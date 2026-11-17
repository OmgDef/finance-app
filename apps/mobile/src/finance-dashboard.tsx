import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import type { Language, Result } from '@teta/contracts';
import { isComaBank } from './app-variant';
import { copy } from './copy';
import { cashFlowSeries, cashFlowWeeks, NetCashFlowPlot, netCashFlow, WeeklyCashFlowPlot } from './finance-cash-flow';
import { financeCopy } from './finance-copy';
import { currencies, currencyName, currencySymbol, formatFinancialDate, formatMoney, formatRate } from './finance-format';
import { CardNetworkLogo, cardNetworkLabel } from './finance-card-network';
import type { Currency } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { statisticsCopy } from './finance-statistics-copy';
import type { StatisticsPreset } from './finance-statistics';
import { cardTextColor, FinanceAlert, palette, styles } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type CardPreview = Result<'listAccounts'>['cardPreviews'][number];
type Quote = Result<'getExchangeRates'>['rates'][number];
type Read<T> = { data?: T; busy: boolean; error?: string; load(): Promise<void> };
type RatesProps = { read: Read<Result<'getExchangeRates'>>; lang: Language };

const rateCurrencies = ['USD', 'EUR'] as const;

const labels = {
  ru: {
    switchBalance: 'Показать остаток', annual: 'годовых', matures: 'до', moreCards: 'Другие карточки',
    flow: 'Движение денег', netFlow: 'Чистый поток', statistics: 'Вся статистика',
    noFlow: 'Нет операций за 90 дней.', flowError: 'Не удалось обновить движение денег.',
    rates: 'Курсы валют', source: 'Официальные курсы Банка России', ratesError: 'Не удалось обновить курсы валют.',
    cachedRates: 'Показаны сохранённые курсы.', effective: 'Действует с', change: 'К предыдущему курсу',
    history: 'Динамика за 30 дней', rateDetails: 'Точный курс и история',
    rateUp: 'Выше предыдущего курса', rateDown: 'Ниже предыдущего курса', rateUnchanged: 'Курс не изменился',
  },
  en: {
    switchBalance: 'Show balance', annual: 'per year', matures: 'until', moreCards: 'More cards',
    flow: 'Cash flow', netFlow: 'Net cash flow', statistics: 'View statistics',
    noFlow: 'No transactions in the last 90 days.', flowError: 'Could not update cash flow.',
    rates: 'Exchange rates', source: 'Official Bank of Russia rates', ratesError: 'Could not update exchange rates.',
    cachedRates: 'Showing saved rates.', effective: 'Effective from', change: 'Since the previous rate',
    history: '30-day history', rateDetails: 'Exact rate and history',
    rateUp: 'Above the previous rate', rateDown: 'Below the previous rate', rateUnchanged: 'Rate unchanged',
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

  if (isComaBank) {
    const stackCurrencies = (Math.min(width, styles.page.maxWidth) - 2 * styles.page.paddingHorizontal) / fontScale < 270 ||
      alternatives.some((currency) => amount(currency).length > 16);
    return <View style={layout.comabankBalance} testID="finance-dashboard-balances">
      <Text accessibilityRole="header" style={styles.section}>{financeCopy[lang].balances}</Text>
      <View style={styles.surface}>
        <View style={[layout.comabankCurrencyRow, layout.comabankMainRow]}>
          <Text style={layout.comabankCurrency}>{primary}</Text>
          <Text style={layout.comabankMainBalance} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}
            testID="finance-dashboard-main-balance">{amount(primary)}</Text>
        </View>
        <View style={!stackCurrencies && layout.comabankCurrencyPair}>
          {alternatives.map((currency, index) => <View key={currency} testID={'finance-dashboard-balance-' + currency}
            style={[layout.comabankCurrencyRow, layout.rowDivider, !stackCurrencies && layout.comabankCurrencyCell,
              !stackCurrencies && index > 0 && layout.comabankCurrencySplit]}>
            <Text style={layout.comabankCurrency}>{currency}</Text>
            <Text style={layout.comabankCurrencyValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65}>
              {amount(currency)}
            </Text>
          </View>)}
        </View>
      </View>
    </View>;
  }

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
  const { width, fontScale } = useWindowDimensions();
  const contentWidth = Math.min(width, styles.page.maxWidth) - 2 * styles.page.paddingHorizontal;
  const stack = isComaBank && contentWidth / fontScale < 290;
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
    onPress={onOpen} style={({ pressed }) => [layout.overviewAccount, isComaBank && layout.comabankAccount,
      divider && layout.rowDivider, pressed && layout.overviewAccountPressed]}>
    <View style={[layout.accountLine, stack && layout.accountLineStacked]}>
      <View style={[layout.accountIdentity, stack && layout.accountIdentityStacked]}>
        <FinanceIcon name={type === 'regular' ? 'wallet' : type} color={isComaBank ? palette.accent : palette.muted} size={18} />
        <Text style={styles.title}>{account.name}</Text>
      </View>
      <View style={[layout.accountValue, stack && layout.accountValueStacked]}>
        <Text style={[layout.accountAmount, isComaBank && layout.comabankAccountAmount]}>{amount}</Text>
        <FinanceIcon name="chevron" color={palette.muted} size={13} />
      </View>
    </View>
    {terms && <Text style={[styles.meta, layout.accountDetail]}>{terms}</Text>}
    {isComaBank && !terms && !preview?.cards.length && <Text style={[styles.meta, layout.accountDetail]}>
      {type === 'regular' ? t[type] + ' · ' : ''}{account.currency}
    </Text>}
    {account.needsReconciliation && <Text style={[styles.meta, layout.accountDetail]}>{t.needsReconciliation}</Text>}
    {isComaBank && !!preview?.cards.length && <View style={layout.linkedCards}>
      {preview.cards.map(({ cardId, appearance, lastFour, name }) => {
        const color = cardTextColor(appearance);
        return <View key={cardId} style={layout.cardMini}>
          <View style={[layout.cardMiniSwatch, { backgroundColor: appearance, borderColor: color + '5C' }]}>
            <View style={[layout.cardMiniMark, { backgroundColor: color + 'B3' }]} />
          </View>
          <Text style={layout.linkedCount} numberOfLines={1}>{lastFour ? '•• ' + lastFour : name}</Text>
        </View>;
      })}
      {preview.count > preview.cards.length && <Text style={layout.linkedCount}>+{preview.count - preview.cards.length}</Text>}
    </View>}
    {!isComaBank && preview && <View style={layout.linkedCards}>
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

function CardLink({ title, onPress, testID, style }: {
  title: string; onPress(): void; testID?: string; style?: StyleProp<ViewStyle>;
}) {
  return <Pressable accessibilityRole="button" testID={testID} onPress={onPress}
    style={({ pressed }) => [layout.link, style, pressed && styles.dimmed]}>
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
  const selection = {
    index: weekIndex,
    onSelect: (index: number) => setSelectedWeek(index === weekIndex ? undefined : weeks[index].fromDate),
  };

  const statisticsLink = report && <CardLink title={t.statistics} testID="finance-dashboard-statistics"
    style={isComaBank && layout.flowStatisticsLink}
    onPress={() => onStatistics({ fromDate: report.fromDate, throughDate: report.throughDate, currency })} />;
  const currencyControl = <View accessibilityRole="radiogroup" accessibilityLabel={s.currency}
    style={isComaBank ? layout.flowCurrencies : layout.currencyControl}>
    {currencies.map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: code === currency }}
      accessibilityLabel={isComaBank ? currencyName(code, lang) : undefined}
      onPress={() => {
        if (code !== currency) setSelectedWeek(undefined);
        setSelected(code);
      }} testID={'finance-dashboard-flow-' + code}
      style={({ pressed }) => [
        isComaBank ? layout.flowCurrency : layout.currencyOption,
        code === currency && (isComaBank ? layout.flowCurrencyActive : layout.selectedCurrency),
        pressed && styles.dimmed,
      ]}>
      <Text style={[isComaBank ? layout.flowCurrencyText : layout.currencyText, code === currency && layout.selectedCurrencyText]}>
        {isComaBank ? code : currencyName(code, lang)}
      </Text>
    </Pressable>)}
  </View>;
  const weekDetails = week && <View style={layout.weekDetails} testID="finance-dashboard-week-details" accessibilityLiveRegion="polite">
    <Text style={styles.groupTitle}>{formatFinancialDate(week.fromDate, lang)} – {formatFinancialDate(week.throughDate, lang)}</Text>
    {cashFlowSeries.map(({ field, label }) => <View key={field} style={layout.weekMetric}>
      <Text style={styles.meta}>{s[label]}</Text>
      <Text style={styles.title}>{formatMoney(week[field], currency, lang)}</Text>
    </View>)}
  </View>;
  const status = <ReadStatus read={read} lang={lang} message={t.flowError} />;

  if (isComaBank) {
    const net = total ? netCashFlow(total) : 0n;
    return <View style={layout.flowSection} testID="finance-dashboard-cash-flow">
      <View style={layout.flowSectionHeader}>
        <View style={layout.labels}>
          <Text accessibilityRole="header" style={styles.section}>{t.flow}</Text>
          <Text style={styles.meta}>{s.recent}</Text>
        </View>
        {currencyControl}
      </View>
      {report && (total ? <>
        <View style={layout.flowPanel}>
          <View style={layout.labels}>
            <Text style={styles.meta}>{t.netFlow}</Text>
            <Text style={layout.flowNetValue} testID="finance-dashboard-net-flow" adjustsFontSizeToFit
              numberOfLines={1} minimumFontScale={0.6}>
              {net > 0n ? '+' : ''}{formatMoney(String(net), currency, lang)}
            </Text>
          </View>
          {weeks.length > 0 && <NetCashFlowPlot weeks={weeks} currency={currency} lang={lang} selection={selection} />}
        </View>
        {cashFlowSeries.map(({ field, label }) => <View key={field} style={layout.flowTotal}>
          <View style={layout.flowTotalLabel}>
            <FinanceIcon name={field === 'incomeMinor' ? 'income' : 'expense'} size={16} color={palette.muted} />
            <Text style={styles.meta}>{s[label]}</Text>
          </View>
          <Text style={layout.flowTotalAmount}>{formatMoney(total[field], currency, lang)}</Text>
        </View>)}
        {weekDetails}
      </> : <Text style={[styles.meta, layout.flowPanel]}>{t.noFlow}</Text>)}
      {status}
      {statisticsLink}
    </View>;
  }

  return <Card title={t.flow} detail={s.recent} testID="finance-dashboard-cash-flow" action={statisticsLink}>
    {currencyControl}
    {report && (total ? <>
      <View style={layout.metrics}>
        {cashFlowSeries.map(({ field, label, color }) => <View key={field} style={layout.metric}>
          <View style={layout.legend}>
            <View style={[layout.swatch, { backgroundColor: color }]} />
            <Text style={styles.meta}>{s[label]}</Text>
          </View>
          <Text style={layout.metricValue}>{formatMoney(total[field], currency, lang)}</Text>
        </View>)}
      </View>
      {weeks.length > 0 && <WeeklyCashFlowPlot weeks={weeks} currency={currency} lang={lang} overview selection={selection} />}
      {weekDetails}
    </> : <Text style={styles.meta}>{t.noFlow}</Text>)}
    {status}
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

