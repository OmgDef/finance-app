import type { Result, StatisticsQuery } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import { one } from './db.ts';
import type { Tx } from './db.ts';
import { AccessError } from './errors.ts';
import { transactionSourceFields } from './transaction-source.ts';
import { readProfileCalendar } from './profile.ts';

type Statistics = Result<'getStatistics'>;
type StoredEntry = Statistics['entries'][number] & { transactionSource: string | null };
type Aggregates = Pick<Required<Statistics>, 'totals' | 'categories' | 'weeks'> & { entries: StoredEntry[] };

const pageSize = 50;
const compareText = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;

function parseDate(date: string) {
  try {
    return Temporal.PlainDate.from(date);
  } catch {
    throw new AccessError(400, 'INVALID_REQUEST');
  }
}

async function reportPeriod(tx: Tx, userId: string, now: number, query: StatisticsQuery) {
  const { fromDate, throughDate } = query;
  if (fromDate !== undefined && throughDate !== undefined) {
    if (Temporal.PlainDate.compare(parseDate(fromDate), parseDate(throughDate)) > 0) {
      throw new AccessError(400, 'INVALID_REQUEST');
    }
    return { fromDate, throughDate };
  }
  if (fromDate !== undefined || throughDate !== undefined) throw new AccessError(400, 'INVALID_REQUEST');

  const { today } = await readProfileCalendar(tx, userId, now);
  const first = parseDate(today).with({ day: 1 });
  return { fromDate: first.toString(), throughDate: first.with({ day: first.daysInMonth }).toString() };
}

export async function getStatistics(tx: Tx, userId: string, now: number, query: StatisticsQuery): Promise<Statistics> {
  const period = await reportPeriod(tx, userId, now, query);
  const { fromDate, throughDate } = period;
  const { accountId, categoryId, type, currency, before, byWeek } = query;
  const [beforeDate, beforeId] = before?.split('.') ?? [];
  if (beforeDate !== undefined) {
    parseDate(beforeDate);
    if (beforeDate < fromDate || beforeDate > throughDate) throw new AccessError(400, 'INVALID_REQUEST');
  }

  // The access transaction uses READ COMMITTED. Keep ownership, totals, and entries in one statement snapshot.
  const report = await one<{ accountAllowed: number } & { [K in keyof Aggregates]: Aggregates[K] | null }>(tx, sql`
    WITH posted AS (
      SELECT t.id AS transactionId, v.version AS transactionVersion, v.financial_date AS date, t.kind AS type,
        a.id AS accountId, CAST(a.currency AS CHAR) AS currency, v.category_id AS categoryId, v.comment,
        v.income_source AS transactionSource, m.amount_minor AS amountMinor
      FROM transactions t
      JOIN transaction_versions v ON v.transaction_id = t.id AND v.version = t.current_version
      JOIN movements m ON m.transaction_id = t.id AND m.transaction_version = v.version
      JOIN accounts a ON a.id = m.account_id AND a.user_id = t.user_id
      WHERE t.user_id = ${userId} AND t.kind IN ('income', 'expense') AND v.status = 'posted'
        AND v.financial_date BETWEEN ${fromDate} AND ${throughDate}
        ${accountId === undefined ? sql`` : sql`AND a.id = ${accountId}`}
        ${categoryId === undefined ? sql`` : sql`AND v.category_id = ${categoryId}`}
        ${type === undefined ? sql`` : sql`AND t.kind = ${type}`}
        ${currency === undefined ? sql`` : sql`AND a.currency = ${currency}`}
    ), totals AS (
      SELECT currency, SUM(CASE WHEN type = 'income' THEN amountMinor ELSE 0 END) AS incomeMinor,
        -SUM(CASE WHEN type = 'expense' THEN amountMinor ELSE 0 END) AS expenseMinor
      FROM posted GROUP BY currency
    ), categories AS (
      SELECT currency, categoryId, -SUM(amountMinor) AS amountMinor
      FROM posted WHERE type = 'expense' GROUP BY currency, categoryId
    ) ${byWeek ? sql`, weeks AS (
      SELECT FLOOR(DATEDIFF(date, ${fromDate}) / 7) AS weekIndex, currency,
        SUM(CASE WHEN type = 'income' THEN amountMinor ELSE 0 END) AS incomeMinor,
        -SUM(CASE WHEN type = 'expense' THEN amountMinor ELSE 0 END) AS expenseMinor
      FROM posted GROUP BY weekIndex, currency
    )` : sql``}, page AS (
      SELECT * FROM posted
      ${beforeDate === undefined ? sql`` : sql`WHERE date < ${beforeDate} OR (date = ${beforeDate} AND transactionId < ${beforeId})`}
      ORDER BY date DESC, transactionId DESC LIMIT ${pageSize + 1}
    )
    SELECT ${accountId === undefined ? sql`1` : sql`EXISTS(SELECT 1 FROM accounts WHERE id = ${accountId} AND user_id = ${userId})`}
        AS accountAllowed,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('currency', currency,
        'incomeMinor', CAST(incomeMinor AS CHAR), 'expenseMinor', CAST(expenseMinor AS CHAR))) FROM totals) AS totals,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('currency', currency, 'categoryId', categoryId,
        'amountMinor', CAST(amountMinor AS CHAR))) FROM categories) AS categories,
      ${byWeek ? sql`(SELECT JSON_ARRAYAGG(JSON_OBJECT('weekIndex', CAST(weekIndex AS UNSIGNED), 'currency', currency,
        'incomeMinor', CAST(incomeMinor AS CHAR), 'expenseMinor', CAST(expenseMinor AS CHAR))) FROM weeks)` : sql`NULL`} AS weeks,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('transactionId', transactionId, 'transactionVersion', transactionVersion,
        'date', CAST(date AS CHAR), 'type', type, 'accountId', accountId, 'currency', currency,
        'categoryId', categoryId, 'comment', comment, 'transactionSource', transactionSource, 'amountMinor', CAST(amountMinor AS CHAR))) FROM page) AS entries`);
  if (!report) throw new Error('Missing statistics snapshot');
  if (!report.accountAllowed) throw new AccessError(404, 'NOT_FOUND');

  const totals = (report.totals ?? []).sort((a, b) => a.currency.localeCompare(b.currency));
  const categories = (report.categories ?? []).sort((a, b) => {
    const currencyOrder = a.currency.localeCompare(b.currency);
    if (currencyOrder) return currencyOrder;
    const amountDifference = BigInt(b.amountMinor) - BigInt(a.amountMinor);
    if (amountDifference !== 0n) return amountDifference < 0n ? -1 : 1;
    return compareText(a.categoryId, b.categoryId);
  });
  const page = report.entries ?? [];
  // JSON_ARRAYAGG does not preserve the order of the limited page.
  page.sort((a, b) => compareText(b.date, a.date) || compareText(b.transactionId, a.transactionId));
  const entries = page.slice(0, pageSize).map(({ transactionSource, ...entry }) =>
    ({ ...entry, ...transactionSourceFields(entry.type, transactionSource) }));
  const last = entries.at(-1);
  const weeks = byWeek ? (report.weeks ?? []).sort((a, b) =>
    a.weekIndex - b.weekIndex || a.currency.localeCompare(b.currency)) : undefined;
  return { ...period, totals, categories, ...(weeks && { weeks }), entries,
    next: last && page.length > pageSize ? `${last.date}.${last.transactionId}` : null };
}
