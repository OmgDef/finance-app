import { sql } from 'drizzle-orm';
import { verifier } from './crypto.ts';
import { one } from './db.ts';
import type { Db, Tx } from './db.ts';
import { limited } from './errors.ts';

export const minute = 60_000;
const windowMs = 15 * minute;

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function networkLimits(db: Db, key: Buffer, scope: string, now: number, ip: string, login?: string) {
  return db.transaction(async (tx) => {
    // Every network request consumes IP capacity, even if the pair is exhausted.
    const ipLimit = await consume(tx, key, now, [scope, ip], 30);
    if (ipLimit) return ipLimit;
    if (login !== undefined) return consume(tx, key, now, [scope, ip, login], 5);
  }, { isolationLevel: 'read committed' }).then((error) => {
    if (error) throw error;
  });
}

export async function consume(tx: Tx, key: Buffer, now: number, scope: string[], max: number) {
  const bucket = verifier(key, 'rate', JSON.stringify(scope));
  await tx.execute(sql`INSERT INTO rate_limits (bucket, expires_at, attempts) VALUES (${bucket}, ${now + windowMs}, 0)
    ON DUPLICATE KEY UPDATE bucket = bucket`);
  const row = (await one<{ attempts: number; expires_at: number }>(tx,
    sql`SELECT attempts, expires_at FROM rate_limits WHERE bucket = ${bucket} FOR UPDATE`))!;
  if (row.expires_at > now && row.attempts >= max) return limited(row.expires_at, now);
  const expired = row.expires_at <= now;
  await tx.execute(sql`UPDATE rate_limits SET attempts = ${expired ? 1 : row.attempts + 1},
    expires_at = ${expired ? now + windowMs : row.expires_at} WHERE bucket = ${bucket}`);
}
