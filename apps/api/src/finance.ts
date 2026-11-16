import { randomUUID } from 'node:crypto';
import type { AccountStatementQuery, Body, Params, Result } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { readProfileCalendar } from './profile.ts';
import { retryFinanceWrite, runCommand } from './commands.ts';
import type { ActorRole, WithCommandAccess } from './commands.ts';
import { audit, one, rows } from './db.ts';
import type { Db, Tx } from './db.ts';
import { AccessError } from './errors.ts';
import { normalizeTransactionSource, transactionSourceFields } from './transaction-source.ts';
import {
  checkScheduleForArchive, readAccountScheduleDates, recordReconciliationSkips, recordScheduleFailure, scheduleSelectionFingerprint,
  requireScheduleRuleAccount, settleScheduleDate, validateReconciliationDates,
} from './schedule.ts';
import type { ScheduleCandidate, ScheduleFailureCode } from './schedule.ts';

type TransactionInput = Body<'recordTransaction'>;
type TransferInput = Extract<TransactionInput, { type: 'transfer' }>;
type TransactionResult = Result<'recordTransaction'>;
type TransferResult = Extract<TransactionResult, { fromAccount: unknown }>;
type Revision = Body<'adminPreviewTransactionRevision'>;
type TransactionChange = Result<'reviseTransaction'>;
type TransactionPreview = Result<'adminPreviewTransactionRevision'>;
type TransactionHistory = Result<'listTransactionVersions'>;
type TransactionVersion = TransactionHistory['versions'][number];
type Movement = { accountId: string; amount: bigint };
type VersionFields = Pick<TransactionVersion, 'date' | 'categoryId' | 'comment' | 'status' | 'actorRole' | 'reason'> &
  { transactionSource: string | null };
type AccountBalance = Result<'getAccountBalance'>;
type DepositBalance = Extract<AccountBalance, { type: 'deposit' }>;
type AccountRow = Omit<AccountBalance, 'archived' | 'needsReconciliation'> & {
  archived: number; needsReconciliation: number;
} & (Pick<DepositBalance, 'type' | 'annualRatePercent' | 'maturityDate'> | {
  type: 'regular' | 'cash'; annualRatePercent: null; maturityDate: null;
});
type BalanceAdjustment = Result<'reconcileAccountBalance'>;
type BalanceAdjustmentRow = Omit<BalanceAdjustment, 'createdAt' | 'skippedDates'> & {
  createdAt: number; skippedDates: NonNullable<BalanceAdjustment['skippedDates']> | null;
};
type CurrencyBalance = Result<'getCurrencySummary'>['balances'][number];
type AccountCard = Result<'createAccountCard'>;
type CardDetails = Pick<AccountCard, 'cardId' | 'name' | 'appearance' | 'lastFour' | 'network'>;
type CardPreview = Result<'listAccounts'>['cardPreviews'][number];
type CardParams = Params<'updateAccountCard'>;
const maxMinor = 9223372036854775807n;
const minMinor = -9223372036854775808n;

const postedMovementsFor = (accountId: SQL) => sql`FROM movements m
  JOIN transactions t ON t.id = m.transaction_id AND t.current_version = m.transaction_version
  JOIN transaction_versions v ON v.transaction_id = m.transaction_id AND v.version = m.transaction_version
  WHERE m.account_id = ${accountId} AND v.status = 'posted' AND t.deleted_at IS NULL`;
const currentPostedMovements = postedMovementsFor(sql`a.id`);
const accountBalanceMinor = sql`a.opening_balance_minor + COALESCE((
  SELECT SUM(m.amount_minor) ${currentPostedMovements}
), 0) + COALESCE((
  SELECT SUM(b.delta_minor) FROM balance_adjustments b WHERE b.account_id = a.id
), 0)`;

async function profileDate(tx: Tx, userId: string, now: number) {
  return (await readProfileCalendar(tx, userId, now)).today;
}

const accountBalances = sql`SELECT a.id AS accountId, a.name, a.currency, a.start_date AS startDate, a.version AS accountVersion,
  a.kind AS type, CAST(a.annual_rate_percent AS CHAR) AS annualRatePercent, a.maturity_date AS maturityDate,
  CAST(${accountBalanceMinor} AS CHAR) AS balanceMinor, a.archived, a.needs_reconciliation AS needsReconciliation
  FROM accounts a`;

function formatAccountBalance(account: AccountRow): AccountBalance {
  const { type, annualRatePercent, maturityDate, archived, needsReconciliation, ...balance } = account;
  const result = { ...balance, ...(archived && { archived: true as const }),
    ...(needsReconciliation && { needsReconciliation: true as const }) };
  if (type === 'deposit') return { ...result, type, annualRatePercent, maturityDate };
  if (type === 'cash') return { ...result, type };
  return result;
}

export async function getAccountBalance(tx: Tx, userId: string, accountId: string): Promise<AccountBalance> {
  const account = await one<AccountRow>(tx, sql`${accountBalances}
    WHERE a.id = ${accountId} AND a.user_id = ${userId} AND a.deleted_at IS NULL`);
  if (!account) throw new AccessError(404, 'NOT_FOUND');
  return formatAccountBalance(account);
}

export const accountStatementRowLimit = 500;

type StatementEntry = {
  date: string;
  kind: 'income' | 'expense' | 'transfer' | 'adjustment';
  amountMinor: string;
  category: string | null;
  description: string | null;
};
type StatementAccount = { name: string; currency: AccountBalance['currency']; startDate: string; openingMinor: string };

