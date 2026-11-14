import type { Result } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import { rows } from './db.ts';
import type { Tx } from './db.ts';
import { AccessError } from './errors.ts';

type AccountHistory = Result<'listAccountHistory'>;
type Entry = AccountHistory['entries'][number];
type HistoryRow = { currency: AccountHistory['currency'] } & (Entry | { type: null });
const pageSize = 50;

export async function listAccountHistory(tx: Tx, userId: string, accountId: string,
  before?: string,
): Promise<AccountHistory> {
  const [beforeDate, beforeId] = before?.split('.') ?? [];
  if (beforeDate) {
    try {
      Temporal.PlainDate.from(beforeDate);
    } catch {
      throw new AccessError(400, 'INVALID_REQUEST');
    }
  }
  // A void version has no movements. Its preceding posted version identifies the affected accounts and amounts.
  const history = await rows<HistoryRow>(tx, sql`
    WITH owned_account AS (
      SELECT id, currency, start_date, opening_balance_minor FROM accounts WHERE id = ${accountId} AND user_id = ${userId}
    ), history_entries AS (
      SELECT a.id, a.start_date AS date, 'opening' AS type, a.opening_balance_minor AS amountMinor,
        NULL AS explanation, NULL AS actorRole, NULL AS transactionVersion, NULL AS status,
        NULL AS categoryId, NULL AS comment
      FROM owned_account a
      UNION ALL
      SELECT b.id, b.financial_date, 'adjustment', b.delta_minor, b.explanation, b.actor_role, NULL, NULL, NULL, NULL
      FROM owned_account a JOIN balance_adjustments b ON b.account_id = a.id
      UNION ALL
      SELECT t.id, v.financial_date, t.kind, m.amount_minor, NULL, v.actor_role, v.version, v.status, v.category_id, v.comment
      FROM owned_account a JOIN movements m ON m.account_id = a.id
      JOIN transactions t ON t.id = m.transaction_id AND t.user_id = ${userId}
      JOIN transaction_versions v ON v.transaction_id = t.id AND v.version = t.current_version
        AND m.transaction_version = v.version - (v.status = 'void')
    ), history_page AS (
      SELECT * FROM history_entries
      ${beforeDate ? sql`WHERE date < ${beforeDate} OR (date = ${beforeDate} AND id < ${beforeId})` : sql``}
      ORDER BY date DESC, id DESC LIMIT ${pageSize + 1}
    )
    SELECT a.currency, h.id, CAST(h.date AS CHAR) AS date, h.type, CAST(h.amountMinor AS CHAR) AS amountMinor,
      h.explanation, h.actorRole, h.transactionVersion, h.status, h.categoryId, h.comment
    FROM owned_account a LEFT JOIN history_page h ON TRUE ORDER BY h.date DESC, h.id DESC`);
  if (!history.length) throw new AccessError(404, 'NOT_FOUND');

  const entries: Entry[] = [];
  for (const row of history.slice(0, pageSize)) {
    if (row.type === null) continue;
    const { id, date, amountMinor } = row;
    if (row.type === 'opening') {
      entries.push({ id, date, type: row.type, amountMinor });
    } else if (row.type === 'adjustment') {
      entries.push({ id, date, type: row.type, amountMinor, explanation: row.explanation, actorRole: row.actorRole });
    } else {
      const { actorRole, transactionVersion, status, categoryId, comment } = row;
      entries.push({ id, date, type: row.type, amountMinor, actorRole, transactionVersion, status, categoryId, comment });
    }
  }
  const last = entries.at(-1);
  return { accountId, currency: history[0].currency, entries,
    next: last && history.length > pageSize ? `${last.date}.${last.id}` : null };
}
