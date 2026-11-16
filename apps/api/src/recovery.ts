import { sql } from 'drizzle-orm';
import { audit, one, rows } from './db.ts';
import type { Db, Runner, Tx } from './db.ts';
import { normalizeEmail } from './rates.ts';
import { flagUncertainScheduleDate } from './schedule.ts';

type RecoveryState = { version: number; snapshotAt: number; incidentAt: number; preparedAt: number };
type Preparation = { version: number; snapshotAt: number; incidentAt: number; administrators: string[] };
const maxVersion = 9_999_999_999;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class RecoveryError extends Error {}

export function readRecoveryState(db: Runner, lock = false) {
  return one<RecoveryState>(db, sql`SELECT version, snapshot_at AS snapshotAt, incident_at AS incidentAt, prepared_at AS preparedAt
    FROM recovery_state WHERE id = 1 ${lock ? sql`FOR UPDATE` : sql``}`);
}

export async function verifyRecoveryVersion(db: Runner, version: string) {
  const state = await readRecoveryState(db);
  if (version !== String(state?.version ?? 1)) {
    throw new RecoveryError('RECOVERY_VERSION does not match the database. Check the recovery state before starting.');
  }
}

export function prepareRecovery(db: Db, input: Preparation, now = Date.now()) {
  const { version, snapshotAt, incidentAt } = input;
  const allowed = input.administrators.map(normalizeEmail);
  if (!Number.isInteger(version) || version < 2 || version > maxVersion ||
      !Number.isSafeInteger(snapshotAt) || !Number.isSafeInteger(incidentAt) ||
      snapshotAt < 0 || snapshotAt > incidentAt || incidentAt > now || !allowed.length ||
      allowed.some((login) => login.length > 254 || !email.test(login)) || new Set(allowed).size !== allowed.length) {
    throw new RecoveryError('Invalid recovery version, UTC interval, or administrator allowlist.');
  }
  return db.transaction(async (tx) => {
    const previous = await readRecoveryState(tx, true);
    if (previous && version <= previous.version) throw new RecoveryError('Choose a recovery version newer than the restored version.');
    const admins = await rows<{ id: string; login: string; enabled: number }>(tx,
      sql`SELECT id, login, enabled FROM admin_users ORDER BY id FOR UPDATE`);
    if (!allowed.every((login) => admins.some((admin) => admin.login === login && admin.enabled))) {
      throw new RecoveryError('The allowlist must contain only currently enabled administrators in the restored database.');
    }
    for (const admin of admins) {
      if (!admin.enabled || allowed.includes(admin.login)) continue;
      await tx.execute(sql`UPDATE admin_users SET enabled = FALSE WHERE id = ${admin.id}`);
      await audit(tx, now, 'operator', 'admin.recovery_disabled', null, null, admin.id, { from: 'enabled', to: 'disabled' });
    }
    await tx.execute(sql`UPDATE admin_users SET recovery_verifier = NULL, recovery_expires_at = NULL`);
    await tx.execute(sql`UPDATE admin_sessions SET revoked = TRUE WHERE revoked = FALSE`);
    await tx.execute(sql`UPDATE admin_steps SET spent = TRUE, pending_totp_cipher = NULL
      WHERE spent = FALSE OR pending_totp_cipher IS NOT NULL`);
    await tx.execute(sql`UPDATE activation_codes SET state = 'revoked' WHERE state = 'issued'`);
    await tx.execute(sql`UPDATE sessions SET revoked = TRUE WHERE revoked = FALSE`);
    await tx.execute(sql`UPDATE devices SET state = 'revoked', biometric_verifier = NULL WHERE state <> 'revoked' OR biometric_verifier IS NOT NULL`);
    await tx.execute(sql`INSERT INTO audit_events (actor_role, user_id, object_id, event, happened_at, transition)
      SELECT 'operator', id, id, 'account.recovery_pending', ${now}, JSON_OBJECT('from', status, 'to', 'review') FROM users`);
    await tx.execute(sql`UPDATE users SET status = 'review'`);
    await tx.execute(sql`UPDATE schedule_rules SET recovery_held = TRUE`);
    await tx.execute(sql`DELETE FROM schedule_worker_state WHERE id = 1`);
    await tx.execute(sql`INSERT INTO recovery_state (id, version, snapshot_at, incident_at, prepared_at)
      VALUES (1, ${version}, ${snapshotAt}, ${incidentAt}, ${now})
      ON DUPLICATE KEY UPDATE version = ${version}, snapshot_at = ${snapshotAt},
        incident_at = ${incidentAt}, prepared_at = ${now}`);
    await audit(tx, now, 'operator', 'recovery.prepared', null, null, null, {
      from: String(previous?.version ?? 1), to: String(version),
      reason: `${new Date(snapshotAt).toISOString()} → ${new Date(incidentAt).toISOString()}`,
    });
    return { version, snapshotAt, incidentAt, preparedAt: now };
  });
}