function rateChange({ current, previous }: Quote) {
  if (previous) return Number((Number(current.rate) - Number(previous.rate)).toFixed(4));
}

function RateQuoteDetails({ quote, lang, showName }: { quote: Quote | Pick<Quote, 'currency'>; lang: Language; showName?: boolean }) {
  const t = labels[lang];
  const locale = lang === 'ru' ? 'ru-RU' : 'en-GB';
  const precision = { minimumFractionDigits: 4, maximumFractionDigits: 4 };
  const number = new Intl.NumberFormat(locale, precision);
  const delta = new Intl.NumberFormat(locale, { ...precision, signDisplay: 'exceptZero' });
  const ruble = '\u00a0' + currencySymbol('RUB');
  const data = 'current' in quote ? quote : undefined;
  const change = data && rateChange(data);
  return <>
    <View style={layout.rateDetails}>
      {showName && <Text style={styles.title}>{currencyName(quote.currency, lang)}</Text>}
      <Text style={layout.metricValue}>{data
        ? '1\u00a0' + currencySymbol(quote.currency) + ' = ' + number.format(Number(data.current.rate)) + ruble : '—'}</Text>
      {data && <Text style={styles.meta}>{t.effective} {formatFinancialDate(data.current.date, lang)}</Text>}
      {change !== undefined && <Text style={styles.meta}>{t.change} {delta.format(change)}{ruble}</Text>}
    </View>
    {data && data.history.length > 1 && <View style={layout.trend}>
      <RateTrend history={data.history} />
      <Text style={layout.axis}>{t.history}</Text>
    </View>}
  </>;
}

