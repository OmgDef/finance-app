import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Body } from '@teta/contracts';
import type { Config } from './config.ts';
import { base32, hashPassword, same, seal, token, totpAt, unseal, verifier, verifyPassword } from './crypto.ts';
import { audit, one } from './db.ts';
import type { Db, Tx } from './db.ts';
import { AccessError, authInvalid, limited } from './errors.ts';
import { consume, minute, networkLimits, normalizeEmail } from './rates.ts';

interface Admin {
  id: string; login: string; password_hash: string; enabled: number;
  totp_cipher: string | null; last_totp_step: number | null;
  recovery_verifier: string | null; recovery_expires_at: number | null;
}
interface Step {
  admin_id: string; kind: 'login' | 'setup'; browser_verifier: string; expires_at: number;
  attempts: number; pending_totp_cipher: string | null; spent: number;
}
const idle = 30 * minute;
const absolute = 8 * 60 * minute;
const csrfInvalid = new AccessError(403, 'CSRF_INVALID');
const dummyHash = await hashPassword(token());

export function adminAccess(db: Db, config: Config, clock: () => number) {
  const digest = (scope: string, value: string) => verifier(config.accessKey, scope, value);
  const transaction = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(fn, { isolationLevel: 'read committed' });
  const lockAdmin = (tx: Tx, id: string) => one<Admin>(tx, sql`SELECT * FROM admin_users WHERE id = ${id} FOR UPDATE`);

  async function passwordCheck(scope: 'password' | 'recovery', input: Body<'password'>, ip: string) {
    const login = normalizeEmail(input.login);
    await networkLimits(db, config.accessKey, scope, clock(), ip, login);
    const admin = await one<Admin>(db, sql`SELECT * FROM admin_users WHERE login = ${login}`);
    const valid = await verifyPassword(input.password, admin?.password_hash ?? dummyHash);
    if (!valid || !admin?.enabled) throw authInvalid;
    return admin;
  }

  async function newStep(tx: Tx, adminId: string, browser: string, kind: Step['kind'], pending: string | null = null) {
    const step = token();
    await tx.execute(sql`INSERT INTO admin_steps (verifier, admin_id, browser_verifier, kind, expires_at, pending_totp_cipher)
      VALUES (${digest('admin-step', step)}, ${adminId}, ${digest('browser', browser)}, ${kind}, ${clock() + 5 * minute}, ${pending})`);
    return step;
  }

  async function confirm(kind: Step['kind'], input: Body<'totp'>, browser: string, ip: string) {
    const hash = digest('admin-step', input.step);
    const candidate = await one<{ admin_id: string; login: string }>(db, sql`
      SELECT a.id AS admin_id, a.login FROM admin_steps s JOIN admin_users a ON a.id = s.admin_id
      WHERE s.verifier = ${hash} AND s.kind = ${kind}`);
    await networkLimits(db, config.accessKey, kind === 'login' ? 'totp' : 'recovery-confirm', clock(), ip, candidate?.login);
    if (!candidate || !browser) throw authInvalid;
    const outcome = await transaction(async (tx) => {
      const admin = await lockAdmin(tx, candidate.admin_id);
      const step = await one<Step>(tx, sql`SELECT * FROM admin_steps WHERE verifier = ${hash} FOR UPDATE`);
      const now = clock();
      if (!admin?.enabled || !step || step.spent || step.expires_at <= now ||
          !same(step.browser_verifier, digest('browser', browser))) throw authInvalid;
      if (step.attempts >= 5) throw limited(step.expires_at, now);
      if (kind === 'login') {
        const error = await consume(tx, config.accessKey, now, ['admin-totp', admin.id], 10);
        if (error) throw error;
      }
      await tx.execute(sql`UPDATE admin_steps SET attempts = attempts + 1 WHERE verifier = ${hash}`);
      const cipher = kind === 'login' ? admin.totp_cipher : step.pending_totp_cipher;
      if (!cipher) return authInvalid;
      const seed = unseal(config.totpKey, admin.id, cipher);
      const current = Math.floor(now / 30_000);
      const accepted = [current, current - 1].find((counter) => same(totpAt(seed, counter), input.code));
      if (accepted === undefined || (kind === 'login' && admin.last_totp_step !== null && accepted <= admin.last_totp_step)) {
        return authInvalid;
      }
      await tx.execute(sql`UPDATE admin_steps SET spent = TRUE, pending_totp_cipher = NULL WHERE verifier = ${hash}`);
      await tx.execute(sql`UPDATE admin_users SET totp_cipher = ${cipher}, last_totp_step = ${accepted} WHERE id = ${admin.id}`);
      if (kind === 'setup') {
        await audit(tx, now, 'admin', 'admin.totp_configured', admin.id, null, admin.id);
        return null;
      }
      const session = token();
      await tx.execute(sql`INSERT INTO admin_sessions (verifier, admin_id, created_at, last_seen_at)
        VALUES (${digest('admin-session', session)}, ${admin.id}, ${now}, ${now})`);
      return { id: admin.id, session, login: admin.login, csrf: digest('csrf', session) };
    });
    if (outcome instanceof AccessError) throw outcome;
    return outcome;
  }

  return {
    async password(input: Body<'password'>, browser: string, ip: string) {
      const checked = await passwordCheck('password', input, ip);
      return transaction(async (tx) => {
        const admin = await lockAdmin(tx, checked.id);
        if (!admin?.enabled || !admin.totp_cipher || admin.password_hash !== checked.password_hash) throw authInvalid;
        return { step: await newStep(tx, admin.id, browser, 'login') };
      });
    },
    async recovery(input: Body<'recovery'>, browser: string, ip: string) {
      const checked = await passwordCheck('recovery', input, ip);
      return transaction(async (tx) => {
        const admin = await lockAdmin(tx, checked.id);
        const now = clock();
        if (!admin?.enabled || admin.password_hash !== checked.password_hash ||
            !admin.recovery_verifier || !admin.recovery_expires_at || admin.recovery_expires_at <= now ||
            !same(admin.recovery_verifier, digest('admin-recovery', input.recoverySecret))) throw authInvalid;
        const seed = randomBytes(20);
        const step = await newStep(tx, admin.id, browser, 'setup', seal(config.totpKey, admin.id, seed));
        await tx.execute(sql`UPDATE admin_users SET recovery_verifier = NULL, recovery_expires_at = NULL WHERE id = ${admin.id}`);
        return { step, totpSecret: base32(seed) };
      });
    },
    login: (input: Body<'totp'>, browser: string, ip: string) => confirm('login', input, browser, ip),
    setup: (input: Body<'setup'>, browser: string, ip: string) => confirm('setup', input, browser, ip),

    async withSession<T>(session: string, csrf: string | undefined, changing: boolean,
      action: (tx: Tx, admin: { id: string; login: string; csrf: string; hash: string }, now: number) => Promise<T>) {
      if (!session) throw authInvalid;
      const hash = digest('admin-session', session);
      const owner = await one<{ admin_id: string }>(db,
        sql`SELECT admin_id FROM admin_sessions WHERE verifier = ${hash}`);
      if (!owner) throw authInvalid;
      return transaction(async (tx) => {
        const admin = await lockAdmin(tx, owner.admin_id);
        const row = await one<{ created_at: number; last_seen_at: number; revoked: number }>(tx,
          sql`SELECT created_at, last_seen_at, revoked FROM admin_sessions WHERE verifier = ${hash} FOR UPDATE`);
        const now = clock();
        if (!admin?.enabled || !row || row.revoked || row.created_at + absolute <= now || row.last_seen_at + idle <= now) {
          throw authInvalid;
        }
        const expected = digest('csrf', session);
        if (changing && !same(csrf ?? '', expected)) throw csrfInvalid;
        const response = await action(tx, { id: admin.id, login: admin.login, csrf: expected, hash }, now);
        await tx.execute(sql`UPDATE admin_sessions SET last_seen_at = ${now} WHERE verifier = ${hash}`);
        return response;
      });
    },
  };
}

