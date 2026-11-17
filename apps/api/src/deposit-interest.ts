import { createHash } from 'node:crypto';
import type { Body, Result } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import { audit, one, rows } from './db.ts';
import type { Tx } from './db.ts';
import { depositInterestAmount, nextDepositPeriod } from './deposit-calendar.ts';
import type { DepositPeriod } from './deposit-calendar.ts';
import { AccessError } from './errors.ts';
import { maxMovementMinor, postedMovementsFor } from './ledger.ts';
import { readProfileCalendar } from './profile.ts';
import { readDepositScheduleBlockers } from './schedule.ts';

type Preview = Result<'previewDepositInterest'>;
type PeriodPreview = Preview['periods'][number];
type Decision = NonNullable<Body<'applyDepositInterest'>['decision']>;
type ExistingInterest = NonNullable<PeriodPreview['transactions']>[number];
type Adjustment = NonNullable<PeriodPreview['adjustments']>[number] & { coveredThrough: string };
type Settlement = { period: PeriodPreview } & (
  { outcome: 'posted' | 'zero' } |
  { outcome: 'existing'; transactionId: string } |
  { outcome: 'reconciled'; adjustmentId: string }
);
type Plan = { settlements: Settlement[]; periods: PeriodPreview[]; blockedBy?: Preview['blockedBy'] };
const periodsPerBatch = 12;
const categoryId = 'deposit-interest';

export function readDepositAccount(tx: Tx, userId: string, accountId: string) {
  return one<{
    accountId: string; version: number; archived: number; currency: Preview['currency'];
    startDate: string; maturityDate: string; nextDate: string | null; lastDate: string | null;
    openingMinor: string; rate: string; reviewBefore: number | null;
  }>(tx, sql`
    SELECT a.id AS accountId, a.version, a.currency, a.archived, CAST(a.start_date AS CHAR) AS startDate,
      CAST(a.maturity_date AS CHAR) AS maturityDate, CAST(a.next_interest_date AS CHAR) AS nextDate,
      (SELECT CAST(MAX(payment_date) AS CHAR) FROM deposit_interest_periods WHERE account_id = a.id) AS lastDate,
      CAST(a.opening_balance_minor AS CHAR) AS openingMinor, CAST(a.annual_rate_percent AS CHAR) AS rate,
      a.interest_review_before AS reviewBefore
    FROM accounts a WHERE a.id = ${accountId} AND a.user_id = ${userId} AND a.kind = 'deposit' AND a.deleted_at IS NULL`);
}

export type DepositAccount = NonNullable<Awaited<ReturnType<typeof readDepositAccount>>>;

async function balancesByDay(tx: Tx, accountId: string, firstDay: string, beforeDate: string) {
  const amounts = await rows<{ date: string; amountMinor: string }>(tx, sql`
    SELECT CAST(GREATEST(financial_date, CAST(${firstDay} AS DATE)) AS CHAR) AS date,
      CAST(SUM(amount_minor) AS CHAR) AS amountMinor
    FROM (
      SELECT v.financial_date, m.amount_minor ${postedMovementsFor(sql`${accountId}`)} AND v.financial_date < ${beforeDate}
      UNION ALL
      SELECT financial_date, delta_minor FROM balance_adjustments
      WHERE account_id = ${accountId} AND financial_date < ${beforeDate}
    ) changes GROUP BY date`);
  return new Map(amounts.map(({ date, amountMinor }) => [date, BigInt(amountMinor)]));
}

async function readUnmatchedCredits(tx: Tx, accountId: string, fromDate: string, today: string) {
  return rows<ExistingInterest>(tx, sql`
    SELECT t.id AS transactionId, CAST(v.financial_date AS CHAR) AS date, CAST(m.amount_minor AS CHAR) AS amountMinor
    ${postedMovementsFor(sql`${accountId}`)}
    AND t.kind = 'income' AND v.category_id = ${categoryId} AND v.financial_date BETWEEN ${fromDate} AND ${today}
    AND NOT EXISTS (SELECT 1 FROM deposit_interest_periods p WHERE p.transaction_id = t.id)
    ORDER BY v.financial_date, t.id`);
}

function duePeriods(account: DepositAccount, today: string) {
  const periods: DepositPeriod[] = [];
  let next = nextDepositPeriod(account.startDate, account.maturityDate, account.lastDate ?? account.startDate);
  if ((next?.date ?? null) !== account.nextDate) throw new Error('Invalid deposit interest calendar');
  while (next && next.date <= today && periods.length < periodsPerBatch) {
    periods.push(next);
    next = nextDepositPeriod(account.startDate, account.maturityDate, next.date);
  }
  return periods;
}

