import { randomUUID } from 'node:crypto';
import type { Body, Result } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import { calculateScheduleDates, latestPossibleDueDate, nextLocalDayStart, scheduleSettingsAt, startOfLocalDay } from './calendar.ts';
import type { CalendarRule, RuleVersion, ScheduledDate, ScheduleWindow, ZoneVersion } from './calendar.ts';
import { retryFinanceWrite, runCommand } from './commands.ts';
import type { ActorRole, WithCommandAccess } from './commands.ts';
import { same, verifier } from './crypto.ts';
import { audit, one, rows } from './db.ts';
import type { Runner, Tx } from './db.ts';
import { AccessError } from './errors.ts';
import { normalizeTransactionSource, transactionSourceFields } from './transaction-source.ts';
import { readProfileCalendar } from './profile.ts';

type StoredVersion = {
  version: number;
  acceptedAt: number;
  effectiveAt: number;
  amountMinor: string | null;
  categoryId: string | null;
  setsComment: number;
  comment: string | null;
  setsSource: number;
  source: string | null;
  setsEndDate: number;
  endDate: string | null;
  state: RuleVersion['changes']['state'] | null;
};
type CalendarRow = Omit<CalendarRule, 'versions'> & {
  userId: string;
  currency: RuleResult['currency'];
  versions: StoredVersion[] | null;
  zones: ZoneVersion[] | null;
  processedThrough: string | null;
  recoveryHeld: number;
  outcomes: (Omit<StoredOutcome, 'source'> & { source: string | null })[] | null;
  failures: (ScheduleFailure & { date: string })[] | null;
  replacesRuleId: string | null;
  previousTransitionDate: string | null;
  predecessorDeletedAt: number | null;
  replacedByRuleId: string | null;
  successorCreatedAt: number | null;
  successorStartsAt: number | null;
  successorDeletedAt: number | null;
};
type ScheduleSelection = NonNullable<Body<'reconcileAccountBalance'>['skippedDates']>[number];
type PreviewDate = Result<'previewBalanceAdjustment'>['dates'][number];
type StoredOutcome = Omit<PreviewDate, 'reason' | 'adjustmentId' | 'transactionId' | 'sourceOccurrenceId' | 'recoveryHeld'> & {
  status: 'posted' | 'skipped'; reason: string | null; adjustmentId: string | null; transactionId: string | null;
  sourceOccurrenceId: string | null;
};
type RuleResult = Result<'getScheduleRule'>;
type RuleCreate = Body<'createScheduleRule'> | Body<'adminCreateScheduleRule'>;
type RuleChange = Body<'changeScheduleRule'> | Body<'adminChangeScheduleRule'>;
type ReplacementInput = Body<'replaceScheduleRule'> | Body<'adminReplaceScheduleRule'>;
type ReplacementPreview = Result<'previewScheduleRuleReplacement'>;
type ReplacementDecision = ReplacementInput['decisions'][number];
type ScheduleFilter = { accountId?: string; ruleId?: string };
export type ScheduleFailureCode = NonNullable<PreviewDate['errorCode']>;
type ScheduleFailure = { attempts: number; errorCode: ScheduleFailureCode; nextAttemptAt: number | null; failureRevision: string };
const maxAmountMinor = 9223372036854775807n;

async function readCalendars(db: Runner, userId: string | undefined, asOf: number, filter: ReturnType<typeof sql>,
  mode: 'rules' | 'calendar' | 'posting' | ScheduleWindow = 'calendar',
  limit?: number,
) {
  const outcomes = mode === 'rules' || mode === 'posting' ? sql`NULL` : sql`(
    SELECT JSON_ARRAYAGG(JSON_OBJECT(
      'ruleId', o.rule_id, 'date', CAST(o.scheduled_date AS CHAR), 'dueAt', o.due_at, 'ruleVersion', o.rule_version,
      'kind', r.kind, 'amountMinor', CAST(o.amount_minor AS CHAR), 'categoryId', o.category_id, 'comment', o.comment,
      'source', o.income_source, 'status', o.status, 'reason', o.reason, 'adjustmentId', o.adjustment_id, 'transactionId', o.transaction_id,
      'sourceOccurrenceId', o.source_occurrence_id
    )) FROM schedule_occurrences o WHERE o.rule_id = r.id AND o.recorded_at <= ${asOf}
    ${mode === 'calendar' ? sql`` : sql`AND o.scheduled_date BETWEEN ${mode.fromDate} AND ${mode.throughDate}`}
  )`;
  const failures = typeof mode === 'object' ? sql`(
    SELECT JSON_ARRAYAGG(JSON_OBJECT('date', CAST(f.scheduled_date AS CHAR), 'attempts', f.attempts,
      'errorCode', f.error_code, 'nextAttemptAt', f.next_attempt_at, 'failureRevision', f.revision))
    FROM schedule_date_failures f WHERE f.rule_id = r.id AND f.recorded_at <= ${asOf}
      AND f.scheduled_date BETWEEN ${mode.fromDate} AND ${mode.throughDate}
      AND (r.processed_through IS NULL OR f.scheduled_date > r.processed_through)
  )` : sql`NULL`;
  // A single read keeps the rule, its edits, and the owner's zone history in one snapshot.
  const rules = await rows<CalendarRow>(db, sql`
    SELECT r.id, a.user_id AS userId, r.account_id AS accountId, r.kind, r.frequency, r.first_date AS firstDate, r.created_at AS createdAt,
      r.starts_at AS startsAt, r.ends_before_date AS endsBeforeDate, r.processed_through AS processedThrough,
      r.recovery_held AS recoveryHeld, a.currency,
      r.replaces_rule_id AS replacesRuleId, p.ends_before_date AS previousTransitionDate,
      p.deleted_at AS predecessorDeletedAt, s.id AS replacedByRuleId, s.created_at AS successorCreatedAt,
      s.starts_at AS successorStartsAt, s.deleted_at AS successorDeletedAt,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'version', v.version, 'acceptedAt', v.accepted_at, 'effectiveAt', v.effective_at,
        'amountMinor', CAST(v.amount_minor AS CHAR), 'categoryId', v.category_id,
        'setsComment', v.sets_comment, 'comment', v.comment, 'setsSource', v.sets_income_source,
        'source', v.income_source, 'setsEndDate', v.sets_end_date,
        'endDate', CAST(v.end_date AS CHAR), 'state', v.state
      )) FROM schedule_rule_versions v WHERE v.rule_id = r.id AND v.accepted_at <= ${asOf}) AS versions,
      ${mode === 'rules' ? sql`NULL` : sql`
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('effectiveAt', z.effective_at, 'timeZone', z.time_zone))
        FROM user_time_zone_versions z WHERE z.user_id = a.user_id AND z.effective_at <= ${asOf})`} AS zones,
      ${outcomes} AS outcomes, ${failures} AS failures
    FROM schedule_rules r JOIN accounts a ON a.id = r.account_id
    LEFT JOIN schedule_rules p ON p.id = r.replaces_rule_id
    LEFT JOIN schedule_rules s ON s.replaces_rule_id = r.id
    WHERE r.deleted_at IS NULL AND a.deleted_at IS NULL AND r.created_at <= ${asOf} AND ${filter}
      ${userId === undefined ? sql`` : sql`AND a.user_id = ${userId}`}
    ORDER BY r.id ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}`);
  return rules.map(({ userId, versions, zones, processedThrough, recoveryHeld, outcomes, failures, currency, replacesRuleId,
    previousTransitionDate, predecessorDeletedAt, replacedByRuleId, successorCreatedAt, successorStartsAt,
    successorDeletedAt, endsBeforeDate, ...fields }) => {
    const history = (versions ?? []).map((row): RuleVersion => {
      const changes: RuleVersion['changes'] = {};
      if (row.amountMinor !== null) changes.amountMinor = row.amountMinor;
      if (row.categoryId !== null) changes.categoryId = row.categoryId;
      if (row.setsComment) changes.comment = row.comment;
      if (row.setsSource) changes.source = row.source;
      if (row.setsEndDate) changes.endDate = row.endDate;
      if (row.state) changes.state = row.state;
      return { version: row.version, acceptedAt: row.acceptedAt, effectiveAt: row.effectiveAt, changes };
    });
    history.sort((a, b) => a.version - b.version);
    const replaces = replacesRuleId && previousTransitionDate && fields.startsAt !== null
      ? { ruleId: replacesRuleId, transitionDate: previousTransitionDate, transitionAt: fields.startsAt } : undefined;
    const replacedBy = replacedByRuleId && endsBeforeDate && successorCreatedAt !== null && successorCreatedAt <= asOf &&
      successorStartsAt !== null
      ? { ruleId: replacedByRuleId, transitionDate: endsBeforeDate, transitionAt: successorStartsAt } : undefined;
    // The replacement ends the old series by date. Keep the structural version out of occurrence parameters.
    return { rule: { ...fields, endsBeforeDate: replacedByRuleId && !replacedBy ? null : endsBeforeDate,
      versions: replacedBy ? history.slice(0, -1) : history }, userId,
      latestVersion: history.at(-1), replaces, replacedBy, predecessorDeletedAt, successorDeletedAt,
      currency, zones: zones ?? [], processedThrough, recoveryHeld: Boolean(recoveryHeld),
      outcomes: new Map((outcomes ?? []).map(({ source, ...outcome }) =>
        [outcome.date, { ...outcome, ...transactionSourceFields(outcome.kind, source) }])),
      failures: failures ?? [] };
  });
}

