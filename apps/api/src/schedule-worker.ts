import { drizzle } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import type { Pool } from 'mysql2/promise';
import { hasDatabaseError, one } from './db.ts';
import type { Db } from './db.ts';
import { AccessError } from './errors.ts';
import { processScheduleDate, recordScheduleDateFailure } from './finance.ts';
import { nextDueScheduleDate, readScheduleRuleForWorker, scanScheduleRules } from './schedule.ts';
import type { ScheduleCandidate, ScheduleFailureCode } from './schedule.ts';

const workerLock = sql`SHA2(CONCAT('tetafinance:worker:', DATABASE()), 256)`;
const rulePageSize = 64;
const rulesPerPass = 256;
const datesPerPass = 128;
const datesPerRule = 8;
const passBudgetMs = 45_000;

type WorkerState = { lastRuleId: string | null; scanOldestDueAt: number | null };
type Calendar = Awaited<ReturnType<typeof scanScheduleRules>>[number];
type PassCounts = {
  scannedRules: number; attemptedDates: number; posted: number; skipped: number;
  retriesScheduled: number; interventions: number; invalidCalendars: number; deferredFailures: number;
};

function postingErrorCode(error: unknown): ScheduleFailureCode {
  if ((error instanceof AccessError && (error.code === 'INVALID_REQUEST' || error.code === 'ACCOUNT_UNAVAILABLE')) ||
      hasDatabaseError(error, 'ER_WARN_DATA_OUT_OF_RANGE', 'ER_DATA_TOO_LONG', 'ER_NO_REFERENCED_ROW_2',
        'ER_CHECK_CONSTRAINT_VIOLATED', 'ER_TRUNCATED_WRONG_VALUE', 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD')) {
    return 'SCHEDULE_DATA_INVALID';
  }
  return 'TEMPORARY_FAILURE';
}

function earliest(a: number | null, b: number | null) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

async function processRule(db: Db, first: Calendar, counts: PassCounts, clock: () => number,
  shouldStop: () => boolean,
) {
  const { userId, rule: { id: ruleId, accountId } } = first;
  const identity = { userId, ruleId, accountId };
  let calendar: Calendar | undefined = first;
  for (let step = 0; calendar; step++) {
    const now = clock();
    let date;
    try {
      date = nextDueScheduleDate(calendar, now);
    } catch {
      // Without a valid date there is no occurrence to flag. Continue scanning the other rules.
      counts.invalidCalendars++;
      return null;
    }
    if (!date) return null;
    if (step >= datesPerRule || counts.attemptedDates >= datesPerPass || shouldStop()) return date.dueAt;
    const candidate: ScheduleCandidate = { ...identity, date: date.date };
    const failure = await one<{ attempts: number; nextAttemptAt: number | null }>(db, sql`
      SELECT f.attempts, f.next_attempt_at AS nextAttemptAt FROM schedule_date_failures f
      WHERE f.rule_id = ${ruleId} AND f.scheduled_date = ${date.date} AND NOT EXISTS (
        SELECT 1 FROM schedule_occurrences o WHERE o.rule_id = f.rule_id AND o.scheduled_date = f.scheduled_date
      )`);
    if (failure && (failure.nextAttemptAt === null || failure.nextAttemptAt > now)) return date.dueAt;
    counts.attemptedDates++;
    try {
      const outcome = await processScheduleDate(db, candidate, clock);
      if (!outcome) return date.dueAt;
      counts[outcome.status]++;
    } catch (error) {
      try {
        const recorded = await recordScheduleDateFailure(db, candidate, postingErrorCode(error), failure?.attempts ?? 0, clock);
        if (recorded) counts[recorded.nextAttemptAt === null ? 'interventions' : 'retriesScheduled']++;
      } catch (recordError) {
        if (!(recordError instanceof AccessError) || recordError.code !== 'TEMPORARY_FAILURE') throw recordError;
        // The row is still busy. Leave the date in the queue and revisit it on the next scan.
        counts.deferredFailures++;
      }
      return date.dueAt;
    }
    calendar = await readScheduleRuleForWorker(db, identity, clock());
  }
  return null;
}

export async function runScheduleWorkerPass(pool: Pool, clock = Date.now, signal?: AbortSignal) {
  if (signal?.aborted) return;
  const connection = await pool.getConnection();
  const db = drizzle(connection);
  let acquired = false;
  let previousLockWait: number | undefined;
  try {
    const lock = await one<{ acquired: number | null }>(db, sql`SELECT GET_LOCK(${workerLock}, 0) AS acquired`);
    if (lock?.acquired !== 1) return;
    acquired = true;
    const lockWait = await one<{ seconds: number }>(db, sql`SELECT @@session.innodb_lock_wait_timeout AS seconds`);
    previousLockWait = lockWait?.seconds;
    await db.execute(sql`SET SESSION innodb_lock_wait_timeout = 2`);
    const state = await one<WorkerState>(db, sql`
      SELECT last_rule_id AS lastRuleId, scan_oldest_due_at AS scanOldestDueAt FROM schedule_worker_state WHERE id = 1`);
    let lastRuleId = state?.lastRuleId ?? null;
    let oldestDueAt = state?.scanOldestDueAt ?? null;
    let scanComplete = false;
    const counts: PassCounts = {
      scannedRules: 0, attemptedDates: 0, posted: 0, skipped: 0, retriesScheduled: 0, interventions: 0, invalidCalendars: 0,
      deferredFailures: 0,
    };
    // Resume after the last visited rule when the budget is spent, even if that rule is still behind.
    const asOf = clock();
    const deadline = performance.now() + passBudgetMs;
    const shouldStop = () => Boolean(signal?.aborted) || performance.now() >= deadline;
    while (!shouldStop() && counts.scannedRules < rulesPerPass && counts.attemptedDates < datesPerPass) {
      const calendars = await scanScheduleRules(db, lastRuleId, asOf, rulePageSize);
      for (const calendar of calendars) {
        if (shouldStop() || counts.attemptedDates >= datesPerPass) break;
        oldestDueAt = earliest(oldestDueAt, await processRule(db, calendar, counts, clock, shouldStop));
        lastRuleId = calendar.rule.id;
        counts.scannedRules++;
      }
      if (calendars.length < rulePageSize && (calendars.length === 0 || lastRuleId === calendars.at(-1)?.rule.id)) {
        scanComplete = true;
        break;
      }
    }
    if (signal?.aborted) return;
    const checkedAt = clock();
    const lastSuccessAt = counts.invalidCalendars || counts.deferredFailures ? null : checkedAt;
    const savedCursor = scanComplete ? null : lastRuleId;
    const savedOldestDueAt = scanComplete ? null : oldestDueAt;
    await db.execute(sql`INSERT INTO schedule_worker_state (id, last_rule_id, scan_oldest_due_at, last_success_at)
      VALUES (1, ${savedCursor}, ${savedOldestDueAt}, ${lastSuccessAt ?? 0})
      ON DUPLICATE KEY UPDATE last_rule_id = ${savedCursor}, scan_oldest_due_at = ${savedOldestDueAt},
        last_success_at = COALESCE(${lastSuccessAt}, last_success_at)`);
    return { event: 'schedule_worker_pass' as const, checkedAt, scanComplete, successful: lastSuccessAt !== null,
      oldestDueLagMs: oldestDueAt === null ? null : Math.max(0, checkedAt - oldestDueAt), ...counts };
  } finally {
    try {
      if (acquired) await db.execute(sql`SELECT RELEASE_LOCK(${workerLock})`);
      if (previousLockWait !== undefined) await db.execute(sql`SET SESSION innodb_lock_wait_timeout = ${previousLockWait}`);
      connection.release();
    } catch (error) {
      connection.destroy();
      throw error;
    }
  }
}
