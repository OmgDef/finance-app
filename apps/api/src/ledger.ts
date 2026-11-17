import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

export const maxMovementMinor = 9223372036854775807n;

export const postedMovementsFor = (accountId: SQL) => sql`FROM movements m
  JOIN transactions t ON t.id = m.transaction_id AND t.current_version = m.transaction_version
  JOIN transaction_versions v ON v.transaction_id = m.transaction_id AND v.version = m.transaction_version
  WHERE m.account_id = ${accountId} AND v.status = 'posted' AND t.deleted_at IS NULL`;
