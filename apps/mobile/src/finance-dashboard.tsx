import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { ReactNode } from 'react';
import type { Language, Result } from '@teta/contracts';
import { copy } from './copy';
import { financeCopy } from './finance-copy';
import { addFinancialDays, currencies, formatAmount, formatFinancialDate, formatMoney, formatRate } from './finance-format';
import type { Currency } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { scheduleCopy } from './finance-schedule-copy';
import { statisticsCopy } from './finance-statistics-copy';
import type { StatisticsPreset } from './finance-statistics';
import { FinanceAlert, palette, styles } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type CardPreview = Result<'listAccounts'>['cardPreviews'][number];
type Category = Result<'listCategories'>['categories'][number];
type Quote = Result<'getExchangeRates'>['rates'][number];
type Read<T> = { data?: T; busy: boolean; error?: string; load(): Promise<void> };

const labels = {
  ru: {
    switchBalance: 'Показать остаток', annual: 'годовых', matures: 'до', moreCards: 'Другие карточки',
    flow: 'Движение денег', period: 'Последние 30 дней', statistics: 'Вся статистика',
    noFlow: 'За этот период в выбранной валюте нет операций.', flowError: 'Не удалось обновить движение денег.',
    rates: 'Курсы валют', source: 'Официальные курсы Банка России', ratesError: 'Не удалось обновить курсы валют.',
    cachedRates: 'Показаны сохранённые курсы.', effective: 'Действует с', change: 'К предыдущему курсу',
    history: 'Динамика за 30 дней', nextPayment: 'Ближайший платёж', noPayment: 'Нет запланированных платежей.',
    paymentError: 'Не удалось обновить ближайший платёж.', schedule: 'Расписание',
  },
  en: {
    switchBalance: 'Show balance', annual: 'per year', matures: 'until', moreCards: 'More cards',
    flow: 'Cash flow', period: 'Last 30 days', statistics: 'View statistics',
    noFlow: 'No transactions in this currency for the period.', flowError: 'Could not update cash flow.',
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
  const amount = (currency: Currency) => formatAmount(String(totals[currency]), lang);
  const stack = (Math.min(width, 540) - 74) / fontScale < 218 ||
    alternatives.some((currency) => amount(currency).length > 16);

  return <View style={layout.balanceCard} testID="finance-dashboard-balances">
    <Text accessibilityRole="header" style={layout.balanceTitle}>{financeCopy[lang].balances}</Text>
    <View style={layout.mainBalance} accessible accessibilityLiveRegion="polite"
      accessibilityLabel={amount(primary) + ' ' + primary} testID="finance-dashboard-main-balance">
      <Text style={layout.balanceValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.35}>{amount(primary)}</Text>
      <Text style={layout.balanceUnit}>{primary}</Text>
    </View>
    <View style={[layout.balanceChoices, stack && layout.balanceChoicesStacked]}>
      {alternatives.map((currency, index) => <Pressable key={index} accessibilityRole="button"
        accessibilityLabel={labels[lang].switchBalance + ' · ' + amount(currency) + ' ' + currency}
        testID={'finance-dashboard-balance-' + currency}
        onPress={() => setSelectedOrder([currency, ...alternatives.map((other) => other === currency ? primary : other)])}
        style={({ pressed }) => [layout.balanceChoice, !stack && layout.balanceChoiceColumn, pressed && layout.balanceChoicePressed]}>
        <View style={layout.balanceChoiceHeader}>
          <Text style={layout.balanceUnit}>{currency}</Text>
          <FinanceIcon name="chevron" color={palette.selected} size={13} />
        </View>
        <Text style={layout.balanceChoiceValue}>{amount(currency)}</Text>
      </Pressable>)}
    </View>
  </View>;
}

const currencySigns: Record<Currency, string> = { RUB: '₽', USD: '$', EUR: '€' };

function cardTextColor(color: string) {
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.179 ? '#000000' : palette.panel;
}

export function OverviewAccountCard({ account, preview, lang, onOpen }: {
  account: Account; preview?: CardPreview; lang: Language; onOpen(): void;
}) {
  const t = financeCopy[lang];
  const words = labels[lang];
  const type = 'type' in account ? account.type : 'regular';
  const amount = formatAmount(account.balanceMinor, lang);
  const terms = 'type' in account && account.type === 'deposit'
    ? formatRate(account.annualRatePercent, lang) + '% ' + words.annual + ' · ' + words.matures + ' ' +
      formatFinancialDate(account.maturityDate, lang)
    : undefined;
  const cardSummary = preview && [
    ...preview.cards.map(({ name, lastFour }) => lastFour ? name + ' · ' + lastFour : name),
    ...(preview.count > preview.cards.length ? [words.moreCards + ': ' + (preview.count - preview.cards.length)] : []),
  ].join(', ');
  const label = [account.name, amount + ' ' + account.currency, t[type], terms,
    account.needsReconciliation && t.needsReconciliation, cardSummary].filter(Boolean).join(', ');
  return <Pressable accessibilityRole="button" accessibilityLabel={label} testID={'finance-account-' + account.accountId}
    onPress={onOpen} style={({ pressed }) => [layout.overviewAccount, pressed && layout.overviewAccountPressed]}>
    <View style={[layout.accountIcon, type !== 'regular' && layout.accountTypeIcon]}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {type === 'regular'
        ? <Text allowFontScaling={false} style={layout.accountSign}>{currencySigns[account.currency]}</Text>
        : <FinanceIcon name={type} color={palette.muted} size={20} />}
    </View>
    <View style={layout.accountInfo}>
      <Text style={layout.accountAmount}>{amount}{' '}<Text style={layout.accountUnit}>{account.currency}</Text></Text>
      <Text style={layout.accountName}>{account.name}</Text>
      {terms && <Text style={styles.meta}>{terms}</Text>}
      {account.needsReconciliation && <Text style={styles.meta}>{t.needsReconciliation}</Text>}
      {preview && <View style={layout.linkedCards}>
        {preview.cards.map(({ cardId, appearance, lastFour }) => {
          const color = cardTextColor(appearance);
          return <View key={cardId} style={[layout.linkedCard, { backgroundColor: appearance }]}>
            {lastFour
              ? <Text style={[layout.linkedDigits, { color }]}>•• {lastFour}</Text>
              : <FinanceIcon name="card" color={color} size={14} />}
          </View>;
        })}
        {preview.count > preview.cards.length && <Text style={layout.linkedCount}>+{preview.count - preview.cards.length}</Text>}
      </View>}
    </View>
    <View style={layout.accountChevron}><FinanceIcon name="chevron" color={palette.muted} size={14} /></View>
  </Pressable>;
}

function Card({ title, detail, action, testID, children }: {
  title: string; detail?: string; action?: ReactNode; testID: string; children: ReactNode;
}) {
  return <View style={[styles.surface, layout.card]} testID={testID}>
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

const series = [
  { field: 'incomeMinor', label: 'income', color: palette.accent },
  { field: 'expenseMinor', label: 'expenses', color: '#91A6BC' },
] as const;
const shortDate = (date: string, lang: Language) => formatFinancialDate(date, lang).slice(0, 5);
const plotHeight = 104;

export function CashFlowCard({ read, accounts, lang, onStatistics }: {
  read: Read<Result<'getStatistics'>>; accounts?: Account[]; lang: Language; onStatistics(preset: StatisticsPreset): void;
}) {
  const [selected, setSelected] = useState<Currency>();
  const currency = selected ?? (accounts?.some((account) => account.currency === 'RUB') ? 'RUB' : accounts?.[0]?.currency) ?? 'RUB';
  const report = read.data;
  const t = labels[lang];
  const s = statisticsCopy[lang];
  const total = report?.totals.find((total) => total.currency === currency);
  const entries = report?.weeks?.filter((week) => week.currency === currency) ?? [];
  const weeks = report ? Array.from({ length: 5 }, (_, weekIndex) => {
    const fromDate = addFinancialDays(report.fromDate, weekIndex * 7);
    const throughDate = addFinancialDays(fromDate, 6);
    return {
      fromDate, throughDate: throughDate > report.throughDate ? report.throughDate : throughDate,
      ...entries.find((week) => week.weekIndex === weekIndex),
    };
  }) : [];
  const max = Math.max(0, ...weeks.flatMap((week) => series.map(({ field }) => Number(week[field] ?? 0))));

  const statisticsLink = report && <CardLink title={t.statistics} testID="finance-dashboard-statistics"
    onPress={() => onStatistics({ fromDate: report.fromDate, throughDate: report.throughDate, currency })} />;
  return <Card title={t.flow} detail={t.period} testID="finance-dashboard-cash-flow" action={statisticsLink}>
    <View accessibilityRole="radiogroup" accessibilityLabel={s.currency} style={layout.currencyControl}>
      {currencies.map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: code === currency }}
        onPress={() => setSelected(code)} testID={'finance-dashboard-flow-' + code}
        style={({ pressed }) => [layout.currencyOption, code === currency && layout.selectedCurrency, pressed && styles.dimmed]}>
        <Text style={[layout.currencyText, code === currency && layout.selectedCurrencyText]}>{code}</Text>
      </Pressable>)}
    </View>
    {report?.weeks && <>
      <View style={layout.metrics}>
        {series.map(({ field, label, color }) => <View key={field} style={layout.metric}>
          <View style={layout.legend}>
            <View style={[layout.swatch, { backgroundColor: color }]} />
            <Text style={styles.meta}>{s[label]}</Text>
          </View>
          <Text style={layout.metricValue}>{formatMoney(total?.[field] ?? '0', currency, lang)}</Text>
        </View>)}
      </View>
      <View style={layout.plot}>
        <View style={layout.guides} pointerEvents="none">
          {[0, 1, 2].map((line) => <View key={line} style={layout.guide} />)}
        </View>
        {weeks.map((week, index) => <View key={week.fromDate} style={layout.week} accessible
          accessibilityLabel={[
            formatFinancialDate(week.fromDate, lang) + ' – ' + formatFinancialDate(week.throughDate, lang),
            ...series.map(({ field, label }) => s[label] + ' ' + formatMoney(week[field] ?? '0', currency, lang)),
          ].join(', ')}>
          <View style={layout.bars}>
            {series.map(({ field, color }) => {
              const proportional = max ? Number(week[field] ?? 0) / max * (plotHeight - 8) : 0;
              return <View key={field} style={[layout.bar, {
                backgroundColor: color, height: proportional ? Math.max(2, proportional) : 0,
              }]} />;
            })}
          </View>
          <Text style={layout.axis}>{index % 2 === 0 ? shortDate(week.fromDate, lang) : ''}</Text>
        </View>)}
      </View>
      {max === 0 && <Text style={styles.meta}>{t.noFlow}</Text>}
    </>}
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
      const pair = quote.currency + '/RUB';
      return <View key={pair} style={[layout.rateRow, index > 0 && layout.rowDivider]}>
        <View style={layout.rateDetails}>
          <Text style={styles.title}>{pair}</Text>
          <Text style={layout.metricValue}>{'current' in quote ? number.format(Number(quote.current.rate)) : '—'}</Text>
          {'current' in quote && <Text style={styles.meta}>
            {t.effective} {formatFinancialDate(quote.current.date, lang)}
          </Text>}
          {'previous' in quote && quote.previous && <Text style={styles.meta}>
            {t.change} {delta.format(Number((Number(quote.current.rate) - Number(quote.previous.rate)).toFixed(4)))}
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
  return <Card title={t.nextPayment} testID="finance-dashboard-next-payment">
    {payment ? <Pressable accessibilityRole="button" onPress={() => onSchedule(payment.ruleId, payment.date)}
      style={({ pressed }) => [layout.payment, pressed && styles.dimmed]}>
      <View style={layout.paymentDate}>
        <FinanceIcon name="calendar" size={17} color={palette.accent} />
        <Text style={layout.linkText}>{formatFinancialDate(payment.date, lang)}</Text>
      </View>
      <View style={layout.paymentContent}>
        <Text style={styles.title}>{title}</Text>
        <Text style={layout.metricValue}>{formatMoney('-' + payment.amountMinor, payment.currency, lang)}</Text>
      </View>
      {payment.status !== 'planned' && <Text style={styles.meta}>{scheduleCopy[lang][payment.status]}</Text>}
    </Pressable> : read.data && <Text style={styles.meta}>{t.noPayment}</Text>}
    <ReadStatus read={read} lang={lang} message={t.paymentError} />
    <CardLink title={t.schedule} onPress={() => onSchedule()} />
  </Card>;
}

