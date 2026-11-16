import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import type { Language, Result } from '@teta/contracts';
import { copy } from './copy';
import { cashFlowSeries, cashFlowWeeks, WeeklyCashFlowPlot } from './finance-cash-flow';
import { financeCopy } from './finance-copy';
import { currencies, currencyName, currencySymbol, formatFinancialDate, formatMoney, formatRate } from './finance-format';
import { CardNetworkLogo, cardNetworkLabel } from './finance-card-network';
import type { Currency } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { scheduleCopy } from './finance-schedule-copy';
import { statisticsCopy } from './finance-statistics-copy';
import type { StatisticsPreset } from './finance-statistics';
import { cardTextColor, FinanceAlert, palette, styles } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type CardPreview = Result<'listAccounts'>['cardPreviews'][number];
type Category = Result<'listCategories'>['categories'][number];
type Quote = Result<'getExchangeRates'>['rates'][number];
type Read<T> = { data?: T; busy: boolean; error?: string; load(): Promise<void> };

const labels = {
  ru: {
    switchBalance: 'Показать остаток', annual: 'годовых', matures: 'до', moreCards: 'Другие карточки',
    flow: 'Движение денег', statistics: 'Вся статистика',
    noFlow: 'Нет операций за 90 дней.', flowError: 'Не удалось обновить движение денег.',
    rates: 'Курсы валют', source: 'Официальные курсы Банка России', ratesError: 'Не удалось обновить курсы валют.',
    cachedRates: 'Показаны сохранённые курсы.', effective: 'Действует с', change: 'К предыдущему курсу',
    history: 'Динамика за 30 дней', nextPayment: 'Ближайший платёж', noPayment: 'Нет запланированных платежей.',
    paymentError: 'Не удалось обновить ближайший платёж.', schedule: 'Расписание',
  },
  en: {
    switchBalance: 'Show balance', annual: 'per year', matures: 'until', moreCards: 'More cards',
    flow: 'Cash flow', statistics: 'View statistics',
    noFlow: 'No transactions in the last 90 days.', flowError: 'Could not update cash flow.',
    rates: 'Exchange rates', source: 'Official Bank of Russia rates', ratesError: 'Could not update exchange rates.',
    cachedRates: 'Showing saved rates.', effective: 'Effective from', change: 'Since the previous rate',
    history: '30-day history', nextPayment: 'Next payment', noPayment: 'No scheduled payments.',
    paymentError: 'Could not update the next payment.', schedule: 'Schedule',
  },
} as const;

export function BalanceCard({ accounts, lang }: { accounts: Account[]; lang: Language }) {
  const { width, fontScale } = useWindowDimensions();
  const [selectedOrder, setSelectedOrder] = useState<readonly Currency[]>();
  const defaultCurrency = accounts.some(({ currency }) => currency === 'RUB') ? 'RUB' : accounts[0]?.currency ?? 'RUB';
  const [primary, ...alternatives] = selectedOrder ?? [defaultCurrency, ...currencies.filter((currency) => currency !== defaultCurrency)];
  const totals: Record<Currency, bigint> = { RUB: 0n, USD: 0n, EUR: 0n };
  for (const { currency, balanceMinor } of accounts) totals[currency] += BigInt(balanceMinor);
  const amount = (currency: Currency) => formatMoney(String(totals[currency]), currency, lang);
  const stack = (Math.min(width, 540) - 74) / fontScale < 218 ||
    alternatives.some((currency) => amount(currency).length > 16);

  return <View style={layout.balanceCard} testID="finance-dashboard-balances">
    <Text accessibilityRole="header" style={layout.balanceTitle}>{financeCopy[lang].balances}</Text>
    <Text style={layout.balanceValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.35}
      accessibilityLiveRegion="polite" testID="finance-dashboard-main-balance">{amount(primary)}</Text>
    <View style={[layout.balanceChoices, stack && layout.balanceChoicesStacked]}>
      {alternatives.map((currency, index) => <Pressable key={index} accessibilityRole="button"
        accessibilityLabel={labels[lang].switchBalance + ' · ' + amount(currency)}
        testID={'finance-dashboard-balance-' + currency}
        onPress={() => setSelectedOrder([currency, ...alternatives.map((other) => other === currency ? primary : other)])}
        style={({ pressed }) => [layout.balanceChoice, !stack && layout.balanceChoiceColumn, pressed && layout.balanceChoicePressed]}>
        <Text style={layout.balanceChoiceValue}>{amount(currency)}</Text>
        <FinanceIcon name="chevron" color={palette.selected} size={13} />
      </Pressable>)}
    </View>
  </View>;
}

