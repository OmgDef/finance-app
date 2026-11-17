import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import type { TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import { FinanceIcon } from './finance-icon';
import { scheduleCopy } from './finance-schedule-copy';
import { palette, styles } from './finance-ui';

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

export function PaymentsScreen({ lang, accountCount, categories, blocked, onRecord }: {
  lang: Language;
  accountCount: number;
  categories?: Result<'listCategories'>['categories'];
  blocked: boolean;
  onRecord: (kind: TransactionFields['type'], categoryId?: string) => void;
}) {
  const t = financeCopy[lang];
  const s = scheduleCopy[lang];
  const { width, fontScale } = useWindowDimensions();
  const contentWidth = Math.min(width, styles.page.maxWidth) - styles.page.paddingHorizontal * 2;
  const stack = contentWidth / fontScale < 260;
  const expenseCategories = (categories ?? []).filter(({ type }) => type === 'expense')
    .sort((left, right) => categoryRank(left.id) - categoryRank(right.id));

  const shortcutsDisabled = blocked || accountCount < 1;

  return <View style={layout.page}>
    <Text accessibilityRole="header" style={styles.heading}>{s.payments}</Text>
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
});