type StoredCalendar = Awaited<ReturnType<typeof readCalendars>>[number];
const lastStoredDate = '9999-12-31';

function summarizeRule({ rule, currency, latestVersion, replaces, replacedBy, predecessorDeletedAt, successorDeletedAt,
  recoveryHeld }: StoredCalendar): RuleResult {
  const { settings } = scheduleSettingsAt(rule.versions, Infinity);
  const { amountMinor, categoryId, state, comment = null, source, endDate = null } = settings;
  if (!latestVersion || amountMinor === undefined || categoryId === undefined || state === undefined) {
    throw new Error('Incomplete schedule rule');
  }
  return { ruleId: rule.id, accountId: rule.accountId, currency, kind: rule.kind, frequency: rule.frequency,
    firstDate: rule.firstDate, amountMinor, categoryId, comment, endDate, state: replacedBy ? 'ended' : state,
    ruleVersion: latestVersion.version, effectiveAt: latestVersion.effectiveAt, ...transactionSourceFields(rule.kind, source),
    ...(replaces && predecessorDeletedAt === null && { replaces }), ...(replacedBy && successorDeletedAt === null && { replacedBy }),
    ...(recoveryHeld && { recoveryHeld: true as const }) };
}

async function requireScheduleAccount(tx: Tx, userId: string, accountId: string, lock = false) {
  const account = await one<{ archived: number; startDate: string }>(tx, sql`
    SELECT archived, start_date AS startDate FROM accounts
    WHERE id = ${accountId} AND user_id = ${userId} AND deleted_at IS NULL ${lock ? sql`FOR UPDATE` : sql``}`);
  if (!account) throw new AccessError(404, 'NOT_FOUND');
  if (lock && account.archived) throw new AccessError(409, 'ACCOUNT_UNAVAILABLE');
  return account;
}

export async function requireScheduleRuleAccount(tx: Tx, userId: string, ruleId: string, includeDeleted = false) {
  const rule = await one<{ accountId: string }>(tx, sql`
    SELECT r.account_id AS accountId FROM schedule_rules r JOIN accounts a ON a.id = r.account_id
    WHERE r.id = ${ruleId} AND a.user_id = ${userId} ${includeDeleted ? sql`` : sql`AND r.deleted_at IS NULL`}`);
  if (!rule) throw new AccessError(404, 'NOT_FOUND');
  return rule.accountId;
}

export async function getScheduleRule(tx: Tx, userId: string, ruleId: string, now: number) {
  const [calendar] = await readCalendars(tx, userId, now, sql`r.id = ${ruleId}`, 'rules');
  if (!calendar) throw new AccessError(404, 'NOT_FOUND');
  return summarizeRule(calendar);
}

export async function listScheduleRules(tx: Tx, userId: string, now: number, accountId?: string) {
  if (accountId) await requireScheduleAccount(tx, userId, accountId);
  const calendars = await readCalendars(tx, userId, now, accountId ? sql`r.account_id = ${accountId}` : sql`TRUE`, 'rules');
  return { rules: calendars.map(summarizeRule) };
}

