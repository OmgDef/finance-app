import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import { isComaBank } from './app-variant';
import { addFinancialDays, formatChartAmount, formatFinancialDate, formatMoney } from './finance-format';
import type { Currency } from './finance-format';
import { statisticsCopy } from './finance-statistics-copy';
import { palette } from './finance-ui';

type Report = Result<'getStatistics'>;
type Week = Pick<Report, 'fromDate' | 'throughDate'> & { incomeMinor: string; expenseMinor: string };
type WeekSelection = { index?: number; onSelect(index: number): void };

export const cashFlowSeries = [
  { field: 'incomeMinor', label: 'income', color: palette.accent },
  { field: 'expenseMinor', label: 'expenses', color: isComaBank ? palette.muted : '#6D8198' },
] as const;

export function cashFlowWeeks(report: Report | undefined, currency: Currency): Week[] {
  if (!report?.weeks) return [];
  const byIndex = new Map(report.weeks.filter((week) => week.currency === currency).map((week) => [week.weekIndex, week]));
  const dayCount = (Date.parse(report.throughDate) - Date.parse(report.fromDate)) / 86_400_000 + 1;
  return Array.from({ length: Math.ceil(dayCount / 7) }, (_, weekIndex) => {
    const fromDate = addFinancialDays(report.fromDate, weekIndex * 7);
    const weekEnd = addFinancialDays(fromDate, 6);
    const bucket = byIndex.get(weekIndex);
    return { fromDate, throughDate: weekEnd > report.throughDate ? report.throughDate : weekEnd,
      incomeMinor: bucket?.incomeMinor ?? '0', expenseMinor: bucket?.expenseMinor ?? '0' };
  });
}

export function netCashFlow({ incomeMinor, expenseMinor }: Pick<Week, 'incomeMinor' | 'expenseMinor'>) {
  return BigInt(incomeMinor) - BigInt(expenseMinor);
}

function weekLabel(week: Week, currency: Currency, lang: Language) {
  const t = statisticsCopy[lang];
  const range = formatFinancialDate(week.fromDate, lang) + ' – ' + formatFinancialDate(week.throughDate, lang);
  const amounts = cashFlowSeries.map(({ field, label }) => t[label] + ' ' + formatMoney(week[field], currency, lang));
  return [range, ...amounts].join(', ');
}

const netPlotHeight = 104;
const netPlotInset = 8;
const millisecondsPerDay = 86_400_000;

function netTicks(values: number[]) {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  if (min === max) return [0];
  const idealStep = (max - min) / 3;
  const magnitude = 10 ** Math.floor(Math.log10(idealStep));
  const factor = [1, 2, 5, 10].find((value) => value * magnitude >= idealStep) ?? 10;
  const step = Math.max(1, factor * magnitude);
  const bottom = Math.floor(min / step);
  const top = Math.ceil(max / step);
  return Array.from({ length: top - bottom + 1 }, (_, index) => (top - index) * step);
}

export function NetCashFlowPlot({ weeks, currency, lang, selection }: {
  weeks: Week[]; currency: Currency; lang: Language; selection: WeekSelection;
}) {
  if (!weeks.length) return null;
  let cumulative = 0n;
  const values = weeks.map((week) => {
    cumulative += netCashFlow(week);
    return cumulative;
  });
  const ticks = netTicks(values.map(Number));
  const top = ticks[0];
  const range = top - ticks[ticks.length - 1];
  const y = (value: number | bigint) => range
    ? netPlotInset + (top - Number(value)) / range * (netPlotHeight - 2 * netPlotInset)
    : netPlotHeight / 2;
  const zeroY = y(0);
  const first = weeks[0].fromDate;
  const last = weeks[weeks.length - 1].throughDate;
  const duration = (Date.parse(last) - Date.parse(first)) / millisecondsPerDay;
  const dates = [...new Set([0, 1, 2, 3].map((index) => addFinancialDays(first, Math.round(duration * index / 3))))];
  const date = new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
  const runningTotal = lang === 'ru' ? 'Чистый поток с начала периода' : 'Net flow since period start';

  return <View style={layout.netFrame} testID="finance-dashboard-net-chart">
    <View style={[layout.netScale, ticks.length === 1 && layout.flatNetScale]}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {ticks.map((tick) => <Text key={tick} style={layout.netTick} maxFontSizeMultiplier={1.2}>
        {formatChartAmount(tick, lang)}
      </Text>)}
    </View>
    <View style={layout.chart}>
      <View style={layout.netPlot}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none"
          accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {ticks.map((tick) => <View key={tick} style={[layout.netGuide, tick === 0 && layout.netBaseline, { top: y(tick) }]} />)}
        </View>
        {weeks.map((week, index) => {
          // Apply each week's movement at the end of its date range.
          const value = values[index];
          const priorY = y(values[index - 1] ?? 0n);
          const currentY = y(value);
          const selected = selection.index === index;
          const days = (Date.parse(week.throughDate) - Date.parse(week.fromDate)) / millisecondsPerDay + 1;
          return <Pressable key={week.fromDate} accessibilityRole="button" accessibilityState={{ selected }}
            accessibilityLabel={weekLabel(week, currency, lang) + ', ' + runningTotal + ' ' + formatMoney(String(value), currency, lang)}
            style={({ pressed }) => [layout.netWeek, { flexGrow: days }, (pressed || selected) && layout.focusedNetWeek]}
            testID={'finance-dashboard-week-' + week.fromDate} onPress={() => selection.onSelect(index)}>
            <View style={StyleSheet.absoluteFill} pointerEvents="none"
              accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <View style={[layout.netFill, { top: Math.min(zeroY, priorY), height: Math.abs(zeroY - priorY) }]} />
              <View style={[layout.netStep, { top: priorY - 1 }]} />
              {priorY !== currentY && <View style={[layout.netRise, {
                top: Math.min(priorY, currentY) - 1, height: Math.abs(priorY - currentY) + 2,
              }]} />}
              {(selected || (index === weeks.length - 1 && (selection.index ?? -1) < 0)) &&
                <View style={[layout.netPoint, { top: currentY - 4 }]} />}
            </View>
          </Pressable>;
        })}
      </View>
      <View style={layout.netDates} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {dates.map((day) => <Text key={day} style={layout.netTick} maxFontSizeMultiplier={1.2}>
          {date.format(Date.parse(day))}
        </Text>)}
      </View>
    </View>
  </View>;
}