export function OverviewAccountCard({ account, preview, lang, divider, onOpen }: {
  account: Account; preview?: CardPreview; lang: Language; divider: boolean; onOpen(): void;
}) {
  const t = financeCopy[lang];
  const words = labels[lang];
  const type = 'type' in account ? account.type : 'regular';
  const amount = formatMoney(account.balanceMinor, account.currency, lang);
  const terms = 'type' in account && account.type === 'deposit'
    ? formatRate(account.annualRatePercent, lang) + '% ' + words.annual + ' · ' + words.matures + ' ' +
      formatFinancialDate(account.maturityDate, lang)
    : undefined;
  const cardSummary = preview && [
    ...preview.cards.map(({ name, lastFour, network }) => [name, cardNetworkLabel(network, lang), lastFour].filter(Boolean).join(' · ')),
    ...(preview.count > preview.cards.length ? [words.moreCards + ': ' + (preview.count - preview.cards.length)] : []),
  ].join(', ');
  const label = [account.name, amount, t[type], terms,
    account.needsReconciliation && t.needsReconciliation, cardSummary].filter(Boolean).join(', ');
  return <Pressable accessibilityRole="button" accessibilityLabel={label} testID={'finance-account-' + account.accountId}
    onPress={onOpen} style={({ pressed }) => [layout.overviewAccount, divider && layout.rowDivider, pressed && layout.overviewAccountPressed]}>
    <View style={layout.accountLine}>
      <View style={layout.accountIdentity}>
        <FinanceIcon name={type === 'regular' ? 'wallet' : type} color={palette.muted} size={18} />
        <Text style={styles.title}>{account.name}</Text>
      </View>
      <View style={layout.accountValue}>
        <Text style={layout.accountAmount}>{amount}</Text>
        <FinanceIcon name="chevron" color={palette.muted} size={13} />
      </View>
    </View>
    {terms && <Text style={[styles.meta, layout.accountDetail]}>{terms}</Text>}
    {account.needsReconciliation && <Text style={[styles.meta, layout.accountDetail]}>{t.needsReconciliation}</Text>}
    {preview && <View style={layout.linkedCards}>
      {preview.cards.map(({ cardId, appearance, lastFour, name, network }) => {
        const color = cardTextColor(appearance);
        const contactColor = color + '73';
        return <View key={cardId} style={[layout.linkedCard, { backgroundColor: appearance }]}>
          {network && <View style={layout.linkedCardTop}>
            <View style={[layout.linkedCardChip, { backgroundColor: color + '26', borderColor: contactColor }]}>
              <View style={[layout.linkedCardContacts, { borderColor: contactColor }]} />
            </View>
            <CardNetworkLogo network={network} appearance={appearance} style={layout.linkedCardLogo} />
          </View>}
          {(!network || lastFour) && <Text style={[layout.linkedCardCaption, { color }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {lastFour ? '•• ' + lastFour : name}
          </Text>}
        </View>;
      })}
      {preview.count > preview.cards.length && <Text style={layout.linkedCount}>+{preview.count - preview.cards.length}</Text>}
    </View>}
  </Pressable>;
}

function Card({ title, detail, action, style, testID, children }: {
  title: string; detail?: string; action?: ReactNode; style?: StyleProp<ViewStyle>; testID: string; children: ReactNode;
}) {
  return <View style={[styles.surface, layout.card, style]} testID={testID}>
    <View style={layout.cardHeader}>
      <View style={layout.labels}>
        <Text accessibilityRole="header" style={styles.section}>{title}</Text>
        {!!detail && <Text style={styles.meta}>{detail}</Text>}
      </View>
      {action}
    </View>
    {children}
  </View>;
}

function CardLink({ title, onPress, testID }: { title: string; onPress(): void; testID?: string }) {
  return <Pressable accessibilityRole="button" testID={testID} onPress={onPress}
    style={({ pressed }) => [layout.link, pressed && styles.dimmed]}>
    <Text style={layout.linkText}>{title}</Text>
    <FinanceIcon name="chevron" size={14} color={palette.accent} />
  </Pressable>;
}

function ReadStatus<T>({ read, lang, message, stale = false }: { read: Read<T>; lang: Language; message: string; stale?: boolean }) {
  if (read.error || stale) return <View>
    <FinanceAlert>{message}</FinanceAlert>
    <CardLink title={copy[lang].retry} onPress={() => void read.load()} />
  </View>;
  if (read.busy && !read.data) return <ActivityIndicator accessibilityLabel={financeCopy[lang].loading}
    color={palette.accent} style={layout.loading} />;
  return null;
}

export function CashFlowCard({ read, accounts, lang, onStatistics }: {
  read: Read<Result<'getStatistics'>>; accounts?: Account[]; lang: Language; onStatistics(preset: StatisticsPreset): void;
}) {
  const [selected, setSelected] = useState<Currency>();
  const [selectedWeek, setSelectedWeek] = useState<string>();
  const currency = selected ?? (accounts?.some((account) => account.currency === 'RUB') ? 'RUB' : accounts?.[0]?.currency) ?? 'RUB';
  const report = read.data;
  const t = labels[lang];
  const s = statisticsCopy[lang];
  const total = report?.totals.find((total) => total.currency === currency);
  const weeks = cashFlowWeeks(report, currency);
  const weekIndex = weeks.findIndex(({ fromDate }) => fromDate === selectedWeek);
  const week = weeks[weekIndex];

  const statisticsLink = report && <CardLink title={t.statistics} testID="finance-dashboard-statistics"
    onPress={() => onStatistics({ fromDate: report.fromDate, throughDate: report.throughDate, currency })} />;
  return <Card title={t.flow} detail={s.recent} testID="finance-dashboard-cash-flow" action={statisticsLink}>
    <View accessibilityRole="radiogroup" accessibilityLabel={s.currency} style={layout.currencyControl}>
      {currencies.map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: code === currency }}
        onPress={() => {
          if (code !== currency) setSelectedWeek(undefined);
          setSelected(code);
        }} testID={'finance-dashboard-flow-' + code}
        style={({ pressed }) => [layout.currencyOption, code === currency && layout.selectedCurrency, pressed && styles.dimmed]}>
        <Text style={[layout.currencyText, code === currency && layout.selectedCurrencyText]}>{currencyName(code, lang)}</Text>
      </Pressable>)}
    </View>
    {report && (total ? <>
      <View style={layout.metrics}>
        {cashFlowSeries.map(({ field, label, color }) => <View key={field} style={layout.metric}>
          <View style={layout.legend}>
            <View style={[layout.swatch, { backgroundColor: color }]} />
            <Text style={styles.meta}>{s[label]}</Text>
          </View>
          <Text style={layout.metricValue}>{formatMoney(total?.[field] ?? '0', currency, lang)}</Text>
        </View>)}
      </View>
      {weeks.length > 0 && <WeeklyCashFlowPlot weeks={weeks} currency={currency} lang={lang} overview
        selection={{ index: weekIndex, onSelect: (index) => setSelectedWeek(index === weekIndex ? undefined : weeks[index].fromDate) }} />}
      {week ? <View style={layout.weekDetails} testID="finance-dashboard-week-details" accessibilityLiveRegion="polite">
        <Text style={styles.groupTitle}>{formatFinancialDate(week.fromDate, lang)} – {formatFinancialDate(week.throughDate, lang)}</Text>
        {cashFlowSeries.map(({ field, label }) => <View key={field} style={layout.weekMetric}>
          <Text style={styles.meta}>{s[label]}</Text>
          <Text style={styles.title}>{formatMoney(week[field], currency, lang)}</Text>
        </View>)}
      </View> : null}
    </> : <Text style={styles.meta}>{t.noFlow}</Text>)}
    <ReadStatus read={read} lang={lang} message={t.flowError} />
  </Card>;
}

