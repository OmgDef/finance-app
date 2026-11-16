import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { Body, Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { apiErrorCode } from './finance-commands';
import type { FinanceAccess, FinanceDraft } from './finance-commands';
import { financeCopy } from './finance-copy';
import { FinanceDateField } from './finance-date-field';
import { formatFinancialDate, formatProfileMoment } from './finance-format';
import { scheduleCopy } from './finance-schedule-copy';
import { ScheduleEditor } from './finance-schedule-editor';
import { Choice, FinanceAlert, FinanceButton, palette, styles } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];
type Rule = Result<'getScheduleRule'>;
type Preview = Result<'previewScheduleRuleReplacement'>;
type Create = Body<'createScheduleRule'>;
type Decision = { kind: 'carry' | 'none'; targetDate?: string };
type Draft = Extract<FinanceDraft, { kind: 'schedule.replace' }>;

function matchesRuleDate(date: string, rule: Create) {
  if (date < rule.firstDate || (rule.endDate && date > rule.endDate)) return false;
  if (rule.frequency === 'once') return date === rule.firstDate;
  const dayMillis = 86_400_000;
  if (rule.frequency === 'weekly') {
    return (Date.parse(date + 'T00:00:00Z') - Date.parse(rule.firstDate + 'T00:00:00Z')) % (7 * dayMillis) === 0;
  }
  const [year, month, day] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === Math.min(lastDay, Number(rule.firstDate.slice(-2)));
}

