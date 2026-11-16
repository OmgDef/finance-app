import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { routes } from '@teta/contracts';
import type { Body, ErrorCode, Result, Route } from '@teta/contracts';
import { buildApp } from '../src/app.ts';
import { configFromEnv } from '../src/config.ts';
import { base32, token, verifier } from '../src/crypto.ts';
import { connect, hasDatabaseError, one, rows } from '../src/db.ts';
import { accountStatementRowLimit, processScheduleDate, readAccountStatement, recordScheduleDateFailure } from '../src/finance.ts';
import { readScheduleDates } from '../src/schedule.ts';
import type { ScheduleCandidate } from '../src/schedule.ts';

type TransactionResult = Result<'recordTransaction'>;
type SingleAccountResult = Extract<TransactionResult, { accountId: string }>;
type TransferResult = Extract<TransactionResult, { fromAccount: unknown }>;

test('Finance API against migrated MySQL', async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL to a dedicated, migrated synthetic database');
  const connection = connect(databaseUrl);
  const reader = connect(databaseUrl);
  const { db } = connection;
  t.after(async () => { await Promise.all([connection.pool.end(), reader.pool.end()]); });
  const config = configFromEnv({
    DATABASE_URL: databaseUrl, API_ORIGIN: 'https://192.0.2.2:18443', ADMIN_ORIGIN: 'https://192.0.2.2:18444',
    ACCESS_KEY: token(), TOTP_KEY: token(), PROXY_IP: '192.0.2.1', RECOVERY_VERSION: '1',
  });
  let now = Date.parse('2027-01-31T16:00:00Z'); // Midnight on February 1 in Makassar.
  const app = buildApp(config, db, () => now);
  const restored = buildApp({ ...config, recoveryVersion: '2' }, db, () => now);
  t.after(async () => { await Promise.all([app.close(), restored.close()]); });
  let activationIp = 31;

  function send<K extends Route>(api: typeof app, name: K, body?: Body<K>, session?: string,
    objectId?: string, cardIdOrDate?: string, query?: URLSearchParams,
  ) {
    const { method, url } = routes[name];
    const path = url.replace(/:(accountId|transactionId|ruleId)/, objectId ?? '$&').replace(/:(cardId|date)/, cardIdOrDate ?? '$&');
    return api.inject({ method, url: query ? `${path}?${query}` : path,
      payload: body, remoteAddress: '192.0.2.1', headers: {
      host: new URL(config.apiOrigin).host, 'x-forwarded-proto': 'https',
      'x-forwarded-for': name === 'activate' ? `198.51.100.${activationIp++}` : '198.51.100.31',
      ...(session && { authorization: 'Bearer ' + session }),
    } });
  }

  function expectError(response: { statusCode: number; body: string }, status: number, code: ErrorCode) {
    assert.equal(response.statusCode, status, response.body);
    const failure = JSON.parse(response.body);
    assert.equal(failure.code, code);
    assert.ok(failure.requestId);
  }

  async function activateOwner(timeZone: string | null = 'Asia/Makassar') {
    const userId = randomUUID();
    const email = userId + '@example.test';
    const code = base32(randomBytes(10));
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})`);
    await db.execute(sql`INSERT INTO activation_codes (id, user_id, verifier, expires_at)
      VALUES (${randomUUID()}, ${userId}, ${verifier(config.accessKey, 'activation', code)}, ${now + 60_000})`);
    if (timeZone !== null) {
      await db.execute(sql`INSERT INTO user_time_zone_versions (user_id, effective_at, time_zone)
        VALUES (${userId}, 0, ${timeZone})`);
    }
    const installationSecret = token();
    const response = await send(app, 'activate', { email, code, pin: '2837', installationSecret });
    assert.equal(response.statusCode, 200, response.body);
    const session = response.json<Result<'activate'>>();
    assert.equal(session.recoveryVersion, '1');
    return { userId, session: session.token, installationSecret, newKey: () => `${session.recoveryVersion}.${token()}` };
  }

  async function adminSessionHeaders() {
    const adminId = randomUUID();
    const adminToken = token();
    await db.execute(sql`INSERT INTO admin_users (id, login, password_hash) VALUES (${adminId}, ${adminId + '@example.test'}, 'unused')`);
    await db.execute(sql`INSERT INTO admin_sessions (verifier, admin_id, created_at, last_seen_at)
      VALUES (${verifier(config.accessKey, 'admin-session', adminToken)}, ${adminId}, ${now}, ${now})`);
    const headers = { host: new URL(config.adminOrigin).host, origin: config.adminOrigin, 'x-forwarded-proto': 'https',
      cookie: '__Host-teta-admin=' + adminToken, 'x-csrf-token': verifier(config.accessKey, 'csrf', adminToken) };
    return { adminId, headers };
  }

  function expenseFor(accountId: string, idempotencyKey: string): Exclude<Body<'recordTransaction'>, { type: 'transfer' }> {
    return { type: 'expense', accountId, date: '2027-02-01', amountMinor: '10000', categoryId: 'groceries', idempotencyKey };
  }

  async function fixture(timeZone?: string | null) {
    const owner = await activateOwner(timeZone);
    const { userId, newKey } = owner;
    const accountId = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${accountId}, ${userId}, 'Synthetic EUR', 'EUR', '2027-01-01', 100000)`);
    return { ...owner, accountId, expense: expenseFor(accountId, newKey()) };
  }

  async function scheduleRule(accountId: string, frequency: 'once' | 'weekly' = 'weekly', firstDate = '2027-02-01') {
    const ruleId = randomUUID();
    const createdAt = Date.parse('2027-01-29T04:00:00Z');
    await db.execute(sql`INSERT INTO schedule_rules (id, account_id, kind, frequency, first_date, created_at)
      VALUES (${ruleId}, ${accountId}, 'expense', ${frequency}, ${firstDate}, ${createdAt})`);
    await db.execute(sql`INSERT INTO schedule_rule_versions
      (rule_id, version, accepted_at, effective_at, amount_minor, category_id)
      VALUES (${ruleId}, 1, ${createdAt}, ${createdAt}, 10000, 'groceries')`);
    return ruleId;
  }

  function scheduleInput(accountId: string, firstDate: string): Body<'createScheduleRule'> {
    return { accountId, kind: 'expense', frequency: 'weekly', firstDate, amountMinor: '10000', categoryId: 'groceries' };
  }

  function occurrences(session: string, fromDate: string, throughDate: string, ruleId: string) {
    return send(app, 'listScheduleOccurrences', undefined, session, undefined, undefined,
      new URLSearchParams({ fromDate, throughDate, ruleId }));
  }

  function statistics(session?: string, filters: Record<string, string> = {}) {
    return send(app, 'getStatistics', undefined, session, undefined, undefined, new URLSearchParams(filters));
  }

  async function readStatistics(session: string, filters?: Record<string, string>) {
    const response = await statistics(session, filters);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Result<'getStatistics'>>();
  }

  async function renewMobileSession(installationSecret: string) {
    const response = await send(app, 'unlock', { installationSecret, pin: '2837' });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Result<'unlock'>>().token;
  }

  function settle(candidate: ScheduleCandidate) {
    return processScheduleDate(db, candidate, () => now);
  }

  async function reconciliationPreview(accountId: string, session: string) {
    const url = routes.previewBalanceAdjustment.url.replace(':accountId', accountId);
    const response = await app.inject({ method: 'GET', url: url + '?fromDate=2027-02-01&throughDate=2027-02-08',
      remoteAddress: '192.0.2.1', headers: { host: new URL(config.apiOrigin).host, 'x-forwarded-proto': 'https',
        authorization: 'Bearer ' + session } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Result<'previewBalanceAdjustment'>>();
  }

  async function replacementFixture({ timeZone = 'Asia/Makassar', earlySkip = true, destinationBalance = 50000,
    firstDate = '2027-02-01' }: { timeZone?: string; earlySkip?: boolean; destinationBalance?: number; firstDate?: string } = {},
  ) {
    now = Date.parse('2027-01-31T04:00:00Z');
    const owner = await fixture(timeZone);
    const target = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${target}, ${owner.userId}, 'Replacement destination', 'EUR', '2027-01-01', ${destinationBalance})`);
    const ruleId = await scheduleRule(owner.accountId, 'weekly', firstDate);

    async function reconcile(date: string, amount: string, session = owner.session) {
      const response = await send(app, 'previewBalanceAdjustment', undefined, session, owner.accountId, undefined,
        new URLSearchParams({ fromDate: date, throughDate: date }));
      assert.equal(response.statusCode, 200, response.body);
      const preview = response.json<Result<'previewBalanceAdjustment'>>();
      const { status, ...selection } = preview.dates[0];
      assert.equal(status, 'planned');
      const recorded = await send(app, 'reconcileAccountBalance', {
        expectedAccountVersion: preview.accountVersion, actualBalanceMinor: amount, explanation: 'Statement balance',
        idempotencyKey: owner.newKey(), skippedDates: [{ ...selection, reason: 'Early bank debit' }],
      }, session, owner.accountId);
      assert.equal(recorded.statusCode, 200, recorded.body);
      return recorded.json<Result<'reconcileAccountBalance'>>().adjustmentId;
    }
    const adjustmentId = earlySkip ? await reconcile('2027-02-08', '90000') : undefined;

    function requestPreview(id: string = ruleId, session = owner.session, destination: string = target) {
      return send(app, 'previewScheduleRuleReplacement', undefined, session, id, undefined,
        new URLSearchParams({ accountId: destination }));
    }

    async function preview(id: string = ruleId, session = owner.session, destination: string = target) {
      const response = await requestPreview(id, session, destination);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Result<'previewScheduleRuleReplacement'>>();
    }

    function input(p: Result<'previewScheduleRuleReplacement'>): Body<'replaceScheduleRule'> {
      return { ...scheduleInput(p.accountId, '2027-02-02'), amountMinor: '7000', endDate: '2027-02-16',
        expectedRuleVersion: p.ruleVersion, previewToken: p.previewToken, idempotencyKey: owner.newKey(),
        decisions: p.skippedDates.map(({ date }) => ({ sourceDate: date, targetDate: '2027-02-09' })) };
    }

    function apply(body: Body<'replaceScheduleRule'>, id: string = ruleId, session = owner.session, api = app) {
      return send(api, 'replaceScheduleRule', body, session, id);
    }

    return { ...owner, target, ruleId, reconcile, adjustmentId, requestPreview, preview, input, apply };
  }

  async function transferFixture() {
    const { userId, session, newKey } = await activateOwner();
    const fromAccountId = randomUUID();
    const toAccountId = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor) VALUES
      (${fromAccountId}, ${userId}, 'Synthetic USD', 'USD', '2027-01-01', 50000),
      (${toAccountId}, ${userId}, 'Synthetic EUR', 'EUR', '2027-02-01', 20000)`);
    const transfer = {
      type: 'transfer', fromAccountId, toAccountId, fromAmountMinor: '10000', toAmountMinor: '9200',
      date: '2027-02-01', idempotencyKey: newKey(), comment: 'По выписке',
    } as const;
    return { userId, session, transfer, newKey };
  }

  async function transferBalances(session: string, eur: string, usd: string) {
    const summary = await send(app, 'getCurrencySummary', undefined, session);
    assert.equal(summary.statusCode, 200, summary.body);
    assert.deepEqual(summary.json(), { balances: [
      { currency: 'EUR', balanceMinor: eur }, { currency: 'USD', balanceMinor: usd },
    ] });
  }

  type CommandKey = Body<'commandStatus'>;
  function expectCommitted(response: LightMyRequestResponse, original: LightMyRequestResponse) {
    assert.equal(original.statusCode, 200, original.body);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { state: 'committed', result: original.json() });
  }

  async function awaitLock(probe: () => Promise<boolean>, message: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await setTimeout(10);
    }
    assert.fail(message);
  }

  async function runScheduleRace<T, U>(userId: string, accountId: string, first: () => PromiseLike<T>, second: () => PromiseLike<U>) {
    let earlier: Promise<T> | undefined;
    let later: Promise<U> | undefined;
    await reader.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE`);
      earlier = Promise.resolve(first());
      await awaitLock(async () => {
        try {
          await reader.db.transaction((probe) => probe.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE NOWAIT`));
        } catch (error) {
          if (!hasDatabaseError(error, 'ER_LOCK_NOWAIT')) throw error;
          return true;
        }
        return false;
      }, 'First request did not acquire the owner lock');
      later = Promise.resolve(second());
      await awaitLock(async () => (await rows<{ Info: string | null }>(reader.db, sql`SHOW FULL PROCESSLIST`))
        .some(({ Info }) => Info !== null && /SELECT (?:\*|id) FROM users WHERE id =/.test(Info) &&
          Info.includes(userId) && Info.endsWith('FOR UPDATE')), 'Second request did not wait on the owner lock');
    });
    assert.ok(earlier && later);
    return Promise.all([earlier, later]);
  }

  function awaitKeyReservation(userId: string, { command, idempotencyKey }: CommandKey) {
    return awaitLock(async () => {
      try {
        await reader.db.transaction((tx) => tx.execute(sql`SELECT command_key FROM idempotency_keys
          WHERE actor_role = 'user' AND actor_id = ${userId} AND command = ${command} AND command_key = ${idempotencyKey}
          FOR UPDATE NOWAIT`), { isolationLevel: 'read committed' });
      } catch (error) {
        if (!hasDatabaseError(error, 'ER_LOCK_NOWAIT')) throw error;
        return true;
      }
      return false;
    }, 'First API request did not reserve the command key');
  }

  await t.test('Recording and closing the same command serialize in both orders', async () => {
    for (const closeFirst of [false, true]) {
      const { userId, accountId, session, expense, newKey } = await fixture();
      const key = { userId, accountId, command: 'expense.record', idempotencyKey: expense.idempotencyKey } as const;
      const status = await send(app, 'commandStatus', key, session);
      assert.equal(status.statusCode, 200, status.body);
      assert.deepEqual(status.json(), { state: 'unknown' });
      const record = () => send(app, 'recordTransaction', expense, session);
      const close = () => send(app, 'closeCommand', key, session);
      const requests = closeFirst ? [close, record] : [record, close];
      const pending: Promise<LightMyRequestResponse>[] = [];
      await reader.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
        pending.push(requests[0]());
        await awaitKeyReservation(userId, key);
        pending.push(requests[1]());
        await awaitLock(async () => (await rows<{ Info: string | null }>(reader.db, sql`SHOW FULL PROCESSLIST`))
          .some(({ Info }) => Info?.startsWith('INSERT INTO idempotency_keys') && Info.includes(key.idempotencyKey)),
        'Second API request did not wait for the reserved command key');
      });

      const [first, second] = await Promise.all(pending);
      let recorded = first;
      if (closeFirst) {
        expectError(first, 409, 'COMMAND_CLOSED');
        expectError(second, 409, 'COMMAND_CLOSED');
        expectError(await send(app, 'commandStatus', key, session), 409, 'COMMAND_CLOSED');
        expectError(await close(), 409, 'COMMAND_CLOSED');
        assert.deepEqual(await rows(reader.db, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
        const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
        assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');
        recorded = await send(app, 'recordTransaction', { ...expense, idempotencyKey: newKey() }, session);
      } else {
        expectCommitted(second, first);
        expectCommitted(await send(app, 'commandStatus', key, session), first);
      }
      assert.equal(recorded.statusCode, 200, recorded.body);
      const { transactionId, balanceMinor } = recorded.json<SingleAccountResult>();
      assert.equal(balanceMinor, '90000');
      assert.deepEqual(await rows(reader.db, sql`SELECT id, current_version FROM transactions WHERE user_id = ${userId}`),
        [{ id: transactionId, current_version: 1 }]);
      assert.deepEqual(await rows(reader.db, sql`SELECT transaction_version, CAST(amount_minor AS CHAR) AS amount
        FROM movements WHERE account_id = ${accountId}`), [{ transaction_version: 1, amount: '-10000' }]);
      assert.deepEqual(await rows(reader.db, sql`SELECT object_id FROM audit_events WHERE user_id = ${userId}
        AND event = 'expense.recorded'`), [{ object_id: transactionId }]);
    }
  });

  await t.test('A schedule skip and command closure serialize in both orders and preserve the receipt', async () => {
    for (const closeFirst of [false, true]) {
      const { userId, accountId, session, newKey } = await fixture();
      const ruleId = await scheduleRule(accountId);
      const date = '2027-02-01';
      const reason = 'Платёж отменён';
      const key = { userId, ruleId, date, command: 'schedule.skip', idempotencyKey: newKey() } as const;
      const skip = (idempotencyKey = key.idempotencyKey) =>
        send(app, 'skipScheduleOccurrence', { idempotencyKey, reason }, session, ruleId, date);
      const close = () => send(app, 'closeCommand', key, session);
      const status = await send(app, 'commandStatus', key, session);
      assert.equal(status.statusCode, 200, status.body);
      assert.deepEqual(status.json(), { state: 'unknown' });
      const pending: Promise<LightMyRequestResponse>[] = [];
      await reader.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
        pending.push(closeFirst ? close() : skip());
        await awaitKeyReservation(userId, key);
        pending.push(closeFirst ? skip() : close());
        await awaitLock(async () => (await rows<{ Info: string | null }>(reader.db, sql`SHOW FULL PROCESSLIST`))
          .some(({ Info }) => Info?.startsWith('INSERT INTO idempotency_keys') && Info.includes(key.idempotencyKey)),
        'Second API request did not wait for the reserved schedule command key');
      });

      const [first, second] = await Promise.all(pending);
      let recorded = first;
      if (closeFirst) {
        expectError(first, 409, 'COMMAND_CLOSED');
        expectError(second, 409, 'COMMAND_CLOSED');
        expectError(await send(app, 'commandStatus', key, session), 409, 'COMMAND_CLOSED');
        expectError(await close(), 409, 'COMMAND_CLOSED');
        assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_occurrences WHERE rule_id = ${ruleId}`), []);
        assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
          { processed_through: null });
        recorded = await skip(newKey());
      } else {
        expectCommitted(second, first);
        expectCommitted(await send(app, 'commandStatus', key, session), first);
        assert.deepEqual((await skip()).json(), first.json());
        expectError(await send(app, 'skipScheduleOccurrence', { idempotencyKey: key.idempotencyKey, reason: 'Иная причина' },
          session, ruleId, date), 409, 'IDEMPOTENCY_CONFLICT');
        expectError(await send(app, 'skipScheduleOccurrence', { idempotencyKey: key.idempotencyKey, reason },
          session, ruleId, '2027-02-08'), 409, 'IDEMPOTENCY_CONFLICT');
        expectError(await send(app, 'commandStatus', { ...key, date: '2027-02-08' }, session), 404, 'NOT_FOUND');
        expectError(await send(app, 'closeCommand', { ...key, userId: randomUUID() }, session), 404, 'NOT_FOUND');
      }
      assert.equal(recorded.statusCode, 200, recorded.body);
      const { occurrenceId } = recorded.json<Result<'skipScheduleOccurrence'>>();
      assert.deepEqual(recorded.json(), { ruleId, date, status: 'skipped', reason, occurrenceId });
      assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
        { processed_through: date });
      assert.deepEqual(await rows(reader.db, sql`SELECT id, status, reason, adjustment_id, transaction_id
        FROM schedule_occurrences WHERE rule_id = ${ruleId}`),
      [{ id: occurrenceId, status: 'skipped', reason, adjustment_id: null, transaction_id: null }]);
      assert.deepEqual(await rows(reader.db, sql`SELECT actor_role, actor_id, object_id, transition FROM audit_events
        WHERE user_id = ${userId} AND event = 'schedule.occurrence.skipped'`), [
        { actor_role: 'user', actor_id: userId, object_id: occurrenceId, transition: { from: 'due', to: 'skipped', reason } },
      ]);
      assert.deepEqual(await rows(reader.db, sql`SELECT transaction_id FROM movements WHERE account_id = ${accountId}`), []);
      const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');
    }
  });

  await t.test('A closure timeout leaves the outcome unknown after the original write rolls back', async () => {
    const { userId, accountId, session, expense } = await fixture();
    const key = { userId, accountId, command: 'expense.record', idempotencyKey: expense.idempotencyKey } as const;
    const closer = connect(databaseUrl, 1);
    const closeApi = buildApp(config, closer.db, () => now);
    try {
      await closer.db.execute(sql`SET SESSION innodb_lock_wait_timeout = 1`);
      // Force the writer to roll back after inserting its movement once the owner lock is released.
      await db.execute(sql`UPDATE accounts SET version = 4294967295 WHERE id = ${accountId}`);
      let writing: Promise<LightMyRequestResponse> | undefined;
      await reader.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
        writing = send(app, 'recordTransaction', expense, session);
        await awaitKeyReservation(userId, key);
        expectError(await send(closeApi, 'closeCommand', key, session), 503, 'TEMPORARY_FAILURE');
      });
      assert.ok(writing);
      expectError(await writing, 500, 'INTERNAL_ERROR');
      const unknown = await send(app, 'commandStatus', key, session);
      assert.equal(unknown.statusCode, 200, unknown.body);
      assert.deepEqual(unknown.json(), { state: 'unknown' });
      expectError(await send(app, 'closeCommand', key, session), 409, 'COMMAND_CLOSED');
      expectError(await send(app, 'commandStatus', key, session), 409, 'COMMAND_CLOSED');
      expectError(await send(app, 'recordTransaction', expense, session), 409, 'COMMAND_CLOSED');
      const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
      assert.equal(balance.statusCode, 200, balance.body);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
    } finally {
      await closeApi.close();
      await closer.pool.end();
    }
  });

  await t.test('Each mobile financial command can be closed before writing or recovered after committing', async () => {
    const { userId, accountId, session, newKey, expense } = await fixture();
    const recorded = await send(app, 'recordTransaction', expense, session);
    assert.equal(recorded.statusCode, 200, recorded.body);
    const { transactionId } = recorded.json<SingleAccountResult>();
    const toAccountId = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${toAccountId}, ${userId}, 'USD destination', 'USD', '2027-01-01', 0)`);
    type WithoutKey<T> = T extends { idempotencyKey: string } ? Omit<T, 'idempotencyKey'> : never;
    async function check(target: WithoutKey<CommandKey>,
      write: (idempotencyKey: string) => Promise<LightMyRequestResponse>,
    ) {
      const closed = { ...target, idempotencyKey: newKey() };
      const pending = { ...closed, idempotencyKey: newKey() };
      expectError(await send(app, 'closeCommand', closed, session), 409, 'COMMAND_CLOSED');
      expectError(await write(closed.idempotencyKey), 409, 'COMMAND_CLOSED');
      const result = await write(pending.idempotencyKey);
      expectCommitted(await send(app, 'commandStatus', pending, session), result);
      expectCommitted(await send(app, 'closeCommand', pending, session), result);
      return result;
    }
    await check({ userId, command: 'account.create' }, (idempotencyKey) => send(app, 'createAccount', {
      idempotencyKey, name: 'Cash', startDate: '2027-01-01', currency: 'EUR', openingBalanceMinor: '2500',
    }, session));
    await check({ userId, command: 'income.record', accountId }, (idempotencyKey) => send(app, 'recordTransaction', {
      ...expense, idempotencyKey, type: 'income', amountMinor: '2500', categoryId: 'other-income',
    }, session));
    await check({ userId, command: 'transfer.record', fromAccountId: accountId, toAccountId }, (idempotencyKey) =>
      send(app, 'recordTransaction', {
        idempotencyKey, type: 'transfer', fromAccountId: accountId, toAccountId,
        date: expense.date, fromAmountMinor: '3000', toAmountMinor: '3200',
      }, session));
    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.statusCode, 200, balance.body);
    const { accountVersion, balanceMinor } = balance.json<Result<'getAccountBalance'>>();
    await check({ userId, command: 'account.reconcile', accountId }, (idempotencyKey) =>
      send(app, 'reconcileAccountBalance', {
        idempotencyKey, expectedAccountVersion: accountVersion, actualBalanceMinor: balanceMinor, explanation: 'Statement check',
      }, session, accountId));
    const revised = await check({ userId, command: 'transaction.revise', transactionId }, (idempotencyKey) =>
      send(app, 'reviseTransaction', {
        ...expense, idempotencyKey, amountMinor: '12000', expectedTransactionVersion: 1,
      }, session, transactionId));
    await check({ userId, command: 'transaction.void', transactionId }, (idempotencyKey) =>
      send(app, 'voidTransaction', {
        idempotencyKey, expectedTransactionVersion: revised.json<Result<'reviseTransaction'>>().transactionVersion,
      }, session, transactionId));
  });

  await t.test('Access, target identity and recovery version are checked for command outcomes', async () => {
    const { userId, accountId, session, installationSecret, expense, newKey } = await fixture();
    const other = await fixture();
    const secondAccount = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${secondAccount}, ${userId}, 'Another EUR account', 'EUR', '2027-01-01', 100000)`);
    const key = { userId, accountId, command: 'expense.record', idempotencyKey: expense.idempotencyKey } as const;
    const closed = { ...key, idempotencyKey: newKey() };
    const unknown = { ...key, idempotencyKey: newKey() };
    const recorded = await send(app, 'recordTransaction', expense, session);
    expectError(await send(app, 'closeCommand', closed, session), 409, 'COMMAND_CLOSED');
    for (const name of ['commandStatus', 'closeCommand'] as const) {
      expectError(await send(app, name, key, other.session), 404, 'NOT_FOUND');
      expectError(await send(app, name, { ...key, userId: other.userId }, other.session), 404, 'NOT_FOUND');
      expectError(await send(app, name, { ...key, accountId: secondAccount }, session), 404, 'NOT_FOUND');
      expectError(await send(app, name, { ...closed, accountId: secondAccount }, session), 404, 'NOT_FOUND');
    }

    const unlocked = await send(restored, 'unlock', { installationSecret, pin: '2837' });
    assert.equal(unlocked.statusCode, 200, unlocked.body);
    const current = unlocked.json<Result<'unlock'>>();
    assert.equal(current.recoveryVersion, '2');
    expectError(await send(restored, 'recordTransaction', expense, session), 401, 'SESSION_EXPIRED');
    for (const name of ['commandStatus', 'closeCommand'] as const) {
      expectError(await send(restored, name, key, session), 401, 'SESSION_EXPIRED');
      expectCommitted(await send(restored, name, key, current.token), recorded);
      expectError(await send(restored, name, closed, current.token), 409, 'COMMAND_CLOSED');
      expectError(await send(restored, name, unknown, current.token), 409, 'COMMAND_REQUIRES_REVIEW');
    }
    expectError(await send(restored, 'recordTransaction', { ...expense, idempotencyKey: closed.idempotencyKey }, current.token),
      409, 'COMMAND_CLOSED');
    expectError(await send(restored, 'recordTransaction', { ...expense, idempotencyKey: unknown.idempotencyKey }, current.token),
      409, 'COMMAND_REQUIRES_REVIEW');
    assert.deepEqual(await rows(reader.db, sql`SELECT command_key FROM idempotency_keys WHERE actor_id = ${userId}
      AND command_key = ${unknown.idempotencyKey}`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM transactions WHERE user_id = ${userId}`),
      [{ id: recorded.json<SingleAccountResult>().transactionId }]);
  });

  await t.test('Administrative command outcomes require the original administrator and current authorization', async () => {
    const { userId, accountId, session, newKey } = await fixture();
    const other = await fixture();
    const admin = await adminSessionHeaders();
    const secondAdmin = await adminSessionHeaders();
    function lookup(name: 'adminCommandStatus' | 'adminCloseCommand', payload: Body<'adminCommandStatus'>,
      headers = admin.headers,
    ) {
      return app.inject({ method: 'POST', url: routes[name].url, payload, headers, remoteAddress: '192.0.2.1' });
    }
    const login = await app.inject({ method: 'GET', url: routes.adminMe.url, headers: admin.headers, remoteAddress: '192.0.2.1' });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json<Result<'adminMe'>>().id, admin.adminId);
    assert.equal(login.json<Result<'adminMe'>>().recoveryVersion, '1');
    const key = { userId, accountId, command: 'account.reconcile', idempotencyKey: newKey() } as const;
    const write = (idempotencyKey: string, owner = userId, account = accountId) => app.inject({
      method: 'POST', url: routes.adminReconcileAccountBalance.url.replace(':userId', owner).replace(':accountId', account),
      payload: { idempotencyKey, expectedAccountVersion: 1, actualBalanceMinor: '90000', explanation: 'Statement check' },
      headers: admin.headers, remoteAddress: '192.0.2.1',
    });

    const closed = { ...key, idempotencyKey: newKey() };
    expectError(await lookup('adminCloseCommand', closed, { ...admin.headers, 'x-csrf-token': '' }), 403, 'CSRF_INVALID');
    expectError(await lookup('adminCloseCommand', { ...closed, userId: other.userId }), 404, 'NOT_FOUND');
    expectError(await lookup('adminCloseCommand', closed), 409, 'COMMAND_CLOSED');
    expectError(await lookup('adminCommandStatus', closed), 409, 'COMMAND_CLOSED');
    expectError(await write(closed.idempotencyKey), 409, 'COMMAND_CLOSED');
    expectError(await write(closed.idempotencyKey, other.userId, other.accountId), 404, 'NOT_FOUND');

    const recorded = await write(key.idempotencyKey);
    expectCommitted(await lookup('adminCommandStatus', key), recorded);
    expectCommitted(await lookup('adminCloseCommand', key), recorded);
    expectError(await lookup('adminCommandStatus', { ...key, userId: other.userId, accountId: other.accountId }), 404, 'NOT_FOUND');
    for (const lookupResponse of [await lookup('adminCommandStatus', key, secondAdmin.headers),
      await send(app, 'commandStatus', key, session)]) {
      assert.equal(lookupResponse.statusCode, 200, lookupResponse.body);
      assert.deepEqual(lookupResponse.json(), { state: 'unknown' });
    }
    await db.execute(sql`UPDATE admin_sessions SET revoked = TRUE WHERE admin_id = ${admin.adminId}`);
    expectError(await lookup('adminCommandStatus', key), 401, 'ADMIN_AUTH_INVALID');
    expectError(await lookup('adminCloseCommand', key), 401, 'ADMIN_AUTH_INVALID');
    assert.deepEqual(await rows(reader.db, sql`SELECT CAST(delta_minor AS CHAR) AS delta
      FROM balance_adjustments WHERE account_id = ${accountId}`), [{ delta: '-10000' }]);
  });

  await t.test('Account list includes owned cash and archived accounts; rename checks version and access', async () => {
    const { userId, accountId, session, newKey } = await fixture();
    const other = await fixture();
    const fields = { name: 'Наличные', currency: 'RUB', startDate: '2027-01-15', openingBalanceMinor: '-9007199254740993',
      idempotencyKey: newKey() } as const;
    const created = await send(app, 'createAccount', { ...fields, type: 'cash' }, session);
    assert.equal(created.statusCode, 200, created.body);
    const cash = created.json<Result<'createAccount'>>();
    assert.deepEqual(cash, { accountId: cash.accountId, name: 'Наличные', type: 'cash', currency: 'RUB',
      startDate: fields.startDate, accountVersion: 1, balanceMinor: fields.openingBalanceMinor });
    expectCommitted(await send(app, 'commandStatus', { userId, command: 'account.create', idempotencyKey: fields.idempotencyKey }, session),
      created);
    expectError(await send(app, 'createAccount', fields, session), 409, 'IDEMPOTENCY_CONFLICT');

    const archived = await send(app, 'createAccount', { ...fields, idempotencyKey: newKey(), name: 'Archive me',
      currency: 'EUR', openingBalanceMinor: '0' }, session);
    assert.equal(archived.statusCode, 200, archived.body);
    const archivedId = archived.json<Result<'createAccount'>>().accountId;
    const archive = await send(app, 'archiveAccount', undefined, session, archivedId);
    assert.equal(archive.statusCode, 200, archive.body);

    const rename = { name: 'Резерв', expectedAccountVersion: 1 };
    expectError(await send(app, 'renameAccount', rename, other.session, cash.accountId), 404, 'NOT_FOUND');
    expectError(await send(app, 'renameAccount', { ...rename, expectedAccountVersion: 2 }, session, archivedId),
      409, 'ACCOUNT_UNAVAILABLE');
    const renamed = await send(app, 'renameAccount', rename, session, cash.accountId);
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.deepEqual(renamed.json(), { ...cash, name: rename.name, accountVersion: 2 });
    expectError(await send(app, 'renameAccount', rename, session, cash.accountId), 409, 'VERSION_CONFLICT');
    const sameName = await send(app, 'renameAccount', { ...rename, expectedAccountVersion: 2 }, session, cash.accountId);
    assert.equal(sameName.statusCode, 200, sameName.body);
    assert.deepEqual(sameName.json(), renamed.json());
    assert.deepEqual(await rows(reader.db, sql`SELECT object_id, transition FROM audit_events
      WHERE user_id = ${userId} AND event = 'finance.account.renamed'`),
      [{ object_id: cash.accountId, transition: { from: '1', to: '2' } }]);

    const listing = await send(app, 'listAccounts', undefined, session);
    assert.equal(listing.statusCode, 200, listing.body);
    const { accounts } = listing.json<Result<'listAccounts'>>();
    assert.deepEqual(accounts.slice(0, 2).map((account) => account.accountId).sort(), [accountId, cash.accountId].sort());
    assert.deepEqual(accounts.find((account) => account.accountId === cash.accountId), renamed.json());
    assert.deepEqual(accounts.at(-1), { ...archived.json(), archived: true, accountVersion: 2 });
    const archivedHistory = await send(app, 'listAccountHistory', undefined, session, archivedId);
    assert.equal(archivedHistory.statusCode, 200, archivedHistory.body);
    assert.deepEqual(archivedHistory.json(), { accountId: archivedId, currency: 'EUR', next: null,
      entries: [{ id: archivedId, type: 'opening', date: fields.startDate, amountMinor: '0' }] });
  });

  await t.test('Category catalog keeps the stable localized IDs used by the ledger', async () => {
    const { session, accountId, expense, newKey } = await fixture();
    expectError(await send(app, 'listCategories'), 401, 'SESSION_EXPIRED');
    const result = await send(app, 'listCategories', undefined, session);
    assert.equal(result.statusCode, 200, result.body);
    const { categories } = result.json<Result<'listCategories'>>();
    assert.equal(categories.length, new Set(categories.map(({ id }) => id)).size);
    assert.ok(categories.every(({ nameEn, nameRu }) => nameEn.trim() && /\p{Script=Cyrillic}/u.test(nameRu)));
    const byId = new Map(categories.map((category) => [category.id, category]));
    assert.deepEqual(byId.get('groceries'), { id: 'groceries', type: 'expense', nameEn: 'Groceries', nameRu: 'Продукты' });
    assert.equal(byId.get('deposit-interest')?.type, 'income');
    assert.equal(byId.get('other-income')?.type, 'income');
    assert.equal(byId.get('transport')?.type, 'expense');
    assert.equal(byId.get('salary')?.type, 'income');
    const salary = await send(app, 'recordTransaction', { ...expense, type: 'income', accountId, categoryId: 'salary' }, session);
    assert.equal(salary.statusCode, 200, salary.body);
    expectError(await send(app, 'recordTransaction', { ...expense, categoryId: 'salary', idempotencyKey: newKey() }, session),
      400, 'INVALID_REQUEST');
  });

  await t.test('Account history follows posted revisions and preserves voided movements with the current author', async () => {
    const { userId, accountId, session, expense, newKey } = await fixture();
    const other = await fixture();
    const destination = await send(app, 'createAccount', { name: 'USD', currency: 'USD', startDate: '2027-01-01',
      openingBalanceMinor: '0', idempotencyKey: newKey() }, session);
    assert.equal(destination.statusCode, 200, destination.body);
    const destinationId = destination.json<Result<'createAccount'>>().accountId;
    const alternative = await send(app, 'createAccount', { name: 'Other EUR', currency: 'EUR', startDate: '2027-01-01',
      openingBalanceMinor: '0', idempotencyKey: newKey() }, session);
    assert.equal(alternative.statusCode, 200, alternative.body);
    const alternativeId = alternative.json<Result<'createAccount'>>().accountId;
    const income = await send(app, 'recordTransaction', { ...expense, type: 'income', amountMinor: '9007199254740993',
      date: '2027-01-31', categoryId: 'salary' }, session);
    assert.equal(income.statusCode, 200, income.body);
    const recorded = await send(app, 'recordTransaction', { ...expense, idempotencyKey: newKey(), comment: 'Market' }, session);
    assert.equal(recorded.statusCode, 200, recorded.body);
    const expenseId = recorded.json<SingleAccountResult>().transactionId;
    const transfer = { type: 'transfer', date: '2027-02-01', fromAccountId: accountId, toAccountId: destinationId,
      fromAmountMinor: '3000', toAmountMinor: '3200', idempotencyKey: newKey() } as const;
    const sent = await send(app, 'recordTransaction', transfer, session);
    assert.equal(sent.statusCode, 200, sent.body);
    const transferId = sent.json<TransferResult>().transactionId;

    const history = (id: string, token = session) => send(app, 'listAccountHistory', undefined, token, id);
    expectError(await history(accountId, other.session), 404, 'NOT_FOUND');
    expectError(await history(other.accountId), 404, 'NOT_FOUND');
    const first = await history(accountId);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json<Result<'listAccountHistory'>>().entries.find(({ id }) => id === transferId),
      { id: transferId, type: 'transfer', date: transfer.date, amountMinor: '-3000', transactionVersion: 1,
        status: 'posted', actorRole: 'user', categoryId: null, comment: null });
    const moved = await send(app, 'reviseTransaction', { ...transfer, fromAccountId: alternativeId, fromAmountMinor: '3500',
      expectedTransactionVersion: 1, idempotencyKey: newKey() }, session, transferId);
    assert.equal(moved.statusCode, 200, moved.body);
    const { headers } = await adminSessionHeaders();
    const previewPath = routes.adminPreviewTransactionVoid.url.replace(':userId', userId).replace(':transactionId', transferId);
    const preview = await app.inject({ method: 'POST', url: previewPath, headers, remoteAddress: '192.0.2.1', payload: {} });
    assert.equal(preview.statusCode, 200, preview.body);
    const voidPath = routes.adminVoidTransaction.url.replace(':userId', userId).replace(':transactionId', transferId);
    const voided = await app.inject({ method: 'POST', url: voidPath, headers, remoteAddress: '192.0.2.1', payload: {
      idempotencyKey: newKey(), expectedTransactionVersion: 2,
      expectedAccounts: preview.json<Result<'adminPreviewTransactionVoid'>>().accounts
        .map(({ accountId, accountVersion }) => ({ accountId, accountVersion })),
      reason: 'Duplicate',
    } });
    assert.equal(voided.statusCode, 200, voided.body);

    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.statusCode, 200, balance.body);
    const { accountVersion } = balance.json<Result<'getAccountBalance'>>();
    const adjustment = await send(app, 'reconcileAccountBalance', { idempotencyKey: newKey(), expectedAccountVersion: accountVersion,
      actualBalanceMinor: '9007199254830000', explanation: 'Checked statement' }, session, accountId);
    assert.equal(adjustment.statusCode, 200, adjustment.body);
    const { adjustmentId, deltaMinor } = adjustment.json<Result<'reconcileAccountBalance'>>();
    const statement = await history(accountId);
    assert.equal(statement.statusCode, 200, statement.body);
    const entries = statement.json<Result<'listAccountHistory'>>().entries;
    assert.equal(entries.length, 4);
    assert.deepEqual(entries.find(({ id }) => id === expenseId), { id: expenseId, type: 'expense', date: expense.date,
      amountMinor: '-10000', transactionVersion: 1, status: 'posted', actorRole: 'user', categoryId: 'groceries', comment: 'Market' });
    assert.deepEqual(entries.find(({ id }) => id === adjustmentId), { id: adjustmentId, type: 'adjustment', date: expense.date,
      amountMinor: deltaMinor, explanation: 'Checked statement', actorRole: 'user' });
    assert.equal(entries.find(({ type }) => type === 'income')?.amountMinor, '9007199254740993');
    assert.deepEqual(entries.at(-1), { id: accountId, type: 'opening', date: '2027-01-01', amountMinor: '100000' });
    const series = await send(app, 'getAccountBalanceSeries', undefined, session, accountId);
    assert.equal(series.statusCode, 200, series.body);
    assert.deepEqual(series.json<Result<'getAccountBalanceSeries'>>().points, [
      { date: '2027-01-01', balanceMinor: '100000' },
      { date: '2027-01-31', balanceMinor: '9007199254840993' },
      { date: '2027-02-01', balanceMinor: '9007199254830000' },
    ]);

    for (const [id, amountMinor] of [[alternativeId, '-3500'], [destinationId, '3200']]) {
      const result = await history(id);
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json<Result<'listAccountHistory'>>().entries[0], { id: transferId, type: 'transfer',
        date: transfer.date, amountMinor, transactionVersion: 3, status: 'void', actorRole: 'admin', categoryId: null, comment: null });
      const current = await send(app, 'getAccountBalance', undefined, session, id);
      assert.equal(current.json<Result<'getAccountBalance'>>().balanceMinor, '0');
    }
  });

  await t.test('Account balance series carries older activity into the six-month window', async () => {
    const { session, newKey } = await activateOwner();
    const created = await send(app, 'createAccount', { name: 'Long history', currency: 'USD', startDate: '2026-01-01',
      openingBalanceMinor: '100000', idempotencyKey: newKey() }, session);
    assert.equal(created.statusCode, 200, created.body);
    const { accountId } = created.json<Result<'createAccount'>>();
    for (const date of ['2026-07-31', '2026-08-01', '2026-12-10']) {
      const result = await send(app, 'recordTransaction', { ...expenseFor(accountId, newKey()), date }, session);
      assert.equal(result.statusCode, 200, result.body);
    }
    const result = await send(app, 'getAccountBalanceSeries', undefined, session, accountId);
    assert.equal(result.statusCode, 200, result.body);
    const current = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(current.statusCode, 200, current.body);
    const { accountVersion, balanceMinor } = current.json<Result<'getAccountBalance'>>();
    assert.deepEqual(result.json(), { accountId, accountVersion, currency: 'USD', points: [
      { date: '2026-08-01', balanceMinor: '80000' },
      { date: '2026-12-10', balanceMinor: '70000' },
      { date: '2027-02-01', balanceMinor },
    ] });
    const stranger = await activateOwner();
    expectError(await send(app, 'getAccountBalanceSeries', undefined, stranger.session, accountId), 404, 'NOT_FOUND');
  });

  await t.test('Account history cursor paginates same-day operations without omissions', async () => {
    const { accountId, session, expense, newKey } = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 51; index++) {
      const result = await send(app, 'recordTransaction', { ...expense, idempotencyKey: newKey(), amountMinor: '1' }, session);
      assert.equal(result.statusCode, 200, result.body);
      ids.push(result.json<SingleAccountResult>().transactionId);
    }
    const history = (before?: string) => send(app, 'listAccountHistory', undefined, session, accountId, undefined,
      before === undefined ? undefined : new URLSearchParams({ before }));
    const first = await history();
    assert.equal(first.statusCode, 200, first.body);
    const { entries, next } = first.json<Result<'listAccountHistory'>>();
    assert.equal(entries.length, 50);
    assert.ok(next);
    const second = await history(next);
    assert.equal(second.statusCode, 200, second.body);
    const page = second.json<Result<'listAccountHistory'>>();
    assert.deepEqual([...entries, ...page.entries].map(({ id }) => id), [...ids.sort().reverse(), accountId]);
    assert.equal(page.next, null);
    const beyondOpening = await history(`2027-01-01.${accountId}`);
    assert.equal(beyondOpening.statusCode, 200, beyondOpening.body);
    assert.deepEqual(beyondOpening.json(), { accountId, currency: 'EUR', entries: [], next: null });
    expectError(await history(`2027-02-30.${accountId}`), 400, 'INVALID_REQUEST');
    expectError(await history('malformed'), 400, 'INVALID_REQUEST');
    const series = await send(app, 'getAccountBalanceSeries', undefined, session, accountId);
    assert.equal(series.statusCode, 200, series.body);
    assert.deepEqual(series.json<Result<'getAccountBalanceSeries'>>().points.at(-1), { date: '2027-02-01', balanceMinor: '99949' });
  });

  await t.test('Two linked cards share a live balance and the currency summary counts each account once', async () => {
    const { userId, accountId, session, expense } = await fixture();
    const otherOwner = await fixture();
    const secondEuro = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor) VALUES
      (${secondEuro}, ${userId}, 'Second EUR account', 'EUR', '2027-01-01', 100000),
      (${randomUUID()}, ${userId}, 'USD account', 'USD', '2027-01-01', '9007199254740993')`);
    const summary = async (eur: string) => {
      const response = await send(app, 'getCurrencySummary', undefined, session);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { balances: [
        { currency: 'EUR', balanceMinor: eur }, { currency: 'USD', balanceMinor: '9007199254740993' },
      ] });
    };
    const list = async () => {
      const response = await send(app, 'listAccountCards', undefined, session, accountId);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Result<'listAccountCards'>>().cards;
    };
    await summary('200000');
    assert.deepEqual(await list(), []);

    const first = { name: 'Основная', appearance: '#124ABC', lastFour: '0042', network: 'visa' } as const;
    const second = { name: 'Запасная', appearance: '#564321' };
    const [firstResponse, secondResponse] = await Promise.all([
      send(app, 'createAccountCard', first, session, accountId),
      send(app, 'createAccountCard', second, session, accountId),
    ]);
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    assert.equal(secondResponse.statusCode, 200, secondResponse.body);
    const cardA = firstResponse.json<Result<'createAccountCard'>>();
    const cardB = secondResponse.json<Result<'createAccountCard'>>();
    assert.notEqual(cardA.cardId, cardB.cardId);
    const balance = { accountId, currency: 'EUR', balanceMinor: '100000' };
    assert.deepEqual(cardA, { cardId: cardA.cardId, ...first, ...balance });
    assert.deepEqual(cardB, { cardId: cardB.cardId, ...second, lastFour: null, network: null, ...balance });
    assert.deepEqual(new Set(await list()), new Set([cardA, cardB]));
    await summary('200000');

    const third = await send(app, 'createAccountCard', { name: 'Третья', appearance: '#ABCDEF', lastFour: '9876' }, session, accountId);
    assert.equal(third.statusCode, 200, third.body);
    const thirdCard = third.json<Result<'createAccountCard'>>();
    const previews = async (ownerSession: string) => {
      const response = await send(app, 'listAccounts', undefined, ownerSession);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Result<'listAccounts'>>().cardPreviews;
    };
    assert.deepEqual(await previews(session), [{ accountId, count: 3,
      cards: [cardA, cardB, thirdCard].sort((a, b) => a.cardId.localeCompare(b.cardId)).slice(0, 2)
        .map(({ cardId, name, appearance, lastFour, network }) => ({ cardId, name, appearance, lastFour, network })),
    }]);
    assert.deepEqual(await previews(otherOwner.session), []);
    assert.equal((await send(app, 'deleteAccountCard', undefined, session, accountId, thirdCard.cardId)).statusCode, 200);

    const payment = await send(app, 'recordTransaction', expense, session);
    assert.equal(payment.statusCode, 200, payment.body);
    const updatedBalance = { balanceMinor: '90000' };
    const updatedB = { ...cardB, ...updatedBalance };
    assert.deepEqual(new Set(await list()), new Set([{ ...cardA, ...updatedBalance }, updatedB]));
    await summary('190000');

    const edit = { name: 'Для покупок', appearance: '#102030' };
    const edited = await send(app, 'updateAccountCard', edit, session, accountId, cardA.cardId);
    assert.equal(edited.statusCode, 200, edited.body);
    const updatedA = { ...cardA, ...edit, ...updatedBalance, lastFour: null };
    assert.deepEqual(edited.json(), updatedA);
    assert.deepEqual(new Set(await list()), new Set([updatedA, updatedB]));
    const changedNetwork = await send(app, 'updateAccountCard', { ...edit, network: 'mastercard' }, session, accountId, cardA.cardId);
    assert.equal(changedNetwork.statusCode, 200, changedNetwork.body);
    assert.deepEqual(changedNetwork.json(), { ...updatedA, network: 'mastercard' });
    assert.equal((await previews(session))[0].cards.find(({ cardId }) => cardId === cardA.cardId)?.network, 'mastercard');
    const clearedNetwork = await send(app, 'updateAccountCard', { ...edit, network: null }, session, accountId, cardA.cardId);
    assert.equal(clearedNetwork.statusCode, 200, clearedNetwork.body);
    assert.deepEqual(new Set(await list()), new Set([{ ...updatedA, network: null }, updatedB]));
    await summary('190000');

    expectError(await send(app, 'listAccountCards', undefined, undefined, accountId), 401, 'SESSION_EXPIRED');
    expectError(await send(app, 'listAccountCards', undefined, otherOwner.session, accountId), 404, 'NOT_FOUND');
    expectError(await send(app, 'createAccountCard', first, otherOwner.session, accountId), 404, 'NOT_FOUND');
    expectError(await send(app, 'updateAccountCard', edit, session, secondEuro, cardA.cardId), 404, 'NOT_FOUND');
    expectError(await send(app, 'deleteAccountCard', undefined, otherOwner.session, accountId, cardA.cardId), 404, 'NOT_FOUND');
    expectError(await send(app, 'deleteAccountCard', undefined, session, secondEuro, cardA.cardId), 404, 'NOT_FOUND');
    expectError(await send(app, 'createAccountCard', { ...first, lastFour: '00421' }, session, accountId), 400, 'INVALID_REQUEST');
    expectError(await send(app, 'updateAccountCard', { ...edit, appearance: 'blue' }, session, accountId, cardA.cardId), 400, 'INVALID_REQUEST');

    for (const { cardId } of [cardA, cardB]) {
      const deleted = await send(app, 'deleteAccountCard', undefined, session, accountId, cardId);
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.deepEqual(deleted.json(), { ok: true });
    }
    assert.deepEqual(await list(), []);
    await summary('190000');
    expectError(await send(app, 'deleteAccountCard', undefined, session, accountId, cardA.cardId), 404, 'NOT_FOUND');

    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM account_cards WHERE account_id = ${accountId}`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT object_id, event FROM audit_events
      WHERE user_id = ${userId} AND event LIKE 'finance.card.%' ORDER BY id DESC LIMIT 3`), [
      { object_id: cardB.cardId, event: 'finance.card.deleted' },
      { object_id: cardA.cardId, event: 'finance.card.deleted' },
      { object_id: cardA.cardId, event: 'finance.card.updated' },
    ]);
    assert.deepEqual(await one(reader.db, sql`SELECT version FROM accounts WHERE id = ${accountId}`), { version: 2 });
  });

  await t.test('Create an account once, then record and replay its first expense', async () => {
    const { userId, session, newKey } = await activateOwner();
    const input: Body<'createAccount'> = {
      name: 'Счёт EUR', currency: 'EUR', startDate: '2027-01-01', openingBalanceMinor: '100000', idempotencyKey: newKey(),
    };
    const [created, concurrentCreate] = await Promise.all([
      send(app, 'createAccount', input, session),
      send(app, 'createAccount', input, session),
    ]);
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(concurrentCreate.statusCode, 200, concurrentCreate.body);
    const opening = created.json<Result<'createAccount'>>();
    const { accountId } = opening;
    assert.deepEqual(opening, { accountId, name: input.name, currency: 'EUR', startDate: input.startDate,
      accountVersion: 1, balanceMinor: '100000' });
    assert.deepEqual(concurrentCreate.json(), opening);
    expectError(await send(app, 'createAccount', { ...input, openingBalanceMinor: '110000' }, session),
      409, 'IDEMPOTENCY_CONFLICT');

    const { db: verify } = reader;
    assert.deepEqual(await rows(verify, sql`SELECT id, version, CAST(opening_balance_minor AS CHAR) AS opening
      FROM accounts WHERE user_id = ${userId}`), [{ id: accountId, version: 1, opening: '100000' }]);
    assert.deepEqual(await rows(verify, sql`SELECT event, actor_id, object_id FROM audit_events
      WHERE user_id = ${userId} AND event = 'finance.account.created'`),
    [{ event: 'finance.account.created', actor_id: userId, object_id: accountId }]);
    assert.deepEqual(await rows(verify, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);

    const readBalance = () => send(app, 'getAccountBalance', undefined, session, accountId);
    const beforeExpense = await readBalance();
    assert.equal(beforeExpense.statusCode, 200, beforeExpense.body);
    assert.deepEqual(beforeExpense.json(), opening);

    // The same key value can be used for a different command type.
    const expense = expenseFor(accountId, input.idempotencyKey);
    const [first, concurrent] = await Promise.all([
      send(app, 'recordTransaction', expense, session),
      send(app, 'recordTransaction', expense, session),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(concurrent.statusCode, 200, concurrent.body);
    const result = first.json<Result<'recordTransaction'>>();
    assert.deepEqual(result, { transactionId: result.transactionId, transactionVersion: 1,
      accountId, accountVersion: 2, currency: 'EUR', balanceMinor: '90000' });
    assert.deepEqual(concurrent.json(), result);
    const replay = await send(app, 'recordTransaction', expense, session);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), result);
    expectError(await send(app, 'recordTransaction', { ...expense, amountMinor: '12000' }, session), 409, 'IDEMPOTENCY_CONFLICT');

    const afterExpense = await readBalance();
    assert.equal(afterExpense.statusCode, 200, afterExpense.body);
    assert.deepEqual(afterExpense.json(), { ...opening, accountVersion: 2, balanceMinor: '90000' });
    const replayCreate = await send(restored, 'createAccount', input, session);
    assert.equal(replayCreate.statusCode, 200, replayCreate.body);
    assert.deepEqual(replayCreate.json(), opening);

    assert.deepEqual(await rows(verify, sql`SELECT id, kind, current_version FROM transactions WHERE user_id = ${userId}`),
      [{ id: result.transactionId, kind: 'expense', current_version: 1 }]);
    assert.deepEqual(await rows(verify, sql`SELECT version, status, financial_date, category_id, created_at
      FROM transaction_versions WHERE transaction_id = ${result.transactionId}`),
    [{ version: 1, status: 'posted', financial_date: expense.date, category_id: expense.categoryId, created_at: now }]);
    assert.deepEqual(await rows(verify, sql`SELECT transaction_id, transaction_version, CAST(amount_minor AS CHAR) AS amount
      FROM movements WHERE account_id = ${accountId}`),
    [{ transaction_id: result.transactionId, transaction_version: 1, amount: '-10000' }]);
    assert.deepEqual(await rows(verify, sql`SELECT actor_role, actor_id, object_id, happened_at, transition
      FROM audit_events WHERE user_id = ${userId} AND event = 'expense.recorded'`),
    [{ actor_role: 'user', actor_id: userId, object_id: result.transactionId, happened_at: now,
      transition: { from: '0', to: '1' } }]);
    assert.deepEqual(await rows(verify, sql`SELECT command, command_key, result FROM idempotency_keys
      WHERE actor_id = ${userId} ORDER BY command`), [
      { command: 'account.create', command_key: input.idempotencyKey, result: opening },
      { command: 'expense.record', command_key: expense.idempotencyKey, result },
    ]);
    assert.deepEqual(await one(verify, sql`SELECT a.version,
      CAST(a.opening_balance_minor + (SELECT SUM(amount_minor) FROM movements WHERE account_id = a.id) AS CHAR) AS balance
      FROM accounts a WHERE a.id = ${accountId}`), { version: 2, balance: '90000' });
  });

  await t.test('Account input limits and owner-only balance access', async () => {
    const { userId, session, newKey } = await activateOwner();
    const other = await activateOwner();
    const input: Body<'createAccount'> = {
      name: 'Synthetic USD', currency: 'USD', startDate: '2027-02-01', openingBalanceMinor: '0', idempotencyKey: newKey(),
    };
    expectError(await send(app, 'createAccount', input), 401, 'SESSION_EXPIRED');
    expectError(await send(restored, 'createAccount', input, session), 409, 'COMMAND_REQUIRES_REVIEW');
    for (const change of [
      { name: '  ' }, { startDate: '2027-02-02' }, { startDate: '2027-02-30' },
      { openingBalanceMinor: '9223372036854775808' }, { openingBalanceMinor: '-9223372036854775809' },
    ]) {
      expectError(await send(app, 'createAccount', { ...input, ...change }, session), 400, 'INVALID_REQUEST');
    }
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM accounts WHERE user_id = ${userId}`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT command_key FROM idempotency_keys WHERE actor_id = ${userId}`), []);

    for (const openingBalanceMinor of ['0', '-9223372036854775808', '9223372036854775807']) {
      const created: LightMyRequestResponse = await send(app, 'createAccount', { ...input, openingBalanceMinor }, session);
      assert.equal(created.statusCode, 200, created.body);
      const account = created.json<Result<'createAccount'>>();
      assert.equal(account.balanceMinor, openingBalanceMinor);
      const read = await send(app, 'getAccountBalance', undefined, session, account.accountId);
      assert.equal(read.statusCode, 200, read.body);
      assert.deepEqual(read.json(), account);
      expectError(await send(app, 'getAccountBalance', undefined, other.session, account.accountId), 404, 'NOT_FOUND');
      expectError(await send(app, 'getAccountBalance', undefined, undefined, account.accountId), 401, 'SESSION_EXPIRED');
      input.idempotencyKey = newKey();
    }
    expectError(await send(app, 'getAccountBalance', undefined, session, 'invalid'), 400, 'INVALID_REQUEST');
  });

  await t.test('Account start date edits preserve the balance, update history and permit earlier schedule dates', async () => {
    const { accountId, session, userId, newKey } = await fixture();
    const other = await fixture();
    const date = '2026-12-01';
    const body = { startDate: date, expectedAccountVersion: 1 };
    const change = (payload: Body<'updateAccountStartDate'>, id = accountId) =>
      send(app, 'updateAccountStartDate', payload, session, id);
    expectError(await change(body, other.accountId), 404, 'NOT_FOUND');
    expectError(await change({ ...body, startDate: '2027-02-02' }), 400, 'INVALID_REQUEST');
    expectError(await change({ ...body, startDate: '2026-11-31' }), 400, 'INVALID_REQUEST');
    const changed = await change(body);
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual(changed.json<Result<'updateAccountStartDate'>>(), {
      accountId, name: 'Synthetic EUR', currency: 'EUR', startDate: date, accountVersion: 2, balanceMinor: '100000',
    });
    expectError(await change(body), 409, 'VERSION_CONFLICT');
    const noChange = await change({ ...body, expectedAccountVersion: 2 });
    assert.equal(noChange.statusCode, 200, noChange.body);
    assert.deepEqual(noChange.json(), changed.json());
    const history = await send(app, 'listAccountHistory', undefined, session, accountId);
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json<Result<'listAccountHistory'>>().entries,
      [{ id: accountId, date, type: 'opening', amountMinor: '100000' }]);

    const scheduled = await send(app, 'createScheduleRule', { ...scheduleInput(accountId, '2026-12-15'), frequency: 'once' }, session);
    assert.equal(scheduled.statusCode, 200, scheduled.body);
    expectError(await change({ startDate: '2026-12-16', expectedAccountVersion: 2 }), 409, 'ACCOUNT_START_DATE_CONFLICT');
    const manual = await send(app, 'recordTransaction', { ...expenseFor(accountId, newKey()), date }, session);
    assert.equal(manual.statusCode, 200, manual.body);
    expectError(await change({ startDate: '2026-12-02', expectedAccountVersion: 3 }), 409, 'ACCOUNT_START_DATE_CONFLICT');
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_id, actor_role, transition FROM audit_events
      WHERE user_id = ${userId} AND event = 'finance.account.start_date_changed'`),
    [{ actor_id: userId, actor_role: 'user', transition: { from: '2027-01-01', to: date } }]);
  });

  await t.test('An administrator can create a backdated deposit once and audit changes to its start date', async () => {
    const { userId, session, newKey } = await activateOwner();
    const other = await activateOwner();
    const { adminId, headers } = await adminSessionHeaders();
    const createPath = routes.adminCreateAccount.url.replace(':userId', userId);
    const request = (method: 'POST' | 'PUT', url: string, payload: object, requestHeaders = headers) =>
      app.inject({ method, url, payload, headers: requestHeaders, remoteAddress: '192.0.2.1' });
    const input = { name: 'Deposit EUR', currency: 'EUR', type: 'deposit', openingBalanceMinor: '25000',
      startDate: '2026-12-01', annualRatePercent: '2.5', maturityDate: '2027-01-31',
      reason: 'Opening date on statement', idempotencyKey: newKey() } as const;
    expectError(await request('POST', createPath, input, { ...headers, 'x-csrf-token': '' }), 403, 'CSRF_INVALID');
    expectError(await request('POST', createPath, { ...input, startDate: '2027-02-02' }), 400, 'INVALID_REQUEST');
    const [first, replay] = await Promise.all([request('POST', createPath, input), request('POST', createPath, input)]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(replay.statusCode, 200, replay.body);
    const opening = first.json<Result<'adminCreateAccount'>>();
    assert.equal(opening.startDate, input.startDate);
    assert.deepEqual(replay.json(), opening);
    const reference = { userId, command: 'account.create', idempotencyKey: input.idempotencyKey };
    const status = await request('POST', routes.adminCommandStatus.url, reference);
    assert.equal(status.statusCode, 200, status.body);
    assert.deepEqual(status.json(), { state: 'committed', result: opening });
    expectError(await request('POST', routes.adminCommandStatus.url, { ...reference, userId: other.userId }), 404, 'NOT_FOUND');

    const { accountId } = opening;
    const editPath = routes.adminUpdateAccountStartDate.url.replace(':userId', userId).replace(':accountId', accountId);
    const edit = { startDate: '2027-01-10', expectedAccountVersion: 1, reason: 'Corrected statement date' };
    expectError(await request('PUT', editPath, edit, { ...headers, 'x-csrf-token': '' }), 403, 'CSRF_INVALID');
    expectError(await request('PUT', editPath.replace(userId, other.userId), edit), 404, 'NOT_FOUND');
    expectError(await request('PUT', editPath, { ...edit, reason: ' ' }), 400, 'INVALID_REQUEST');
    expectError(await request('PUT', editPath, { ...edit, startDate: '2027-02-01' }), 400, 'INVALID_REQUEST');
    const saved = await request('PUT', editPath, edit);
    assert.equal(saved.statusCode, 200, saved.body);
    const updated = { ...opening, startDate: edit.startDate, accountVersion: 2 };
    assert.deepEqual(saved.json(), updated);
    const read = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json(), updated);
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_id, actor_role, event, transition FROM audit_events
      WHERE object_id = ${accountId} ORDER BY id`), [
      { actor_id: adminId, actor_role: 'admin', event: 'finance.account.created',
        transition: { from: '0', to: '1', reason: input.reason } },
      { actor_id: adminId, actor_role: 'admin', event: 'finance.account.start_date_changed',
        transition: { from: input.startDate, to: edit.startDate, reason: edit.reason } },
    ]);
  });

  await t.test('Concurrent deposit creation stores one account and opening balance', async () => {
    const { userId, session, newKey } = await activateOwner();
    const other = await activateOwner();
    const accountInput = {
      name: 'Вклад EUR', currency: 'EUR', startDate: '2027-01-01',
      openingBalanceMinor: '9007199254740993', idempotencyKey: newKey(),
    } as const;
    const input = { ...accountInput, type: 'deposit', annualRatePercent: '4.1250', maturityDate: '2028-02-29' } as const;
    const [created, concurrent] = await Promise.all([
      send(app, 'createAccount', input, session),
      send(app, 'createAccount', input, session),
    ]);
    assert.equal(created.statusCode, 200, created.body);
    const { accountId } = created.json<Result<'createAccount'>>();
    const opening = { accountId, name: input.name, currency: input.currency, startDate: input.startDate,
      type: input.type, annualRatePercent: input.annualRatePercent, maturityDate: input.maturityDate,
      accountVersion: 1, balanceMinor: input.openingBalanceMinor };
    assert.deepEqual(created.json(), opening);
    for (const replay of [concurrent, await send(app, 'createAccount', { ...input, annualRatePercent: '4.125' }, session)]) {
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), opening);
    }
    for (const changed of [accountInput, { ...input, annualRatePercent: '4.1251' },
      { ...input, maturityDate: '2028-03-01' }, { ...input, openingBalanceMinor: '9007199254740994' }]) {
      expectError(await send(app, 'createAccount', changed, session), 409, 'IDEMPOTENCY_CONFLICT');
    }

    const read = () => send(app, 'getAccountBalance', undefined, session, accountId);
    const beforeExpense = await read();
    assert.equal(beforeExpense.statusCode, 200, beforeExpense.body);
    assert.deepEqual(beforeExpense.json(), opening);
    expectError(await send(app, 'getAccountBalance', undefined, other.session, accountId), 404, 'NOT_FOUND');
    expectError(await send(app, 'getAccountBalance', undefined, undefined, accountId), 401, 'SESSION_EXPIRED');

    const { db: verify } = reader;
    assert.deepEqual(await rows(verify, sql`SELECT id, kind, version,
      CAST(opening_balance_minor AS CHAR) AS opening, CAST(annual_rate_percent AS CHAR) AS rate, maturity_date
      FROM accounts WHERE user_id = ${userId}`), [{ id: accountId, kind: 'deposit', version: 1,
      opening: input.openingBalanceMinor, rate: input.annualRatePercent, maturity_date: input.maturityDate }]);
    assert.deepEqual(await rows(verify, sql`SELECT object_id FROM audit_events
      WHERE user_id = ${userId} AND event = 'finance.account.created'`), [{ object_id: accountId }]);
    assert.deepEqual(await rows(verify, sql`SELECT command_key, result FROM idempotency_keys
      WHERE actor_id = ${userId} AND command = 'account.create'`), [{ command_key: input.idempotencyKey, result: opening }]);
    assert.deepEqual(await rows(verify, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
    assert.deepEqual(await rows(verify, sql`SELECT transaction_id FROM movements WHERE account_id = ${accountId}`), []);

    const expense = await send(app, 'recordTransaction', expenseFor(accountId, newKey()), session);
    assert.equal(expense.statusCode, 200, expense.body);
    const afterExpense = await read();
    assert.equal(afterExpense.statusCode, 200, afterExpense.body);
    assert.deepEqual(afterExpense.json(), { ...opening, accountVersion: 2, balanceMinor: '9007199254730993' });
    const restoredReplay = await send(restored, 'createAccount', input, session);
    assert.equal(restoredReplay.statusCode, 200, restoredReplay.body);
    assert.deepEqual(restoredReplay.json(), opening);
  });

  await t.test('Deposit terms are required and invalid input leaves the command key available', async () => {
    const { userId, session, newKey } = await activateOwner();
    const input = {
      type: 'deposit', name: 'Вклад RUB', currency: 'RUB', startDate: '2027-01-01', openingBalanceMinor: '0',
      annualRatePercent: '0', maturityDate: '2027-01-01', idempotencyKey: newKey(),
    } as const;
    for (const invalid of [
      { annualRatePercent: undefined }, { maturityDate: undefined }, { type: undefined }, { type: 'regular' },
      { annualRatePercent: 1.25 }, { annualRatePercent: '-0.1' }, { annualRatePercent: '1000' },
      { annualRatePercent: '4.12345' }, { maturityDate: '2027-02-29' }, { maturityDate: '2026-12-31' },
    ]) {
      // Send malformed JSON shapes that the TypeScript client contract disallows.
      const body = { ...input, ...invalid } as Body<'createAccount'>;
      expectError(await send(app, 'createAccount', body, session), 400, 'INVALID_REQUEST');
    }
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM accounts WHERE user_id = ${userId}`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT command_key FROM idempotency_keys WHERE actor_id = ${userId}`), []);

    const created = await send(app, 'createAccount', input, session);
    assert.equal(created.statusCode, 200, created.body);
    const { accountId } = created.json<Result<'createAccount'>>();
    const read = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json(), { accountId, name: input.name, type: input.type, currency: input.currency,
      startDate: input.startDate, maturityDate: input.maturityDate, annualRatePercent: '0.0000',
      accountVersion: 1, balanceMinor: '0' });
  });

  await t.test('Deposit interest increases the balance with exactly one movement across retries', async () => {
    const { userId, session, newKey } = await activateOwner();
    const other = await activateOwner();
    const deposit = await send(app, 'createAccount', {
      type: 'deposit', name: 'Вклад EUR', currency: 'EUR', startDate: '2027-01-01', openingBalanceMinor: '100000',
      annualRatePercent: '4.125', maturityDate: '2028-02-29', idempotencyKey: newKey(),
    }, session);
    assert.equal(deposit.statusCode, 200, deposit.body);
    const { accountId } = deposit.json<Result<'createAccount'>>();
    const input = {
      type: 'income', accountId, date: '2027-02-01', amountMinor: '2500', categoryId: 'deposit-interest',
      comment: 'Проценты начислены банком', idempotencyKey: newKey(),
    } as const;
    expectError(await send(app, 'recordTransaction', input), 401, 'SESSION_EXPIRED');
    expectError(await send(app, 'recordTransaction', input, other.session), 404, 'NOT_FOUND');
    for (const change of [
      { categoryId: 'groceries' }, { categoryId: 'missing' }, { amountMinor: '0' }, { amountMinor: '-2500' },
      { amountMinor: '9223372036854775808' }, { date: '2026-12-31' }, { date: '2027-02-02' },
    ]) {
      expectError(await send(app, 'recordTransaction', { ...input, ...change }, session), 400, 'INVALID_REQUEST');
    }
    expectError(await send(app, 'recordTransaction', { ...input, type: 'expense' }, session), 400, 'INVALID_REQUEST');

    const [first, concurrent] = await Promise.all([
      send(app, 'recordTransaction', input, session),
      send(app, 'recordTransaction', input, session),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    const result = first.json<Result<'recordTransaction'>>();
    assert.deepEqual(result, { transactionId: result.transactionId, transactionVersion: 1,
      accountId, accountVersion: 2, currency: 'EUR', balanceMinor: '102500' });
    for (const replay of [concurrent, await send(app, 'recordTransaction', input, session)]) {
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), result);
    }
    expectError(await send(app, 'recordTransaction', { ...input, amountMinor: '2600' }, session), 409, 'IDEMPOTENCY_CONFLICT');

    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.statusCode, 200, balance.body);
    assert.deepEqual(balance.json(), { ...deposit.json(), accountVersion: 2, balanceMinor: '102500' });
    const summary = await send(app, 'getCurrencySummary', undefined, session);
    assert.equal(summary.statusCode, 200, summary.body);
    assert.deepEqual(summary.json(), { balances: [{ currency: 'EUR', balanceMinor: '102500' }] });

    const { transactionId } = result;
    const { db: verify } = reader;
    assert.deepEqual(await rows(verify, sql`SELECT id, kind, current_version FROM transactions WHERE user_id = ${userId}`),
      [{ id: transactionId, kind: 'income', current_version: 1 }]);
    assert.deepEqual(await rows(verify, sql`SELECT version, status, financial_date, category_id, comment
      FROM transaction_versions WHERE transaction_id = ${transactionId}`),
    [{ version: 1, status: 'posted', financial_date: input.date, category_id: input.categoryId, comment: input.comment }]);
    assert.deepEqual(await rows(verify, sql`SELECT transaction_id, transaction_version, CAST(amount_minor AS CHAR) AS amount
      FROM movements WHERE account_id = ${accountId}`), [{ transaction_id: transactionId, transaction_version: 1, amount: '2500' }]);
    assert.deepEqual(await rows(verify, sql`SELECT object_id FROM audit_events WHERE user_id = ${userId} AND event = 'income.recorded'`),
      [{ object_id: transactionId }]);
    assert.deepEqual(await rows(verify, sql`SELECT command_key, result FROM idempotency_keys
      WHERE actor_id = ${userId} AND command = 'income.record'`), [{ command_key: input.idempotencyKey, result }]);

    const expense = await send(app, 'recordTransaction', expenseFor(accountId, input.idempotencyKey), session);
    assert.equal(expense.statusCode, 200, expense.body);
    assert.equal(expense.json<SingleAccountResult>().balanceMinor, '92500');
    const restoredReplay = await send(restored, 'recordTransaction', input, session);
    assert.equal(restoredReplay.statusCode, 200, restoredReplay.body);
    assert.deepEqual(restoredReplay.json(), result);
  });

  await t.test('Other income works on a regular account with exact minor units', async () => {
    const { accountId, session, expense } = await fixture();
    const income = await send(app, 'recordTransaction', {
      ...expense, type: 'income', categoryId: 'other-income', amountMinor: '9223372036854775807',
    }, session);
    assert.equal(income.statusCode, 200, income.body);
    assert.equal(income.json<SingleAccountResult>().balanceMinor, '9223372036854875807');
    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.statusCode, 200, balance.body);
    assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '9223372036854875807');
  });

  await t.test('A 100 USD to 92 EUR transfer posts two movements once across concurrent retries', async () => {
    const { userId, session, transfer } = await transferFixture();
    const { fromAccountId, toAccountId } = transfer;
    const other = await fixture();
    const sameCurrencyId = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${sameCurrencyId}, ${userId}, 'Second USD account', 'USD', '2027-01-01', 0)`);
    expectError(await send(app, 'recordTransaction', transfer), 401, 'SESSION_EXPIRED');
    expectError(await send(app, 'recordTransaction', { ...transfer, toAccountId: other.accountId }, session), 404, 'NOT_FOUND');
    expectError(await send(app, 'recordTransaction', { ...transfer, fromAccountId: other.accountId }, session), 404, 'NOT_FOUND');
    for (const change of [
      { toAccountId: fromAccountId }, { toAccountId: sameCurrencyId },
      { fromAmountMinor: '0' }, { toAmountMinor: '9223372036854775808' },
      { date: '2027-01-31' }, { date: '2027-02-02' },
    ]) {
      expectError(await send(app, 'recordTransaction', { ...transfer, ...change }, session), 400, 'INVALID_REQUEST');
    }
    await db.execute(sql`UPDATE accounts SET archived = TRUE WHERE id = ${toAccountId}`);
    expectError(await send(app, 'recordTransaction', transfer, session), 409, 'ACCOUNT_UNAVAILABLE');
    await db.execute(sql`UPDATE accounts SET archived = FALSE WHERE id = ${toAccountId}`);
    await transferBalances(session, '20000', '50000');

    const [first, concurrent] = await Promise.all([
      send(app, 'recordTransaction', transfer, session), send(app, 'recordTransaction', transfer, session),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    const result = first.json<TransferResult>();
    const { transactionId } = result;
    assert.deepEqual(result, { transactionId, transactionVersion: 1,
      fromAccount: { accountId: fromAccountId, currency: 'USD', accountVersion: 2, balanceMinor: '40000' },
      toAccount: { accountId: toAccountId, currency: 'EUR', accountVersion: 2, balanceMinor: '29200' },
    });
    for (const replay of [concurrent, await send(restored, 'recordTransaction', transfer, session)]) {
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), result);
    }
    expectError(await send(app, 'recordTransaction', { ...transfer, toAmountMinor: '9300' }, session), 409, 'IDEMPOTENCY_CONFLICT');
    await transferBalances(session, '29200', '40000');

    const { db: verify } = reader;
    assert.deepEqual(await rows(verify, sql`SELECT id, kind, current_version FROM transactions WHERE user_id = ${userId}`),
      [{ id: transactionId, kind: 'transfer', current_version: 1 }]);
    assert.deepEqual(await rows(verify, sql`SELECT version, status, financial_date, category_id, comment
      FROM transaction_versions WHERE transaction_id = ${transactionId}`),
    [{ version: 1, status: 'posted', financial_date: transfer.date, category_id: null, comment: transfer.comment }]);
    const movements = await rows(verify, sql`SELECT transaction_id, transaction_version, account_id, CAST(amount_minor AS CHAR) AS amount
      FROM movements WHERE account_id IN (${fromAccountId}, ${toAccountId})`);
    assert.deepEqual(new Set(movements), new Set([
      { transaction_id: transactionId, transaction_version: 1, account_id: fromAccountId, amount: '-10000' },
      { transaction_id: transactionId, transaction_version: 1, account_id: toAccountId, amount: '9200' },
    ]));
    assert.deepEqual(await rows(verify, sql`SELECT object_id, transition FROM audit_events
      WHERE user_id = ${userId} AND event = 'transfer.recorded'`), [{ object_id: transactionId, transition: { from: '0', to: '1' } }]);
    assert.deepEqual(await rows(verify, sql`SELECT command_key, result FROM idempotency_keys
      WHERE actor_id = ${userId} AND command = 'transfer.record'`), [{ command_key: transfer.idempotencyKey, result }]);

    const sameCurrency = await send(app, 'recordTransaction', {
      ...transfer, toAccountId: sameCurrencyId, toAmountMinor: transfer.fromAmountMinor, idempotencyKey: `1.${token()}`,
    }, session);
    assert.equal(sameCurrency.statusCode, 200, sameCurrency.body);
    const sameCurrencyResult = sameCurrency.json<TransferResult>();
    assert.equal(sameCurrencyResult.fromAccount.balanceMinor, '30000');
    assert.equal(sameCurrencyResult.toAccount.balanceMinor, '10000');
    await transferBalances(session, '29200', '40000');
  });

  await t.test('MySQL rejection of the second transfer movement rolls back the debit and releases the key', async () => {
    const { userId, session, transfer } = await transferFixture();
    const { fromAccountId, toAccountId } = transfer;
    await db.execute(sql`ALTER TABLE movements ADD CONSTRAINT test_reject_transfer_credit CHECK (account_id <> ${toAccountId})`);
    try {
      expectError(await send(app, 'recordTransaction', transfer, session), 500, 'INTERNAL_ERROR');
      await transferBalances(session, '20000', '50000');
      const { db: verify } = reader;
      assert.deepEqual(await rows(verify, sql`SELECT version FROM accounts WHERE user_id = ${userId}`), [{ version: 1 }, { version: 1 }]);
      assert.deepEqual(await rows(verify, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
      assert.deepEqual(await rows(verify, sql`SELECT transaction_id FROM movements WHERE account_id IN (${fromAccountId}, ${toAccountId})`), []);
      assert.deepEqual(await rows(verify, sql`SELECT id FROM audit_events WHERE user_id = ${userId} AND event = 'transfer.recorded'`), []);
      assert.deepEqual(await rows(verify, sql`SELECT command_key FROM idempotency_keys WHERE actor_id = ${userId}`), []);
    } finally {
      await db.execute(sql`ALTER TABLE movements DROP CHECK test_reject_transfer_credit`);
    }
    const retry = await send(app, 'recordTransaction', transfer, session);
    assert.equal(retry.statusCode, 200, retry.body);
    const replay = await send(app, 'recordTransaction', transfer, session);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), retry.json());
    await transferBalances(session, '29200', '40000');
  });

  await t.test('Concurrent expense revisions reject a stale version, and void preserves the earlier movements', async () => {
    const { userId, session, expense } = await fixture();
    const { accountId } = expense;
    const other = await fixture();
    const recorded = await send(app, 'recordTransaction', expense, session);
    assert.equal(recorded.statusCode, 200, recorded.body);
    const { transactionId } = recorded.json<SingleAccountResult>();
    const revise = { ...expense, amountMinor: '12000', expectedTransactionVersion: 1, idempotencyKey: `1.${token()}` };
    const rival = { ...revise, amountMinor: '15000', idempotencyKey: `1.${token()}` };
    expectError(await send(app, 'reviseTransaction', revise, other.session, transactionId), 404, 'NOT_FOUND');
    expectError(await send(app, 'reviseTransaction', { ...revise, accountId: other.accountId }, session, transactionId), 404, 'NOT_FOUND');
    expectError(await send(app, 'listTransactionVersions', undefined, other.session, transactionId), 404, 'NOT_FOUND');

    const [first, second] = await Promise.all([
      send(app, 'reviseTransaction', revise, session, transactionId),
      send(app, 'reviseTransaction', rival, session, transactionId),
    ]);
    const [winner, winningInput, stale] = first.statusCode === 200 ? [first, revise, second] : [second, rival, first];
    expectError(stale, 409, 'VERSION_CONFLICT');
    assert.equal(winner.statusCode, 200, winner.body);
    const balanceMinor = winningInput === revise ? '88000' : '85000';
    const corrected = { transactionId, transactionVersion: 2, status: 'posted', accounts: [
      { accountId, accountVersion: 3, currency: 'EUR', balanceMinor },
    ] };
    assert.deepEqual(winner.json(), corrected);
    const replay = await send(app, 'reviseTransaction', winningInput, session, transactionId);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), corrected);
    expectError(await send(app, 'reviseTransaction', { ...winningInput, amountMinor: '9000' }, session, transactionId),
      409, 'IDEMPOTENCY_CONFLICT');
    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.statusCode, 200, balance.body);
    assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, balanceMinor);

    const cancellation = { expectedTransactionVersion: 2, idempotencyKey: `1.${token()}` };
    expectError(await send(app, 'voidTransaction', { ...cancellation, expectedTransactionVersion: 1 }, session, transactionId),
      409, 'VERSION_CONFLICT');
    const voided = await send(app, 'voidTransaction', cancellation, session, transactionId);
    assert.equal(voided.statusCode, 200, voided.body);
    assert.deepEqual(voided.json(), { transactionId, transactionVersion: 3, status: 'void', accounts: [
      { accountId, accountVersion: 4, currency: 'EUR', balanceMinor: '100000' },
    ] });
    const voidReplay = await send(restored, 'voidTransaction', cancellation, session, transactionId);
    assert.equal(voidReplay.statusCode, 200, voidReplay.body);
    assert.deepEqual(voidReplay.json(), voided.json());
    expectError(await send(app, 'voidTransaction', { expectedTransactionVersion: 3, idempotencyKey: `1.${token()}` }, session,
      transactionId), 409, 'TRANSACTION_VOID');
    const finalBalance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(finalBalance.statusCode, 200, finalBalance.body);
    assert.equal(finalBalance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');

    const history = await send(app, 'listTransactionVersions', undefined, session, transactionId);
    assert.equal(history.statusCode, 200, history.body);
    const metadata = { date: expense.date, categoryId: 'groceries', comment: null,
      createdAt: new Date(now).toISOString(), actorRole: 'user', reason: null };
    assert.deepEqual(history.json(), { transactionId, transactionVersion: 3, type: 'expense', versions: [
      { ...metadata, version: 1, status: 'posted', movements: [{ accountId, currency: 'EUR', amountMinor: '-10000' }] },
      { ...metadata, version: 2, status: 'posted', movements: [{ accountId, currency: 'EUR', amountMinor: `-${winningInput.amountMinor}` }] },
      { ...metadata, version: 3, status: 'void', movements: [] },
    ] });
    assert.deepEqual(await rows(reader.db, sql`SELECT id, current_version FROM transactions WHERE user_id = ${userId}`),
      [{ id: transactionId, current_version: 3 }]);
    assert.deepEqual(await rows(reader.db, sql`SELECT event, transition FROM audit_events
      WHERE user_id = ${userId} AND object_id = ${transactionId} ORDER BY id`), [
      { event: 'expense.recorded', transition: { from: '0', to: '1' } },
      { event: 'transaction.revised', transition: { from: '1', to: '2' } },
      { event: 'transaction.voided', transition: { from: '2', to: '3' } },
    ]);
    assert.deepEqual(await rows(reader.db, sql`SELECT command, command_key FROM idempotency_keys
      WHERE actor_id = ${userId} AND command LIKE 'transaction.%' ORDER BY command`), [
      { command: 'transaction.revise', command_key: winningInput.idempotencyKey },
      { command: 'transaction.void', command_key: cancellation.idempotencyKey },
    ]);
  });

  await t.test('Income source is visible in ledger reads and supports revision and explicit clearing', async () => {
    const { accountId, session, expense, newKey } = await fixture();
    expectError(await send(app, 'recordTransaction', { ...expense, incomeSource: 'Bank' }, session), 400, 'INVALID_REQUEST');
    const input = { ...expense, type: 'income', categoryId: 'other-income', incomeSource: '  Example Bank  ' } as const;
    const recorded = await send(app, 'recordTransaction', input, session);
    assert.equal(recorded.statusCode, 200, recorded.body);
    const { transactionId } = recorded.json<SingleAccountResult>();
    expectError(await send(app, 'recordTransaction', { ...input, incomeSource: 'Other bank' }, session),
      409, 'IDEMPOTENCY_CONFLICT');

    const { incomeSource: _source, ...fields } = input;
    const revised = await send(app, 'reviseTransaction', { ...fields, expectedTransactionVersion: 1, idempotencyKey: newKey() },
      session, transactionId);
    assert.equal(revised.statusCode, 200, revised.body);
    const ledger = await send(app, 'listAccountHistory', undefined, session, accountId);
    assert.equal(ledger.statusCode, 200, ledger.body);
    const entry = ledger.json<Result<'listAccountHistory'>>().entries.find(({ id }) => id === transactionId);
    assert.equal(entry?.type === 'income' && entry.incomeSource, 'Example Bank');
    assert.equal(entry?.type === 'income' && entry.source, 'Example Bank');
    assert.equal((await readStatistics(session)).entries.find((item) => item.transactionId === transactionId)?.incomeSource, 'Example Bank');

    const cleared = await send(app, 'reviseTransaction', {
      ...fields, expectedTransactionVersion: 2, idempotencyKey: newKey(), incomeSource: null,
    }, session, transactionId);
    assert.equal(cleared.statusCode, 200, cleared.body);
    const history = await send(app, 'listTransactionVersions', undefined, session, transactionId);
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json<Result<'listTransactionVersions'>>().versions.map(({ incomeSource }) => incomeSource),
      ['Example Bank', 'Example Bank', undefined]);
  });

  await t.test('A late scheduled income keeps the source effective on the date it was due', async () => {
    const previous = now;
    try {
      now = Date.parse('2027-02-01T01:00:00Z');
      const { userId, accountId, session, installationSecret } = await fixture();
      const firstDate = '2027-02-01';
      const created = await send(app, 'createScheduleRule', {
        ...scheduleInput(accountId, firstDate), kind: 'income', categoryId: 'other-income', incomeSource: 'First payer',
      }, session);
      assert.equal(created.statusCode, 200, created.body);
      const { ruleId } = created.json<Result<'createScheduleRule'>>();
      const changed = await send(app, 'changeScheduleRule', {
        action: 'edit', expectedRuleVersion: 1, incomeSource: 'Next payer',
      }, session, ruleId);
      assert.equal(changed.statusCode, 200, changed.body);
      const actualPostingTime = Date.parse('2027-02-02T01:23:45Z');
      const outcome = await processScheduleDate(db, { userId, accountId, ruleId, date: firstDate }, () => actualPostingTime);
      assert.equal(outcome?.status, 'posted');
      now = actualPostingTime;
      const refreshedSession = await renewMobileSession(installationSecret);
      const history = await send(app, 'listTransactionVersions', undefined, refreshedSession, outcome.transactionId);
      assert.equal(history.statusCode, 200, history.body);
      const [version] = history.json<Result<'listTransactionVersions'>>().versions;
      assert.equal(version.incomeSource, 'First payer');
      assert.equal(version.date, firstDate);
      assert.equal(version.createdAt, new Date(actualPostingTime).toISOString());

      const calendar = await occurrences(refreshedSession, firstDate, '2027-02-08', ruleId);
      assert.equal(calendar.statusCode, 200, calendar.body);
      assert.deepEqual(calendar.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ incomeSource, status }) =>
        [incomeSource, status]), [['First payer', 'posted'], ['Next payer', 'planned']]);
    } finally {
      now = previous;
    }
  });

  await t.test('Expense sources work for manual records, scheduled posting, and clearing on edit', async () => {
    const { userId, accountId, session, expense, newKey } = await fixture();
    const manual = await send(app, 'recordTransaction', { ...expense, source: '  Local shop  ' }, session);
    assert.equal(manual.statusCode, 200, manual.body);
    const { transactionId: manualId } = manual.json<SingleAccountResult>();

    const created = await send(app, 'createScheduleRule', {
      ...scheduleInput(accountId, expense.date), frequency: 'once', categoryId: 'education', source: 'Learning site',
    }, session);
    assert.equal(created.statusCode, 200, created.body);
    const rule = created.json<Result<'createScheduleRule'>>();
    assert.equal(rule.source, 'Learning site');
    assert.equal(rule.incomeSource, undefined);
    const occurrence = await processScheduleDate(db, { userId, accountId, ruleId: rule.ruleId, date: rule.firstDate }, () => now);
    assert.equal(occurrence?.status, 'posted');
    const scheduledId = occurrence.transactionId;
    const calendar = await occurrences(session, rule.firstDate, rule.firstDate, rule.ruleId);
    assert.equal(calendar.statusCode, 200, calendar.body);
    assert.equal(calendar.json<Result<'listScheduleOccurrences'>>().occurrences[0].source, 'Learning site');

    const ledger = await send(app, 'listAccountHistory', undefined, session, accountId);
    assert.equal(ledger.statusCode, 200, ledger.body);
    const entries = ledger.json<Result<'listAccountHistory'>>().entries;
    const manualEntry = entries.find(({ id }) => id === manualId);
    const scheduledEntry = entries.find(({ id }) => id === scheduledId);
    assert.ok(manualEntry?.type === 'expense' && scheduledEntry?.type === 'expense');
    assert.equal(manualEntry.source, 'Local shop');
    assert.equal(scheduledEntry.source, 'Learning site');
    assert.equal(scheduledEntry.incomeSource, undefined);
    assert.equal((await readStatistics(session)).entries.find(({ transactionId }) => transactionId === scheduledId)?.source, 'Learning site');

    const cleared = await send(app, 'reviseTransaction', {
      ...expense, categoryId: 'education', expectedTransactionVersion: 1,
      amountMinor: rule.amountMinor, idempotencyKey: newKey(), source: null,
    }, session, scheduledId);
    assert.equal(cleared.statusCode, 200, cleared.body);
    const history = await send(app, 'listTransactionVersions', undefined, session, scheduledId);
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json<Result<'listTransactionVersions'>>().versions.map(({ source }) => source),
      ['Learning site', undefined]);
  });

  await t.test('An income revision can move its credit to another owned account and rolls back on failure', async () => {
    const { userId, session, transfer } = await transferFixture();
    const { fromAccountId, toAccountId, date } = transfer;
    const input = { type: 'income', accountId: fromAccountId, amountMinor: '2500', categoryId: 'other-income',
      date, idempotencyKey: transfer.idempotencyKey } as const;
    const recorded = await send(app, 'recordTransaction', input, session);
    assert.equal(recorded.statusCode, 200, recorded.body);
    const { transactionId } = recorded.json<SingleAccountResult>();
    const revision = { ...input, accountId: toAccountId, amountMinor: '3000', expectedTransactionVersion: 1 };
    await db.execute(sql`UPDATE accounts SET version = 4294967295 WHERE id = ${toAccountId}`);
    try {
      expectError(await send(app, 'reviseTransaction', revision, session, transactionId), 500, 'INTERNAL_ERROR');
      await transferBalances(session, '20000', '52500');
      assert.deepEqual(await rows(reader.db, sql`SELECT version FROM transaction_versions WHERE transaction_id = ${transactionId}`),
        [{ version: 1 }]);
      assert.deepEqual(await rows(reader.db, sql`SELECT command_key FROM idempotency_keys WHERE actor_id = ${userId}
        AND command = 'transaction.revise'`), []);
    } finally {
      await db.execute(sql`UPDATE accounts SET version = 1 WHERE id = ${toAccountId}`);
    }
    const edited = await send(app, 'reviseTransaction', revision, session, transactionId);
    assert.equal(edited.statusCode, 200, edited.body);
    const accounts = edited.json<Result<'reviseTransaction'>>().accounts;
    assert.deepEqual(new Set(accounts), new Set([
      { accountId: fromAccountId, accountVersion: 3, currency: 'USD', balanceMinor: '50000' },
      { accountId: toAccountId, accountVersion: 2, currency: 'EUR', balanceMinor: '23000' },
    ]));
    await transferBalances(session, '23000', '50000');
    const voided = await send(app, 'voidTransaction', { expectedTransactionVersion: 2, idempotencyKey: `1.${token()}` },
      session, transactionId);
    assert.equal(voided.statusCode, 200, voided.body);
    await transferBalances(session, '20000', '50000');
  });

  await t.test('An administrative transfer revision checks both preview versions and records the reason', async () => {
    const { userId, session, transfer } = await transferFixture();
    const other = await fixture();
    const { fromAccountId, toAccountId, idempotencyKey, ...transferFields } = transfer;
    const recorded = await send(app, 'recordTransaction', transfer, session);
    assert.equal(recorded.statusCode, 200, recorded.body);
    const { transactionId } = recorded.json<TransferResult>();
    const { adminId, headers } = await adminSessionHeaders();
    function adminSend<K extends Route>(name: K, payload?: Body<K>, ownerId = userId, csrf = headers['x-csrf-token']) {
      const { method, url } = routes[name];
      return app.inject({ method, url: url.replace(':userId', ownerId).replace(':transactionId', transactionId), payload,
        remoteAddress: '192.0.2.1', headers: { ...headers, 'x-csrf-token': csrf } });
    }
    const replacement = { ...transferFields, fromAccountId, toAccountId, fromAmountMinor: '12000', toAmountMinor: '11000' };
    expectError(await adminSend('adminPreviewTransactionRevision', replacement, other.userId), 404, 'NOT_FOUND');
    expectError(await adminSend('adminPreviewTransactionRevision', replacement, userId, 'invalid'), 403, 'CSRF_INVALID');
    async function preview() {
      const response = await adminSend('adminPreviewTransactionRevision', replacement);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Result<'adminPreviewTransactionRevision'>>();
    }
    const before = await preview();
    assert.deepEqual(new Set(before.accounts), new Set([
      { accountId: fromAccountId, accountVersion: 2, currency: 'USD', balanceMinor: '40000', balanceAfterMinor: '38000' },
      { accountId: toAccountId, accountVersion: 2, currency: 'EUR', balanceMinor: '29200', balanceAfterMinor: '31000' },
    ]));
    const income = await send(app, 'recordTransaction', { type: 'income', accountId: fromAccountId, categoryId: 'other-income',
      date: transfer.date, amountMinor: '2500', idempotencyKey }, session);
    assert.equal(income.statusCode, 200, income.body);
    const reason = 'Уточнение по выписке';
    const confirmed = { ...replacement, idempotencyKey, reason, expectedTransactionVersion: before.transactionVersion,
      expectedAccounts: before.accounts.map(({ accountId, accountVersion }) => ({ accountId, accountVersion })) };
    expectError(await adminSend('adminReviseTransaction', confirmed), 409, 'VERSION_CONFLICT');
    await transferBalances(session, '29200', '42500');

    const updated = await preview();
    const expectedAccounts = updated.accounts.map(({ accountId, accountVersion }) => ({ accountId, accountVersion }));
    const edited = await adminSend('adminReviseTransaction', { ...confirmed, expectedAccounts });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json<Result<'adminReviseTransaction'>>().transactionVersion, 2);
    const revisionKey = { userId, transactionId, idempotencyKey, command: 'transaction.revise' } as const;
    expectCommitted(await adminSend('adminCommandStatus', revisionKey), edited);
    expectCommitted(await adminSend('adminCloseCommand', revisionKey), edited);
    const replay = await adminSend('adminReviseTransaction', { ...confirmed, expectedAccounts: [...expectedAccounts].reverse() });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), edited.json());
    await transferBalances(session, '31000', '40500');

    const cancelPreview = await adminSend('adminPreviewTransactionVoid', {});
    assert.equal(cancelPreview.statusCode, 200, cancelPreview.body);
    const cancel = cancelPreview.json<Result<'adminPreviewTransactionVoid'>>();
    const cancellation = { expectedTransactionVersion: cancel.transactionVersion, reason, idempotencyKey,
      expectedAccounts: cancel.accounts.map(({ accountId, accountVersion }) => ({ accountId, accountVersion })) };
    const voided = await adminSend('adminVoidTransaction', cancellation);
    const voidKey = { userId, transactionId, idempotencyKey, command: 'transaction.void' } as const;
    expectCommitted(await adminSend('adminCommandStatus', voidKey), voided);
    expectCommitted(await adminSend('adminCloseCommand', voidKey), voided);
    assert.equal(voided.statusCode, 200, voided.body);
    await transferBalances(session, '20000', '52500');
    const history = await send(app, 'listTransactionVersions', undefined, session, transactionId);
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json<Result<'listTransactionVersions'>>().versions.map(({ actorRole, reason, status, movements }) =>
      [actorRole, reason, status, movements.length]), [['user', null, 'posted', 2], ['admin', reason, 'posted', 2],
      ['admin', reason, 'void', 0]]);
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_id, actor_role, event, transition FROM audit_events
      WHERE object_id = ${transactionId} AND actor_role = 'admin' ORDER BY id`), [
      { actor_id: adminId, actor_role: 'admin', event: 'transaction.revised', transition: { from: '1', to: '2', reason } },
      { actor_id: adminId, actor_role: 'admin', event: 'transaction.voided', transition: { from: '2', to: '3', reason } },
    ]);
  });

  await t.test('Reconciliation stores the factual balance and one delta across retries', async () => {
    const { userId, accountId, session, expense } = await fixture();
    const other = await fixture();
    const input: Body<'reconcileAccountBalance'> = { expectedAccountVersion: 1, actualBalanceMinor: '90000',
      explanation: 'Остаток по выписке', idempotencyKey: expense.idempotencyKey };
    expectError(await send(app, 'reconcileAccountBalance', input, undefined, accountId), 401, 'SESSION_EXPIRED');
    expectError(await send(app, 'reconcileAccountBalance', input, other.session, accountId), 404, 'NOT_FOUND');
    expectError(await send(app, 'listBalanceAdjustments', undefined, other.session, accountId), 404, 'NOT_FOUND');
    expectError(await send(restored, 'reconcileAccountBalance', input, session, accountId), 409, 'COMMAND_REQUIRES_REVIEW');
    for (const actualBalanceMinor of ['9223372036854775808', '-9223372036854775808']) {
      expectError(await send(app, 'reconcileAccountBalance', { ...input, actualBalanceMinor }, session, accountId),
        400, 'INVALID_REQUEST');
    }
    const [first, concurrent] = await Promise.all([
      send(app, 'reconcileAccountBalance', input, session, accountId),
      send(app, 'reconcileAccountBalance', input, session, accountId),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    const result = first.json<Result<'reconcileAccountBalance'>>();
    assert.deepEqual(result, { adjustmentId: result.adjustmentId, accountId, accountVersion: 2, currency: 'EUR',
      balanceBeforeMinor: '100000', actualBalanceMinor: '90000', deltaMinor: '-10000', date: '2027-02-01',
      coveredThrough: '2027-02-01', createdAt: new Date(now).toISOString(), explanation: input.explanation, actorRole: 'user' });
    for (const replay of [concurrent, await send(restored, 'reconcileAccountBalance', input, session, accountId)]) {
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), result);
    }
    expectError(await send(app, 'reconcileAccountBalance', { ...input, actualBalanceMinor: '91000' }, session, accountId),
      409, 'IDEMPOTENCY_CONFLICT');
    expectError(await send(app, 'reconcileAccountBalance', { ...input, idempotencyKey: `1.${token()}` }, session, accountId),
      409, 'VERSION_CONFLICT');
    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.statusCode, 200, balance.body);
    assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '90000');
    const summary = await send(app, 'getCurrencySummary', undefined, session);
    assert.equal(summary.statusCode, 200, summary.body);
    assert.deepEqual(summary.json(), { balances: [{ currency: 'EUR', balanceMinor: '90000' }] });
    const history = await send(app, 'listBalanceAdjustments', undefined, session, accountId);
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json(), { adjustments: [result], next: null });

    const { db: verify } = reader;
    assert.deepEqual(await rows(verify, sql`SELECT id, account_version, CAST(balance_before_minor AS CHAR) AS before_minor,
      CAST(actual_balance_minor AS CHAR) AS actual, CAST(delta_minor AS CHAR) AS delta, financial_date, created_at,
      covered_through, explanation FROM balance_adjustments WHERE account_id = ${accountId}`), [{ id: result.adjustmentId,
      account_version: 2, before_minor: '100000', actual: '90000', delta: '-10000', financial_date: '2027-02-01',
      created_at: now, covered_through: '2027-02-01', explanation: input.explanation }]);
    assert.deepEqual(await rows(verify, sql`SELECT command_key, result FROM idempotency_keys
      WHERE actor_id = ${userId} AND command = 'account.reconcile'`), [{ command_key: input.idempotencyKey, result }]);
    assert.deepEqual(await rows(verify, sql`SELECT object_id, transition FROM audit_events
      WHERE user_id = ${userId} AND event = 'finance.account.reconciled'`),
    [{ object_id: result.adjustmentId, transition: { from: '1', to: '2' } }]);
    assert.deepEqual(await rows(verify, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
    assert.deepEqual(await rows(verify, sql`SELECT transaction_id FROM movements WHERE account_id = ${accountId}`), []);
    assert.deepEqual(await rows(verify, sql`SELECT version, CAST(opening_balance_minor AS CHAR) AS opening
      FROM accounts WHERE id = ${accountId}`), [{ version: 2, opening: '100000' }]);
  });

  await t.test('An early skip survives replay and leaves the first date in the schedule queue', async () => {
    const baseline = now;
    const { userId, accountId, session, expense, installationSecret } = await fixture();
    const ruleId = await scheduleRule(accountId);
    try {
      now = Date.parse('2027-01-31T04:00:00Z');
      const preview = await reconciliationPreview(accountId, session);
      assert.deepEqual(preview.dates.map(({ date, status }) => [date, status]), [
        ['2027-02-01', 'planned'], ['2027-02-08', 'planned'],
      ]);
      const { status: _status, ...selection } = preview.dates[1];
      const reason = 'Банк списал платёж досрочно';
      const input = { expectedAccountVersion: preview.accountVersion, actualBalanceMinor: '90000',
        explanation: 'Остаток по выписке', idempotencyKey: expense.idempotencyKey, skippedDates: [{ ...selection, reason }] };
      const [first, replay] = await Promise.all([
        send(app, 'reconcileAccountBalance', input, session, accountId),
        send(app, 'reconcileAccountBalance', input, session, accountId),
      ]);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(replay.statusCode, 200, replay.body);
      const result = first.json<Result<'reconcileAccountBalance'>>();
      assert.deepEqual(replay.json(), result);
      assert.equal(result.deltaMinor, '-10000');
      assert.deepEqual(result.skippedDates, [{ ruleId, date: '2027-02-08', reason }]);
      expectError(await send(app, 'reconcileAccountBalance', { ...input, skippedDates: [{ ...selection, reason: 'Другая причина' }] },
        session, accountId), 409, 'IDEMPOTENCY_CONFLICT');
      expectError(await send(app, 'reconcileAccountBalance', { ...input, expectedAccountVersion: 2, idempotencyKey: `1.${token()}` },
        session, accountId), 409, 'SCHEDULE_DATE_CONFLICT');
      assert.deepEqual(await rows(reader.db, sql`SELECT scheduled_date, status, adjustment_id, reason
        FROM schedule_occurrences WHERE rule_id = ${ruleId}`), [
        { scheduled_date: '2027-02-08', status: 'skipped', adjustment_id: result.adjustmentId, reason },
      ]);
      assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`), { processed_through: null });

      now = baseline;
      await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, amount_minor)
        VALUES (${ruleId}, 2, ${now}, ${Date.parse('2027-02-01T16:00:00Z')}, 12000)`);
      const queue = await readScheduleDates(reader.db, userId, ruleId, { fromDate: '2027-02-01', throughDate: '2027-02-08', asOf: now });
      assert.deepEqual(queue?.map(({ date, status, amountMinor, ruleVersion }) => [date, status, amountMinor, ruleVersion]), [
        ['2027-02-01', 'due', '10000', 1], ['2027-02-08', 'skipped', '10000', 1],
      ]);
      const history = await send(app, 'listBalanceAdjustments', undefined, session, accountId);
      assert.equal(history.statusCode, 200, history.body);
      assert.deepEqual(history.json(), { adjustments: [result], next: null });
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
      const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
      assert.equal(balance.statusCode, 200, balance.body);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '90000');

      const candidate = { userId, accountId, ruleId, date: '2027-02-01' };
      const later = { ...candidate, date: '2027-02-08' };
      assert.equal(await settle(later), undefined);
      const posted = await settle(candidate);
      assert.equal(posted?.status, 'posted');
      assert.deepEqual(await settle(candidate), posted);
      now = Date.parse('2027-02-07T16:00:00Z');
      const skipped = { status: 'skipped', adjustmentId: result.adjustmentId, reason };
      assert.deepEqual(await settle(later), skipped);
      assert.deepEqual(await settle(later), skipped);
      assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
        { processed_through: '2027-02-08' });
      assert.deepEqual(await rows(reader.db, sql`SELECT CAST(amount_minor AS CHAR) AS amount
        FROM movements WHERE account_id = ${accountId}`), [{ amount: '-10000' }]);
      const final = await send(app, 'getAccountBalance', undefined, await renewMobileSession(installationSecret), accountId);
      assert.equal(final.statusCode, 200, final.body);
      assert.equal(final.json<Result<'getAccountBalance'>>().balanceMinor, '80000');
    } finally {
      now = baseline;
    }
  });

  await t.test('Scheduled posting and reconciliation serialize in either order at the due instant', async () => {
    const baseline = now;
    try {
      for (const reconciliationFirst of [false, true]) {
        now = Date.parse('2027-01-31T04:00:00Z');
        const { userId, accountId, installationSecret, newKey, session } = await fixture();
        const ruleId = await scheduleRule(accountId);
        const candidate = { userId, accountId, ruleId, date: '2027-02-01' };
        const preview = await reconciliationPreview(accountId, session);
        const { status, ...date } = preview.dates[0];
        assert.equal(status, 'planned');
        assert.equal(await settle(candidate), undefined);
        const reason = 'Банк списал платёж досрочно';
        const input = { expectedAccountVersion: preview.accountVersion, actualBalanceMinor: '90000',
          idempotencyKey: newKey(), explanation: 'По выписке', skippedDates: [{ ...date, reason }] };
        now = baseline;
        const currentSession = await renewMobileSession(installationSecret);
        const reconcile = () => send(app, 'reconcileAccountBalance', input, currentSession, accountId);
        const post = () => settle(candidate);
        const [reconciled, outcome] = reconciliationFirst
          ? await runScheduleRace(userId, accountId, reconcile, post)
          : await runScheduleRace(userId, accountId, post, reconcile).then(([posting, reconciliation]) =>
            [reconciliation, posting] as const);
        if (reconciliationFirst) {
          assert.equal(reconciled.statusCode, 200, reconciled.body);
          const result = reconciled.json<Result<'reconcileAccountBalance'>>();
          assert.equal(result.deltaMinor, '-10000');
          assert.deepEqual(outcome, { status: 'skipped', reason, adjustmentId: result.adjustmentId });
        } else {
          expectError(reconciled, 409, 'VERSION_CONFLICT');
          assert.equal(outcome?.status, 'posted');
          assert.deepEqual(await rows(reader.db, sql`SELECT id FROM balance_adjustments WHERE account_id = ${accountId}`), []);
        }
        assert.deepEqual(await settle(candidate), outcome);
        assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
          { processed_through: candidate.date });
        assert.deepEqual(await rows(reader.db, sql`SELECT CAST(amount_minor AS CHAR) AS amount
          FROM movements WHERE account_id = ${accountId}`), reconciliationFirst ? [] : [{ amount: '-10000' }]);
        const balance = await send(app, 'getAccountBalance', undefined, currentSession, accountId);
        assert.equal(balance.statusCode, 200, balance.body);
        assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '90000');
      }
    } finally {
      now = baseline;
    }
  });

  await t.test('An overdue date blocks reconciliation until a posting commits with its outcome and position', async () => {
    const { userId, accountId, session, newKey } = await fixture();
    const ruleId = await scheduleRule(accountId, 'once');
    const candidate = { userId, accountId, ruleId, date: '2027-02-01' };
    const input = { expectedAccountVersion: 1, actualBalanceMinor: '90000', idempotencyKey: newKey(), explanation: 'По выписке' };
    expectError(await send(app, 'reconcileAccountBalance', input, session, accountId), 409, 'SCHEDULE_DATES_PENDING');
    await db.execute(sql`ALTER TABLE schedule_rules ADD CONSTRAINT test_reject_schedule_position
      CHECK (id <> ${ruleId} OR processed_through IS NULL)`);
    try {
      await assert.rejects(settle(candidate), (error) => hasDatabaseError(error, 'ER_CHECK_CONSTRAINT_VIOLATED'));
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
      assert.deepEqual(await rows(reader.db, sql`SELECT transaction_id FROM movements WHERE account_id = ${accountId}`), []);
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM audit_events WHERE user_id = ${userId} AND event = 'expense.recorded'`), []);
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_occurrences WHERE rule_id = ${ruleId}`), []);
      assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
        { processed_through: null });
      const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
      assert.equal(balance.statusCode, 200, balance.body);
      assert.equal(balance.json<Result<'getAccountBalance'>>().accountVersion, 1);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');
    } finally {
      await db.execute(sql`ALTER TABLE schedule_rules DROP CHECK test_reject_schedule_position`);
    }
    const [posted, duplicate] = await Promise.all([settle(candidate), settle(candidate)]);
    assert.ok(posted?.status === 'posted');
    assert.deepEqual(duplicate, posted);
    assert.deepEqual(await settle(candidate), posted);
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_role, actor_id, object_id FROM audit_events
      WHERE user_id = ${userId} AND event = 'expense.recorded'`),
      [{ actor_role: 'operator', actor_id: null, object_id: posted.transactionId }]);
    const response = await send(app, 'reconcileAccountBalance', { ...input, expectedAccountVersion: 2 }, session, accountId);
    assert.equal(response.statusCode, 200, response.body);
    const { deltaMinor, date, coveredThrough } = response.json<Result<'reconcileAccountBalance'>>();
    assert.deepEqual({ deltaMinor, date, coveredThrough }, { deltaMinor: '0', date: candidate.date, coveredThrough: candidate.date });
  });

  await t.test('Catch-up processes dates in order and skips only the paused date while login is blocked', async () => {
    const baseline = now;
    try {
      const { userId, accountId } = await fixture();
      const ruleId = await scheduleRule(accountId);
      const candidate = { userId, accountId, ruleId, date: '2027-02-01' };
      await db.execute(sql`INSERT INTO schedule_rule_versions
        (rule_id, version, accepted_at, effective_at, state, amount_minor) VALUES
        (${ruleId}, 2, ${baseline}, ${Date.parse('2027-02-01T16:00:00Z')}, 'paused', NULL),
        (${ruleId}, 3, ${Date.parse('2027-02-08T16:00:00Z')}, ${Date.parse('2027-02-09T16:00:00Z')}, 'active', 12000)`);
      await db.execute(sql`UPDATE users SET status = 'blocked' WHERE id = ${userId}`);
      now = Date.parse('2027-02-15T04:00:00Z');
      const second = { ...candidate, date: '2027-02-08' };
      const third = { ...candidate, date: '2027-02-15' };
      assert.equal(await settle(third), undefined);
      assert.equal(await settle({ ...candidate, userId: randomUUID() }), undefined);
      assert.equal((await settle(candidate))?.status, 'posted');
      assert.equal(await settle(third), undefined);
      const skipped = { status: 'skipped', reason: 'RULE_PAUSED', adjustmentId: null };
      assert.deepEqual(await settle(second), skipped);
      assert.deepEqual(await settle(second), skipped);
      assert.equal((await settle(third))?.status, 'posted');
      assert.deepEqual(await rows(reader.db, sql`SELECT scheduled_date, status, rule_version, CAST(amount_minor AS CHAR) AS amount
        FROM schedule_occurrences WHERE rule_id = ${ruleId} ORDER BY scheduled_date`), [
        { scheduled_date: candidate.date, status: 'posted', rule_version: 1, amount: '10000' },
        { scheduled_date: second.date, status: 'skipped', rule_version: 2, amount: '10000' },
        { scheduled_date: third.date, status: 'posted', rule_version: 3, amount: '12000' },
      ]);
      assert.deepEqual(await rows(reader.db, sql`SELECT actor_role, actor_id, transition FROM audit_events
        WHERE user_id = ${userId} AND event = 'schedule.occurrence.skipped'`),
      [{ actor_role: 'operator', actor_id: null, transition: { from: 'paused', to: 'skipped', reason: 'RULE_PAUSED' } }]);
      assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
        { processed_through: third.date });
    } finally {
      now = baseline;
    }
  });

  await t.test('Failure after storing the skip rolls back the adjustment, position, audit and idempotency result', async () => {
    const baseline = now;
    const { userId, accountId, session, expense } = await fixture();
    const ruleId = await scheduleRule(accountId);
    const key = expense.idempotencyKey;
    try {
      now = Date.parse('2027-01-31T04:00:00Z');
      const preview = await reconciliationPreview(accountId, session);
      const { status: _status, ...selection } = preview.dates[0];
      const input = { expectedAccountVersion: 1, actualBalanceMinor: '90000', explanation: 'По выписке', idempotencyKey: key,
        skippedDates: [{ ...selection, reason: 'Уже списано' }] };
      await db.execute(sql`ALTER TABLE idempotency_keys ADD CONSTRAINT test_reject_reconciliation_result
        CHECK (command_key <> ${key} OR result IS NULL)`);
      try {
        expectError(await send(app, 'reconcileAccountBalance', input, session, accountId), 500, 'INTERNAL_ERROR');
        assert.deepEqual(await rows(reader.db, sql`SELECT id FROM balance_adjustments WHERE account_id = ${accountId}`), []);
        assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_occurrences WHERE rule_id = ${ruleId}`), []);
        assert.deepEqual(await rows(reader.db, sql`SELECT id FROM audit_events WHERE user_id = ${userId}
          AND event IN ('finance.account.reconciled', 'schedule.occurrence.skipped')`), []);
        assert.deepEqual(await rows(reader.db, sql`SELECT command_key FROM idempotency_keys WHERE actor_id = ${userId}`), []);
        assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`), { processed_through: null });
        const afterFailure = await reconciliationPreview(accountId, session);
        assert.equal(afterFailure.accountVersion, 1);
        assert.equal(afterFailure.balanceMinor, '100000');
        assert.deepEqual(afterFailure.dates, preview.dates);
      } finally {
        await db.execute(sql`ALTER TABLE idempotency_keys DROP CHECK test_reject_reconciliation_result`);
      }
      const retry = await send(app, 'reconcileAccountBalance', input, session, accountId);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json<Result<'reconcileAccountBalance'>>().actualBalanceMinor, '90000');
      const persisted = await reconciliationPreview(accountId, session);
      assert.deepEqual(persisted.dates.map(({ status }) => status), ['skipped', 'planned']);
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
    } finally {
      now = baseline;
    }
  });

  await t.test('Reconciliation rejects unseen due dates and changed or foreign selections', async () => {
    const { accountId, session, expense } = await fixture();
    const other = await fixture();
    const ruleId = await scheduleRule(accountId);
    const otherRule = await scheduleRule(other.accountId);
    const preview = await reconciliationPreview(accountId, session);
    const { status: _status, ...selection } = preview.dates[0];
    assert.equal(_status, 'due');
    const input = { expectedAccountVersion: 1, actualBalanceMinor: '90000', explanation: 'По выписке',
      idempotencyKey: expense.idempotencyKey };
    expectError(await send(app, 'reconcileAccountBalance', input, session, accountId), 409, 'SCHEDULE_DATES_PENDING');
    expectError(await send(app, 'reconcileAccountBalance', { ...input, skippedDates: [{ ...selection, ruleId: otherRule, reason: 'По выписке' }] },
      session, accountId), 409, 'SCHEDULE_DATE_CONFLICT');
    await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, amount_minor)
      VALUES (${ruleId}, 2, ${now - 3600000}, ${now}, 12000)`);
    expectError(await send(app, 'reconcileAccountBalance', { ...input, skippedDates: [{ ...selection, reason: 'По выписке' }] },
      session, accountId), 409, 'SCHEDULE_DATE_CONFLICT');
    const updated = await reconciliationPreview(accountId, session);
    const { status: _updatedStatus, ...current } = updated.dates[0];
    assert.equal(current.amountMinor, '12000');
    const result = await send(app, 'reconcileAccountBalance', { ...input, skippedDates: [{ ...current, reason: 'По выписке' }] },
      session, accountId);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json<Result<'reconcileAccountBalance'>>().deltaMinor, '-10000');
  });

  await t.test('Revising an included movement leaves the old delta and marks the account for another reconciliation', async () => {
    const { accountId, session, expense } = await fixture();
    const original = await send(app, 'recordTransaction', expense, session);
    assert.equal(original.statusCode, 200, original.body);
    const { transactionId } = original.json<SingleAccountResult>();
    const adjustment = await send(app, 'reconcileAccountBalance', { actualBalanceMinor: '89000', expectedAccountVersion: 2,
      explanation: 'Остаток по выписке', idempotencyKey: `1.${token()}` }, session, accountId);
    assert.equal(adjustment.statusCode, 200, adjustment.body);
    const first = adjustment.json<Result<'reconcileAccountBalance'>>();
    assert.equal(first.deltaMinor, '-1000');
    const revised = await send(app, 'reviseTransaction', { ...expense, amountMinor: '12000', expectedTransactionVersion: 1 },
      session, transactionId);
    assert.equal(revised.statusCode, 200, revised.body);
    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.statusCode, 200, balance.body);
    assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '87000');
    assert.equal(balance.json<Result<'getAccountBalance'>>().needsReconciliation, true);
    const corrected = await send(app, 'reconcileAccountBalance', { actualBalanceMinor: '89000', expectedAccountVersion: 4,
      explanation: 'Повторная сверка', idempotencyKey: `1.${token()}` }, session, accountId);
    assert.equal(corrected.statusCode, 200, corrected.body);
    assert.equal(corrected.json<Result<'reconcileAccountBalance'>>().deltaMinor, '2000');
    const zero = await send(app, 'reconcileAccountBalance', { actualBalanceMinor: '89000', expectedAccountVersion: 5,
      explanation: 'Остаток совпал', idempotencyKey: `1.${token()}` }, session, accountId);
    assert.equal(zero.statusCode, 200, zero.body);
    assert.equal(zero.json<Result<'reconcileAccountBalance'>>().deltaMinor, '0');
    const current = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(current.statusCode, 200, current.body);
    assert.equal(current.json<Result<'getAccountBalance'>>().balanceMinor, '89000');
    assert.equal(current.json<Result<'getAccountBalance'>>().needsReconciliation, undefined);
    const history = await send(app, 'listBalanceAdjustments', undefined, session, accountId);
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json(), { adjustments: [zero.json(), corrected.json(), first], next: null });
  });

  await t.test('Reconciliation covers posted dates after a profile zone change and void marks it stale', async () => {
    const { userId, accountId, session } = await fixture();
    const ruleId = await scheduleRule(accountId, 'once');
    const candidate = { userId, accountId, ruleId, date: '2027-02-01' };
    await db.execute(sql`INSERT INTO user_time_zone_versions (user_id, effective_at, time_zone)
      VALUES (${userId}, ${now}, 'Europe/Moscow')`);
    const posted = await settle(candidate);
    assert.ok(posted?.status === 'posted');
    const { transactionId } = posted;
    assert.deepEqual(await one(reader.db, sql`SELECT due_at, scheduled_date FROM schedule_occurrences WHERE rule_id = ${ruleId}`),
      { due_at: now, scheduled_date: candidate.date });
    assert.deepEqual(await one(reader.db, sql`SELECT financial_date FROM transaction_versions WHERE transaction_id = ${transactionId}`),
      { financial_date: candidate.date });
    const response = await send(app, 'reconcileAccountBalance', { actualBalanceMinor: '90000', expectedAccountVersion: 2,
      explanation: 'Сверка после смены зоны', idempotencyKey: `1.${token()}` }, session, accountId);
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json<Result<'reconcileAccountBalance'>>();
    assert.equal(result.deltaMinor, '0');
    assert.equal(result.date, '2027-01-31');
    assert.equal(result.coveredThrough, '2027-02-01');
    const voided = await send(app, 'voidTransaction', { expectedTransactionVersion: 1, idempotencyKey: `1.${token()}` },
      session, transactionId);
    assert.equal(voided.statusCode, 200, voided.body);
    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.statusCode, 200, balance.body);
    assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');
    assert.equal(balance.json<Result<'getAccountBalance'>>().needsReconciliation, true);
    assert.deepEqual(await settle(candidate), posted);
    assert.deepEqual(await rows(reader.db, sql`SELECT id, current_version FROM transactions WHERE user_id = ${userId}`),
      [{ id: transactionId, current_version: 2 }]);
    const list = await occurrences(session, candidate.date, candidate.date, ruleId);
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ status, transactionId }) =>
      [status, transactionId]), [['posted', transactionId]]);
  });

  await t.test('Administrative reconciliation checks the account owner and audits the administrator', async () => {
    const { userId, accountId, expense } = await fixture();
    const other = await fixture();
    const { adminId, headers } = await adminSessionHeaders();
    const input = { actualBalanceMinor: '100500', expectedAccountVersion: 1,
      explanation: 'Корректировка по выписке', idempotencyKey: expense.idempotencyKey };
    const url = routes.adminReconcileAccountBalance.url.replace(':userId', userId).replace(':accountId', accountId);
    const post = { method: 'POST', url, payload: input, remoteAddress: '192.0.2.1', headers } as const;
    expectError(await app.inject({ ...post, url: url.replace(userId, other.userId) }), 404, 'NOT_FOUND');
    expectError(await app.inject({ ...post, headers: { ...headers, 'x-csrf-token': 'invalid' } }), 403, 'CSRF_INVALID');
    const response = await app.inject(post);
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json<Result<'adminReconcileAccountBalance'>>();
    assert.equal(result.actorRole, 'admin');
    assert.equal(result.deltaMinor, '500');
    const replay = await app.inject(post);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), result);
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_id, actor_role, object_id FROM audit_events
      WHERE user_id = ${userId} AND event = 'finance.account.reconciled'`),
    [{ actor_id: adminId, actor_role: 'admin', object_id: result.adjustmentId }]);
  });

  await t.test('Deleting an account clears its ledger and cards and reverses transfers on the other account', async () => {
    const { userId, session, transfer, newKey } = await transferFixture();
    const { fromAccountId: accountId, toAccountId: peer } = transfer;
    const other = await fixture();
    const cardInput = { name: 'Debit card', appearance: '#124ABC' };
    const card = await send(app, 'createAccountCard', cardInput, session, accountId);
    const peerCard = await send(app, 'createAccountCard', cardInput, session, peer);
    assert.equal(card.statusCode, 200, card.body);
    assert.equal(peerCard.statusCode, 200, peerCard.body);

    const entry = await send(app, 'recordTransaction', expenseFor(accountId, newKey()), session);
    const moved = await send(app, 'recordTransaction', expenseFor(accountId, newKey()), session);
    assert.equal(entry.statusCode, 200, entry.body);
    assert.equal(moved.statusCode, 200, moved.body);
    const { transactionId: retainedId } = moved.json<SingleAccountResult>();
    const scheduled = await send(app, 'createScheduleRule', scheduleInput(accountId, transfer.date), session);
    assert.equal(scheduled.statusCode, 200, scheduled.body);
    const { ruleId } = scheduled.json<Result<'createScheduleRule'>>();
    const candidate = { userId, accountId, ruleId, date: transfer.date };
    const due = await settle(candidate);
    assert.ok(due?.status === 'posted');
    for (const [id, amountMinor] of [[retainedId, '10000'], [due.transactionId, '4000']]) {
      const revised = await send(app, 'reviseTransaction', {
        ...expenseFor(peer, newKey()), amountMinor, expectedTransactionVersion: 1,
      }, session, id);
      assert.equal(revised.statusCode, 200, revised.body);
    }
    const recordedTransfer = await send(app, 'recordTransaction', transfer, session);
    assert.equal(recordedTransfer.statusCode, 200, recordedTransfer.body);
    const recorded = recordedTransfer.json<TransferResult>();
    const adjustment = await send(app, 'reconcileAccountBalance', {
      actualBalanceMinor: '15200', expectedAccountVersion: recorded.toAccount.accountVersion, explanation: 'Statement balance',
      idempotencyKey: newKey(),
    }, session, peer);
    assert.equal(adjustment.statusCode, 200, adjustment.body);
    assert.equal(adjustment.json<Result<'reconcileAccountBalance'>>().deltaMinor, '0');

    const body = { idempotencyKey: newKey(), expectedAccountVersion: recorded.fromAccount.accountVersion };
    const remove = (input = body, auth = session) => send(app, 'deleteAccount', input, auth, accountId);
    expectError(await remove(body, other.session), 404, 'NOT_FOUND');
    expectError(await remove({ ...body, expectedAccountVersion: 1 }), 409, 'VERSION_CONFLICT');
    await db.execute(sql`ALTER TABLE accounts ADD CONSTRAINT test_reject_account_delete CHECK (id <> ${accountId} OR deleted_at IS NULL)`);
    try {
      expectError(await remove(), 500, 'INTERNAL_ERROR');
      const balance = await send(app, 'getAccountBalance', undefined, session, peer);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '15200');
      const cards = (await send(app, 'listAccountCards', undefined, session, accountId)).json<Result<'listAccountCards'>>();
      assert.deepEqual(cards.cards.map(({ cardId }) => cardId), [card.json<Result<'createAccountCard'>>().cardId]);
      assert.equal((await send(app, 'getScheduleRule', undefined, session, ruleId)).statusCode, 200);
    } finally {
      await db.execute(sql`ALTER TABLE accounts DROP CHECK test_reject_account_delete`);
    }

    const deleted = await remove();
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.deepEqual(deleted.json(), { accountId, status: 'deleted' });
    assert.deepEqual((await remove()).json(), deleted.json());
    const key = { userId, command: 'account.delete', accountId, idempotencyKey: body.idempotencyKey } as const;
    expectCommitted(await send(app, 'commandStatus', key, session), deleted);
    expectCommitted(await send(restored, 'closeCommand', key, session), deleted);
    expectError(await remove({ ...body, idempotencyKey: newKey() }), 404, 'NOT_FOUND');
    for (const name of ['getAccountBalance', 'getAccountBalanceSeries', 'listAccountHistory', 'listBalanceAdjustments',
      'listAccountCards', 'restoreAccount'] as const) {
      expectError(await send(app, name, undefined, session, accountId), 404, 'NOT_FOUND');
    }
    expectError(await statistics(session, { accountId }), 404, 'NOT_FOUND');
    expectError(await send(app, 'getScheduleRule', undefined, session, ruleId), 404, 'NOT_FOUND');
    assert.equal(await settle(candidate), undefined);
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM account_cards WHERE account_id = ${accountId}`), []);
    for (const id of [entry.json<SingleAccountResult>().transactionId, due.transactionId, recorded.transactionId]) {
      expectError(await send(app, 'listTransactionVersions', undefined, session, id), 404, 'NOT_FOUND');
    }
    assert.deepEqual((await readStatistics(session)).entries.map(({ transactionId }) => transactionId), [retainedId]);
    const remaining = (await send(app, 'listAccounts', undefined, session)).json<Result<'listAccounts'>>();
    assert.deepEqual(remaining.accounts.map(({ accountId, balanceMinor, needsReconciliation }) => [accountId, balanceMinor, needsReconciliation]),
      [[peer, '10000', true]]);
    assert.deepEqual(remaining.cardPreviews?.map(({ accountId }) => accountId), [peer]);
    const history = (await send(app, 'listAccountHistory', undefined, session, peer)).json<Result<'listAccountHistory'>>();
    assert.deepEqual(history.entries.filter(({ type }) => type === 'transfer'), []);
    assert.deepEqual((await send(app, 'getCurrencySummary', undefined, session)).json(), {
      balances: [{ currency: 'EUR', balanceMinor: '10000' }],
    });
  });

  await t.test('An archived account can be deleted while linked archived balances remain protected', async () => {
    const { userId, accountId, session, newKey } = await fixture();
    const peer = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${peer}, ${userId}, 'Archived EUR account', 'EUR', '2027-01-01', -10000)`);
    const transfer = await send(app, 'recordTransaction', {
      type: 'transfer', fromAccountId: accountId, toAccountId: peer, fromAmountMinor: '10000', toAmountMinor: '10000',
      date: '2027-02-01', idempotencyKey: newKey(),
    }, session);
    assert.equal(transfer.statusCode, 200, transfer.body);
    const archived = await send(app, 'archiveAccount', undefined, session, peer);
    assert.equal(archived.statusCode, 200, archived.body);
    expectError(await send(app, 'deleteAccount', { idempotencyKey: newKey(), expectedAccountVersion: 2 }, session, accountId),
      409, 'ACCOUNT_UNAVAILABLE');
    const deleted = await send(app, 'deleteAccount', { idempotencyKey: newKey(),
      expectedAccountVersion: archived.json<Result<'archiveAccount'>>().accountVersion }, session, peer);
    assert.equal(deleted.statusCode, 200, deleted.body);
    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');
    expectError(await send(app, 'restoreAccount', undefined, session, peer), 404, 'NOT_FOUND');
  });

  await t.test('Administrative card and account deletion enforce scope and audit the administrator', async () => {
    const { userId, accountId, session, newKey } = await fixture();
    const other = await fixture();
    const { adminId, headers } = await adminSessionHeaders();
    const card = await send(app, 'createAccountCard', { name: 'Debit card', appearance: '#124ABC' }, session, accountId);
    assert.equal(card.statusCode, 200, card.body);
    const { cardId } = card.json<Result<'createAccountCard'>>();
    function adminSend<K extends Route>(name: K, body?: Body<K>, owner = userId, csrf = headers['x-csrf-token']) {
      const { method, url } = routes[name];
      return app.inject({ method, url: url.replace(':userId', owner).replace(':accountId', accountId).replace(':cardId', cardId),
        payload: body, remoteAddress: '192.0.2.1', headers: { ...headers, 'x-csrf-token': csrf } });
    }
    expectError(await adminSend('adminListAccountCards', undefined, other.userId), 404, 'NOT_FOUND');
    const cards = await adminSend('adminListAccountCards');
    assert.equal(cards.statusCode, 200, cards.body);
    assert.deepEqual(cards.json(), { cards: [card.json()] });
    expectError(await adminSend('adminDeleteAccountCard', undefined, other.userId), 404, 'NOT_FOUND');
    expectError(await adminSend('adminDeleteAccountCard', undefined, userId, ''), 403, 'CSRF_INVALID');
    const deletedCard = await adminSend('adminDeleteAccountCard');
    assert.equal(deletedCard.statusCode, 200, deletedCard.body);
    assert.deepEqual((await adminSend('adminListAccountCards')).json(), { cards: [] });
    const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');

    const idempotencyKey = newKey();
    const reason = 'Remove an unused account';
    const body = { idempotencyKey, expectedAccountVersion: 1, reason };
    expectError(await adminSend('adminDeleteAccount', body, other.userId), 404, 'NOT_FOUND');
    expectError(await adminSend('adminDeleteAccount', { ...body, reason: ' ' }), 400, 'INVALID_REQUEST');
    expectError(await adminSend('adminDeleteAccount', body, userId, ''), 403, 'CSRF_INVALID');
    const deleted = await adminSend('adminDeleteAccount', body);
    assert.equal(deleted.statusCode, 200, deleted.body);
    expectCommitted(await adminSend('adminCommandStatus', { command: 'account.delete', userId, accountId, idempotencyKey }), deleted);
    assert.deepEqual(await rows(reader.db, sql`SELECT event, object_id AS objectId, transition FROM audit_events
      WHERE actor_id = ${adminId} AND actor_role = 'admin' AND user_id = ${userId} ORDER BY event`), [
      { event: 'finance.account.deleted', objectId: accountId, transition: { from: '1', to: 'deleted', reason } },
      { event: 'finance.card.deleted', objectId: cardId, transition: null },
    ]);
  });

  await t.test('Deleting an account and posting a scheduled date serialize in both orders', async () => {
    for (const postFirst of [false, true]) {
      const { userId, accountId, session, newKey } = await fixture();
      const ruleId = await scheduleRule(accountId);
      const candidate = { userId, accountId, ruleId, date: '2027-02-01' };
      const post = () => settle(candidate);
      const remove = (version = 1) => send(app, 'deleteAccount', {
        idempotencyKey: newKey(), expectedAccountVersion: version,
      }, session, accountId);
      const [deleted, posted] = postFirst
        ? await runScheduleRace(userId, accountId, post, remove).then(([posted, removed]) => [removed, posted] as const)
        : await runScheduleRace(userId, accountId, remove, post);
      if (postFirst) {
        assert.equal(posted?.status, 'posted');
        expectError(deleted, 409, 'VERSION_CONFLICT');
        const retry = await remove(2);
        assert.equal(retry.statusCode, 200, retry.body);
      } else {
        assert.equal(deleted.statusCode, 200, deleted.body);
        assert.equal(posted, undefined);
      }
      assert.equal(await post(), undefined);
    }
  });

  await t.test('Only a zero-balance account can be archived and restored with its history intact', async () => {
    const { userId, accountId, session, expense } = await fixture();
    const other = await fixture();
    const archive = () => send(app, 'archiveAccount', undefined, session, accountId);
    const restore = () => send(app, 'restoreAccount', undefined, session, accountId);
    expectError(await send(app, 'archiveAccount', undefined, undefined, accountId), 401, 'SESSION_EXPIRED');
    expectError(await send(app, 'archiveAccount', undefined, other.session, accountId), 404, 'NOT_FOUND');
    expectError(await send(app, 'restoreAccount', undefined, other.session, accountId), 404, 'NOT_FOUND');
    expectError(await archive(), 409, 'ACCOUNT_BALANCE_NOT_ZERO');
    assert.deepEqual(await one(reader.db, sql`SELECT archived, version FROM accounts WHERE id = ${accountId}`),
      { archived: 0, version: 1 });

    const recorded = await send(app, 'recordTransaction', expense, session);
    assert.equal(recorded.statusCode, 200, recorded.body);
    const { transactionId } = recorded.json<SingleAccountResult>();
    const reconcile = { actualBalanceMinor: '0', expectedAccountVersion: 2, idempotencyKey: `1.${token()}`,
      explanation: 'Счёт закрыт по выписке' };
    const adjusted = await send(app, 'reconcileAccountBalance', reconcile, session, accountId);
    assert.equal(adjusted.statusCode, 200, adjusted.body);
    assert.equal(adjusted.json<Result<'reconcileAccountBalance'>>().deltaMinor, '-90000');
    async function history() {
      const [versions, adjustments] = await Promise.all([
        send(app, 'listTransactionVersions', undefined, session, transactionId),
        send(app, 'listBalanceAdjustments', undefined, session, accountId),
      ]);
      assert.equal(versions.statusCode, 200, versions.body);
      assert.equal(adjustments.statusCode, 200, adjustments.body);
      return [versions.json<Result<'listTransactionVersions'>>(), adjustments.json<Result<'listBalanceAdjustments'>>()];
    }
    const before = await history();
    assert.deepEqual(before[1], { adjustments: [adjusted.json()], next: null });
    const archived = await archive();
    assert.equal(archived.statusCode, 200, archived.body);
    assert.deepEqual(archived.json(), { accountId, accountVersion: 4, archived: true, balanceMinor: '0' });
    const archiveReplay = await archive();
    assert.equal(archiveReplay.statusCode, 200, archiveReplay.body);
    assert.deepEqual(archiveReplay.json(), archived.json());
    const archivedBalance = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(archivedBalance.statusCode, 200, archivedBalance.body);
    assert.equal(archivedBalance.json<Result<'getAccountBalance'>>().archived, true);
    const summary = await send(app, 'getCurrencySummary', undefined, session);
    assert.equal(summary.statusCode, 200, summary.body);
    assert.deepEqual(summary.json(), { balances: [] });
    assert.deepEqual(await history(), before);

    const newExpense = expenseFor(accountId, `1.${token()}`);
    expectError(await send(app, 'recordTransaction', newExpense, session), 409, 'ACCOUNT_UNAVAILABLE');
    expectError(await send(app, 'reconcileAccountBalance', { ...reconcile, expectedAccountVersion: 4, idempotencyKey: `1.${token()}` },
      session, accountId), 409, 'ACCOUNT_UNAVAILABLE');
    expectError(await send(app, 'reviseTransaction', { ...expense, expectedTransactionVersion: 1, idempotencyKey: `1.${token()}` },
      session, transactionId), 409, 'ACCOUNT_UNAVAILABLE');
    expectError(await send(app, 'voidTransaction', { expectedTransactionVersion: 1, idempotencyKey: `1.${token()}` },
      session, transactionId), 409, 'ACCOUNT_UNAVAILABLE');

    const restored = await restore();
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json(), { accountId, accountVersion: 5, archived: false, balanceMinor: '0' });
    const restoreReplay = await restore();
    assert.equal(restoreReplay.statusCode, 200, restoreReplay.body);
    assert.deepEqual(restoreReplay.json(), restored.json());
    const active = await send(app, 'getAccountBalance', undefined, session, accountId);
    assert.equal(active.statusCode, 200, active.body);
    assert.equal(active.json<Result<'getAccountBalance'>>().archived, undefined);
    assert.deepEqual(await history(), before);
    assert.deepEqual(await rows(reader.db, sql`SELECT event, transition FROM audit_events
      WHERE user_id = ${userId} AND object_id = ${accountId} ORDER BY id`), [
      { event: 'finance.account.archived', transition: { from: '3', to: '4' } },
      { event: 'finance.account.restored', transition: { from: '4', to: '5' } },
    ]);
    const posted = await send(app, 'recordTransaction', newExpense, session);
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.json<SingleAccountResult>().balanceMinor, '-10000');
    expectError(await archive(), 409, 'ACCOUNT_BALANCE_NOT_ZERO');
  });

  await t.test('Archiving a zero-balance account and recording income serialize in both orders', async () => {
    for (const archiveFirst of [true, false]) {
      const { userId, accountId, session, expense } = await fixture();
      await db.execute(sql`UPDATE accounts SET opening_balance_minor = 0 WHERE id = ${accountId}`);
      const archive = () => send(app, 'archiveAccount', undefined, session, accountId);
      const income = () => send(app, 'recordTransaction', { ...expense, type: 'income', categoryId: 'other-income',
        amountMinor: '2500' }, session);
      let first: Promise<LightMyRequestResponse> | undefined;
      let second: Promise<LightMyRequestResponse> | undefined;
      await reader.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE`);
        first = archiveFirst ? archive() : income();
        // Use a separate transaction for the probe, so any successful probe releases its owner lock on commit.
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            await reader.db.transaction((probe) => probe.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE NOWAIT`));
          } catch (error) {
            if (!hasDatabaseError(error, 'ER_LOCK_NOWAIT')) throw error;
            break;
          }
          assert.ok(Date.now() < deadline, 'First API request did not acquire the owner lock');
          await setTimeout(10);
        }
        second = archiveFirst ? income() : archive();
      });
      assert.ok(first && second);
      const [winner, loser] = await Promise.all([first, second]);
      assert.equal(winner.statusCode, 200, winner.body);
      expectError(loser, 409, archiveFirst ? 'ACCOUNT_UNAVAILABLE' : 'ACCOUNT_BALANCE_NOT_ZERO');
      const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
      assert.equal(balance.statusCode, 200, balance.body);
      const state = balance.json<Result<'getAccountBalance'>>();
      assert.equal(state.accountVersion, 2);
      assert.equal(state.balanceMinor, archiveFirst ? '0' : '2500');
      assert.equal(Boolean(state.archived), archiveFirst);
      assert.deepEqual(await rows(reader.db, sql`SELECT event FROM audit_events WHERE user_id = ${userId}
        AND event IN ('finance.account.archived', 'income.recorded')`), [
        { event: archiveFirst ? 'finance.account.archived' : 'income.recorded' },
      ]);
    }
  });

  await t.test('Archiving and creating a schedule rule serialize in both orders', async () => {
    for (const archiveFirst of [true, false]) {
      const { userId, accountId, session } = await fixture();
      await db.execute(sql`UPDATE accounts SET opening_balance_minor = 0 WHERE id = ${accountId}`);
      const archive = () => send(app, 'archiveAccount', undefined, session, accountId);
      const create = () => send(app, 'createScheduleRule', scheduleInput(accountId, '2027-02-02'), session);
      let first: Promise<LightMyRequestResponse> | undefined;
      let second: Promise<LightMyRequestResponse> | undefined;
      await reader.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE`);
        first = archiveFirst ? archive() : create();
        await awaitLock(async () => {
          try {
            await reader.db.transaction((probe) => probe.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE NOWAIT`));
          } catch (error) {
            if (!hasDatabaseError(error, 'ER_LOCK_NOWAIT')) throw error;
            return true;
          }
          return false;
        }, 'First schedule race request did not acquire the owner lock');
        second = archiveFirst ? create() : archive();
        await awaitLock(async () => (await rows<{ Info: string | null }>(reader.db, sql`SHOW FULL PROCESSLIST`))
          .some(({ Info }) => Info?.startsWith('SELECT * FROM users WHERE id =') && Info.includes(userId) && Info.includes('FOR UPDATE')),
        'Second schedule race request did not wait on the owner lock');
      });
      assert.ok(first && second);
      const [winner, loser] = await Promise.all([first, second]);
      assert.equal(winner.statusCode, 200, winner.body);
      expectError(loser, 409, archiveFirst ? 'ACCOUNT_UNAVAILABLE' : 'SCHEDULE_FUTURE_DATES');
      const account = await send(app, 'getAccountBalance', undefined, session, accountId);
      assert.equal(account.statusCode, 200, account.body);
      const state = account.json<Result<'getAccountBalance'>>();
      assert.equal(Boolean(state.archived), archiveFirst);
      assert.equal(state.balanceMinor, '0');
      assert.equal(state.accountVersion, archiveFirst ? 2 : 1);
      const rules = await send(app, 'listScheduleRules', undefined, session);
      assert.equal(rules.statusCode, 200, rules.body);
      assert.equal(rules.json<Result<'listScheduleRules'>>().rules.length, archiveFirst ? 0 : 1);
      assert.deepEqual(await rows(reader.db, sql`SELECT event FROM audit_events WHERE user_id = ${userId}
        AND event IN ('finance.account.archived', 'schedule.rule.created')`),
      [{ event: archiveFirst ? 'finance.account.archived' : 'schedule.rule.created' }]);
    }
  });

  await t.test('The profile and rule API share a calendar and preserve due dates across a zone change', async () => {
    const previousNow = now;
    try {
      now = Date.parse('2027-01-30T04:00:00Z');
      const { session, userId, accountId, installationSecret } = await fixture(null);
      let currentSession = session;
      const profile = async () => {
        const response = await send(app, 'me', undefined, currentSession);
        assert.equal(response.statusCode, 200, response.body);
        const { timeZone, timeZoneConfigured, today } = response.json<Result<'me'>>();
        return { timeZone, timeZoneConfigured, today };
      };
      assert.deepEqual(await profile(), { timeZone: 'UTC', timeZoneConfigured: false, today: '2027-01-30' });
      expectError(await send(app, 'setTimeZone', { timeZone: '+08:00' }, session), 400, 'INVALID_REQUEST');
      expectError(await send(app, 'setTimeZone', { timeZone: 'Mars/Olympus' }, session), 400, 'INVALID_REQUEST');
      const setZone = (timeZone: string) => send(app, 'setTimeZone', { timeZone }, currentSession);
      const selected = await setZone('Asia/Makassar');
      assert.equal(selected.statusCode, 200, selected.body);
      assert.equal(selected.json<Result<'setTimeZone'>>().timeZoneConfigured, true);
      expectError(await setZone('Europe/Moscow'), 409, 'TIME_ZONE_CONFLICT');
      const replay = await setZone('asia/makassar');
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), selected.json());

      const input = scheduleInput(accountId, '2027-02-01');
      const created = await send(app, 'createScheduleRule', input, session);
      assert.equal(created.statusCode, 200, created.body);
      const { ruleId } = created.json<Result<'createScheduleRule'>>();
      const edit = await send(app, 'changeScheduleRule', { action: 'edit', expectedRuleVersion: 1, amountMinor: '12000' }, currentSession, ruleId);
      assert.equal(edit.statusCode, 200, edit.body);
      assert.equal(edit.json<Result<'changeScheduleRule'>>().effectiveAt, Date.parse('2027-01-30T16:00:00Z'));
      now = Date.parse('2027-01-31T16:00:00Z');
      currentSession = await renewMobileSession(installationSecret);
      const change = await setZone('Europe/Moscow');
      assert.equal(change.statusCode, 200, change.body);
      assert.deepEqual(await profile(), { timeZone: 'Europe/Moscow', timeZoneConfigured: true, today: '2027-01-31' });
      const editNextDate = await send(app, 'changeScheduleRule', { action: 'edit', expectedRuleVersion: 2, amountMinor: '13000' }, currentSession, ruleId);
      assert.equal(editNextDate.statusCode, 200, editNextDate.body);
      const dates = await occurrences(currentSession, '2027-02-01', '2027-02-08', ruleId);
      assert.equal(dates.statusCode, 200, dates.body);
      assert.deepEqual(dates.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ date, dueAt, status, amountMinor }) =>
        [date, dueAt, status, amountMinor]), [
        ['2027-02-01', now, 'due', '12000'],
        ['2027-02-08', Date.parse('2027-02-07T21:00:00Z'), 'planned', '13000'],
      ]);
      assert.deepEqual(await rows(reader.db, sql`SELECT time_zone AS timeZone FROM user_time_zone_versions
        WHERE user_id = ${userId} ORDER BY effective_at`), [{ timeZone: 'Asia/Makassar' }, { timeZone: 'Europe/Moscow' }]);
      assert.equal((await rows(reader.db, sql`SELECT id FROM audit_events WHERE user_id = ${userId}
        AND event = 'profile.time_zone.changed'`)).length, 2);
    } finally {
      now = previousNow;
    }
  });

  await t.test('Rule changes preserve prior occurrences, keep pause across edits, and end the series', async () => {
    const previousNow = now;
    try {
      now = Date.parse('2027-02-01T04:00:00Z');
      const { session, userId, accountId, installationSecret } = await fixture();
      const other = await fixture();
      const input = scheduleInput(accountId, '2027-02-01');
      expectError(await send(app, 'createScheduleRule', { ...input, firstDate: '2026-12-31' }, session), 400, 'INVALID_REQUEST');
      expectError(await send(app, 'createScheduleRule', { ...input, categoryId: 'salary' }, session), 400, 'INVALID_REQUEST');
      expectError(await send(app, 'createScheduleRule', { ...input, amountMinor: '9223372036854775808' }, session), 400, 'INVALID_REQUEST');
      expectError(await send(app, 'createScheduleRule', input, other.session), 404, 'NOT_FOUND');
      const create = await send(app, 'createScheduleRule', { ...input, comment: 'Rent', endDate: '2027-03-01' }, session);
      assert.equal(create.statusCode, 200, create.body);
      const initial = create.json<Result<'createScheduleRule'>>();
      const { ruleId } = initial;
      assert.deepEqual(initial, { ...input, ruleId, currency: 'EUR', comment: 'Rent', endDate: '2027-03-01',
        state: 'active', ruleVersion: 1, effectiveAt: now });
      expectError(await send(app, 'setTimeZone', { timeZone: 'Europe/Moscow' }, session), 409, 'TIME_ZONE_CONFLICT');
      const read = await send(app, 'getScheduleRule', undefined, session, ruleId);
      assert.equal(read.statusCode, 200, read.body);
      assert.deepEqual(read.json(), initial);
      expectError(await send(app, 'getScheduleRule', undefined, other.session, ruleId), 404, 'NOT_FOUND');
      expectError(await occurrences(other.session, '2027-02-01', '2027-02-08', ruleId), 404, 'NOT_FOUND');
      expectError(await occurrences(session, '2027-02-01', '2028-02-03', ruleId), 400, 'INVALID_REQUEST');
      let currentSession = session;
      const update = (body: Body<'changeScheduleRule'>) => send(app, 'changeScheduleRule', body, currentSession, ruleId);
      expectError(await update({ action: 'edit', expectedRuleVersion: 1 }), 400, 'INVALID_REQUEST');
      expectError(await update({ action: 'resume', expectedRuleVersion: 1 }), 409, 'SCHEDULE_RULE_STATE_CONFLICT');
      const pause = await update({ action: 'pause', expectedRuleVersion: 1 });
      assert.equal(pause.statusCode, 200, pause.body);
      assert.equal(pause.json<Result<'changeScheduleRule'>>().effectiveAt, Date.parse('2027-02-01T16:00:00Z'));
      expectError(await update({ action: 'end', expectedRuleVersion: 1 }), 409, 'VERSION_CONFLICT');
      const edit = await update({ action: 'edit', expectedRuleVersion: 2, amountMinor: '12500', comment: null, endDate: null });
      assert.equal(edit.statusCode, 200, edit.body);
      assert.equal(edit.json<Result<'changeScheduleRule'>>().state, 'paused');
      assert.equal(edit.json<Result<'changeScheduleRule'>>().comment, null);
      assert.equal(edit.json<Result<'changeScheduleRule'>>().endDate, null);

      now = Date.parse('2027-02-08T04:00:00Z');
      currentSession = await renewMobileSession(installationSecret);
      const resumed = await update({ action: 'resume', expectedRuleVersion: 3 });
      assert.equal(resumed.statusCode, 200, resumed.body);
      assert.equal(resumed.json<Result<'changeScheduleRule'>>().state, 'active');

      now = Date.parse('2027-02-15T04:00:00Z');
      currentSession = await renewMobileSession(installationSecret);
      const ended = await update({ action: 'end', expectedRuleVersion: 4 });
      assert.equal(ended.statusCode, 200, ended.body);
      assert.equal(ended.json<Result<'changeScheduleRule'>>().state, 'ended');
      expectError(await update({ action: 'resume', expectedRuleVersion: 5 }), 409, 'SCHEDULE_RULE_STATE_CONFLICT');
      const dates = await occurrences(currentSession, '2027-02-01', '2027-02-22', ruleId);
      assert.equal(dates.statusCode, 200, dates.body);
      assert.deepEqual(dates.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ date, ruleVersion, status, amountMinor }) =>
        [date, ruleVersion, status, amountMinor]), [
        ['2027-02-01', 1, 'due', '10000'], ['2027-02-08', 3, 'paused', '12500'], ['2027-02-15', 4, 'due', '12500'],
      ]);
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
      assert.deepEqual(await rows(reader.db, sql`SELECT event FROM audit_events WHERE object_id = ${ruleId} ORDER BY id`),
        ['created', 'paused', 'edited', 'resumed', 'ended'].map((action) => ({ event: 'schedule.rule.' + action })));
    } finally {
      now = previousNow;
    }
  });

  await t.test('Administrative rule routes scope reads and audit reasons to the selected owner', async () => {
    const { userId, accountId, session } = await fixture();
    const other = await fixture();
    const { adminId, headers } = await adminSessionHeaders();
    const createPath = routes.adminCreateScheduleRule.url.replace(':userId', userId);
    const input = scheduleInput(accountId, '2027-01-26');
    const adminRequest = (method: 'GET' | 'POST', url: string, payload?: object,
      requestHeaders = headers) => app.inject({ method, url, payload, headers: requestHeaders, remoteAddress: '192.0.2.1' });
    expectError(await adminRequest('POST', createPath, input), 400, 'INVALID_REQUEST');
    expectError(await adminRequest('POST', createPath, { ...input, reason: 'Use statement schedule' },
      { ...headers, 'x-csrf-token': '' }), 403, 'CSRF_INVALID');
    expectError(await adminRequest('POST', createPath, { ...input, accountId: other.accountId, reason: 'Wrong owner' }), 404, 'NOT_FOUND');
    const created = await adminRequest('POST', createPath, { ...input, reason: 'Use statement schedule' });
    assert.equal(created.statusCode, 200, created.body);
    const rule = created.json<Result<'adminCreateScheduleRule'>>();
    const rulePath = routes.adminGetScheduleRule.url.replace(':userId', userId).replace(':ruleId', rule.ruleId);
    assert.deepEqual((await adminRequest('GET', rulePath)).json(), rule);
    expectError(await adminRequest('GET', rulePath.replace(userId, other.userId)), 404, 'NOT_FOUND');
    const editPath = routes.adminChangeScheduleRule.url.replace(':userId', userId).replace(':ruleId', rule.ruleId);
    expectError(await adminRequest('POST', editPath, { action: 'pause', expectedRuleVersion: 1 }), 400, 'INVALID_REQUEST');
    const pause = await adminRequest('POST', editPath, { action: 'pause', expectedRuleVersion: 1, reason: 'Payment paused' });
    assert.equal(pause.statusCode, 200, pause.body);
    assert.equal(pause.json<Result<'adminChangeScheduleRule'>>().state, 'paused');
    const result = await send(app, 'getScheduleRule', undefined, session, rule.ruleId);
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), pause.json());
    const datesPath = routes.adminListScheduleOccurrences.url.replace(':userId', userId) + '?fromDate=2027-01-26&throughDate=2027-02-02';
    const dates = await adminRequest('GET', datesPath);
    assert.equal(dates.statusCode, 200, dates.body);
    assert.deepEqual(dates.json<Result<'adminListScheduleOccurrences'>>().occurrences.map(({ date, status }) => [date, status]),
      [['2027-01-26', 'due'], ['2027-02-02', 'paused']]);
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_id AS actorId, actor_role AS actorRole, event, transition
      FROM audit_events WHERE user_id = ${userId} AND object_id = ${rule.ruleId} ORDER BY id`), [
      { actorId: adminId, actorRole: 'admin', event: 'schedule.rule.created', transition: { from: '0', to: '1', reason: 'Use statement schedule' } },
      { actorId: adminId, actorRole: 'admin', event: 'schedule.rule.paused', transition: { from: '1', to: '2', reason: 'Payment paused' } },
    ]);
  });

  await t.test('ЗП-02. Replacement validates start, category and every transfer decision', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    now = Date.parse('2027-01-31T06:00:00Z');
    await f.reconcile('2027-02-15', '80000', await renewMobileSession(f.installationSecret));
    now = Date.parse('2027-02-01T04:00:00Z');
    const session = await renewMobileSession(f.installationSecret);
    const preview = await f.preview(f.ruleId, session);
    assert.deepEqual(preview.skippedDates.map(({ date }) => date), ['2027-02-08', '2027-02-15']);
    const input = f.input(preview);
    const validDecisions = [{ sourceDate: '2027-02-08', targetDate: '2027-02-09' }, { sourceDate: '2027-02-15', targetDate: null }];
    for (const invalid of [
      { firstDate: '2027-02-01', decisions: validDecisions },
      { decisions: validDecisions.slice(0, 1) },
      { decisions: input.decisions },
      { decisions: [{ sourceDate: '2027-02-08', targetDate: '2027-02-08' }, validDecisions[1]] },
      { decisions: [validDecisions[0], { sourceDate: '2027-02-08', targetDate: null }] },
      { kind: 'income' as const, decisions: validDecisions },
      { endDate: '2027-02-02', decisions: validDecisions },
    ]) {
      expectError(await f.apply({ ...input, ...invalid }, f.ruleId, session), 400, 'INVALID_REQUEST');
    }
    const original = (await send(app, 'getScheduleRule', undefined, session, f.ruleId)).json<Result<'getScheduleRule'>>();
    assert.equal(original.ruleVersion, 1);
    assert.equal(original.replacedBy, undefined);
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_rules WHERE replaces_rule_id = ${f.ruleId}`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM audit_events WHERE object_id = ${f.ruleId} AND event = 'schedule.rule.replaced'`), []);
    const replaced = await f.apply({ ...input, kind: 'income', categoryId: 'salary',
      decisions: input.decisions.map(({ sourceDate }) => ({ sourceDate, targetDate: null })) }, f.ruleId, session);
    assert.equal(replaced.statusCode, 200, replaced.body);
    const { replacementRule } = replaced.json<Result<'replaceScheduleRule'>>();
    assert.equal(replacementRule.kind, 'income');
    const historical = await occurrences(session, '2027-02-08', '2027-02-15', f.ruleId);
    assert.deepEqual(historical.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ status }) => status),
      ['skipped', 'skipped']);
    const next = await occurrences(session, '2027-02-09', '2027-02-09', replacementRule.ruleId);
    assert.equal(next.json<Result<'listScheduleOccurrences'>>().occurrences[0].status, 'planned');
  });

  await t.test('ЗП-03. A local midnight changes the preview boundary and requires reconfirmation', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    now = Date.parse('2027-02-01T15:59:59Z');
    const session = await renewMobileSession(f.installationSecret);
    const before = await f.preview(f.ruleId, session);
    assert.equal(before.transitionDate, '2027-02-02');
    const input = { ...f.input(before), firstDate: '2027-02-03', decisions: [
      { sourceDate: '2027-02-08', targetDate: '2027-02-10' },
    ] };
    now = Date.parse('2027-02-01T16:00:00Z');
    expectError(await f.apply(input, f.ruleId, session), 409, 'SCHEDULE_REPLACEMENT_CONFLICT');
    const after = await f.preview(f.ruleId, session);
    assert.equal(after.ruleVersion, before.ruleVersion);
    assert.equal(after.transitionDate, '2027-02-03');
    assert.equal(after.transitionAt, Date.parse('2027-02-02T16:00:00Z'));
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_rules WHERE replaces_rule_id = ${f.ruleId}`), []);
    const replaced = await f.apply({ ...input, previewToken: after.previewToken }, f.ruleId, session);
    assert.equal(replaced.statusCode, 200, replaced.body);
  });

  await t.test('ЗП-04. A reconciliation with another skip invalidates the previous source list', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    now = Date.parse('2027-01-31T05:00:00Z');
    const before = await f.preview(f.ruleId, await renewMobileSession(f.installationSecret));
    now = Date.parse('2027-01-31T06:00:00Z');
    await f.reconcile('2027-02-15', '80000', await renewMobileSession(f.installationSecret));
    now = Date.parse('2027-01-31T07:00:00Z');
    const session = await renewMobileSession(f.installationSecret);
    expectError(await f.apply(f.input(before), f.ruleId, session), 409, 'SCHEDULE_REPLACEMENT_CONFLICT');
    const after = await f.preview(f.ruleId, session);
    assert.equal(after.ruleVersion, before.ruleVersion);
    assert.equal(after.transitionDate, '2027-02-01');
    assert.equal(after.transitionAt, before.transitionAt);
    assert.deepEqual(after.skippedDates.map(({ date }) => date), ['2027-02-08', '2027-02-15']);
    const source = await send(app, 'getAccountBalance', undefined, session, f.accountId);
    assert.equal(source.json<Result<'getAccountBalance'>>().balanceMinor, '80000');
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_rules WHERE replaces_rule_id = ${f.ruleId}`), []);
  });

  await t.test('ЗП-05. Simultaneous replacements commit once with a shared key or competing keys', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    for (const shareKey of [true, false]) {
      const f = await replacementFixture();
      now = Date.parse('2027-02-01T04:00:00Z');
      const session = await renewMobileSession(f.installationSecret);
      const preview = await f.preview(f.ruleId, session);
      const input = f.input(preview);
      const record = () => f.apply(input, f.ruleId, session);
      const key = { userId: f.userId, command: 'schedule.replace', ruleId: f.ruleId,
        accountId: f.target, idempotencyKey: input.idempotencyKey } as const;
      let left: LightMyRequestResponse;
      let right: LightMyRequestResponse;
      if (shareKey) {
        const requests: Promise<LightMyRequestResponse>[] = [];
        await reader.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM users WHERE id = ${f.userId} FOR UPDATE`);
          requests.push(record());
          await awaitKeyReservation(f.userId, key);
          requests.push(record());
          await awaitLock(async () => (await rows<{ Info: string | null }>(reader.db, sql`SHOW FULL PROCESSLIST`))
            .some(({ Info }) => Info?.startsWith('INSERT INTO idempotency_keys') && Info.includes(key.idempotencyKey)),
          'Second replacement did not wait for the key');
        });
        [left, right] = await Promise.all(requests);
        assert.equal(right.statusCode, 200, right.body);
        assert.deepEqual(left.json(), right.json());
      } else {
        [left, right] = await runScheduleRace(f.userId, f.accountId, record,
          () => f.apply({ ...input, idempotencyKey: f.newKey() }, f.ruleId, session));
        expectError(right, 409, 'VERSION_CONFLICT');
      }
      assert.equal(left.statusCode, 200, left.body);
      const result = left.json<Result<'replaceScheduleRule'>>();
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_rules WHERE replaces_rule_id = ${f.ruleId}`),
        [{ id: result.replacementRule.ruleId }]);
      assert.deepEqual(await rows(reader.db, sql`SELECT adjustment_id AS adjustmentId, source_occurrence_id AS sourceOccurrenceId
        FROM schedule_occurrences WHERE rule_id = ${result.replacementRule.ruleId}`),
      [{ adjustmentId: f.adjustmentId, sourceOccurrenceId: preview.skippedDates[0].occurrenceId }]);
      const reconciliations = await send(app, 'listBalanceAdjustments', undefined, session, f.accountId);
      assert.equal(reconciliations.statusCode, 200, reconciliations.body);
      assert.deepEqual(reconciliations.json<Result<'listBalanceAdjustments'>>().adjustments[0].skippedDates,
        [{ ruleId: f.ruleId, date: '2027-02-08', reason: 'Early bank debit' }]);
      assert.equal((await rows(reader.db, sql`SELECT id FROM audit_events WHERE object_id = ${f.ruleId} AND event = 'schedule.rule.replaced'`)).length, 1);
      expectCommitted(await send(app, 'commandStatus', key, session), left);
      expectCommitted(await send(restored, 'closeCommand', key, session), left);
      expectError(await send(app, 'commandStatus', { ...key, accountId: f.accountId }, session), 404, 'NOT_FOUND');
      expectError(await f.apply({ ...input, amountMinor: '8000' }, f.ruleId, session), 409, 'IDEMPOTENCY_CONFLICT');
    }
  });

  await t.test('ЗП-06. Failure after writes rolls back a replacement and a lost committed response is recoverable', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    now = Date.parse('2027-02-01T04:00:00Z');
    const session = await renewMobileSession(f.installationSecret);
    const preview = await f.preview(f.ruleId, session);
    const input = f.input(preview);
    const key = { userId: f.userId, command: 'schedule.replace', ruleId: f.ruleId,
      accountId: f.target, idempotencyKey: input.idempotencyKey } as const;
    // The final key write happens after the rule, transfer, and audit. Reject it on this synthetic key.
    await db.execute(sql`ALTER TABLE idempotency_keys ADD CONSTRAINT test_replacement_outcome
      CHECK (command_key <> ${input.idempotencyKey} OR result IS NULL)`);
    try {
      expectError(await f.apply(input, f.ruleId, session), 500, 'INTERNAL_ERROR');
      assert.deepEqual(await rows(reader.db, sql`SELECT version FROM schedule_rule_versions WHERE rule_id = ${f.ruleId}`),
        [{ version: 1 }]);
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_rules WHERE replaces_rule_id = ${f.ruleId}`), []);
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM audit_events WHERE object_id = ${f.ruleId} AND event = 'schedule.rule.replaced'`), []);
      assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_occurrences WHERE source_occurrence_id = ${preview.skippedDates[0].occurrenceId}`), []);
      const status = await send(app, 'commandStatus', key, session);
      assert.equal(status.statusCode, 200, status.body);
      assert.deepEqual(status.json(), { state: 'unknown' });
    } finally {
      await db.execute(sql`ALTER TABLE idempotency_keys DROP CHECK test_replacement_outcome`);
    }

    const interrupted = buildApp(config, db, () => now);
    t.after(() => interrupted.close());
    interrupted.addHook('preSerialization', async (request, reply, payload) => {
      if (request.routeOptions.url === routes.replaceScheduleRule.url && reply.statusCode === 200) {
        throw new Error('Synthetic response loss after commit');
      }
      return payload;
    });
    expectError(await f.apply(input, f.ruleId, session, interrupted), 500, 'INTERNAL_ERROR');
    const replay = await f.apply(input, f.ruleId, session);
    assert.equal(replay.statusCode, 200, replay.body);
    expectCommitted(await send(app, 'commandStatus', key, session), replay);
    expectCommitted(await send(app, 'closeCommand', key, session), replay);
  });

  await t.test('ЗП-07. A date already due in the previous time zone remains on the old rule', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    now = Date.parse('2027-01-31T16:30:00Z');
    const zone = await send(app, 'setTimeZone', { timeZone: 'Europe/Moscow' }, await renewMobileSession(f.installationSecret));
    assert.equal(zone.statusCode, 200, zone.body);
    assert.equal(zone.json<Result<'setTimeZone'>>().today, '2027-01-31');
    now = Date.parse('2027-01-31T17:00:00Z');
    const session = await renewMobileSession(f.installationSecret);
    const preview = await f.preview(f.ruleId, session);
    assert.equal(preview.transitionDate, '2027-02-02');
    assert.equal(preview.transitionAt, Date.parse('2027-02-01T21:00:00Z'));
    const input = f.input(preview);
    expectError(await f.apply({ ...input, firstDate: '2027-02-01' }, f.ruleId, session), 400, 'INVALID_REQUEST');
    const replaced = await f.apply(input, f.ruleId, session);
    assert.equal(replaced.statusCode, 200, replaced.body);
    const history = await occurrences(session, '2027-02-01', '2027-02-08', f.ruleId);
    assert.deepEqual(history.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ date, amountMinor, dueAt, status }) =>
      [date, amountMinor, dueAt, status]), [
      ['2027-02-01', '10000', Date.parse('2027-01-31T16:00:00Z'), 'due'],
      ['2027-02-08', '10000', Date.parse('2027-02-07T16:00:00Z'), 'skipped'],
    ]);
    assert.equal((await settle({ userId: f.userId, accountId: f.accountId, ruleId: f.ruleId, date: '2027-02-01' }))?.status, 'posted');
  });

  await t.test('ЗП-09. Linked rules respect their previous transition and retain the originating reconciliation', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    now = Date.parse('2027-02-01T04:00:00Z');
    let session = await renewMobileSession(f.installationSecret);
    const preview = await f.preview(f.ruleId, session);
    const applied = await f.apply(f.input(preview), f.ruleId, session);
    assert.equal(applied.statusCode, 200, applied.body);
    const { replacementRule } = applied.json<Result<'replaceScheduleRule'>>();
    const successor = replacementRule.ruleId;
    now = Date.parse('2027-02-01T15:59:59Z');
    session = await renewMobileSession(f.installationSecret);
    expectError(await f.requestPreview(successor, session), 409, 'SCHEDULE_RULE_STATE_CONFLICT');
    now = Date.parse('2027-02-03T04:00:00Z');
    session = await renewMobileSession(f.installationSecret);
    const inherited = await f.preview(successor, session);
    assert.equal(inherited.transitionDate, '2027-02-04');
    assert.equal(inherited.transitionAt, Date.parse('2027-02-03T16:00:00Z'));
    assert.deepEqual(inherited.skippedDates.map(({ date, adjustmentId }) => [date, adjustmentId]), [['2027-02-09', f.adjustmentId]]);
    const last = await f.apply({ ...f.input(inherited), firstDate: '2027-02-04', endDate: '2027-02-11', amountMinor: '6000',
      decisions: [{ sourceDate: '2027-02-09', targetDate: '2027-02-11' }] }, successor, session);
    assert.equal(last.statusCode, 200, last.body);
    const finalRuleId = last.json<Result<'replaceScheduleRule'>>().replacementRule.ruleId;
    const sourceOutcome = { userId: f.userId, accountId: f.accountId, ruleId: f.ruleId, date: '2027-02-01' };
    const middle = { userId: f.userId, accountId: f.target, ruleId: successor, date: '2027-02-02' };
    const final = { ...middle, ruleId: finalRuleId, date: '2027-02-04' };
    assert.equal((await settle(sourceOutcome))?.status, 'posted');
    assert.equal((await settle(middle))?.status, 'posted');
    now = Date.parse('2027-02-11T04:00:00Z');
    assert.equal((await settle(final))?.status, 'posted');
    assert.deepEqual(await settle({ ...final, date: '2027-02-11' }),
      { status: 'skipped', adjustmentId: f.adjustmentId, reason: 'Early bank debit' });
    session = await renewMobileSession(f.installationSecret);
    const finalDates = await occurrences(session, '2027-02-04', '2027-02-11', finalRuleId);
    assert.deepEqual(finalDates.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ date, status, adjustmentId, sourceOccurrenceId }) =>
      [date, status, adjustmentId, sourceOccurrenceId]), [
      ['2027-02-04', 'posted', undefined, undefined],
      ['2027-02-11', 'skipped', f.adjustmentId, inherited.skippedDates[0].occurrenceId],
    ]);
    for (const [accountId, amount] of [[f.accountId, '80000'], [f.target, '37000']]) {
      const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, amount);
    }
  });

  await t.test('Administrative replacement requires ownership, CSRF and an audit reason', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    const other = await fixture();
    const { adminId, headers } = await adminSessionHeaders();
    const url = routes.adminReplaceScheduleRule.url.replace(':userId', f.userId).replace(':ruleId', f.ruleId);
    const previewUrl = url + '/preview?accountId=' + f.target;
    const sendAdmin = (method: 'GET' | 'POST', path: string, payload?: object, requestHeaders = headers) =>
      app.inject({ method, url: path, payload, remoteAddress: '192.0.2.1', headers: requestHeaders });
    expectError(await sendAdmin('GET', previewUrl.replace(f.userId, other.userId)), 404, 'NOT_FOUND');
    expectError(await sendAdmin('GET', previewUrl.replace(f.target, other.accountId)), 404, 'NOT_FOUND');
    const preview = await sendAdmin('GET', previewUrl);
    assert.equal(preview.statusCode, 200, preview.body);
    const input = f.input(preview.json<Result<'adminPreviewScheduleRuleReplacement'>>());
    expectError(await sendAdmin('POST', url, input), 400, 'INVALID_REQUEST');
    const body = { ...input, reason: 'Move recurring expense' };
    expectError(await sendAdmin('POST', url, body, { ...headers, 'x-csrf-token': '' }), 403, 'CSRF_INVALID');
    expectError(await sendAdmin('POST', url, { ...body, accountId: other.accountId }), 404, 'NOT_FOUND');
    const result = await sendAdmin('POST', url, body);
    assert.equal(result.statusCode, 200, result.body);
    const key = { userId: f.userId, command: 'schedule.replace', ruleId: f.ruleId, accountId: f.target,
      idempotencyKey: body.idempotencyKey } as const;
    expectCommitted(await sendAdmin('POST', routes.adminCommandStatus.url, key), result);
    expectCommitted(await sendAdmin('POST', routes.adminCloseCommand.url, key), result);
    assert.deepEqual(await one(reader.db, sql`SELECT actor_id AS actorId, actor_role AS actorRole, transition
      FROM audit_events WHERE object_id = ${f.ruleId} AND event = 'schedule.rule.replaced'`),
    { actorId: adminId, actorRole: 'admin', transition: { from: '1', to: '2', reason: body.reason } });
  });

  await t.test('Replacement recovery checks close, recovery epoch, and request limits before changing any rules', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    const input = f.input(await f.preview());
    const key = { userId: f.userId, command: 'schedule.replace', ruleId: f.ruleId, accountId: f.target,
      idempotencyKey: input.idempotencyKey } as const;
    expectError(await send(restored, 'commandStatus', key, f.session), 409, 'COMMAND_REQUIRES_REVIEW');
    expectError(await send(restored, 'closeCommand', key, f.session), 409, 'COMMAND_REQUIRES_REVIEW');
    expectError(await f.apply(input, f.ruleId, f.session, restored), 409, 'COMMAND_REQUIRES_REVIEW');
    expectError(await send(app, 'closeCommand', key, f.session), 409, 'COMMAND_CLOSED');
    expectError(await f.apply(input), 409, 'COMMAND_CLOSED');
    expectError(await send(app, 'commandStatus', { ...key, accountId: f.accountId }, f.session), 404, 'NOT_FOUND');

    const newInput = { ...input, idempotencyKey: f.newKey() };
    const oversized = { ...newInput, comment: ' '.repeat(256 * 1024) };
    expectError(await f.apply(oversized), 413, 'INVALID_REQUEST');
    expectError(await f.apply({ ...newInput, decisions: Array(3001).fill(input.decisions[0]) }), 400, 'INVALID_REQUEST');
    expectError(await send(app, 'createScheduleRule', { ...scheduleInput(f.target, input.firstDate),
      comment: ' '.repeat(8192) }, f.session), 413, 'INVALID_REQUEST');
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_rules WHERE replaces_rule_id = ${f.ruleId}`), []);
    const recorded = await f.apply(newInput);
    assert.equal(recorded.statusCode, 200, recorded.body);
  });

  await t.test('Replacement and archive lock the target account in both orders', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    for (const archiveFirst of [false, true]) {
      const f = await replacementFixture({ earlySkip: false, destinationBalance: 0 });
      const input = f.input(await f.preview());
      const archive = () => send(app, 'archiveAccount', undefined, f.session, f.target);
      const replace = () => f.apply(input);
      const [archived, replaced] = archiveFirst
        ? await runScheduleRace(f.userId, f.target, archive, replace)
        : await runScheduleRace(f.userId, f.target, replace, archive).then(([replacement, archive]) => [archive, replacement] as const);
      if (archiveFirst) {
        assert.equal(archived.statusCode, 200, archived.body);
        expectError(replaced, 409, 'ACCOUNT_UNAVAILABLE');
      } else {
        assert.equal(replaced.statusCode, 200, replaced.body);
        expectError(archived, 409, 'SCHEDULE_FUTURE_DATES');
      }
    }
  });

  await t.test('Deleting a rule removes all its transactions, including revised and already voided ones', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    now = Date.parse('2027-02-16T04:00:00Z');
    const { userId, accountId, session, newKey, expense } = await fixture();
    const other = await fixture();
    const destination = randomUUID();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${destination}, ${userId}, 'Other EUR account', 'EUR', '2027-01-01', 50000)`);
    const created = await send(app, 'createScheduleRule', scheduleInput(accountId, '2027-02-01'), session);
    assert.equal(created.statusCode, 200, created.body);
    const { ruleId, ruleVersion } = created.json<Result<'createScheduleRule'>>();
    const transactionIds: string[] = [];
    for (const date of ['2027-02-01', '2027-02-08', '2027-02-15']) {
      const outcome = await settle({ userId, accountId, ruleId, date });
      assert.ok(outcome?.status === 'posted');
      transactionIds.push(outcome.transactionId);
    }
    const [posted, moved, voided] = transactionIds;
    const revised = await send(app, 'reviseTransaction', {
      ...expense, accountId: destination, date: '2027-02-08', amountMinor: '12000', expectedTransactionVersion: 1, idempotencyKey: newKey(),
    }, session, moved);
    assert.equal(revised.statusCode, 200, revised.body);
    const priorVoid = await send(app, 'voidTransaction', { expectedTransactionVersion: 1, idempotencyKey: newKey() }, session, voided);
    assert.equal(priorVoid.statusCode, 200, priorVoid.body);
    const manual = await send(app, 'recordTransaction', expense, session);
    assert.equal(manual.statusCode, 200, manual.body);
    const { transactionId: manualId } = manual.json<SingleAccountResult>();
    const reconciled = await send(app, 'reconcileAccountBalance', {
      idempotencyKey: newKey(), expectedAccountVersion: 2, actualBalanceMinor: '38000', explanation: 'Bank statement',
    }, session, destination);
    assert.equal(reconciled.statusCode, 200, reconciled.body);
    const { adjustmentId } = reconciled.json<Result<'reconcileAccountBalance'>>();

    const body = { idempotencyKey: newKey(), expectedRuleVersion: ruleVersion };
    const remove = (input = body, auth = session) => send(app, 'deleteScheduleRule', input, auth, ruleId);
    expectError(await remove(body, other.session), 404, 'NOT_FOUND');
    expectError(await remove({ ...body, expectedRuleVersion: ruleVersion + 1 }), 409, 'VERSION_CONFLICT');

    await db.execute(sql`ALTER TABLE schedule_rules ADD CONSTRAINT test_reject_schedule_delete
      CHECK (id <> ${ruleId} OR deleted_at IS NULL)`);
    try {
      expectError(await remove(), 500, 'INTERNAL_ERROR');
      const balance = await send(app, 'getAccountBalance', undefined, session, destination);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '38000');
      const detail = await send(app, 'listTransactionVersions', undefined, session, moved);
      assert.equal(detail.json<Result<'listTransactionVersions'>>().transactionVersion, 2);
      assert.equal((await send(app, 'getScheduleRule', undefined, session, ruleId)).statusCode, 200);
    } finally {
      await db.execute(sql`ALTER TABLE schedule_rules DROP CHECK test_reject_schedule_delete`);
    }

    const deleted = await remove();
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.deepEqual(deleted.json(), { ruleId, status: 'deleted' });
    const replayed = await remove();
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.deepEqual(replayed.json(), deleted.json());
    const key = { userId, command: 'schedule.delete', ruleId, idempotencyKey: body.idempotencyKey } as const;
    expectCommitted(await send(app, 'commandStatus', key, session), deleted);
    expectCommitted(await send(restored, 'closeCommand', key, session), deleted);
    expectError(await remove({ ...body, idempotencyKey: newKey() }), 404, 'NOT_FOUND');

    expectError(await send(app, 'getScheduleRule', undefined, session, ruleId), 404, 'NOT_FOUND');
    expectError(await occurrences(session, '2027-02-01', '2027-02-28', ruleId), 404, 'NOT_FOUND');
    assert.deepEqual((await send(app, 'listScheduleRules', undefined, session)).json(), { rules: [] });
    assert.deepEqual((await send(app, 'getNextPayment', undefined, session)).json(), { payment: null });
    for (const [id, expectedBalance, remainingEntry] of [[accountId, '90000', manualId], [destination, '50000', adjustmentId]]) {
      const balance = await send(app, 'getAccountBalance', undefined, session, id);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, expectedBalance);
      if (id === destination) assert.equal(balance.json<Result<'getAccountBalance'>>().needsReconciliation, true);
      const history = await send(app, 'listAccountHistory', undefined, session, id);
      assert.deepEqual(history.json<Result<'listAccountHistory'>>().entries.map((entry) => entry.id), [remainingEntry, id]);
    }
    assert.deepEqual((await readStatistics(session)).entries.map((entry) => entry.transactionId), [manualId]);
    for (const [id, version] of [[posted, 2], [moved, 3], [voided, 2]] as const) {
      expectError(await send(app, 'listTransactionVersions', undefined, session, id), 404, 'NOT_FOUND');
      assert.deepEqual(await one(reader.db, sql`SELECT v.status, v.version FROM transactions tx
        JOIN transaction_versions v ON v.transaction_id = tx.id AND v.version = tx.current_version WHERE tx.id = ${id}`),
      { status: 'void', version });
    }
  });

  await t.test('Deleting a rule and posting its next date serialize in either order', async () => {
    for (const postFirst of [false, true]) {
      const { userId, accountId, session, newKey } = await fixture();
      const created = await send(app, 'createScheduleRule', scheduleInput(accountId, '2027-02-01'), session);
      assert.equal(created.statusCode, 200, created.body);
      const { ruleId, ruleVersion } = created.json<Result<'createScheduleRule'>>();
      const remove = () => send(app, 'deleteScheduleRule', { expectedRuleVersion: ruleVersion, idempotencyKey: newKey() }, session, ruleId);
      const candidate = { userId, accountId, ruleId, date: '2027-02-01' };
      const post = () => settle(candidate);
      const [deleted, outcome] = postFirst
        ? await runScheduleRace(userId, accountId, post, remove).then(([posted, removed]) => [removed, posted] as const)
        : await runScheduleRace(userId, accountId, remove, post);
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.equal(outcome?.status, postFirst ? 'posted' : undefined);
      assert.equal(await post(), undefined);
      const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '100000');
    }
  });

  await t.test('Deleting a replacement with an audit reason preserves the earlier series and its cutoff', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture();
    now = Date.parse('2027-02-01T04:00:00Z');
    let session = await renewMobileSession(f.installationSecret);
    const replaced = await f.apply(f.input(await f.preview(f.ruleId, session)), f.ruleId, session);
    assert.equal(replaced.statusCode, 200, replaced.body);
    const { transitionAt, replacementRule } = replaced.json<Result<'replaceScheduleRule'>>();
    const { ruleId, ruleVersion } = replacementRule;
    now = transitionAt;
    session = await renewMobileSession(f.installationSecret);
    const oldDate = { userId: f.userId, accountId: f.accountId, ruleId: f.ruleId, date: '2027-02-01' };
    const earlier = await settle(oldDate);
    const later = await settle({ ...oldDate, accountId: f.target, ruleId, date: replacementRule.firstDate });
    assert.equal(earlier?.status, 'posted');
    assert.equal(later?.status, 'posted');

    const { adminId, headers } = await adminSessionHeaders();
    const { url } = routes.adminDeleteScheduleRule;
    const path = url.replace(':userId', f.userId).replace(':ruleId', ruleId);
    const adminPost = (url: string, payload: object, requestHeaders = headers) =>
      app.inject({ method: 'POST', url, payload, remoteAddress: '192.0.2.1', headers: requestHeaders });
    const command = { idempotencyKey: f.newKey(), expectedRuleVersion: ruleVersion };
    const reason = 'Remove replacement charges';
    expectError(await adminPost(path, command), 400, 'INVALID_REQUEST');
    expectError(await adminPost(path, { ...command, reason }, { ...headers, 'x-csrf-token': '' }), 403, 'CSRF_INVALID');
    const deleted = await adminPost(path, { ...command, reason });
    assert.equal(deleted.statusCode, 200, deleted.body);
    expectCommitted(await adminPost(routes.adminCommandStatus.url, { command: 'schedule.delete', userId: f.userId, ruleId,
      idempotencyKey: command.idempotencyKey }), deleted);
    const events = await rows(reader.db, sql`SELECT event, transition FROM audit_events WHERE actor_id = ${adminId}
      AND object_id IN (${ruleId}, ${later.transactionId}) ORDER BY event`);
    assert.deepEqual(events, [
      { event: 'schedule.rule.deleted', transition: { from: '1', to: 'deleted', reason } },
      { event: 'transaction.voided', transition: { from: '1', to: '2', reason } },
    ]);
    const earlierRule = await send(app, 'getScheduleRule', undefined, session, f.ruleId);
    assert.equal(earlierRule.statusCode, 200, earlierRule.body);
    assert.equal(earlierRule.json<Result<'getScheduleRule'>>().state, 'ended');
    assert.equal(earlierRule.json<Result<'getScheduleRule'>>().replacedBy, undefined);
    const dates = await occurrences(session, '2027-02-13', '2027-02-22', f.ruleId);
    assert.deepEqual(dates.json(), { occurrences: [] });
    assert.equal((await send(app, 'listTransactionVersions', undefined, session, earlier.transactionId)).statusCode, 200);
    expectError(await send(app, 'listTransactionVersions', undefined, session, later.transactionId), 404, 'NOT_FOUND');
  });

  await t.test('A linked rule can be replaced after its UTC start when the local date falls back', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    const f = await replacementFixture({ timeZone: 'Pacific/Kiritimati', earlySkip: false });
    now = Date.parse('2027-02-01T04:00:00Z');
    let session = await renewMobileSession(f.installationSecret);
    const preview = await f.preview(f.ruleId, session);
    assert.equal(preview.transitionAt, Date.parse('2027-02-01T10:00:00Z'));
    const result = await f.apply(f.input(preview), f.ruleId, session);
    assert.equal(result.statusCode, 200, result.body);
    const { replacementRule } = result.json<Result<'replaceScheduleRule'>>();
    now = Date.parse('2027-02-01T08:00:00Z');
    session = await renewMobileSession(f.installationSecret);
    const changed = await send(app, 'setTimeZone', { timeZone: 'Pacific/Pago_Pago' }, session);
    assert.equal(changed.statusCode, 200, changed.body);
    now = Date.parse('2027-02-01T11:00:00Z');
    session = await renewMobileSession(f.installationSecret);
    const next = await f.preview(replacementRule.ruleId, session);
    assert.equal(next.transitionDate, '2027-02-03');
    assert.equal(next.transitionAt, Date.parse('2027-02-03T11:00:00Z'));
  });

  await t.test('A replacement transition on an omitted civil day keeps that date and uses the next valid instant', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    now = Date.parse('2011-12-29T20:00:00Z');
    const f = await fixture('Pacific/Apia');
    await db.execute(sql`UPDATE accounts SET start_date = '2011-12-01' WHERE id = ${f.accountId}`);
    const created = await send(app, 'createScheduleRule', scheduleInput(f.accountId, '2011-12-30'), f.session);
    assert.equal(created.statusCode, 200, created.body);
    const { ruleId } = created.json<Result<'createScheduleRule'>>();
    const response = await send(app, 'previewScheduleRuleReplacement', undefined, f.session, ruleId, undefined,
      new URLSearchParams({ accountId: f.accountId }));
    assert.equal(response.statusCode, 200, response.body);
    const preview = response.json<Result<'previewScheduleRuleReplacement'>>();
    assert.equal(preview.transitionDate, '2011-12-30');
    assert.equal(preview.transitionAt, Date.parse('2011-12-30T10:00:00Z'));
    const replaced = await send(app, 'replaceScheduleRule', { ...scheduleInput(f.accountId, '2011-12-30'),
      frequency: 'once', expectedRuleVersion: preview.ruleVersion, previewToken: preview.previewToken,
      decisions: [], idempotencyKey: f.newKey() }, f.session, ruleId);
    assert.equal(replaced.statusCode, 200, replaced.body);
    const { replacementRule } = replaced.json<Result<'replaceScheduleRule'>>();
    now = preview.transitionAt;
    assert.equal((await settle({ userId: f.userId, accountId: f.accountId, ruleId, date: '2011-12-30' })), undefined);
    const outcome = await settle({ userId: f.userId, accountId: f.accountId, ruleId: replacementRule.ruleId, date: '2011-12-30' });
    assert.equal(outcome?.status, 'posted');
  });

  await t.test('Future dates and resumable pauses block archive even when the balance is zero', async () => {
    const { userId, accountId, session } = await fixture();
    await db.execute(sql`UPDATE accounts SET opening_balance_minor = 0 WHERE id = ${accountId}`);
    const ruleId = await scheduleRule(accountId, 'weekly', '2027-02-02');
    const archive = () => send(app, 'archiveAccount', undefined, session, accountId);
    expectError(await archive(), 409, 'SCHEDULE_FUTURE_DATES');

    const boundary = Date.parse('2027-02-01T16:00:00Z');
    await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, state)
      VALUES (${ruleId}, 2, ${now}, ${boundary}, 'paused')`);
    expectError(await archive(), 409, 'SCHEDULE_FUTURE_DATES');
    assert.deepEqual(await one(reader.db, sql`SELECT archived, version FROM accounts WHERE id = ${accountId}`),
      { archived: 0, version: 1 });
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM audit_events WHERE user_id = ${userId}
      AND event = 'finance.account.archived'`), []);

    await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, state)
      VALUES (${ruleId}, 3, ${now}, ${boundary}, 'ended')`);
    const archived = await archive();
    assert.equal(archived.statusCode, 200, archived.body);
    assert.deepEqual(archived.json(), { accountId, accountVersion: 2, archived: true, balanceMinor: '0' });
    const restored = await send(app, 'restoreAccount', undefined, session, accountId);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(await rows(reader.db, sql`SELECT version, state FROM schedule_rule_versions WHERE rule_id = ${ruleId} ORDER BY version`),
      [{ version: 1, state: null }, { version: 2, state: 'paused' }, { version: 3, state: 'ended' }]);
    assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
      { processed_through: null });
  });

  await t.test('An early skip blocks archive until the date is removed by ending the rule and remains in history', async () => {
    const { userId, accountId, session, expense, installationSecret } = await fixture();
    const ruleId = await scheduleRule(accountId, 'once', '2027-02-02');
    const preview = await reconciliationPreview(accountId, session);
    const { status, ...selection } = preview.dates[0];
    assert.equal(status, 'planned');
    const reconciled = await send(app, 'reconcileAccountBalance', { expectedAccountVersion: 1, actualBalanceMinor: '0',
      idempotencyKey: expense.idempotencyKey, explanation: 'Остаток по выписке',
      skippedDates: [{ ...selection, reason: 'Уже учтено' }] }, session, accountId);
    assert.equal(reconciled.statusCode, 200, reconciled.body);
    expectError(await send(app, 'archiveAccount', undefined, session, accountId), 409, 'SCHEDULE_FUTURE_DATES');
    assert.deepEqual(await one(reader.db, sql`SELECT archived, version FROM accounts WHERE id = ${accountId}`),
      { archived: 0, version: 2 });
    assert.deepEqual(await rows(reader.db, sql`SELECT status FROM schedule_occurrences WHERE rule_id = ${ruleId}`),
      [{ status: 'skipped' }]);

    const ended = await send(app, 'changeScheduleRule', { action: 'end', expectedRuleVersion: 1 }, session, ruleId);
    assert.equal(ended.statusCode, 200, ended.body);
    const baseline = now;
    try {
      now = ended.json<Result<'changeScheduleRule'>>().effectiveAt;
      assert.equal(await settle({ userId, accountId, ruleId, date: selection.date }), undefined);
      assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
        { processed_through: null });
      const currentSession = await renewMobileSession(installationSecret);
      const history = await occurrences(currentSession, selection.date, selection.date, ruleId);
      assert.equal(history.statusCode, 200, history.body);
      assert.deepEqual(history.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ status, adjustmentId, reason }) =>
        [status, adjustmentId, reason]), [['skipped', reconciled.json<Result<'reconcileAccountBalance'>>().adjustmentId, 'Уже учтено']]);
      assert.equal((await send(app, 'archiveAccount', undefined, currentSession, accountId)).statusCode, 200);
    } finally {
      now = baseline;
    }
  });

  await t.test('An ended rule blocks archive until its due date has a final outcome', async () => {
    const { userId, accountId, session } = await fixture();
    await db.execute(sql`UPDATE accounts SET opening_balance_minor = 0 WHERE id = ${accountId}`);
    const ruleId = await scheduleRule(accountId, 'once', '2027-01-31');
    await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, state)
      VALUES (${ruleId}, 2, ${now - 3600000}, ${now}, 'ended')`);
    const archive = () => send(app, 'archiveAccount', undefined, session, accountId);
    expectError(await archive(), 409, 'SCHEDULE_DATES_PENDING');
    const { headers } = await adminSessionHeaders();
    const url = routes.adminArchiveAccount.url.replace(':userId', userId).replace(':accountId', accountId);
    expectError(await app.inject({ method: 'POST', url, headers, remoteAddress: '192.0.2.1' }), 409, 'SCHEDULE_DATES_PENDING');
    assert.deepEqual(await one(reader.db, sql`SELECT archived, version FROM accounts WHERE id = ${accountId}`),
      { archived: 0, version: 1 });
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM schedule_occurrences WHERE rule_id = ${ruleId}`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM audit_events WHERE user_id = ${userId}
      AND event = 'finance.account.archived'`), []);

    const occurrenceId = randomUUID();
    await db.execute(sql`INSERT INTO schedule_occurrences
      (id, rule_id, scheduled_date, due_at, rule_version, amount_minor, category_id, status, recorded_at, reason)
      VALUES (${occurrenceId}, ${ruleId}, '2027-01-31', ${now - 86400000}, 1, 10000, 'groceries', 'skipped', ${now}, 'Платёж отменён')`);
    const archived = await archive();
    assert.equal(archived.statusCode, 200, archived.body);
    const restored = await send(app, 'restoreAccount', undefined, session, accountId);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(await rows(reader.db, sql`SELECT id, status, reason FROM schedule_occurrences WHERE rule_id = ${ruleId}`),
      [{ id: occurrenceId, status: 'skipped', reason: 'Платёж отменён' }]);
  });

  await t.test('Archiving and posting the last scheduled date serialize even when posting zeroes the balance', async () => {
    for (const opening of [0, 10000]) {
      for (const archiveFirst of [false, true]) {
        const { userId, accountId, session } = await fixture();
        await db.execute(sql`UPDATE accounts SET opening_balance_minor = ${opening} WHERE id = ${accountId}`);
        const ruleId = await scheduleRule(accountId, 'once', '2027-01-31');
        await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, state)
          VALUES (${ruleId}, 2, ${now - 3600000}, ${now}, 'ended')`);
        const candidate = { userId, accountId, ruleId, date: '2027-01-31' };
        const archive = () => send(app, 'archiveAccount', undefined, session, accountId);
        const post = () => settle(candidate);
        const [archived, posted] = archiveFirst
          ? await runScheduleRace(userId, accountId, archive, post)
          : await runScheduleRace(userId, accountId, post, archive).then(([posting, archiving]) => [archiving, posting] as const);
        assert.ok(posted?.status === 'posted');
        const { transactionId } = posted;
        const archiveSucceeded = !archiveFirst && opening === 10000;
        if (archiveSucceeded) assert.equal(archived.statusCode, 200, archived.body);
        else expectError(archived, 409, archiveFirst && opening === 0 ? 'SCHEDULE_DATES_PENDING' : 'ACCOUNT_BALANCE_NOT_ZERO');
        const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
        assert.equal(balance.statusCode, 200, balance.body);
        const account = balance.json<Result<'getAccountBalance'>>();
        assert.equal(account.balanceMinor, String(opening - 10000));
        assert.equal(Boolean(account.archived), archiveSucceeded);
        assert.deepEqual(await settle(candidate), posted);
        if (archiveSucceeded) assert.equal((await send(app, 'restoreAccount', undefined, session, accountId)).statusCode, 200);
        assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
          { processed_through: candidate.date });
        assert.deepEqual(await rows(reader.db, sql`SELECT scheduled_date, status, transaction_id
          FROM schedule_occurrences WHERE rule_id = ${ruleId}`),
        [{ scheduled_date: candidate.date, status: 'posted', transaction_id: transactionId }]);
      }
    }
  });

  await t.test('A schedule skip cannot bypass earlier dates or overwrite a worker outcome', async () => {
    const baseline = now;
    try {
      now = Date.parse('2027-02-08T04:00:00Z');
      for (const skipFirst of [false, true]) {
        const { userId, accountId, session, newKey } = await fixture();
        const ruleId = await scheduleRule(accountId);
        const date = '2027-02-01';
        const reason = 'Платёж отменён';
        const skip = (target: string) =>
          send(app, 'skipScheduleOccurrence', { idempotencyKey: newKey(), reason }, session, ruleId, target);
        expectError(await skip('2027-02-08'), 409, 'SCHEDULE_DATE_CONFLICT');
        expectError(await skip('2027-02-15'), 409, 'SCHEDULE_DATE_CONFLICT');
        expectError(await skip('2027-02-30'), 400, 'INVALID_REQUEST');
        const post = () => settle({ userId, accountId, ruleId, date });
        const [response, outcome] = skipFirst
          ? await runScheduleRace(userId, accountId, () => skip(date), post)
          : await runScheduleRace(userId, accountId, post, () => skip(date)).then(([posted, skipped]) =>
            [skipped, posted] as const);
        if (skipFirst) {
          assert.equal(response.statusCode, 200, response.body);
          assert.deepEqual(outcome, { status: 'skipped', reason, adjustmentId: null });
        } else {
          expectError(response, 409, 'SCHEDULE_DATE_CONFLICT');
          assert.equal(outcome?.status, 'posted');
        }
        const second = await skip('2027-02-08');
        assert.equal(second.statusCode, 200, second.body);
        assert.deepEqual(await post(), outcome);
        const balance = await send(app, 'getAccountBalance', undefined, session, accountId);
        assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, skipFirst ? '100000' : '90000');
      }
    } finally {
      now = baseline;
    }
  });

  await t.test('A committed schedule skip is recoverable after the account is archived', async () => {
    const { userId, accountId, session, newKey } = await fixture();
    await db.execute(sql`UPDATE accounts SET opening_balance_minor = 0 WHERE id = ${accountId}`);
    const date = '2027-01-31';
    const ruleId = await scheduleRule(accountId, 'once', date);
    await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, state)
      VALUES (${ruleId}, 2, ${now - 3600000}, ${now}, 'ended')`);
    const idempotencyKey = newKey();
    const skip = (key = idempotencyKey) =>
      send(app, 'skipScheduleOccurrence', { idempotencyKey: key, reason: 'Payment cancelled' }, session, ruleId, date);
    const archive = () => send(app, 'archiveAccount', undefined, session, accountId);
    const [recorded, archived] = await runScheduleRace(userId, accountId, () => skip(), archive);
    assert.equal(recorded.statusCode, 200, recorded.body);
    assert.equal(archived.statusCode, 200, archived.body);
    assert.deepEqual((await skip()).json(), recorded.json());
    expectCommitted(await send(app, 'commandStatus', { idempotencyKey, command: 'schedule.skip', userId, ruleId, date }, session), recorded);
    expectError(await skip(newKey()), 409, 'ACCOUNT_UNAVAILABLE');
  });

  await t.test('A manual skip can follow a due reconciliation skip without changing its recorded outcome', async () => {
    const baseline = now;
    try {
      now = Date.parse('2027-01-31T04:00:00Z');
      const { accountId, session, newKey, installationSecret } = await fixture();
      const ruleId = await scheduleRule(accountId);
      const preview = await reconciliationPreview(accountId, session);
      const { status: _status, ...firstDate } = preview.dates[0];
      assert.equal(firstDate.ruleId, ruleId);
      const adjustmentReason = 'Payment recorded on the statement';
      const reconciliation = await send(app, 'reconcileAccountBalance', {
        expectedAccountVersion: preview.accountVersion, actualBalanceMinor: '90000',
        explanation: 'Statement balance', idempotencyKey: newKey(), skippedDates: [{ ...firstDate, reason: adjustmentReason }],
      }, session, accountId);
      assert.equal(reconciliation.statusCode, 200, reconciliation.body);
      const { adjustmentId } = reconciliation.json<Result<'reconcileAccountBalance'>>();
      now = Date.parse('2027-02-08T04:00:00Z');
      const currentSession = await renewMobileSession(installationSecret);
      const skip = (date: string) => send(app, 'skipScheduleOccurrence', { idempotencyKey: newKey(), reason: 'Payment cancelled' },
        currentSession, ruleId, date);
      expectError(await skip(firstDate.date), 409, 'SCHEDULE_DATE_CONFLICT');
      expectError(await skip('2027-02-15'), 409, 'SCHEDULE_DATE_CONFLICT');
      assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
        { processed_through: null });
      const result = await skip('2027-02-08');
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
        { processed_through: '2027-02-08' });
      assert.deepEqual(await rows(reader.db, sql`SELECT scheduled_date, status, reason, adjustment_id FROM schedule_occurrences
        WHERE rule_id = ${ruleId} ORDER BY scheduled_date`), [
        { scheduled_date: firstDate.date, status: 'skipped', reason: adjustmentReason, adjustment_id: adjustmentId },
        { scheduled_date: '2027-02-08', status: 'skipped', reason: 'Payment cancelled', adjustment_id: null },
      ]);
      const balance = await send(app, 'getAccountBalance', undefined, currentSession, accountId);
      assert.equal(balance.json<Result<'getAccountBalance'>>().balanceMinor, '90000');
    } finally {
      now = baseline;
    }
  });

  await t.test('Administrative retry rejects a stale failure revision and starts a fresh attempt', async () => {
    const { userId, accountId, session } = await fixture();
    const { adminId, headers } = await adminSessionHeaders();
    const other = await fixture();
    const ruleId = await scheduleRule(accountId, 'once');
    const date = '2027-02-01';
    const candidate = { userId, accountId, ruleId, date };
    const firstFailure = await recordScheduleDateFailure(db, candidate, 'SCHEDULE_DATA_INVALID', 0, () => now);
    assert.ok(firstFailure);
    const { failureRevision } = firstFailure;
    const dates = await occurrences(session, date, date, ruleId);
    assert.equal(dates.statusCode, 200, dates.body);
    const [failed] = dates.json<Result<'listScheduleOccurrences'>>().occurrences;
    assert.equal(failed.status, 'needs_intervention');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.failureRevision, failureRevision);
    const url = routes.adminRetryScheduleOccurrence.url.replace(':userId', userId).replace(':ruleId', ruleId).replace(':date', date);
    const reason = 'Statement checked';
    const post = { method: 'POST', url, remoteAddress: '192.0.2.1', headers,
      payload: { reason, expectedFailureRevision: failureRevision } } as const;
    expectError(await app.inject({ ...post, headers: { ...headers, 'x-csrf-token': 'invalid' } }), 403, 'CSRF_INVALID');
    expectError(await app.inject({ ...post, url: url.replace(userId, other.userId) }), 404, 'NOT_FOUND');
    assert.deepEqual(await settle(candidate), undefined);
    const retry = await app.inject(post);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), { ruleId, date, status: 'due' });
    assert.deepEqual(await rows(reader.db, sql`SELECT attempts FROM schedule_date_failures WHERE rule_id = ${ruleId}`), []);
    assert.deepEqual(await one(reader.db, sql`SELECT processed_through FROM schedule_rules WHERE id = ${ruleId}`),
      { processed_through: null });
    expectError(await app.inject(post), 409, 'SCHEDULE_DATE_CONFLICT');

    // A new failure can occur at exactly the same clock instant.
    const nextFailure = await recordScheduleDateFailure(db, candidate, 'SCHEDULE_DATA_INVALID', 0, () => now);
    assert.ok(nextFailure);
    assert.equal(nextFailure.attempts, 1);
    assert.notEqual(nextFailure.failureRevision, failureRevision);
    expectError(await app.inject(post), 409, 'SCHEDULE_DATE_CONFLICT');
    assert.deepEqual(await settle(candidate), undefined);
    const secondRetry = await app.inject({ ...post, payload: { reason, expectedFailureRevision: nextFailure.failureRevision } });
    assert.equal(secondRetry.statusCode, 200, secondRetry.body);
    assert.equal((await settle(candidate))?.status, 'posted');
    expectError(await app.inject({ ...post, payload: { reason, expectedFailureRevision: nextFailure.failureRevision } }),
      409, 'SCHEDULE_DATE_CONFLICT');
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_role, actor_id, object_id, transition FROM audit_events
      WHERE user_id = ${userId} AND event = 'schedule.occurrence.retried' ORDER BY id`), [
      { actor_role: 'admin', actor_id: adminId, object_id: ruleId, transition: { from: date, to: 'due', reason } },
      { actor_role: 'admin', actor_id: adminId, object_id: ruleId, transition: { from: date, to: 'due', reason } },
    ]);
  });

  await t.test('The owner or administrator can skip a date needing intervention', async () => {
    for (const adminActs of [false, true]) {
      const { userId, accountId, session, newKey } = await fixture();
      const { adminId, headers } = await adminSessionHeaders();
      const other = await fixture();
      const ruleId = await scheduleRule(accountId);
      const date = '2027-02-01';
      const candidate = { userId, accountId, ruleId, date };
      const idempotencyKey = newKey();
      const reason = 'Payment cancelled';
      const url = routes.adminSkipScheduleOccurrence.url.replace(':userId', userId).replace(':ruleId', ruleId).replace(':date', date);
      const adminSkip = (expectedFailureRevision: string) => app.inject({ method: 'POST', url,
        remoteAddress: '192.0.2.1', headers, payload: { idempotencyKey, reason, expectedFailureRevision } });
      const ownerSkip = () => send(app, 'skipScheduleOccurrence', { idempotencyKey, reason }, session, ruleId, date);
      expectError(await adminSkip(randomUUID()), 409, 'SCHEDULE_DATE_CONFLICT');
      const failure = await recordScheduleDateFailure(db, candidate, 'SCHEDULE_DATA_INVALID', 0, () => now);
      assert.ok(failure);
      expectError(await adminSkip(randomUUID()), 409, 'SCHEDULE_DATE_CONFLICT');
      expectError(await send(app, 'skipScheduleOccurrence', { idempotencyKey, reason }, other.session, ruleId, date), 404, 'NOT_FOUND');
      const result = adminActs ? await adminSkip(failure.failureRevision) : await ownerSkip();
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(await rows(reader.db, sql`SELECT attempts FROM schedule_date_failures WHERE rule_id = ${ruleId}`), []);
      const key = { command: 'schedule.skip', userId, ruleId, date, idempotencyKey } as const;
      if (adminActs) {
        const adminStatus = await app.inject({ method: 'POST', url: routes.adminCommandStatus.url,
          remoteAddress: '192.0.2.1', headers, payload: key });
        expectCommitted(adminStatus, result);
        assert.deepEqual((await adminSkip(failure.failureRevision)).json(), result.json());
        expectError(await adminSkip(randomUUID()), 409, 'IDEMPOTENCY_CONFLICT');
        const ownerStatus = await send(app, 'commandStatus', key, session);
        assert.equal(ownerStatus.statusCode, 200, ownerStatus.body);
        assert.deepEqual(ownerStatus.json(), { state: 'unknown' });
      }
      const { occurrenceId } = result.json<Result<'skipScheduleOccurrence'>>();
      assert.deepEqual(await rows(reader.db, sql`SELECT actor_role, actor_id, object_id, transition FROM audit_events
        WHERE user_id = ${userId} AND event = 'schedule.occurrence.skipped'`), [
        { actor_role: adminActs ? 'admin' : 'user', actor_id: adminActs ? adminId : userId, object_id: occurrenceId,
          transition: { from: 'needs_intervention', to: 'skipped', reason } },
      ]);
      assert.deepEqual(await settle(candidate), { status: 'skipped', reason, adjustmentId: null });
    }
  });

  await t.test('An administrator archives and restores an account for the selected owner', async () => {
    const { userId, accountId } = await fixture();
    const other = await fixture();
    const { adminId, headers } = await adminSessionHeaders();
    await db.execute(sql`UPDATE accounts SET opening_balance_minor = 0 WHERE id = ${accountId}`);
    const url = routes.adminArchiveAccount.url.replace(':userId', userId).replace(':accountId', accountId);
    const post = { method: 'POST', url, remoteAddress: '192.0.2.1', headers } as const;
    expectError(await app.inject({ ...post, url: url.replace(userId, other.userId) }), 404, 'NOT_FOUND');
    expectError(await app.inject({ ...post, headers: { ...headers, 'x-csrf-token': 'invalid' } }), 403, 'CSRF_INVALID');
    const archived = await app.inject(post);
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal(archived.json<Result<'adminArchiveAccount'>>().archived, true);
    const restored = await app.inject({ ...post, url: url.replace(/archive$/, 'restore') });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json<Result<'adminRestoreAccount'>>().archived, false);
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_id, event FROM audit_events WHERE object_id = ${accountId}
      AND actor_role = 'admin' ORDER BY id`), [
      { actor_id: adminId, event: 'finance.account.archived' }, { actor_id: adminId, event: 'finance.account.restored' },
    ]);
  });

  await t.test('The administrative ledger scopes search, reads, renames and audit to the selected owner', async () => {
    const { userId, accountId, session, expense } = await fixture();
    const other = await fixture();
    const { adminId, headers } = await adminSessionHeaders();
    const address = 'ledger_%' + randomUUID() + '@example.test';
    await db.execute(sql`UPDATE users SET email = ${address} WHERE id = ${userId}`);
    await db.execute(sql`UPDATE users SET email = ${address.replace('_%', 'xx')} WHERE id = ${other.userId}`);
    assert.equal((await send(app, 'recordTransaction', expense, session)).statusCode, 200);
    const get = (url: string, requestHeaders = headers) => app.inject({ method: 'GET', url, remoteAddress: '192.0.2.1', headers: requestHeaders });
    const path = routes.adminListAccounts.url.replace(':userId', userId);
    const historyPath = routes.adminListAccountHistory.url.replace(':userId', userId).replace(':accountId', accountId);
    const search = new URLSearchParams({ search: address.slice(0, -13).toUpperCase() });
    const found = await get(routes.listUsers.url + '?' + search);
    assert.equal(found.statusCode, 200, found.body);
    assert.deepEqual(found.json<Result<'listUsers'>>().users.map(({ id }) => id), [userId]);
    const ledger = await get(path);
    assert.equal(ledger.statusCode, 200, ledger.body);
    const snapshot = ledger.json<Result<'adminListAccounts'>>();
    assert.equal(snapshot.timeZone, 'Asia/Makassar');
    assert.deepEqual(snapshot.accounts.map(({ accountId, balanceMinor }) => [accountId, balanceMinor]), [[accountId, '90000']]);
    expectError(await get(path.replace(userId, randomUUID())), 404, 'NOT_FOUND');
    expectError(await get(path, { ...headers, cookie: '' }), 401, 'ADMIN_AUTH_INVALID');
    expectError(await get(historyPath.replace(userId, other.userId)), 404, 'NOT_FOUND');
    const history = await get(historyPath);
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json<Result<'adminListAccountHistory'>>().entries.map(({ type }) => type), ['expense', 'opening']);
    const catalog = await get(routes.adminListCategories.url);
    assert.equal(catalog.statusCode, 200, catalog.body);
    assert.ok(catalog.json<Result<'adminListCategories'>>().categories.some(({ id, nameRu }) => id === 'groceries' && nameRu === 'Продукты'));

    const renamePath = routes.adminRenameAccount.url.replace(':userId', userId).replace(':accountId', accountId);
    const reason = 'Match the account name on the bank statement';
    const expectedAccountVersion = snapshot.accounts[0].accountVersion;
    const rename = (payload: object, url = renamePath, requestHeaders = headers) =>
      app.inject({ method: 'PUT', url, payload, remoteAddress: '192.0.2.1', headers: requestHeaders });
    const payload = { name: 'Renamed EUR account', reason, expectedAccountVersion };
    expectError(await rename(payload, renamePath, { ...headers, 'x-csrf-token': '' }), 403, 'CSRF_INVALID');
    expectError(await rename(payload, renamePath.replace(userId, other.userId)), 404, 'NOT_FOUND');
    expectError(await rename({ ...payload, reason: ' ' }), 400, 'INVALID_REQUEST');
    const saved = await rename(payload);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json<Result<'adminRenameAccount'>>().name, payload.name);
    expectError(await rename(payload), 409, 'VERSION_CONFLICT');
    assert.deepEqual(await rows(reader.db, sql`SELECT actor_role, actor_id, user_id, object_id, transition FROM audit_events
      WHERE object_id = ${accountId} AND event = 'finance.account.renamed'`), [
      { actor_role: 'admin', actor_id: adminId, user_id: userId, object_id: accountId,
        transition: { from: String(expectedAccountVersion), to: String(expectedAccountVersion + 1), reason } },
    ]);
  });

  await t.test('Next payment selects the first unsettled outgoing occurrence, including distant dates', async () => {
    const { session, accountId } = await fixture();
    const other = await fixture();
    const read = async () => {
      const response = await send(app, 'getNextPayment', undefined, session);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Result<'getNextPayment'>>().payment;
    };
    const create = async (date: string, kind: 'expense' | 'income', comment?: string) => {
      const response = await send(app, 'createScheduleRule', {
        ...scheduleInput(accountId, date), kind, frequency: 'once', comment,
        categoryId: kind === 'income' ? 'salary' : 'groceries',
      }, session);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Result<'createScheduleRule'>>().ruleId;
    };

    await scheduleRule(other.accountId, 'once', '2027-02-02');
    await create('2027-02-03', 'income');
    const skipped = await create('2027-02-01', 'expense');
    const skip = await send(app, 'skipScheduleOccurrence', { reason: 'Already covered',
      idempotencyKey: '1.' + token() }, session, skipped, '2027-02-01');
    assert.equal(skip.statusCode, 200, skip.body);
    assert.equal(await read(), null);
    const ruleId = await create('2028-02-01', 'expense', 'Annual insurance');
    const payment = await read();
    assert.equal(payment?.ruleId, ruleId);
    assert.equal(payment?.date, '2028-02-01');
    assert.equal(payment?.comment, 'Annual insurance');
    assert.equal(payment?.amountMinor, '10000');
  });

  await t.test('Account statements use the latest posted ledger, inclusive dates, and an owned account', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    now = Date.parse('2027-02-28T15:59:00Z'); // One minute before midnight in Asia/Makassar.
    const { accountId, userId, session, newKey, installationSecret } = await fixture();
    const other = await fixture();
    const usd = randomUUID();
    const first = '2027-02-01';
    const last = '2027-02-28';
    const query = { fromDate: first, throughDate: last, lang: 'ru' as const };
    await db.execute(sql`UPDATE accounts SET opening_balance_minor = 110000 WHERE id = ${accountId}`);
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${usd}, ${userId}, 'USD wallet', 'USD', '2027-01-01', 10000)`);

    async function record(type: 'expense' | 'income', date: string, amountMinor: string) {
      const response = await send(app, 'recordTransaction', {
        type, accountId, date, amountMinor, categoryId: type === 'income' ? 'salary' : 'groceries', idempotencyKey: newKey(),
      }, session);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<SingleAccountResult>();
    }
    function download(bearer: string | undefined, account = accountId, filters = query) {
      return send(app, 'getAccountStatement', undefined, bearer, account, undefined, new URLSearchParams(filters));
    }
    const read = (filters = query, account = accountId) =>
      db.transaction((tx) => readAccountStatement(tx, userId, account, now, filters));

    await record('expense', '2027-01-31', '10000');
    await record('income', first, '10000');
    const expense = await record('expense', last, '5100');
    const edit = (amountMinor: string, expectedTransactionVersion: number) =>
      send(app, 'reviseTransaction', { type: 'expense', accountId, date: last, amountMinor, categoryId: 'groceries',
        comment: 'Исправленный расход', expectedTransactionVersion, idempotencyKey: newKey(),
      }, session, expense.transactionId);
    assert.equal((await edit('5000', 1)).statusCode, 200);
    const canceled = await record('expense', first, '9900');
    const voidResponse = await send(app, 'voidTransaction', { expectedTransactionVersion: 1, idempotencyKey: newKey() },
      session, canceled.transactionId);
    assert.equal(voidResponse.statusCode, 200, voidResponse.body);

    const transfer = await send(app, 'recordTransaction', {
      type: 'transfer', fromAccountId: usd, toAccountId: accountId, fromAmountMinor: '10000', toAmountMinor: '9200',
      date: last, idempotencyKey: newKey(),
    }, session);
    assert.equal(transfer.statusCode, 200, transfer.body);
    const reconciliation = await send(app, 'reconcileAccountBalance', {
      expectedAccountVersion: transfer.json<TransferResult>().toAccount.accountVersion, actualBalanceMinor: '114000',
      explanation: 'Проверено по выписке', idempotencyKey: newKey(),
    }, session, accountId);
    assert.equal(reconciliation.statusCode, 200, reconciliation.body);
    expectError(await download(session, accountId, { ...query, throughDate: '2027-03-01' }), 400, 'INVALID_REQUEST');
    now += 2 * 60 * 1000;
    await record('income', '2027-03-01', '700');

    const statement = await read();
    assert.deepEqual([statement.openingMinor, statement.incomingMinor, statement.outgoingMinor,
      statement.adjustmentsMinor, statement.closingMinor], ['100000', '19200', '5000', '-200', '114000']);
    assert.deepEqual(statement.entries.map(({ date }) => date), [first, last, last, last]);
    assert.deepEqual(statement.entries.map(({ kind, amountMinor }) => [kind, amountMinor]).sort(),
      [['adjustment', '-200'], ['expense', '-5000'], ['income', '10000'], ['transfer', '9200']]);
    assert.equal(statement.entries.find(({ kind }) => kind === 'expense')?.description, 'Исправленный расход');
    const oneDay = await read({ ...query, throughDate: first });
    assert.deepEqual([oneDay.openingMinor, oneDay.closingMinor, oneDay.entries.length], ['100000', '110000', 1]);
    const empty = await read({ ...query, fromDate: '2027-02-02', throughDate: '2027-02-02' });
    assert.deepEqual([empty.openingMinor, empty.closingMinor, empty.entries], ['110000', '110000', []]);

    const response = await download(session);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['content-disposition'], 'attachment; filename="statement-2027-02-01-2027-02-28.pdf"');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.rawPayload.subarray(0, 5).toString(), '%PDF-');
    expectError(await download(other.session), 404, 'NOT_FOUND');
    expectError(await download(session, randomUUID()), 404, 'NOT_FOUND');
    expectError(await download(undefined), 401, 'SESSION_EXPIRED');
    expectError(await download(session, accountId, { ...query, fromDate: '2026-12-31' }), 400, 'INVALID_REQUEST');
    expectError(await download(session, accountId, { ...query, fromDate: '2027-02-30' }), 400, 'INVALID_REQUEST');
    expectError(await download(session, accountId, { ...query, fromDate: last, throughDate: first }), 400, 'INVALID_REQUEST');

    const [duringEdit, edited] = await Promise.all([read(), edit('5500', 2)]);
    assert.equal(edited.statusCode, 200, edited.body);
    const duringExpense = duringEdit.entries.find(({ kind }) => kind === 'expense')?.amountMinor;
    assert.deepEqual([duringExpense, duringEdit.closingMinor],
      duringEdit.outgoingMinor === '5000' ? ['-5000', '114000'] : ['-5500', '113500']);
    assert.equal((await read()).closingMinor, '113500');

    const archive = await send(app, 'archiveAccount', undefined, session, usd);
    assert.equal(archive.statusCode, 200, archive.body);
    const archived = await read(query, usd);
    assert.deepEqual([archived.currency, archived.outgoingMinor, archived.closingMinor], ['USD', '10000', '0']);
    assert.equal((await download(session, usd)).statusCode, 200);
    const current = await renewMobileSession(installationSecret);
    expectError(await download(session), 401, 'SESSION_EXPIRED');
    assert.equal((await download(current)).statusCode, 200);
  });

  await t.test('A statement includes more than one history page and rejects over-limit reports', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    now = Date.parse('2027-02-03T00:00:00Z');
    const { accountId, userId, session } = await fixture();
    await db.execute(sql`
      INSERT INTO balance_adjustments (id, account_id, account_version, financial_date, created_at, covered_through,
        balance_before_minor, actual_balance_minor, delta_minor, explanation, actor_role)
      WITH RECURSIVE sequence AS (
        SELECT 0 AS n UNION ALL SELECT n + 1 FROM sequence WHERE n < 49
      )
      SELECT UUID(), ${accountId}, a.n * 50 + b.n + 2, IF(a.n = 0, '2027-02-01', '2027-02-02'),
        ${now}, '2027-02-02', 100000, 100000, 0, 'Checked', 'user'
      FROM sequence a CROSS JOIN sequence b ORDER BY a.n, b.n LIMIT ${accountStatementRowLimit + 1}`);
    const query = { fromDate: '2027-02-02', throughDate: '2027-02-02', lang: 'en' as const };
    const withinLimit = await db.transaction((tx) => readAccountStatement(tx, userId, accountId, now, query));
    assert.equal(withinLimit.entries.length, accountStatementRowLimit + 1 - 50);
    const tooLarge = await send(app, 'getAccountStatement', undefined, session, accountId, undefined,
      new URLSearchParams({ ...query, fromDate: '2027-02-01' }));
    expectError(tooLarge, 422, 'STATEMENT_TOO_LARGE');
    assert.match(String(tooLarge.headers['content-type']), /^application\/json/);
    assert.equal(tooLarge.headers['content-disposition'], undefined);
  });

  await t.test('Statistics defaults to the profile month and validates access and period bounds', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    now = Date.parse('2028-01-31T16:30:00Z');
    const owner = await fixture();
    const utc = await fixture(null);
    assert.deepEqual(await readStatistics(owner.session), {
      fromDate: '2028-02-01', throughDate: '2028-02-29', totals: [], categories: [], entries: [], next: null,
    });
    assert.deepEqual(await readStatistics(utc.session), {
      fromDate: '2028-01-01', throughDate: '2028-01-31', totals: [], categories: [], entries: [], next: null,
    });
    expectError(await statistics(), 401, 'SESSION_EXPIRED');
    expectError(await statistics(owner.session, { accountId: utc.accountId, categoryId: 'dining', type: 'income' }), 404, 'NOT_FOUND');
    expectError(await statistics(owner.session, { accountId: randomUUID() }), 404, 'NOT_FOUND');
    for (const filters of [
      { fromDate: '2028-02-01' }, { throughDate: '2028-02-29' },
      { fromDate: '2028-02-29', throughDate: '2028-02-01' }, { fromDate: '2028-02-30', throughDate: '2028-02-30' },
      { before: '' }, { before: 'not-a-cursor' }, { before: '2028-02-30.' + randomUUID() },
      { before: '2028-01-31.' + randomUUID() }, { currency: 'GBP' }, { type: 'transfer' },
      { categoryId: 'Groceries' }, { userId: utc.userId },
    ] as Record<string, string>[]) expectError(await statistics(owner.session, filters), 400, 'INVALID_REQUEST');
    const newSession = await renewMobileSession(owner.installationSecret);
    expectError(await statistics(owner.session), 401, 'SESSION_EXPIRED');
    assert.equal((await readStatistics(newSession)).throughDate, '2028-02-29');
  });

  await t.test('Statistics matches current history by date, category, currency, and account', async (t) => {
    const previousNow = now;
    t.after(() => { now = previousNow; });
    now = Date.parse('2027-03-01T00:00:00Z');
    const { session, accountId, userId, newKey } = await fixture();
    const usd = randomUUID();
    const archived = randomUUID();
    const other = await fixture();
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor) VALUES
      (${usd}, ${userId}, 'USD wallet', 'USD', '2027-01-01', 50000),
      (${archived}, ${userId}, 'Closed EUR wallet', 'EUR', '2027-01-01', 10000)`);

    async function record(type: 'expense' | 'income', account: string, date: string, amountMinor: string, categoryId: string) {
      const response = await send(app, 'recordTransaction', {
        type, accountId: account, date, amountMinor, categoryId, idempotencyKey: newKey(),
      }, session);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<SingleAccountResult>();
    }

    const first = '2027-02-01';
    const last = '2027-02-28';
    const revised = await record('expense', accountId, '2027-01-31', '90000', 'groceries');
    const change = await send(app, 'reviseTransaction', {
      type: 'expense', accountId, date: first, amountMinor: '3000', categoryId: 'dining', comment: 'Corrected',
      expectedTransactionVersion: revised.transactionVersion, idempotencyKey: newKey(),
    }, session, revised.transactionId);
    assert.equal(change.statusCode, 200, change.body);
    const voided = await record('expense', accountId, first, '5000', 'transport');
    const cancellation = await send(app, 'voidTransaction', {
      expectedTransactionVersion: voided.transactionVersion, idempotencyKey: newKey(),
    }, session, voided.transactionId);
    assert.equal(cancellation.statusCode, 200, cancellation.body);
    const income = await record('income', accountId, last, '12550', 'salary');
    await record('income', accountId, '2027-03-01', '1000', 'salary');
    await record('expense', usd, first, '2100', 'groceries');
    const archivedEntry = await record('expense', archived, first, '10000', 'groceries');
    const archive = await send(app, 'archiveAccount', undefined, session, archived);
    assert.equal(archive.statusCode, 200, archive.body);

    const ruleId = await scheduleRule(accountId, 'once', last);
    const automatic = await settle({ userId, accountId, ruleId, date: last });
    assert.equal(automatic?.status, 'posted');
    const transfer = await send(app, 'recordTransaction', {
      type: 'transfer', fromAccountId: usd, toAccountId: accountId, fromAmountMinor: '440', toAmountMinor: '390',
      date: last, idempotencyKey: newKey(),
    }, session);
    assert.equal(transfer.statusCode, 200, transfer.body);
    const reconciliation = await send(app, 'reconcileAccountBalance', {
      expectedAccountVersion: transfer.json<TransferResult>().toAccount.accountVersion, actualBalanceMinor: '100000',
      explanation: 'Bank statement', idempotencyKey: newKey(),
    }, session, accountId);
    assert.equal(reconciliation.statusCode, 200, reconciliation.body);
    const otherExpense = await send(app, 'recordTransaction', other.expense, other.session);
    assert.equal(otherExpense.statusCode, 200, otherExpense.body);

    const period = { fromDate: first, throughDate: last };
    const all = await readStatistics(session, period);
    assert.deepEqual(all.totals, [
      { currency: 'EUR', incomeMinor: '12550', expenseMinor: '23000' },
      { currency: 'USD', incomeMinor: '0', expenseMinor: '2100' },
    ]);
    assert.equal(all.weeks, undefined);
    const weekly = await readStatistics(session, { ...period, byWeek: 'true' });
    assert.deepEqual(weekly.weeks, [
      { weekIndex: 0, currency: 'EUR', incomeMinor: '0', expenseMinor: '13000' },
      { weekIndex: 0, currency: 'USD', incomeMinor: '0', expenseMinor: '2100' },
      { weekIndex: 3, currency: 'EUR', incomeMinor: '12550', expenseMinor: '10000' },
    ]);
    assert.deepEqual(all.categories, [
      { currency: 'EUR', categoryId: 'groceries', amountMinor: '20000' },
      { currency: 'EUR', categoryId: 'dining', amountMinor: '3000' },
      { currency: 'USD', categoryId: 'groceries', amountMinor: '2100' },
    ]);
    assert.equal(all.entries.length, 5);
    assert.deepEqual(all.entries.map(({ date }) => date), [last, last, first, first, first]);
    assert.equal(all.next, null);
    const base = await readStatistics(session, { ...period, accountId });
    const history = await send(app, 'listAccountHistory', undefined, session, accountId);
    assert.equal(history.statusCode, 200, history.body);
    const { entries } = history.json<Result<'listAccountHistory'>>();
    assert.deepEqual(base.entries.map(({ transactionId, transactionVersion, date, type, categoryId, amountMinor, comment }) =>
      ({ id: transactionId, transactionVersion, date, type, categoryId, amountMinor, comment })), entries.flatMap((entry) => {
      if ((entry.type !== 'expense' && entry.type !== 'income') || entry.status !== 'posted' || entry.date > last || entry.date < first) return [];
      const { id, transactionVersion, date, type, categoryId, amountMinor, comment } = entry;
      return [{ id, transactionVersion, date, type, categoryId, amountMinor, comment }];
    }));
    assert.ok(entries.some((entry) => entry.type === 'transfer'));
    assert.ok(entries.some((entry) => entry.type === 'opening'));
    assert.ok(entries.some((entry) => entry.type === 'adjustment'));
    assert.ok(entries.some((entry) => entry.type === 'expense' && entry.status === 'void'));
    const salary = await readStatistics(session, { ...period, type: 'income', currency: 'EUR', categoryId: 'salary' });
    assert.deepEqual(salary.categories, []);
    assert.deepEqual(salary.totals, [{ currency: 'EUR', incomeMinor: '12550', expenseMinor: '0' }]);
    assert.deepEqual(salary.entries.map(({ transactionId }) => transactionId), [income.transactionId]);
    const groceries = await readStatistics(session, { ...period, type: 'expense', currency: 'EUR', categoryId: 'groceries' });
    assert.deepEqual(groceries.totals, [{ currency: 'EUR', incomeMinor: '0', expenseMinor: '20000' }]);
    assert.equal(groceries.entries.length, 2);
    const closed = await readStatistics(session, { ...period, accountId: archived });
    assert.deepEqual(closed.entries.map(({ transactionId }) => transactionId), [archivedEntry.transactionId]);
    assert.deepEqual((await readStatistics(session, { ...period, type: 'income', categoryId: 'groceries' })).entries, []);
  });

  await t.test('Statistics paginates same-day operations and preserves exact whole-report totals', async () => {
    const { session, accountId, newKey } = await fixture();
    const sample = [9223372036854775807n, ...Array.from({ length: 51 }, (_, index) => BigInt(index + 1))];
    const expectedIds: string[] = [];
    const date = '2027-02-01';
    for (const amount of sample) {
      const response = await send(app, 'recordTransaction', {
        ...expenseFor(accountId, newKey()), date, amountMinor: amount.toString(),
      }, session);
      assert.equal(response.statusCode, 200, response.body);
      expectedIds.push(response.json<SingleAccountResult>().transactionId);
    }
    for (const name of ['First card', 'Second card']) {
      const card = await send(app, 'createAccountCard', { name, appearance: '#123456' }, session, accountId);
      assert.equal(card.statusCode, 200, card.body);
    }
    const filter = { fromDate: date, throughDate: date, accountId, categoryId: 'groceries', byWeek: 'true' };
    const first = await readStatistics(session, filter);
    assert.equal(first.entries.length, 50);
    assert.ok(first.next);
    const second = await readStatistics(session, { ...filter, before: first.next });
    assert.equal(second.entries.length, 2);
    assert.equal(second.next, null);
    assert.deepEqual([...first.entries, ...second.entries].map(({ transactionId }) => transactionId), expectedIds.sort().reverse());
    const total = sample.reduce((sum, value) => sum + value, 0n).toString();
    assert.deepEqual(first.totals, [{ currency: 'EUR', incomeMinor: '0', expenseMinor: total }]);
    assert.deepEqual(first.categories, [{ currency: 'EUR', categoryId: 'groceries', amountMinor: total }]);
    assert.deepEqual(first.weeks, [{ weekIndex: 0, currency: 'EUR', incomeMinor: '0', expenseMinor: total }]);
    assert.deepEqual(second.weeks, first.weeks);
    assert.deepEqual(second.totals, first.totals);
    assert.deepEqual(second.categories, first.categories);
    expectError(await statistics(session, { fromDate: '2027-01-01', throughDate: '2027-01-31', before: first.next }),
      400, 'INVALID_REQUEST');
  });

  await t.test('A concurrent revision changes statistics entries and aggregates together', async () => {
    const { userId, accountId, session, newKey } = await fixture();
    const posted = await send(app, 'recordTransaction', expenseFor(accountId, newKey()), session);
    assert.equal(posted.statusCode, 200, posted.body);
    const { transactionId } = posted.json<SingleAccountResult>();
    const before = await readStatistics(session);
    assert.deepEqual(before.totals, [{ currency: 'EUR', incomeMinor: '0', expenseMinor: '10000' }]);
    assert.deepEqual(before.categories, [{ currency: 'EUR', categoryId: 'groceries', amountMinor: '10000' }]);
    assert.equal(before.entries[0].transactionVersion, 1);
    const [revision, after] = await runScheduleRace(userId, accountId, () => send(app, 'reviseTransaction', {
      ...expenseFor(accountId, newKey()), categoryId: 'transport', amountMinor: '2400', expectedTransactionVersion: 1,
    }, session, transactionId), () => readStatistics(session));
    assert.equal(revision.statusCode, 200, revision.body);
    assert.deepEqual(after.totals, [{ currency: 'EUR', incomeMinor: '0', expenseMinor: '2400' }]);
    assert.deepEqual(after.categories, [{ currency: 'EUR', categoryId: 'transport', amountMinor: '2400' }]);
    assert.deepEqual(after.entries.map((entry) => [entry.transactionId, entry.transactionVersion, entry.amountMinor, entry.categoryId]),
      [[transactionId, 2, '-2400', 'transport']]);
  });

  await t.test('Access, rejected inputs, recovery version and exact large amounts', async () => {
    const { userId, session, expense } = await fixture();
    const other = await fixture();
    expectError(await send(app, 'recordTransaction', expense), 401, 'SESSION_EXPIRED');
    expectError(await send(app, 'recordTransaction', expense, other.session), 404, 'NOT_FOUND');
    for (const change of [
      { date: '2026-12-31' }, { date: '2027-02-02' }, { date: '2027-02-30' },
      { amountMinor: '0' }, { amountMinor: '9223372036854775808' }, { categoryId: 'missing' },
    ]) {
      expectError(await send(app, 'recordTransaction', { ...expense, ...change }, session), 400, 'INVALID_REQUEST');
    }
    const restoredProfile = await send(restored, 'me', undefined, session);
    assert.equal(restoredProfile.statusCode, 200, restoredProfile.body);
    assert.equal(restoredProfile.json<Result<'me'>>().recoveryVersion, '2');
    expectError(await send(restored, 'recordTransaction', expense, session), 409, 'COMMAND_REQUIRES_REVIEW');
    assert.deepEqual(await rows(reader.db, sql`SELECT command_key FROM idempotency_keys WHERE actor_id IN (${userId}, ${other.userId})`), []);

    const original = await send(app, 'recordTransaction', expense, session);
    assert.equal(original.statusCode, 200, original.body);
    const large = await send(restored, 'recordTransaction', {
      ...expense, amountMinor: '9223372036854775807', idempotencyKey: `2.${token()}`,
    }, session);
    assert.equal(large.statusCode, 200, large.body);
    assert.equal(large.json<SingleAccountResult>().balanceMinor, '-9223372036854685807');
    const replay = await send(restored, 'recordTransaction', expense, session);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), original.json());

    const logout = await send(app, 'logout', {}, session);
    assert.equal(logout.statusCode, 200, logout.body);
    expectError(await send(app, 'recordTransaction', expense, session), 403, 'DEVICE_REVOKED');
  });

  await t.test('A failure after writing the movement rolls back the command and permits a retry', async () => {
    const { userId, accountId, session, expense } = await fixture();
    // Force the version increment to fail after the movement insert.
    await db.execute(sql`UPDATE accounts SET version = 4294967295 WHERE id = ${accountId}`);
    expectError(await send(app, 'recordTransaction', expense, session), 500, 'INTERNAL_ERROR');
    assert.deepEqual(await one(reader.db, sql`SELECT version, CAST(opening_balance_minor AS CHAR) AS balance
      FROM accounts WHERE id = ${accountId}`), { version: 4294967295, balance: '100000' });
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM transactions WHERE user_id = ${userId}`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT transaction_id FROM movements WHERE account_id = ${accountId}`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT id FROM audit_events WHERE user_id = ${userId} AND event = 'expense.recorded'`), []);
    assert.deepEqual(await rows(reader.db, sql`SELECT command_key FROM idempotency_keys WHERE actor_id = ${userId}`), []);

    await db.execute(sql`UPDATE accounts SET version = 1 WHERE id = ${accountId}`);
    const retry = await send(app, 'recordTransaction', expense, session);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json<SingleAccountResult>().balanceMinor, '90000');
  });
});