export async function readAccountStatement(tx: Tx, userId: string, accountId: string, now: number,
  { fromDate, throughDate, lang }: AccountStatementQuery,
) {
  const { today, timeZone } = await readProfileCalendar(tx, userId, now);
  if (fromDate > throughDate || throughDate > today) throw new AccessError(400, 'INVALID_REQUEST');

  const data = await rows<StatementAccount & (StatementEntry | { kind: null })>(tx, sql`
    WITH owned_account AS (
      SELECT id, name, currency, start_date, opening_balance_minor FROM accounts
      WHERE id = ${accountId} AND user_id = ${userId} AND deleted_at IS NULL
    ), eligible_account AS (
      SELECT id FROM owned_account WHERE start_date <= ${fromDate}
    ), ledger AS (
      SELECT b.id, b.financial_date AS date, 'adjustment' AS kind, b.delta_minor AS amount,
        NULL AS category_id, b.explanation AS description
      FROM eligible_account a JOIN balance_adjustments b ON b.account_id = a.id
      WHERE b.financial_date <= ${throughDate}
      UNION ALL
      SELECT t.id, v.financial_date, t.kind, m.amount_minor, v.category_id, v.comment
      ${postedMovementsFor(sql`(SELECT id FROM eligible_account)`)} AND v.financial_date <= ${throughDate}
    ), opening AS (
      SELECT COALESCE(SUM(amount), 0) AS prior_movements FROM ledger WHERE date < ${fromDate}
    ), period_entries AS (
      SELECT * FROM ledger WHERE date >= ${fromDate}
      ORDER BY date, id, kind LIMIT ${accountStatementRowLimit + 1}
    )
    SELECT a.name, a.currency, CAST(a.start_date AS CHAR) AS startDate,
      CAST(a.opening_balance_minor + o.prior_movements AS CHAR) AS openingMinor,
      CAST(p.date AS CHAR) AS date, p.kind, CAST(p.amount AS CHAR) AS amountMinor,
      ${lang === 'ru' ? sql`c.name_ru` : sql`c.name_en`} AS category, p.description
    FROM owned_account a CROSS JOIN opening o LEFT JOIN period_entries p ON TRUE
    LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.date, p.id, p.kind`);
  const account = data[0];
  if (!account) throw new AccessError(404, 'NOT_FOUND');
  if (fromDate < account.startDate) throw new AccessError(400, 'INVALID_REQUEST');
  if (data.length > accountStatementRowLimit) throw new AccessError(422, 'STATEMENT_TOO_LARGE');

  const entries: StatementEntry[] = [];
  let incoming = 0n;
  let outgoing = 0n;
  let adjustments = 0n;
  for (const row of data) {
    if (row.kind === null) continue;
    const { date, kind, amountMinor, category, description } = row;
    entries.push({ date, kind, amountMinor, category, description });
    const amount = BigInt(amountMinor);
    if (kind === 'adjustment') adjustments += amount;
    else if (amount > 0n) incoming += amount;
    else outgoing -= amount;
  }
  const { name, currency, openingMinor } = account;
  return { name, currency, fromDate, throughDate, lang, generatedAt: now, timeZone, entries,
    openingMinor, closingMinor: (BigInt(openingMinor) + incoming - outgoing + adjustments).toString(),
    incomingMinor: incoming.toString(), outgoingMinor: outgoing.toString(), adjustmentsMinor: adjustments.toString() };
}

export type AccountStatement = Awaited<ReturnType<typeof readAccountStatement>>;

export async function getAccountBalanceSeries(tx: Tx, userId: string, accountId: string,
  now: number,
): Promise<Result<'getAccountBalanceSeries'>> {
  type Series = Result<'getAccountBalanceSeries'>;
  type DailyChange = Pick<Series, 'accountVersion' | 'currency'> & { date: string; throughDate: string; deltaMinor: string };
  const today = await profileDate(tx, userId, now);
  // The access transaction uses READ COMMITTED. Keep the ledger and version in one statement snapshot.
  const changes = await rows<DailyChange>(tx, sql`
    WITH owned_account AS (
      SELECT id, version, currency, start_date, opening_balance_minor FROM accounts
      WHERE id = ${accountId} AND user_id = ${userId} AND deleted_at IS NULL
    ), ledger AS (
      SELECT start_date AS date, opening_balance_minor AS delta FROM owned_account
      UNION ALL
      SELECT b.financial_date, b.delta_minor FROM balance_adjustments b JOIN owned_account a ON a.id = b.account_id
      UNION ALL
      SELECT v.financial_date, m.amount_minor ${postedMovementsFor(sql`(SELECT id FROM owned_account)`)}
    ), period_end AS (
      SELECT GREATEST(CAST(${today} AS DATE), MAX(date)) AS throughDate FROM ledger
    ), daily_changes AS (
      SELECT GREATEST(l.date, DATE_SUB(p.throughDate, INTERVAL 6 MONTH)) AS balance_date, SUM(l.delta) AS delta
      FROM ledger l CROSS JOIN period_end p GROUP BY balance_date
    )
    SELECT a.version AS accountVersion, a.currency, CAST(d.balance_date AS CHAR) AS date,
      CAST(p.throughDate AS CHAR) AS throughDate, CAST(d.delta AS CHAR) AS deltaMinor
    FROM daily_changes d CROSS JOIN owned_account a CROSS JOIN period_end p ORDER BY d.balance_date`);
  const first = changes[0];
  if (!first) throw new AccessError(404, 'NOT_FOUND');

  let balance = 0n;
  const points = changes.map(({ date, deltaMinor }) => {
    balance += BigInt(deltaMinor);
    return { date, balanceMinor: balance.toString() };
  });
  if (points.at(-1)?.date !== first.throughDate) points.push({ date: first.throughDate, balanceMinor: balance.toString() });
  return { accountId, accountVersion: first.accountVersion, currency: first.currency, points };
}

export async function listAccounts(tx: Tx, userId: string) {
  const accounts = await rows<AccountRow>(tx, sql`${accountBalances}
    WHERE a.user_id = ${userId} AND a.deleted_at IS NULL ORDER BY a.archived, a.name, a.id`);
  return { accounts: accounts.map(formatAccountBalance) };
}

export async function listMobileAccounts(tx: Tx, userId: string): Promise<Result<'listAccounts'>> {
  const { accounts } = await listAccounts(tx, userId);
  const cards = await rows<CardDetails & { accountId: string; cardCount: number }>(tx, sql`
    WITH ranked AS (
      SELECT c.account_id AS accountId, c.id AS cardId, c.name, c.appearance, c.last_four AS lastFour, c.network,
        COUNT(*) OVER (PARTITION BY c.account_id) AS cardCount,
        ROW_NUMBER() OVER (PARTITION BY c.account_id ORDER BY c.id) AS cardPosition
      FROM account_cards c JOIN accounts a ON a.id = c.account_id
      WHERE a.user_id = ${userId} AND a.archived = FALSE AND a.deleted_at IS NULL
    )
    SELECT accountId, cardId, name, appearance, lastFour, network, cardCount
    FROM ranked WHERE cardPosition <= 2 ORDER BY accountId, cardPosition`);
  const previews = new Map<string, CardPreview>();
  for (const { accountId, cardCount, ...card } of cards) {
    const preview = previews.get(accountId);
    if (preview) preview.cards.push(card);
    else previews.set(accountId, { accountId, count: cardCount, cards: [card] });
  }
  return { accounts, cardPreviews: [...previews.values()] };
}

export async function listCategories(tx: Tx): Promise<Result<'listCategories'>> {
  const categories = await rows<Result<'listCategories'>['categories'][number]>(tx, sql`
    SELECT id, kind AS type, name_en AS nameEn, name_ru AS nameRu FROM categories ORDER BY kind, id`);
  return { categories };
}

export async function getCurrencySummary(tx: Tx, userId: string): Promise<Result<'getCurrencySummary'>> {
  const balances = await rows<CurrencyBalance>(tx, sql`
    SELECT a.currency, CAST(SUM(${accountBalanceMinor}) AS CHAR) AS balanceMinor
    FROM accounts a WHERE a.user_id = ${userId} AND a.archived = FALSE AND a.deleted_at IS NULL
    GROUP BY a.currency ORDER BY CAST(a.currency AS CHAR)`);
  return { balances };
}