export async function planDepositInterest(tx: Tx, userId: string, account: DepositAccount, now: number, automatic = false): Promise<Plan> {
  const plan: Plan = { periods: [], settlements: [] };
  if (!account.nextDate) return plan;
  const { today } = await readProfileCalendar(tx, userId, now);
  if (account.nextDate > today) return plan;
  if (automatic && account.reviewBefore !== null) {
    const cutoff = await readProfileCalendar(tx, userId, account.reviewBefore);
    if (account.nextDate <= cutoff.today) return plan;
  }

  const { accountId, maturityDate, openingMinor, rate } = account;
  const { competingRuleId, pending } = await readDepositScheduleBlockers(tx, userId, accountId, now, maturityDate);
  if (competingRuleId) return { ...plan, blockedBy: { ruleId: competingRuleId, reason: 'competing' } };

  const periods = duePeriods(account, today);
  const first = periods[0];
  const amountsByDate = await balancesByDay(tx, accountId, first.fromDate, periods.at(-1)!.date);
  let balance = BigInt(openingMinor);
  const credits = await readUnmatchedCredits(tx, accountId, first.fromDate, today);
  const usedCredits = new Set<string>();
  const adjustments = await rows<Adjustment>(tx, sql`
    SELECT id AS adjustmentId, CAST(financial_date AS CHAR) AS date, CAST(covered_through AS CHAR) AS coveredThrough,
      CAST(actual_balance_minor AS CHAR) AS actualBalanceMinor
    FROM balance_adjustments WHERE account_id = ${accountId} AND covered_through >= ${first.date}
    ORDER BY account_version`);

  for (const { fromDate, date, fullDays } of periods) {
    if (pending && (pending.date < date || (pending.date === date && pending.interest))) {
      plan.blockedBy = { ruleId: pending.ruleId, reason: 'pending' };
      break;
    }
    let positiveBalanceDays = 0n;
    for (let day = Temporal.PlainDate.from(fromDate), end = Temporal.PlainDate.from(date);
      Temporal.PlainDate.compare(day, end) < 0; day = day.add({ days: 1 })) {
      balance += amountsByDate.get(day.toString()) ?? 0n;
      if (balance > 0n) positiveBalanceDays += balance;
    }

    const amount = depositInterestAmount(positiveBalanceDays, rate, fullDays);
    const calculatedMinor = amount.toString();
    const period = { fromDate, date, calculatedMinor };
    const unmatched = credits.filter((item) => item.date >= fromDate && !usedCredits.has(item.transactionId));
    const onDate = unmatched.filter((item) => item.date === date);
    const covered = adjustments.filter((item) => item.coveredThrough >= date)
      .map(({ coveredThrough: _coveredThrough, ...item }) => item);
    let settlement: Settlement;
    if (onDate.length === 1 && onDate[0].amountMinor === calculatedMinor) {
      usedCredits.add(onDate[0].transactionId);
      settlement = { period: { ...period, status: 'existing', recordedMinor: calculatedMinor, changeMinor: '0' },
        outcome: 'existing', transactionId: onDate[0].transactionId };
    } else if (amount === 0n && onDate.length === 0) {
      settlement = { period: { ...period, status: 'zero', recordedMinor: '0', changeMinor: '0' }, outcome: 'zero' };
    } else if (unmatched.length || covered.length || amount > maxMovementMinor) {
      plan.periods.push({ ...period, status: 'review', recordedMinor: onDate.length === 1 ? onDate[0].amountMinor : null,
        changeMinor: null, transactions: unmatched, adjustments: covered, canPost: amount <= maxMovementMinor });
      break;
    } else {
      balance += amount;
      settlement = { period: { ...period, status: 'post', recordedMinor: '0', changeMinor: calculatedMinor }, outcome: 'posted' };
    }
    plan.periods.push(settlement.period);
    plan.settlements.push(settlement);
  }
  return plan;
}

export function depositInterestPreview(account: DepositAccount, balanceMinor: string, plan: Plan): Preview {
  const { accountId, currency, nextDate } = account;
  const { periods, blockedBy } = plan;
  const preview = { accountId, currency, balanceMinor, nextDate, periods, ...(blockedBy && { blockedBy }) };
  const previewId = createHash('sha256').update(JSON.stringify([account.version, preview])).digest('hex');
  return { ...preview, previewId };
}

export function decideDepositInterest(plan: Plan, decision: Decision | undefined) {
  if (!decision) return plan.settlements;
  const period = plan.periods.at(-1);
  if (period?.status !== 'review') throw new AccessError(400, 'INVALID_REQUEST');
  let settlement: Settlement;
  if (decision.action === 'post' && period.canPost) {
    settlement = { period, outcome: period.calculatedMinor === '0' ? 'zero' : 'posted' };
  } else if (decision.action === 'useTransaction' && period.transactions?.some(
    ({ transactionId }) => transactionId === decision.transactionId,
  )) {
    settlement = { period, outcome: 'existing', transactionId: decision.transactionId };
  } else if (decision.action === 'useAdjustment' && period.adjustments?.some(
    ({ adjustmentId }) => adjustmentId === decision.adjustmentId,
  )) {
    settlement = { period, outcome: 'reconciled', adjustmentId: decision.adjustmentId };
  } else {
    throw new AccessError(400, 'INVALID_REQUEST');
  }
  return [...plan.settlements, settlement];
}

export async function settleDepositInterest(tx: Tx, userId: string, account: DepositAccount, now: number,
  settlements: Settlement[], post: (date: string, amountMinor: string) => Promise<string>, actorId: string | null = null,
) {
  if (!settlements.length) return;
  let posted = false;
  for (const settlement of settlements) {
    const { period: { date, fromDate, calculatedMinor }, outcome } = settlement;
    let transactionId = 'transactionId' in settlement ? settlement.transactionId : null;
    const adjustmentId = 'adjustmentId' in settlement ? settlement.adjustmentId : null;
    if (outcome === 'posted') {
      transactionId = await post(date, calculatedMinor);
      posted = true;
    }
    await tx.execute(sql`INSERT INTO deposit_interest_periods
      (account_id, payment_date, from_date, calculated_minor, outcome, transaction_id, adjustment_id)
      VALUES (${account.accountId}, ${date}, ${fromDate}, ${calculatedMinor}, ${outcome}, ${transactionId}, ${adjustmentId})`);
    await audit(tx, now, actorId === null ? 'operator' : 'user', 'deposit.interest.settled', actorId,
      userId, account.accountId, { from: date, to: outcome });
  }
  const next = nextDepositPeriod(account.startDate, account.maturityDate, settlements.at(-1)!.period.date);
  await tx.execute(sql`UPDATE accounts SET next_interest_date = ${next?.date ?? null}, version = version + ${posted ? 0 : 1}
    WHERE id = ${account.accountId}`);
}
