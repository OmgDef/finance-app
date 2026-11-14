import { readFile } from 'node:fs/promises';
import { connect } from './db.ts';
import { applyRecoveryReview, prepareRecovery, RecoveryError } from './recovery.ts';
import { AccessError } from './errors.ts';

const [action, database, ...args] = process.argv.slice(2);
const uri = process.env.DATABASE_URL;
const recoveryVersion = process.env.RECOVERY_VERSION ?? '';
const id = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function instant(value: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) {
    throw new RecoveryError('Expected a UTC timestamp.');
  }
  try { return Temporal.Instant.from(value).epochMilliseconds; }
  catch { throw new RecoveryError('Expected a valid UTC timestamp.'); }
}

async function run() {
  if (!uri || !database || !/^[a-zA-Z0-9_]+$/.test(database) || new URL(uri).pathname !== '/' + database ||
      !/^[1-9][0-9]{0,9}$/.test(recoveryVersion)) {
    throw new RecoveryError('Provide the target database name and matching DATABASE_URL, and set RECOVERY_VERSION.');
  }
  const { db, pool } = connect(uri, 1);
  try {
    if (action === 'prepare' && args.length === 3) {
      const [snapshot, incident, allowlist] = args;
      const administrators = (await readFile(allowlist, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const state = await prepareRecovery(db, {
        version: Number(recoveryVersion), snapshotAt: instant(snapshot), incidentAt: instant(incident), administrators,
      });
      console.log(JSON.stringify(state));
      return;
    }
    const [target, date] = args;
    if (!target || !id.test(target)) throw new RecoveryError('Expected an account or rule ID.');
    let reason = '';
    if (process.stdin.isTTY) throw new RecoveryError('Pass the evidence or decision reason on stdin.');
    for await (const chunk of process.stdin.setEncoding('utf8')) {
      reason += chunk;
      if (reason.length > 502) throw new RecoveryError('Enter a reason of 1–500 characters.');
    }
    if (action === 'flag-date' && args.length === 2 && /^[1-9]\d{3}-\d\d-\d\d$/.test(date)) {
      try { Temporal.PlainDate.from(date); }
      catch { throw new RecoveryError('Expected a valid financial date.'); }
      await applyRecoveryReview(db, recoveryVersion, { action, ruleId: target, date, reason });
    } else if (action === 'release-rule' && args.length === 1) {
      await applyRecoveryReview(db, recoveryVersion, { action, ruleId: target, reason });
    } else if (action === 'flag-account' && args.length === 1) {
      await applyRecoveryReview(db, recoveryVersion, { action, accountId: target, reason });
    } else throw new RecoveryError('Expected prepare, flag-date, release-rule, or flag-account.');
    console.log(JSON.stringify({ action, recoveryVersion }));
  } finally {
    await pool.end();
  }
}

try { await run(); }
catch (error) {
  console.error(error instanceof RecoveryError || error instanceof AccessError ? error.message : 'Recovery command failed.');
  process.exitCode = 1;
}