export async function listAccountCards(tx: Tx, userId: string, accountId: string): Promise<Result<'listAccountCards'>> {
  const { currency, balanceMinor } = await getAccountBalance(tx, userId, accountId);
  const cards = await rows<CardDetails>(tx, sql`SELECT id AS cardId, name, appearance, last_four AS lastFour, network
    FROM account_cards WHERE account_id = ${accountId} ORDER BY id`);
  return { cards: cards.map((card) => ({ ...card, accountId, currency, balanceMinor })) };
}

function findAccountForUpdate(tx: Tx, userId: string, accountId: string) {
  return one<{
    name: string; archived: number; start_date: string; currency: AccountBalance['currency']; version: number;
    maturity_date: string | null;
  }>(tx, sql`SELECT name, archived, start_date, currency, version, maturity_date FROM accounts
    WHERE id = ${accountId} AND user_id = ${userId} AND deleted_at IS NULL FOR UPDATE`);
}

async function lockAccount(tx: Tx, userId: string, accountId: string) {
  const account = await findAccountForUpdate(tx, userId, accountId);
  if (!account) throw new AccessError(404, 'NOT_FOUND');
  return account;
}

export function renameAccount(withAccess: WithCommandAccess, accountId: string,
  input: Body<'renameAccount'> | Body<'adminRenameAccount'>,
) {
  return retryFinanceWrite(() => withAccess(async (tx, userId, now, actorId) => {
    const account = await lockAccount(tx, userId, accountId);
    requireActiveAccounts([account]);
    if (account.version !== input.expectedAccountVersion) throw new AccessError(409, 'VERSION_CONFLICT');
    if (account.name !== input.name) {
      const version = account.version + 1;
      await tx.execute(sql`UPDATE accounts SET name = ${input.name}, version = ${version} WHERE id = ${accountId}`);
      const reason = 'reason' in input ? input.reason : undefined;
      await audit(tx, now, reason === undefined ? 'user' : 'admin', 'finance.account.renamed', actorId, userId, accountId,
        { from: String(account.version), to: String(version), ...(reason !== undefined && { reason }) });
    }
    return getAccountBalance(tx, userId, accountId);
  }));
}

export function updateAccountStartDate(withAccess: WithCommandAccess, accountId: string,
  input: Body<'updateAccountStartDate'> | Body<'adminUpdateAccountStartDate'>,
) {
  return retryFinanceWrite(() => withAccess(async (tx, userId, now, actorId) => {
    const account = await lockAccount(tx, userId, accountId);
    const { startDate, expectedAccountVersion } = input;
    requireActiveAccounts([account]);
    if (account.version !== expectedAccountVersion) throw new AccessError(409, 'VERSION_CONFLICT');
    if (startDate === account.start_date) return getAccountBalance(tx, userId, accountId);
    if (startDate > await profileDate(tx, userId, now) || (account.maturity_date && startDate > account.maturity_date)) {
      throw new AccessError(400, 'INVALID_REQUEST');
    }

    // Account and owner locks serialize this check with operations, reconciliation, and schedule writes.
    if (startDate > account.start_date) {
      const conflict = await one<{ found: number }>(tx, sql`SELECT (
        EXISTS (SELECT 1 FROM movements m JOIN transactions t ON t.id = m.transaction_id
          JOIN transaction_versions v ON v.transaction_id = t.id AND v.version = t.current_version
          WHERE m.account_id = ${accountId} AND m.transaction_version = v.version - (v.status = 'void')
            AND v.financial_date < ${startDate} AND t.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM balance_adjustments WHERE account_id = ${accountId} AND financial_date < ${startDate})
        OR EXISTS (SELECT 1 FROM schedule_rules WHERE account_id = ${accountId} AND deleted_at IS NULL AND first_date < ${startDate})
      ) AS found`);
      if (conflict?.found) throw new AccessError(409, 'ACCOUNT_START_DATE_CONFLICT');
    }

    await tx.execute(sql`UPDATE accounts SET start_date = ${startDate}, version = version + 1 WHERE id = ${accountId}`);
    const reason = 'reason' in input ? input.reason : undefined;
    await audit(tx, now, reason === undefined ? 'user' : 'admin', 'finance.account.start_date_changed', actorId, userId, accountId,
      { from: account.start_date, to: startDate, ...(reason !== undefined && { reason }) });
    return getAccountBalance(tx, userId, accountId);
  }));
}

export function setAccountArchived(withAccess: WithCommandAccess, accountId: string, archived: boolean,
  actorRole: ActorRole = 'user',
) {
  return retryFinanceWrite(() => withAccess<Result<'archiveAccount'>>(async (tx, userId, now, actorId) => {
    const account = await lockAccount(tx, userId, accountId);
    const { balanceMinor } = await getAccountBalance(tx, userId, accountId);
    if (archived === Boolean(account.archived)) {
      return { accountId, accountVersion: account.version, archived, balanceMinor };
    }
    if (archived) {
      if (balanceMinor !== '0') throw new AccessError(409, 'ACCOUNT_BALANCE_NOT_ZERO');
      await checkScheduleForArchive(tx, userId, accountId, now);
    }

    const accountVersion = account.version + 1;
    await tx.execute(sql`UPDATE accounts SET archived = ${archived}, version = ${accountVersion} WHERE id = ${accountId}`);
    await audit(tx, now, actorRole, archived ? 'finance.account.archived' : 'finance.account.restored', actorId, userId, accountId,
      { from: String(account.version), to: String(accountVersion) });
    return { accountId, accountVersion, archived, balanceMinor };
  }));
}

export async function listBalanceAdjustments(tx: Tx, userId: string, accountId: string,
  beforeVersion?: string,
): Promise<Result<'listBalanceAdjustments'>> {
  const account = await one(tx, sql`SELECT id FROM accounts WHERE id = ${accountId} AND user_id = ${userId} AND deleted_at IS NULL`);
  if (!account) throw new AccessError(404, 'NOT_FOUND');
  const pageSize = 50;
  const history = await rows<BalanceAdjustmentRow>(tx, sql`
    SELECT b.id AS adjustmentId, b.account_id AS accountId, a.currency, b.account_version AS accountVersion,
      CAST(b.balance_before_minor AS CHAR) AS balanceBeforeMinor,
      CAST(b.actual_balance_minor AS CHAR) AS actualBalanceMinor, CAST(b.delta_minor AS CHAR) AS deltaMinor,
      b.financial_date AS date, b.created_at AS createdAt, b.covered_through AS coveredThrough, b.explanation,
      b.actor_role AS actorRole,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('ruleId', o.rule_id, 'date', CAST(o.scheduled_date AS CHAR), 'reason', o.reason))
        FROM schedule_occurrences o WHERE o.adjustment_id = b.id AND o.source_occurrence_id IS NULL) AS skippedDates
    FROM balance_adjustments b JOIN accounts a ON a.id = b.account_id
    WHERE b.account_id = ${accountId} AND a.user_id = ${userId}
      ${beforeVersion ? sql`AND b.account_version < ${Number(beforeVersion)}` : sql``}
    ORDER BY b.account_version DESC LIMIT ${pageSize + 1}`);
  const adjustments = history.slice(0, pageSize).map(({ skippedDates, ...row }) => ({ ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    ...(skippedDates && { skippedDates: skippedDates.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.date.localeCompare(b.date)) }),
  }));
  const next = history.length > pageSize ? String(adjustments[pageSize - 1].accountVersion) : null;
  return { adjustments, next };
}

