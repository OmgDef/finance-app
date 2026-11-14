import { sql } from 'drizzle-orm';
import { localDateAt } from './calendar.ts';
import { audit, one } from './db.ts';
import type { Tx } from './db.ts';
import { AccessError } from './errors.ts';

export async function readProfileCalendar(tx: Tx, userId: string, now: number) {
  const current = await one<{ timeZone: string }>(tx, sql`
    SELECT time_zone AS timeZone FROM user_time_zone_versions
    WHERE user_id = ${userId} AND effective_at <= ${now} ORDER BY effective_at DESC LIMIT 1`);
  const timeZone = current?.timeZone ?? 'UTC';
  return { timeZone, today: localDateAt(now, timeZone), timeZoneConfigured: Boolean(current) };
}

function canonicalTimeZone(value: string) {
  // Intl also accepts numeric UTC offsets. Profiles use named IANA zones.
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value)) throw new AccessError(400, 'INVALID_REQUEST');
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone!;
  } catch (error) {
    if (error instanceof RangeError) throw new AccessError(400, 'INVALID_REQUEST');
    throw error;
  }
}

export async function changeProfileTimeZone(tx: Tx, userId: string, now: number, value: string) {
  const timeZone = canonicalTimeZone(value);
  const current = await readProfileCalendar(tx, userId, now);
  if (current.timeZoneConfigured && current.timeZone === timeZone) return current;

  // The owner is locked. Preserve the order of a zone selection and a rule created in the same millisecond.
  const occupied = await one<{ occupied: number }>(tx, sql`
    SELECT (EXISTS (SELECT 1 FROM user_time_zone_versions WHERE user_id = ${userId} AND effective_at >= ${now})
      OR EXISTS (SELECT 1 FROM schedule_rules r JOIN accounts a ON a.id = r.account_id
        WHERE a.user_id = ${userId} AND r.created_at >= ${now})) AS occupied`);
  if (occupied?.occupied) throw new AccessError(409, 'TIME_ZONE_CONFLICT');

  await tx.execute(sql`INSERT INTO user_time_zone_versions (user_id, effective_at, time_zone)
    VALUES (${userId}, ${now}, ${timeZone})`);
  await audit(tx, now, 'user', 'profile.time_zone.changed', userId, userId, userId,
    { from: current.timeZone, to: timeZone });
  return { timeZone, today: localDateAt(now, timeZone), timeZoneConfigured: true };
}
