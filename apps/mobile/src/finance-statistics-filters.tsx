import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Language, Result } from '@teta/contracts';
import { financeCopy } from './finance-copy';
import { FinanceDateField } from './finance-date-field';
import { currencies, recentStatisticsPeriod } from './finance-format';
import type { Currency } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { statisticsCopy } from './finance-statistics-copy';
import type { StatisticsFilterEditor, StatisticsFilters, StatisticsPeriod } from './finance-statistics';
import { Choice, FinanceAlert, FinanceButton, palette, styles } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];
type Option = { id: string; label: string };
type List = 'account' | 'category';
const periods: StatisticsPeriod[] = ['recent', 'month', 'custom'];

function FilterList({ title, value, options, expanded, onToggle, onSelect, testID }: {
  title: string; value: string; options: Option[]; expanded: boolean; onToggle(): void;
  onSelect(id: string): void; testID: string;
}) {
  const selectedLabel = options.find(({ id }) => id === value)?.label ?? options[0].label;
  return <View style={[styles.surface, layout.list]}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityValue={{ text: selectedLabel }}
      accessibilityState={{ expanded }} testID={testID} onPress={onToggle}
      style={({ pressed }) => [layout.listRow, pressed && layout.pressed]}>
      <View style={layout.listLabels}>
        <Text style={styles.groupTitle}>{title}</Text>
        <Text style={styles.meta}>{selectedLabel}</Text>
      </View>
      <View style={expanded && layout.up}>
        <FinanceIcon name="chevron-down" color={palette.accent} size={16} />
      </View>
    </Pressable>
    {expanded && <View accessibilityRole="radiogroup" accessibilityLabel={title}>
      {options.map(({ id, label }) => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: id === value }}
        onPress={() => onSelect(id)} testID={`${testID}-${id}`}
        style={({ pressed }) => [layout.listRow, layout.option, id === value && layout.selected, pressed && layout.pressed]}>
        <Text style={[styles.label, layout.rowLabel]}>{label}</Text>
        {id === value && <FinanceIcon name="check" color={palette.accent} size={16} />}
      </Pressable>)}
    </View>}
  </View>;
}