export async function previewBalanceAdjustment(tx: Tx, userId: string, accountId: string, now: number,
  query: { fromDate: string; throughDate: string },
): Promise<Result<'previewBalanceAdjustment'>> {
  const { accountVersion, balanceMinor, currency } = await getAccountBalance(tx, userId, accountId);
  const dates = await readAccountScheduleDates(tx, userId, accountId, { ...query, asOf: now });
  return { accountId, accountVersion, balanceMinor, currency, dates };
}

export function reconcileAccountBalance(withAccess: WithCommandAccess, recoveryVersion: string, accountId: string,
  input: Body<'reconcileAccountBalance'>, actorRole: ActorRole = 'user',
) {
  const { idempotencyKey, expectedAccountVersion, actualBalanceMinor, explanation, skippedDates = [] } = input;
  const selections = [...skippedDates].sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.date.localeCompare(b.date));
  const parameters = [String(expectedAccountVersion), actualBalanceMinor, explanation];
  if (selections.length) parameters.push(...selections.map(scheduleSelectionFingerprint));
  return runCommand<BalanceAdjustment>(withAccess, 'account.reconcile', recoveryVersion, idempotencyKey,
    [accountId], parameters, async (tx, userId, now, apply, actorId) => {
      const account = await lockAccount(tx, userId, accountId);
      return apply(async () => {
        if (account.version !== expectedAccountVersion) throw new AccessError(409, 'VERSION_CONFLICT');
        requireActiveAccounts([account]);
        const skips = await validateReconciliationDates(tx, userId, accountId, now, selections);
        const actual = BigInt(actualBalanceMinor);
        const date = await profileDate(tx, userId, now);
        const snapshot = await one<{ balanceBeforeMinor: string; coveredThrough: string }>(tx, sql`
          SELECT CAST(${accountBalanceMinor} AS CHAR) AS balanceBeforeMinor,
            CAST(GREATEST(CAST(${date} AS DATE), COALESCE((SELECT MAX(v.financial_date) ${currentPostedMovements}),
              CAST(${date} AS DATE))) AS CHAR) AS coveredThrough
          FROM accounts a WHERE a.id = ${accountId} AND a.user_id = ${userId}`);
        if (!snapshot) throw new AccessError(404, 'NOT_FOUND');
        const { balanceBeforeMinor, coveredThrough } = snapshot;
        const delta = actual - BigInt(balanceBeforeMinor);
        if (actual < minMinor || actual > maxMinor || delta < minMinor || delta > maxMinor) {
          throw new AccessError(400, 'INVALID_REQUEST');
        }
        const adjustmentId = randomUUID();
        const accountVersion = account.version + 1;
        const deltaMinor = delta.toString();
        await tx.execute(sql`INSERT INTO balance_adjustments
          (id, account_id, account_version, financial_date, created_at, covered_through, balance_before_minor,
            actual_balance_minor, delta_minor, explanation, actor_role)
          VALUES (${adjustmentId}, ${accountId}, ${accountVersion}, ${date}, ${now}, ${coveredThrough}, ${balanceBeforeMinor},
            ${actualBalanceMinor}, ${deltaMinor}, ${explanation}, ${actorRole})`);
        await tx.execute(sql`UPDATE accounts SET version = ${accountVersion}, needs_reconciliation = FALSE WHERE id = ${accountId}`);
        await audit(tx, now, actorRole, 'finance.account.reconciled', actorId, userId, adjustmentId,
          { from: String(account.version), to: String(accountVersion), ...(actorRole === 'admin' && { reason: explanation }) });
        await recordReconciliationSkips(tx, { adjustmentId, now, userId, actorId, actorRole }, skips);
        return { adjustmentId, accountId, accountVersion, currency: account.currency, balanceBeforeMinor, actualBalanceMinor,
          deltaMinor, date, createdAt: new Date(now).toISOString(), coveredThrough, explanation, actorRole,
          ...(selections.length && { skippedDates: selections.map(({ ruleId, date, reason }) => ({ ruleId, date, reason })) }) };
      });
    }, actorRole);
}

async function updateAccountForMovement(tx: Tx, accountId: string, date: string) {
  await tx.execute(sql`UPDATE accounts SET version = version + 1,
    needs_reconciliation = needs_reconciliation OR COALESCE(${date} <= (
      SELECT covered_through FROM balance_adjustments WHERE account_id = ${accountId} ORDER BY account_version DESC LIMIT 1
    ), FALSE)
    WHERE id = ${accountId}`);
}

function writeAccountCard<T>(withAccess: WithCommandAccess, accountId: string,
  write: (tx: Tx, userId: string, now: number, actorId: string) => Promise<T>,
) {
  return retryFinanceWrite(() => withAccess(async (tx, userId, now, actorId) => {
    await lockAccount(tx, userId, accountId);
    return write(tx, userId, now, actorId);
  }));
}

async function lockCard(tx: Tx, { accountId, cardId }: CardParams) {
  const card = await one<Pick<CardDetails, 'network'>>(tx, sql`SELECT network FROM account_cards
    WHERE id = ${cardId} AND account_id = ${accountId} FOR UPDATE`);
  if (!card) throw new AccessError(404, 'NOT_FOUND');
  return card;
}

export function createAccountCard(withAccess: WithCommandAccess, accountId: string, input: Body<'createAccountCard'>) {
  const cardId = randomUUID();
  const { name, appearance, lastFour = null, network = null } = input;
  return writeAccountCard<AccountCard>(withAccess, accountId, async (tx, userId, now) => {
    await tx.execute(sql`INSERT INTO account_cards (id, account_id, name, appearance, last_four, network)
      VALUES (${cardId}, ${accountId}, ${name}, ${appearance}, ${lastFour}, ${network})`);
    await audit(tx, now, 'user', 'finance.card.created', userId, userId, cardId);
    const { currency, balanceMinor } = await getAccountBalance(tx, userId, accountId);
    return { cardId, accountId, name, appearance, lastFour, network, currency, balanceMinor };
  });
}

export function updateAccountCard(withAccess: WithCommandAccess, params: CardParams, input: Body<'updateAccountCard'>) {
  const { accountId, cardId } = params;
  const { name, appearance, lastFour = null } = input;
  return writeAccountCard<AccountCard>(withAccess, accountId, async (tx, userId, now) => {
    const card = await lockCard(tx, params);
    const { network = card.network } = input;
    await tx.execute(sql`UPDATE account_cards SET name = ${name}, appearance = ${appearance}, last_four = ${lastFour}, network = ${network}
      WHERE id = ${cardId} AND account_id = ${accountId}`);
    await audit(tx, now, 'user', 'finance.card.updated', userId, userId, cardId);
    const { currency, balanceMinor } = await getAccountBalance(tx, userId, accountId);
    return { cardId, accountId, name, appearance, lastFour, network, currency, balanceMinor };
  });
}