async function lockRecoveryRule(tx: Tx, ruleId: string) {
  const target = await one<{ userId: string; accountId: string }>(tx, sql`
    SELECT a.user_id AS userId, a.id AS accountId FROM schedule_rules r JOIN accounts a ON a.id = r.account_id
    WHERE r.id = ${ruleId}`);
  if (!target) throw new RecoveryError('The rule is unavailable.');
  await tx.execute(sql`SELECT id FROM users WHERE id = ${target.userId} FOR UPDATE`);
  await tx.execute(sql`SELECT id FROM accounts WHERE id = ${target.accountId} FOR UPDATE`);
  const rule = await one<{ held: number }>(tx, sql`SELECT recovery_held AS held FROM schedule_rules WHERE id = ${ruleId} FOR UPDATE`);
  if (!rule?.held) throw new RecoveryError('The rule is not held for recovery.');
  return target;
}

type ReviewAction =
  | { action: 'flag-date'; ruleId: string; date: string; reason: string }
  | { action: 'release-rule'; ruleId: string; reason: string }
  | { action: 'flag-account'; accountId: string; reason: string };

export function applyRecoveryReview(db: Db, version: string, input: ReviewAction, now = Date.now()) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new RecoveryError('Enter a reason of 1–500 characters.');
  return db.transaction(async (tx) => {
    const state = await readRecoveryState(tx, true);
    if (!state || String(state.version) !== version) throw new RecoveryError('The active recovery version does not match.');
    if (input.action === 'flag-account') {
      const { accountId } = input;
      const account = await one<{ userId: string }>(tx, sql`SELECT user_id AS userId FROM accounts WHERE id = ${accountId}`);
      if (!account) throw new RecoveryError('The account is unavailable.');
      await tx.execute(sql`SELECT id FROM users WHERE id = ${account.userId} FOR UPDATE`);
      const current = await one<{ marked: number }>(tx, sql`
        SELECT needs_reconciliation AS marked FROM accounts WHERE id = ${accountId} FOR UPDATE`);
      if (!current) throw new RecoveryError('The account is unavailable.');
      if (current.marked) return;
      await tx.execute(sql`UPDATE accounts SET needs_reconciliation = TRUE, version = version + 1 WHERE id = ${accountId}`);
      await audit(tx, now, 'operator', 'finance.account.recovery_flagged', null, account.userId, accountId,
        { from: 'unmarked', to: 'needs_reconciliation', reason });
      return;
    }
    const { ruleId } = input;
    const target = await lockRecoveryRule(tx, ruleId);
    if (input.action === 'flag-date') {
      await flagUncertainScheduleDate(tx, { ...target, ruleId, date: input.date }, now, reason);
    } else {
      await tx.execute(sql`UPDATE schedule_rules SET recovery_held = FALSE WHERE id = ${ruleId}`);
      await audit(tx, now, 'operator', 'schedule.recovery_released', null, target.userId, ruleId,
        { from: 'held', to: 'reviewed', reason });
    }
  }, { isolationLevel: 'read committed' });
}
