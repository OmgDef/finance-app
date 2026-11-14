import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { apiErrorCode } from './finance-commands';
import type { FinanceAccess, TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import { addFinancialDays, formatFinancialDate, formatMoney } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { scheduleRangeDays } from './finance-schedule';
import type { ScheduleOccurrence } from './finance-schedule';
import { scheduleCopy } from './finance-schedule-copy';
import { FinanceAlert, FinanceButton, palette, styles } from './finance-ui';

type Snapshot = { today: string; timeZone: string } & ({ entries: ScheduleOccurrence[] } | { error: string });

export function PaymentsScreen({ access, lang, accountCount, categories, blocked, focused, refreshSignal, onRecord, onSchedule }: {
  access: FinanceAccess;
  lang: Language;
  accountCount: number;
  categories?: Result<'listCategories'>['categories'];
  blocked: boolean;
  focused: boolean;
  refreshSignal: number;
  onRecord: (kind: TransactionFields['type']) => void;
  onSchedule: (ruleId?: string) => void;
}) {
  const t = financeCopy[lang];
  const s = scheduleCopy[lang];
  const { today, timeZone } = access.profile;
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [retry, setRetry] = useState(0);
  const active = snapshot?.today === today && snapshot.timeZone === timeZone ? snapshot : undefined;

  useEffect(() => {
    if (!focused) return;
    let live = true;
    const query = new URLSearchParams({ fromDate: today, throughDate: addFinancialDays(today, scheduleRangeDays - 1) });
    void request('listScheduleOccurrences', { token: access.token, query })
      .then(({ occurrences }) => {
        if (!live || !access.isCurrent()) return;
        const entries = occurrences.filter(({ status }) => status !== 'posted' && status !== 'skipped' && status !== 'paused')
          .slice(0, 3);
        setSnapshot({ today, timeZone, entries });
      })
      .catch((error) => {
        if (!live || !access.isCurrent()) return;
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setSnapshot({ today, timeZone, error: code });
      });
    return () => { live = false; };
  }, [today, timeZone, focused, refreshSignal, retry, access.token]);

  const month = new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', timeZone: 'UTC' });
  const entries = active && 'entries' in active ? active.entries : undefined;

  return <>
    <View style={layout.section}>
      <Text accessibilityRole="header" style={styles.groupTitle}>{s.newEntry}</Text>
      <View style={styles.surface}>
        {([
          { kind: 'expense', title: t.expense, icon: 'expense' },
          { kind: 'income', title: t.income, icon: 'income' },
          { kind: 'transfer', title: t.newTransfer, icon: 'transfer' },
        ] as const).map(({ kind, title, icon }, index) => {
          const disabled = blocked || accountCount < (kind === 'transfer' ? 2 : 1);
          return <Pressable key={kind} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
            testID={'finance-' + kind} onPress={() => onRecord(kind)} style={({ pressed }) => [
              layout.action, index > 0 && layout.divider, pressed && layout.pressed, disabled && styles.dimmed,
            ]}>
            <FinanceIcon name={icon} color={index === 0 ? palette.accent : palette.muted} />
            <Text style={styles.title}>{title}</Text>
          </Pressable>;
        })}
      </View>
    </View>
    <View style={layout.section}>
      <Text accessibilityRole="header" style={styles.groupTitle}>{s.schedule}</Text>
      <View style={styles.surface}>
        {!active && <ActivityIndicator style={layout.message} color={palette.accent} accessibilityLabel={t.loading} />}
        {active && 'error' in active && <View style={layout.message}>
          <FinanceAlert>{copy[lang].errors[active.error] ?? t.error}</FinanceAlert>
          <FinanceButton title={s.reload} onPress={() => { setSnapshot(undefined); setRetry((value) => value + 1); }} />
        </View>}
        {entries?.length === 0 && <Text style={[styles.meta, layout.message]}>{s.noUpcoming}</Text>}
        {entries?.map((entry, index) => {
          const category = categories?.find(({ id }) => id === entry.categoryId);
          const title = category ? (lang === 'ru' ? category.nameRu : category.nameEn)
            : entry.kind === 'expense' ? t.expenseEntry : t.incomeEntry;
          const status = entry.recoveryHeld ? s.recoveryHeld : s[entry.status];
          const amount = formatMoney(entry.kind === 'expense' ? '-' + entry.amountMinor : entry.amountMinor, entry.currency, lang, true);
          return <Pressable key={entry.ruleId + ':' + entry.date} accessibilityRole="button"
            accessibilityLabel={[formatFinancialDate(entry.date, lang), title, status, amount].join(', ')}
            onPress={() => onSchedule(entry.ruleId)}
            style={({ pressed }) => [layout.entry, index > 0 && layout.divider, pressed && layout.pressed]}>
            <View style={layout.entryIdentity}>
              <View style={layout.date}>
                <Text style={layout.day}>{Number(entry.date.slice(-2))}</Text>
                <Text style={layout.month}>{month.format(new Date(entry.date + 'T00:00:00Z'))}</Text>
              </View>
              <View style={layout.labels}>
                <Text style={styles.title}>{title}</Text>
                <Text style={entry.status === 'needs_intervention' ? styles.alert : styles.meta}>{status}</Text>
              </View>
            </View>
            <Text style={[layout.amount, entry.kind === 'income' && layout.income]}>{amount}</Text>
          </Pressable>;
        })}
      </View>
      <View style={layout.scheduleLink}>
        <FinanceButton title={s.openSchedule} icon="chevron" onPress={() => onSchedule()} testID="finance-payments-schedule" />
      </View>
    </View>
  </>;
}

const layout = StyleSheet.create({
  section: { gap: 8 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 8, minHeight: 49 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  pressed: { backgroundColor: palette.ground },
  message: { padding: 12, gap: 8 },
  entry: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, minHeight: 60,
    paddingHorizontal: 12, paddingVertical: 8 },
  entryIdentity: { flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexBasis: '48%', minWidth: 120, gap: 10 },
  labels: { flex: 1, gap: 2 },
  date: { minWidth: 38, minHeight: 42, paddingHorizontal: 4, paddingVertical: 3, borderRadius: 6,
    backgroundColor: palette.raised, alignItems: 'center', justifyContent: 'center' },
  day: { color: palette.ink, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  month: { color: palette.muted, fontSize: 11 },
  amount: { color: palette.ink, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'],
    textAlign: 'right', marginLeft: 'auto', flexShrink: 1 },
  income: { color: palette.positive },
  scheduleLink: { alignItems: 'flex-start' },
});