export function ScheduleReplacement({ rule, accounts, categories, access, lang, visible, disabled, commandError, onSubmit }: {
  rule: Rule;
  accounts: Account[];
  categories: Category[];
  access: FinanceAccess;
  lang: Language;
  visible: boolean;
  disabled: boolean;
  commandError: string;
  onSubmit: (draft: Draft) => void;
}) {
  const t = scheduleCopy[lang];
  const f = financeCopy[lang];
  const [destinationId, setDestination] = useState(rule.accountId);
  const [previewState, setPreview] = useState<{ scope: string; value: Preview; rule: Rule }>();
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [validation, setValidation] = useState<'chooseSkipDecisions' | 'invalidSkipDate' | 'duplicateSkipDate'>();
  const destination = accounts.find((item) => item.accountId === destinationId && !item.archived);
  const { today, timeZone } = access.profile;
  const scope = [rule.ruleId, destinationId, today, timeZone, refresh].join(':');
  const active = useRef('');
  active.current = visible ? scope : '';
  const currentPreview = previewState?.scope === scope;
  const preview = previewState?.value.accountId === destinationId ? previewState.value : undefined;
  const waiting = busy || !currentPreview;

  useEffect(() => {
    if (!visible || !destination || !access.isCurrent()) return;
    let disposed = false;
    const current = () => !disposed && active.current === scope && access.isCurrent();
    setBusy(true);
    setReadError('');
    setValidation(undefined);
    setDecisions({});
    const query = new URLSearchParams({ accountId: destinationId });
    const options = { token: access.token, params: { ruleId: rule.ruleId } };
    void Promise.all([
      request('previewScheduleRuleReplacement', { ...options, query }), request('getScheduleRule', options),
    ]).then(([value, latest]) => {
      if (!current()) return;
      if (value.ruleVersion === latest.ruleVersion) setPreview({ scope, value, rule: latest });
      else setReadError('VERSION_CONFLICT');
    })
      .catch((error: unknown) => {
        if (!current()) return;
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setReadError(code);
      })
      .finally(() => { if (current()) setBusy(false); });
    return () => { disposed = true; };
  }, [scope, visible, !!destination]);

  useEffect(() => {
    if (['VERSION_CONFLICT', 'SCHEDULE_REPLACEMENT_CONFLICT', 'SCHEDULE_RULE_STATE_CONFLICT'].includes(commandError)) {
      setRefresh((version) => version + 1);
    }
  }, [commandError]);

  function submit(fields: Create) {
    if (!preview || disabled || waiting || readError || !access.isCurrent()) return;
    const targets = new Set<string>();
    const resolved: Draft['body']['decisions'] = [];
    for (const source of preview.skippedDates) {
      const decision = decisions[source.date];
      if (!decision) return setValidation('chooseSkipDecisions');
      if (decision.kind === 'none') {
        resolved.push({ sourceDate: source.date, targetDate: null });
        continue;
      }
      const target = decision.targetDate;
      if (!target || !matchesRuleDate(target, fields)) return setValidation('invalidSkipDate');
      if (targets.has(target)) return setValidation('duplicateSkipDate');
      targets.add(target);
      resolved.push({ sourceDate: source.date, targetDate: target });
    }
    setValidation(undefined);
    onSubmit({ kind: 'schedule.replace', ruleId: rule.ruleId, body: {
      ...fields, expectedRuleVersion: preview.ruleVersion, previewToken: preview.previewToken, decisions: resolved,
    } });
  }

  function renderSkipDecisions({ firstDate, endDate, frequency }: Pick<Create, 'firstDate' | 'endDate' | 'frequency'>) {
    if (!currentPreview || !preview?.skippedDates.length) return null;
    return <View style={layout.section}>
      <Text accessibilityRole="header" style={styles.section}>{t.replacementSkips}</Text>
      {preview.skippedDates.map(({ date, reason }) => {
        const decision = decisions[date];
        return <View key={date} style={layout.decision}>
          <Choice title={formatFinancialDate(date, lang)} value={decision?.kind ?? ''}
            options={[{ id: 'carry', label: t.transferSkip }, { id: 'none', label: t.noMatchingDate }]}
            disabled={disabled || waiting || !!readError} testID={'schedule-replace-skip-' + date}
            onChange={(kind) => {
              if (kind) setDecisions((previous) => ({ ...previous, [date]: { kind, targetDate: previous[date]?.targetDate } }));
            }} />
          <Text style={styles.meta}>{reason}</Text>
          {decision?.kind === 'carry' && <FinanceDateField title={t.newOccurrenceDate} lang={lang} today={today}
            value={decision.targetDate ?? null} min={firstDate} max={(frequency === 'once' ? firstDate : endDate) ?? undefined}
            onChange={(targetDate) => setDecisions((previous) => ({ ...previous, [date]: { kind: 'carry', targetDate } }))}
            disabled={disabled || waiting || !!readError} testID={'schedule-replace-target-' + date} />}
        </View>;
      })}
      {validation && <FinanceAlert>{t[validation]}</FinanceAlert>}
    </View>;
  }

  return <View style={layout.section}>
    <Choice title={t.destination} value={destinationId} disabled={disabled}
      options={accounts.filter((item) => !item.archived).map((item) => ({ id: item.accountId, label: item.name }))}
      onChange={setDestination} testID="schedule-replace-account" />
    {busy && destination && <ActivityIndicator color={palette.accent} accessibilityLabel={f.loading} />}
    {readError && <View style={layout.decision}>
      <FinanceAlert>{['VERSION_CONFLICT', 'SCHEDULE_RULE_STATE_CONFLICT', 'SCHEDULE_REPLACEMENT_CONFLICT'].includes(readError)
        ? t.conflict : copy[lang].errors[readError] ?? t.previewUnavailable}</FinanceAlert>
      <FinanceButton title={t.reload} onPress={() => setRefresh((version) => version + 1)} disabled={disabled || busy}
        testID="schedule-replace-refresh" />
    </View>}
    {preview && previewState && destination && <View style={layout.section}>
      {currentPreview && <View style={layout.transition}>
        <Text style={styles.meta}>{t.replacementDate}</Text>
        <Text style={styles.value} testID="schedule-replace-transition-date">{formatFinancialDate(preview.transitionDate, lang)}</Text>
        <Text style={styles.meta}>{t.replacementBoundary} · {formatProfileMoment(preview.transitionAt, timeZone, lang)}</Text>
        <Text style={styles.label} testID="schedule-replace-earliest">
          {t.earliestStart} · {formatFinancialDate(preview.earliestFirstDate, lang)}
        </Text>
      </View>}
      <ScheduleEditor key={destinationId + ':' + previewState.rule.ruleVersion} mode="replace" accounts={accounts}
        categories={categories} lang={lang} today={today} scopedAccountId={null} destination={destination}
        earliestFirstDate={preview.earliestFirstDate} rule={previewState.rule}
        disabled={disabled || waiting || !!readError} onSave={submit} renderSkipDecisions={renderSkipDecisions} />
    </View>}
  </View>;
}

const layout = StyleSheet.create({
  section: { gap: 16 },
  decision: { gap: 8, paddingVertical: 8, borderBottomColor: palette.line, borderBottomWidth: StyleSheet.hairlineWidth },
  transition: { backgroundColor: palette.panel, borderRadius: 12, padding: 14, gap: 6 },
});
