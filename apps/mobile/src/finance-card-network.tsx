import { Image, StyleSheet } from 'react-native';
import type { ImageProps, ImageSourcePropType } from 'react-native';
import type { CardNetwork, Language } from '@teta/contracts';
import { isComaBank } from './app-variant';
import { financeCopy } from './finance-copy';
import { cardTextColor } from './finance-ui';

const networks = {
  visa: { label: 'Visa', logo: require('../assets/card-networks/visa.png') },
  mastercard: { label: 'Mastercard', logo: require('../assets/card-networks/mastercard.png') },
  mir: { label: 'Мир', logo: require('../assets/card-networks/mir.png') },
  unionpay: { label: 'UnionPay', logo: require('../assets/card-networks/unionpay.png') },
} satisfies Record<CardNetwork, { label: string; logo: ImageSourcePropType }>;

export function cardNetworkLabel(network: CardNetwork | null | undefined, lang: Language) {
  if (!network) return financeCopy[lang].cardNetworkUnspecified;
  return network === 'mir' && lang === 'en' ? 'Mir' : networks[network].label;
}

export function CardNetworkLogo({ network, appearance, large, accessibilityLabel, style }: {
  network?: CardNetwork | null; appearance?: string; large?: boolean; accessibilityLabel?: string; style?: ImageProps['style'];
}) {
  if (!network) return null;
  const tintColor = appearance && (network === 'visa' || (isComaBank && network === 'mir'))
    ? cardTextColor(appearance) : undefined;
  return <Image source={networks[network].logo} resizeMode="contain" style={[layout.logo, large && layout.large, style, { tintColor }]}
    accessible={!!accessibilityLabel} accessibilityRole={accessibilityLabel ? 'image' : undefined}
    accessibilityLabel={accessibilityLabel} />;
}

const layout = StyleSheet.create({
  logo: { width: 34, height: 20 },
  large: { width: 54, height: 32 },
});
