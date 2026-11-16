import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { routes } from '@teta/contracts';
import type { Body, Result, Route } from '@teta/contracts';
import { buildApp } from '../src/app.ts';
import { configFromEnv } from '../src/config.ts';
import { token, verifier } from '../src/crypto.ts';
import { connect, one, rows } from '../src/db.ts';
import { processScheduleDate, recordScheduleDateFailure } from '../src/finance.ts';
import { runScheduleWorkerPass } from '../src/schedule-worker.ts';

const databaseUrl = process.env.TEST_WORKER_DATABASE_URL;
test('Schedule worker with isolated MySQL', {
  skip: databaseUrl ? false : 'Set TEST_WORKER_DATABASE_URL to a separate, migrated synthetic schema',
}, async (t) => {
  assert.ok(databaseUrl);
  const apiUrl = process.env.TEST_DATABASE_URL;
  if (apiUrl) {
    const apiDatabase = new URL(apiUrl);
    const workerDatabase = new URL(databaseUrl);
    assert.notEqual(workerDatabase.pathname, apiDatabase.pathname, 'Worker fixtures require a separate schema');
  }
  const { db, pool } = connect(databaseUrl, 4);
  const config = configFromEnv({
    DATABASE_URL: databaseUrl, API_ORIGIN: 'https://192.0.2.2:18443', ADMIN_ORIGIN: 'https://192.0.2.2:18444',
    ACCESS_KEY: token(), TOTP_KEY: token(), PROXY_IP: '192.0.2.1',
  });
  const baseline = Date.parse('2027-02-01T04:00:00Z');
  let now = baseline;
  const clock = () => now;
  const app = buildApp(config, db, clock);
  t.after(async () => { await app.close(); await pool.end(); });
  const existing = await one<{ count: number }>(db, sql`SELECT COUNT(*) AS count FROM schedule_rules`);
  assert.equal(existing?.count, 0, 'Start with a migrated synthetic worker schema without rules');
  const owners = new Set<string>();
  t.afterEach(async () => {
    await db.execute(sql`DELETE FROM schedule_worker_state WHERE id = 1`);
    for (const userId of owners) {
      const owned = sql`SELECT id FROM accounts WHERE user_id = ${userId}`;
      const rules = sql`SELECT id FROM schedule_rules WHERE account_id IN (${owned})`;
      const transactions = sql`SELECT id FROM transactions WHERE user_id = ${userId}`;
      await db.execute(sql`DELETE FROM schedule_date_failures WHERE rule_id IN (${rules})`);
      await db.execute(sql`UPDATE schedule_occurrences SET source_occurrence_id = NULL WHERE rule_id IN (${rules})`);
      await db.execute(sql`DELETE FROM schedule_occurrences WHERE rule_id IN (${rules})`);
      await db.execute(sql`UPDATE schedule_rules SET replaces_rule_id = NULL WHERE account_id IN (${owned})`);
      await db.execute(sql`DELETE FROM schedule_rule_versions WHERE rule_id IN (${rules})`);
      await db.execute(sql`DELETE FROM schedule_rules WHERE account_id IN (${owned})`);
      await db.execute(sql`DELETE FROM balance_adjustments WHERE account_id IN (${owned})`);
      await db.execute(sql`DELETE FROM movements WHERE transaction_id IN (${transactions})`);
      await db.execute(sql`DELETE FROM transaction_versions WHERE transaction_id IN (${transactions})`);
      await db.execute(sql`DELETE FROM transactions WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM accounts WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM sessions WHERE device_id IN (SELECT id FROM devices WHERE user_id = ${userId})`);
      await db.execute(sql`DELETE FROM devices WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM user_time_zone_versions WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM idempotency_keys WHERE actor_id = ${userId}`);
      await db.execute(sql`DELETE FROM audit_events WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    }
    owners.clear();
    now = baseline;
  });

  async function fixture(options: { firstDate?: string; frequency?: 'once' | 'weekly'; kind?: 'expense' | 'income';
    categoryId?: string; blocked?: boolean } = {}) {
    const { firstDate = '2027-02-01', frequency = 'once', kind = 'expense', categoryId = 'groceries', blocked = false } = options;
    const userId = randomUUID();
    const accountId = randomUUID();
    const ruleId = randomUUID();
    const deviceId = randomUUID();
    const session = token();
    const createdAt = Date.parse('2026-01-01T00:00:00Z');
    await db.execute(sql`INSERT INTO users (id, email, status)
      VALUES (${userId}, ${userId + '@example.test'}, ${blocked ? 'blocked' : 'active'})`);
    owners.add(userId);
    await db.execute(sql`INSERT INTO devices (id, user_id, verifier, pin_hash) VALUES (${deviceId}, ${userId}, ${token()}, 'unused')`);
    await db.execute(sql`INSERT INTO sessions (verifier, device_id, expires_at)
      VALUES (${verifier(config.accessKey, 'mobile-session', session)}, ${deviceId}, ${baseline + 31 * 86_400_000})`);
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${accountId}, ${userId}, 'Test account', 'EUR', '2026-01-01', 0)`);
    await db.execute(sql`INSERT INTO schedule_rules (id, account_id, kind, frequency, first_date, created_at)
      VALUES (${ruleId}, ${accountId}, ${kind}, ${frequency}, ${firstDate}, ${createdAt})`);
    await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, amount_minor, category_id)
      VALUES (${ruleId}, 1, ${createdAt}, ${createdAt}, 1000, ${categoryId})`);
    return { userId, accountId, ruleId, date: firstDate, session };
  }

  async function occurrences(ruleId: string, session: string) {
    const query = new URLSearchParams({ ruleId, fromDate: '2027-02-01', throughDate: '2027-02-28' });
    const response = await app.inject({ method: 'GET', url: `${routes.listScheduleOccurrences.url}?${query}`,
      remoteAddress: '192.0.2.1', headers: { host: new URL(config.apiOrigin).host, 'x-forwarded-proto': 'https',
        authorization: 'Bearer ' + session } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Result<'listScheduleOccurrences'>>().occurrences;
  }

  function request<K extends Route>(route: K, session: string, path?: string, body?: Body<K>) {
    return app.inject({ method: routes[route].method, url: path ?? routes[route].url, payload: body,
      remoteAddress: '192.0.2.1', headers: { host: new URL(config.apiOrigin).host, 'x-forwarded-proto': 'https',
        authorization: 'Bearer ' + session } });
  }

  async function replaceForWorker(timeZone: string, earlySkip: boolean) {
    const source = await fixture({ frequency: 'weekly' });
    const target = randomUUID();
    const { userId, accountId, ruleId, session } = source;
    await db.execute(sql`UPDATE accounts SET opening_balance_minor = 100000 WHERE id = ${accountId}`);
    await db.execute(sql`UPDATE schedule_rule_versions SET amount_minor = 10000 WHERE rule_id = ${ruleId}`);
    await db.execute(sql`INSERT INTO user_time_zone_versions (user_id, effective_at, time_zone) VALUES (${userId}, 0, ${timeZone})`);
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${target}, ${userId}, 'New account', 'EUR', '2027-01-01', 50000)`);

    let adjustmentId: string | undefined;
    if (earlySkip) {
      now = Date.parse('2027-01-31T04:00:00Z');
      const query = '?fromDate=2027-02-08&throughDate=2027-02-08';
      const read = await request('previewBalanceAdjustment', session,
        routes.previewBalanceAdjustment.url.replace(':accountId', accountId) + query);
      assert.equal(read.statusCode, 200, read.body);
      const { accountVersion, dates } = read.json<Result<'previewBalanceAdjustment'>>();
      const { status, ...selection } = dates[0];
      assert.equal(status, 'planned');
      const reconciled = await request('reconcileAccountBalance', session,
        routes.reconcileAccountBalance.url.replace(':accountId', accountId), {
          idempotencyKey: `${config.recoveryVersion}.${token()}`, expectedAccountVersion: accountVersion, actualBalanceMinor: '90000',
          explanation: 'Statement balance', skippedDates: [{ ...selection, reason: 'Early bank debit' }],
        });
      assert.equal(reconciled.statusCode, 200, reconciled.body);
      adjustmentId = reconciled.json<Result<'reconcileAccountBalance'>>().adjustmentId;
    }
    now = Date.parse('2027-02-01T10:00:00Z');
    const path = routes.replaceScheduleRule.url.replace(':ruleId', ruleId);
    const read = await request('previewScheduleRuleReplacement', session, path + '/preview?accountId=' + target);
    assert.equal(read.statusCode, 200, read.body);
    const preview = read.json<Result<'previewScheduleRuleReplacement'>>();
    const response = await request('replaceScheduleRule', session, path, {
      accountId: target, kind: 'expense', amountMinor: '7000', categoryId: 'groceries', frequency: 'weekly',
      firstDate: '2027-02-02', endDate: '2027-02-16', idempotencyKey: `${config.recoveryVersion}.${token()}`,
      expectedRuleVersion: preview.ruleVersion, previewToken: preview.previewToken,
      decisions: preview.skippedDates.map(({ date }) => ({ sourceDate: date, targetDate: '2027-02-09' })),
    });
    assert.equal(response.statusCode, 200, response.body);
    return { ...source, target, adjustmentId, preview, replaced: response.json<Result<'replaceScheduleRule'>>() };
  }

  async function balance(accountId: string, session: string) {
    const result = await request('getAccountBalance', session, routes.getAccountBalance.url.replace(':accountId', accountId));
    assert.equal(result.statusCode, 200, result.body);
    return result.json<Result<'getAccountBalance'>>().balanceMinor;
  }

  await t.test('new backdated rules post original financial dates once and respect the inclusive end date', async () => {
    const { userId, accountId, session } = await fixture({ firstDate: '2027-03-01' });
    const monthly = await request('createScheduleRule', session, undefined, {
      accountId, kind: 'expense', categoryId: 'groceries', amountMinor: '1000',
      frequency: 'monthly', firstDate: '2026-11-30', endDate: '2027-01-30',
    });
    assert.equal(monthly.statusCode, 200, monthly.body);
    const once = await request('createScheduleRule', session, undefined, {
      accountId, kind: 'income', categoryId: 'salary', amountMinor: '5000',
      frequency: 'once', firstDate: '2026-01-01',
    });
    assert.equal(once.statusCode, 200, once.body);
    const ruleIds = [monthly, once].map((result) => result.json<Result<'createScheduleRule'>>().ruleId);
    const query = '?accountId=' + accountId + '&fromDate=2026-11-30&throughDate=2027-02-28';
    const scheduled = await request('listScheduleOccurrences', session, routes.listScheduleOccurrences.url + query);
    assert.equal(scheduled.statusCode, 200, scheduled.body);
    assert.deepEqual(scheduled.json<Result<'listScheduleOccurrences'>>().occurrences.map(({ date, dueAt, status }) =>
      [date, dueAt, status]), ['2026-11-30', '2026-12-30', '2027-01-30'].map((date) => [date, now, 'due']));
    assert.equal(await balance(accountId, session), '0');

    assert.equal((await runScheduleWorkerPass(pool, clock))?.posted, 4);
    assert.equal((await runScheduleWorkerPass(pool, clock))?.attemptedDates, 0);
    assert.equal(await balance(accountId, session), '2000');
    assert.deepEqual(await rows(db, sql`
      SELECT o.scheduled_date AS scheduledDate, v.financial_date AS financialDate
      FROM schedule_occurrences o JOIN transaction_versions v ON v.transaction_id = o.transaction_id
      WHERE o.rule_id IN (${ruleIds[0]}, ${ruleIds[1]}) ORDER BY o.scheduled_date`),
    ['2026-01-01', '2026-11-30', '2026-12-30', '2027-01-30'].map((date) => ({ scheduledDate: date, financialDate: date })));
    assert.equal((await one<{ count: number }>(db, sql`SELECT COUNT(*) AS count FROM transactions WHERE user_id = ${userId}`))?.count, 4);
  });

  await t.test('catch-up is bounded per rule and a concurrent pass leaves the same outcomes', async () => {
    const long = await fixture({ firstDate: '2026-01-05', frequency: 'weekly', blocked: true });
    const once = await fixture();
    let running: ReturnType<typeof runScheduleWorkerPass> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id IN (${long.userId}, ${once.userId}) FOR UPDATE`);
      running = runScheduleWorkerPass(pool, clock);
      let held = false;
      for (let attempt = 0; !held && attempt < 50; attempt++) {
        const lock = await one<{ held: number | null }>(tx, sql`
          SELECT IS_USED_LOCK(SHA2(CONCAT('tetafinance:worker:', DATABASE()), 256)) AS held`);
        held = lock?.held != null;
        if (!held) await setTimeout(10);
      }
      assert.equal(held, true);
      assert.equal(await runScheduleWorkerPass(pool, clock), undefined);
    });
    const report = await running;
    assert.equal(report?.posted, 9);
    assert.equal(report?.scanComplete, true);
    assert.equal(report?.oldestDueLagMs, now - Date.parse('2026-03-02T00:00:00Z'));
    assert.equal((await runScheduleWorkerPass(pool, clock))?.posted, 8);
    assert.equal((await one<{ count: number }>(db, sql`SELECT COUNT(*) AS count FROM schedule_occurrences
      WHERE rule_id = ${once.ruleId}`))?.count, 1);
    assert.equal((await one<{ count: number }>(db, sql`SELECT COUNT(*) AS count FROM schedule_occurrences
      WHERE rule_id = ${long.ruleId}`))?.count, 16);
    assert.equal((await one<{ lastSuccess: number }>(db, sql`SELECT last_success_at AS lastSuccess FROM schedule_worker_state`))
      ?.lastSuccess, now);
  });

  await t.test('data error requires immediate intervention while another rule is posted', async () => {
    const failed = await fixture({ kind: 'income' }); // An expense category on an income rule is invalid ledger data.
    const valid = await fixture();
    const report = await runScheduleWorkerPass(pool, clock);
    assert.equal(report?.posted, 1);
    assert.equal(report?.interventions, 1);
    const [failedDate] = await occurrences(failed.ruleId, failed.session);
    assert.equal(failedDate.status, 'needs_intervention');
    assert.equal(failedDate.errorCode, 'SCHEDULE_DATA_INVALID');
    assert.equal(failedDate.attempts, 1);
    assert.equal(failedDate.nextAttemptAt, undefined);
    assert.equal((await occurrences(valid.ruleId, valid.session))[0].status, 'posted');
    assert.equal((await runScheduleWorkerPass(pool, clock))?.attemptedDates, 0);
  });

  await t.test('incomplete calendar is counted without stopping the valid dates or advancing the successful heartbeat', async () => {
    const malformed = await fixture();
    const valid = await fixture();
    await db.execute(sql`DELETE FROM schedule_rule_versions WHERE rule_id = ${malformed.ruleId}`);
    const report = await runScheduleWorkerPass(pool, clock);
    assert.equal(report?.invalidCalendars, 1);
    assert.equal(report?.posted, 1);
    assert.equal(report?.successful, false);
    assert.equal((await one<{ lastSuccess: number }>(db, sql`SELECT last_success_at AS lastSuccess FROM schedule_worker_state`))
      ?.lastSuccess, 0);
    assert.equal((await occurrences(valid.ruleId, valid.session))[0].status, 'posted');
  });

  await t.test('temporary errors survive fresh passes and the fifth failure stops automatic retries', async () => {
    const failed = await fixture();
    await db.transaction(async (tx) => {
      // The posting times out checking the category foreign key. Failure recording does not need that row.
      await tx.execute(sql`SELECT id FROM categories WHERE id = 'groceries' FOR UPDATE`);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const report = await runScheduleWorkerPass(pool, clock);
        assert.equal(report?.attemptedDates, 1);
        assert.equal(report?.posted, 0);
        assert.equal(report?.interventions, attempt === 5 ? 1 : 0);
        const [date] = await occurrences(failed.ruleId, failed.session);
        assert.equal(date.attempts, attempt);
        assert.equal(date.errorCode, 'TEMPORARY_FAILURE');
        assert.equal(date.status, attempt === 5 ? 'needs_intervention' : 'retrying');
        assert.equal((await runScheduleWorkerPass(pool, clock))?.attemptedDates, 0);
        if (attempt < 5) {
          assert.equal(date.nextAttemptAt, now + 60_000 * 2 ** (attempt - 1));
          now = date.nextAttemptAt!;
        }
      }
      assert.deepEqual(await rows(db, sql`SELECT id FROM transactions WHERE user_id = ${failed.userId}`), []);
      assert.equal((await one<{ position: string | null }>(db,
        sql`SELECT processed_through AS position FROM schedule_rules WHERE id = ${failed.ruleId}`))?.position, null);
    });
    assert.equal((await runScheduleWorkerPass(pool, clock))?.attemptedDates, 0);
  });

  await t.test('stale errors cannot reopen a posted date', async () => {
    const candidate = await fixture();
    await recordScheduleDateFailure(db, candidate, 'TEMPORARY_FAILURE', 0, clock);
    now += 60_000;
    assert.equal((await runScheduleWorkerPass(pool, clock))?.posted, 1);
    assert.equal(await recordScheduleDateFailure(db, candidate, 'SCHEDULE_DATA_INVALID', 1, clock), undefined);
    assert.deepEqual(await rows(db, sql`SELECT attempts FROM schedule_date_failures WHERE rule_id = ${candidate.ruleId}`), []);
    assert.equal((await occurrences(candidate.ruleId, candidate.session))[0].status, 'posted');
  });

  await t.test('ЗП-01/06. Worker catch-up preserves both series and restarts after a failure before and after commit', async () => {
    const f = await replaceForWorker('Asia/Makassar', true);
    const successor = f.replaced.replacementRule.ruleId;
    const boundary = Date.parse('2027-02-01T16:00:00Z');
    assert.equal(f.replaced.transitionDate, '2027-02-02');
    assert.equal(f.replaced.transitionAt, boundary);
    assert.deepEqual(f.replaced.replacementRule.replaces, { ruleId: f.ruleId, transitionDate: '2027-02-02', transitionAt: boundary });
    const read = await request('getScheduleRule', f.session, routes.getScheduleRule.url.replace(':ruleId', f.ruleId));
    const original = read.json<Result<'getScheduleRule'>>();
    assert.equal(original.state, 'ended');
    assert.equal(original.ruleVersion, 2);
    assert.deepEqual(original.replacedBy, { ruleId: successor, transitionDate: '2027-02-02', transitionAt: boundary });
    assert.equal((await one<{ position: string | null }>(db,
      sql`SELECT processed_through AS position FROM schedule_rules WHERE id = ${successor}`))?.position, null);

    const candidate = { userId: f.userId, accountId: f.target, ruleId: successor, date: '2027-02-02' };
    now = boundary;
    // The account version write follows the journal and movement inserts inside the posting transaction.
    await db.execute(sql`UPDATE accounts SET version = 4294967295 WHERE id = ${f.target}`);
    await assert.rejects(processScheduleDate(db, candidate, clock));
    assert.equal(await balance(f.target, f.session), '50000');
    assert.equal((await occurrences(successor, f.session))[0].status, 'due');
    assert.equal((await one<{ position: string | null }>(db,
      sql`SELECT processed_through AS position FROM schedule_rules WHERE id = ${successor}`))?.position, null);
    await db.execute(sql`UPDATE accounts SET version = 1 WHERE id = ${f.target}`);

    // Discard the result of a successful transaction to model a worker stopping before receiving it.
    await processScheduleDate(db, candidate, clock);
    assert.equal(await balance(f.target, f.session), '43000');
    now = Date.parse('2027-02-15T16:00:00Z');
    const pass = await runScheduleWorkerPass(pool, clock);
    assert.deepEqual([pass?.posted, pass?.skipped, pass?.successful], [2, 1, true]);
    assert.equal((await runScheduleWorkerPass(pool, clock))?.attemptedDates, 0);
    assert.equal(await balance(f.accountId, f.session), '80000');
    assert.equal(await balance(f.target, f.session), '36000');
    const oldDates = await occurrences(f.ruleId, f.session);
    assert.deepEqual(oldDates.map(({ date, status, adjustmentId }) => [date, status, adjustmentId]), [
      ['2027-02-01', 'posted', undefined],
      ['2027-02-08', 'skipped', f.adjustmentId],
    ]);
    const newDates = await occurrences(successor, f.session);
    assert.deepEqual(newDates.map(({ date, status, adjustmentId, sourceOccurrenceId }) => [date, status, adjustmentId, sourceOccurrenceId]), [
      ['2027-02-02', 'posted', undefined, undefined],
      ['2027-02-09', 'skipped', f.adjustmentId, f.preview.skippedDates[0].occurrenceId],
      ['2027-02-16', 'posted', undefined, undefined],
    ]);
    assert.equal((await one<{ position: string | null }>(db,
      sql`SELECT processed_through AS position FROM schedule_rules WHERE id = ${successor}`))?.position, '2027-02-16');
    assert.deepEqual(await rows(db, sql`SELECT a.id AS accountId, CAST(v.financial_date AS CHAR) AS date
      FROM transaction_versions v JOIN transactions t ON t.id = v.transaction_id
      JOIN movements m ON m.transaction_id = t.id AND m.transaction_version = v.version
      JOIN accounts a ON a.id = m.account_id WHERE t.user_id = ${f.userId} ORDER BY v.financial_date`),
    [{ accountId: f.accountId, date: '2027-02-01' }, { accountId: f.target, date: '2027-02-02' }, { accountId: f.target, date: '2027-02-16' }]);
    assert.equal((await rows(db, sql`SELECT id FROM audit_events WHERE object_id = ${f.ruleId} AND event = 'schedule.rule.replaced'`)).length, 1);
  });

  await t.test('ЗП-08. Moving to a zone where the day has begun cannot advance the new series before the saved UTC boundary', async () => {
    const f = await replaceForWorker('Europe/Moscow', false);
    assert.equal(f.replaced.transitionAt, Date.parse('2027-02-01T21:00:00Z'));
    now = Date.parse('2027-02-01T17:00:00Z');
    const changed = await request('setTimeZone', f.session, undefined, { timeZone: 'Asia/Makassar' });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json<Result<'setTimeZone'>>().today, '2027-02-02');
    now = f.replaced.transitionAt - 1000;
    assert.equal((await runScheduleWorkerPass(pool, clock))?.posted, 1);
    assert.equal(await balance(f.target, f.session), '50000');
    now = f.replaced.transitionAt;
    assert.equal((await runScheduleWorkerPass(pool, clock))?.posted, 1);
    assert.equal(await balance(f.target, f.session), '43000');
    const [date] = await occurrences(f.replaced.replacementRule.ruleId, f.session);
    assert.deepEqual([date.date, date.dueAt, date.status], ['2027-02-02', f.replaced.transitionAt, 'posted']);
    assert.equal((await runScheduleWorkerPass(pool, clock))?.attemptedDates, 0);
  });
});
