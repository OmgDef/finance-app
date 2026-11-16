import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import type { Body, Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { apiErrorCode } from './finance-commands';
import type { FinanceAccess, FinanceDraft } from './finance-commands';
import { financeCopy } from './finance-copy';
import { addFinancialDays, formatFinancialDate, formatMoney, formatProfileMoment } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { scheduleCopy } from './finance-schedule-copy';
import { ScheduleEditor } from './finance-schedule-editor';
import { ScheduleReplacement } from './finance-schedule-replacement';
import { Choice, FinanceAlert, FinanceButton, FinanceField, palette, styles, transactionAmountColor } from './finance-ui';

export type SchedulePage = {
  name: 'schedule';
  accountId: string | null;
  ruleId?: string;
  editor?: 'create' | 'edit' | 'replace';
  skipDate?: string;
  offset?: number;
  section?: 'dates' | 'rules';
};
type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];
export type ScheduleRule = Result<'getScheduleRule'>;
export type ScheduleOccurrence = Result<'listScheduleOccurrences'>['occurrences'][number];
type Create = Body<'createScheduleRule'>;
type Change = Body<'changeScheduleRule'>;
export const scheduleRangeDays = 90;

function canSkip(entry: ScheduleOccurrence) {
  return !entry.recoveryHeld && (entry.status === 'due' || entry.status === 'retrying' || entry.status === 'needs_intervention');
}

function ScheduleSkipForm({ entry, lang, disabled, onSubmit }: {
  entry: ScheduleOccurrence;
  lang: Language;
  disabled: boolean;
  onSubmit: (draft: FinanceDraft) => void;
}) {
  const t = scheduleCopy[lang];
  const [reason, setReason] = useState('');
  const { ruleId, date, amountMinor, kind, currency } = entry;
  const explanation = reason.trim();
  return <View style={layout.section}>
    <View style={layout.ruleCard}>
      <View style={layout.row}>
        <Text style={layout.identity}>{formatFinancialDate(date, lang)}</Text>
        <Text style={styles.value}>{formatMoney(kind === 'expense' ? '-' + amountMinor : amountMinor, currency, lang, true)}</Text>
      </View>
      <Text style={styles.meta}>{t.skipExplanation}</Text>
    </View>
    <FinanceField title={t.skipReason} value={reason} onChangeText={setReason} editable={!disabled}
      multiline maxLength={500} testID="schedule-skip-reason" />
    <FinanceButton title={t.skip} onPress={() => {
      void KeyboardController.dismiss();
      onSubmit({ kind: 'schedule.skip', ruleId, date, body: { reason: explanation } });
    }} primary disabled={disabled || !explanation} testID="schedule-skip-save" />
  </View>;
}

