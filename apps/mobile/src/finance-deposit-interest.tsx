import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Body, Language, Result } from '@teta/contracts';
import { formatFinancialDate, formatMoney } from './finance-format';
import { Choice, FinanceAlert, FinanceButton, palette, styles } from './finance-ui';

type Preview = Result<'previewDepositInterest'>;
type Decision = NonNullable<Body<'applyDepositInterest'>['decision']>;
type Option = { id: string; label: string; decision: Decision };

export const depositInterestCopy = {
  en: {
    title: 'Deposit interest', ready: 'Interest periods to review', next: 'Next interest date',
    complete: 'All periods through maturity are settled.', calculated: 'Calculated', recorded: 'Recorded', add: 'To add',
    automatic: 'Added automatically', projected: 'Balance after applying', saved: 'Interest periods settled',
    apply: 'Apply interest', applyReady: 'Apply ready periods', review: 'How was this period’s interest recorded?',
    post: 'Add the calculated amount as separate income', useIncome: 'Use income', useReconciliation: 'Included in reconciliation',
    editIncome: 'Edit recorded income', schedule: 'Open schedule rule',
    competing: 'End the separate interest rule to continue with capitalization.',
    pending: 'A scheduled entry must be settled before this interest can be calculated.',
    outOfRange: 'The calculated amount exceeds the supported limit for one entry.',
    loadError: 'Could not load deposit interest.', reload: 'Reload interest',
    changed: 'The deposit changed. Reload the calculation and check the amounts.',
  },
  ru: {
    title: 'Проценты по вкладу', ready: 'Есть периоды для проверки', next: 'Следующее начисление',
    complete: 'Все периоды до окончания вклада обработаны.', calculated: 'Расчёт', recorded: 'Учтено', add: 'К зачислению',
    automatic: 'Начислено автоматически', projected: 'Остаток после применения', saved: 'Начисления обработаны',
    apply: 'Применить начисления', applyReady: 'Применить готовые периоды', review: 'Как учтены проценты за этот период?',
    post: 'Добавить расчётную сумму отдельным доходом', useIncome: 'Учесть доход', useReconciliation: 'Уже в сверке',
    editIncome: 'Исправить записанный доход', schedule: 'Открыть правило графика',
    competing: 'Завершите отдельное правило начисления процентов, чтобы продолжить капитализацию.',
    pending: 'Расчёт станет доступен, когда операция из графика будет обработана.',
    outOfRange: 'Расчётная сумма превышает допустимый размер одной операции.',
    loadError: 'Не удалось загрузить проценты по вкладу.', reload: 'Обновить расчёт',
    changed: 'Данные вклада изменились. Обновите расчёт и проверьте суммы.',
  },
} as const;

export function depositInterestSummary(preview: Preview, lang: Language) {
  const t = depositInterestCopy[lang];
  if (preview.periods.length || preview.blockedBy) return t.ready;
  return preview.nextDate ? t.next + ' · ' + formatFinancialDate(preview.nextDate, lang) : t.complete;
}

export function DepositInterest({ preview, lang, disabled, onApply, onEditIncome, onSchedule }: {
  preview: Preview; lang: Language; disabled: boolean;
  onApply: (decision?: Decision) => void;
  onEditIncome: (transactionId: string) => void;
  onSchedule: (ruleId: string) => void;
}) {
  const t = depositInterestCopy[lang];
  const [selected, setSelected] = useState('');
  const { periods, blockedBy } = preview;
  const last = periods.at(-1);
  const review = last?.status === 'review' ? last : undefined;
  const money = (value: string, signed = false) => formatMoney(value, preview.currency, lang, signed);
  const date = (value: string) => formatFinancialDate(value, lang);

  const options: Option[] = [];
  if (review?.canPost) options.push({ id: 'post', label: t.post, decision: { action: 'post' } });
  for (const entry of review?.transactions ?? []) {
    options.push({ id: entry.transactionId, label: [t.useIncome, date(entry.date), money(entry.amountMinor)].join(' · '),
      decision: { action: 'useTransaction', transactionId: entry.transactionId } });
  }
  for (const entry of review?.adjustments ?? []) {
    options.push({ id: entry.adjustmentId, label: [t.useReconciliation, date(entry.date), money(entry.actualBalanceMinor)].join(' · '),
      decision: { action: 'useAdjustment', adjustmentId: entry.adjustmentId } });
  }
  const decision = options.find((option) => option.id === selected)?.decision;
  const transactionId = decision?.action === 'useTransaction' ? decision.transactionId : undefined;
  const ready = review ? periods.length - 1 : periods.length;
  const added = periods.reduce((total, period) => total + BigInt(period.changeMinor ?? '0'), 0n);
  const projected = BigInt(preview.balanceMinor) + added +
    (review && decision?.action === 'post' ? BigInt(review.calculatedMinor) : 0n);

  return <View style={layout.content}>
    {periods.length === 0 && !blockedBy && <Text style={styles.title}>{depositInterestSummary(preview, lang)}</Text>}
    {periods.length > 0 && <>
      <View style={layout.balance}>
        <Text style={styles.meta}>{t.projected}</Text>
        <Text style={layout.projected} testID="deposit-interest-projected">{money(projected.toString())}</Text>
      </View>
      <View style={styles.surface}>
        {periods.map((period, index) => <View key={period.date}
          style={[layout.period, index > 0 && layout.divider]} testID={'deposit-interest-' + period.date}>
          <View style={layout.line}>
            <Text style={styles.title}>{date(period.date)}</Text>
            <Text style={layout.figure} accessibilityLabel={t.calculated + ' ' + money(period.calculatedMinor)}>
              {money(period.calculatedMinor)}
            </Text>
          </View>
          <Text style={styles.meta}>{date(period.fromDate)} – {date(period.date)}</Text>
          <View style={layout.line}>
            <Text style={styles.meta}>{t.recorded} · {period.recordedMinor === null ? '—' : money(period.recordedMinor)}</Text>
            <Text style={styles.meta}>{t.add} · {period.changeMinor === null ? '—' : money(period.changeMinor, true)}</Text>
          </View>
        </View>)}
      </View>
    </>}
    {blockedBy && <>
      <FinanceAlert>{t[blockedBy.reason]}</FinanceAlert>
      <FinanceButton title={t.schedule} disabled={disabled} onPress={() => onSchedule(blockedBy.ruleId)} />
    </>}
    {review && <>
      {options.length > 0 && <Choice title={t.review} value={selected} options={options} onChange={setSelected}
        disabled={disabled} testID="deposit-interest-decision" />}
      {!review.canPost && <FinanceAlert>{t.outOfRange}</FinanceAlert>}
      {transactionId && <FinanceButton title={t.editIncome} disabled={disabled}
        onPress={() => onEditIncome(transactionId)} />}
    </>}
    {(ready > 0 || options.length > 0) && <FinanceButton primary
      title={review && !decision && ready > 0 ? t.applyReady : t.apply}
      disabled={disabled || (ready === 0 && !decision)} testID="deposit-interest-apply"
      onPress={() => onApply(decision)} />}
  </View>;
}

const layout = StyleSheet.create({
  content: { gap: 16 },
  balance: { gap: 4 },
  projected: { color: palette.ink, fontSize: 28, fontWeight: '600', fontVariant: ['tabular-nums'] },
  period: { gap: 4, padding: 14 },
  line: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 },
  figure: { color: palette.ink, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
});
