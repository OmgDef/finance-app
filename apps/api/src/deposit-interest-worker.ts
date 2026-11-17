import { sql } from 'drizzle-orm';
import { latestPossibleDueDate } from './calendar.ts';
import { rows } from './db.ts';
import type { Db } from './db.ts';
import { processDepositInterest } from './finance.ts';

export async function runDepositInterestPass(db: Db, clock = Date.now, signal?: AbortSignal) {
  const throughDate = latestPossibleDueDate(clock());
  const pageSize = 100;
  let afterId: string | undefined;
  let settled = 0;
  let failed = 0;
  while (!signal?.aborted) {
    const accounts = await rows<{ userId: string; accountId: string }>(db, sql`
      SELECT id AS accountId, user_id AS userId FROM accounts
      WHERE next_interest_date <= ${throughDate} AND archived = FALSE AND deleted_at IS NULL
        ${afterId ? sql`AND id > ${afterId}` : sql``}
      ORDER BY id LIMIT ${pageSize}`);
    for (const account of accounts) {
      if (signal?.aborted) break;
      try {
        settled += await processDepositInterest(db, account, clock) ?? 0;
      } catch {
        failed++;
      }
    }
    if (accounts.length < pageSize) break;
    afterId = accounts.at(-1)!.accountId;
  }
  return { settled, failed };
}