export function deleteAccountCard(withAccess: WithCommandAccess, params: CardParams, role: ActorRole = 'user') {
  const { accountId, cardId } = params;
  return writeAccountCard<Result<'deleteAccountCard'>>(withAccess, accountId, async (tx, userId, now, actorId) => {
    await lockCard(tx, params);
    await tx.execute(sql`DELETE FROM account_cards WHERE id = ${cardId} AND account_id = ${accountId}`);
    await audit(tx, now, role, 'finance.card.deleted', actorId, userId, cardId);
    return { ok: true };
  });
}

export function createAccount(withAccess: WithCommandAccess, recoveryVersion: string,
  input: Body<'createAccount'> | Body<'adminCreateAccount'>,
) {
  const { name, currency, startDate, openingBalanceMinor, idempotencyKey } = input;
  const reason = 'reason' in input ? input.reason : undefined;
  const actorRole = reason === undefined ? 'user' : 'admin';
  // Keep fingerprints for existing regular account commands valid.
  const parameters = [name, currency, startDate, openingBalanceMinor];
  const kind = 'type' in input ? input.type : 'regular';
  let annualRatePercent: string | null = null;
  let maturityDate: string | null = null;
  if ('annualRatePercent' in input) {
    const [whole, fraction = ''] = input.annualRatePercent.split('.');
    annualRatePercent = `${whole}.${fraction.padEnd(4, '0')}`;
    maturityDate = input.maturityDate;
    parameters.push(kind, annualRatePercent, maturityDate);
  }
  if (kind === 'cash') parameters.push(kind);
  if (reason !== undefined) parameters.push(reason);
  return runCommand<AccountBalance>(withAccess, 'account.create', recoveryVersion, idempotencyKey,
    [], parameters, (tx, userId, now, apply, actorId) => apply(async () => {
      const amount = BigInt(openingBalanceMinor);
      if (amount < minMinor || amount > maxMinor || (maturityDate !== null && maturityDate < startDate) ||
          startDate > await profileDate(tx, userId, now)) {
        throw new AccessError(400, 'INVALID_REQUEST');
      }

      const accountId = randomUUID();
      await tx.execute(sql`INSERT INTO accounts
        (id, user_id, name, currency, start_date, opening_balance_minor, kind, annual_rate_percent, maturity_date)
        VALUES (${accountId}, ${userId}, ${name}, ${currency}, ${startDate}, ${amount.toString()},
          ${kind}, ${annualRatePercent}, ${maturityDate})`);
      await audit(tx, now, actorRole, 'finance.account.created', actorId, userId, accountId,
        { from: '0', to: '1', ...(reason !== undefined && { reason }) });
      return getAccountBalance(tx, userId, accountId);
    }), actorRole);
}

function postedVersion(input: Revision, transactionSource: string | null, actorRole: ActorRole = 'user', reason: string | null = null): VersionFields {
  return { status: 'posted', date: input.date, comment: input.comment ?? null,
    categoryId: input.type === 'transfer' ? null : input.categoryId, transactionSource, actorRole, reason };
}

async function insertVersion(tx: Tx, transactionId: string, version: number, now: number,
  fields: VersionFields, movements: Movement[],
) {
  await tx.execute(sql`INSERT INTO transaction_versions
    (transaction_id, version, status, financial_date, category_id, comment, income_source, created_at, actor_role, reason)
    VALUES (${transactionId}, ${version}, ${fields.status}, ${fields.date}, ${fields.categoryId}, ${fields.comment},
      ${fields.transactionSource}, ${now}, ${fields.actorRole}, ${fields.reason})`);
  for (const { accountId, amount } of movements) {
    await tx.execute(sql`INSERT INTO movements (transaction_id, transaction_version, account_id, amount_minor)
      VALUES (${transactionId}, ${version}, ${accountId}, ${amount.toString()})`);
  }
}

async function postTransaction(tx: Tx, userId: string, now: number, input: Revision, movements: Movement[],
  transactionSource: string | null = null, origin: 'manual' | 'schedule' = 'manual',
) {
  const { type } = input;
  const transactionId = randomUUID();
  await tx.execute(sql`INSERT INTO transactions (id, user_id, kind, current_version)
    VALUES (${transactionId}, ${userId}, ${type}, 1)`);
  await insertVersion(tx, transactionId, 1, now, postedVersion(input, transactionSource), movements);
  for (const { accountId } of movements) {
    await updateAccountForMovement(tx, accountId, input.date);
  }
  const automatic = origin === 'schedule';
  await audit(tx, now, automatic ? 'operator' : 'user', `${type}.recorded`, automatic ? null : userId,
    userId, transactionId, { from: '0', to: '1' });
  return { transactionId, transactionVersion: 1 };
}

async function getTransactionAccount(tx: Tx, userId: string, accountId: string) {
  const { accountVersion, currency, balanceMinor } = await getAccountBalance(tx, userId, accountId);
  return { accountId, accountVersion, currency, balanceMinor };
}

type LockedAccount = Awaited<ReturnType<typeof lockAccount>>;

async function transactionMovements(tx: Tx, userId: string, now: number, input: Revision,
  accounts: ReadonlyMap<string, LockedAccount>, permittedDate?: string,
): Promise<Movement[]> {
  const { date, type } = input;
  if (date !== permittedDate && date > await profileDate(tx, userId, now)) {
    throw new AccessError(400, 'INVALID_REQUEST');
  }
  if (type === 'transfer') {
    const { fromAccountId, toAccountId } = input;
    const from = accounts.get(fromAccountId)!;
    const to = accounts.get(toAccountId)!;
    const debit = BigInt(input.fromAmountMinor);
    const credit = BigInt(input.toAmountMinor);
    if (fromAccountId === toAccountId || debit > maxMinor || credit > maxMinor ||
        date < from.start_date || date < to.start_date || (from.currency === to.currency && debit !== credit)) {
      throw new AccessError(400, 'INVALID_REQUEST');
    }
    return [{ accountId: fromAccountId, amount: -debit }, { accountId: toAccountId, amount: credit }];
  }

  const { accountId, amountMinor, categoryId } = input;
  const amount = BigInt(amountMinor);
  if (amount <= 0n || amount > maxMinor || date < accounts.get(accountId)!.start_date ||
      !await one(tx, sql`SELECT id FROM categories WHERE id = ${categoryId} AND kind = ${type}`)) {
    throw new AccessError(400, 'INVALID_REQUEST');
  }
  return [{ accountId, amount: type === 'income' ? amount : -amount }];
}

function requireActiveAccounts(accounts: Iterable<LockedAccount>) {
  for (const account of accounts) {
    if (account.archived) throw new AccessError(409, 'ACCOUNT_UNAVAILABLE');
  }
}

function inputAccountIds(input: Revision) {
  return input.type === 'transfer' ? [input.fromAccountId, input.toAccountId] : [input.accountId];
}