export async function listScheduleOccurrences(tx: Tx, userId: string, window: ScheduleWindow, { accountId, ruleId }: ScheduleFilter) {
  validateScheduleWindow(window);
  if (accountId) await requireScheduleAccount(tx, userId, accountId);
  if (ruleId) {
    const ruleAccountId = await requireScheduleRuleAccount(tx, userId, ruleId);
    if (accountId && accountId !== ruleAccountId) throw new AccessError(404, 'NOT_FOUND');
  }
  const calendars = await readCalendars(tx, userId, window.asOf,
    ruleId ? sql`r.id = ${ruleId}` : accountId ? sql`r.account_id = ${accountId}` : sql`TRUE`, window);
  const occurrences = calendars.flatMap((calendar) => effectiveScheduleDates(calendar, window)
    .map((date) => ({ ...date, accountId: calendar.rule.accountId, currency: calendar.currency })));
  return { occurrences: occurrences.sort(compareOccurrences) };
}

export async function getNextPayment(tx: Tx, userId: string, now: number): Promise<Result<'getNextPayment'>> {
  const { today } = await readProfileCalendar(tx, userId, now);
  const window = { fromDate: today, throughDate: lastStoredDate, asOf: now };
  const calendars = await readCalendars(tx, userId, now,
    sql`r.kind = 'expense' AND r.recovery_held = FALSE AND a.archived = FALSE`, window);
  let payment: Result<'getNextPayment'>['payment'] = null;
  for (const calendar of calendars) {
    if (calendar.processedThrough === lastStoredDate) continue;
    const lastEffectiveAt = calendar.rule.versions.reduce((latest, version) => Math.max(latest, version.effectiveAt), 0);
    const throughDate: string = payment?.date ?? window.throughDate;
    const fromDate = calendar.processedThrough !== null && calendar.processedThrough >= today
      ? Temporal.PlainDate.from(calendar.processedThrough).add({ days: 1 }).toString() : today;
    if (fromDate > throughDate) continue;
    for (const date of calculateScheduleDates(calendar.rule, calendar.zones, { ...window, fromDate, throughDate })) {
      if (date.status === 'paused') {
        if (date.dueAt >= lastEffectiveAt) break;
        continue;
      }
      if (calendar.outcomes.has(date.date)) continue;
      const failure = date.dueAt <= now ? calendar.failures.find((failure) => failure.date === date.date) : undefined;
      const occurrence = { ...date, currency: calendar.currency };
      const candidate = failure ? { ...occurrence, attempts: failure.attempts, errorCode: failure.errorCode,
        failureRevision: failure.failureRevision,
        status: failure.nextAttemptAt === null ? 'needs_intervention' as const : 'retrying' as const,
        nextAttemptAt: failure.nextAttemptAt ?? undefined } : occurrence;
      if (!payment || compareOccurrences(candidate, payment) < 0) payment = candidate;
      break;
    }
  }
  return { payment };
}

async function validateRuleAmountAndCategory(tx: Tx, kind: RuleResult['kind'], amountMinor?: string, categoryId?: string) {
  if (amountMinor !== undefined && (BigInt(amountMinor) <= 0n || BigInt(amountMinor) > maxAmountMinor)) {
    throw new AccessError(400, 'INVALID_REQUEST');
  }
  if (categoryId !== undefined && !await one(tx, sql`SELECT id FROM categories WHERE id = ${categoryId} AND kind = ${kind}`)) {
    throw new AccessError(400, 'INVALID_REQUEST');
  }
}

function validateRuleEnd(frequency: RuleResult['frequency'], firstDate: string, endDate?: string | null) {
  if (endDate != null && (frequency === 'once' || endDate < firstDate)) throw new AccessError(400, 'INVALID_REQUEST');
}

async function insertRuleVersion(tx: Tx, ruleId: string, { version, acceptedAt, effectiveAt, changes }: RuleVersion) {
  await tx.execute(sql`INSERT INTO schedule_rule_versions
    (rule_id, version, accepted_at, effective_at, amount_minor, category_id, sets_comment, comment,
      sets_income_source, income_source, sets_end_date, end_date, state)
    VALUES (${ruleId}, ${version}, ${acceptedAt}, ${effectiveAt}, ${changes.amountMinor ?? null}, ${changes.categoryId ?? null},
      ${changes.comment !== undefined}, ${changes.comment ?? null}, ${changes.source !== undefined}, ${changes.source ?? null},
      ${changes.endDate !== undefined}, ${changes.endDate ?? null},
      ${changes.state ?? null})`);
}

export function createScheduleRule(withAccess: WithCommandAccess, input: RuleCreate, role: ActorRole = 'user') {
  return retryFinanceWrite(() => withAccess(async (tx, userId, now, actorId) => {
    const { accountId, kind, frequency, firstDate, amountMinor, categoryId, comment = null, endDate = null } = input;
    const source = normalizeTransactionSource(kind, input);
    const account = await requireScheduleAccount(tx, userId, accountId, true);
    if (firstDate < account.startDate) throw new AccessError(400, 'INVALID_REQUEST');
    validateRuleEnd(frequency, firstDate, endDate);
    await validateRuleAmountAndCategory(tx, kind, amountMinor, categoryId);

    const ruleId = randomUUID();
    await tx.execute(sql`INSERT INTO schedule_rules (id, account_id, kind, frequency, first_date, created_at)
      VALUES (${ruleId}, ${accountId}, ${kind}, ${frequency}, ${firstDate}, ${now})`);
    await insertRuleVersion(tx, ruleId, { version: 1, acceptedAt: now, effectiveAt: now,
      changes: { amountMinor, categoryId, comment, source, endDate, state: 'active' } });
    await audit(tx, now, role, 'schedule.rule.created', actorId, userId, ruleId,
      { from: '0', to: '1', ...('reason' in input && { reason: input.reason }) });
    return getScheduleRule(tx, userId, ruleId, now);
  }));
}

const lifecycleState = { pause: 'paused', resume: 'active', end: 'ended' } as const;
const ruleEvents = { edit: 'edited', pause: 'paused', resume: 'resumed', end: 'ended' } as const;

