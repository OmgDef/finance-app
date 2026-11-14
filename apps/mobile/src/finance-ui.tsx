import type { ReactNode } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';

export const palette = {
  ground: '#111715', panel: '#1a241f', raised: '#25322b', ink: '#ebf2ee', muted: '#b7c8bf',
  line: '#3a4a40', danger: '#f8c3a8', mint: '#a5dec1',
};

export function FinanceButton({ title, onPress, primary, disabled, testID }: {
  title: string; onPress: () => void; primary?: boolean; disabled?: boolean; testID?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    testID={testID} onPress={onPress} style={({ pressed }) => [
      styles.button, primary && styles.primary, (disabled || pressed) && styles.dimmed,
    ]}>
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text>
  </Pressable>;
}

export function FinanceField({ title, hint, ...input }: TextInputProps & { title: string; hint?: string }) {
  return <View style={styles.field}>
    <Text style={styles.label}>{title}</Text>
    <TextInput {...input} returnKeyType={input.multiline ? undefined : 'done'}
      onSubmitEditing={input.multiline ? undefined : Keyboard.dismiss}
      inputAccessoryViewID={Platform.OS === 'ios' ? 'finance-keyboard' : undefined}
      autoCorrect={input.keyboardType ? false : undefined} spellCheck={input.keyboardType ? false : undefined}
      accessibilityLabel={title} placeholderTextColor={palette.muted}
      style={styles.input} selectionColor={palette.mint} />
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
  heading: { color: palette.ink, fontSize: 27, fontWeight: '700' },
  section: { color: palette.ink, fontSize: 19, fontWeight: '700' },
  title: { color: palette.ink, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  label: { color: palette.ink, fontSize: 15 },
  meta: { color: palette.muted, fontSize: 14, flexShrink: 1 },
  alert: { color: palette.danger, fontSize: 15 },
  value: { color: palette.ink, fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
  heroValue: { color: palette.ink, fontSize: 30, fontWeight: '600', fontVariant: ['tabular-nums'] },
  mutedValue: { color: palette.muted, textDecorationLine: 'line-through' },
  field: { gap: 6 },
  input: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: palette.panel,
    color: palette.ink, borderWidth: 1, borderColor: palette.line, fontSize: 17 },
  choices: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  choice: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: palette.line,
    borderRadius: 8, justifyContent: 'center', flexShrink: 1 },
  checked: { borderColor: palette.ink, backgroundColor: palette.raised },
  button: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, justifyContent: 'center',
    alignItems: 'center', borderWidth: 1, borderColor: palette.line, flexShrink: 1 },
  buttonText: { color: palette.ink, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  primary: { backgroundColor: palette.ink, borderColor: palette.ink },
  primaryText: { color: palette.ground },
  dimmed: { opacity: 0.58 },
});
