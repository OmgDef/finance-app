import { Type as T } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import { endpoints } from './client.ts';

export const language = T.Union([T.Literal('en'), T.Literal('ru')]);
const email = T.String({ minLength: 3, maxLength: 254, pattern: '^\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*$' });
const pin = T.String({ pattern: '^[0-9]{4}$' });
const secret = T.String({ pattern: '^[a-f0-9]{64}$' });
const code = T.String({ minLength: 1, maxLength: 64 });
const id = T.String({ pattern: '^[a-f0-9-]{36}$' });
const expiry = T.String({ format: 'date-time' });
const recoveryVersion = T.String({ pattern: '^[1-9][0-9]{0,9}$', description: 'Current database recovery version' });
const mobileSession = T.Object({ token: secret, expiresAt: expiry, recoveryVersion });
const idempotencyKey = T.String({
  pattern: '^[1-9][0-9]{0,9}\\.[a-f0-9]{64}$',
  description: 'Recovery version, a dot, and 32 random bytes in lowercase hexadecimal. Scoped to the authenticated actor and command type.',
});
const commandWriteConflicts = 'IDEMPOTENCY_CONFLICT for changed parameters, COMMAND_CLOSED for a closed command, or COMMAND_REQUIRES_REVIEW for an unknown key from another recovery version.';
const currency = T.Union([T.Literal('EUR'), T.Literal('USD'), T.Literal('RUB')]);
const financialDate = T.String({ format: 'date', pattern: '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' });
const timeZone = T.String({ minLength: 1, maxLength: 64, description: 'IANA time zone identifier, for example Asia/Makassar.' });
const profile = T.Object({ id, email, recoveryVersion, timeZone, today: financialDate,
  timeZoneConfigured: T.Boolean({ description: 'Whether the user has selected a time zone. UTC is used until then.' }) });