export function changeScheduleRule(withAccess: WithCommandAccess, ruleId: string, input: RuleChange, role: ActorRole = 'user') {
  return retryFinanceWrite(() => withAccess(async (tx, userId, now, actorId) => {
    // The access wrapper holds the owner. Resolve the account without taking the rule lock first.
    const accountId = await requireScheduleRuleAccount(tx, userId, ruleId);
    await requireScheduleAccount(tx, userId, accountId, true);
    const locked = await one<{ endsBeforeDate: string | null }>(tx, sql`
      SELECT ends_before_date AS endsBeforeDate FROM schedule_rules WHERE id = ${ruleId} AND account_id = ${accountId} FOR UPDATE`);
    if (!locked) throw new AccessError(404, 'NOT_FOUND');

    const current = await getScheduleRule(tx, userId, ruleId, now);
    if (current.ruleVersion !== input.expectedRuleVersion) throw new AccessError(409, 'VERSION_CONFLICT');
    const { action } = input;
    if (current.recoveryHeld || locked.endsBeforeDate || current.state === 'ended' || (action === 'pause' && current.state !== 'active') ||
        (action === 'resume' && current.state !== 'paused')) throw new AccessError(409, 'SCHEDULE_RULE_STATE_CONFLICT');

    let changes: RuleVersion['changes'];
    if (action === 'edit') {
      const { amountMinor, categoryId, comment, endDate } = input;
      const source = normalizeTransactionSource(current.kind, input);
      if (amountMinor === undefined && categoryId === undefined && comment === undefined &&
          source === undefined && endDate === undefined) {
        throw new AccessError(400, 'INVALID_REQUEST');
      }
      validateRuleEnd(current.frequency, current.firstDate, endDate);
      await validateRuleAmountAndCategory(tx, current.kind, amountMinor, categoryId);
      changes = { amountMinor, categoryId, comment, source, endDate };
    } else {
      changes = { state: lifecycleState[action] };
    }

    const { timeZone } = await readProfileCalendar(tx, userId, now);
    const effectiveAt = nextLocalDayStart(now, timeZone);
    const version = current.ruleVersion + 1;
    await insertRuleVersion(tx, ruleId, { version, acceptedAt: now, effectiveAt, changes });
    await audit(tx, now, role, 'schedule.rule.' + ruleEvents[action], actorId, userId, ruleId,
      { from: String(current.ruleVersion), to: String(version), ...('reason' in input && { reason: input.reason }) });
    return getScheduleRule(tx, userId, ruleId, now);
  }));
}

const replacementConflict = new AccessError(409, 'SCHEDULE_REPLACEMENT_CONFLICT');

export async function previewScheduleRuleReplacement(tx: Tx, userId: string, now: number, ruleId: string, accountId: string,
  previewKey: Buffer,
): Promise<ReplacementPreview> {
  const sourceAccountId = await requireScheduleRuleAccount(tx, userId, ruleId);
  const source = await requireScheduleAccount(tx, userId, sourceAccountId);
  const target = sourceAccountId === accountId ? source : await requireScheduleAccount(tx, userId, accountId);
  if (source.archived || target.archived) throw new AccessError(409, 'ACCOUNT_UNAVAILABLE');
  const calendar = await readReplacementCalendar(tx, userId, ruleId, now);
  return calculateReplacementPreview(tx, userId, now, calendar, accountId, target.startDate, previewKey);
}

async function readReplacementCalendar(tx: Tx, userId: string, ruleId: string, now: number) {
  const [calendar] = await readCalendars(tx, userId, now, sql`r.id = ${ruleId}`, 'posting');
  if (!calendar) throw new AccessError(404, 'NOT_FOUND');
  return calendar;
}

async function calculateReplacementPreview(tx: Tx, userId: string, now: number, calendar: StoredCalendar, accountId: string,
  targetStartDate: string, previewKey: Buffer,
): Promise<ReplacementPreview> {
  const { rule, zones, replaces, replacedBy } = calendar;
  if (replacedBy) throw replacementConflict;
  const { ruleVersion, state } = summarizeRule(calendar);
  if (calendar.recoveryHeld || rule.endsBeforeDate || state === 'ended' || (rule.startsAt !== null && now < rule.startsAt)) {
    throw new AccessError(409, 'SCHEDULE_RULE_STATE_CONFLICT');
  }
  const { today, timeZone } = await readProfileCalendar(tx, userId, now);
  let transition = Temporal.PlainDate.from(today).add({ days: 1 });
  if (transition.year > 9999) throw new AccessError(409, 'SCHEDULE_RULE_STATE_CONFLICT');
  const fromDate = transition.toString();
  const through = latestPossibleDueDate(now);
  const throughDate = through.startsWith('+') ? lastStoredDate : through;
  for (const date of calculateScheduleDates(rule, zones, { fromDate, throughDate, asOf: now })) {
    if (date.dueAt > now) break;
    transition = Temporal.PlainDate.from(date.date).add({ days: 1 });
  }
  if (replaces && transition.toString() <= replaces.transitionDate) {
    transition = Temporal.PlainDate.from(replaces.transitionDate).add({ days: 1 });
  }
  if (transition.year > 9999) throw new AccessError(409, 'SCHEDULE_RULE_STATE_CONFLICT');

  const transitionDate = transition.toString();
  const transitionAt = Math.max(startOfLocalDay(transition, timeZone), rule.startsAt ?? rule.createdAt);
  const earliestFirstDate = targetStartDate > transitionDate ? targetStartDate : transitionDate;
  const skippedDates = await rows<ReplacementPreview['skippedDates'][number]>(tx, sql`
    SELECT scheduled_date AS date, id AS occurrenceId, adjustment_id AS adjustmentId, reason
    FROM schedule_occurrences
    WHERE rule_id = ${rule.id} AND scheduled_date >= ${transitionDate} AND status = 'skipped' AND adjustment_id IS NOT NULL
      AND recorded_at <= ${now}
    ORDER BY scheduled_date`);
  const previewToken = verifier(previewKey, 'schedule-replacement-preview', JSON.stringify([
    userId, rule.id, accountId, ruleVersion, transitionDate, transitionAt, earliestFirstDate, skippedDates.map(({ occurrenceId }) => occurrenceId),
  ]));
  return { ruleId: rule.id, accountId, ruleVersion, transitionDate, transitionAt, earliestFirstDate, skippedDates, previewToken };
}

function transferredSkips(decisions: ReplacementDecision[], preview: ReplacementPreview, rule: CalendarRule,
  zones: readonly ZoneVersion[], now: number,
) {
  if (decisions.length !== preview.skippedDates.length) throw new AccessError(400, 'INVALID_REQUEST');
  const targets = new Set<string>();
  const transfers: { date: ScheduledDate; source: ReplacementPreview['skippedDates'][number] }[] = [];
  for (const [index, { sourceDate, targetDate }] of decisions.entries()) {
    const source = preview.skippedDates[index];
    if (sourceDate !== source.date) throw new AccessError(400, 'INVALID_REQUEST');
    if (targetDate === null) continue;
    const date = calculateScheduleDates(rule, zones, { fromDate: targetDate, throughDate: targetDate, asOf: now }).next().value;
    if (!date || targets.has(targetDate)) throw new AccessError(400, 'INVALID_REQUEST');
    targets.add(targetDate);
    transfers.push({ date, source });
  }
  return transfers;
}