const sparkWidth = 112;
const sparkHeight = 38;
function RateTrend({ history }: { history: Quote['history'] }) {
  if (history.length < 2) return null;
  const values = history.map(({ rate }) => Number(rate));
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  const lastDate = Date.parse(history.at(-1)!.date);
  const startDate = lastDate - 29 * 86_400_000;
  const points = history.map(({ date }, index) => ({
    x: 2 + Math.max(0, (Date.parse(date) - startDate) / (lastDate - startDate)) * (sparkWidth - 4),
    y: range ? sparkHeight - 4 - (values[index] - min) / range * (sparkHeight - 8) : sparkHeight / 2,
  }));
  return <View style={layout.spark} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={layout.sparkGuide} />
    {points.slice(1).map(({ x, y }, index) => {
      const before = points[index];
      const angle = Math.atan2(y - before.y, x - before.x);
      const width = Math.hypot(x - before.x, y - before.y) + 1;
      return <View key={index} style={[layout.segment, {
        width, left: (x + before.x - width) / 2, top: (y + before.y) / 2 - 1,
        transform: [{ rotate: angle + 'rad' }],
      }]} />;
    })}
  </View>;
}

export function ExchangeRatesCard({ read, lang }: { read: Read<Result<'getExchangeRates'>>; lang: Language }) {
  const t = labels[lang];
  const number = new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const delta = new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
    minimumFractionDigits: 4, maximumFractionDigits: 4, signDisplay: 'exceptZero',
  });
  return <Card title={t.rates} detail={t.source} testID="finance-dashboard-rates">
    {(read.data?.rates ?? [{ currency: 'USD' }, { currency: 'EUR' }] as const).map((quote, index) => {
      const ruble = '\u00a0' + currencySymbol('RUB');
      return <View key={quote.currency} style={[layout.rateRow, index > 0 && layout.rowDivider]}>
        <View style={layout.rateDetails}>
          <Text style={styles.title}>{currencyName(quote.currency, lang)}</Text>
          <Text style={layout.metricValue}>{'current' in quote
            ? '1\u00a0' + currencySymbol(quote.currency) + ' = ' + number.format(Number(quote.current.rate)) + ruble : '—'}</Text>
          {'current' in quote && <Text style={styles.meta}>
            {t.effective} {formatFinancialDate(quote.current.date, lang)}
          </Text>}
          {'previous' in quote && quote.previous && <Text style={styles.meta}>
            {t.change} {delta.format(Number((Number(quote.current.rate) - Number(quote.previous.rate)).toFixed(4)))}{ruble}
          </Text>}
        </View>
        {'history' in quote && quote.history.length > 1 && <View style={layout.trend}>
          <RateTrend history={quote.history} />
          <Text style={layout.axis}>{t.history}</Text>
        </View>}
      </View>;
    })}
    <ReadStatus read={read} lang={lang} message={read.data ? t.cachedRates : t.ratesError} stale={read.data?.stale} />
  </Card>;
}