const accountName = T.String({ maxLength: 255, pattern: '\\S' });
const balanceMinor = T.String({ pattern: '^(0|-?[1-9][0-9]*)$', description: 'Balance in minor units' });
const signedMinor = T.String({
  pattern: '^(0|-?[1-9][0-9]{0,18})$',
  description: 'Signed amount in minor units, between -9223372036854775808 and 9223372036854775807',
});
const ledgerVersion = T.Integer({ minimum: 1, maximum: 4294967295 });
const depositTerms = {
  type: T.Literal('deposit'),
  annualRatePercent: T.String({
    pattern: '^(0|[1-9][0-9]{0,2})(\\.[0-9]{1,4})?$',
    description: 'Informational annual rate in percent as a decimal string, from 0 to 999.9999. Responses use four fractional digits.',
  }),
  maturityDate: financialDate,
};
const accountBalanceFields = {
  accountId: id, name: accountName, currency, startDate: financialDate,
  accountVersion: T.Integer({ minimum: 1 }),
  balanceMinor,
  archived: T.Optional(T.Literal(true, { description: 'Present for archived accounts' })),
  needsReconciliation: T.Optional(T.Literal(true, { description: 'Present when an included movement has changed since the last reconciliation' })),
};
const accountBalance = T.Union([
  T.Object(accountBalanceFields, { additionalProperties: false }),
  T.Object({ ...accountBalanceFields, type: T.Literal('cash') }, { additionalProperties: false }),
  T.Object({ ...accountBalanceFields, ...depositTerms }, { additionalProperties: false }),
]);
const createAccountFields = {
  name: accountName, currency, startDate: financialDate, idempotencyKey,
  openingBalanceMinor: signedMinor,
};
const createAccountInput = T.Union([
  T.Object(createAccountFields, { additionalProperties: false }),
  T.Object({ ...createAccountFields, type: T.Literal('cash') }, { additionalProperties: false }),
  T.Object({ ...createAccountFields, ...depositTerms }, { additionalProperties: false }),
]);
const accountStartDateFields = { startDate: financialDate, expectedAccountVersion: ledgerVersion };
const accountParams = T.Object({ accountId: id });
const adminAccountParams = T.Object({ userId: id, accountId: id });
const scheduleDateFields = {
  ruleId: id, date: financialDate, ruleVersion: ledgerVersion,
  dueAt: T.Integer({ description: 'UTC Unix time in milliseconds' }),
  kind: T.Union([T.Literal('expense'), T.Literal('income')]),
  amountMinor: signedMinor, categoryId: T.String(), comment: T.Union([T.String(), T.Null()]),
};
const skipReason = T.String({ maxLength: 500, pattern: '\\S' });
export const scheduleFailureCode = T.Union([
  T.Literal('TEMPORARY_FAILURE'), T.Literal('SCHEDULE_DATA_INVALID'), T.Literal('RECOVERY_UNCERTAIN'),
]);
const scheduleOccurrence = T.Object({ ...scheduleDateFields,
  status: T.Union((['planned', 'due', 'paused', 'posted', 'skipped', 'retrying', 'needs_intervention'] as const)
    .map((status) => T.Literal(status))),
  reason: T.Optional(skipReason), adjustmentId: T.Optional(id), transactionId: T.Optional(id),
  sourceOccurrenceId: T.Optional(id),
  attempts: T.Optional(T.Integer({ minimum: 1, maximum: 5 })),
  errorCode: T.Optional(scheduleFailureCode),
  failureRevision: T.Optional(id),
  recoveryHeld: T.Optional(T.Literal(true, { description: 'Automatic processing is held pending review of the restored rule.' })),
  nextAttemptAt: T.Optional(T.Integer({ description: 'UTC Unix time in milliseconds. Present while waiting to retry.' })),
});
const skippedDate = T.Object({ ruleId: id, date: financialDate, reason: skipReason });
const selectedDate = T.Object({ ...scheduleDateFields, reason: skipReason }, { additionalProperties: false });
const reconciliationPreviewQuery = T.Object({ fromDate: financialDate, throughDate: financialDate });
const reconciliationPreviewDescription = 'Returns dates within the inclusive calendar range. The end date may be at most 366 days after the start date.';
const reconciliationPreviewFailures = { 400: 'INVALID_REQUEST for an invalid or too wide date range.' };
const reconciliationPreview = T.Object({
  accountId: id, accountVersion: ledgerVersion, balanceMinor, currency,
  dates: T.Array(scheduleOccurrence),
});
const reconciliationInput = T.Object({
  idempotencyKey, expectedAccountVersion: ledgerVersion, actualBalanceMinor: signedMinor,
  explanation: T.String({ maxLength: 500, pattern: '\\S' }),
  skippedDates: T.Optional(T.Array(selectedDate, { description: 'Dates already included in the factual balance. Copy the parameters from the preview and supply a reason for each. Omit the list or send an empty list when no dates are selected.' })),
}, { additionalProperties: false });
const balanceAdjustment = T.Object({
  adjustmentId: id, accountId: id, currency, accountVersion: ledgerVersion,
  balanceBeforeMinor: balanceMinor, actualBalanceMinor: signedMinor, deltaMinor: signedMinor,
  date: financialDate, createdAt: expiry, coveredThrough: financialDate, explanation: T.String(),
  actorRole: T.Union([T.Literal('user'), T.Literal('admin')]),
  skippedDates: T.Optional(T.Array(skippedDate)),
});
const adjustmentCursor = T.String({ pattern: '^[1-9][0-9]{0,9}$', description: 'Account version returned as the next page cursor' });
const adjustmentQuery = T.Object({ beforeVersion: T.Optional(adjustmentCursor) });
const adjustmentHistory = T.Object({ adjustments: T.Array(balanceAdjustment), next: T.Union([adjustmentCursor, T.Null()]) });
const accountNotFound = { 404: 'NOT_FOUND when the account is absent or belongs to another user.' };
const accountArchiveState = T.Object({ accountId: id, accountVersion: ledgerVersion, archived: T.Boolean(), balanceMinor });
const restoreFailures = {
  ...accountNotFound,
  503: 'TEMPORARY_FAILURE after exhausting transaction retries for a database lock error.',
};
const createAccountDescription = 'The start date must be today or earlier in the profile time zone. Deposits require an informational annual rate and a maturity date on or after the start date. Repeating the same key and equivalent payload returns the account details and balance at creation.';
const createAccountFailures = {
  400: 'INVALID_REQUEST for invalid account fields, a future start date, or a maturity date before the start date.',
  409: commandWriteConflicts,
  503: restoreFailures[503],
};
const updateAccountStartDateDescription = 'Moves the date of the opening balance in account history. Supply the current account version. The new date must be today or earlier in the profile time zone and no later than the maturity date for deposits. A successful change advances the version. Reload account history from the first page.';
const updateAccountStartDateFailures = {
  ...restoreFailures,
  400: 'INVALID_REQUEST for a future start date or a start date after deposit maturity.',
  409: 'ACCOUNT_START_DATE_CONFLICT when the start date would move past a transaction, reconciliation, or schedule rule. VERSION_CONFLICT for a stale version, or ACCOUNT_UNAVAILABLE for an archived account.',
};
const archiveFailures = {
  ...restoreFailures,
  409: 'ACCOUNT_BALANCE_NOT_ZERO for a nonzero balance, SCHEDULE_DATES_PENDING for an unfinished due date, or SCHEDULE_FUTURE_DATES for a rule with a future date, including a paused rule that can resume.',
};
const archiveDescription = 'Archives a zero-balance account once all due schedule dates have a final outcome and its rules have no remaining future dates. Account history stays readable. Repeating the command while it is archived returns its current state.';
const restoreDescription = 'Restores an archived account with its existing history. Repeating the command while it is active returns its current state.';
const reconciliationFailures = {
  ...accountNotFound,
  400: 'INVALID_REQUEST for duplicate selected dates or when the factual balance or computed delta is outside the signed BIGINT range.',
  409: 'VERSION_CONFLICT for a stale account version, SCHEDULE_DATE_CONFLICT for a changed or unavailable selected date, SCHEDULE_DATES_PENDING for unselected overdue dates, ACCOUNT_UNAVAILABLE for an archived account. ' + commandWriteConflicts,
  503: 'TEMPORARY_FAILURE after exhausting transaction retries for a database lock error.',
};
const reconciliationDescription = 'Saves the factual balance and its difference from the current balance, including zero. Selected dates already included in that balance are skipped in the same transaction. An identical retry returns the original adjustment.';
const cardParams = T.Object({ accountId: id, cardId: id });
const cardFields = {
  name: accountName,
  appearance: T.String({ pattern: '^#[0-9a-fA-F]{6}$', description: 'Card color in #RRGGBB format' }),
  lastFour: T.Union([T.String({ pattern: '^[0-9]{4}$' }), T.Null()]),
};
const cardInput = T.Object({ ...cardFields, lastFour: T.Optional(cardFields.lastFour) }, { additionalProperties: false });
const accountCard = T.Object({ cardId: id, accountId: id, ...cardFields, currency, balanceMinor });
const cardWriteFailures = {
  404: 'NOT_FOUND when the account is absent or belongs to another user, or the card does not belong to that account.',
  503: 'TEMPORARY_FAILURE after exhausting transaction retries for a database lock error.',
};
const transactionFields = {
  date: financialDate,
  comment: T.Optional(T.String({ maxLength: 500 })),
};
const positiveAmountMinor = T.String({
  pattern: '^[1-9][0-9]{0,18}$',
  description: 'Positive amount in minor units, at most 9223372036854775807',
});
const transactionVersionFields = { transactionId: id, transactionVersion: T.Integer({ minimum: 1 }) };
const transactionAccountFields = {
  accountId: id, accountVersion: T.Integer({ minimum: 1 }), currency,
  balanceMinor: T.String({ pattern: '^-?(0|[1-9][0-9]*)$', description: 'Account balance in minor units at commit' }),
};
const transactionAccount = T.Object(transactionAccountFields);
const incomeExpenseType = T.Union([T.Literal('expense'), T.Literal('income')]);
const categoryIdPattern = '^[a-z][a-z0-9_-]{0,63}$';
const singleAccountTransaction = {
  ...transactionFields, type: incomeExpenseType, accountId: id,
  amountMinor: positiveAmountMinor,
  categoryId: T.String({
    pattern: categoryIdPattern,
    description: 'Category of the matching transaction type. Use deposit-interest for deposit interest or other-income for other income.',
  }),
};
const transferTransaction = {
  ...transactionFields, type: T.Literal('transfer'),
  fromAccountId: id, toAccountId: id, fromAmountMinor: positiveAmountMinor, toAmountMinor: positiveAmountMinor,
};
const transactionRecord = T.Union([
  T.Object({ ...transactionVersionFields, ...transactionAccountFields }, { additionalProperties: false }),
  T.Object({ ...transactionVersionFields, fromAccount: transactionAccount, toAccount: transactionAccount },
    { additionalProperties: false }),
]);
const transactionParams = T.Object({ transactionId: id });
const adminTransactionParams = T.Object({ userId: id, transactionId: id });
const expectedTransactionVersion = ledgerVersion;
const versionedCommand = { idempotencyKey, expectedTransactionVersion };
const adminVersionedCommand = {
  ...versionedCommand,
  reason: T.String({ maxLength: 500, pattern: '\\S' }),
  expectedAccounts: T.Array(T.Object({ accountId: id, accountVersion: expectedTransactionVersion }, { additionalProperties: false }),
    { minItems: 1, maxItems: 4, description: 'Versions of all affected accounts from the preview' }),
};
const transactionStatus = T.Union([T.Literal('posted'), T.Literal('void')]);
const financialActor = T.Union([T.Literal('user'), T.Literal('admin')]);
const accountHistoryCursor = T.String({
  pattern: '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}\\.[a-f0-9-]{36}$',
  description: 'Opaque cursor returned as next by the previous page',
});
const accountHistoryEntryFields = { id, date: financialDate, amountMinor: signedMinor };
const accountHistory = T.Object({
  accountId: id, currency,
  entries: T.Array(T.Union([
    T.Object({ ...accountHistoryEntryFields, type: T.Literal('opening') }, { additionalProperties: false }),
    T.Object({ ...accountHistoryEntryFields, type: T.Literal('adjustment'), explanation: T.String(), actorRole: financialActor },
      { additionalProperties: false }),
    T.Object({ ...accountHistoryEntryFields,
      type: T.Union([T.Literal('expense'), T.Literal('income'), T.Literal('transfer')]),
      transactionVersion: ledgerVersion, status: transactionStatus, actorRole: financialActor,
      categoryId: T.Union([T.String(), T.Null()]), comment: T.Union([T.String(), T.Null()]),
    }, { additionalProperties: false }),
  ])),
  next: T.Union([accountHistoryCursor, T.Null()]),
});
const category = T.Object({
  id: T.String(), type: incomeExpenseType, nameEn: T.String(), nameRu: T.String(),
});
const statisticsPeriod = { fromDate: financialDate, throughDate: financialDate };
const statisticsQuery = T.Object({
  fromDate: T.Optional(statisticsPeriod.fromDate), throughDate: T.Optional(statisticsPeriod.throughDate),
  accountId: T.Optional(id),
  categoryId: T.Optional(T.String({ pattern: categoryIdPattern, description: 'Stable category ID from /api/v1/categories' })),
  type: T.Optional(incomeExpenseType), currency: T.Optional(currency), before: T.Optional(accountHistoryCursor),
}, { additionalProperties: false });
const totalMinor = T.String({ pattern: '^(0|[1-9][0-9]*)$', description: 'Non-negative total in minor units' });
const statistics = T.Object({
  ...statisticsPeriod,
  totals: T.Array(T.Object({ currency, incomeMinor: totalMinor, expenseMinor: totalMinor })),
  categories: T.Array(T.Object({ currency, categoryId: T.String(), amountMinor: totalMinor })),
  entries: T.Array(T.Object({
    transactionId: id, transactionVersion: ledgerVersion, date: financialDate, type: incomeExpenseType,
    accountId: id, currency, categoryId: T.String(), comment: T.Union([T.String(), T.Null()]), amountMinor: signedMinor,
  })),
  next: T.Union([accountHistoryCursor, T.Null()]),
});
const transactionChange = T.Object({ ...transactionVersionFields, status: transactionStatus, accounts: T.Array(transactionAccount) });
const transactionChangePreview = T.Object({
  ...transactionVersionFields,
  accounts: T.Array(T.Object({ ...transactionAccountFields, balanceMinor, balanceAfterMinor: balanceMinor })),
});
const transactionHistory = T.Object({
  ...transactionVersionFields,
  type: T.Union([T.Literal('expense'), T.Literal('income'), T.Literal('transfer')]),
  versions: T.Array(T.Object({
    version: expectedTransactionVersion, status: transactionStatus, date: financialDate,
    categoryId: T.Union([T.String(), T.Null()]), comment: T.Union([T.String(), T.Null()]), createdAt: expiry,
    actorRole: financialActor, reason: T.Union([T.String(), T.Null()]),
    movements: T.Array(T.Object({ accountId: id, currency, amountMinor: balanceMinor })),
  })),
});
const transactionChangeFailures = {
  400: 'INVALID_REQUEST for invalid replacement data or a change to the operation type.',
  404: 'NOT_FOUND when the transaction or an affected account is absent or belongs to another user.',
  409: 'VERSION_CONFLICT for stale versions, TRANSACTION_VOID for an already voided operation, ACCOUNT_UNAVAILABLE for an archived account. ' + commandWriteConflicts,
  503: 'TEMPORARY_FAILURE after exhausting transaction retries for a database lock error.',
};
const transactionHistoryFailure = { 404: 'NOT_FOUND when the transaction is absent or belongs to another user.' };
const transactionPreviewFailures = {
  ...transactionHistoryFailure,
  400: transactionChangeFailures[400],
  409: 'TRANSACTION_VOID for an already voided operation or ACCOUNT_UNAVAILABLE for an archived account.',
  503: transactionChangeFailures[503],
};
const credentials = { login: email, password: T.String({ minLength: 1, maxLength: 256 }) };
const adminSession = T.Object({ id, login: email, csrf: secret, recoveryVersion });
const ok = T.Object({ ok: T.Literal(true) });
export const accountStatus = T.Union([T.Literal('active'), T.Literal('blocked'), T.Literal('review')]);
const confirmedAccountStatus = T.Union([T.Literal('active'), T.Literal('blocked')]);
const user = T.Object({ id, email, status: accountStatus, deviceActive: T.Boolean() });
const empty = T.Object({}, { additionalProperties: false });

