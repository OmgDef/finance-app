import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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

const expenseShortcuts = [
  { categoryId: 'mobile-phone', title: 'phoneTopUp', icon: 'phone' },
  { categoryId: 'housing', title: 'utilities', icon: 'utilities' },
  { categoryId: 'transport', title: 'transport', icon: 'transport' },
  { categoryId: 'groceries', title: 'groceries', icon: 'groceries' },
  { categoryId: 'dining', title: 'dining', icon: 'dining' },
  { categoryId: 'shopping', title: 'shopping', icon: 'shopping' },
  { categoryId: 'health', title: 'health', icon: 'health' },
  { categoryId: 'entertainment', title: 'entertainment', icon: 'entertainment' },
  { categoryId: 'travel', title: 'travel', icon: 'travel' },
] as const;

const featuredCategories = ['groceries', 'transport', 'dining', 'shopping'];

function categoryRank(id: string) {
  if (featuredCategories.includes(id)) return 0;
  return id === 'other-expense' ? 2 : 1;
}

export function PaymentsScreen({ access, lang, accountCount, categories, blocked, focused, refreshSignal, onRecord, onSchedule }: {
  access: FinanceAccess;
  lang: Language;
  accountCount: number;
  categories?: Result<'listCategories'>['categories'];
  blocked: boolean;
  focused: boolean;
  refreshSignal: number;
  onRecord: (kind: TransactionFields['type'], categoryId?: string) => void;
  onSchedule: (ruleId?: string) => void;
}) {
  const t = financeCopy[lang];
  const s = scheduleCopy[lang];
  const { width, fontScale } = useWindowDimensions();
  const contentWidth = Math.min(width, styles.page.maxWidth) - styles.page.paddingHorizontal * 2;
  const stack = contentWidth / fontScale < 260;
  const expenseCategories = (categories ?? []).filter(({ type }) => type === 'expense')
    .sort((left, right) => categoryRank(left.id) - categoryRank(right.id));
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
          .slice(0, 1);
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

  const shortcutsDisabled = blocked || accountCount < 1;

  return <View style={layout.page}>
    <Text accessibilityRole="header" style={styles.heading}>{s.payments}</Text>
    <View style={layout.section}>
      <View style={[styles.surface, layout.actions, !stack && layout.actionsHorizontal]}>
        {([
          { kind: 'expense', title: t.expenseEntry, label: t.expense, icon: 'expense' },
          { kind: 'income', title: t.incomeEntry, label: t.income, icon: 'income' },
          { kind: 'transfer', title: t.transfer, label: t.newTransfer, icon: 'transfer' },
        ] as const).map(({ kind, title, label, icon }, index) => {
          const disabled = blocked || accountCount < (kind === 'transfer' ? 2 : 1);
          return <Pressable key={kind} accessibilityRole="button" accessibilityLabel={label}
            accessibilityState={{ disabled }} disabled={disabled}
            testID={'finance-' + kind} onPress={() => onRecord(kind)} style={({ pressed }) => [
              layout.action, !stack && layout.actionTile, index === 0 && layout.primaryAction,
              index > 0 && (stack ? layout.divider : layout.actionDivider), pressed && layout.pressed, disabled && styles.dimmed,
            ]}>
            <FinanceIcon name={icon} color={index === 0 ? palette.accent : palette.ink} />
            <Text style={styles.title}>{title}</Text>
          </Pressable>;
        })}
      </View>
    </View>
    <View style={layout.section}>
      <View style={layout.sectionHeader}>
        <Text accessibilityRole="header" style={styles.section}>{s.schedule}</Text>
        <Pressable accessibilityRole="button" onPress={() => onSchedule()} testID="finance-payments-schedule"
          style={({ pressed }) => [layout.link, pressed && styles.dimmed]}>
          <Text style={layout.linkText}>{s.openSchedule}</Text>
          <FinanceIcon name="chevron" color={palette.accent} size={14} />
        </Pressable>
      </View>
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
          const source = entry.source ?? entry.incomeSource;
          const primary = source ?? title;
          const secondary = source ? `${title} · ${status}` : status;
          const amount = formatMoney(entry.kind === 'expense' ? '-' + entry.amountMinor : entry.amountMinor, entry.currency, lang, true);
          return <Pressable key={entry.ruleId + ':' + entry.date} accessibilityRole="button"
            accessibilityLabel={[formatFinancialDate(entry.date, lang), primary, secondary, amount].join(', ')}
            onPress={() => onSchedule(entry.ruleId)}
            style={({ pressed }) => [layout.entry, index > 0 && layout.divider, pressed && layout.pressed]}>
            <View style={layout.entryIdentity}>
              <View style={layout.date}>
                <Text style={layout.day}>{Number(entry.date.slice(-2))}</Text>
                <Text style={layout.month}>{month.format(new Date(entry.date + 'T00:00:00Z'))}</Text>
              </View>
              <View style={layout.labels}>
                <Text style={styles.title}>{primary}</Text>
                <Text style={entry.status === 'needs_intervention' ? styles.alert : styles.meta}>{secondary}</Text>
              </View>
            </View>
            <Text style={[layout.amount, entry.kind === 'income' && layout.income]}>{amount}</Text>
          </Pressable>;
        })}
      </View>
    </View>
    {expenseCategories.length > 0 && <View style={layout.categorySection}>
      <Text accessibilityRole="header" style={styles.section}>{t.quickExpenses}</Text>
      <View style={[layout.shortcuts, !stack && layout.shortcutsGrid]}>
        {expenseCategories.map(({ id, nameRu, nameEn }) => {
          const shortcut = expenseShortcuts.find(({ categoryId }) => categoryId === id);
          const title = shortcut ? t[shortcut.title] : lang === 'ru' ? nameRu : nameEn;
          return <Pressable key={id} accessibilityRole="button" accessibilityState={{ disabled: shortcutsDisabled }}
            disabled={shortcutsDisabled} testID={'finance-quick-expense-' + id} onPress={() => onRecord('expense', id)}
            style={({ pressed }) => [styles.surface, layout.shortcut, !stack && layout.shortcutTile,
              pressed && layout.pressed, shortcutsDisabled && styles.dimmed]}>
            <FinanceIcon name={shortcut?.icon ?? 'expense'} color={palette.muted} size={19} />
            <Text style={styles.title}>{title}</Text>
          </Pressable>;
        })}
      </View>
    </View>}
  </View>;
}

const layout = StyleSheet.create({
  page: { gap: 20 },
  section: { gap: 4 },
  sectionHeader: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, flexShrink: 1 },
  linkText: { color: palette.accent, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  categorySection: { gap: 10 },
  shortcuts: { gap: 8 },
  shortcutsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  shortcut: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10,
    minHeight: 48, paddingHorizontal: 12, paddingVertical: 9 },
  shortcutTile: { flexBasis: '46%', flexGrow: 1 },
  actions: { overflow: 'hidden' },
  actionsHorizontal: { flexDirection: 'row' },
  action: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12, paddingVertical: 12, minHeight: 49 },
  actionTile: { flex: 1, flexDirection: 'column', justifyContent: 'center', minHeight: 75 },
  primaryAction: { backgroundColor: palette.selected },
  actionDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: palette.line },
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
});
