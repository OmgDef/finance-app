import { StyleSheet, Text, View } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import { CardNetworkLogo, cardNetworkLabel } from './finance-card-network';
import { financeCopy } from './finance-copy';
import { cardTextColor, styles } from './finance-ui';

type Card = Result<'listAccountCards'>['cards'][number];

export function ComaBankCard({ card, lang, balance, testID }: {
  card: Card; lang: Language; balance?: string; testID?: string;
}) {
  const { name, appearance, lastFour, network } = card;
  const full = balance !== undefined;
  const foreground = cardTextColor(appearance);
  const balanceLabel = financeCopy[lang].linkedAccountBalance;
  return <View testID={testID} style={[layout.card, full && layout.full,
    { backgroundColor: appearance, borderColor: foreground + '33' }]}>
    <View pointerEvents="none" style={[layout.highlight, { backgroundColor: foreground + '0F' }]} />
    <Text style={[layout.name, full && layout.fullName, { color: foreground }]} numberOfLines={2}
      maxFontSizeMultiplier={1.5}>{name}</Text>
    <View style={layout.middle}>
      <View accessible={false} style={[layout.chip, full && layout.fullChip]}>
        <View style={layout.chipCore} />
      </View>
      {full && <View style={layout.balance} accessible accessibilityLabel={balanceLabel + ', ' + balance}>
        <Text style={[layout.balanceLabel, { color: foreground }]} maxFontSizeMultiplier={1.4}>{balanceLabel}</Text>
        <Text style={[layout.balanceAmount, { color: foreground }]} maxFontSizeMultiplier={1.4} numberOfLines={1}
          adjustsFontSizeToFit>{balance}</Text>
      </View>}
    </View>
    <View style={layout.bottom}>
      {lastFour && <Text style={[layout.digits, full && layout.fullDigits, { color: foreground }]} numberOfLines={1}
        maxFontSizeMultiplier={1.5} adjustsFontSizeToFit>{'•••• ' + lastFour}</Text>}
      <CardNetworkLogo network={network} appearance={appearance} large={full} style={layout.network}
        accessibilityLabel={full ? cardNetworkLabel(network, lang) : undefined} />
    </View>
  </View>;
}

const layout = StyleSheet.create({
  card: { width: '100%', aspectRatio: 1.5, minHeight: 114, overflow: 'hidden', borderRadius: 12, borderWidth: 1,
    justifyContent: 'space-between', padding: 10, gap: 4 },
  full: { aspectRatio: 1.6, minHeight: 175, borderRadius: 16, padding: 16, gap: 7 },
  highlight: { position: 'absolute', top: 0, bottom: 0, right: '-38%', width: '70%', transform: [{ skewX: '-40deg' }] },
  name: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  fullName: { fontSize: 16 },
  middle: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 17 },
  chip: { width: 22, height: 16, borderRadius: 4, backgroundColor: '#D5BC83', borderWidth: 1, borderColor: '#937448',
    alignItems: 'center', justifyContent: 'center' },
  fullChip: { width: 38, height: 28, borderRadius: 6 },
  chipCore: { width: '47%', height: '59%', borderRadius: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: '#937448' },
  balance: { flex: 1, gap: 2 },
  balanceLabel: { fontSize: 11, fontWeight: '500', textAlign: 'right' },
  balanceAmount: { ...styles.value, fontSize: 24, textAlign: 'right' },
  bottom: { minHeight: 20, flexDirection: 'row', alignItems: 'center', gap: 4 },
  digits: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
  fullDigits: { fontSize: 17, letterSpacing: 0.6 },
  network: { marginLeft: 'auto' },
});