const scheduleRuleParams = T.Object({ ruleId: id });
const adminUserParams = T.Object({ userId: id });
const recoveryEvidence = T.Union([T.Literal('post_snapshot_records'), T.Literal('service_owner_confirmation')]);
const utcAuditTime = T.String({ format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$' });
const auditId = T.String({ pattern: '^[1-9]\\d{0,19}$', description: 'Exact unsigned event ID as a decimal string.' });
const auditCursor = T.String({ pattern: '^(0|-?[1-9]\\d{0,15})\\.[1-9]\\d{0,19}$',
  description: 'Pass next with the same filters. Orders by UTC milliseconds and exact event ID.' });
const auditEventName = T.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' });
const auditQuery = T.Object({
  userId: T.Optional(id), userEmail: T.Optional(email), adminId: T.Optional(id), adminLogin: T.Optional(email),
  from: T.Optional(utcAuditTime), through: T.Optional(utcAuditTime), event: T.Optional(auditEventName), before: T.Optional(auditCursor),
}, { additionalProperties: false });
const auditEvent = T.Object({
  id: auditId, happenedAt: utcAuditTime, event: auditEventName,
  actorRole: T.Union([T.Literal('operator'), T.Literal('admin'), T.Literal('user')]),
  actorId: T.Union([id, T.Null()]), actorLogin: T.Union([T.String(), T.Null()]),
  userId: T.Union([id, T.Null()]), userEmail: T.Union([T.String(), T.Null()]),
  objectId: T.Union([T.String({ maxLength: 64 }), T.Null()]),
  transition: T.Union([T.Object({
    from: T.Optional(T.String()), to: T.Optional(T.String()), reason: T.Optional(T.String()), source: T.Optional(recoveryEvidence),
  }, { additionalProperties: false }), T.Null()]),
});
const publicContacts = {
  email: T.Union([email, T.Null()]),
  phone: T.Union([T.String({ maxLength: 32 }), T.Null()]),
};
const supportContacts = T.Object({ ...publicContacts, version: ledgerVersion });
const supportContactInput = T.Object({
  email: T.Union([T.String({ maxLength: 254 }), T.Null()]),
  phone: publicContacts.phone,
  expectedVersion: ledgerVersion,
}, { additionalProperties: false });
const faqFields = {
  position: T.Integer({ minimum: 0, maximum: 2147483647 }),
  published: T.Boolean(),
  questionEn: T.String({ maxLength: 255 }), answerEn: T.String({ maxLength: 4000 }),
  questionRu: T.String({ maxLength: 255 }), answerRu: T.String({ maxLength: 4000 }),
};
const faqId = T.String({ minLength: 1, maxLength: 64 });
const faqParams = T.Object({ faqId });
const faqEntry = T.Object({ id: faqId, version: ledgerVersion, ...faqFields });
const faqWriteFailures = {
  400: 'INVALID_REQUEST for invalid FAQ fields or publication without both complete translations.',
  413: 'INVALID_REQUEST if the serialized FAQ request exceeds 64 KiB.',
};
const faqVersionFailures = {
  404: 'NOT_FOUND when the FAQ entry is absent.',
  409: 'VERSION_CONFLICT when the content has changed since the form was opened.',
};
const adminScheduleRuleParams = T.Object({ userId: id, ruleId: id });
const ruleFrequency = T.Union([T.Literal('once'), T.Literal('weekly'), T.Literal('monthly')]);
const ruleState = T.Union([T.Literal('active'), T.Literal('paused'), T.Literal('ended')]);
const ruleComment = T.Union([T.String({ maxLength: 500 }), T.Null()]);
const ruleEndDate = T.Union([financialDate, T.Null()]);
const ruleFields = {
  accountId: id, kind: scheduleDateFields.kind, frequency: ruleFrequency, firstDate: financialDate,
  amountMinor: positiveAmountMinor, categoryId: singleAccountTransaction.categoryId,
};
const ruleCreateFields = { ...ruleFields, comment: T.Optional(ruleComment), endDate: T.Optional(ruleEndDate) };
const adminReason = T.String({ maxLength: 500, pattern: '\\S' });
const ruleEditFields = {
  amountMinor: T.Optional(ruleFields.amountMinor), categoryId: T.Optional(ruleFields.categoryId),
  comment: T.Optional(ruleComment), endDate: T.Optional(ruleEndDate),
};
const ruleVersionFields = { expectedRuleVersion: ledgerVersion };
const ruleEdit = T.Object({ ...ruleVersionFields, action: T.Literal('edit'), ...ruleEditFields }, { additionalProperties: false });
const ruleLifecycle = T.Object({ ...ruleVersionFields,
  action: T.Union([T.Literal('pause'), T.Literal('resume'), T.Literal('end')]),
}, { additionalProperties: false });
const ruleChange = T.Union([ruleEdit, ruleLifecycle]);
const adminRuleChange = T.Union([
  T.Object({ ...ruleEdit.properties, reason: adminReason }, { additionalProperties: false }),
  T.Object({ ...ruleLifecycle.properties, reason: adminReason }, { additionalProperties: false }),
]);
const scheduleTransition = {
  transitionDate: financialDate,
  transitionAt: T.Integer({ description: 'Saved UTC boundary in Unix milliseconds.' }),
};
const linkedScheduleRule = T.Object({ ruleId: id, ...scheduleTransition });
const scheduleRule = T.Object({
  ...ruleFields, ruleId: id, currency, comment: ruleComment, endDate: ruleEndDate, state: ruleState,
  ruleVersion: ledgerVersion, effectiveAt: T.Integer({ description: 'UTC Unix time in milliseconds for the latest accepted version.' }),
  replaces: T.Optional(linkedScheduleRule), replacedBy: T.Optional(linkedScheduleRule),
  recoveryHeld: T.Optional(T.Literal(true, { description: 'Automatic processing is held until the restored rule is verified.' })),
});
const replacementPreviewQuery = T.Object({ accountId: id }, { additionalProperties: false });
const replacementPreview = T.Object({
  ruleId: id, accountId: id, ruleVersion: ledgerVersion, ...scheduleTransition, earliestFirstDate: financialDate,
  skippedDates: T.Array(T.Object({ date: financialDate, occurrenceId: id, adjustmentId: id, reason: skipReason })),
  previewToken: secret,
});
const replacementDecision = T.Object({
  sourceDate: financialDate,
  targetDate: T.Union([financialDate, T.Null()], { description: 'Use null to confirm the new rule has no corresponding date.' }),
}, { additionalProperties: false });
const replaceRuleFields = {
  ...ruleCreateFields, ...ruleVersionFields, idempotencyKey, previewToken: secret,
  decisions: T.Array(replacementDecision, { maxItems: 3000 }),
};
const replacementResult = T.Object({
  ruleId: id, accountId: id, ...scheduleTransition,
  previousRuleVersion: T.Integer({ minimum: 1, maximum: 4294967295, description: 'Latest version of the superseded rule after replacement.' }),
  replacementRule: scheduleRule, decisions: T.Array(replacementDecision),
});
const scheduleRuleList = T.Object({ rules: T.Array(scheduleRule) });
const scheduleRuleQuery = T.Object({ accountId: T.Optional(id) }, { additionalProperties: false });
const scheduleOccurrenceQuery = T.Object({
  ...reconciliationPreviewQuery.properties, accountId: T.Optional(id), ruleId: T.Optional(id),
}, { additionalProperties: false });
const scheduleOccurrenceList = T.Object({ occurrences: T.Array(T.Object({ ...scheduleOccurrence.properties, accountId: id, currency })) });
const scheduleDateTarget = { ruleId: id, date: financialDate };
const scheduleDateParams = T.Object(scheduleDateTarget);
const adminScheduleDateParams = T.Object({ userId: id, ...scheduleDateTarget });
const scheduleIntervention = { reason: skipReason, expectedFailureRevision: id };
const scheduleSkipResult = T.Object({ ...scheduleDateTarget, status: T.Literal('skipped'), reason: skipReason, occurrenceId: id });
const scheduleRetryResult = T.Object({ ...scheduleDateTarget, status: T.Union([T.Literal('due'), T.Literal('paused')]) });
const scheduleRuleDescription = 'Reports the latest accepted settings and version with its UTC effective time. Individual occurrences use the settings effective when the date came due.';
const scheduleCreateDescription = 'The first date must be on or after the account start date. Past occurrences become due at creation and are posted with their scheduled dates. An end date is inclusive and applies to repeating rules.';
const scheduleRuleWriteFailures = {
  400: 'INVALID_REQUEST for an invalid date, amount, category, or empty edit.',
  404: 'NOT_FOUND when the owner, account, or rule is unavailable to the caller.',
  409: 'ACCOUNT_UNAVAILABLE for an archived account, VERSION_CONFLICT for a stale version, or SCHEDULE_RULE_STATE_CONFLICT for a change that is unavailable in the current rule state or while the rule is held for recovery.',
  503: 'TEMPORARY_FAILURE after exhausting transaction retries for a database lock error.',
};
const scheduleRuleReadFailures = { 404: scheduleRuleWriteFailures[404] };
const replacementPreviewDescription = 'Select the destination account to obtain the transition boundary, minimum start date, and all reconciliation skips to consider. A linked rule becomes eligible at its saved UTC boundary.';
const replacementDescription = 'Use the source rule version and token returned by the preview for the destination account. Supply one decision per previewed source date and use each target date at most once. A changed boundary or source list requires a new preview. An identical retry returns the original result.';
const replacementPreviewFailures = {
  ...scheduleRuleWriteFailures,
  409: scheduleRuleWriteFailures[409] + ' SCHEDULE_REPLACEMENT_CONFLICT if the rule already has a replacement.',
};
const replacementFailures = {
  ...replacementPreviewFailures,
  400: 'INVALID_REQUEST for invalid new rule parameters or missing, duplicate, or invalid transfer decisions.',
  409: replacementPreviewFailures[409] + ' SCHEDULE_REPLACEMENT_CONFLICT also indicates a changed preview. ' + commandWriteConflicts,
  413: 'INVALID_REQUEST for a request body larger than 256 KiB.',
};
const scheduleOccurrenceFailures = { ...scheduleRuleReadFailures, ...reconciliationPreviewFailures };
const scheduleOccurrenceDescription = 'Returns dates and recorded outcomes in an inclusive date range of up to 366 days between endpoints. A date marked retrying or needing intervention includes an attempt count, error code, and failure revision. The optional account and rule filters must belong to the caller.';
const scheduleDateConflict = 'SCHEDULE_DATE_CONFLICT when the date is no longer eligible, or ACCOUNT_UNAVAILABLE for an archived account.';
const scheduleDateActionFailures = {
  404: scheduleRuleWriteFailures[404], 409: scheduleDateConflict, 503: scheduleRuleWriteFailures[503],
};
const scheduleSkipFailures = { ...scheduleDateActionFailures, 409: scheduleDateConflict + ' ' + commandWriteConflicts };

const commandKeyFields = { idempotencyKey, userId: id };
const accountReconcileKey = T.Object({
  ...commandKeyFields, command: T.Literal('account.reconcile'), accountId: id,
}, { additionalProperties: false });
const transactionChangeKey = T.Object({
  ...commandKeyFields, command: T.Union([T.Literal('transaction.revise'), T.Literal('transaction.void')]), transactionId: id,
}, { additionalProperties: false });
const scheduleSkipKey = T.Object({
  ...commandKeyFields, command: T.Literal('schedule.skip'), ...scheduleDateTarget,
}, { additionalProperties: false });
const scheduleReplaceKey = T.Object({
  ...commandKeyFields, command: T.Literal('schedule.replace'), ruleId: id, accountId: id,
}, { additionalProperties: false });
const accountCreateKey = T.Object({ ...commandKeyFields, command: T.Literal('account.create') }, { additionalProperties: false });
const adminCommandKey = T.Union([accountCreateKey, accountReconcileKey, transactionChangeKey, scheduleSkipKey, scheduleReplaceKey]);
const mobileCommandKey = T.Union([
  accountCreateKey,
  T.Object({
    ...commandKeyFields, command: T.Union([T.Literal('expense.record'), T.Literal('income.record')]), accountId: id,
  }, { additionalProperties: false }),
  T.Object({
    ...commandKeyFields, command: T.Literal('transfer.record'), fromAccountId: id, toAccountId: id,
  }, { additionalProperties: false }),
  accountReconcileKey, transactionChangeKey, scheduleSkipKey, scheduleReplaceKey,
]);
const committedCommand = T.Object({
  state: T.Literal('committed'),
  result: T.Union([accountBalance, transactionRecord, balanceAdjustment, transactionChange, scheduleSkipResult, replacementResult]),
});
const commandStatus = T.Union([committedCommand, T.Object({ state: T.Literal('unknown') })]);
const commandStatusDescription = 'Send the key, command name, data owner, and target from the original request. A schedule skip uses the rule and date. A schedule replacement uses the superseded rule and destination account. Returns the original committed result, or unknown if no outcome has committed for the current recovery version.';
const closeCommandDescription = 'Atomically closes a key with no result. COMMAND_CLOSED confirms the key cannot record changes. If the command committed first, returns its original result. After a timeout, use the same key to check the outcome.';
const commandLookupFailures = {
  404: 'NOT_FOUND when the requested owner or targets are unavailable to the caller or differ from the recorded command scope.',
  409: 'COMMAND_CLOSED for a confirmed closure, or COMMAND_REQUIRES_REVIEW for an unknown key from another recovery version.',
  503: 'TEMPORARY_FAILURE after exhausting transaction retries for a database lock error. The outcome remains unknown to the caller.',
};

type Access = 'public' | 'mobile' | 'admin-step' | 'admin';
function route<B extends TSchema, R extends TSchema>(
  endpoint: (typeof endpoints)[keyof typeof endpoints], access: Access,
  summary: string, body: B, result: R,
) {
  return { ...endpoint, access, summary, body, result };
}

export const routes = {
  health: route(endpoints.health, 'public', 'Check API and database availability', empty, ok),
  support: {
    ...route(endpoints.support, 'public', 'Read published support contacts and FAQ', empty,
      T.Object({ ...publicContacts,
        faq: T.Array(T.Object({ id: T.String(), question: T.String(), answer: T.String() })) })),
    query: T.Object({ lang: T.Optional(language) }),
    description: 'Does not require an installation or session. Unconfigured contacts are null. Includes complete, published FAQ entries ordered by position and stable ID. Language defaults to English.',
  },
  activate: route(endpoints.activate, 'public', 'Activate a new installation with a one-time code', T.Object({
    email, code, pin, installationSecret: secret,
  }), mobileSession),
  unlock: route(endpoints.unlock, 'public', 'Replace the session using the installation secret and a PIN or biometrics',
    T.Union([
      T.Object({ installationSecret: secret, pin }, { additionalProperties: false }),
      T.Object({ installationSecret: secret, biometricSecret: secret }, { additionalProperties: false }),
    ]), mobileSession),
  me: route(endpoints.me, 'mobile', 'Read the profile and verify the current session', empty, profile),
  setTimeZone: {
    ...route(endpoints.setTimeZone, 'mobile', 'Select the profile time zone', T.Object({ timeZone }, { additionalProperties: false }), profile),
    description: 'Records the selected time zone for future dates. Dates already due keep their original due time. Repeating the current selection returns the profile.',
    failures: {
      400: 'INVALID_REQUEST for an unknown IANA time zone.',
      409: 'TIME_ZONE_CONFLICT when a concurrent change shares the same clock instant. Retry in a new request.',
      503: scheduleRuleWriteFailures[503],
    },
  },
  logout: route(endpoints.logout, 'mobile', 'Revoke the installation and its sessions', empty, ok),
  enableBiometrics: route(endpoints.enableBiometrics, 'mobile', 'Register a locally protected biometric secret',
    T.Object({ pin, biometricSecret: secret }), ok),
  disableBiometrics: route(endpoints.disableBiometrics, 'mobile', 'Revoke the biometric secret', empty, ok),
  createAccount: {
    ...route(endpoints.createAccount, 'mobile', 'Create an account, cash account, or deposit with an opening balance',
      createAccountInput, accountBalance),
    description: createAccountDescription, failures: createAccountFailures,
  },
  listAccounts: {
    ...route(endpoints.listAccounts, 'mobile', 'List accounts owned by the caller', empty,
      T.Object({ accounts: T.Array(accountBalance) })),
    description: 'Returns current balances and versions from one snapshot. Active accounts come first. Archived accounts have archived: true. A regular account omits type.',
  },
  getCurrencySummary: {
    ...route(endpoints.getCurrencySummary, 'mobile', 'Read account balances grouped by currency', empty,
      T.Object({ balances: T.Array(T.Object({ currency, balanceMinor })) })),
    description: 'Returns one total per currency with an active account. Each active account contributes its current balance once.',
  },
  getAccountBalance: {
    ...route(endpoints.getAccountBalance, 'mobile', 'Read the current balance of an account owned by the caller', empty, accountBalance),
    params: accountParams,
    description: 'Returns the balance and account version from the same database snapshot, with the annual rate and maturity date for deposits.',
    failures: { 404: 'NOT_FOUND when the account is absent or belongs to another user.' },
  },
  renameAccount: {
    ...route(endpoints.renameAccount, 'mobile', 'Rename an owned active account',
      T.Object({ name: accountName, expectedAccountVersion: ledgerVersion }, { additionalProperties: false }), accountBalance),
    params: accountParams,
    description: 'Send the account version shown in the editor. A successful name change advances that version and records the change in the audit log.',
    failures: {
      ...restoreFailures, 409: 'VERSION_CONFLICT for a stale account version, or ACCOUNT_UNAVAILABLE for an archived account.',
    },
  },
  updateAccountStartDate: {
    ...route(endpoints.updateAccountStartDate, 'mobile', 'Change the start date of an owned active account',
      T.Object(accountStartDateFields, { additionalProperties: false }), accountBalance),
    params: accountParams, description: updateAccountStartDateDescription, failures: updateAccountStartDateFailures,
  },
  listAccountHistory: {
    ...route(endpoints.listAccountHistory, 'mobile', 'Read the financial history of an owned account', empty, accountHistory),
    params: accountParams,
    query: T.Object({ before: T.Optional(accountHistoryCursor) }, { additionalProperties: false }),
    description: 'Returns up to 50 entries ordered by financial date and ID, newest first. Pass next as before for the following page. Reload from the first page after changing a date. Includes the opening balance, reconciliations, and current transaction versions. A void entry shows its last posted amount and has no effect on balances. Archived account history remains readable.',
    failures: { ...accountNotFound, 400: 'INVALID_REQUEST for a malformed cursor or an invalid date in the cursor.' },
  },
  listCategories: {
    ...route(endpoints.listCategories, 'mobile', 'List expense and income categories', empty,
      T.Object({ categories: T.Array(category) })),
    description: 'Returns stable category IDs, transaction types, and names in English and Russian.',
  },
  getStatistics: {
    ...route(endpoints.getStatistics, 'mobile', 'Read income, expenses, and their transactions', empty, statistics),
    query: statisticsQuery,
    description: 'Send both period dates or omit both for the current calendar month in the profile time zone. Both boundaries are inclusive. ' +
      'The report uses current posted income and expenses, including scheduled postings and archived accounts. ' +
      'Opening balances, reconciliations, transfers, and void versions are excluded. ' +
      'Each currency is reported separately. Expense category totals are sorted by currency and decreasing amount, then by category ID. ' +
      'Each response calculates totals, categories and up to 50 entries from one snapshot using the same filters. ' +
      'Entries use signed amounts and are ordered by financial date and transaction ID, newest first. ' +
      'For the next page, pass next as before with the same filters and the explicit period from the first response. ' +
      'The cursor determines the entry page and totals still cover the whole period. Start at the first page after changing a filter or editing an operation.',
    failures: {
      400: 'INVALID_REQUEST for an incomplete or reversed period, invalid date, or malformed or out-of-period cursor.',
      401: 'SESSION_EXPIRED when the mobile session is missing, expired, or no longer current.',
      403: 'DEVICE_REVOKED or PIN_LOCKED when the installation cannot access the account.',
      ...accountNotFound,
    },
  },
  archiveAccount: {
    ...route(endpoints.archiveAccount, 'mobile', 'Archive an owned account', empty, accountArchiveState),
    params: accountParams, optionalBody: true, description: archiveDescription, failures: archiveFailures,
  },
  restoreAccount: {
    ...route(endpoints.restoreAccount, 'mobile', 'Restore an owned account', empty, accountArchiveState),
    params: accountParams, optionalBody: true, description: restoreDescription, failures: restoreFailures,
  },
  listBalanceAdjustments: {
    ...route(endpoints.listBalanceAdjustments, 'mobile', 'Read balance reconciliation history', empty, adjustmentHistory),
    params: accountParams, query: adjustmentQuery, failures: accountNotFound,
  },
  reconcileAccountBalance: {
    ...route(endpoints.reconcileAccountBalance, 'mobile', 'Reconcile the balance of an owned account', reconciliationInput, balanceAdjustment),
    params: accountParams, description: reconciliationDescription, failures: reconciliationFailures,
  },
  previewBalanceAdjustment: {
    ...route(endpoints.previewBalanceAdjustment, 'mobile', 'Read scheduled dates and account version for reconciliation', empty, reconciliationPreview),
    params: accountParams, query: reconciliationPreviewQuery, description: reconciliationPreviewDescription,
    failures: { ...accountNotFound, ...reconciliationPreviewFailures },
  },
  listAccountCards: {
    ...route(endpoints.listAccountCards, 'mobile', 'Read cards linked to an owned account', empty,
      T.Object({ cards: T.Array(accountCard) })),
    params: accountParams,
    description: 'Every card reports the current balance and currency of its linked account.',
    failures: { 404: 'NOT_FOUND when the account is absent or belongs to another user.' },
  },
  createAccountCard: {
    ...route(endpoints.createAccountCard, 'mobile', 'Create a card linked to an owned account', cardInput, accountCard),
    params: accountParams,
    failures: cardWriteFailures,
  },
  updateAccountCard: {
    ...route(endpoints.updateAccountCard, 'mobile', 'Replace the display fields of a card', cardInput, accountCard),
    params: cardParams,
    description: 'Send the name and appearance. Omitting lastFour or passing null clears the stored digits.',
    failures: cardWriteFailures,
  },
  deleteAccountCard: {
    ...route(endpoints.deleteAccountCard, 'mobile', 'Delete a card from an owned account', empty, ok),
    params: cardParams,
    failures: cardWriteFailures,
  },
  recordTransaction: {
    ...route(endpoints.recordTransaction, 'mobile', 'Record income, an expense, or a transfer between owned accounts', T.Union([
      T.Object({ ...singleAccountTransaction, idempotencyKey }, { additionalProperties: false }),
      T.Object({ ...transferTransaction, idempotencyKey }, { additionalProperties: false }),
    ]), transactionRecord),
    description: 'A transfer debits the source and credits the destination atomically. Supply both actual amounts in the respective account currencies. For accounts in the same currency, both amounts must match. Keys are scoped by transaction type. Repeating the same key and payload with current access returns the original result, including balances at commit.',
    failures: {
      400: 'INVALID_REQUEST for invalid fields, a category that does not match the transaction type, a transfer to the same account, or unequal amounts in the same currency.',
      404: 'NOT_FOUND when any affected account is absent or belongs to another user.',
      409: 'ACCOUNT_UNAVAILABLE for an archived account. ' + commandWriteConflicts,
      503: 'TEMPORARY_FAILURE after exhausting transaction retries for a database lock error.',
    },
  },
  listTransactionVersions: {
    ...route(endpoints.listTransactionVersions, 'mobile', 'Read the version history of an owned transaction', empty, transactionHistory),
    params: transactionParams, failures: transactionHistoryFailure,
  },
  reviseTransaction: {
    ...route(endpoints.reviseTransaction, 'mobile', 'Replace the current version of an owned transaction', T.Union([
      T.Object({ ...singleAccountTransaction, ...versionedCommand }, { additionalProperties: false }),
      T.Object({ ...transferTransaction, ...versionedCommand }, { additionalProperties: false }),
    ]), transactionChange),
    params: transactionParams, failures: transactionChangeFailures,
    description: 'Send the complete replacement and the current transaction version. The result includes balances of accounts from both versions. An identical retry returns the original result.',
  },
  voidTransaction: {
    ...route(endpoints.voidTransaction, 'mobile', 'Void an owned transaction and remove its effect on balances',
      T.Object(versionedCommand, { additionalProperties: false }), transactionChange),
    params: transactionParams, failures: transactionChangeFailures,
    description: 'Creates a void version and preserves earlier versions and movements. An identical retry returns the original result.',
  },
  listScheduleRules: {
    ...route(endpoints.listScheduleRules, 'mobile', 'List the owner’s schedule rules', empty, scheduleRuleList),
    query: scheduleRuleQuery, description: scheduleRuleDescription, failures: scheduleRuleReadFailures,
  },
  createScheduleRule: {
    ...route(endpoints.createScheduleRule, 'mobile', 'Create a rule for an active account',
      T.Object(ruleCreateFields, { additionalProperties: false }), scheduleRule),
    description: scheduleCreateDescription,
    failures: scheduleRuleWriteFailures,
  },
  getScheduleRule: {
    ...route(endpoints.getScheduleRule, 'mobile', 'Read a schedule rule', empty, scheduleRule),
    params: scheduleRuleParams, description: scheduleRuleDescription, failures: scheduleRuleReadFailures,
  },
  changeScheduleRule: {
    ...route(endpoints.changeScheduleRule, 'mobile', 'Edit, pause, resume, or end a rule', ruleChange, scheduleRule),
    params: scheduleRuleParams,
    description: 'Uses the latest accepted version as a concurrency guard. The change becomes effective at the start of the next local day, even if the profile time zone changes later. Ending a rule is final.',
    failures: scheduleRuleWriteFailures,
  },
  previewScheduleRuleReplacement: {
    ...route(endpoints.previewScheduleRuleReplacement, 'mobile', 'Preview the replacement of a schedule rule', empty, replacementPreview),
    params: scheduleRuleParams, query: replacementPreviewQuery,
    description: replacementPreviewDescription, failures: replacementPreviewFailures,
  },
  replaceScheduleRule: {
    ...route(endpoints.replaceScheduleRule, 'mobile', 'Replace a schedule rule',
      T.Object(replaceRuleFields, { additionalProperties: false }), replacementResult),
    params: scheduleRuleParams, description: replacementDescription, failures: replacementFailures,
  },
  listScheduleOccurrences: {
    ...route(endpoints.listScheduleOccurrences, 'mobile', 'List scheduled dates and recorded outcomes', empty, scheduleOccurrenceList),
    query: scheduleOccurrenceQuery, description: scheduleOccurrenceDescription, failures: scheduleOccurrenceFailures,
  },
  skipScheduleOccurrence: {
    ...route(endpoints.skipScheduleOccurrence, 'mobile', 'Skip the next due scheduled date', T.Object({
      idempotencyKey, reason: skipReason,
    }, { additionalProperties: false }), scheduleSkipResult),
    params: scheduleDateParams,
    description: 'Records the reason for the earliest unsettled due date without affecting the balance. The worker handles paused dates. Replaying the same key and request returns the original result.',
    failures: scheduleSkipFailures,
  },
  commandStatus: {
    ...route(endpoints.commandStatus, 'mobile', 'Check a financial command outcome', mobileCommandKey, commandStatus),
    description: commandStatusDescription, failures: commandLookupFailures,
  },
  closeCommand: {
    ...route(endpoints.closeCommand, 'mobile', 'Close a financial command after losing its response', mobileCommandKey, committedCommand),
    description: closeCommandDescription, failures: commandLookupFailures,
  },
  password: route(endpoints.password, 'admin-step', 'Verify password and create a browser-bound five-minute step',
    T.Object(credentials), T.Object({ step: secret })),
  totp: route(endpoints.totp, 'admin-step', 'Consume the login step and issue an administrative cookie',
    T.Object({ step: secret, code: T.String({ pattern: '^[0-9]{6}$' }) }), adminSession),
  recovery: route(endpoints.recovery, 'admin-step', 'Consume a recovery secret and begin TOTP setup',
    T.Object({ ...credentials, recoverySecret: secret }), T.Object({ step: secret, totpSecret: T.String() })),
  setup: route(endpoints.setup, 'admin-step', 'Confirm the new TOTP secret and consume the setup step',
    T.Object({ step: secret, code: T.String({ pattern: '^[0-9]{6}$' }) }), ok),
  adminMe: route(endpoints.adminMe, 'admin', 'Verify the administrative cookie and read the CSRF token', empty, adminSession),
  adminLogout: route(endpoints.adminLogout, 'admin', 'Revoke the administrative session', empty, ok),
  adminGetSupport: {
    ...route(endpoints.adminGetSupport, 'admin', 'Read contacts and bilingual FAQ for editing', empty,
      T.Object({ contacts: supportContacts, faq: T.Array(faqEntry) })),
    description: 'Includes drafts and both translations. FAQ entries are ordered by position and stable ID.',
  },
  adminUpdateSupportContacts: {
    ...route(endpoints.adminUpdateSupportContacts, 'admin', 'Replace the public support contacts', supportContactInput, supportContacts),
    description: 'Send the current version. Null and blank values clear their respective contact. Phone numbers may include a leading plus and visual separators.',
    failures: { 400: 'INVALID_REQUEST for invalid email or telephone format.', 409: faqVersionFailures[409] },
  },
  adminCreateFaq: {
    ...route(endpoints.adminCreateFaq, 'admin', 'Create a draft or published FAQ entry',
      T.Object(faqFields, { additionalProperties: false }), faqEntry),
    description: 'The server assigns a stable ID. Smaller positions are shown first. Publication requires a question and answer in both languages.',
    failures: faqWriteFailures,
  },
  adminUpdateFaq: {
    ...route(endpoints.adminUpdateFaq, 'admin', 'Replace an existing FAQ entry',
      T.Object({ ...faqFields, expectedVersion: ledgerVersion }, { additionalProperties: false }), faqEntry),
    params: faqParams,
    description: 'Retains the entry ID and allows editing translations, position and publication status.',
    failures: { ...faqWriteFailures, ...faqVersionFailures },
  },
  adminDeleteFaq: {
    ...route(endpoints.adminDeleteFaq, 'admin', 'Delete an existing FAQ entry', empty, ok),
    params: faqParams,
    query: T.Object({ expectedVersion: T.String({ pattern: '^[1-9]\\d{0,9}$' }) }, { additionalProperties: false }),
    failures: { 400: 'INVALID_REQUEST for an invalid version.', ...faqVersionFailures },
  },
  listUsers: {
    ...route(endpoints.listUsers, 'admin', 'List accounts by ascending normalized email', empty,
      T.Object({ users: T.Array(user), next: T.Union([email, T.Null()]) })),
    query: T.Object({ after: T.Optional(email), search: T.Optional(T.String({ minLength: 1, maxLength: 254, pattern: '\\S' })) },
      { additionalProperties: false }),
    description: 'Search by normalized email prefix. Pass the same search with the next cursor.',
  },
  adminGetUser: {
    ...route(endpoints.adminGetUser, 'admin', 'Read a user account by ID', empty, user),
    params: adminUserParams, failures: { 404: 'NOT_FOUND for an unknown account.' },
  },
  createUser: route(endpoints.createUser, 'admin', 'Create an active account', T.Object({ email }), user),
  issue: route(endpoints.issue, 'admin', 'Replace unused codes and return the new code once',
    T.Object({ userId: id }), T.Object({ code, expiresAt: expiry })),
  revoke: route(endpoints.revoke, 'admin', 'Revoke the active installation and its sessions', T.Object({ userId: id }), ok),
  setStatus: {
    ...route(endpoints.setStatus, 'admin', 'Block or unblock an account after any recovery review',
      T.Object({ userId: id, status: confirmedAccountStatus }), ok),
    failures: { 404: 'NOT_FOUND for an unknown account.', 409: 'ACCOUNT_REVIEW_REQUIRED while recovery review is pending.' },
  },
  adminReviewRecoveredUser: {
    ...route(endpoints.adminReviewRecoveredUser, 'admin', 'Record a decision on a restored account',
      T.Object({ status: confirmedAccountStatus, source: recoveryEvidence,
        reason: T.String({ maxLength: 500, pattern: '\\S' }) }, { additionalProperties: false }), user),
    params: adminUserParams,
    description: 'Only an account awaiting recovery review is eligible. Record post-snapshot records or explicit confirmation by the service owner. The decision revokes any restored installation and issued codes. An account with insufficient evidence stays in review.',
    failures: { 400: 'INVALID_REQUEST for missing or invalid evidence or reason.', 404: 'NOT_FOUND for an unknown account.',
      409: 'ACCOUNT_REVIEW_CONFLICT when the account no longer awaits review.' },
  },
  adminListAudit: {
    ...route(endpoints.adminListAudit, 'admin', 'Search administrative audit events', empty,
      T.Object({ events: T.Array(auditEvent), next: T.Union([auditCursor, T.Null()]) })),
    query: auditQuery,
    description: 'Returns up to 50 events ordered by UTC time and exact event ID, newest first. The optional UTC bounds are inclusive. Email and login filters match the complete normalized value. Administrator filters only match administrative actors. Pass next as before with the same filters.',
    failures: { 400: 'INVALID_REQUEST for a reversed UTC range or invalid cursor.' },
  },
  adminListAccounts: {
    ...route(endpoints.adminListAccounts, 'admin', 'Read accounts and financial dates for the selected user', empty,
      T.Object({ accounts: T.Array(accountBalance), today: financialDate, timeZone })),
    params: adminUserParams, failures: { 404: 'NOT_FOUND when the selected user does not exist.' },
  },
  adminCreateAccount: {
    ...route(endpoints.adminCreateAccount, 'admin', 'Create a financial account for the selected user', T.Union([
      T.Object({ ...createAccountFields, reason: adminReason }, { additionalProperties: false }),
      T.Object({ ...createAccountFields, type: T.Literal('cash'), reason: adminReason }, { additionalProperties: false }),
      T.Object({ ...createAccountFields, ...depositTerms, reason: adminReason }, { additionalProperties: false }),
    ]), accountBalance),
    params: adminUserParams, description: createAccountDescription + ' Supply an audit reason.',
    failures: { ...createAccountFailures, 404: 'NOT_FOUND when the selected user does not exist.' },
  },
  adminListAccountHistory: {
    ...route(endpoints.adminListAccountHistory, 'admin', 'Read account history for the selected user', empty, accountHistory),
    params: adminAccountParams, query: T.Object({ before: T.Optional(accountHistoryCursor) }, { additionalProperties: false }),
    description: 'Returns up to 50 entries in descending order by financial date and ID. Pass next as before. Archived history remains readable.',
    failures: { ...accountNotFound, 400: 'INVALID_REQUEST for a malformed cursor or an invalid date in the cursor.' },
  },
  adminListCategories: route(endpoints.adminListCategories, 'admin', 'Read the bilingual category catalog', empty,
    T.Object({ categories: T.Array(category) })),
  adminRenameAccount: {
    ...route(endpoints.adminRenameAccount, 'admin', 'Rename an active account for the selected user',
      T.Object({ name: accountName, expectedAccountVersion: ledgerVersion, reason: adminReason }, { additionalProperties: false }),
      accountBalance),
    params: adminAccountParams,
    description: 'Send the account version shown in the editor and an audit reason.',
    failures: { ...restoreFailures, 409: 'VERSION_CONFLICT for a stale version or ACCOUNT_UNAVAILABLE for an archived account.' },
  },
  adminUpdateAccountStartDate: {
    ...route(endpoints.adminUpdateAccountStartDate, 'admin', 'Change an active account’s start date for the selected user',
      T.Object({ ...accountStartDateFields, reason: adminReason }, { additionalProperties: false }), accountBalance),
    params: adminAccountParams, description: updateAccountStartDateDescription + ' Supply an audit reason.',
    failures: updateAccountStartDateFailures,
  },
  adminArchiveAccount: {
    ...route(endpoints.adminArchiveAccount, 'admin', 'Archive an account for the selected user', empty, accountArchiveState),
    params: adminAccountParams, optionalBody: true, description: archiveDescription, failures: archiveFailures,
  },
  adminRestoreAccount: {
    ...route(endpoints.adminRestoreAccount, 'admin', 'Restore an account for the selected user', empty, accountArchiveState),
    params: adminAccountParams, optionalBody: true, description: restoreDescription, failures: restoreFailures,
  },
  adminListBalanceAdjustments: {
    ...route(endpoints.adminListBalanceAdjustments, 'admin', 'Read reconciliation history for the selected user', empty, adjustmentHistory),
    params: adminAccountParams, query: adjustmentQuery, failures: accountNotFound,
  },
  adminReconcileAccountBalance: {
    ...route(endpoints.adminReconcileAccountBalance, 'admin', 'Reconcile the balance of an account for the selected user', reconciliationInput, balanceAdjustment),
    params: adminAccountParams, description: reconciliationDescription, failures: reconciliationFailures,
  },
  adminPreviewBalanceAdjustment: {
    ...route(endpoints.adminPreviewBalanceAdjustment, 'admin', 'Read scheduled dates and account version for the selected user', empty, reconciliationPreview),
    params: adminAccountParams, query: reconciliationPreviewQuery, description: reconciliationPreviewDescription,
    failures: { ...accountNotFound, ...reconciliationPreviewFailures },
  },
  adminListTransactionVersions: {
    ...route(endpoints.adminListTransactionVersions, 'admin', 'Read a transaction version history for the selected user', empty, transactionHistory),
    params: adminTransactionParams, failures: transactionHistoryFailure,
  },
  adminPreviewTransactionRevision: {
    ...route(endpoints.adminPreviewTransactionRevision, 'admin', 'Preview balance changes from a transaction revision', T.Union([
      T.Object(singleAccountTransaction, { additionalProperties: false }),
      T.Object(transferTransaction, { additionalProperties: false }),
    ]), transactionChangePreview),
    params: adminTransactionParams, failures: transactionPreviewFailures,
    description: 'Returns the current transaction and account versions, with current and projected balances for every affected account.',
  },
  adminPreviewTransactionVoid: {
    ...route(endpoints.adminPreviewTransactionVoid, 'admin', 'Preview balance changes from voiding a transaction', empty, transactionChangePreview),
    params: adminTransactionParams, failures: transactionPreviewFailures,
  },
  adminReviseTransaction: {
    ...route(endpoints.adminReviseTransaction, 'admin', 'Revise a transaction for the selected user', T.Union([
      T.Object({ ...singleAccountTransaction, ...adminVersionedCommand }, { additionalProperties: false }),
      T.Object({ ...transferTransaction, ...adminVersionedCommand }, { additionalProperties: false }),
    ]), transactionChange),
    params: adminTransactionParams, failures: transactionChangeFailures,
    description: 'Supply the transaction and all affected account versions from the preview and a reason for the revision.',
  },
  adminVoidTransaction: {
    ...route(endpoints.adminVoidTransaction, 'admin', 'Void a transaction for the selected user',
      T.Object(adminVersionedCommand, { additionalProperties: false }), transactionChange),
    params: adminTransactionParams, failures: transactionChangeFailures,
    description: 'Supply the transaction and all affected account versions from the preview and a reason for voiding.',
  },
  adminListScheduleRules: {
    ...route(endpoints.adminListScheduleRules, 'admin', 'List schedule rules for the selected owner', empty, scheduleRuleList),
    params: adminUserParams, query: scheduleRuleQuery, description: scheduleRuleDescription, failures: scheduleRuleReadFailures,
  },
  adminCreateScheduleRule: {
    ...route(endpoints.adminCreateScheduleRule, 'admin', 'Create a schedule rule for the selected owner',
      T.Object({ ...ruleCreateFields, reason: adminReason }, { additionalProperties: false }), scheduleRule),
    params: adminUserParams, description: scheduleCreateDescription, failures: scheduleRuleWriteFailures,
  },
  adminGetScheduleRule: {
    ...route(endpoints.adminGetScheduleRule, 'admin', 'Read a rule for the selected owner', empty, scheduleRule),
    params: adminScheduleRuleParams, description: scheduleRuleDescription, failures: scheduleRuleReadFailures,
  },
  adminChangeScheduleRule: {
    ...route(endpoints.adminChangeScheduleRule, 'admin', 'Edit, pause, resume, or end a rule with an audit reason', adminRuleChange, scheduleRule),
    params: adminScheduleRuleParams, failures: scheduleRuleWriteFailures,
  },
  adminPreviewScheduleRuleReplacement: {
    ...route(endpoints.adminPreviewScheduleRuleReplacement, 'admin', 'Preview a rule replacement for the selected owner', empty, replacementPreview),
    params: adminScheduleRuleParams, query: replacementPreviewQuery,
    description: replacementPreviewDescription, failures: replacementPreviewFailures,
  },
  adminReplaceScheduleRule: {
    ...route(endpoints.adminReplaceScheduleRule, 'admin', 'Replace a schedule rule for the selected owner with an audit reason',
      T.Object({ ...replaceRuleFields, reason: adminReason }, { additionalProperties: false }), replacementResult),
    params: adminScheduleRuleParams, description: replacementDescription, failures: replacementFailures,
  },
  adminListScheduleOccurrences: {
    ...route(endpoints.adminListScheduleOccurrences, 'admin', 'List scheduled dates and outcomes for the selected owner', empty, scheduleOccurrenceList),
    params: adminUserParams, query: scheduleOccurrenceQuery, description: scheduleOccurrenceDescription, failures: scheduleOccurrenceFailures,
  },
  adminSkipScheduleOccurrence: {
    ...route(endpoints.adminSkipScheduleOccurrence, 'admin', 'Skip a scheduled date that needs intervention', T.Object({
      idempotencyKey, ...scheduleIntervention,
    }, { additionalProperties: false }), scheduleSkipResult),
    params: adminScheduleDateParams,
    description: 'Use the failure revision returned by the date list. The skip records the reason and advances the rule. Replaying the same key and request returns the original result.',
    failures: scheduleSkipFailures,
  },
  adminRetryScheduleOccurrence: {
    ...route(endpoints.adminRetryScheduleOccurrence, 'admin', 'Return a scheduled date to the queue', T.Object(
      scheduleIntervention, { additionalProperties: false }), scheduleRetryResult),
    params: adminScheduleDateParams,
    description: 'Clears the failure and resets its attempt count for the given failure revision. The worker handles the queued date. An outdated failure revision receives SCHEDULE_DATE_CONFLICT.',
    failures: scheduleDateActionFailures,
  },
  adminCommandStatus: {
    ...route(endpoints.adminCommandStatus, 'admin', 'Check an administrative financial command outcome', adminCommandKey, commandStatus),
    description: commandStatusDescription, failures: commandLookupFailures,
  },
  adminCloseCommand: {
    ...route(endpoints.adminCloseCommand, 'admin', 'Close an administrative financial command after losing its response', adminCommandKey, committedCommand),
    description: closeCommandDescription, failures: commandLookupFailures,
  },
};

export type Route = keyof typeof routes;
export type Body<K extends Route> = Static<(typeof routes)[K]['body']>;
type RouteParams = { [K in Route]: (typeof routes)[K] extends { params: infer P extends TSchema }
  ? Static<P> : Record<string, never> };
export type Params<K extends Route> = RouteParams[K];
export type Result<K extends Route> = Static<(typeof routes)[K]['result']>;
export type StatisticsQuery = Static<typeof statisticsQuery>;
export type AuditQuery = Static<typeof auditQuery>;
export type RecoveryEvidence = Static<typeof recoveryEvidence>;
export type Language = Static<typeof language>;

export const errorCodes = [
  'INVALID_REQUEST', 'ACTIVATION_INVALID', 'DEVICE_REVOKED', 'PIN_INVALID', 'PIN_LOCKED',
  'BIOMETRICS_INVALID', 'SESSION_EXPIRED', 'ADMIN_AUTH_INVALID', 'CSRF_INVALID',
  'RATE_LIMITED', 'EMAIL_EXISTS', 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_REVIEW_REQUIRED', 'ACCOUNT_REVIEW_CONFLICT', 'NOT_FOUND', 'INTERNAL_ERROR',
  'IDEMPOTENCY_CONFLICT', 'COMMAND_CLOSED', 'COMMAND_REQUIRES_REVIEW', 'TEMPORARY_FAILURE',
  'VERSION_CONFLICT', 'TRANSACTION_VOID', 'ACCOUNT_BALANCE_NOT_ZERO', 'ACCOUNT_START_DATE_CONFLICT', 'SCHEDULE_DATE_CONFLICT', 'SCHEDULE_DATES_PENDING',
  'SCHEDULE_FUTURE_DATES', 'SCHEDULE_RULE_STATE_CONFLICT', 'SCHEDULE_REPLACEMENT_CONFLICT', 'TIME_ZONE_CONFLICT',
] as const;
export type ErrorCode = typeof errorCodes[number];
export const errorSchema = T.Object({
  code: T.Union(errorCodes.map((value) => T.Literal(value))),
  requestId: T.String(),
  retryAfter: T.Optional(T.Integer({ minimum: 1 })),
});
