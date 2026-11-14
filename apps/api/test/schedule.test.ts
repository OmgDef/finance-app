import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { nextLocalDayStart } from '../src/calendar.ts';
import type { Frequency, RuleVersion } from '../src/calendar.ts';
import { connect, rows } from '../src/db.ts';
import { readScheduleDates } from '../src/schedule.ts';

test('Calendar calculation from MySQL rules and time zone history', async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL to a dedicated, migrated synthetic database');
  const { db, pool } = connect(databaseUrl);
  t.after(() => pool.end());

  async function account(timeZone?: string) {
    const userId = randomUUID();
    const accountId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${userId + '@example.test'})`);
    await db.execute(sql`INSERT INTO accounts (id, user_id, name, currency, start_date, opening_balance_minor)
      VALUES (${accountId}, ${userId}, 'Calendar account', 'EUR', '2000-01-01', 0)`);
    if (timeZone) await zone(userId, timeZone, 0);
    return { userId, accountId };
  }

  async function zone(userId: string, timeZone: string, effectiveAt: number) {
    await db.execute(sql`INSERT INTO user_time_zone_versions (user_id, effective_at, time_zone)
      VALUES (${userId}, ${effectiveAt}, ${timeZone})`);
  }

  async function version(ruleId: string, index: number, acceptedAt: number, effectiveAt: number,
    changes: RuleVersion['changes'],
  ) {
    await db.execute(sql`INSERT INTO schedule_rule_versions
      (rule_id, version, accepted_at, effective_at, amount_minor, category_id, sets_comment, comment, sets_end_date, end_date, state)
      VALUES (${ruleId}, ${index}, ${acceptedAt}, ${effectiveAt}, ${changes.amountMinor ?? null}, ${changes.categoryId ?? null},
        ${'comment' in changes}, ${changes.comment ?? null}, ${'endDate' in changes}, ${changes.endDate ?? null}, ${changes.state ?? null})`);
  }

  async function rule(owner: Awaited<ReturnType<typeof account>>, frequency: Frequency, firstDate: string,
    options: { createdAt?: number; startsAt?: number; endsBeforeDate?: string; endDate?: string } = {},
  ) {
    const id = randomUUID();
    const createdAt = options.createdAt ?? Date.parse('2027-01-01T00:00:00Z');
    await db.execute(sql`INSERT INTO schedule_rules (id, account_id, kind, frequency, first_date, created_at, starts_at, ends_before_date)
      VALUES (${id}, ${owner.accountId}, 'expense', ${frequency}, ${firstDate}, ${createdAt}, ${options.startsAt ?? null}, ${options.endsBeforeDate ?? null})`);
    await version(id, 1, createdAt, createdAt, { amountMinor: '9007199254740993', categoryId: 'groceries',
      comment: 'По выписке', endDate: options.endDate ?? null });
    return id;
  }

  async function dates(userId: string, ruleId: string, fromDate: string, throughDate: string, asOf: string) {
    const result = await readScheduleDates(db, userId, ruleId, { fromDate, throughDate, asOf: Date.parse(asOf) });
    assert.ok(result);
    return result;
  }

  await t.test('One-time rule uses the creation instant for today and has no later dates', async () => {
    const { userId, accountId } = await account('Asia/Makassar');
    const createdAt = Date.parse('2027-02-01T04:00:00Z');
    const id = await rule({ userId, accountId }, 'once', '2027-02-01', { createdAt });
    const window = { fromDate: '2027-02-01', throughDate: '2027-02-28', asOf: createdAt };
    assert.equal(await readScheduleDates(db, randomUUID(), id, window), undefined);
    assert.equal(await readScheduleDates(db, userId, id, { ...window, asOf: createdAt - 1 }), undefined);
    assert.deepEqual(await readScheduleDates(db, userId, id, window), [{
      ruleId: id, accountId, kind: 'expense', date: '2027-02-01', dueAt: createdAt, ruleVersion: 1,
      amountMinor: '9007199254740993', categoryId: 'groceries', comment: 'По выписке', status: 'due',
    }]);
    assert.deepEqual(await dates(userId, id, '2027-02-02', '2027-02-28', '2027-02-02T00:00:00Z'), []);
  });

  await t.test('Weekly and monthly dates retain their anchor and include the final date', async () => {
    const owner = await account('UTC');
    const weekly = await rule(owner, 'weekly', '2027-02-01', { endDate: '2027-02-15' });
    assert.deepEqual((await dates(owner.userId, weekly, '2027-02-02', '2027-03-01', '2027-02-08T00:00:00Z'))
      .map(({ date, status }) => [date, status]), [['2027-02-08', 'due'], ['2027-02-15', 'planned']]);

    for (const [year, february] of [[2027, '28'], [2028, '29']]) {
      const monthly = await rule(owner, 'monthly', `${year}-01-31`, { endDate: `${year}-04-30` });
      assert.deepEqual((await dates(owner.userId, monthly, `${year}-01-01`, `${year}-05-31`, `${year}-01-01T00:00:00Z`))
        .map(({ date }) => date), [`${year}-01-31`, `${year}-02-${february}`, `${year}-03-31`, `${year}-04-30`]);
    }
  });

  await t.test('A zone change keeps a date that already arrived, including equality, and moves later dates', async () => {
    const owner = await account('Asia/Makassar');
    const id = await rule(owner, 'weekly', '2027-02-01');
    const changeAt = Date.parse('2027-01-31T16:00:00Z');
    await zone(owner.userId, 'Europe/Moscow', changeAt);
    const before = await dates(owner.userId, id, '2027-02-01', '2027-02-08', '2027-01-31T15:59:59Z');
    const after = await dates(owner.userId, id, '2027-02-01', '2027-02-08', '2027-02-01T00:00:00Z');
    assert.deepEqual(before.map(({ dueAt, status }) => [dueAt, status]), [
      [changeAt, 'planned'], [Date.parse('2027-02-07T16:00:00Z'), 'planned'],
    ]);
    assert.deepEqual(after.map(({ date, dueAt, status }) => [date, new Date(dueAt).toISOString(), status]), [
      ['2027-02-01', '2027-01-31T16:00:00.000Z', 'due'], ['2027-02-08', '2027-02-07T21:00:00.000Z', 'planned'],
    ]);
  });

  await t.test('An earlier zone takes effect at the change instant and a replacement retains its UTC boundary', async () => {
    const owner = await account('Europe/Moscow');
    const changeAt = Date.parse('2027-02-01T17:00:00Z');
    const startsAt = Date.parse('2027-02-01T21:00:00Z');
    await zone(owner.userId, 'Asia/Makassar', changeAt);
    const original = await rule(owner, 'weekly', '2027-01-26', { endsBeforeDate: '2027-02-02' });
    const ordinary = await rule(owner, 'once', '2027-02-02');
    const replacement = await rule(owner, 'weekly', '2027-02-02', { createdAt: Date.parse('2027-02-01T10:00:00Z'), startsAt });
    assert.deepEqual(await dates(owner.userId, original, '2027-02-02', '2027-02-09', '2027-02-01T18:00:00Z'), []);
    const [first] = await dates(owner.userId, ordinary, '2027-02-02', '2027-02-02', '2027-02-01T18:00:00Z');
    assert.deepEqual([first.date, first.dueAt, first.status], ['2027-02-02', changeAt, 'due']);
    const [pending] = await dates(owner.userId, replacement, '2027-02-02', '2027-02-02', '2027-02-01T20:59:59Z');
    const [due] = await dates(owner.userId, replacement, '2027-02-02', '2027-02-02', '2027-02-01T21:00:00Z');
    assert.deepEqual([pending.dueAt, pending.status, due.dueAt, due.status], [startsAt, 'planned', startsAt, 'due']);
  });

  await t.test('The start of a skipped midnight or missing local day uses the first valid instant', async () => {
    for (const [timeZone, date, created, expected] of [
      ['America/Sao_Paulo', '2018-11-04', '2018-11-01T00:00:00Z', '2018-11-04T03:00:00Z'],
      ['Pacific/Apia', '2011-12-30', '2011-12-28T00:00:00Z', '2011-12-30T10:00:00Z'],
    ]) {
      const owner = await account(timeZone);
      const id = await rule(owner, 'once', date, { createdAt: Date.parse(created) });
      const [entry] = await dates(owner.userId, id, date, date, expected);
      assert.deepEqual([entry.date, entry.dueAt, entry.status], [date, Date.parse(expected), 'due']);
    }
    assert.equal(nextLocalDayStart(Date.parse('2011-12-29T20:00:00Z'), 'Pacific/Apia'), Date.parse('2011-12-30T10:00:00Z'));
  });

  await t.test('Accepted edits apply by version at their saved UTC boundaries without resetting the cadence', async () => {
    const owner = await account('Asia/Makassar');
    const id = await rule(owner, 'weekly', '2027-02-01');
    const feb8 = Date.parse('2027-02-07T16:00:00Z');
    const feb15 = Date.parse('2027-02-14T16:00:00Z');
    const feb22 = Date.parse('2027-02-21T16:00:00Z');
    await version(id, 2, feb8 - 4000, feb8, { amountMinor: '2000' });
    await version(id, 3, feb8 - 3000, feb8, { state: 'paused' });
    await version(id, 4, feb8 - 2000, feb8, { amountMinor: '3000', comment: null });
    await version(id, 5, feb15 - 1000, feb15, { state: 'active' });
    await version(id, 6, feb22 - 1000, feb22, { state: 'ended' });
    const result = await dates(owner.userId, id, '2027-02-01', '2027-03-01', '2027-02-25T00:00:00Z');
    assert.deepEqual(result.map(({ date, ruleVersion, amountMinor, comment, status }) => [date, ruleVersion, amountMinor, comment, status]), [
      ['2027-02-01', 1, '9007199254740993', 'По выписке', 'due'],
      ['2027-02-08', 4, '3000', null, 'paused'], ['2027-02-15', 5, '3000', null, 'due'],
    ]);
    const beforeEdits = await dates(owner.userId, id, '2027-02-08', '2027-02-08', '2027-02-01T00:00:00Z');
    assert.equal(beforeEdits[0].ruleVersion, 1);
    assert.deepEqual(await rows(db, sql`SELECT id FROM transactions WHERE user_id = ${owner.userId}`), []);
  });

  await t.test('Rule edits are applied in acceptance order even when their UTC boundaries are reversed', async () => {
    const owner = await account('Europe/Moscow');
    const id = await rule(owner, 'weekly', '2027-02-01');
    const acceptedInMoscow = Date.parse('2027-02-07T12:00:00Z');
    const changedZone = Date.parse('2027-02-07T13:00:00Z');
    const acceptedInMakassar = Date.parse('2027-02-07T14:00:00Z');
    const earlierBoundary = Date.parse('2027-02-07T16:00:00Z');
    const laterBoundary = Date.parse('2027-02-07T21:00:00Z');
    await zone(owner.userId, 'Asia/Makassar', changedZone);
    await version(id, 2, acceptedInMoscow, laterBoundary, { amountMinor: '2000', state: 'paused' });
    await version(id, 3, acceptedInMakassar, earlierBoundary, { amountMinor: '3000' });

    const result = await dates(owner.userId, id, '2027-02-01', '2027-02-15', '2027-02-15T00:00:00Z');
    assert.deepEqual(result.map(({ date, dueAt, ruleVersion, amountMinor, status }) => [date, dueAt, ruleVersion, amountMinor, status]), [
      ['2027-02-01', Date.parse('2027-01-31T21:00:00Z'), 1, '9007199254740993', 'due'],
      ['2027-02-08', earlierBoundary, 3, '3000', 'due'],
      ['2027-02-15', Date.parse('2027-02-14T16:00:00Z'), 3, '3000', 'paused'],
    ]);
  });
});
