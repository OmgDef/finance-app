import { useMemo } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import { financeCopy } from './finance-copy';
import { formatFinancialDate, formatMoney } from './finance-format';
import { statisticsCopy } from './finance-statistics-copy';
import { FinanceAlert, palette, styles } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type History = Result<'listAccountHistory'>;
type Entry = History['entries'][number];
type Category = Result<'listCategories'>['categories'][number];
type Totals = Result<'getStatistics'>['totals'];
type MonthSection = { key: string; title: string; data: Entry[] };

export function AccountOverview({ account, depositTerms, lang, categories, month, totals, totalsError, history,
  historyBusy, historyError, accountError, refreshing, created, onRefresh, onMore, onTransaction }: {
  account?: Account;
  depositTerms: string;
  lang: Language;
  categories?: Category[];
  month: string;
  totals?: Totals;
  totalsError: boolean;
  history?: History;
  historyBusy: boolean;
  historyError: boolean;
  accountError?: string;
  refreshing: boolean;
  created: boolean;
  onRefresh: () => void;
  onMore: () => void;
  onTransaction: (id: string) => void;
}) {
  const t = financeCopy[lang];
  const s = statisticsCopy[lang];
  const { width, fontScale } = useWindowDimensions();
  const monthFormat = useMemo(() => new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }), [lang]);
  const sections = useMemo(() => {
    const result: MonthSection[] = [];
    for (const entry of history?.entries ?? []) {
      const key = entry.date.slice(0, 7);
      const last = result.at(-1);
      if (last?.key === key) last.data.push(entry);
      else result.push({ key, title: monthFormat.format(new Date(key + '-01T00:00:00Z')), data: [entry] });
    }
    return result;
  }, [history, monthFormat]);
  const categoryNames = useMemo(() => new Map(categories?.map(({ id, nameRu, nameEn }) =>
    [id, lang === 'ru' ? nameRu : nameEn])), [categories, lang]);
  const titles = {
    opening: t.opening, adjustment: t.adjustment, expense: t.expenseEntry, income: t.incomeEntry, transfer: t.transfer,
  };
  const amounts = totals?.find(({ currency }) => currency === account?.currency);
  const metrics = account && totals && [
    { label: s.income, amount: formatMoney(amounts?.incomeMinor ?? '0', account.currency, lang) },
    { label: s.expenses, amount: formatMoney(amounts?.expenseMinor ?? '0', account.currency, lang) },
  ];
  const stackMetrics = Math.min(width, 540) / fontScale < 330 || !!metrics?.some(({ amount }) => amount.length > 18);
  const onlyOpening = history && !history.next && history.entries.every(({ type }) => type === 'opening');

  return <SectionList<Entry, MonthSection>
    sections={sections}
    contentContainerStyle={layout.content}
    contentInsetAdjustmentBehavior="never"
    stickySectionHeadersEnabled={false}
    refreshing={refreshing} onRefresh={onRefresh}
    onEndReached={onMore} onEndReachedThreshold={0.45}
    keyExtractor={({ type, id }) => type + ':' + id}
    ListHeaderComponent={<View style={layout.header}>
      {account && <>
        <View style={layout.balance}>
          <Text style={styles.heroValue} testID="finance-detail-balance">{formatMoney(account.balanceMinor, account.currency, lang)}</Text>
          <Text style={styles.meta}>
            {t['type' in account ? account.type : 'regular']} · {formatFinancialDate(account.startDate, lang)}
          </Text>
          {!!depositTerms && <Text style={styles.meta}>{depositTerms}</Text>}
          {account.archived && <Text style={styles.meta}>{t.archivedAccount}</Text>}
          {account.needsReconciliation && <FinanceAlert>{t.needsReconciliation}</FinanceAlert>}
          {created && <Text style={styles.meta} testID="finance-receipt" accessibilityLiveRegion="polite">{t.accountCreated}</Text>}
        </View>
        <View style={[styles.surface, layout.summary]}>
          <Text accessibilityRole="header" style={styles.groupTitle}>
            {t.monthlyActivity} · {monthFormat.format(new Date(month + '-01T00:00:00Z'))}
          </Text>
          {metrics && <View style={stackMetrics ? layout.metricsStack : layout.metrics}>
            {metrics.map(({ label, amount }) => <View key={label} style={layout.metric}>
              <Text style={styles.meta}>{label}</Text>
              <Text style={styles.value}>{amount}</Text>
            </View>)}
          </View>}
          {!totals && !totalsError && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} style={layout.loading} />}
          {totalsError && <FinanceAlert>{t.monthlyActivityError}</FinanceAlert>}
        </View>
      </>}
      {!!accountError && <FinanceAlert>{accountError}</FinanceAlert>}
      <Text accessibilityRole="header" style={styles.section} testID="finance-history">{t.history}</Text>
      {onlyOpening && <Text style={styles.meta}>{t.noAccountActivity}</Text>}
    </View>}
    renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={layout.month}>{section.title}</Text>}
    renderItem={({ item, section, index }) => {
      const isTransaction = 'status' in item;
      const isVoided = isTransaction && item.status === 'void';
      const category = 'categoryId' in item && item.categoryId ? categoryNames.get(item.categoryId) : undefined;
      const details = 'comment' in item ? item.comment : 'explanation' in item ? item.explanation : null;
      const isFirst = index === 0;
      const isLast = index === section.data.length - 1;
      const date = index === 0 || section.data[index - 1].date !== item.date ? formatFinancialDate(item.date, lang) : undefined;
      const row = <View style={layout.row}>
        <View style={layout.identity}>
          <Text style={styles.title}>{category ?? titles[item.type]}</Text>
          {!!details && <Text style={styles.meta}>{details}</Text>}
          {isVoided && <Text style={styles.meta}>{t.void}</Text>}
          {'actorRole' in item && item.actorRole === 'admin' && <Text style={styles.meta}>{t.changedByAdmin}</Text>}
        </View>
        <Text style={[layout.amount, isVoided && styles.mutedValue]}>
          {history && formatMoney(item.amountMinor, history.currency, lang, item.type !== 'opening')}
        </Text>
      </View>;
      return <View style={[layout.item, isFirst && layout.first, isLast ? layout.last : layout.divider]}>
        {!!date && <Text style={layout.date}>{date}</Text>}
        {isTransaction
          ? <Pressable accessibilityRole="button" testID={'finance-transaction-' + item.id}
              onPress={() => onTransaction(item.id)} style={({ pressed }) => pressed && styles.dimmed}>{row}</Pressable>
          : row}
      </View>;
    }}
    ListFooterComponent={historyBusy || historyError ? <View style={layout.footer}>
      {historyBusy && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
      {historyError && <FinanceAlert>{t.historyLoadError}</FinanceAlert>}
    </View> : undefined}
  />;
}

const layout = StyleSheet.create({
  content: { ...styles.page, gap: 0 },
  header: { gap: 14 },
  balance: { gap: 4 },
  summary: { padding: 12, gap: 9 },
  metrics: { flexDirection: 'row', gap: 12 },
  metricsStack: { gap: 9 },
  metric: { flexGrow: 1, flexBasis: 0, gap: 2 },
  loading: { alignSelf: 'flex-start', minHeight: 42 },
  month: { ...styles.groupTitle, color: palette.muted, marginTop: 10, marginBottom: 6 },
  item: { backgroundColor: palette.panel, paddingHorizontal: 12 },
  first: { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  last: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  divider: { borderBottomColor: palette.line, borderBottomWidth: StyleSheet.hairlineWidth },
  date: { color: palette.muted, fontSize: 13, paddingTop: 9 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6,
    paddingVertical: 8, minHeight: 44 },
  identity: { flexGrow: 1, flexBasis: '44%', minWidth: 96, gap: 2 },
  amount: { color: palette.ink, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right',
    marginLeft: 'auto', flexShrink: 1 },
  footer: { paddingVertical: 10 },
});
