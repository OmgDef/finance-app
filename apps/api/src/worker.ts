import { setTimeout } from 'node:timers/promises';
import { connect } from './db.ts';
import { runDepositInterestPass } from './deposit-interest-worker.ts';
import { verifyRecoveryVersion } from './recovery.ts';
import { runScheduleWorkerPass } from './schedule-worker.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Missing DATABASE_URL');
const { db, pool } = connect(databaseUrl, 1);
const stop = new AbortController();
const stopWorker = () => stop.abort();
const minute = 60_000;

process.once('SIGINT', stopWorker);
process.once('SIGTERM', stopWorker);
try {
  await verifyRecoveryVersion(db, process.env.RECOVERY_VERSION ?? '1');
  while (!stop.signal.aborted) {
    const started = performance.now();
    try {
      const report = await runScheduleWorkerPass(pool, Date.now, stop.signal);
      if (report) console.log(JSON.stringify(report));
    } catch {
      // DB errors can include query parameters and connection details.
      console.error(JSON.stringify({ event: 'schedule_worker_pass_failed', checkedAt: Date.now() }));
    }
    if (!stop.signal.aborted) {
      try {
        const { settled, failed } = await runDepositInterestPass(db, Date.now, stop.signal);
        if (settled || failed) console.log(JSON.stringify({ event: 'deposit_interest_pass', settled, failed }));
      } catch {
        console.error(JSON.stringify({ event: 'deposit_interest_pass_failed', checkedAt: Date.now() }));
      }
    }
    if (!stop.signal.aborted) {
      await setTimeout(Math.max(0, minute - (performance.now() - started)), undefined, { signal: stop.signal })
        .catch((error: unknown) => { if (!stop.signal.aborted) throw error; });
    }
  }
} finally {
  process.removeListener('SIGINT', stopWorker);
  process.removeListener('SIGTERM', stopWorker);
  await pool.end();
}