export function WeeklyCashFlowPlot({ weeks, currency, lang, selection, overview = false }: {
  weeks: Week[]; currency: Currency; lang: Language;
  selection: WeekSelection; overview?: boolean;
}) {
  const height = 60;
  const max = Math.max(0, ...weeks.flatMap((week) => cashFlowSeries.map(({ field }) => Number(week[field]))));
  const dates = overview && weeks.length ? [...new Set([0, 1, 2, 3].map((tick) => {
    const week = weeks[Math.round(tick * (weeks.length - 1) / 3)];
    return tick === 3 ? week.throughDate : week.fromDate;
  }))] : [];

  return <View style={layout.frame}>
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden
      style={[layout.scale, { height }, max === 0 && layout.zeroScale]}>
      {max > 0 && <Text maxFontSizeMultiplier={1.35} style={layout.tick}>{formatChartAmount(max, lang)}</Text>}
      {overview && max > 0 && <Text maxFontSizeMultiplier={1.35} style={layout.tick}>{formatChartAmount(max / 2, lang)}</Text>}
      <Text maxFontSizeMultiplier={1.35} style={layout.tick}>0</Text>
    </View>
    <View style={layout.chart}>
      <View style={layout.plot}>
        <View style={[layout.guides, { height }]} pointerEvents="none">
          {[0, 1, 2].map((line) => <View key={line} style={layout.guide} />)}
        </View>
        {weeks.map((week, index) => {
          const selected = selection.index === index;
          const fromDay = Number(week.fromDate.slice(8));
          const throughDay = Number(week.throughDate.slice(8));
          const days = fromDay === throughDay ? fromDay : `${fromDay}–${throughDay}`;
          return <Pressable key={week.fromDate} style={layout.week} accessibilityRole="button" accessibilityLabel={weekLabel(week, currency, lang)}
            accessibilityState={{ selected }} testID={(overview ? 'finance-dashboard-week-' : 'finance-account-week-') + week.fromDate}
            onPress={() => selection.onSelect(index)}>
            <View pointerEvents="none" style={[layout.bars, { height }, selected && layout.selected]}>
              {cashFlowSeries.map(({ field, color }) => {
                const proportion = max ? Number(week[field]) / max * height : 0;
                return <View key={field} style={[layout.bar, { backgroundColor: color,
                  height: overview && proportion > 0 ? Math.max(1, proportion) : proportion }]} />;
              })}
            </View>
            {!overview && <Text style={[layout.tick, layout.days, selected && layout.selectedDays]}
              maxFontSizeMultiplier={1.35}>{days}</Text>}
          </Pressable>;
        })}
      </View>
      {overview && <View style={layout.axis} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {dates.map((date) => <Text key={date} style={layout.tick} maxFontSizeMultiplier={1.35}>
          {formatFinancialDate(date, lang).slice(0, 5)}
        </Text>)}
      </View>}
    </View>
  </View>;
}

const layout = StyleSheet.create({
  netFrame: { flexDirection: 'row', gap: 9 },
  netScale: { height: netPlotHeight, justifyContent: 'space-between', alignItems: 'flex-end' },
  flatNetScale: { justifyContent: 'center' },
  netTick: { color: palette.muted, fontSize: 11, lineHeight: 16, fontVariant: ['tabular-nums'] },
  netPlot: { height: netPlotHeight, flexDirection: 'row' },
  netGuide: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.line },
  netBaseline: { backgroundColor: palette.control },
  netWeek: { flexBasis: 0 },
  focusedNetWeek: { backgroundColor: palette.accent + '18', zIndex: 1 },
  netFill: { position: 'absolute', left: 0, right: 0, backgroundColor: palette.accent + '22' },
  netStep: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: palette.accent },
  netRise: { position: 'absolute', right: 0, width: 2, backgroundColor: palette.accent },
  netPoint: { position: 'absolute', right: -3, width: 8, height: 8, borderRadius: 4,
    borderWidth: 1.5, borderColor: palette.panel, backgroundColor: palette.accent },
  netDates: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 4, marginTop: 4 },
  frame: { flexDirection: 'row', gap: 6 },
  scale: { justifyContent: 'space-between', alignItems: 'flex-end' },
  zeroScale: { justifyContent: 'flex-end' },
  chart: { flex: 1 },
  plot: { flexDirection: 'row' },
  guides: { position: 'absolute', top: 0, left: 0, right: 0, justifyContent: 'space-between' },
  guide: { height: StyleSheet.hairlineWidth, backgroundColor: palette.line },
  week: { flex: 1 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 4 },
  bar: { width: '23%', maxWidth: 23, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  tick: { color: palette.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  days: { textAlign: 'center', marginTop: 3 },
  selectedDays: { color: palette.accent, fontWeight: '600' },
  selected: { backgroundColor: palette.selected },
});
