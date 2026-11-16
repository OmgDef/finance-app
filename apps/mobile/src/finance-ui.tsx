import type { ComponentProps, ReactNode } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps, TextProps } from 'react-native';
import { KeyboardAwareScrollView, KeyboardController } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView as NativeTabsSafeAreaView } from 'react-native-screens/experimental';
import { currencySymbol } from '@teta/contracts/money';
import type { Currency } from '@teta/contracts/money';
import { appBrand, appVariant } from './app-variant';
import { FinanceIcon } from './finance-icon';
import type { FinanceIconName } from './finance-icon';

const isWallet = appVariant === 'b';

export const palette = isWallet ? {
  ground: '#F6F2E9', panel: '#FFFFFF', raised: '#EFEFE5', ink: '#20362E', muted: '#52645B',
  line: '#DFE3D8', control: '#75887E', danger: '#A12F3A', accent: appBrand.brandColor, selected: '#E1EFE6',
  positive: '#286648', balanceSurface: '#23483B', balanceMuted: '#C6DACD',
} : {
  ground: '#F5F7FA', panel: '#FFFFFF', raised: '#EDF1F6', ink: '#17263A', muted: '#53647A',
  line: '#E2E8F0', control: '#8594A7', danger: '#AD343E', accent: appBrand.brandColor, selected: '#E9F1FF',
  positive: '#226349',
  balanceSurface: '#191F29', balanceMuted: '#C0CAD8',
};

export function transactionAmountColor(amountMinor: string) {
  if (amountMinor === '0') return palette.ink;
  return amountMinor.startsWith('-') ? palette.danger : palette.positive;
}

export function cardTextColor(color: string) {
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.179 ? '#000000' : palette.panel;
}

export function FinanceScrollView({ children, nativeTab, ...props }: ComponentProps<typeof KeyboardAwareScrollView> & {
  nativeTab?: boolean;
}) {
  const { bottom } = useSafeAreaInsets();
  // Android's native tab bar is measured by react-native-screens.
  const useNativeTabInset = nativeTab && Platform.OS === 'android';
  return <KeyboardAwareScrollView {...props} contentInsetAdjustmentBehavior="never"
    contentContainerStyle={useNativeTabInset ? undefined : [styles.page, { paddingBottom: styles.page.paddingBottom + bottom }]}>
    {useNativeTabInset ? <NativeTabsSafeAreaView edges={{ bottom: true }} insetType="all" style={styles.page}>
      {children}
    </NativeTabsSafeAreaView> : children}
  </KeyboardAwareScrollView>;
}

export function FinanceMark({ size = 29 }: { size?: number }) {
  const source = isWallet ? require('../assets/app-icon/wallet/splash-logo.png') : require('../assets/theta.png');
  return <Image source={source} style={[isWallet ? styles.walletMark : styles.brandMark, { width: size, height: size }]} accessible={false}
    importantForAccessibility="no" />;
}

export function FinanceBrand({ title }: { title: string }) {
  return <View style={styles.brand}>
    <FinanceMark />
    <Text style={styles.brandTitle}>{title}</Text>
  </View>;
}

