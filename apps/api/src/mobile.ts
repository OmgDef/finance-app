import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Body } from '@teta/contracts';
import { base32, hashPassword, same, token, verifier, verifyPassword } from './crypto.ts';
import { audit, hasDatabaseError, one, rows } from './db.ts';
import type { Db, Tx } from './db.ts';
import { AccessError, deviceRevoked, pinInvalid, pinLocked, sessionExpired } from './errors.ts';
import { changeProfileTimeZone, readProfileCalendar } from './profile.ts';
import { retryFinanceWrite } from './commands.ts';
import { minute, networkLimits, normalizeEmail } from './rates.ts';

type Status = 'active' | 'blocked' | 'review';
interface User { id: string; email: string; status: Status }
interface Device {
  id: string; user_id: string; state: 'active' | 'locked' | 'revoked';
  verifier: string; pin_hash: string; pin_failures: number; biometric_verifier: string | null;
}
type UserWithDevice = User & { device_active: number };
const usersWithDevices = sql`SELECT u.id, u.email, u.status,
  EXISTS(SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.state = 'active') AS device_active FROM users u`;
function userSummary(user: UserWithDevice) {
  return { id: user.id, email: user.email, status: user.status, deviceActive: Boolean(user.device_active) };
}
const activationInvalid = new AccessError(401, 'ACTIVATION_INVALID');

