import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { Language, Result, StatisticsQuery } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { apiErrorCode } from './finance-commands';
import type { FinanceAccess } from './finance-commands';
import { financeCopy } from './finance-copy';
import { currencies, financialDate, formatFinancialDate, formatMoney } from './finance-format';
import type { Currency } from './finance-format';
import { useLocalizedInput } from './finance-forms';
import { statisticsCopy } from './finance-statistics-copy';
import { Choice, FinanceAlert, FinanceButton, FinanceField, palette, styles } from './finance-ui';

type Report = Result<'getStatistics'>;
type Entry = Report['entries'][number];
type ExpenseCategory = Report['categories'][number];
type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];
type Filters = Omit<StatisticsQuery, 'before'>;
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

export function useStatistics(access: FinanceAccess, enabled: boolean) {
  const [filters, setFilters] = useState<Filters>({});
  const [drill, setDrill] = useState<Drill>();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const latest = useRef(0);
  const pendingPage = useRef<string | undefined>(undefined);
  const activeScope = useRef('');
  const effective: Filters = drill ? { ...filters, ...drill, type: 'expense' } : filters;
  const month = effective.fromDate === undefined ? access.profile.today.slice(0, 7) : '';
  const scope = JSON.stringify([revision, month, queryFor(effective).toString()]);
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
    filters: effective, drill, report: visible?.report, error: visible?.error,
    loading: enabled && (visible?.busy ?? true), refresh,
    more: () => { if (visible?.report && !visible.busy) void load(visible.report); },
    apply: (next: Filters) => { setFilters(next); setDrill(undefined); refresh(); },
    openCategory: (entry: ExpenseCategory) => {
      if (visible?.report) {
        const { fromDate, throughDate } = visible.report;
        setDrill({ currency: entry.currency, categoryId: entry.categoryId, fromDate, throughDate });
      }
    },
    closeCategory: () => setDrill(undefined),
  };
}

function FilterForm({ current, report, today, accounts, categories, lang, onApply }: {
  current: Filters; report?: Report; today: string; accounts?: Account[]; categories?: Category[]; lang: Language;
  onApply(filters: Filters): void;
}) {
  const t = statisticsCopy[lang];
  const f = financeCopy[lang];
  const { fontScale } = useWindowDimensions();
  const wideFields = fontScale < 1.5;
  const [period, setPeriod] = useState<'month' | 'custom'>(current.fromDate ? 'custom' : 'month');
  const [account, setAccount] = useState(current.accountId ?? 'all');
  const [category, setCategory] = useState(current.categoryId ?? 'all');
  const [type, setType] = useState<NonNullable<Filters['type']> | 'all'>(current.type ?? 'all');
  const [currency, setCurrency] = useState<Currency | 'all'>(current.currency ?? 'all');
  const [invalid, setInvalid] = useState(false);
  const from = useLocalizedInput(lang, formatFinancialDate(current.fromDate ?? report?.fromDate ?? today, lang),
    financialDate, formatFinancialDate);
  const through = useLocalizedInput(lang, formatFinancialDate(current.throughDate ?? report?.throughDate ?? today, lang),
    financialDate, formatFinancialDate);

  function apply() {
    if (period === 'custom' && (!from.value || !through.value || from.value > through.value)) {
      setInvalid(true);
      return;
    }
    Keyboard.dismiss();
    onApply({
      ...(period === 'custom' && { fromDate: from.value, throughDate: through.value }),
      accountId: account === 'all' ? undefined : account,
      categoryId: category === 'all' ? undefined : category,
      type: type === 'all' ? undefined : type,
      currency: currency === 'all' ? undefined : currency,
    });
  }

  return <View style={layout.filterForm}>
    <Choice title={t.period} value={period} onChange={setPeriod} testID="statistics-period"
      options={[{ id: 'month', label: t.month }, { id: 'custom', label: t.custom }]} />
    {period === 'custom' && <View style={wideFields ? layout.dateInputs : layout.stackedFields}>
      <View style={wideFields && layout.dateInput}>
        <FinanceField title={t.from} hint={f.dateHint} value={from.text} onChangeText={from.setText}
          keyboardType="numbers-and-punctuation" maxLength={10} testID="statistics-from-date" />
      </View>
      <View style={wideFields && layout.dateInput}>
        <FinanceField title={t.through} hint={f.dateHint} value={through.text} onChangeText={through.setText}
          keyboardType="numbers-and-punctuation" maxLength={10} testID="statistics-through-date" />
      </View>
    </View>}
    <Choice title={t.type} value={type} onChange={(value) => {
      setType(value);
      if (value !== 'all' && categories?.some((item) => item.id === category && item.type !== value)) setCategory('all');
    }} testID="statistics-filter"
      options={[{ id: 'all', label: t.allTypes }, { id: 'income', label: f.incomeEntry }, { id: 'expense', label: f.expenseEntry }]} />
    <Choice title={f.account} value={account} onChange={setAccount} testID="statistics-account"
      options={[{ id: 'all', label: t.allAccounts }, ...(accounts ?? []).map(({ accountId, name, currency, archived }) => ({
        id: accountId, label: [name, currency, ...(archived ? [f.archivedAccount] : [])].join(' · '),
      }))]} />
    <Choice title={f.category} value={category} onChange={setCategory} testID="statistics-category"
      options={[{ id: 'all', label: t.allCategories }, ...(categories ?? [])
        .filter((item) => type === 'all' || item.type === type)
        .map(({ id, nameEn, nameRu }) => ({ id, label: lang === 'en' ? nameEn : nameRu }))]} />
    <Choice title={t.currency} value={currency} onChange={setCurrency} testID="statistics-currency"
      options={[{ id: 'all', label: t.allCurrencies }, ...currencies.map((id) => ({ id, label: id }))]} />
    {invalid && period === 'custom' && <FinanceAlert>{t.invalidPeriod}</FinanceAlert>}
    <View style={layout.actions}>
      <FinanceButton title={t.apply} onPress={apply} primary testID="statistics-apply" />
      <FinanceButton title={t.reset} onPress={() => { Keyboard.dismiss(); onApply({}); }} testID="statistics-reset" />
    </View>
  </View>;
}