export function replaceScheduleRule(withAccess: WithCommandAccess, recoveryVersion: string, ruleId: string,
  input: ReplacementInput, previewKey: Buffer, role: ActorRole = 'user',
): Promise<Result<'replaceScheduleRule'>> {
  const { accountId, kind, frequency, firstDate, amountMinor, categoryId, comment = null, endDate = null,
    expectedRuleVersion, previewToken, idempotencyKey } = input;
  const reason = 'reason' in input ? input.reason : undefined;
  const source = normalizeTransactionSource(kind, input);
  const decisions = [...input.decisions].sort((a, b) => a.sourceDate.localeCompare(b.sourceDate));
  const parameters = [String(expectedRuleVersion), previewToken, kind, frequency, firstDate, amountMinor, categoryId,
    comment, endDate, reason ?? null, JSON.stringify(decisions.map(({ sourceDate, targetDate }) => [sourceDate, targetDate]))];
  if (source !== undefined) parameters.push(source);
  return runCommand(withAccess, 'schedule.replace', recoveryVersion, idempotencyKey, [ruleId, accountId], parameters,
    async (tx, userId, now, apply, actorId) => {
      const sourceAccountId = await requireScheduleRuleAccount(tx, userId, ruleId, true);
      await requireScheduleAccount(tx, userId, accountId);
      return apply(async () => {
        // Access holds the owner. Acquire account locks in the same order as ledger writes, then lock the source rule.
        if (sourceAccountId < accountId) await requireScheduleAccount(tx, userId, sourceAccountId, true);
        const { startDate } = await requireScheduleAccount(tx, userId, accountId, true);
        if (sourceAccountId > accountId) await requireScheduleAccount(tx, userId, sourceAccountId, true);
        await tx.execute(sql`SELECT id FROM schedule_rules WHERE id = ${ruleId} FOR UPDATE`);
        const calendar = await readReplacementCalendar(tx, userId, ruleId, now);
        if (calendar.latestVersion?.version !== expectedRuleVersion) throw new AccessError(409, 'VERSION_CONFLICT');
        const preview = await calculateReplacementPreview(tx, userId, now, calendar, accountId, startDate, previewKey);
        if (!same(preview.previewToken, previewToken)) throw replacementConflict;
        if (firstDate < preview.earliestFirstDate) throw new AccessError(400, 'INVALID_REQUEST');
        validateRuleEnd(frequency, firstDate, endDate);
        await validateRuleAmountAndCategory(tx, kind, amountMinor, categoryId);

        const { transitionDate, transitionAt } = preview;
        const newRuleId = randomUUID();
        const replacementSource = source === undefined && kind === calendar.rule.kind ? summarizeRule(calendar).source : source;
        const initial: RuleVersion = { version: 1, acceptedAt: now, effectiveAt: transitionAt,
          changes: { amountMinor, categoryId, comment, source: replacementSource, endDate, state: 'active' } };
        const newRule: CalendarRule = { id: newRuleId, accountId, kind, frequency, firstDate, createdAt: now,
          startsAt: transitionAt, endsBeforeDate: null, versions: [initial] };
        const transfers = transferredSkips(decisions, preview, newRule, calendar.zones, now);
        const previousRuleVersion = expectedRuleVersion + 1;
        await tx.execute(sql`UPDATE schedule_rules SET ends_before_date = ${transitionDate} WHERE id = ${ruleId}`);
        await insertRuleVersion(tx, ruleId, { version: previousRuleVersion, acceptedAt: now, effectiveAt: transitionAt, changes: {} });
        await tx.execute(sql`INSERT INTO schedule_rules (id, account_id, kind, frequency, first_date, created_at, starts_at, replaces_rule_id)
          VALUES (${newRuleId}, ${accountId}, ${kind}, ${frequency}, ${firstDate}, ${now}, ${transitionAt}, ${ruleId})`);
        await insertRuleVersion(tx, newRuleId, initial);
        for (const { date, source } of transfers) {
          await insertScheduleOutcome(tx, date, now, {
            status: 'skipped', reason: source.reason, adjustmentId: source.adjustmentId, sourceOccurrenceId: source.occurrenceId,
          });
        }
        await audit(tx, now, role, 'schedule.rule.replaced', actorId, userId, ruleId,
          { from: String(expectedRuleVersion), to: String(previousRuleVersion), ...(reason !== undefined && { reason }) });
        const replacementRule = await getScheduleRule(tx, userId, newRuleId, now);
        return { ruleId, accountId, transitionDate, transitionAt, previousRuleVersion, replacementRule, decisions };
      });
    }, role);
}

async function lockAccountCalendars(tx: Tx, userId: string, accountId: string, asOf: number) {
  // The caller already holds the owner and account locks. Schedule writes use the same order.
  await tx.execute(sql`SELECT id FROM schedule_rules WHERE account_id = ${accountId} AND deleted_at IS NULL ORDER BY id FOR UPDATE`);
  return readCalendars(tx, userId, asOf, sql`r.account_id = ${accountId}`);
}

function* datesAfterPosition({ rule, zones, processedThrough }: StoredCalendar, asOf: number, throughDate: string) {
  const window = { fromDate: processedThrough ?? rule.firstDate, throughDate, asOf };
  for (const date of calculateScheduleDates(rule, zones, window)) {
    if (processedThrough === null || date.date > processedThrough) yield date;
  }
}

export type ScheduleCandidate = { userId: string; accountId: string; ruleId: string; date: string };
type ScheduleOutcome = { status: 'posted'; transactionId: string }
  | { status: 'skipped'; reason: string; adjustmentId: string | null; sourceOccurrenceId?: string };

export async function scanScheduleRules(db: Runner, afterRuleId: string | null, now: number, limit: number) {
  const through = latestPossibleDueDate(now);
  return readCalendars(db, undefined, now, sql`
    r.recovery_held = FALSE AND r.first_date <= ${through}
    AND (r.processed_through IS NULL OR (r.processed_through < ${through} AND r.frequency <> 'once'))
    ${afterRuleId === null ? sql`` : sql`AND r.id > ${afterRuleId}`}`, 'posting', limit);
}

