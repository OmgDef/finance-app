import type { ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import { FinanceIcon } from './finance-icon';
import type { FinanceIconName } from './finance-icon';

export const palette = {
  ground: '#F5F7FA', panel: '#FFFFFF', raised: '#EDF1F6', ink: '#17263A', muted: '#53647A',
  line: '#E2E8F0', control: '#8594A7', danger: '#AD343E', accent: '#2459B2', selected: '#E9F1FF',
  positive: '#226349',
};

export function FinanceMark() {
  return <Image source={require('../assets/theta.png')} style={styles.brandMark} accessible={false}
    importantForAccessibility="no" />;
}

export function FinanceBrand({ title }: { title: string }) {
  return <View style={styles.brand}>
    <FinanceMark />
    <Text style={styles.brandTitle}>{title}</Text>
  </View>;
}

export function FinanceButton({ title, onPress, primary, disabled, testID, icon }: {
  title: string; onPress: () => void; primary?: boolean; disabled?: boolean; testID?: string; icon?: FinanceIconName;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    testID={testID} onPress={onPress} style={({ pressed }) => [
      styles.button, primary && styles.primary, (disabled || pressed) && styles.dimmed,
    ]}>
    {icon && <FinanceIcon name={icon} color={primary ? palette.panel : palette.accent} size={16} />}
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text>
  </Pressable>;
}

export function FinanceField({ title, hint, ...input }: TextInputProps & { title: string; hint?: string }) {
  return <View style={styles.field}>
    <Text style={styles.label}>{title}</Text>
    <TextInput {...input} returnKeyType={input.multiline ? undefined : 'done'}
      onSubmitEditing={input.multiline ? undefined : () => void KeyboardController.dismiss()}
      autoCorrect={input.keyboardType ? false : undefined} spellCheck={input.keyboardType ? false : undefined}
      accessibilityLabel={title} placeholderTextColor={palette.muted}
      style={styles.input} selectionColor={palette.accent} />
    {hint && <Text style={styles.meta}>{hint}</Text>}
  </View>;
}

export function Choice<T extends string>({ title, value, options, onChange, disabled, testID }: {
  title: string; value: T; options: { id: T; label: string }[]; onChange: (value: T) => void;
  disabled?: boolean; testID?: string;
}) {
  return <View style={styles.field}>
    <Text style={styles.label}>{title}</Text>
    <View style={styles.choices} accessibilityRole="radiogroup">
      {options.map(({ id, label }) => <Pressable key={id} testID={testID && testID + '-' + id}
        accessibilityRole="radio" accessibilityState={{ checked: value === id, disabled: !!disabled }}
        disabled={disabled} onPress={() => onChange(id)} style={[styles.choice, value === id && styles.checked]}>
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>)}
    </View>
  </View>;
}

export function FinanceAlert({ children, testID }: { children: ReactNode; testID?: string }) {
  return <Text style={styles.alert} testID={testID} accessibilityRole="alert" accessibilityLiveRegion="polite">
    {children}
  </Text>;
}

export const styles = StyleSheet.create({
  page: { width: '100%', maxWidth: 540, alignSelf: 'center', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 24, gap: 18 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  // The visible outline in theta.png is 234 × 250 within a square canvas.
  brandMark: { width: 29, height: 29, transform: [{ scaleY: 234 / 250 }] },
  brandTitle: { color: palette.ink, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  heading: { color: palette.ink, fontSize: 27, fontWeight: '700' },
  section: { color: palette.ink, fontSize: 19, fontWeight: '700' },
  groupTitle: { color: palette.ink, fontSize: 15, fontWeight: '600' },
  surface: { backgroundColor: palette.panel, borderRadius: 12, borderWidth: 1, borderColor: palette.line },
  title: { color: palette.ink, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  label: { color: palette.ink, fontSize: 15 },
  meta: { color: palette.muted, fontSize: 14, flexShrink: 1 },
  alert: { color: palette.danger, fontSize: 15 },
  value: { color: palette.ink, fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
  heroValue: { color: palette.ink, fontSize: 30, fontWeight: '600', fontVariant: ['tabular-nums'] },
  mutedValue: { color: palette.muted, textDecorationLine: 'line-through' },
  field: { gap: 6 },
  input: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: palette.panel,
    color: palette.ink, borderWidth: 1, borderColor: palette.control, fontSize: 17 },
  choices: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  choice: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: palette.control,
    borderRadius: 8, justifyContent: 'center', flexShrink: 1 },
  checked: { borderColor: palette.accent, backgroundColor: palette.selected },
  button: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, justifyContent: 'center',
    alignItems: 'center', flexDirection: 'row', gap: 6, backgroundColor: palette.panel, borderWidth: 1,
    borderColor: palette.control, flexShrink: 1 },
  buttonText: { color: palette.ink, fontSize: 15, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  primary: { backgroundColor: palette.accent, borderColor: palette.accent },
  primaryText: { color: palette.panel },
  dimmed: { opacity: 0.58 },
});