function categoryWidth(amount: string, total: string): `${number}%` {
  const denominator = BigInt(total);
  if (denominator === 0n) return '0%';
  const basisPoints = BigInt(amount) * 10_000n / denominator;
  return `${Number(basisPoints) / 100}%`;
}

export function StatisticsScreen({ statistics, accounts, categories, lang, today, onTransaction, scrollToTop }: {
  statistics: ReturnType<typeof useStatistics>; accounts?: Account[]; categories?: Category[]; lang: Language; today: string;
  onTransaction(entry: Entry): void; scrollToTop(): void;
}) {
  const t = statisticsCopy[lang];
  const f = financeCopy[lang];
  const [editing, setEditing] = useState(false);
  const { fontScale } = useWindowDimensions();
  const { filters, drill, report, loading, error } = statistics;
  const period = report ?? (filters.fromDate && filters.throughDate ? { fromDate: filters.fromDate, throughDate: filters.throughDate } : undefined);
  const categoryNames = new Map(categories?.map(({ id, nameEn, nameRu }) => [id, lang === 'en' ? nameEn : nameRu]));
  const accountNames = new Map(accounts?.map(({ accountId, name }) => [accountId, name]));
  const filterLabels = [filters.accountId && (accountNames.get(filters.accountId) ?? f.account),
    filters.type && (filters.type === 'income' ? f.incomeEntry : f.expenseEntry),
    filters.categoryId && (categoryNames.get(filters.categoryId) ?? filters.categoryId), filters.currency].filter(Boolean);
  const errorMessage = error === 'NOT_FOUND' ? t.unavailable : error === 'REPORT_CHANGED' ? t.reportChanged
    : error === 'INVALID_REQUEST' ? f.invalidRequest : error && (copy[lang].errors[error] ?? f.error);

  function apply(next: Filters) {
    statistics.apply(next);
    setEditing(false);
    scrollToTop();
  }

  return <View style={layout.report}>
    <View style={layout.header}>
      <View style={layout.period}>
        {!filters.fromDate && <Text style={styles.meta}>{t.month}</Text>}
        {period && <Text style={styles.title} testID="statistics-period">
          {formatFinancialDate(period.fromDate, lang)} – {formatFinancialDate(period.throughDate, lang)}
        </Text>}
        {filterLabels.length > 0 && <Text style={styles.meta}>{filterLabels.join(' · ')}</Text>}
      </View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: editing }} testID="statistics-filters"
        onPress={() => setEditing(!editing)} style={({ pressed }) => [styles.button, (editing || pressed) && styles.checked]}>
        <Text style={styles.buttonText}>{t.filters}</Text>
      </Pressable>
    </View>
    {editing && <FilterForm current={filters} report={report} today={today} accounts={accounts} categories={categories}
      lang={lang} onApply={apply} />}
    {drill && <View style={layout.actions}>
      <FinanceButton title={t.report} onPress={() => { setEditing(false); statistics.closeCategory(); scrollToTop(); }}
        testID="statistics-clear-drill" />
    </View>}
    {errorMessage && <View style={layout.section}>
      <FinanceAlert testID="statistics-error">{errorMessage}</FinanceAlert>
      <FinanceButton title={copy[lang].retry} onPress={statistics.refresh} testID="statistics-retry" />
    </View>}
    {!report && loading && <ActivityIndicator color={palette.mint} accessibilityLabel={f.loading} />}
    {report && <>
      <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section}>{t.totals}</Text>
        {report.totals.length === 0 ? <Text style={styles.meta} testID="statistics-empty">{t.empty}</Text> :
          <View style={layout.totals}>
            {report.totals.map(({ currency, incomeMinor, expenseMinor }, index) =>
              <View key={currency} style={[layout.totalGroup, index > 0 && layout.divider]} testID={'statistics-total-' + currency}>
                <Text accessibilityRole="header" style={styles.title}>{currency}</Text>
                <View style={fontScale >= 1.5 ? layout.stackedMetrics : layout.metrics}>
                  <View style={layout.metric}>
                    <Text style={styles.meta}>{t.income}</Text>
                    <Text style={layout.amount}>{formatMoney(incomeMinor, currency, lang)}</Text>
                  </View>
                  <View style={layout.metric}>
                    <Text style={styles.meta}>{t.expenses}</Text>
                    <Text style={layout.amount}>{formatMoney(expenseMinor, currency, lang)}</Text>
                  </View>
                </View>
              </View>)}
          </View>}
      </View>
      {!drill && report.totals.length > 0 && <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section}>{t.expensesByCategory}</Text>
        {report.categories.length === 0 && <Text style={styles.meta}>{t.emptyExpenses}</Text>}
        {report.totals.map(({ currency, expenseMinor }) => {
          const group = report.categories.filter((category) => category.currency === currency);
          if (!group.length) return null;
          return <View key={currency} style={layout.categoryGroup}>
            <Text accessibilityRole="header" style={styles.meta}>{currency}</Text>
            {group.map((entry) => <Pressable key={entry.categoryId} accessibilityRole="button"
              testID={`statistics-expense-${currency}-${entry.categoryId}`}
              onPress={() => { setEditing(false); statistics.openCategory(entry); scrollToTop(); }}
              style={({ pressed }) => [layout.categoryRow, pressed && styles.dimmed]}>
              <View style={layout.line}>
                <Text style={styles.title}>{categoryNames.get(entry.categoryId) ?? entry.categoryId}</Text>
                <Text style={layout.entryAmount}>{formatMoney(entry.amountMinor, currency, lang)}</Text>
              </View>
              <View style={layout.track} accessible={false}>
                <View style={[layout.bar, { width: categoryWidth(entry.amountMinor, expenseMinor) }]} />
              </View>
            </Pressable>)}
          </View>;
        })}
      </View>}
      {report.entries.length > 0 && <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section}>{t.transactions}</Text>
        {report.entries.map((entry, index) => {
          const title = categoryNames.get(entry.categoryId) ?? (entry.type === 'income' ? f.incomeEntry : f.expenseEntry);
          const account = accountNames.get(entry.accountId);
          const dateChanged = report.entries[index - 1]?.date !== entry.date;
          return <View key={entry.transactionId}>
            {dateChanged && <Text accessibilityRole="header" style={layout.day}>{formatFinancialDate(entry.date, lang)}</Text>}
            <Pressable accessibilityRole="button" onPress={() => onTransaction(entry)} testID={'statistics-transaction-' + entry.transactionId}
              style={({ pressed }) => [layout.transaction, pressed && styles.dimmed]}>
              <View style={layout.identity}>
                <Text style={styles.title}>{entry.comment || title}</Text>
                <Text style={styles.meta}>{[entry.comment && title, account].filter(Boolean).join(' · ') || title}</Text>
              </View>
              <Text style={layout.entryAmount}>{formatMoney(entry.amountMinor, entry.currency, lang, true)}</Text>
            </Pressable>
          </View>;
        })}
        {report.next && error !== 'REPORT_CHANGED' && <FinanceButton title={f.loadMore} disabled={loading} onPress={statistics.more}
          testID="statistics-more" />}
        {loading && <ActivityIndicator color={palette.mint} accessibilityLabel={f.loading} />}
      </View>}
    </>}
  </View>;
}