export function NextPaymentCard({ read, categories, lang, onSchedule }: {
  read: Read<Result<'getNextPayment'>>; categories?: Category[]; lang: Language;
  onSchedule(ruleId?: string, date?: string): void;
}) {
  const t = labels[lang];
  const payment = read.data?.payment;
  const category = categories?.find(({ id }) => id === payment?.categoryId);
  const title = payment?.comment || (category && (lang === 'ru' ? category.nameRu : category.nameEn)) || financeCopy[lang].expenseEntry;
  return <Card title={t.nextPayment} style={layout.nextPaymentCard} testID="finance-dashboard-next-payment"
    action={<CardLink title={t.schedule} onPress={() => onSchedule()} />}>
    {payment ? <Pressable accessibilityRole="button" onPress={() => onSchedule(payment.ruleId, payment.date)}
      style={({ pressed }) => [layout.payment, pressed && styles.dimmed]}>
      <View style={layout.paymentIdentity}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.meta}>{formatFinancialDate(payment.date, lang)}</Text>
        {payment.status !== 'planned' && <Text style={styles.meta}>{scheduleCopy[lang][payment.status]}</Text>}
      </View>
      <Text style={[layout.metricValue, layout.paymentAmount]}>{formatMoney('-' + payment.amountMinor, payment.currency, lang)}</Text>
      <FinanceIcon name="chevron" color={palette.muted} size={13} />
    </Pressable> : read.data && <Text style={styles.meta}>{t.noPayment}</Text>}
    <ReadStatus read={read} lang={lang} message={t.paymentError} />
  </Card>;
}