export function StatisticsFiltersScreen({ current, currentPeriod, reportPeriod, today, accounts, categories, lang, onApply }:
  StatisticsFilterEditor & { today: string; accounts?: Account[]; categories?: Category[]; lang: Language }) {
  const t = statisticsCopy[lang];
  const f = financeCopy[lang];
  const { width, fontScale } = useWindowDimensions();
  const wideFields = Math.min(width, 540) / fontScale >= 330;
  const recent = recentStatisticsPeriod(today);
  const [period, setPeriod] = useState(currentPeriod);
  const [type, setType] = useState<NonNullable<StatisticsFilters['type']> | 'all'>(current.type ?? 'all');
  const [category, setCategory] = useState(current.categoryId ?? 'all');
  const [account, setAccount] = useState(current.accountId ?? 'all');
  const [currency, setCurrency] = useState<Currency | 'all'>(current.currency ?? 'all');
  const [fromDate, setFromDate] = useState(current.fromDate ?? reportPeriod?.fromDate ?? recent.fromDate);
  const [throughDate, setThroughDate] = useState(current.throughDate ?? reportPeriod?.throughDate ?? recent.throughDate);
  const [expanded, setExpanded] = useState<List>();
  const invalid = period === 'custom' && fromDate > throughDate;

  const accountOptions = [{ id: 'all', label: t.allAccounts }, ...(accounts ?? []).map(({ accountId, name, currency, archived }) => ({
    id: accountId, label: [name, currency, ...(archived ? [f.archivedAccount] : [])].join(' · '),
  }))];
  const categoryOptions = [{ id: 'all', label: t.allCategories }, ...(categories ?? [])
    .filter((item) => type === 'all' || item.type === type)
    .map(({ id, nameEn, nameRu }) => ({ id, label: lang === 'ru' ? nameRu : nameEn }))
    .sort((a, b) => a.label.localeCompare(b.label, lang))];

  function toggle(list: List) {
    setExpanded((previous) => previous === list ? undefined : list);
  }

  function reset() {
    setPeriod('recent');
    setType('all');
    setAccount('all');
    setCategory('all');
    setCurrency('all');
    setFromDate(recent.fromDate);
    setThroughDate(recent.throughDate);
    setExpanded(undefined);
  }

  function apply() {
    if (invalid) return;
    onApply({
      ...(period === 'custom' && { fromDate, throughDate }),
      accountId: account === 'all' ? undefined : account,
      categoryId: category === 'all' ? undefined : category,
      type: type === 'all' ? undefined : type,
      currency: currency === 'all' ? undefined : currency,
    }, period);
  }

  return <SafeAreaView edges={['left', 'right']} style={layout.screen} testID="statistics-filters-screen">
    <ScrollView style={layout.screen} contentContainerStyle={styles.page} contentInsetAdjustmentBehavior="never">
      <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section}>{t.period}</Text>
        <View style={[styles.surface, layout.list]} accessibilityRole="radiogroup" accessibilityLabel={t.period}>
          {periods.map((id, index) => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: period === id }}
            onPress={() => setPeriod(id)} testID={'statistics-period-' + id}
            style={({ pressed }) => [layout.listRow, index > 0 && layout.option, period === id && layout.selected,
              pressed && layout.pressed]}>
            <Text style={[styles.label, layout.rowLabel]}>{t[id]}</Text>
            {period === id && <FinanceIcon name="check" color={palette.accent} size={16} />}
          </Pressable>)}
        </View>
        {period === 'custom' && <View style={wideFields ? layout.dateRow : layout.section}>
          <View style={wideFields && layout.dateInput}>
            <FinanceDateField title={t.from} lang={lang} today={today} value={fromDate} onChange={setFromDate}
              max={throughDate} testID="statistics-from-date" />
          </View>
          <View style={wideFields && layout.dateInput}>
            <FinanceDateField title={t.through} lang={lang} today={today} value={throughDate} onChange={setThroughDate}
              min={fromDate} testID="statistics-through-date" />
          </View>
        </View>}
        {invalid && <FinanceAlert>{t.invalidPeriod}</FinanceAlert>}
      </View>
      <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section}>{t.transactions}</Text>
        <Choice title={t.type} value={type} onChange={(value) => {
          setType(value);
          if (value !== 'all' && categories?.some((item) => item.id === category && item.type !== value)) setCategory('all');
        }} testID="statistics-filter"
          options={[{ id: 'all', label: t.allTypes }, { id: 'income', label: f.incomeEntry }, { id: 'expense', label: f.expenseEntry }]} />
        <FilterList title={f.category} value={category} options={categoryOptions} testID="statistics-category"
          expanded={expanded === 'category'} onToggle={() => toggle('category')}
          onSelect={(id) => { setCategory(id); setExpanded(undefined); }} />
      </View>
      <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section}>{t.accountAndCurrency}</Text>
        <FilterList title={f.account} value={account} options={accountOptions} testID="statistics-account"
          expanded={expanded === 'account'} onToggle={() => toggle('account')}
          onSelect={(id) => { setAccount(id); setExpanded(undefined); }} />
        <Choice title={t.currency} value={currency} onChange={setCurrency} testID="statistics-currency"
          options={[{ id: 'all', label: t.allCurrencies }, ...currencies.map((id) => ({ id, label: id }))]} />
      </View>
    </ScrollView>
    <SafeAreaView edges={['bottom']} style={layout.footer}>
      <View style={[layout.actions, !wideFields && layout.stackedActions]}>
        <FinanceButton title={t.reset} onPress={reset} testID="statistics-reset" />
        <FinanceButton title={t.apply} onPress={apply} primary disabled={invalid} testID="statistics-apply" />
      </View>
    </SafeAreaView>
  </SafeAreaView>;
}

const layout = StyleSheet.create({
  screen: { flex: 1 },
  section: { gap: 9 },
  list: { overflow: 'hidden' },
  listRow: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  listLabels: { flex: 1, gap: 2 },
  rowLabel: { flexShrink: 1 },
  option: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  selected: { backgroundColor: palette.selected },
  pressed: { backgroundColor: palette.raised },
  up: { transform: [{ rotate: '180deg' }] },
  dateRow: { flexDirection: 'row', gap: 8 },
  dateInput: { flex: 1 },
  footer: { backgroundColor: palette.panel, borderTopColor: palette.line, borderTopWidth: StyleSheet.hairlineWidth },
  actions: { width: '100%', maxWidth: 540, alignSelf: 'center', flexDirection: 'row', justifyContent: 'space-between',
    gap: 8, paddingHorizontal: 18, paddingVertical: 10 },
  stackedActions: { flexDirection: 'column' },
});