export async function readScheduleRuleForWorker(db: Runner, { userId, ruleId, accountId }: Omit<ScheduleCandidate, 'date'>, now: number) {
  const [calendar] = await readCalendars(db, userId, now,
    sql`r.id = ${ruleId} AND r.account_id = ${accountId} AND r.recovery_held = FALSE`, 'posting');
  return calendar;
}

export function nextDueScheduleDate(calendar: StoredCalendar, now: number) {
  const next = datesAfterPosition(calendar, now, latestPossibleDueDate(now)).next().value;
  return next && next.dueAt <= now ? next : undefined;
}

function readScheduleFailure(db: Runner, ruleId: string, date: string) {
  return one<ScheduleFailure>(db, sql`SELECT attempts, error_code AS errorCode, next_attempt_at AS nextAttemptAt,
    revision AS failureRevision
    FROM schedule_date_failures WHERE rule_id = ${ruleId} AND scheduled_date = ${date}`);
}

function clearScheduleFailure(tx: Tx, ruleId: string, date: string) {
  return tx.execute(sql`DELETE FROM schedule_date_failures WHERE rule_id = ${ruleId} AND scheduled_date = ${date}`);
}

async function insertScheduleOutcome(tx: Tx, date: ScheduledDate, now: number, outcome: ScheduleOutcome) {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO schedule_occurrences
    (id, rule_id, scheduled_date, due_at, rule_version, amount_minor, category_id, comment, income_source, status, recorded_at, reason,
      adjustment_id, transaction_id, source_occurrence_id)
    VALUES (${id}, ${date.ruleId}, ${date.date}, ${date.dueAt}, ${date.ruleVersion}, ${date.amountMinor},
      ${date.categoryId}, ${date.comment}, ${date.source ?? null}, ${outcome.status}, ${now}, ${outcome.status === 'skipped' ? outcome.reason : null},
      ${outcome.status === 'skipped' ? outcome.adjustmentId : null}, ${outcome.status === 'posted' ? outcome.transactionId : null},
      ${outcome.status === 'skipped' ? outcome.sourceOccurrenceId ?? null : null})`);
  await clearScheduleFailure(tx, date.ruleId, date.date);
  return id;
}

async function lockScheduleDate(tx: Tx, candidate: ScheduleCandidate, now: number, allowSettledPrefix = false) {
  // The financial service holds the owner and account locks.
  const { userId, accountId, ruleId, date } = candidate;
  const rule = await one<{ processedThrough: string | null; recoveryHeld: number }>(tx, sql`
    SELECT processed_through AS processedThrough, recovery_held AS recoveryHeld
    FROM schedule_rules WHERE id = ${ruleId} AND account_id = ${accountId} AND deleted_at IS NULL FOR UPDATE`);
  if (!rule) return;
  const stored = await one<ScheduleOutcome>(tx, sql`SELECT status, transaction_id AS transactionId, reason,
    adjustment_id AS adjustmentId FROM schedule_occurrences WHERE rule_id = ${ruleId} AND scheduled_date = ${date} FOR UPDATE`);
  const outcome = stored?.status === 'posted' ? { status: stored.status, transactionId: stored.transactionId }
    : stored && { status: stored.status, reason: stored.reason, adjustmentId: stored.adjustmentId };
  if (rule.recoveryHeld || (rule.processedThrough !== null && date <= rule.processedThrough)) {
    return { outcome, next: undefined };
  }

  const [calendar] = await readCalendars(tx, userId, now, sql`r.id = ${ruleId}`, 'posting');
  if (!calendar) return;

  const dates = datesAfterPosition(calendar, now, date);
  const first = dates.next().value;
  if (!first || first.dueAt > now) return;
  if (first.date === date) return { outcome, next: first };
  if (!allowSettledPrefix) return;

  // Reconciliation can settle a date before the worker has advanced past it.
  const settled = new Set((await rows<{ date: string }>(tx, sql`
    SELECT scheduled_date AS date FROM schedule_occurrences
    WHERE rule_id = ${ruleId} AND scheduled_date >= ${first.date} AND scheduled_date < ${date}`)).map((row) => row.date));
  if (!settled.has(first.date)) return;
  for (const next of dates) {
    if (next.dueAt > now) return;
    if (next.date === date) return { outcome, next };
    if (!settled.has(next.date)) return;
  }
}

const scheduleDateConflict = new AccessError(409, 'SCHEDULE_DATE_CONFLICT');

async function lockUnsettledScheduleDate(tx: Tx, candidate: ScheduleCandidate, now: number, expectedFailureRevision?: string) {
  const { userId, accountId, ruleId, date } = candidate;
  await requireScheduleAccount(tx, userId, accountId, true);
  const locked = await lockScheduleDate(tx, candidate, now, true);
  if (!locked?.next || locked.outcome) throw scheduleDateConflict;
  const failure = await readScheduleFailure(tx, ruleId, date);
  if (expectedFailureRevision !== undefined &&
      (!failure || failure.nextAttemptAt !== null || failure.failureRevision !== expectedFailureRevision)) {
    throw scheduleDateConflict;
  }
  return { next: locked.next, failure };
}

function advanceSchedulePosition(tx: Tx, ruleId: string, date: string) {
  return tx.execute(sql`UPDATE schedule_rules SET processed_through = ${date} WHERE id = ${ruleId}`);
}

export function skipScheduleOccurrence(withAccess: WithCommandAccess, recoveryVersion: string,
  { ruleId, date }: Pick<ScheduleCandidate, 'ruleId' | 'date'>,
  { idempotencyKey, reason }: Body<'skipScheduleOccurrence'>,
  access: { role: 'user' } | { role: 'admin'; expectedFailureRevision: string } = { role: 'user' },
): Promise<Result<'skipScheduleOccurrence'>> {
  const { role } = access;
  const expectedFailureRevision = access.role === 'admin' ? access.expectedFailureRevision : undefined;
  return runCommand(withAccess, 'schedule.skip', recoveryVersion, idempotencyKey, [ruleId, date],
    [reason, expectedFailureRevision ?? null], async (tx, userId, now, apply, actorId) => {
      const accountId = await requireScheduleRuleAccount(tx, userId, ruleId, true);
      return apply(async () => {
        const { next, failure } = await lockUnsettledScheduleDate(tx, { userId, accountId, ruleId, date }, now,
          expectedFailureRevision);
        if (next.status === 'paused' || (role === 'user' && failure?.errorCode === 'RECOVERY_UNCERTAIN')) {
          throw scheduleDateConflict;
        }
        const occurrenceId = await insertScheduleOutcome(tx, next, now, { status: 'skipped', reason, adjustmentId: null });
        await advanceSchedulePosition(tx, ruleId, date);
        await audit(tx, now, role, 'schedule.occurrence.skipped', actorId, userId, occurrenceId, {
          from: failure ? (failure.nextAttemptAt === null ? 'needs_intervention' : 'retrying') : next.status, to: 'skipped', reason,
        });
        return { ruleId, date, status: 'skipped', reason, occurrenceId };
      });
    }, role);
}

export function retryScheduleOccurrence(withAccess: WithCommandAccess, { ruleId, date }: Pick<ScheduleCandidate, 'ruleId' | 'date'>,
  { reason, expectedFailureRevision }: Body<'adminRetryScheduleOccurrence'>,
): Promise<Result<'adminRetryScheduleOccurrence'>> {
  return retryFinanceWrite(() => withAccess(async (tx, userId, now, actorId) => {
    const accountId = await requireScheduleRuleAccount(tx, userId, ruleId);
    const { next } = await lockUnsettledScheduleDate(tx, { userId, accountId, ruleId, date }, now, expectedFailureRevision);
    const status = next.status === 'paused' ? 'paused' : 'due';
    await clearScheduleFailure(tx, ruleId, date);
    await audit(tx, now, 'admin', 'schedule.occurrence.retried', actorId, userId, ruleId,
      { from: date, to: status, reason });
    return { ruleId, date, status };
  }));
}

export async function settleScheduleDate(tx: Tx, candidate: ScheduleCandidate, now: number, accountArchived: boolean,
  post: (date: ScheduledDate) => Promise<string>,
): Promise<ScheduleOutcome | undefined> {
  const locked = await lockScheduleDate(tx, candidate, now);
  if (!locked || !locked.next) return locked?.outcome;
  const { outcome, next } = locked;
  const { userId, ruleId, date } = candidate;

  if (!outcome) {
    const failure = await readScheduleFailure(tx, ruleId, date);
    if (failure && (failure.nextAttemptAt === null || failure.nextAttemptAt > now)) return;
  }

  if (!outcome && accountArchived) throw new AccessError(409, 'ACCOUNT_UNAVAILABLE');
  let settled = outcome;
  if (!settled && next.status === 'paused') {
    const reason = 'RULE_PAUSED';
    settled = { status: 'skipped', reason, adjustmentId: null };
    const occurrenceId = await insertScheduleOutcome(tx, next, now, settled);
    await audit(tx, now, 'operator', 'schedule.occurrence.skipped', null, userId, occurrenceId,
      { from: 'paused', to: 'skipped', reason });
  } else if (!settled) {
    settled = { status: 'posted', transactionId: await post(next) };
    await insertScheduleOutcome(tx, next, now, settled);
  }
  await advanceSchedulePosition(tx, ruleId, date);
  if (outcome) await clearScheduleFailure(tx, ruleId, date);
  return settled;
}

export async function recordScheduleFailure(tx: Tx, candidate: ScheduleCandidate, now: number, errorCode: ScheduleFailureCode,
  expectedAttempts: number,
) {
  const locked = await lockScheduleDate(tx, candidate, now);
  if (!locked?.next || locked.outcome) return;
  const { ruleId, date, userId } = candidate;
  const failure = await readScheduleFailure(tx, ruleId, date);
  if ((failure?.attempts ?? 0) !== expectedAttempts) return;
  if (failure && (failure.nextAttemptAt === null || failure.nextAttemptAt > now)) return;
  const attempts = (failure?.attempts ?? 0) + 1;
  const failureRevision = randomUUID();
  const nextAttemptAt = errorCode !== 'TEMPORARY_FAILURE' || attempts >= 5 ? null : now + 60_000 * 2 ** (attempts - 1);
  await tx.execute(sql`INSERT INTO schedule_date_failures
    (rule_id, scheduled_date, attempts, error_code, recorded_at, next_attempt_at, revision)
    VALUES (${ruleId}, ${date}, ${attempts}, ${errorCode}, ${now}, ${nextAttemptAt}, ${failureRevision})
    ON DUPLICATE KEY UPDATE attempts = ${attempts}, error_code = ${errorCode},
      recorded_at = ${now}, next_attempt_at = ${nextAttemptAt}, revision = ${failureRevision}`);
  if (nextAttemptAt === null) {
    await audit(tx, now, 'operator', 'schedule.occurrence.needs_intervention', null, userId, ruleId,
      { from: date, to: 'needs_intervention', reason: errorCode });
  }
  return { attempts, errorCode, nextAttemptAt, failureRevision };
}

export async function flagUncertainScheduleDate(tx: Tx, candidate: ScheduleCandidate, now: number, reason: string) {
  const { ruleId, date, userId, accountId } = candidate;
  const window = { asOf: now, fromDate: date, throughDate: date };
  const [calendar] = await readCalendars(tx, userId, now, sql`r.id = ${ruleId} AND r.account_id = ${accountId}`, window);
  if (!calendar?.recoveryHeld || calendar.outcomes.has(date) ||
      (calendar.processedThrough !== null && date <= calendar.processedThrough)) throw scheduleDateConflict;
  const scheduled = calculateScheduleDates(calendar.rule, calendar.zones, window).next().value;
  if (!scheduled || scheduled.dueAt > now) throw scheduleDateConflict;
  const existing = await readScheduleFailure(tx, ruleId, date);
  if (existing?.errorCode === 'RECOVERY_UNCERTAIN') return;
  const revision = randomUUID();
  await tx.execute(sql`INSERT INTO schedule_date_failures
    (rule_id, scheduled_date, attempts, error_code, recorded_at, next_attempt_at, revision)
    VALUES (${ruleId}, ${date}, 1, 'RECOVERY_UNCERTAIN', ${now}, NULL, ${revision})
    ON DUPLICATE KEY UPDATE attempts = 1, error_code = 'RECOVERY_UNCERTAIN',
      recorded_at = ${now}, next_attempt_at = NULL, revision = ${revision}`);
  await audit(tx, now, 'operator', 'schedule.occurrence.needs_intervention', null, userId, ruleId,
    { from: date, to: 'needs_intervention', reason });
}

export async function checkScheduleForArchive(tx: Tx, userId: string, accountId: string, asOf: number) {
  const calendars = await lockAccountCalendars(tx, userId, accountId, asOf);
  let hasFutureDates = false;
  for (const calendar of calendars) {
    for (const date of datesAfterPosition(calendar, asOf, lastStoredDate)) {
      if (date.dueAt > asOf) {
        hasFutureDates = true;
        break;
      }
      if (!calendar.outcomes.has(date.date)) throw new AccessError(409, 'SCHEDULE_DATES_PENDING');
    }
  }
  if (hasFutureDates) throw new AccessError(409, 'SCHEDULE_FUTURE_DATES');
}

function toPreviewDate({ accountId: _accountId, source, ...date }: ScheduledDate): PreviewDate {
  return { ...date, ...transactionSourceFields(date.kind, source) };
}

function effectiveScheduleDates(calendar: StoredCalendar, window: ScheduleWindow) {
  const dates = new Map([...calculateScheduleDates(calendar.rule, calendar.zones, window)]
    .map((date) => [date.date, { ...toPreviewDate(date), ...(calendar.recoveryHeld && { recoveryHeld: true as const }) }]));
  for (const { date, attempts, errorCode, nextAttemptAt, failureRevision } of calendar.failures) {
    const scheduled = dates.get(date);
    if (scheduled && scheduled.dueAt <= window.asOf) {
      dates.set(date, { ...scheduled, attempts, errorCode, failureRevision, status: nextAttemptAt === null ? 'needs_intervention' : 'retrying',
        ...(nextAttemptAt !== null && { nextAttemptAt }) });
    }
  }
  for (const outcome of calendar.outcomes.values()) {
    const { date, reason, adjustmentId, transactionId, sourceOccurrenceId, ...details } = outcome;
    if (date < window.fromDate || date > window.throughDate) continue;
    dates.set(date, { date, ...details, ...(reason !== null && { reason }), ...(adjustmentId !== null && { adjustmentId }),
      ...(transactionId !== null && { transactionId }), ...(sourceOccurrenceId !== null && { sourceOccurrenceId }) });
  }
  return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function readScheduleDates(db: Runner, userId: string, ruleId: string, window: ScheduleWindow) {
  const [calendar] = await readCalendars(db, userId, window.asOf, sql`r.id = ${ruleId}`, window);
  if (!calendar) return undefined;
  return effectiveScheduleDates(calendar, window).map((date) => ({ ...date, accountId: calendar.rule.accountId }));
}

export async function readAccountScheduleDates(tx: Tx, userId: string, accountId: string, window: ScheduleWindow) {
  validateScheduleWindow(window);
  const calendars = await readCalendars(tx, userId, window.asOf, sql`r.account_id = ${accountId}`, window);
  return calendars.flatMap((calendar) => effectiveScheduleDates(calendar, window)).sort(compareOccurrences);
}

function validateScheduleWindow(window: ScheduleWindow) {
  if (window.fromDate > window.throughDate ||
      Temporal.PlainDate.from(window.fromDate).until(window.throughDate).days > 366) {
    throw new AccessError(400, 'INVALID_REQUEST');
  }
}

function compareOccurrences(a: PreviewDate, b: PreviewDate) {
  return a.date.localeCompare(b.date) || a.ruleId.localeCompare(b.ruleId);
}

export function scheduleSelectionFingerprint(selection: ScheduleSelection) {
  const { ruleId, date, ruleVersion, dueAt, kind, amountMinor, categoryId, comment, reason } = selection;
  const fields = [ruleId, date, ruleVersion, dueAt, kind, amountMinor, categoryId, comment, reason];
  const source = selection.source ?? selection.incomeSource;
  if (source !== undefined) fields.push(source);
  return JSON.stringify(fields);
}

function sameScheduleParameters(date: ScheduledDate, selection: ScheduleSelection) {
  return date.ruleVersion === selection.ruleVersion && date.dueAt === selection.dueAt && date.kind === selection.kind &&
    date.amountMinor === selection.amountMinor && date.categoryId === selection.categoryId && date.comment === selection.comment &&
    (selection.source === undefined || date.source === selection.source) &&
    (selection.incomeSource === undefined || (date.kind === 'income' && date.source === selection.incomeSource));
}

export async function validateReconciliationDates(tx: Tx, userId: string, accountId: string, asOf: number,
  selections: ScheduleSelection[],
) {
  const calendars = await lockAccountCalendars(tx, userId, accountId, asOf);
  const byRule = new Map(calendars.map((calendar) => [calendar.rule.id, calendar]));
  const selected = new Map<string, Set<string>>();
  const validated: { date: ScheduledDate; reason: string }[] = [];
  for (const selection of selections) {
    const calendar = byRule.get(selection.ruleId);
    if (!calendar || calendar.recoveryHeld || calendar.outcomes.has(selection.date) ||
        calendar.failures.some((failure) => failure.date === selection.date && failure.errorCode === 'RECOVERY_UNCERTAIN') ||
        (calendar.processedThrough !== null && selection.date <= calendar.processedThrough)) {
      throw new AccessError(409, 'SCHEDULE_DATE_CONFLICT');
    }
    const dates = selected.get(selection.ruleId) ?? new Set<string>();
    if (dates.has(selection.date)) throw new AccessError(400, 'INVALID_REQUEST');
    dates.add(selection.date);
    selected.set(selection.ruleId, dates);
    const date = calculateScheduleDates(calendar.rule, calendar.zones,
      { fromDate: selection.date, throughDate: selection.date, asOf }).next().value;
    if (!date || !sameScheduleParameters(date, selection)) throw new AccessError(409, 'SCHEDULE_DATE_CONFLICT');
    validated.push({ date, reason: selection.reason });
  }

  for (const calendar of calendars) {
    for (const date of datesAfterPosition(calendar, asOf, latestPossibleDueDate(asOf))) {
      if (date.dueAt > asOf) break;
      if (calendar.outcomes.has(date.date) || selected.get(date.ruleId)?.has(date.date)) continue;
      throw new AccessError(409, 'SCHEDULE_DATES_PENDING');
    }
  }
  return validated;
}

export async function recordReconciliationSkips(tx: Tx, context: {
  adjustmentId: string; now: number; userId: string; actorId: string; actorRole: 'user' | 'admin';
}, skipped: Awaited<ReturnType<typeof validateReconciliationDates>>) {
  const { adjustmentId, now, userId, actorId, actorRole } = context;
  for (const { date, reason } of skipped) {
    const id = await insertScheduleOutcome(tx, date, now, { status: 'skipped', reason, adjustmentId });
    await audit(tx, now, actorRole, 'schedule.occurrence.skipped', actorId, userId, id,
      { from: date.status, to: 'skipped', reason });
  }
}
