import type { AuditQuery, Result } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import { rows } from './db.ts';
import type { Tx } from './db.ts';
import { AccessError } from './errors.ts';
import { normalizeEmail } from './rates.ts';

type Audit = Result<'adminListAudit'>;
type Event = Audit['events'][number];
type StoredEvent = Omit<Event, 'happenedAt' | 'transition'> & { happenedAt: number; transition: unknown };

const pageSize = 50;
const invalid = new AccessError(400, 'INVALID_REQUEST');
const maxAuditId = 18_446_744_073_709_551_615n;
const minAuditTime = Date.parse('0000-01-01T00:00:00.000Z');
const maxAuditTime = Date.parse('9999-12-31T23:59:59.999Z');

function timestamp(value: string) {
  try { return Temporal.Instant.from(value).epochMilliseconds; }
  catch { throw invalid; }
}

function metadata(value: unknown): Event['transition'] {
  if (!value || typeof value !== 'object') return null;
  const details: NonNullable<Event['transition']> = {};
  for (const field of ['from', 'to', 'reason'] as const) {
    const text = (value as Record<string, unknown>)[field];
    if (typeof text === 'string') details[field] = text;
  }
  if ('source' in value && (value.source === 'post_snapshot_records' || value.source === 'service_owner_confirmation')) {
    details.source = value.source;
  }
  return Object.keys(details).length ? details : null;
}

export async function listAuditEvents(tx: Tx, { userId, userEmail, adminId, adminLogin, from, through, event, before }: AuditQuery): Promise<Audit> {
  const fromTime = from === undefined ? undefined : timestamp(from);
  const throughTime = through === undefined ? undefined : timestamp(through);
  if (fromTime !== undefined && throughTime !== undefined && fromTime > throughTime) throw invalid;

  const [beforeTime, beforeId] = before?.split('.') ?? [];
  const cursorTime = beforeTime === undefined ? undefined : Number(beforeTime);
  if (cursorTime !== undefined && (!Number.isSafeInteger(cursorTime) || cursorTime < minAuditTime || cursorTime > maxAuditTime ||
      BigInt(beforeId) > maxAuditId)) {
    throw invalid;
  }

  const matches = await rows<StoredEvent>(tx, sql`
    SELECT CAST(e.id AS CHAR) AS id, e.happened_at AS happenedAt, e.event, e.actor_role AS actorRole,
      e.actor_id AS actorId, a.login AS actorLogin, e.user_id AS userId, u.email AS userEmail,
      e.object_id AS objectId, e.transition
    FROM audit_events e
    LEFT JOIN admin_users a ON e.actor_role = 'admin' AND a.id = e.actor_id
    LEFT JOIN users u ON u.id = e.user_id
    WHERE TRUE
      ${userId === undefined ? sql`` : sql`AND e.user_id = ${userId}`}
      ${userEmail === undefined ? sql`` : sql`AND u.email = ${normalizeEmail(userEmail)}`}
      ${adminId === undefined ? sql`` : sql`AND e.actor_role = 'admin' AND e.actor_id = ${adminId}`}
      ${adminLogin === undefined ? sql`` : sql`AND a.login = ${normalizeEmail(adminLogin)}`}
      ${fromTime === undefined ? sql`` : sql`AND e.happened_at >= ${fromTime}`}
      ${throughTime === undefined ? sql`` : sql`AND e.happened_at <= ${throughTime}`}
      ${event === undefined ? sql`` : sql`AND BINARY e.event = ${event}`}
      ${cursorTime === undefined ? sql`` : sql`AND (e.happened_at < ${cursorTime} OR
        (e.happened_at = ${cursorTime} AND e.id < CAST(${beforeId} AS UNSIGNED)))`}
    ORDER BY e.happened_at DESC, e.id DESC LIMIT ${pageSize + 1}`);

  const page = matches.slice(0, pageSize);
  const last = page.at(-1);
  return { events: page.map(({ happenedAt, transition, ...row }) => ({
    ...row, happenedAt: new Date(happenedAt).toISOString(), transition: metadata(transition),
  })), next: last && matches.length > pageSize ? `${last.happenedAt}.${last.id}` : null };
}