function ComaBankExchangeRates({ read, lang }: RatesProps) {
  const t = labels[lang];
  const [expanded, setExpanded] = useState<Quote['currency']>();
  const { width, fontScale } = useWindowDimensions();
  const stack = (Math.min(width, styles.page.maxWidth) - 2 * styles.page.paddingHorizontal) / fontScale < 240;
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  const number = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: lang === 'ru' ? 'long' : 'short', timeZone: 'UTC',
  });
  const dateLabel = (day: string) => date.format(new Date(day + 'T00:00:00Z'));
  const rates = read.data?.rates ?? [];
  const firstDate = rates[0]?.current.date;
  const sharedDate = rates.every(({ current }) => current.date === firstDate) ? firstDate : undefined;

  return <View style={layout.comabankRates} testID="finance-dashboard-rates">
    <View style={layout.comabankRatesHeader}>
      <Text accessibilityRole="header" style={styles.section}>{t.rates}</Text>
      {sharedDate && <Text style={styles.meta}>{dateLabel(sharedDate)}</Text>}
    </View>
    <View>
      {rateCurrencies.map((currency) => {
        const quote = rates.find((item) => item.currency === currency);
        const name = currencyName(currency, lang);
        const currencyLabel = quote && !sharedDate ? currency + ' · ' + dateLabel(quote.current.date) : currency;
        const value = quote ? number.format(Number(quote.current.rate)) + '\u00a0' + currencySymbol('RUB') : '—';
        const change = quote && rateChange(quote);
        const direction = change === undefined ? undefined : change > 0 ? 'rateUp' : change < 0 ? 'rateDown' : 'rateUnchanged';
        const prefix = direction === 'rateUp' ? '↑\u00a0' : direction === 'rateDown' ? '↓\u00a0' : '';
        const open = !!quote && expanded === currency;
        return <View key={currency} style={layout.comabankRateDivider}>
          <Pressable accessibilityRole={quote ? 'button' : undefined}
            accessibilityState={quote ? { expanded: open } : undefined}
            accessibilityHint={quote ? t.rateDetails : undefined}
            accessibilityLabel={[name, currencyLabel, value, direction && t[direction]].filter(Boolean).join(', ')}
            testID={'finance-dashboard-rate-' + currency} disabled={!quote}
            onPress={() => setExpanded(open ? undefined : currency)}
            style={({ pressed }) => [layout.comabankRateRow, stack && layout.comabankRateStack, pressed && styles.dimmed]}>
            <View style={layout.comabankRateIdentity}>
              <Text style={styles.title}>{name}</Text>
              <View style={layout.comabankRateCode}>
                <Text style={styles.meta}>{currencyLabel}</Text>
                {quote && <FinanceIcon name={open ? 'chevron-down' : 'chevron'} color={palette.muted} size={12} />}
              </View>
            </View>
            <Text style={[layout.comabankRateValue, stack && layout.comabankRateValueStack, !quote && layout.missingRate,
              direction === 'rateUp' && layout.risingRate, direction === 'rateDown' && layout.fallingRate]}>
              {prefix + value}
            </Text>
          </Pressable>
          {open && <View style={layout.comabankRateDetails} testID={'finance-dashboard-rate-details-' + currency}>
            <RateQuoteDetails quote={quote} lang={lang} />
          </View>}
        </View>;
      })}
    </View>
    <Text style={styles.meta}>{t.source}</Text>
    <ReadStatus read={read} lang={lang} message={read.data ? t.cachedRates : t.ratesError} stale={read.data?.stale} />
  </View>;
}