export function ScheduleScreen({ page, access, accounts, categories, lang, disabled, visible, refreshSignal,
  commandError, onSubmit, onPage, onSaving, onCancel, onSaved, onTransaction }: {
  page: SchedulePage;
  access: FinanceAccess;
  accounts: Account[] | undefined;
  categories: Category[] | undefined;
  lang: Language;
  disabled: boolean;
  visible: boolean;
  refreshSignal: number;
  commandError: string;
  onSubmit: (draft: FinanceDraft) => void;
  onPage: (page: SchedulePage) => void;
  onSaving: (saving: boolean) => void;
  onCancel: () => void;
  onSaved: (page: SchedulePage, created: boolean) => void;
  onTransaction: (entry: ScheduleOccurrence) => void;
}) {
  const t = scheduleCopy[lang];
  const f = financeCopy[lang];
  const { today, timeZone } = access.profile;
  const { accountId, ruleId, editor, skipDate, offset = 0, section = 'dates' } = page;
  const editing = !!editor || !!skipDate;
  const [snapshot, setSnapshot] = useState<{ key: string; rules: ScheduleRule[]; dates: ScheduleOccurrence[] }>();
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [accountFilterOpen, setAccountFilterOpen] = useState(false);
  const reading = useRef(0);
  const writing = useRef(false);
  const mounted = useRef(false);
  const scope = useRef('');
  const writeScope = useRef('');
  const displayed = useRef(visible);
  displayed.current = visible;
  const from = addFinancialDays(today, offset * scheduleRangeDays);
  const through = addFinancialDays(from, scheduleRangeDays - 1);
  const key = [accountId, ruleId, from, timeZone].join(':');
  const viewKey = key + ':' + (editor ?? skipDate ?? '');
  const writeKey = [accountId, ruleId, editor].join(':');
  scope.current = viewKey;
  writeScope.current = writeKey;
  const isCurrent = () => mounted.current && displayed.current && scope.current === viewKey && access.isCurrent();
  const active = snapshot?.key === key ? snapshot : undefined;
  const selectedRule = ruleId ? active?.rules.find((item) => item.ruleId === ruleId) : undefined;
  const selectedAccount = accounts?.find((item) => item.accountId === (selectedRule?.accountId ?? accountId));
  const skipTarget = skipDate ? active?.dates.find((item) => item.date === skipDate && item.ruleId === ruleId && canSkip(item)) : undefined;
  const earliestUnsettled = new Map<string, string>();
  for (const entry of active?.dates ?? []) {
    if (!earliestUnsettled.has(entry.ruleId) && (canSkip(entry) || entry.status === 'paused')) {
      earliestUnsettled.set(entry.ruleId, entry.date);
    }
  }
  const mustRefresh = !!writeError && writeError !== 'INVALID_REQUEST';
  const mayDelete = !disabled && !saving && !busy && !readError && !mustRefresh && !!selectedRule && !!selectedAccount &&
    !selectedAccount.archived && !selectedRule.recoveryHeld;
  const mayWrite = mayDelete && selectedRule.state !== 'ended';
  const categoryName = (id: string) => {
    const category = categories?.find((item) => item.id === id);
    return category ? (lang === 'ru' ? category.nameRu : category.nameEn) : undefined;
  };
  const kindName = (kind: Create['kind']) => kind === 'expense' ? f.expenseEntry : f.incomeEntry;

  async function load() {
    if (!isCurrent()) return;
    const attempt = ++reading.current;
    const current = () => attempt === reading.current && isCurrent();
    setBusy(true);
    setReadError('');
    try {
      const query = new URLSearchParams({ fromDate: from, throughDate: through });
      if (ruleId) query.set('ruleId', ruleId);
      else if (accountId) query.set('accountId', accountId);
      const [rules, dates] = await Promise.all([
        ruleId ? request('getScheduleRule', { token: access.token, params: { ruleId } }).then((rule) => [rule])
          : request('listScheduleRules', { token: access.token,
            query: accountId ? new URLSearchParams({ accountId }) : undefined }).then((result) => result.rules),
        request('listScheduleOccurrences', { token: access.token, query }),
      ]);
      if (current()) setSnapshot({ key, rules, dates: dates.occurrences });
    } catch (error) {
      if (current()) {
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setReadError(code);
      }
    } finally {
      if (current()) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; reading.current += 1; };
  }, []);

  useEffect(() => {
    if (!editing || !snapshot || snapshot.key !== key) void load();
    else setBusy(false);
    return () => { reading.current += 1; };
  }, [viewKey, visible, refreshVersion, refreshSignal]);

  useEffect(() => {
    if (ruleId && !editing && (commandError === 'VERSION_CONFLICT' || commandError === 'NOT_FOUND' ||
        commandError === 'SCHEDULE_RULE_STATE_CONFLICT')) void load();
  }, [commandError]);

  function show(next: SchedulePage) {
    reading.current += 1;
    setReadError('');
    setWriteError('');
    onPage(next);
  }

  function refresh() {
    setWriteError('');
    if (editing) onCancel();
    else setRefreshVersion((version) => version + 1);
  }

  async function save(body: Create | Change) {
    if (!isCurrent() || disabled || writing.current || readError || mustRefresh) return;
    writing.current = true;
    reading.current += 1;
    setSaving(true);
    onSaving(true);
    setWriteError('');
    const current = () => mounted.current && writeScope.current === writeKey && access.isCurrent();
    try {
      const updated = 'action' in body && ruleId
        ? await request('changeScheduleRule', { token: access.token, body, params: { ruleId } })
        : 'accountId' in body ? await request('createScheduleRule', { token: access.token, body }) : undefined;
      if (!current() || !updated) return;
      if (editor) {
        const nextOffset = editor === 'create' && updated.firstDate < today ? scheduleOffset(today, updated.firstDate) : offset;
        onSaved({ ...page, ruleId: updated.ruleId, editor: undefined, offset: nextOffset }, editor === 'create');
      }
      else {
        setSnapshot((previous) => previous?.key === key ? { ...previous, rules: [updated] } : previous);
        setRefreshVersion((version) => version + 1);
      }
    } catch (error) {
      if (current()) {
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setWriteError(code);
      }
    } finally {
      writing.current = false;
      if (mounted.current && access.isCurrent()) {
        setSaving(false);
        onSaving(false);
      }
    }
  }

  function change(action: 'pause' | 'resume' | 'end') {
    if (!selectedRule || !mayWrite) return;
    const label = t[action];
    Alert.alert(label, action === 'end' ? t.confirmEnd : t.pendingChange, [
      { text: copy[lang].cancel, style: 'cancel' },
      { text: label, ...(action === 'end' && { style: 'destructive' as const }),
        onPress: () => void save({ action, expectedRuleVersion: selectedRule.ruleVersion }) },
    ]);
  }

  function confirmDelete() {
    if (!selectedRule || !mayDelete) return;
    Alert.alert(t.deleteRule, t.confirmDelete, [
      { text: copy[lang].cancel, style: 'cancel' },
      { text: t.deleteRule, style: 'destructive', onPress: () => {
        if (isCurrent()) onSubmit({ kind: 'schedule.delete', ruleId: selectedRule.ruleId,
          body: { expectedRuleVersion: selectedRule.ruleVersion } });
      } },
    ]);
  }

  const problem = writeError || readError;
  const errorLabel = problem === 'VERSION_CONFLICT' || problem === 'SCHEDULE_RULE_STATE_CONFLICT' ? t.conflict
    : problem === 'NOT_FOUND' || problem === 'ACCOUNT_UNAVAILABLE' ? t.unavailable
    : writeError && ['NETWORK', 'TEMPORARY_FAILURE', 'INTERNAL_ERROR'].includes(problem) ? t.unconfirmed
    : problem === 'INVALID_REQUEST' ? f.invalidRequest : copy[lang].errors[problem] ?? f.error;
  const canCreate = accounts?.some((item) => !item.archived && (!accountId || item.accountId === accountId));

  return <View style={layout.section} testID="schedule-screen">
    {selectedAccount && (editing || ruleId) &&
      <Text style={styles.meta}>{editor === 'replace' && t.source + ' · '}{selectedAccount.name}</Text>}
    {busy && !active && <ActivityIndicator color={palette.accent} accessibilityLabel={f.loading} />}
    {problem && <View style={layout.group}>
      <FinanceAlert>{errorLabel}</FinanceAlert>
      {(readError || mustRefresh) && <FinanceButton title={t.reload} onPress={refresh} disabled={busy || saving} testID="schedule-reload" />}
    </View>}
    {editor && !categories && !problem && <ActivityIndicator color={palette.accent} accessibilityLabel={f.loading} />}
    {editor === 'create' && accounts && categories && canCreate && <ScheduleEditor mode="create" lang={lang} accounts={accounts}
      categories={categories} scopedAccountId={accountId} today={today} disabled={disabled || saving || busy || !!readError || mustRefresh}
      onSave={(body) => void save(body)} />}
    {editor === 'edit' && accounts && categories && selectedRule && <ScheduleEditor key={selectedRule.ruleVersion} mode="edit"
      rule={selectedRule} lang={lang} accounts={accounts} categories={categories} scopedAccountId={accountId} today={today}
      disabled={!mayWrite} onSave={(fields) => void save({ ...fields, action: 'edit', expectedRuleVersion: selectedRule.ruleVersion })} />}
    {editor === 'replace' && selectedRule && accounts && categories && <ScheduleReplacement key={selectedRule.ruleId}
      rule={selectedRule} accounts={accounts} categories={categories} lang={lang} access={access} visible={visible}
      disabled={disabled || saving || !!readError} commandError={commandError} onSubmit={onSubmit} />}
    {skipDate && (commandError === 'SCHEDULE_DATE_CONFLICT'
      ? <FinanceButton title={t.reload} onPress={onCancel} disabled={disabled} testID="schedule-reload" />
      : skipTarget ? <ScheduleSkipForm key={skipTarget.ruleId + skipDate} entry={skipTarget} lang={lang}
        disabled={disabled || busy || saving || !!readError} onSubmit={onSubmit} /> : active && <FinanceAlert>{t.skipChanged}</FinanceAlert>)}
    {!editing && !ruleId && <>
      {!!accounts?.length && <View style={layout.section}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: accountFilterOpen, disabled: saving }}
          accessibilityLabel={f.account + ', ' + (selectedAccount?.name ?? (accountId ? t.unavailable : t.allAccounts))}
          testID="schedule-account-filter" disabled={saving} onPress={() => setAccountFilterOpen((open) => !open)}
          style={[styles.surface, layout.accountFilter]}>
          <Text style={[styles.title, layout.accountFilterTitle]}>
            {f.account} · {selectedAccount?.name ?? (accountId ? t.unavailable : t.allAccounts)}
          </Text>
          <FinanceIcon name={accountFilterOpen ? 'chevron-down' : 'chevron'} color={palette.muted} size={15} />
        </Pressable>
        {accountFilterOpen && <Choice title={t.filterByAccount} value={accountId ?? 'all'} testID="schedule-filter-account"
          options={[{ id: 'all', label: t.allAccounts }, ...accounts.map((account) => ({
            id: account.accountId, label: account.archived ? account.name + ' · ' + f.archivedAccount : account.name,
          }))]} onChange={(id) => {
            setAccountFilterOpen(false);
            onPage({ ...page, accountId: id === 'all' ? null : id });
          }} />}
      </View>}
      {canCreate && <FinanceButton title={t.newRule} onPress={() => show({ ...page, editor: 'create' })} primary
        disabled={disabled || saving || busy} testID="schedule-create" />}
      {accounts && !accounts.length && <Text style={styles.meta}>{t.noAccount}</Text>}
      <View style={layout.actions} accessibilityRole="tablist">
        {(['dates', 'rules'] as const).map((value) => <Pressable key={value} accessibilityRole="tab"
          accessibilityState={{ selected: section === value }} onPress={() => onPage({ ...page, section: value })}
          style={[layout.sectionTab, section === value && styles.checked]} testID={'schedule-section-' + value}>
          <Text style={styles.buttonText}>{t[value]}</Text>
        </Pressable>)}
      </View>
    </>}
    {!editing && selectedRule && <View style={layout.ruleCard}>
      <View style={layout.row}>
        <Text style={layout.identity}>{categoryName(selectedRule.categoryId) ?? kindName(selectedRule.kind)}</Text>
        <Text style={styles.value}>{formatMoney(selectedRule.amountMinor, selectedRule.currency, lang)}</Text>
      </View>
      <Text style={styles.meta}>{t[selectedRule.frequency]} · {t[selectedRule.state]} · {kindName(selectedRule.kind)}</Text>
      {selectedRule.recoveryHeld && <Text style={styles.meta}>{t.recoveryHeld}</Text>}
      <Text style={styles.meta}>{formatFinancialDate(selectedRule.firstDate, lang)}
        {selectedRule.endDate && ' – ' + formatFinancialDate(selectedRule.endDate, lang)}</Text>
      <Text style={styles.meta} testID="schedule-effective-at">{t.effective} {formatProfileMoment(selectedRule.effectiveAt, timeZone, lang)}</Text>
      {(selectedRule.source ?? selectedRule.incomeSource)
        ? <Text style={styles.title}>{f.transactionSource} · {selectedRule.source ?? selectedRule.incomeSource}</Text>
        : <Text style={styles.meta}>{f.noTransactionSource}</Text>}
      {selectedRule.comment && <Text style={styles.label}>{selectedRule.comment}</Text>}
      {[{ link: selectedRule.replaces, label: t.oldRule }, { link: selectedRule.replacedBy, label: t.nextRule }].map(({ link, label }) => link &&
        <View key={link.ruleId} style={layout.group}>
          <FinanceButton title={label} onPress={() => show({ ...page, ruleId: link.ruleId,
            offset: scheduleOffset(today, link.transitionDate) })} disabled={saving}
            testID={'schedule-linked-' + link.ruleId} />
          <Text style={styles.meta}>{t.transition} {formatFinancialDate(link.transitionDate, lang)} · {formatProfileMoment(link.transitionAt, timeZone, lang)}</Text>
        </View>)}
      {!selectedAccount?.archived && <View style={layout.actions}>
        {selectedRule.state !== 'ended' && <>
          <FinanceButton title={t.edit} onPress={() => show({ ...page, editor: 'edit' })}
            disabled={!mayWrite} testID="schedule-edit" />
          <FinanceButton title={t.replace} onPress={() => show({ ...page, editor: 'replace' })}
            disabled={!mayWrite || (selectedRule.replaces !== undefined && selectedRule.replaces.transitionAt > Date.now())}
            testID="schedule-replace" />
          {selectedRule.state === 'active'
            ? <FinanceButton title={t.pause} onPress={() => change('pause')} disabled={!mayWrite} testID="schedule-pause" />
            : <FinanceButton title={t.resume} onPress={() => change('resume')} disabled={!mayWrite} testID="schedule-resume" />}
          <FinanceButton title={t.end} onPress={() => change('end')} disabled={!mayWrite} testID="schedule-finish" />
        </>}
        <FinanceButton title={t.deleteRule} onPress={confirmDelete} disabled={!mayDelete} destructive testID="schedule-delete" />
      </View>}
    </View>}
    {!editing && (ruleId || section === 'dates') && <>
      {ruleId && <Text accessibilityRole="header" style={styles.section}>{t.dates}</Text>}
      <View style={layout.group}>
        <Text style={styles.meta} testID="schedule-period">{formatFinancialDate(from, lang)} – {formatFinancialDate(through, lang)}</Text>
        <View style={layout.actions}>
          <FinanceButton title={t.previous} onPress={() => show({ ...page, offset: offset - 1 })}
            disabled={busy || saving} testID="schedule-previous" />
          <FinanceButton title={t.next} onPress={() => show({ ...page, offset: offset + 1 })}
            disabled={busy || saving} testID="schedule-next" />
          {offset !== 0 && <FinanceButton title={t.today} onPress={() => show({ ...page, offset: 0 })} disabled={busy || saving} />}
        </View>
      </View>
      {active && !active.dates.length && <Text style={styles.meta}>{t.noDates}</Text>}
      {active && active.dates.length > 0 && <View style={layout.list}>
        {active.dates.map((entry) => {
          const showSkip = canSkip(entry) && earliestUnsettled.get(entry.ruleId) === entry.date &&
            accounts?.some((item) => item.accountId === entry.accountId && !item.archived);
          const amountMinor = entry.kind === 'expense' ? '-' + entry.amountMinor : entry.amountMinor;
          return <View key={entry.ruleId + entry.date} style={layout.entry}
            testID={'schedule-date-' + entry.ruleId + '-' + entry.date}>
            <View style={layout.row}>
              <Text style={layout.identity}>{formatFinancialDate(entry.date, lang)} · {categoryName(entry.categoryId) ?? kindName(entry.kind)}</Text>
              <Text style={[layout.amount, entry.status === 'posted' && { color: transactionAmountColor(amountMinor) }]}>
                {formatMoney(amountMinor, entry.currency, lang, true)}
              </Text>
            </View>
            <Text style={entry.status === 'needs_intervention' ? styles.alert : styles.meta}>{t[entry.status]}
              {!ruleId && ' · ' + (accounts?.find((item) => item.accountId === entry.accountId)?.name ?? t.unavailable)}</Text>
            {(entry.source ?? entry.incomeSource) && <Text style={styles.title}>{entry.source ?? entry.incomeSource}</Text>}
            {entry.comment && <Text style={styles.meta}>{entry.comment}</Text>}
            {entry.reason && <Text style={styles.meta}>{entry.reason}</Text>}
            {entry.sourceOccurrenceId && <Text style={styles.meta}>{t.carriedSkip}</Text>}
            {entry.recoveryHeld && <Text style={styles.meta}>{t.recoveryHeld}</Text>}
            {entry.errorCode && <Text style={styles.meta}>{entry.errorCode === 'TEMPORARY_FAILURE' ? t.temporaryFailure
              : entry.errorCode === 'RECOVERY_UNCERTAIN' ? t.recoveryUncertain : t.dataFailure}</Text>}
            {entry.nextAttemptAt !== undefined && <Text style={styles.meta}>{t.retryAt} {formatProfileMoment(entry.nextAttemptAt, timeZone, lang)}</Text>}
            {(!ruleId || entry.transactionId || showSkip) && <View style={layout.actions}>
              {!ruleId && <Pressable accessibilityRole="button" style={layout.link}
                onPress={() => show({ ...page, ruleId: entry.ruleId })} testID={'schedule-date-rule-' + entry.ruleId + '-' + entry.date}>
                <Text style={layout.linkText}>{t.rule}</Text>
              </Pressable>}
              {entry.transactionId && <Pressable accessibilityRole="button" style={layout.link} disabled={saving}
                onPress={() => onTransaction(entry)} testID={'schedule-transaction-' + entry.transactionId}>
                <Text style={layout.linkText}>{t.operation}</Text>
              </Pressable>}
              {showSkip && <FinanceButton title={t.skip} onPress={() => show({ ...page, ruleId: entry.ruleId, skipDate: entry.date })}
                disabled={disabled || saving || busy || !!readError} testID={'schedule-skip-' + entry.ruleId + '-' + entry.date} />}
            </View>}
          </View>;
        })}
      </View>}
    </>}
    {!editing && !ruleId && section === 'rules' && active && <>
      {active.rules.length === 0 ? <Text style={styles.meta}>{t.noRules}</Text> : <View style={layout.list}>
        {active.rules.map((rule) => <Pressable key={rule.ruleId} accessibilityRole="button" style={layout.entry}
          onPress={() => show({ ...page, ruleId: rule.ruleId })} testID={'schedule-rule-' + rule.ruleId}>
          <View style={layout.row}>
            <Text style={layout.identity}>{rule.source ?? rule.incomeSource ?? categoryName(rule.categoryId) ?? kindName(rule.kind)}</Text>
            <Text style={layout.amount}>{formatMoney(rule.amountMinor, rule.currency, lang)}</Text>
          </View>
          <Text style={styles.meta}>{(rule.source ?? rule.incomeSource) && (categoryName(rule.categoryId) ?? kindName(rule.kind)) + ' · '}
            {t[rule.frequency]} · {t[rule.state]}{rule.recoveryHeld && ' · ' + t.recoveryHeld}
            {!accountId && ' · ' + (accounts?.find((item) => item.accountId === rule.accountId)?.name ?? t.unavailable)}</Text>
        </Pressable>)}
      </View>}
    </>}
  </View>;
}

export function scheduleOffset(today: string, date: string) {
  const time = (day: string) => Date.parse(day + 'T00:00:00Z');
  return Math.floor((time(date) - time(today)) / (scheduleRangeDays * 86_400_000));
}

const layout = StyleSheet.create({
  accountFilter: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, padding: 12 },
  accountFilterTitle: { flex: 1 },
  section: { gap: 16 },
  group: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sectionTab: { ...styles.choice, flexGrow: 1, alignItems: 'center' },
  ruleCard: { backgroundColor: palette.panel, borderRadius: 12, padding: 14, gap: 8 },
  list: { backgroundColor: palette.panel, borderRadius: 12, paddingHorizontal: 12 },
  entry: { gap: 4, paddingVertical: 10, minHeight: 48, borderBottomColor: palette.line, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  identity: { ...styles.title, flexGrow: 1, flexBasis: '50%' },
  amount: { ...styles.title, textAlign: 'right', fontVariant: ['tabular-nums'] },
  link: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  linkText: { ...styles.title, color: palette.accent },
});