const layout = StyleSheet.create({
  balanceCard: { backgroundColor: palette.accent, borderRadius: 20, padding: 18 },
  balanceTitle: { color: palette.selected, fontSize: 14, fontWeight: '600' },
  mainBalance: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 9, marginTop: 6, marginBottom: 16 },
  balanceValue: { color: palette.panel, fontSize: 42, fontWeight: '700', letterSpacing: -1.3,
    fontVariant: ['tabular-nums'], flexShrink: 1, maxWidth: '100%' },
  balanceUnit: { color: palette.selected, fontSize: 12, fontWeight: '600' },
  balanceChoices: { flexDirection: 'row', gap: 8, paddingTop: 11, borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.34)' },
  balanceChoicesStacked: { flexDirection: 'column' },
  balanceChoice: { backgroundColor: 'rgba(255,255,255,0.10)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7,
    minHeight: 50, justifyContent: 'center', gap: 2 },
  balanceChoiceColumn: { flex: 1 },
  balanceChoicePressed: { backgroundColor: 'rgba(255,255,255,0.20)' },
  balanceChoiceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  balanceChoiceValue: { color: palette.panel, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  overviewAccount: { ...styles.surface, borderRadius: 16, flexDirection: 'row', columnGap: 11, padding: 13, alignItems: 'flex-start' },
  overviewAccountPressed: { backgroundColor: palette.raised },
  accountIcon: { backgroundColor: palette.selected, borderRadius: 21, width: 42, height: 42,
    justifyContent: 'center', alignItems: 'center' },
  accountTypeIcon: { backgroundColor: palette.raised },
  accountSign: { fontSize: 22, color: palette.accent, fontWeight: '600' },
  accountInfo: { flex: 1, gap: 2 },
  accountAmount: { color: palette.ink, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  accountUnit: { color: palette.muted, fontSize: 12, fontWeight: '600' },
  accountName: { color: palette.muted, fontSize: 14 },
  accountChevron: { alignSelf: 'center' },
  linkedCards: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 },
  linkedCard: { borderRadius: 6, minWidth: 53, minHeight: 32, padding: 5, justifyContent: 'flex-end' },
  linkedDigits: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
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
  plot: { flexDirection: 'row', marginTop: 6 },
  guides: { position: 'absolute', top: 6, left: 0, right: 0, height: plotHeight - 6, justifyContent: 'space-between' },
  guide: { height: StyleSheet.hairlineWidth, backgroundColor: palette.line },
  week: { flex: 1, gap: 4 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 4, height: plotHeight },
  bar: { width: '23%', maxWidth: 23, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  axis: { color: palette.muted, fontSize: 12, textAlign: 'center', fontVariant: ['tabular-nums'] },
  rateRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 7 },
  rateDetails: { flexGrow: 1, gap: 3 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  trend: { width: sparkWidth, gap: 4 },
  spark: { width: sparkWidth, height: sparkHeight },
  sparkGuide: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.line },
  segment: { position: 'absolute', height: 2, borderRadius: 1, backgroundColor: palette.accent },
  payment: { minHeight: 44, backgroundColor: palette.raised, borderRadius: 10, padding: 12, gap: 8 },
  paymentDate: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  paymentContent: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
});
