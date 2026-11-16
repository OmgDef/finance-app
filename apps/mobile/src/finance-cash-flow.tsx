import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import { addFinancialDays, formatChartAmount, formatFinancialDate, formatMoney } from './finance-format';
import type { Currency } from './finance-format';
import { statisticsCopy } from './finance-statistics-copy';
import { palette } from './finance-ui';

type Report = Result<'getStatistics'>;
type Week = Pick<Report, 'fromDate' | 'throughDate'> & { incomeMinor: string; expenseMinor: string };

export const cashFlowSeries = [
  { field: 'incomeMinor', label: 'income', color: palette.accent },
  { field: 'expenseMinor', label: 'expenses', color: '#6D8198' },
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

export function WeeklyCashFlowPlot({ weeks, currency, lang, selection, overview = false }: {
  weeks: Week[]; currency: Currency; lang: Language;
  selection: { index?: number; onSelect(index: number): void }; overview?: boolean;
}) {
  const height = 60;
  const max = Math.max(0, ...weeks.flatMap((week) => cashFlowSeries.map(({ field }) => Number(week[field]))));
  const t = statisticsCopy[lang];
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
          const label = [formatFinancialDate(week.fromDate, lang) + ' – ' + formatFinancialDate(week.throughDate, lang),
            ...cashFlowSeries.map(({ field, label }) => t[label] + ' ' + formatMoney(week[field], currency, lang))].join(', ');
          const selected = selection.index === index;
          const fromDay = Number(week.fromDate.slice(8));
          const throughDay = Number(week.throughDate.slice(8));
          const days = fromDay === throughDay ? fromDay : `${fromDay}–${throughDay}`;
          return <Pressable key={week.fromDate} style={layout.week} accessibilityRole="button" accessibilityLabel={label}
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