export function mobileAccess(db: Db, key: Buffer, clock: () => number) {
  const digest = (scope: string, value: string) => verifier(key, scope, value);
  const transaction = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(fn, { isolationLevel: 'read committed' });
  const lockUser = (tx: Tx, id: string) => one<User>(tx, sql`SELECT * FROM users WHERE id = ${id} FOR UPDATE`);

  async function lockActiveUser(tx: Tx, id: string) {
    const user = await lockUser(tx, id);
    if (user?.status !== 'active') throw deviceRevoked;
    return user;
  }

  async function revokeSessions(tx: Tx, deviceId: string) {
    await tx.execute(sql`UPDATE sessions SET revoked = TRUE WHERE device_id = ${deviceId} AND revoked = FALSE`);
  }

  async function revokeInstallation(tx: Tx, userId: string, deviceId: string, now: number, actor?: string) {
    await tx.execute(sql`UPDATE devices SET state = 'revoked', biometric_verifier = NULL WHERE id = ${deviceId}`);
    await revokeSessions(tx, deviceId);
    await audit(tx, now, actor ? 'admin' : 'user', 'installation.revoked', actor ?? userId, userId, deviceId);
  }

  async function revokeInstallations(tx: Tx, userId: string, now: number, actor: string) {
    const devices = await rows<Pick<Device, 'id'>>(tx,
      sql`SELECT id FROM devices WHERE user_id = ${userId} AND state <> 'revoked' FOR UPDATE`);
    for (const { id } of devices) await revokeInstallation(tx, userId, id, now, actor);
  }

  async function revokeCodes(tx: Tx, userId: string, now: number, actor: string) {
    const codes = await rows<{ id: string }>(tx,
      sql`SELECT id FROM activation_codes WHERE user_id = ${userId} AND state = 'issued'`);
    await tx.execute(sql`UPDATE activation_codes SET state = 'revoked' WHERE user_id = ${userId} AND state = 'issued'`);
    for (const code of codes) await audit(tx, now, 'admin', 'activation.revoked', actor, userId, code.id);
  }

  async function newSession(tx: Tx, deviceId: string, now: number) {
    const value = token();
    const expiresAt = now + 30 * minute;
    await revokeSessions(tx, deviceId);
    await tx.execute(sql`INSERT INTO sessions (verifier, device_id, expires_at)
      VALUES (${digest('mobile-session', value)}, ${deviceId}, ${expiresAt})`);
    return { token: value, expiresAt: new Date(expiresAt).toISOString() };
  }

  async function checkPin(tx: Tx, user: User, device: Device, pin: string, now: number) {
    const correct = await verifyPassword(digest('pin', pin), device.pin_hash);
    const failures = correct ? 0 : device.pin_failures + 1;
    if (failures === 5) {
      await tx.execute(sql`UPDATE devices SET state = 'locked', pin_failures = 5, biometric_verifier = NULL
        WHERE id = ${device.id}`);
      await revokeSessions(tx, device.id);
      await audit(tx, now, 'user', 'installation.locked', user.id, user.id, device.id);
      return pinLocked;
    }
    await tx.execute(sql`UPDATE devices SET pin_failures = ${failures} WHERE id = ${device.id}`);
    return correct ? undefined : pinInvalid;
  }

  async function activeDevice(tx: Tx, userId: string, id: string) {
    const device = await one<Device>(tx, sql`SELECT * FROM devices WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
    if (!device || device.state === 'revoked') throw deviceRevoked;
    if (device.state === 'locked') throw pinLocked;
    return device;
  }

  async function withSession<T>(value: string, fn: (tx: Tx, user: User, device: Device, now: number) => Promise<T>,
    beforeOwnerLock?: (tx: Tx, userId: string) => Promise<void>) {
    const hash = digest('mobile-session', value);
    const owner = await one<{
      user_id: string; device_id: string; status: Status;
      state: Device['state']; revoked: number; expires_at: number;
    }>(db, sql`
      SELECT u.id AS user_id, d.id AS device_id, u.status, d.state, s.revoked, s.expires_at
      FROM sessions s JOIN devices d ON d.id = s.device_id JOIN users u ON u.id = d.user_id
      WHERE s.verifier = ${hash}`);
    if (!owner) throw sessionExpired;
    if (beforeOwnerLock) {
      if (owner.status !== 'active' || owner.state === 'revoked') {
        throw deviceRevoked;
      }
      if (owner.state === 'locked') throw pinLocked;
      if (owner.revoked || owner.expires_at <= clock()) throw sessionExpired;
    }
    return transaction(async (tx) => {
      await beforeOwnerLock?.(tx, owner.user_id);
      const user = await lockActiveUser(tx, owner.user_id);
      const device = await activeDevice(tx, user.id, owner.device_id);
      const session = await one<{ expires_at: number; revoked: number }>(tx,
        sql`SELECT expires_at, revoked FROM sessions WHERE verifier = ${hash} FOR UPDATE`);
      const now = clock();
      if (!session || session.revoked || session.expires_at <= now) throw sessionExpired;
      return fn(tx, user, device, now);
    });
  }

  return {
    withSession,
    async activate(input: Body<'activate'>, ip: string) {
      const email = normalizeEmail(input.email);
      await networkLimits(db, key, 'activate', clock(), ip, email);
      const code = input.code.replace(/[\s-]/g, '').toUpperCase();
      if (!/^[A-Z2-7]{16}$/.test(code)) throw activationInvalid;
      const codeHash = digest('activation', code);
      const installationHash = digest('installation', input.installationSecret);
      const pinHash = await hashPassword(digest('pin', input.pin));
      return transaction(async (tx) => {
        const user = await one<User>(tx, sql`SELECT * FROM users WHERE email = ${email} FOR UPDATE`);
        if (!user || user.status !== 'active') throw activationInvalid;
        const now = clock();
        const issued = await one<{ id: string }>(tx, sql`SELECT id FROM activation_codes
          WHERE user_id = ${user.id} AND state = 'issued' AND verifier = ${codeHash}
          AND expires_at > ${now} FOR UPDATE`);
        if (!issued || await one(tx, sql`SELECT id FROM devices WHERE verifier = ${installationHash}`)) throw activationInvalid;
        const deviceId = randomUUID();
        await tx.execute(sql`INSERT INTO devices (id, user_id, verifier, pin_hash)
          VALUES (${deviceId}, ${user.id}, ${installationHash}, ${pinHash})`);
        await tx.execute(sql`UPDATE activation_codes SET state = 'used' WHERE id = ${issued.id}`);
        await audit(tx, now, 'user', 'activation.used', user.id, user.id, issued.id);
        return newSession(tx, deviceId, now);
      }).catch((error: unknown) => {
        if (hasDatabaseError(error, 'ER_DUP_ENTRY')) throw activationInvalid;
        throw error;
      });
    },

    async unlock(input: Body<'unlock'>, ip: string) {
      const hash = digest('installation', input.installationSecret);
      const owner = await one<Pick<Device, 'id' | 'user_id'>>(db, sql`SELECT id, user_id FROM devices WHERE verifier = ${hash}`);
      if (!owner) {
        await networkLimits(db, key, 'unlock', clock(), ip);
        throw deviceRevoked;
      }
      const outcome = await transaction(async (tx) => {
        const user = await lockActiveUser(tx, owner.user_id);
        const device = await activeDevice(tx, user.id, owner.id);
        const now = clock();
        if ('pin' in input) {
          const error = await checkPin(tx, user, device, input.pin, now);
          if (error) return error;
        } else if (!device.biometric_verifier || !same(device.biometric_verifier, digest('biometric', input.biometricSecret))) {
          throw new AccessError(401, 'BIOMETRICS_INVALID');
        }
        return newSession(tx, device.id, now);
      });
      if (outcome instanceof AccessError) throw outcome;
      return outcome;
    },

    profile: (value: string) => withSession(value, async (tx, user, _device, now) =>
      ({ id: user.id, email: user.email, ...await readProfileCalendar(tx, user.id, now) })),
    setTimeZone: (value: string, timeZone: string) => retryFinanceWrite(() =>
      withSession(value, async (tx, user, _device, now) =>
        ({ id: user.id, email: user.email, ...await changeProfileTimeZone(tx, user.id, now, timeZone) }))),
    logout: (value: string) => withSession(value, async (tx, user, device, now) => {
      await revokeInstallation(tx, user.id, device.id, now);
    }),
    async setBiometrics(value: string, input?: Body<'enableBiometrics'>) {
      const outcome = await withSession(value, async (tx, user, device, now) => {
        if (input && 'installationSecret' in input) {
          if (!same(device.verifier, digest('installation', input.installationSecret))) {
            throw new AccessError(401, 'BIOMETRICS_INVALID');
          }
        } else if (input) {
          const error = await checkPin(tx, user, device, input.pin, now);
          if (error) return error;
        }
        await tx.execute(sql`UPDATE devices SET biometric_verifier =
          ${input ? digest('biometric', input.biometricSecret) : null} WHERE id = ${device.id}`);
        await audit(tx, now, 'user', input ? 'biometrics.enabled' : 'biometrics.revoked', user.id, user.id, device.id);
      });
      if (outcome instanceof AccessError) throw outcome;
    },

    async create(tx: Tx, actor: string, emailInput: string, now: number) {
      const email = normalizeEmail(emailInput);
      const id = randomUUID();
      try {
        await tx.execute(sql`INSERT INTO users (id, email) VALUES (${id}, ${email})`);
      } catch (error) {
        if (hasDatabaseError(error, 'ER_DUP_ENTRY')) throw new AccessError(409, 'EMAIL_EXISTS');
        throw error;
      }
      await audit(tx, now, 'admin', 'account.created', actor, id, id);
      return { id, email, status: 'active' as const, deviceActive: false };
    },
    async list(tx: Tx, after?: string, search?: string) {
      const prefix = search === undefined ? undefined : normalizeEmail(search).replace(/[=%_]/g, (character) => '=' + character);
      const list = await rows<UserWithDevice>(tx, sql`${usersWithDevices}
        WHERE TRUE ${after ? sql`AND u.email > ${normalizeEmail(after)}` : sql``}
          ${prefix !== undefined ? sql`AND u.email LIKE ${prefix + '%'} ESCAPE '='` : sql``}
        ORDER BY u.email LIMIT 51`);
      const users = list.slice(0, 50).map(userSummary);
      return { users, next: list.length > 50 ? users[49].email : null };
    },
    async getUser(tx: Tx, id: string) {
      const user = await one<UserWithDevice>(tx, sql`${usersWithDevices} WHERE u.id = ${id}`);
      if (!user) throw new AccessError(404, 'NOT_FOUND');
      return userSummary(user);
    },
    async issue(tx: Tx, actor: string, id: string, now: number) {
      const user = await lockUser(tx, id);
      if (!user || user.status !== 'active') throw new AccessError(409, 'ACCOUNT_UNAVAILABLE');
      await revokeCodes(tx, id, now, actor);
      const code = base32(randomBytes(10));
      const expires = now + 24 * 60 * minute;
      const codeId = randomUUID();
      await tx.execute(sql`INSERT INTO activation_codes (id, user_id, verifier, expires_at)
        VALUES (${codeId}, ${id}, ${digest('activation', code)}, ${expires})`);
      await audit(tx, now, 'admin', 'activation.issued', actor, id, codeId);
      return { code: code.match(/.{4}/g)!.join('-'), expiresAt: new Date(expires).toISOString() };
    },
    async revoke(tx: Tx, actor: string, id: string, now: number) {
      const user = await lockUser(tx, id);
      if (!user) throw new AccessError(404, 'NOT_FOUND');
      await revokeInstallations(tx, user.id, now, actor);
    },
    async status(tx: Tx, actor: string, id: string, status: Exclude<Status, 'review'>, now: number) {
      const user = await lockUser(tx, id);
      if (!user) throw new AccessError(404, 'NOT_FOUND');
      if (user.status === 'review') throw new AccessError(409, 'ACCOUNT_REVIEW_REQUIRED');
      if (status === 'blocked') {
        await revokeInstallations(tx, user.id, now, actor);
        await revokeCodes(tx, id, now, actor);
      }
      if (user.status !== status) {
        await tx.execute(sql`UPDATE users SET status = ${status} WHERE id = ${id}`);
        await audit(tx, now, 'admin', 'account.status', actor, id, id, { from: user.status, to: status });
      }
    },
    async reviewRecoveredUser(tx: Tx, actor: string, id: string, input: Body<'adminReviewRecoveredUser'>, now: number) {
      const user = await lockUser(tx, id);
      if (!user) throw new AccessError(404, 'NOT_FOUND');
      if (user.status !== 'review') throw new AccessError(409, 'ACCOUNT_REVIEW_CONFLICT');
      const { status, source } = input;
      await revokeInstallations(tx, user.id, now, actor);
      await revokeCodes(tx, id, now, actor);
      await tx.execute(sql`UPDATE users SET status = ${status} WHERE id = ${id}`);
      await audit(tx, now, 'admin', 'account.recovery_reviewed', actor, id, id,
        { from: user.status, to: status, source, reason: input.reason.trim() });
      return { id, email: user.email, status, deviceActive: false };
    },
  };
}
