import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import { cashFlowSeries, cashFlowWeeks, WeeklyCashFlowPlot } from './finance-cash-flow';
import { financeCopy } from './finance-copy';
import { addFinancialDays, formatChartAmount, formatFinancialDate, formatMoney } from './finance-format';
import type { Currency } from './finance-format';
import { statisticsCopy } from './finance-statistics-copy';
import { palette, styles } from './finance-ui';

type BalanceSeries = Result<'getAccountBalanceSeries'>;
const millisecondsPerDay = 86_400_000;
const plotHeight = 68;
const stepHeight = 2;
const chartActions = [{ name: 'decrement' }, { name: 'increment' }];

export function AccountBalancePlot({ series, lang }: { series: BalanceSeries; lang: Language }) {
  const [date, setDate] = useState<string>();
  const [width, setWidth] = useState(0);
  const { points, currency } = series;
  const first = points[0];
  const last = points.at(-1)!;
  const days = (Date.parse(last.date) - Date.parse(first.date)) / millisecondsPerDay;
  const x = (day: string) => days ? (Date.parse(day) - Date.parse(first.date)) / millisecondsPerDay / days * 100 : 50;
  const [min, max] = useMemo(() => {
    const opening = BigInt(points[0].balanceMinor);
    return points.reduce(([low, high], { balanceMinor }) => {
      const balance = BigInt(balanceMinor);
      return [balance < low ? balance : low, balance > high ? balance : high];
    }, [opening, opening]);
  }, [points]);
  const y = (minor: string) => min === max ? plotHeight / 2 :
    4 + Number(max - BigInt(minor)) / Number(max - min) * (plotHeight - 8);
  const selectedDate = date && date >= first.date && date <= last.date ? date : undefined;
  const focusDate = selectedDate ?? last.date;
  const nextIndex = points.findIndex((point) => point.date > focusDate);
  const activeIndex = nextIndex === -1 ? points.length - 1 : nextIndex - 1;
  const point = points[activeIndex];
  const selectedAmount = formatMoney(point.balanceMinor, currency, lang);
  const preciseDate = formatFinancialDate(focusDate, lang);
  const ticks = days > 21 ? [first.date, addFinancialDays(first.date, Math.round(days / 2)), last.date]
    : days ? [first.date, last.date] : [first.date];
  const guides = min === max ? [plotHeight / 2] : [4, plotHeight / 2, plotHeight - 4];

  return <View style={layout.chart} testID="finance-account-balance-chart">
    <View style={layout.balanceFrame}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={[layout.scale, min === max && layout.flatScale]}>
        <Text style={layout.tick} maxFontSizeMultiplier={1.35}>{formatChartAmount(max, lang)}</Text>
        {min !== max && <Text style={layout.tick} maxFontSizeMultiplier={1.35}>{formatChartAmount(min, lang)}</Text>}
      </View>
      <View style={layout.balanceChart}>
        <Pressable accessibilityRole="adjustable" accessibilityLabel={financeCopy[lang].balanceTrend}
          accessibilityValue={{ text: preciseDate + ', ' + selectedAmount }} accessibilityActions={chartActions}
          testID="finance-account-balance-plot" onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
          onPress={({ nativeEvent }) => {
            if (!width) return;
            const day = Math.max(0, Math.min(days, Math.round(nativeEvent.locationX / width * days)));
            setDate(addFinancialDays(first.date, day));
          }}
          onAccessibilityAction={({ nativeEvent }) => {
            const index = nativeEvent.actionName === 'decrement' ? (point.date < focusDate ? activeIndex : activeIndex - 1)
              : activeIndex + 1;
            setDate(points[Math.max(0, Math.min(points.length - 1, index))].date);
          }} style={layout.balancePlot}>
          <View style={StyleSheet.absoluteFill} pointerEvents="none" importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden>
            {guides.map((top) => <View key={top} style={[layout.guide, { top }]} />)}
            {points.slice(1).map((current, index) => {
              const before = points[index];
              const left = x(before.date);
              const right = x(current.date);
              const beforeY = y(before.balanceMinor);
              const afterY = y(current.balanceMinor);
              return <View key={current.date} style={StyleSheet.absoluteFill}>
                <View style={[layout.horizontalStep, { left: `${left}%`, width: `${right - left}%`, top: beforeY - 1 }]} />
                {beforeY !== afterY && <View style={[layout.verticalStep, {
                  left: `${right}%`, top: Math.min(beforeY, afterY) - 1, height: Math.abs(beforeY - afterY) + stepHeight,
                }]} />}
              </View>;
            })}
            {!!selectedDate && <View style={[layout.cursor, { left: `${x(selectedDate)}%` }]} />}
            <View style={[layout.point, { left: `${x(focusDate)}%`, top: y(point.balanceMinor) }]} />
          </View>
        </Pressable>
        <View style={[layout.axis, !days && layout.centerAxis]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {ticks.map((tick) => <Text key={tick} maxFontSizeMultiplier={1.35} style={layout.tick}>
            {formatFinancialDate(tick, lang).slice(0, 5)}
          </Text>)}
        </View>
      </View>
    </View>
    {selectedDate && <View style={layout.readout} testID="finance-account-balance-day">
      <Text style={styles.meta}>{preciseDate}</Text>
      <Text style={layout.detailAmount}>{selectedAmount}</Text>
    </View>}
  </View>;
}

export function AccountMonthlyFlow({ report, currency, lang }: {
  report: Result<'getStatistics'>; currency: Currency; lang: Language;
}) {
  const [index, setIndex] = useState<number>();
  const weeks = cashFlowWeeks(report, currency);
  const week = index === undefined ? undefined : weeks[index];
  if (!weeks.length) return null;
  return <View style={layout.chart} testID="finance-account-monthly-flow">
    <WeeklyCashFlowPlot weeks={weeks} currency={currency} lang={lang} selection={{ index, onSelect: setIndex }} />
    {week ? <View style={layout.weekReadout} testID="finance-account-week-details" accessibilityLiveRegion="polite">
      {cashFlowSeries.map(({ field, label }) => <View key={field} style={layout.readout}>
        <Text style={styles.meta}>{statisticsCopy[lang][label]}</Text>
        <Text style={layout.detailAmount}>{formatMoney(week[field], currency, lang)}</Text>
      </View>)}
    </View> : weeks.every(({ incomeMinor, expenseMinor }) => incomeMinor === '0' && expenseMinor === '0') &&
      <Text style={styles.meta}>{financeCopy[lang].noMonthlyFlow}</Text>}
  </View>;
}

const layout = StyleSheet.create({
  chart: { gap: 5 },
  balanceFrame: { flexDirection: 'row', gap: 8 },
  scale: { height: plotHeight, alignItems: 'flex-end', justifyContent: 'space-between' },
  flatScale: { justifyContent: 'center' },
  balanceChart: { flex: 1, marginRight: 5 },
  balancePlot: { height: plotHeight },
  tick: { color: palette.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  axis: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 3 },
  centerAxis: { justifyContent: 'center' },
  guide: { position: 'absolute', height: StyleSheet.hairlineWidth, left: 0, right: 0, backgroundColor: palette.line },
  horizontalStep: { position: 'absolute', height: stepHeight, backgroundColor: palette.accent },
  verticalStep: { position: 'absolute', width: stepHeight, marginLeft: -1, backgroundColor: palette.accent },
  cursor: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: palette.control },
  point: { position: 'absolute', width: 7, height: 7, borderRadius: 4, marginTop: -3.5, marginLeft: -3.5,
    backgroundColor: palette.accent },
  readout: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', columnGap: 8 },
  weekReadout: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line, paddingTop: 5 },
  detailAmount: { ...styles.label, textAlign: 'right', fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
});