const layout = StyleSheet.create({
  report: { gap: 22 },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  period: { flexGrow: 1, flexShrink: 1, gap: 4 },
  filterForm: { backgroundColor: palette.panel, borderRadius: 16, padding: 12, gap: 14 },
  dateInputs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stackedFields: { gap: 8 },
  dateInput: { flex: 1, minWidth: 128 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' },
  section: { gap: 10 },
  totals: { backgroundColor: palette.panel, borderRadius: 16, paddingHorizontal: 14 },
  totalGroup: { gap: 6, paddingVertical: 10 },
  divider: { borderTopColor: palette.line, borderTopWidth: StyleSheet.hairlineWidth },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  stackedMetrics: { gap: 6 },
  metric: { flexGrow: 1, flexBasis: '46%', minWidth: 104, alignItems: 'flex-end', gap: 3 },
  amount: { color: palette.ink, fontSize: 19, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right' },
  categoryGroup: { gap: 2 },
  categoryRow: { paddingVertical: 8, gap: 5, minHeight: 44, justifyContent: 'center' },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 },
  track: { height: 3, borderRadius: 2, backgroundColor: palette.line, overflow: 'hidden' },
  bar: { height: 3, backgroundColor: palette.mint },
  day: { color: palette.muted, fontSize: 14, paddingTop: 4, paddingBottom: 6 },
  transaction: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', minHeight: 48,
    gap: 6, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  identity: { flexGrow: 1, flexBasis: '45%', minWidth: 112, gap: 3 },
  entryAmount: { color: palette.ink, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 1 },
});
