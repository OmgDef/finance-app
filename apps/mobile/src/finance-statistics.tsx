import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { Language, Result, StatisticsQuery } from '@teta/contracts';
import { request } from './api';
import { isComaBank } from './app-variant';
import { copy } from './copy';
import { apiErrorCode } from './finance-commands';
import type { FinanceAccess } from './finance-commands';
import { financeCopy } from './finance-copy';
import { currencyName, formatFinancialDate, formatMoney, recentStatisticsPeriod } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { statisticsCopy } from './finance-statistics-copy';
import { FinanceAlert, FinanceButton, palette, styles, transactionAmountColor } from './finance-ui';

type Report = Result<'getStatistics'>;
type Entry = Report['entries'][number];
type ExpenseCategory = Report['categories'][number];
type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];
export type StatisticsFilters = Omit<StatisticsQuery, 'before' | 'byWeek'>;
export type StatisticsPeriod = 'recent' | 'month' | 'custom';
export type StatisticsFilterEditor = {
  current: StatisticsFilters;
  currentPeriod: StatisticsPeriod;
  reportPeriod?: Pick<Report, 'fromDate' | 'throughDate'>;
  onApply(filters: StatisticsFilters, period: StatisticsPeriod): void;
};
export type StatisticsPreset = Pick<Report, 'fromDate' | 'throughDate'> & { currency: NonNullable<StatisticsFilters['currency']> };
type Drill = Pick<ExpenseCategory, 'currency' | 'categoryId'> & Pick<Report, 'fromDate' | 'throughDate'>;
type Snapshot = { scope: string; report?: Report; busy: boolean; error?: string };

function queryFor({ fromDate, throughDate, accountId, categoryId, type, currency, before }: StatisticsQuery) {
  const query = new URLSearchParams();
  const fields = { fromDate, throughDate, accountId, categoryId, type, currency, before };
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) query.set(name, value);
  }
  return query;
}

export function useStatistics(access: FinanceAccess, enabled: boolean, dataRevision: number, preset?: StatisticsPreset) {
  const { today } = access.profile;
  const [selection, setSelection] = useState<{ filters: StatisticsFilters; periodMode: StatisticsPeriod }>(() => {
    if (!preset) return { filters: {}, periodMode: 'recent' };
    const { fromDate, throughDate, currency } = preset;
    if (throughDate === today && fromDate === recentStatisticsPeriod(today).fromDate) {
      return { filters: { currency }, periodMode: 'recent' };
    }
    return { filters: preset, periodMode: 'custom' };
  });
  const [drill, setDrill] = useState<Drill>();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const latest = useRef(0);
  const pendingPage = useRef<string | undefined>(undefined);
  const activeScope = useRef('');
  const { filters } = selection;
  const periodMode = drill ? 'custom' : selection.periodMode;
  const effective: StatisticsFilters = drill ? { ...filters, ...drill, type: 'expense' }
    : periodMode === 'recent' ? { ...filters, ...recentStatisticsPeriod(today) } : filters;
  const month = periodMode === 'month' ? today.slice(0, 7) : '';
  const scope = JSON.stringify([revision, dataRevision, month, queryFor(effective).toString()]);
  activeScope.current = enabled ? scope : '';
  const visible = snapshot?.scope === scope ? snapshot : undefined;

  async function load(previous?: Report) {
    if (activeScope.current !== scope || !access.isCurrent()) return;
    if (previous && (!previous.next || pendingPage.current === scope)) return;
    const attempt = ++latest.current;
    pendingPage.current = scope;
    const current = () => attempt === latest.current && activeScope.current === scope && access.isCurrent();
    setSnapshot({ scope, report: previous, busy: true });
    try {
      const query = queryFor(previous ? {
        ...effective, fromDate: previous.fromDate, throughDate: previous.throughDate, before: previous.next ?? undefined,
      } : effective);
      const report = await request('getStatistics', { token: access.token, query: query.size ? query : undefined });
      if (!current()) return;
      if (previous) {
        const shown = new Set(previous.entries.map(({ transactionId }) => transactionId));
        const changed = report.fromDate !== previous.fromDate || report.throughDate !== previous.throughDate ||
          JSON.stringify(report.totals) !== JSON.stringify(previous.totals) ||
          JSON.stringify(report.categories) !== JSON.stringify(previous.categories) ||
          report.entries.some(({ transactionId }) => shown.has(transactionId));
        if (changed) {
          setSnapshot({ scope, report: previous, busy: false, error: 'REPORT_CHANGED' });
          return;
        }
        setSnapshot({ scope, report: { ...report, entries: [...previous.entries, ...report.entries] }, busy: false });
      } else setSnapshot({ scope, report, busy: false });
    } catch (error) {
      if (!current()) return;
      const code = apiErrorCode(error);
      if (!access.onAccessFailure(code)) setSnapshot({ scope, report: previous, busy: false, error: code });
    } finally {
      if (latest.current === attempt) pendingPage.current = undefined;
    }
  }

  useEffect(() => {
    if (enabled) void load();
    return () => { latest.current += 1; pendingPage.current = undefined; };
  }, [enabled, scope]);

  function refresh() { setRevision((value) => value + 1); }

  return {
    filters: effective, periodMode, drill, report: visible?.report, error: visible?.error,
    loading: enabled && (visible?.busy ?? true), refresh,
    more: () => { if (visible?.report && !visible.busy) void load(visible.report); },
    apply: (next: StatisticsFilters, mode: StatisticsPeriod) => { setSelection({ filters: next, periodMode: mode }); setDrill(undefined); refresh(); },
    openCategory: (entry: ExpenseCategory) => {
      if (visible?.report) {
        const { fromDate, throughDate } = visible.report;
        setDrill({ currency: entry.currency, categoryId: entry.categoryId, fromDate, throughDate });
      }
    },
    closeCategory: () => setDrill(undefined),
  };
}