export function ExchangeRatesCard({ read, lang }: RatesProps) {
  if (isComaBank) return <ComaBankExchangeRates read={read} lang={lang} />;
  const t = labels[lang];
  return <Card title={t.rates} detail={t.source} testID="finance-dashboard-rates">
    {(read.data?.rates ?? rateCurrencies.map((currency) => ({ currency }))).map((quote, index) =>
      <View key={quote.currency} style={[layout.rateRow, index > 0 && layout.rowDivider]}>
        <RateQuoteDetails quote={quote} lang={lang} showName />
      </View>)}
    <ReadStatus read={read} lang={lang} message={read.data ? t.cachedRates : t.ratesError} stale={read.data?.stale} />
  </Card>;
}

const layout = StyleSheet.create({
  comabankBalance: { gap: 10 },
  comabankCurrencyRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 8, paddingHorizontal: 14, paddingVertical: 9 },
  comabankMainRow: { paddingVertical: 12 },
  comabankCurrency: { color: palette.accent, fontSize: 12, fontWeight: '700' },
  comabankMainBalance: { ...styles.heroValue, fontSize: 34, fontWeight: '700', letterSpacing: -1, flexShrink: 1, textAlign: 'right' },
  comabankCurrencyPair: { flexDirection: 'row' },
  comabankCurrencyCell: { flex: 1 },
  comabankCurrencySplit: { borderLeftColor: palette.line, borderLeftWidth: StyleSheet.hairlineWidth },
  comabankCurrencyValue: { ...styles.value, fontSize: 16, textAlign: 'right' },
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
  comabankAccount: { paddingHorizontal: 0, gap: 2, minHeight: 55 },
  comabankAccountAmount: { fontSize: 15 },
  overviewAccountPressed: { backgroundColor: palette.raised },
  accountLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  accountLineStacked: { flexDirection: 'column', flexWrap: 'nowrap', alignItems: 'stretch', gap: 3 },
  accountIdentity: { flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexBasis: '45%', minWidth: 112, gap: 9 },
  accountIdentityStacked: { flexGrow: 0, flexBasis: 'auto', minWidth: 0 },
  accountValue: { marginLeft: 'auto', maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 7 },
  accountValueStacked: { marginLeft: 0, paddingLeft: 27, justifyContent: 'space-between' },
  accountAmount: { color: palette.ink, fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' },
  accountDetail: { marginLeft: 27 },
  linkedCards: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginLeft: 27, marginTop: 4 },
  cardMini: { flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: '100%', minWidth: 0, flexShrink: 1 },
  cardMiniSwatch: { width: 19, height: 12, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 3, paddingBottom: 2, justifyContent: 'flex-end' },
  cardMiniMark: { width: 6, height: 1 },
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
  flowSection: { gap: 12 },
  flowSectionHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    justifyContent: 'space-between', columnGap: 10, rowGap: 4 },
  flowCurrencies: { flexDirection: 'row', flexWrap: 'wrap' },
  flowCurrency: { minWidth: 44, minHeight: 44, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center',
    borderBottomWidth: 2, borderBottomColor: 'transparent' },
  flowCurrencyActive: { borderBottomColor: palette.accent },
  flowCurrencyText: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  flowPanel: { backgroundColor: palette.panel, borderRadius: 14, padding: 14, gap: 12 },
  flowNetValue: { ...styles.heroValue, fontSize: 32, fontWeight: '700', letterSpacing: -0.8 },
  flowTotal: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  flowTotalLabel: { flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '100%' },
  flowTotalAmount: { ...styles.value, textAlign: 'right', marginLeft: 'auto' },
  flowStatisticsLink: { alignSelf: 'stretch', justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
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
  comabankRates: { gap: 10 },
  comabankRatesHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline',
    justifyContent: 'space-between', columnGap: 10 },
  comabankRateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 64, gap: 12, paddingVertical: 10 },
  comabankRateStack: { flexDirection: 'column', alignItems: 'stretch', gap: 4 },
  comabankRateIdentity: { flexShrink: 1, gap: 3 },
  comabankRateCode: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  comabankRateValue: { ...styles.title, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'], textAlign: 'right' },
  comabankRateValueStack: { textAlign: 'left' },
  comabankRateDivider: { borderBottomColor: palette.line, borderBottomWidth: StyleSheet.hairlineWidth },
  comabankRateDetails: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingBottom: 12 },
  risingRate: { color: palette.positive },
  fallingRate: { color: palette.danger },
  missingRate: { color: palette.muted },
  rateRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 7 },
  rateDetails: { flexGrow: 1, gap: 3 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  trend: { width: sparkWidth, gap: 4 },
  spark: { width: sparkWidth, height: sparkHeight },
  sparkGuide: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.line },
  segment: { position: 'absolute', height: 2, borderRadius: 1, backgroundColor: palette.accent },
});
