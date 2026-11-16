import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import type { Body, Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { apiErrorCode } from './finance-commands';
import type { FinanceAccess } from './finance-commands';
import { financeCopy } from './finance-copy';
import type { FinanceCopyKey } from './finance-copy';
import { addFinancialDays, amountInMinorUnits, formatAmount, formatFinancialDate, formatMoney } from './finance-format';
import { useLocalizedInput } from './finance-forms';
import { scheduleCopy } from './finance-schedule-copy';
import { FinanceAlert, FinanceButton, FinanceField, palette, styles } from './finance-ui';

type Account = Result<'getAccountBalance'>;
type Category = Result<'listCategories'>['categories'][number];
type Preview = Result<'previewBalanceAdjustment'>;
type PreviewDate = Preview['dates'][number];
type Submission = Omit<Body<'reconcileAccountBalance'>, 'idempotencyKey'>;
type SelectedDate = NonNullable<Submission['skippedDates']>[number];
type Snapshot = { key: string; calendar: string; preview: Preview };
type Review = { snapshot: Snapshot; body: Submission & { skippedDates: SelectedDate[] } };
type OutstandingDate = Pick<PreviewDate, 'ruleId' | 'date'>;

const rangeDays = 90;
const minMinor = -9223372036854775808n;
const maxMinor = 9223372036854775807n;
const firstSupportedDate = '1000-01-01';
const lastSupportedDate = '9999-12-31';

export function reconciliationConflict(code: string) {
  return code === 'VERSION_CONFLICT' || code === 'SCHEDULE_DATES_PENDING' || code === 'SCHEDULE_DATE_CONFLICT';
}

function dateKey(date: { ruleId: string; date: string }) {
  return date.ruleId + '-' + date.date;
}

function eligibleDates(preview: Preview) {
  return preview.dates.filter(({ status }) => status !== 'posted' && status !== 'skipped');
}

function awaitingProcessing({ status }: PreviewDate) {
  return status === 'due' || status === 'retrying' || status === 'needs_intervention';
}

function needsRecoveryReview(date: PreviewDate) {
  return date.recoveryHeld || date.errorCode === 'RECOVERY_UNCERTAIN';
}

function selectedDate({ ruleId, date, ruleVersion, dueAt, kind, amountMinor, categoryId, comment }: PreviewDate): SelectedDate {
  return { ruleId, date, ruleVersion, dueAt, kind, amountMinor, categoryId, comment, reason: '' };
}

function sameDate(a: SelectedDate, b: SelectedDate) {
  return a.ruleVersion === b.ruleVersion && a.dueAt === b.dueAt && a.kind === b.kind &&
    a.amountMinor === b.amountMinor && a.categoryId === b.categoryId && a.comment === b.comment;
}

export function ReconciliationForm({ account, categories, access, lang, visible, disabled, commandError, onSubmit }: {
  account: Account;
  categories: Category[] | undefined;
  access: FinanceAccess;
  lang: Language;
  visible: boolean;
  disabled: boolean;
  commandError: string;
  onSubmit: (body: Submission) => void;
}) {
  const t = financeCopy[lang];
  const s = scheduleCopy[lang];
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [handledConflict, setHandledConflict] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [failed, setFailed] = useState<{ key: string; code: string }>();
  const [selected, setSelected] = useState<SelectedDate[]>([]);
  const [outstanding, setOutstanding] = useState<OutstandingDate[]>([]);
  const [sawDates, setSawDates] = useState(false);
  const [none, setNone] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState<FinanceCopyKey>();
  const [review, setReview] = useState<Review>();
  const actual = useLocalizedInput(lang, '', amountInMinorUnits, formatAmount);
  const { today, timeZone } = access.profile;
  const calendar = [account.accountId, today, timeZone].join(':');
  const from = addFinancialDays(today, rangeDays * offset - 30);
  const through = addFinancialDays(today, rangeDays * (offset + 1) - 31);
  const fromDate = from < firstSupportedDate || from.startsWith('-') ? firstSupportedDate : from;
  const throughDate = through > lastSupportedDate || through.startsWith('+') ? lastSupportedDate : through;
  const key = [calendar, offset, refresh].join(':');
  const activeKey = useRef('');
  activeKey.current = visible ? key : '';
  const latest = useRef<Snapshot | undefined>(undefined);
  const current = snapshot?.key === key ? snapshot : undefined;
  const readError = failed?.key === key ? failed.code : undefined;
  const dates = current ? eligibleDates(current.preview) : [];
  const selection = new Map(selected.map((date) => [dateKey(date), date]));
  const unselectedDue = outstanding.some((entry) => !selection.has(dateKey(entry)));
  const needsRefresh = reconciliationConflict(commandError) && commandError !== handledConflict;
  const canEdit = visible && !disabled && !needsRefresh;
  const editableDates = canEdit && !!current;
  const delta = actual.value !== undefined && current ? BigInt(actual.value) - BigInt(current.preview.balanceMinor) : undefined;
  const currency = current?.preview.currency ?? account.currency;
  const confirmedReview = !needsRefresh && review?.snapshot === current ? review : undefined;
  const loading = !current && !readError;

  function reload() {
    setSelected([]);
    setSawDates(false);
    setNone(false);
    setError(undefined);
    setReview(undefined);
    setRefresh((value) => value + 1);
  }

  useEffect(() => {
    setHandledConflict(commandError);
    if (reconciliationConflict(commandError) || commandError === 'ACCOUNT_UNAVAILABLE') reload();
  }, [commandError]);

  useEffect(() => {
    if (!visible || !access.isCurrent()) {
      setReview(undefined);
      return;
    }
    let disposed = false;
    const stillCurrent = () => !disposed && activeKey.current === key && access.isCurrent();
    const previous = latest.current;
    const query = new URLSearchParams({ fromDate, throughDate });
    if (snapshot?.key === key) setSnapshot(undefined);
    setFailed(undefined);
    setReview(undefined);
    setError(undefined);
    setNone(false);
    if (previous && previous.calendar !== calendar) setOutstanding([]);
    void request('previewBalanceAdjustment', { token: access.token, params: { accountId: account.accountId }, query })
      .then((preview) => {
        if (!stillCurrent()) return;
        const versionChanged = previous &&
          (previous.calendar !== calendar || previous.preview.accountVersion !== preview.accountVersion);
        const available = eligibleDates(preview);
        const availableByKey = new Map(available.filter((date) => !needsRecoveryReview(date))
          .map((date) => [dateKey(date), selectedDate(date)]));
        setOutstanding((known) => [
          ...known.filter(({ date }) => date < fromDate || date > throughDate),
          ...available.filter(awaitingProcessing).map(({ date, ruleId }) => ({ date, ruleId })),
        ]);
        setSelected((choices) => versionChanged ? [] : choices.filter((choice) => {
          if (choice.date < fromDate || choice.date > throughDate) return true;
          const fresh = availableByKey.get(dateKey(choice));
          return fresh !== undefined && sameDate(choice, fresh);
        }));
        setSawDates((saw) => available.length > 0 || (!versionChanged && saw));
        const next = { key, calendar, preview };
        latest.current = next;
        setSnapshot(next);
      })
      .catch((failure: unknown) => {
        if (!stillCurrent()) return;
        const code = apiErrorCode(failure);
        if (!access.onAccessFailure(code)) setFailed({ key, code });
      });
    return () => { disposed = true; };
  }, [key, visible]);

  function toggle(entry: PreviewDate) {
    setReview(undefined);
    setNone(false);
    setError(undefined);
    const key = dateKey(entry);
    setSelected((choices) => selection.has(key)
      ? choices.filter((choice) => dateKey(choice) !== key) : [...choices, selectedDate(entry)]);
  }

  function reviewAdjustment() {
    if (!editableDates || !current || !access.isCurrent()) return;
    if (actual.value === undefined || delta === undefined) return setError('invalidAmount');
    if (!explanation.trim()) return setError('invalidReconciliationReason');
    if (delta < minMinor || delta > maxMinor) return setError('reconciliationOutOfRange');
    if (unselectedDue) return setError('reconcileUnsettledSelection');
    if (!selected.length && sawDates && !none) return setError('reconcileConfirmDates');
    if (selected.some(({ reason }) => !reason.trim())) return setError('reconcileSkipReasonRequired');
    setError(undefined);
    void KeyboardController.dismiss();
    setReview({ snapshot: current, body: {
      expectedAccountVersion: current.preview.accountVersion,
      actualBalanceMinor: actual.value,
      explanation: explanation.trim(),
      skippedDates: selected.map((date) => ({ ...date, reason: date.reason.trim() })),
    } });
  }

  function entryTitle(entry: Pick<PreviewDate, 'categoryId' | 'kind'>) {
    const category = categories?.find(({ id }) => id === entry.categoryId);
    return category ? lang === 'ru' ? category.nameRu : category.nameEn
      : entry.kind === 'expense' ? t.expenseEntry : t.incomeEntry;
  }

  return <View style={layout.form}>
    <Text style={styles.title}>{account.name}</Text>
    {readError && <FinanceAlert>{readError === 'NOT_FOUND' || readError === 'ACCOUNT_UNAVAILABLE'
      ? t.unavailable : copy[lang].errors[readError] ?? t.error}</FinanceAlert>}
    {(current || loading) && <View style={layout.amountRow}>
      <Text style={styles.meta}>{t.currentBalance}</Text>
      {current ? <Text style={styles.value} testID="finance-reconcile-current">
        {formatMoney(current.preview.balanceMinor, currency, lang)}
      </Text> : <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
    </View>}
    <FinanceField title={t.actualBalance} currency={currency} value={actual.text} onChangeText={(value) => {
      actual.setText(value);
      setReview(undefined);
    }} editable={canEdit} keyboardType="numbers-and-punctuation" maxLength={30} testID="finance-reconcile-amount" />
    <FinanceField title={t.reconciliationReason} value={explanation} onChangeText={(value) => {
      setExplanation(value);
      setReview(undefined);
    }} editable={canEdit} multiline maxLength={500} testID="finance-reconcile-reason" />
    {delta !== undefined && <View style={layout.amountRow}>
      <Text style={styles.meta}>{t.reconciliationDelta}</Text>
      <Text style={styles.value}>{formatMoney(String(delta), currency, lang, true)}</Text>
    </View>}
    <View style={layout.section}>
      <Text accessibilityRole="header" style={styles.section}>{t.reconcileSchedule}</Text>
      <Text style={styles.meta}>{formatFinancialDate(fromDate, lang)} – {formatFinancialDate(throughDate, lang)}</Text>
      <View style={layout.actions}>
        <FinanceButton title={s.previous} onPress={() => setOffset((value) => value - 1)}
          disabled={!canEdit || fromDate === firstSupportedDate} testID="finance-reconcile-earlier" />
        <FinanceButton title={s.next} onPress={() => setOffset((value) => value + 1)}
          disabled={!canEdit || throughDate === lastSupportedDate} testID="finance-reconcile-later" />
        <FinanceButton title={t.reloadAccount} onPress={reload} disabled={!canEdit || (!current && !readError)}
          testID="finance-reconcile-refresh" />
      </View>
      {current && (dates.length === 0 ? <Text style={styles.meta}>{t.reconcileNoDates}</Text>
        : <Text style={styles.meta}>{t.reconcileChooseDates}</Text>)}
      {unselectedDue && <FinanceAlert testID="finance-reconcile-awaiting">{t.reconcileAwaiting}</FinanceAlert>}
      {!!dates.length && <View style={layout.dates}>
        {dates.map((entry, index) => {
          const key = dateKey(entry);
          const choice = selection.get(key);
          const amount = entry.kind === 'expense' ? '-' + entry.amountMinor : entry.amountMinor;
          const canSelect = editableDates && !needsRecoveryReview(entry);
          return <View key={key} style={[layout.date, index > 0 && layout.divider]}>
            <View style={layout.amountRow}>
              <Text style={styles.title}>{formatFinancialDate(entry.date, lang)} · {entryTitle(entry)}</Text>
              <Text style={styles.value}>{formatMoney(amount, currency, lang, true)}</Text>
            </View>
            <Text style={styles.meta}>{s[entry.status]}</Text>
            {needsRecoveryReview(entry) && <Text style={styles.meta}>
              {entry.recoveryHeld ? s.recoveryHeld : s.recoveryUncertain}
            </Text>}
            {entry.comment && <Text style={styles.meta}>{entry.comment}</Text>}
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: !!choice, disabled: !canSelect }}
              disabled={!canSelect} onPress={() => toggle(entry)} testID={'finance-reconcile-date-' + key}
              style={[layout.checkbox, choice && styles.checked, !canSelect && styles.dimmed]}>
              <Text style={styles.buttonText}>{choice ? t.reconcileIncluded : t.reconcileInclude}</Text>
            </Pressable>
            {choice && <FinanceField title={s.skipReason} value={choice.reason} onChangeText={(reason) => {
              setReview(undefined);
              setError(undefined);
              setSelected((choices) => choices.map((value) => dateKey(value) === key ? { ...value, reason } : value));
            }} editable={canSelect} multiline maxLength={500} testID={'finance-reconcile-date-reason-' + key} />}
          </View>;
        })}
      </View>}
      {selected.length > 0 && <Text style={styles.meta}>{t.reconcileSelected} · {selected.length}</Text>}
      {current && !selected.length && sawDates && !unselectedDue && <Pressable accessibilityRole="checkbox"
        accessibilityState={{ checked: none, disabled: !editableDates }} disabled={!editableDates}
        style={[layout.checkbox, none && styles.checked, !editableDates && styles.dimmed]}
        testID="finance-reconcile-no-dates" onPress={() => {
          setNone(!none);
          setReview(undefined);
          setError(undefined);
        }}>
        <Text style={styles.buttonText}>{t.reconcileNoneIncluded}</Text>
      </Pressable>}
    </View>
    {error && <FinanceAlert>{t[error]}</FinanceAlert>}
    {confirmedReview && current && delta !== undefined ? <View style={layout.review}>
      <Text accessibilityRole="header" style={styles.section}>{t.reconcileReview}</Text>
      <View style={layout.amountRow}>
        <Text style={styles.label}>{t.actualBalance}</Text>
        <Text style={styles.value}>{formatMoney(confirmedReview.body.actualBalanceMinor, currency, lang)}</Text>
      </View>
      <View style={layout.amountRow}>
        <Text style={styles.label}>{t.reconciliationDelta}</Text>
        <Text style={styles.value}>{formatMoney(String(delta), currency, lang, true)}</Text>
      </View>
      <Text style={styles.label}>{confirmedReview.body.explanation}</Text>
      {confirmedReview.body.skippedDates?.length ? <>
        <Text style={styles.title}>{t.reconcileSkippedDates}</Text>
        {confirmedReview.body.skippedDates.map((entry) => <View key={dateKey(entry)} style={layout.section}>
          <Text style={styles.label}>{formatFinancialDate(entry.date, lang)} · {entryTitle(entry)}</Text>
          <Text style={styles.meta}>{entry.reason}</Text>
        </View>)}
      </> : <Text style={styles.meta}>{t.reconcileNoSkips}</Text>}
      <FinanceButton title={t.reconcileConfirm} primary disabled={!editableDates} testID="finance-reconcile-confirm"
        onPress={() => {
          if (editableDates && activeKey.current === key && access.isCurrent()) onSubmit(confirmedReview.body);
        }} />
    </View> : <FinanceButton title={t.reconcileReview} primary disabled={!editableDates} onPress={reviewAdjustment}
      testID="finance-reconcile-save" />}
  </View>;
}

const layout = StyleSheet.create({
  form: { gap: 16 },
  section: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  amountRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  dates: { borderRadius: 12, backgroundColor: palette.panel, paddingHorizontal: 12 },
  date: { paddingVertical: 12, gap: 8 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  checkbox: { ...styles.choice, alignSelf: 'flex-start' },
  review: { gap: 12, borderRadius: 12, padding: 12, backgroundColor: palette.panel },
});