function categoryWidth(amount: string, total: string): `${number}%` {
  const denominator = BigInt(total);
  if (denominator === 0n) return '0%';
  const basisPoints = BigInt(amount) * 10_000n / denominator;
  return `${Number(basisPoints) / 100}%`;
}

export function StatisticsScreen({ statistics, accounts, categories, lang, onEditFilters, onTransaction, scrollToTop }: {
  statistics: ReturnType<typeof useStatistics>; accounts?: Account[]; categories?: Category[]; lang: Language;
  onEditFilters(editor: StatisticsFilterEditor): void; onTransaction(entry: Entry): void; scrollToTop(): void;
}) {
  const t = statisticsCopy[lang];
  const f = financeCopy[lang];
  const { width, fontScale } = useWindowDimensions();
  const { filters, periodMode, drill, report, loading, error } = statistics;
  const reportWidth = Math.min(width, styles.page.maxWidth);
  const metricsWidth = isComaBank ? reportWidth - styles.page.paddingHorizontal * 2 : reportWidth;
  const stackMetrics = metricsWidth / fontScale < 300 || (isComaBank && report?.totals.some(({ incomeMinor, expenseMinor }) =>
    incomeMinor.length > 12 || expenseMinor.length > 12));
  const period = report ?? (filters.fromDate && filters.throughDate ? { fromDate: filters.fromDate, throughDate: filters.throughDate } : undefined);
  const periodName = periodMode === 'custom' ? t.period : t[periodMode];
  const periodDates = period && [period.fromDate, period.throughDate].map((date) => formatFinancialDate(date, lang)).join(' – ');
  const categoryNames = new Map(categories?.map(({ id, nameEn, nameRu }) => [id, lang === 'en' ? nameEn : nameRu]));
  const accountNames = new Map(accounts?.map(({ accountId, name }) => [accountId, name]));
  const filterLabels = [filters.accountId && (accountNames.get(filters.accountId) ?? f.account),
    filters.type && (filters.type === 'income' ? f.incomeEntry : f.expenseEntry),
    filters.categoryId && (categoryNames.get(filters.categoryId) ?? filters.categoryId),
    filters.currency && currencyName(filters.currency, lang)].filter(Boolean);
  const errorMessage = error === 'NOT_FOUND' ? t.unavailable : error === 'REPORT_CHANGED' ? t.reportChanged
    : error === 'INVALID_REQUEST' ? f.invalidRequest : error && (copy[lang].errors[error] ?? f.error);
  const entriesByDay = new Map<string, Entry[]>();
  for (const entry of report?.entries ?? []) {
    const day = entriesByDay.get(entry.date);
    if (day) day.push(entry);
    else entriesByDay.set(entry.date, [entry]);
  }

  function openFilters() {
    onEditFilters({ current: filters, currentPeriod: periodMode, reportPeriod: period, onApply: (next, mode) => {
      statistics.apply(next, mode);
      scrollToTop();
    } });
  }

  const filterButton = <Pressable accessibilityRole="button" testID="statistics-filters" onPress={openFilters}
    style={({ pressed }) => isComaBank ? [layout.comabankFilters, pressed && styles.dimmed]
      : [styles.button, layout.filters, pressed && styles.checked]}>
    <FinanceIcon name="filters" color={palette.accent} size={16} />
    <Text style={[styles.buttonText, isComaBank && layout.comabankFilterText]}>{t.filters}</Text>
  </Pressable>;
  const filterSummary = filterLabels.length > 0 && <Text style={[styles.meta, !isComaBank && layout.filterSummary]}>
    {filterLabels.join(' · ')}
  </Text>;

  return <View style={layout.report}>
    {isComaBank ? <View style={layout.comabankHeader}>
      <View style={layout.comabankTitleRow}>
        <Text accessibilityRole="header" style={[styles.heading, layout.comabankTitle]}>{t.title}</Text>
        {filterButton}
      </View>
      <Text style={styles.meta} testID="statistics-period">{[periodName, periodDates].filter(Boolean).join(' · ')}</Text>
      {filterSummary}
    </View> : <View style={[styles.surface, layout.header]}>
      <View style={layout.period}>
        <FinanceIcon name="calendar" color={palette.accent} size={18} />
        <View style={layout.labels}>
          <Text style={styles.groupTitle}>{periodName}</Text>
          {periodDates && <Text style={styles.meta} testID="statistics-period">{periodDates}</Text>}
        </View>
      </View>
      {filterButton}
      {filterSummary}
    </View>}
    {drill && <View style={layout.actions}>
      <FinanceButton title={t.report} onPress={() => { statistics.closeCategory(); scrollToTop(); }}
        testID="statistics-clear-drill" />
    </View>}
    {errorMessage && <View style={[styles.surface, layout.message]}>
      <FinanceAlert testID="statistics-error">{errorMessage}</FinanceAlert>
      <FinanceButton title={copy[lang].retry} onPress={statistics.refresh} testID="statistics-retry" />
    </View>}
    {(loading || report) && <>
      <View style={layout.section}>
        <Text accessibilityRole="header" style={isComaBank ? styles.section : styles.groupTitle}>{t.totals}</Text>
        <View style={!isComaBank && styles.surface}>
          {!report && <ActivityIndicator style={layout.message} color={palette.accent} accessibilityLabel={f.loading} />}
          {report?.totals.length === 0 && <Text style={[styles.meta, layout.message]} testID="statistics-empty">{t.empty}</Text>}
          {report?.totals.map(({ currency, incomeMinor, expenseMinor }, index) => (
            <View key={currency} style={[layout.totalGroup, isComaBank ? layout.comabankTotalGroup : index > 0 && layout.divider]}
              testID={'statistics-total-' + currency}>
              <View style={stackMetrics ? layout.stackedMetrics : layout.metrics}>
                <View style={[layout.metric, !stackMetrics && layout.metricColumn]}>
                  <Text style={styles.meta}>{t.income}</Text>
                  <Text style={[layout.amount, isComaBank && layout.comabankAmount, layout.income]}>
                    {formatMoney(incomeMinor, currency, lang)}
                  </Text>
                </View>
                <View style={[layout.metric, !stackMetrics && layout.metricColumn]}>
                  <Text style={styles.meta}>{t.expenses}</Text>
                  <Text style={[layout.amount, isComaBank && layout.comabankAmount]}>
                    {formatMoney(expenseMinor, currency, lang)}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      </View>
      {report && !drill && report.totals.length > 0 && <View style={layout.section}>
        <Text accessibilityRole="header" style={isComaBank ? styles.section : styles.groupTitle}>{t.expensesByCategory}</Text>
        <View style={!isComaBank && styles.surface}>
          {report.categories.length === 0 && <Text style={[styles.meta, layout.message]}>{t.emptyExpenses}</Text>}
          {report.totals.filter(({ currency }) => report.categories.some((category) => category.currency === currency))
            .map(({ currency, expenseMinor }, index) => (
              <View key={currency} style={[layout.categoryGroup, index > 0 && layout.divider]}>
                {report.categories.filter((category) => category.currency === currency).map((entry) => (
                  <Pressable key={entry.categoryId} accessibilityRole="button"
                    testID={`statistics-expense-${currency}-${entry.categoryId}`}
                    onPress={() => { statistics.openCategory(entry); scrollToTop(); }}
                    style={({ pressed }) => [layout.categoryRow, isComaBank && layout.flush,
                      pressed && (isComaBank ? styles.dimmed : layout.pressed)]}>
                    <View style={layout.line}>
                      <Text style={styles.title}>{categoryNames.get(entry.categoryId) ?? entry.categoryId}</Text>
                      <Text style={layout.entryAmount}>{formatMoney(entry.amountMinor, currency, lang)}</Text>
                    </View>
                    <View style={layout.track} importantForAccessibility="no" accessible={false}>
                      <View style={[layout.bar, { width: categoryWidth(entry.amountMinor, expenseMinor) }]} />
                    </View>
                  </Pressable>
                ))}
              </View>
            ))}
        </View>
      </View>}
      {report && entriesByDay.size > 0 && <View style={layout.section}>
        <Text accessibilityRole="header" style={isComaBank ? styles.section : styles.groupTitle}>{t.transactions}</Text>
        <View style={!isComaBank && styles.surface}>
          {[...entriesByDay].map(([date, entries], dayIndex) => (
            <View key={date} style={dayIndex > 0 && layout.divider}>
              <Text accessibilityRole="header" style={[layout.day, isComaBank && layout.flush]}>{formatFinancialDate(date, lang)}</Text>
              {entries.map((entry, rowIndex) => {
                const isIncome = entry.type === 'income';
                const color = transactionAmountColor(entry.amountMinor);
                const title = categoryNames.get(entry.categoryId) ?? (isIncome ? f.incomeEntry : f.expenseEntry);
                const account = accountNames.get(entry.accountId);
                const description = entry.source ?? entry.incomeSource ?? entry.comment;
                return <Pressable key={entry.transactionId} accessibilityRole="button" onPress={() => onTransaction(entry)}
                  testID={'statistics-transaction-' + entry.transactionId}
                  style={({ pressed }) => [layout.transaction, isComaBank && layout.flush, rowIndex > 0 && layout.divider,
                    pressed && (isComaBank ? styles.dimmed : layout.pressed)]}>
                  <View style={layout.identity}>
                    <FinanceIcon name={isIncome ? 'income' : 'expense'} color={color} size={18} />
                    <View style={layout.labels}>
                      <Text style={styles.title}>{description || title}</Text>
                      <Text style={styles.meta}>{[description && title, account].filter(Boolean).join(' · ') || title}</Text>
                    </View>
                  </View>
                  <Text style={[layout.entryAmount, { color }]}>
                    {formatMoney(entry.amountMinor, entry.currency, lang, true)}
                  </Text>
                </Pressable>;
              })}
            </View>
          ))}
        </View>
        {report.next && error !== 'REPORT_CHANGED' && <FinanceButton title={f.loadMore} disabled={loading} onPress={statistics.more}
          testID="statistics-more" />}
        {loading && <ActivityIndicator color={palette.accent} accessibilityLabel={f.loading} />}
      </View>}
    </>}
  </View>;
}

const layout = StyleSheet.create({
  report: { gap: 18 },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, padding: 10 },
  comabankHeader: { gap: 5, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  comabankTitleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 10 },
  comabankTitle: { flexShrink: 1 },
  comabankFilters: { minHeight: 44, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 5 },
  comabankFilterText: { color: palette.accent },
  period: { flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexBasis: '48%', minWidth: 128, gap: 8 },
  labels: { flex: 1, gap: 3 },
  filterSummary: { width: '100%', paddingHorizontal: 4 },
  filters: { paddingHorizontal: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' },
  section: { gap: 8 },
  message: { padding: 12, gap: 8 },
  totalGroup: { gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  comabankTotalGroup: { paddingHorizontal: 0, borderBottomColor: palette.line, borderBottomWidth: StyleSheet.hairlineWidth },
  divider: { borderTopColor: palette.line, borderTopWidth: StyleSheet.hairlineWidth },
  metrics: { flexDirection: 'row', gap: 10 },
  stackedMetrics: { gap: 8 },
  metric: { gap: 3 },
  metricColumn: { flex: 1 },
  amount: { color: palette.ink, fontSize: 19, fontWeight: '700', fontVariant: ['tabular-nums'] },
  comabankAmount: { fontSize: 23, letterSpacing: -0.5 },
  income: { color: palette.positive },
  categoryGroup: { paddingVertical: 6 },
  categoryRow: { paddingHorizontal: 12, paddingVertical: 8, gap: 6, minHeight: 48, justifyContent: 'center' },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 },
  track: { height: 4, borderRadius: 2, backgroundColor: palette.raised, overflow: 'hidden' },
  bar: { height: 4, borderRadius: 2, backgroundColor: palette.accent },
  day: { color: palette.muted, fontSize: 13, fontWeight: '600', backgroundColor: palette.ground,
    paddingHorizontal: 12, paddingVertical: 6 },
  transaction: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', minHeight: 48,
    gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  identity: { flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexBasis: '45%', minWidth: 104, gap: 8 },
  pressed: { backgroundColor: palette.ground },
  flush: { paddingHorizontal: 0 },
  entryAmount: { color: palette.ink, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'],
    textAlign: 'right', marginLeft: 'auto', flexShrink: 1 },
});
