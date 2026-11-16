import { useMemo } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Language, Result } from '@teta/contracts';
import { AccountBalancePlot, AccountMonthlyFlow } from './finance-account-charts';
import { cashFlowSeries } from './finance-cash-flow';
import { financeCopy } from './finance-copy';
import { formatFinancialDate, formatMoney } from './finance-format';
import { CardNetworkLogo, cardNetworkLabel } from './finance-card-network';
import { FinanceIcon } from './finance-icon';
import { statisticsCopy } from './finance-statistics-copy';
import { FinanceAlert, FinanceButton, palette, styles, transactionAmountColor } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type History = Result<'listAccountHistory'>;
type Entry = History['entries'][number];
type Category = Result<'listCategories'>['categories'][number];
type BalanceSeries = Result<'getAccountBalanceSeries'>;
type LinkedCard = Result<'listAccountCards'>['cards'][number];
type MonthSection = { key: string; title: string; data: Entry[] };

export function AccountOverview({ account, depositTerms, lang, categories, month, balanceSeries, balanceSeriesError,
  cards, cardsError, monthlyActivity, totalsError, history, historyBusy, historyError, accountError, refreshing, created,
  onRefresh, onMore, onTransaction, onOpenCard, onManageCards, onReloadCards }: {
  account?: Account;
  depositTerms: string;
  lang: Language;
  categories?: Category[];
  month: string;
  balanceSeries?: BalanceSeries;
  balanceSeriesError: boolean;
  cards?: LinkedCard[];
  cardsError: boolean;
  monthlyActivity?: Result<'getStatistics'>;
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
  onOpenCard: (id: string) => void;
  onManageCards: () => void;
  onReloadCards: () => void;
}) {
  const t = financeCopy[lang];
  const s = statisticsCopy[lang];
  const { width, fontScale } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
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
  const series = account && balanceSeries && balanceSeries.accountVersion >= account.accountVersion ? balanceSeries : undefined;
  const balance = account ? formatMoney(series?.points.at(-1)?.balanceMinor ?? account.balanceMinor, account.currency, lang) : '';
  const amounts = monthlyActivity?.totals.find(({ currency }) => currency === account?.currency);
  const metrics = account && monthlyActivity && cashFlowSeries.map(({ field, color, label }) => ({
    label: s[label], color, amount: formatMoney(amounts?.[field] ?? '0', account.currency, lang),
  }));
  const stackMetrics = Math.min(width, 540) / fontScale < 330 || !!metrics?.some(({ amount }) => amount.length > 18);
  const onlyOpening = history && !history.next && history.entries.every(({ type }) => type === 'opening');

  return <SectionList<Entry, MonthSection>
    sections={sections}
    contentContainerStyle={[layout.content, { paddingBottom: layout.content.paddingBottom + bottom }]}
    contentInsetAdjustmentBehavior="never"
    stickySectionHeadersEnabled={false}
    refreshing={refreshing} onRefresh={onRefresh}
    onEndReached={onMore} onEndReachedThreshold={0.45}
    keyExtractor={({ type, id }) => type + ':' + id}
    ListHeaderComponent={<View style={layout.header}>
      {account && <>
        <View style={layout.balance}>
          <Text accessibilityRole="header" style={layout.balanceLabel}>{t.accountBalance}</Text>
          <Text style={layout.balanceAmount} numberOfLines={1} adjustsFontSizeToFit
            accessibilityLiveRegion="polite" testID="finance-detail-balance">{balance}</Text>
          <Text style={layout.balanceMeta}>
            {t['type' in account ? account.type : 'regular']} · {formatFinancialDate(account.startDate, lang)}
          </Text>
          {!!depositTerms && <Text style={layout.balanceMeta}>{depositTerms}</Text>}
          {account.archived && <Text style={layout.balanceMeta}>{t.archivedAccount}</Text>}
          {account.needsReconciliation && <FinanceAlert style={layout.balanceAlert}>{t.needsReconciliation}</FinanceAlert>}
          {created && <Text style={layout.balanceMeta} testID="finance-receipt" accessibilityLiveRegion="polite">{t.accountCreated}</Text>}
        </View>
        {(!!cards?.length || cardsError) && <View style={layout.cardSection}>
          <View style={layout.cardHeader}>
            <Text accessibilityRole="header" style={styles.section} testID="finance-detail-cards">{t.cards}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t.manageAccount}
              onPress={onManageCards} testID="finance-detail-manage-cards"
              style={({ pressed }) => [layout.manageCards, pressed && styles.dimmed]}>
              <Text style={layout.manageCardsLabel}>{t.manageCards}</Text>
              <FinanceIcon name="chevron" color={palette.accent} size={14} />
            </Pressable>
          </View>
          {!!cards?.length && <View style={styles.surface}>
            {cards.map(({ cardId, name, lastFour, network }, index) => (
              <Pressable key={cardId} accessibilityRole="button" testID={'finance-detail-card-' + cardId}
                accessibilityLabel={[name, cardNetworkLabel(network, lang), lastFour].filter(Boolean).join(', ')}
                onPress={() => onOpenCard(cardId)}
                style={({ pressed }) => [layout.linkedCard, index < cards.length - 1 && layout.divider, pressed && styles.dimmed]}>
                <CardNetworkLogo network={network} />
                <View style={layout.cardIdentity}>
                  <Text style={styles.title}>{name}</Text>
                  {lastFour && <Text style={layout.cardDigits}>{'•••• ' + lastFour}</Text>}
                </View>
                <FinanceIcon name="chevron" color={palette.muted} size={14} />
              </Pressable>
            ))}
          </View>}
          {cardsError && <View style={[styles.surface, layout.cardLoadError]}>
            <FinanceAlert>{t.cardsLoadError}</FinanceAlert>
            <View style={layout.cardRetry}>
              <FinanceButton title={t.reloadCards} onPress={onReloadCards} />
            </View>
          </View>}
        </View>}
        <View style={[styles.surface, layout.summary]}>
          <Text accessibilityRole="header" style={styles.groupTitle}>{t.balanceTrend}</Text>
          {series && <AccountBalancePlot series={series} lang={lang} />}
          {!series && !balanceSeriesError && !balanceSeries &&
            <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} style={layout.loading} />}
          {(balanceSeriesError || (balanceSeries && !series)) && <FinanceAlert>{t.balanceTrendError}</FinanceAlert>}
        </View>
        <View style={[styles.surface, layout.summary]}>
          <Text accessibilityRole="header" style={styles.groupTitle}>
            {t.monthlyActivity} · {monthFormat.format(new Date(month + '-01T00:00:00Z'))}
          </Text>
          {metrics && <View style={stackMetrics ? layout.metricsStack : layout.metrics}>
            {metrics.map(({ label, amount, color }) => <View key={label} style={layout.metric}>
              <View style={layout.legend}>
                <View style={[layout.swatch, { backgroundColor: color }]} />
                <Text style={styles.meta}>{label}</Text>
              </View>
              <Text style={styles.value}>{amount}</Text>
            </View>)}
          </View>}
          {monthlyActivity && <AccountMonthlyFlow key={monthlyActivity.fromDate} report={monthlyActivity}
            currency={account.currency} lang={lang} />}
          {!monthlyActivity && !totalsError && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} style={layout.loading} />}
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
        <Text style={[layout.amount, item.type !== 'opening' && { color: transactionAmountColor(item.amountMinor) },
          isVoided && styles.mutedValue]}>
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
  balance: { backgroundColor: palette.balanceSurface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, gap: 4 },
  balanceLabel: { ...styles.groupTitle, color: palette.balanceMuted },
  balanceAmount: { ...styles.heroValue, color: palette.panel, fontSize: 40, fontWeight: '700', letterSpacing: -0.8,
    maxWidth: '100%', flexShrink: 1 },
  balanceMeta: { ...styles.meta, color: palette.balanceMuted },
  balanceAlert: { color: '#FFB4BB' },
  cardSection: { gap: 4 },
  cardHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12 },
  manageCards: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  manageCardsLabel: { color: palette.accent, flexShrink: 1, fontSize: 14, fontWeight: '600' },
  linkedCard: { flexDirection: 'row', alignItems: 'center', minHeight: 54, gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
  cardIdentity: { flex: 1, gap: 2 },
  cardDigits: { ...styles.meta, fontVariant: ['tabular-nums'] },
  cardLoadError: { gap: 8, padding: 12 },
  cardRetry: { alignItems: 'flex-start' },
  summary: { padding: 12, gap: 9 },
  metrics: { flexDirection: 'row', gap: 12 },
  metricsStack: { gap: 9 },
  metric: { flexGrow: 1, flexBasis: 0, gap: 2 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 7, height: 7, borderRadius: 2 },
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