export async function configureAdmin(db: Db, key: Buffer, email: string, password: string, clock = Date.now) {
  const login = normalizeEmail(email);
  const hash = await hashPassword(password);
  const secret = token();
  await db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO admin_users (id, login, password_hash)
      VALUES (${randomUUID()}, ${login}, ${hash}) ON DUPLICATE KEY UPDATE login = login`);
    const admin = (await one<Admin>(tx, sql`SELECT * FROM admin_users WHERE login = ${login} FOR UPDATE`))!;
    const now = clock();
    await tx.execute(sql`UPDATE admin_users SET password_hash = ${hash}, totp_cipher = NULL, last_totp_step = NULL,
      recovery_verifier = ${verifier(key, 'admin-recovery', secret)}, recovery_expires_at = ${now + 15 * minute}
      WHERE id = ${admin.id}`);
    await tx.execute(sql`UPDATE admin_steps SET spent = TRUE, pending_totp_cipher = NULL WHERE admin_id = ${admin.id}`);
    await tx.execute(sql`UPDATE admin_sessions SET revoked = TRUE WHERE admin_id = ${admin.id}`);
    await audit(tx, now, 'operator', 'admin.setup_issued', null, null, admin.id);
  }, { isolationLevel: 'read committed' });
  return secret;
}
