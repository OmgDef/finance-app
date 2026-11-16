import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Language, Result } from '@teta/contracts';
import { copy } from './copy';
import { CardNetworkLogo, cardNetworkLabel } from './finance-card-network';
import { financeCopy } from './finance-copy';
import { formatMoney } from './finance-format';
import { FinanceIcon } from './finance-icon';
import type { FinanceIconName } from './finance-icon';
import { cardTextColor, FinanceAlert, palette, styles } from './finance-ui';

type Card = Result<'listAccountCards'>['cards'][number];

export function CardDetails({ card, accountName, lang, loading, error, editDisabled, onClose, onOpenAccount, onEdit, onRetry }: {
  card?: Card;
  accountName?: string;
  lang: Language;
  loading: boolean;
  error?: string;
  editDisabled: boolean;
  onClose: () => void;
  onOpenAccount: () => void;
  onEdit: () => void;
  onRetry: () => void;
}) {
  const t = financeCopy[lang];
  const common = copy[lang];
  const foreground = card ? cardTextColor(card.appearance) : palette.panel;
  const balance = card && formatMoney(card.balanceMinor, card.currency, lang);

  return <SafeAreaView style={layout.screen}>
    <View style={layout.header}>
      <Pressable accessibilityRole="button" onPress={onClose} testID="finance-card-details-close"
        style={({ pressed }) => [layout.link, pressed && styles.dimmed]}>
        <Text style={layout.linkText}>{common.close}</Text>
      </Pressable>
    </View>
    <ScrollView contentContainerStyle={layout.content} contentInsetAdjustmentBehavior="never">
      {card && <>
        <View style={layout.cardFrame}>
          <View style={[layout.card, { backgroundColor: card.appearance }]} testID="finance-card-details">
            <Text accessibilityRole="header" style={[layout.cardName, { color: foreground }]}
              numberOfLines={2} maxFontSizeMultiplier={1.4}>{card.name}</Text>
            <View style={layout.cardMiddle}>
              <View style={layout.chip} accessible={false}>
                <View style={layout.chipSide}><View style={layout.chipDivider} /></View>
                <View style={layout.chipCenter} />
                <View style={layout.chipSide}><View style={layout.chipDivider} /></View>
              </View>
              <View style={layout.cardBalance} accessible accessibilityLabel={`${t.linkedAccountBalance}, ${balance}`}>
                <Text style={[layout.balanceLabel, { color: foreground }]} maxFontSizeMultiplier={1.3}>
                  {t.linkedAccountBalance}
                </Text>
                <Text style={[layout.balanceAmount, { color: foreground }]} numberOfLines={1}
                  maxFontSizeMultiplier={1.3} adjustsFontSizeToFit>{balance}</Text>
              </View>
            </View>
            <View style={layout.cardBottom}>
              {card.lastFour && <Text style={[layout.lastFour, { color: foreground }]} numberOfLines={1}
                maxFontSizeMultiplier={1.4}>{`•••• ${card.lastFour}`}</Text>}
              <CardNetworkLogo network={card.network} appearance={card.appearance} large
                style={layout.cardLogo} accessibilityLabel={cardNetworkLabel(card.network, lang)} />
            </View>
          </View>
        </View>
        <View style={layout.panel}>
          <Text accessibilityRole="header" style={layout.panelHeading}>{t.linkedAccount}</Text>
          <DetailAction title={accountName ?? t.account} icon="wallet" onPress={onOpenAccount}
            testID="finance-card-details-account" />
        </View>
        <View style={layout.panel}>
          <DetailAction title={t.editCard} icon="settings" onPress={onEdit} disabled={editDisabled} testID="finance-card-details-edit" />
        </View>
      </>}
      {!card && loading && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} style={layout.loading} />}
      {error && <View style={[layout.panel, layout.message]}>
        <FinanceAlert>{error}</FinanceAlert>
        <Pressable accessibilityRole="button" onPress={onRetry} testID="finance-card-details-reload"
          style={({ pressed }) => [layout.link, pressed && styles.dimmed]}>
          <Text style={layout.linkText}>{common.retry}</Text>
        </Pressable>
      </View>}
      {!card && !loading && !error && <View style={[layout.panel, layout.message]}>
        <Text style={styles.title}>{t.cardUnavailable}</Text>
      </View>}
    </ScrollView>
  </SafeAreaView>;
}

function DetailAction({ title, icon, onPress, disabled, testID }: {
  title: string;
  icon: FinanceIconName;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    onPress={onPress} testID={testID} style={({ pressed }) => [layout.row, (pressed || disabled) && styles.dimmed]}>
    <FinanceIcon name={icon} color={palette.accent} size={21} />
    <View style={layout.rowIdentity}>
      <Text style={styles.title}>{title}</Text>
    </View>
    <FinanceIcon name="chevron" color={palette.muted} size={14} />
  </Pressable>;
}

const layout = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.ground },
  header: { width: '100%', maxWidth: styles.page.maxWidth, alignSelf: 'center', paddingHorizontal: styles.page.paddingHorizontal },
  link: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  linkText: { color: palette.accent, fontSize: 16, fontWeight: '600' },
  content: { ...styles.page, paddingTop: 10 },
  cardFrame: { width: '100%', maxWidth: 336, alignSelf: 'center' },
  card: { width: '100%', aspectRatio: 1.586, borderRadius: 16, padding: 18,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(23,38,58,0.18)', justifyContent: 'space-between', gap: 8 },
  cardName: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
  cardMiddle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardBalance: { flex: 1, gap: 2 },
  balanceLabel: { fontSize: 12, fontWeight: '500', textAlign: 'right' },
  balanceAmount: { ...styles.heroValue, fontSize: 26, letterSpacing: -0.5, textAlign: 'right' },
  chip: { width: 42, height: 31, borderRadius: 7, overflow: 'hidden', flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#D4C099', borderWidth: 1, borderColor: '#867550' },
  chipSide: { flex: 1, justifyContent: 'center' },
  chipDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#867550' },
  chipCenter: { width: 15, height: 17, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: '#867550' },
  cardBottom: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 10 },
  lastFour: { fontSize: 19, fontWeight: '600', fontVariant: ['tabular-nums'], letterSpacing: 1.6, flexShrink: 1 },
  cardLogo: { marginLeft: 'auto' },
  panel: { ...styles.surface, paddingHorizontal: 14 },
  panelHeading: { ...styles.section, paddingTop: 14 },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11 },
  rowIdentity: { flex: 1, gap: 2 },
  message: { paddingVertical: 12 },
  loading: { marginTop: 26 },
});
