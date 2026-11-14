import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { createPool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import type { RecoveryEvidence } from '@teta/contracts';

export function connect(uri: string, connectionLimit = 12) {
  const pool = createPool({ uri, connectionLimit });
  return { db: drizzle(pool), pool };
}

export type Db = MySql2Database;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Runner = Db | Tx;

export async function rows<T>(db: Runner, query: SQL) {
  const [result] = await db.execute(query);
  if (!Array.isArray(result)) throw new Error('Expected database rows');
  return result as (T & RowDataPacket)[];
}

export async function one<T>(db: Runner, query: SQL) {
  return (await rows<T>(db, query))[0];
}

export function hasDatabaseError(error: unknown, ...codes: string[]): boolean {
  return !!error && typeof error === 'object' &&
    (('code' in error && typeof error.code === 'string' && codes.includes(error.code)) ||
      ('cause' in error && hasDatabaseError(error.cause, ...codes)));
}

export function audit(
  db: Tx, now: number, role: 'operator' | 'admin' | 'user', event: string,
  actorId: string | null, userId: string | null, objectId: string | null,
  transition: { from: string; to: string; reason?: string; source?: RecoveryEvidence } | null = null,
) {
  return db.execute(sql`INSERT INTO audit_events
    (actor_role, actor_id, user_id, object_id, event, happened_at, transition)
    VALUES (${role}, ${actorId}, ${userId}, ${objectId}, ${event}, ${now},
      ${transition && JSON.stringify(transition)})`);
}