async function lockAccounts(tx: Tx, userId: string, accountIds: string[]) {
  const accounts = new Map<string, LockedAccount>();
  for (const accountId of [...new Set(accountIds)].sort()) {
    accounts.set(accountId, await lockAccount(tx, userId, accountId));
  }
  return accounts;
}

function recordTransfer(withAccess: WithCommandAccess, recoveryVersion: string, input: TransferInput) {
  const { fromAccountId, toAccountId, fromAmountMinor, toAmountMinor, date, comment = null, idempotencyKey } = input;
  return runCommand<TransferResult>(withAccess, 'transfer.record', recoveryVersion, idempotencyKey,
    [fromAccountId, toAccountId], [fromAmountMinor, toAmountMinor, date, comment], async (tx, userId, now, apply) => {
    const accounts = await lockAccounts(tx, userId, inputAccountIds(input));

    return apply(async () => {
      requireActiveAccounts(accounts.values());
      const movements = await transactionMovements(tx, userId, now, input, accounts);
      const posted = await postTransaction(tx, userId, now, input, movements);
      const fromAccount = await getTransactionAccount(tx, userId, fromAccountId);
      const toAccount = await getTransactionAccount(tx, userId, toAccountId);
      return { ...posted, fromAccount, toAccount };
    });
  });
}

export function recordTransaction(withAccess: WithCommandAccess, recoveryVersion: string, input: TransactionInput) {
  if (input.type === 'transfer') return recordTransfer(withAccess, recoveryVersion, input);
  const { type, accountId, date, amountMinor, categoryId, comment = null, idempotencyKey } = input;
  const transactionSource = normalizeTransactionSource(type, input) ?? null;
  const parameters = [date, amountMinor, categoryId, comment];
  if (transactionSource !== null) parameters.push(transactionSource);
  return runCommand<TransactionResult>(withAccess, `${type}.record`, recoveryVersion, idempotencyKey,
    [accountId], parameters, async (tx, userId, now, apply) => {
    const accounts = await lockAccounts(tx, userId, [accountId]);

    return apply(async () => {
      requireActiveAccounts(accounts.values());
      const movements = await transactionMovements(tx, userId, now, input, accounts);
      const posted = await postTransaction(tx, userId, now, input, movements, transactionSource);
      return { ...posted, ...await getTransactionAccount(tx, userId, accountId) };
    });
  });
}