const layout = StyleSheet.create({
  balanceCard: { backgroundColor: palette.balanceSurface, borderRadius: 20, padding: 18 },
  balanceTitle: { color: palette.balanceMuted, fontSize: 14, fontWeight: '600' },
  balanceValue: { color: palette.panel, fontSize: 40, fontWeight: '600', letterSpacing: -1.2,
    fontVariant: ['tabular-nums'], flexShrink: 1, maxWidth: '100%', marginTop: 6, marginBottom: 11 },
  balanceChoices: { flexDirection: 'row', gap: 8, paddingTop: 5, borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.24)' },
  balanceChoicesStacked: { flexDirection: 'column' },
  balanceChoice: { flexDirection: 'row', alignItems: 'center', borderRadius: 8, paddingHorizontal: 4, paddingVertical: 5,
    minHeight: 44, gap: 6 },
  balanceChoiceColumn: { flex: 1 },
  balanceChoicePressed: { backgroundColor: 'rgba(255,255,255,0.20)' },
  balanceChoiceValue: { color: palette.panel, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
  overviewAccount: { gap: 4, paddingHorizontal: 13, paddingVertical: 10, minHeight: 53, justifyContent: 'center' },
  overviewAccountPressed: { backgroundColor: palette.raised },
  accountLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  accountIdentity: { flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexBasis: '45%', minWidth: 112, gap: 9 },
  accountValue: { marginLeft: 'auto', maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 7 },
  accountAmount: { color: palette.ink, fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' },
  accountDetail: { marginLeft: 27 },
  linkedCards: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginLeft: 27, marginTop: 4 },
  linkedCard: { width: 76, aspectRatio: 1.586, maxWidth: '100%', borderRadius: 6, padding: 5,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(23,38,58,0.15)' },
  linkedCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  linkedCardChip: { width: 13, height: 10, borderRadius: 2, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  linkedCardContacts: { width: 5, flex: 1, borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth },
  linkedCardLogo: { width: 26, height: 15 },
  linkedCardCaption: { marginTop: 'auto', fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  linkedCount: { color: palette.muted, fontSize: 12, paddingLeft: 2 },
  card: { borderRadius: 20, padding: 17, gap: 10 },
  cardHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 10 },
  labels: { gap: 3 },
  link: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', minHeight: 44, gap: 6 },
  linkText: { color: palette.accent, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  loading: { alignSelf: 'flex-start', minHeight: 44 },
  currencyControl: { flexDirection: 'row', flexWrap: 'wrap', alignSelf: 'flex-start', gap: 4 },
  currencyOption: { minWidth: 52, minHeight: 44, paddingHorizontal: 10, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  selectedCurrency: { backgroundColor: palette.selected },
  currencyText: { fontSize: 14, color: palette.muted, fontWeight: '600' },
  selectedCurrencyText: { color: palette.accent, fontWeight: '700' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 8 },
  metric: { flexGrow: 1, gap: 3 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  metricValue: { color: palette.ink, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  weekDetails: { borderTopColor: palette.line, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 3 },
  weekMetric: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', columnGap: 8 },
  axis: { color: palette.muted, fontSize: 12, textAlign: 'center', fontVariant: ['tabular-nums'] },
  rateRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 7 },
  rateDetails: { flexGrow: 1, gap: 3 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  trend: { width: sparkWidth, gap: 4 },
  spark: { width: sparkWidth, height: sparkHeight },
  sparkGuide: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.line },
  segment: { position: 'absolute', height: 2, borderRadius: 1, backgroundColor: palette.accent },
  nextPaymentCard: { paddingTop: 7 },
  payment: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 },
  paymentIdentity: { flexGrow: 1, flexBasis: '42%', minWidth: 100, gap: 3 },
  paymentAmount: { flexShrink: 1, marginLeft: 'auto', textAlign: 'right' },
});