export function FinanceButton({ title, onPress, primary, destructive, disabled, testID, icon }: {
  title: string; onPress: () => void; primary?: boolean; destructive?: boolean; disabled?: boolean; testID?: string; icon?: FinanceIconName;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    testID={testID} onPress={onPress} style={({ pressed }) => [
      styles.button, primary && styles.primary, (disabled || pressed) && styles.dimmed,
    ]}>
    {icon && <FinanceIcon name={icon} color={primary ? palette.panel : palette.accent} size={16} />}
    <Text style={[styles.buttonText, primary && styles.primaryText, destructive && styles.alert]}>{title}</Text>
  </Pressable>;
}

export function FinanceField({ title, hint, currency, ...input }: TextInputProps & { title: string; hint?: string; currency?: Currency }) {
  const unit = currency && currencySymbol(currency);
  const field = <TextInput {...input} returnKeyType={input.multiline ? undefined : 'done'}
    onSubmitEditing={input.multiline ? undefined : () => void KeyboardController.dismiss()}
    autoCorrect={input.keyboardType ? false : undefined} spellCheck={input.keyboardType ? false : undefined}
    accessibilityLabel={unit ? `${title} (${unit})` : title}
    placeholder={input.placeholder ?? (unit ? '0' : undefined)} placeholderTextColor={palette.muted}
    style={unit ? styles.currencyInput : styles.input} selectionColor={palette.accent} />;
  return <View style={styles.field}>
    <Text style={styles.label}>{title}</Text>
    {unit ? <View style={styles.currencyField}>
      {field}
      <Text style={styles.inputText} accessible={false} importantForAccessibility="no">{unit}</Text>
    </View> : field}
    {hint && <Text style={styles.meta}>{hint}</Text>}
  </View>;
}

export function Choice<T extends string>({ title, value, options, onChange, disabled, testID }: {
  title: string; value: T; options: { id: T; label: string; icon?: ReactNode }[]; onChange: (value: T) => void;
  disabled?: boolean; testID?: string;
}) {
  return <View style={styles.field}>
    <Text style={styles.label}>{title}</Text>
    <View style={styles.choices} accessibilityRole="radiogroup">
      {options.map(({ id, label, icon }) => <Pressable key={id} testID={testID && testID + '-' + id}
        accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: value === id, disabled: !!disabled }}
        disabled={disabled} onPress={() => onChange(id)} style={[styles.choice, !!icon && styles.choiceWithIcon, value === id && styles.checked]}>
        {icon}
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>)}
    </View>
  </View>;
}

export function FinanceAlert({ children, testID, style }: { children: ReactNode; testID?: string; style?: TextProps['style'] }) {
  return <Text style={[styles.alert, style]} testID={testID} accessibilityRole="alert" accessibilityLiveRegion="polite">
    {children}
  </Text>;
}

const inputFrame = { minHeight: 48, paddingHorizontal: 12, borderRadius: 8, backgroundColor: palette.panel,
  borderWidth: 1, borderColor: palette.control };
const inputText = { color: palette.ink, fontSize: 17 };

export const styles = StyleSheet.create({
  page: { width: '100%', maxWidth: 540, alignSelf: 'center', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 24, gap: 18 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  // The visible outline in theta.png is 234 × 250 within a square canvas.
  brandMark: { transform: [{ scaleY: 234 / 250 }] },
  walletMark: { tintColor: palette.accent },
  brandTitle: { color: palette.ink, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  heading: { color: palette.ink, fontSize: 27, fontWeight: '700' },
  section: { color: palette.ink, fontSize: 19, fontWeight: '700' },
  groupTitle: { color: palette.ink, fontSize: 15, fontWeight: '600' },
  surface: { backgroundColor: palette.panel, borderRadius: isWallet ? 20 : 12, borderWidth: 1, borderColor: palette.line },
  title: { color: palette.ink, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  label: { color: palette.ink, fontSize: 15 },
  meta: { color: palette.muted, fontSize: 14, flexShrink: 1 },
  alert: { color: palette.danger, fontSize: 15 },
  value: { color: palette.ink, fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
  heroValue: { color: palette.ink, fontSize: 30, fontWeight: '600', fontVariant: ['tabular-nums'] },
  mutedValue: { color: palette.muted, textDecorationLine: 'line-through' },
  field: { gap: 6 },
  input: { ...inputFrame, ...inputText, paddingVertical: 10 },
  inputText,
  currencyField: { ...inputFrame, flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  currencyInput: { ...inputText, flex: 1, textAlign: 'right', paddingVertical: 10 },
  choices: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  choice: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: palette.control,
    borderRadius: 8, justifyContent: 'center', flexShrink: 1 },
  choiceWithIcon: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checked: { borderColor: palette.accent, backgroundColor: palette.selected },
  button: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, justifyContent: 'center',
    alignItems: 'center', flexDirection: 'row', gap: 6, backgroundColor: palette.panel, borderWidth: 1,
    borderColor: palette.control, flexShrink: 1 },
  buttonText: { color: palette.ink, fontSize: 15, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  primary: { backgroundColor: palette.accent, borderColor: palette.accent },
  primaryText: { color: palette.panel },
  dimmed: { opacity: 0.58 },
});