function withScheduleAccount<T>(db: Db, candidate: ScheduleCandidate, clock: () => number,
  action: (tx: Tx, account: LockedAccount, now: number) => Promise<T>,
) {
  return retryFinanceWrite(() => db.transaction(async (tx) => {
    const { userId, accountId } = candidate;
    // The owner's login status does not affect the schedule.
    if (!await one(tx, sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`)) return;
    const account = await findAccountForUpdate(tx, userId, accountId);
    if (!account) return;
    return action(tx, account, clock());
  }, { isolationLevel: 'read committed' }));
}

export function processScheduleDate(db: Db, candidate: ScheduleCandidate, clock = Date.now) {
  const { userId, accountId } = candidate;
  return withScheduleAccount(db, candidate, clock, (tx, account, now) =>
    settleScheduleDate(tx, candidate, now, Boolean(account.archived), async (date) => {
      const input: Revision = { type: date.kind, date: date.date, accountId, amountMinor: date.amountMinor,
        categoryId: date.categoryId, comment: date.comment ?? undefined };
      // The calendar established the due instant, even if the profile's date moved back.
      const movements = await transactionMovements(tx, userId, now, input, new Map([[accountId, account]]), date.date);
      return (await postTransaction(tx, userId, now, input, movements, date.source ?? null, 'schedule')).transactionId;
    }));
}

export function recordScheduleDateFailure(db: Db, candidate: ScheduleCandidate, errorCode: ScheduleFailureCode,
  expectedAttempts: number, clock = Date.now,
) {
  return withScheduleAccount(db, candidate, clock, (tx, _account, now) =>
    recordScheduleFailure(tx, candidate, now, errorCode, expectedAttempts));
}

export async function listTransactionVersions(tx: Tx, userId: string, transactionId: string): Promise<TransactionHistory> {
  type HistoryRow = Omit<TransactionVersion, 'createdAt' | 'movements'> & {
    createdAt: number; transactionSource: string | null; type: TransactionHistory['type']; transactionVersion: number;
  } & ({ accountId: null; currency: null; amountMinor: null } | TransactionVersion['movements'][number]);
  const history = await rows<HistoryRow>(tx, sql`
    SELECT t.kind AS type, t.current_version AS transactionVersion, v.version, v.status, v.financial_date AS date,
      v.category_id AS categoryId, v.comment, v.income_source AS transactionSource, v.created_at AS createdAt, v.actor_role AS actorRole, v.reason,
      m.account_id AS accountId, a.currency, CAST(m.amount_minor AS CHAR) AS amountMinor
    FROM transactions t JOIN transaction_versions v ON v.transaction_id = t.id
    LEFT JOIN movements m ON m.transaction_id = v.transaction_id AND m.transaction_version = v.version
    LEFT JOIN accounts a ON a.id = m.account_id
    WHERE t.id = ${transactionId} AND t.user_id = ${userId} AND t.deleted_at IS NULL AND v.version <= t.current_version
    ORDER BY v.version, m.account_id`);
  if (!history.length) throw new AccessError(404, 'NOT_FOUND');
  const { type, transactionVersion } = history[0];
  const versions = new Map<number, TransactionVersion>();
  for (const row of history) {
    const { version, status, date, categoryId, comment, transactionSource, createdAt, actorRole, reason, accountId, currency, amountMinor } = row;
    let entry = versions.get(version);
    if (!entry) {
      entry = { version, status, date, categoryId, comment, createdAt: new Date(createdAt).toISOString(), actorRole, reason,
        ...transactionSourceFields(type, transactionSource), movements: [] };
      versions.set(version, entry);
    }
    if (accountId !== null) entry.movements.push({ accountId, currency, amountMinor });
  }
  return { transactionId, transactionVersion, type, versions: [...versions.values()] };
}

async function lockTransactionChange(tx: Tx, userId: string, transactionId: string, revision?: Revision) {
  type CurrentVersion = Pick<TransactionVersion, 'version' | 'status' | 'date' | 'categoryId' | 'comment'> & {
    type: TransactionHistory['type']; transactionSource: string | null;
  };
  // The owner is already locked. Read the old account set before acquiring account and transaction locks.
  const current = await one<CurrentVersion>(tx, sql`
    SELECT t.kind AS type, v.version, v.status, v.financial_date AS date, v.category_id AS categoryId,
      v.comment, v.income_source AS transactionSource
    FROM transactions t JOIN transaction_versions v ON v.transaction_id = t.id AND v.version = t.current_version
    WHERE t.id = ${transactionId} AND t.user_id = ${userId}`);
  if (!current) throw new AccessError(404, 'NOT_FOUND');
  const movements = await rows<{ accountId: string; amountMinor: string }>(tx, sql`
    SELECT account_id AS accountId, CAST(amount_minor AS CHAR) AS amountMinor FROM movements
    WHERE transaction_id = ${transactionId} AND transaction_version = ${current.version}`);
  const accounts = await lockAccounts(tx, userId, [
    ...movements.map(({ accountId }) => accountId), ...(revision ? inputAccountIds(revision) : []),
  ]);
  const locked = await one<{ current_version: number }>(tx,
    sql`SELECT current_version FROM transactions WHERE id = ${transactionId} AND user_id = ${userId} FOR UPDATE`);
  if (!locked) throw new AccessError(404, 'NOT_FOUND');
  if (locked.current_version !== current.version) throw new AccessError(409, 'VERSION_CONFLICT');
  return { current, movements, accounts };
}

type LockedTransactionChange = Awaited<ReturnType<typeof lockTransactionChange>>;

async function replacementMovements(tx: Tx, userId: string, now: number, change: LockedTransactionChange,
  revision?: Revision,
) {
  if (change.current.status === 'void') throw new AccessError(409, 'TRANSACTION_VOID');
  requireActiveAccounts(change.accounts.values());
  if (!revision) return [];
  if (revision.type !== change.current.type) throw new AccessError(400, 'INVALID_REQUEST');
  return transactionMovements(tx, userId, now, revision, change.accounts, change.current.date);
}

export function previewTransactionChange(withAccess: WithCommandAccess, transactionId: string, revision?: Revision) {
  if (revision && revision.type !== 'transfer') normalizeTransactionSource(revision.type, revision);
  return retryFinanceWrite(() => withAccess<TransactionPreview>(async (tx, userId, now) => {
    const change = await lockTransactionChange(tx, userId, transactionId, revision);
    const replacement = await replacementMovements(tx, userId, now, change, revision);
    const before = new Map(change.movements.map(({ accountId, amountMinor }) => [accountId, BigInt(amountMinor)]));
    const after = new Map(replacement.map(({ accountId, amount }) => [accountId, amount]));
    const accounts: TransactionPreview['accounts'] = [];
    for (const accountId of change.accounts.keys()) {
      const account = await getTransactionAccount(tx, userId, accountId);
      const balanceAfter = BigInt(account.balanceMinor) - (before.get(accountId) ?? 0n) + (after.get(accountId) ?? 0n);
      accounts.push({ ...account, balanceAfterMinor: balanceAfter.toString() });
    }
    return { transactionId, transactionVersion: change.current.version, accounts };
  }));
}

type ChangeInput = Body<'reviseTransaction'> | Body<'voidTransaction'> | Body<'adminReviseTransaction'> | Body<'adminVoidTransaction'>;

export function changeTransaction(withAccess: WithCommandAccess, recoveryVersion: string, transactionId: string,
  input: ChangeInput, actorRole: ActorRole = 'user',
) {
  const { idempotencyKey, expectedTransactionVersion } = input;
  const revision = 'type' in input ? input : undefined;
  const transactionSource = revision && revision.type !== 'transfer'
    ? normalizeTransactionSource(revision.type, revision) : undefined;
  const reason = 'reason' in input ? input.reason : null;
  const expected = 'expectedAccounts' in input ? input.expectedAccounts : undefined;
  const expectedAccounts = expected && new Map(expected.map(({ accountId, accountVersion }) => [accountId, accountVersion]));
  const command = revision ? 'transaction.revise' : 'transaction.void';
  const parameters = [String(expectedTransactionVersion), reason];
  if (expected) {
    const versions = expected.map(({ accountId, accountVersion }) => `${accountId}:${accountVersion}`).sort();
    parameters.push(JSON.stringify(versions));
  }
  if (revision) {
    parameters.push(revision.type, revision.date, revision.comment ?? null);
    if (revision.type === 'transfer') {
      parameters.push(revision.fromAccountId, revision.toAccountId, revision.fromAmountMinor, revision.toAmountMinor);
    } else {
      parameters.push(revision.accountId, revision.amountMinor, revision.categoryId);
      if (transactionSource !== undefined) parameters.push(transactionSource);
    }
  }

  return runCommand<TransactionChange>(withAccess, command, recoveryVersion, idempotencyKey, [transactionId], parameters,
    async (tx, userId, now, apply, actorId) => {
      const change = await lockTransactionChange(tx, userId, transactionId, revision);
      return apply(async () => {
        if (change.current.version !== expectedTransactionVersion) throw new AccessError(409, 'VERSION_CONFLICT');
        if (actorRole === 'admin') {
          if (!reason?.trim() || !expectedAccounts || expectedAccounts.size !== expected?.length) {
            throw new AccessError(400, 'INVALID_REQUEST');
          }
          if (expectedAccounts.size !== change.accounts.size ||
              [...change.accounts].some(([id, account]) => expectedAccounts.get(id) !== account.version)) {
            throw new AccessError(409, 'VERSION_CONFLICT');
          }
        }
        const movements = await replacementMovements(tx, userId, now, change, revision);
        const transactionVersion = change.current.version + 1;
        const source = transactionSource === undefined ? change.current.transactionSource : transactionSource;
        const fields: VersionFields = revision ? postedVersion(revision, source, actorRole, reason) : {
          status: 'void', date: change.current.date, categoryId: change.current.categoryId, comment: change.current.comment,
          transactionSource: change.current.transactionSource, actorRole, reason,
        };
        await insertVersion(tx, transactionId, transactionVersion, now, fields, movements);
        await tx.execute(sql`UPDATE transactions SET current_version = ${transactionVersion} WHERE id = ${transactionId}`);
        const oldAccounts = new Set(change.movements.map(({ accountId }) => accountId));
        const newAccounts = new Set(movements.map(({ accountId }) => accountId));
        for (const accountId of change.accounts.keys()) {
          const date = oldAccounts.has(accountId) && (!newAccounts.has(accountId) || change.current.date < fields.date)
            ? change.current.date : fields.date;
          await updateAccountForMovement(tx, accountId, date);
        }
        await audit(tx, now, actorRole, revision ? 'transaction.revised' : 'transaction.voided', actorId, userId, transactionId,
          { from: String(change.current.version), to: String(transactionVersion), ...(reason !== null && { reason }) });
        const accounts: TransactionChange['accounts'] = [];
        for (const accountId of change.accounts.keys()) {
          accounts.push(await getTransactionAccount(tx, userId, accountId));
        }
        return { transactionId, transactionVersion, status: fields.status, accounts };
      });
    }, actorRole);
}

function selectTransactionsForDeletion(userId: string, filter: SQL) {
  return sql`transactions t JOIN transaction_versions v ON v.transaction_id = t.id AND v.version = t.current_version
    AND t.user_id = ${userId} AND t.deleted_at IS NULL AND (${filter})`;
}

type AffectedAccount = { accountId: string; date: string };

function accountsAffectedByDeletion(tx: Tx, selected: SQL) {
  return rows<AffectedAccount>(tx, sql`
    SELECT m.account_id AS accountId, CAST(MIN(v.financial_date) AS CHAR) AS date FROM ${selected}
    JOIN movements m ON m.transaction_id = t.id AND m.transaction_version = t.current_version
    WHERE v.status = 'posted' GROUP BY m.account_id`);
}

async function deleteLedgerTransactions(tx: Tx, selected: SQL, affected: AffectedAccount[],
  { userId, actorId, now, role, reason }: { userId: string; actorId: string; now: number; role: ActorRole; reason: string | null },
) {
  await tx.execute(sql`INSERT INTO transaction_versions
    (transaction_id, version, status, financial_date, category_id, comment, income_source, created_at, actor_role, reason)
    SELECT t.id, v.version + 1, 'void', v.financial_date, v.category_id, v.comment, v.income_source, ${now}, ${role}, ${reason}
    FROM ${selected} WHERE v.status = 'posted'`);
  const transition = sql`JSON_OBJECT('from', CAST(v.version AS CHAR), 'to', CAST(v.version + 1 AS CHAR)
    ${reason === null ? sql`` : sql`, 'reason', ${reason}`})`;
  await tx.execute(sql`INSERT INTO audit_events (actor_role, actor_id, user_id, object_id, event, happened_at, transition)
    SELECT ${role}, ${actorId}, ${userId}, t.id, 'transaction.voided', ${now}, ${transition}
    FROM ${selected} WHERE v.status = 'posted'`);
  await tx.execute(sql`UPDATE ${selected} SET t.current_version = v.version + (v.status = 'posted'), t.deleted_at = ${now}`);
  for (const account of affected) await updateAccountForMovement(tx, account.accountId, account.date);
}

export function deleteAccount(withAccess: WithCommandAccess, recoveryVersion: string, accountId: string,
  input: Body<'deleteAccount'> | Body<'adminDeleteAccount'>, role: ActorRole = 'user',
): Promise<Result<'deleteAccount'>> {
  const { idempotencyKey, expectedAccountVersion } = input;
  const reason = 'reason' in input ? input.reason : null;
  return runCommand(withAccess, 'account.delete', recoveryVersion, idempotencyKey, [accountId], [String(expectedAccountVersion), reason],
    async (tx, userId, now, apply, actorId) => {
      // Keep ownership checks and command retries available after deletion.
      if (!await one(tx, sql`SELECT id FROM accounts WHERE id = ${accountId} AND user_id = ${userId}`)) {
        throw new AccessError(404, 'NOT_FOUND');
      }
      return apply(async () => {
        // The owner lock serializes changes to the ledger and the schedule. A void entry belongs to its last posted account.
        const selected = selectTransactionsForDeletion(userId, sql`EXISTS (
          SELECT 1 FROM movements m WHERE m.transaction_id = t.id AND m.account_id = ${accountId}
            AND m.transaction_version = v.version - (v.status = 'void')
        ) OR EXISTS (
          SELECT 1 FROM schedule_occurrences o JOIN schedule_rules r ON r.id = o.rule_id
          WHERE o.transaction_id = t.id AND r.account_id = ${accountId}
        )`);
        const affected = (await accountsAffectedByDeletion(tx, selected)).filter((account) => account.accountId !== accountId);
        const accounts = await lockAccounts(tx, userId, [accountId, ...affected.map((account) => account.accountId)]);
        const account = accounts.get(accountId)!;
        if (account.version !== expectedAccountVersion) throw new AccessError(409, 'VERSION_CONFLICT');
        requireActiveAccounts(affected.map(({ accountId }) => accounts.get(accountId)!));

        await deleteLedgerTransactions(tx, selected, affected, { userId, actorId, now, role, reason });
        await tx.execute(sql`DELETE f FROM schedule_date_failures f JOIN schedule_rules r ON r.id = f.rule_id
          WHERE r.account_id = ${accountId}`);
        await tx.execute(sql`UPDATE schedule_rules SET deleted_at = ${now} WHERE account_id = ${accountId} AND deleted_at IS NULL`);
        await tx.execute(sql`DELETE FROM account_cards WHERE account_id = ${accountId}`);
        await tx.execute(sql`UPDATE accounts SET deleted_at = ${now}, version = version + 1 WHERE id = ${accountId}`);
        await audit(tx, now, role, 'finance.account.deleted', actorId, userId, accountId,
          { from: String(account.version), to: 'deleted', ...(reason !== null && { reason }) });
        return { accountId, status: 'deleted' };
      });
    }, role);
}

export function deleteScheduleRule(withAccess: WithCommandAccess, recoveryVersion: string, ruleId: string,
  input: Body<'deleteScheduleRule'> | Body<'adminDeleteScheduleRule'>, role: ActorRole = 'user',
): Promise<Result<'deleteScheduleRule'>> {
  const { idempotencyKey, expectedRuleVersion } = input;
  const reason = 'reason' in input ? input.reason : null;
  return runCommand(withAccess, 'schedule.delete', recoveryVersion, idempotencyKey, [ruleId], [String(expectedRuleVersion), reason],
    async (tx, userId, now, apply, actorId) => {
      const accountId = await requireScheduleRuleAccount(tx, userId, ruleId, true);
      return apply(async () => {
        // The owner lock serializes worker posts and transaction revisions. Use the current movements, including moves to other accounts.
        const selected = selectTransactionsForDeletion(userId, sql`EXISTS (
          SELECT 1 FROM schedule_occurrences o WHERE o.transaction_id = t.id AND o.rule_id = ${ruleId}
        )`);
        const affected = await accountsAffectedByDeletion(tx, selected);
        const accounts = await lockAccounts(tx, userId, [accountId, ...affected.map((movement) => movement.accountId)]);
        requireActiveAccounts(accounts.values());

        const rule = await one<{ ruleVersion: number; recoveryHeld: number }>(tx, sql`
          SELECT r.recovery_held AS recoveryHeld,
            (SELECT MAX(rv.version) FROM schedule_rule_versions rv WHERE rv.rule_id = r.id) AS ruleVersion
          FROM schedule_rules r WHERE r.id = ${ruleId} AND r.deleted_at IS NULL FOR UPDATE`);
        if (!rule) throw new AccessError(404, 'NOT_FOUND');
        if (rule.ruleVersion !== expectedRuleVersion) throw new AccessError(409, 'VERSION_CONFLICT');
        if (rule.recoveryHeld) throw new AccessError(409, 'SCHEDULE_RULE_STATE_CONFLICT');

        await deleteLedgerTransactions(tx, selected, affected, { userId, actorId, now, role, reason });
        await tx.execute(sql`UPDATE schedule_rules SET deleted_at = ${now} WHERE id = ${ruleId}`);
        await tx.execute(sql`DELETE FROM schedule_date_failures WHERE rule_id = ${ruleId}`);
        await audit(tx, now, role, 'schedule.rule.deleted', actorId, userId, ruleId,
          { from: String(rule.ruleVersion), to: 'deleted', ...(reason !== null && { reason }) });
        return { ruleId, status: 'deleted' };
      });
    }, role);
}
