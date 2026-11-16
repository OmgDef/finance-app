import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Language } from '@teta/contracts';
import { appBrand, appVariant } from './app-variant';
import { copy } from './copy';
import { FinanceIcon } from './finance-icon';
import { SupportScreen } from './support-screen';

export const unlockBackground = appBrand.brandColor;
const foreground = '#FFFFFF';
const isWallet = appVariant === 'b';
const digits = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']];

export function UnlockScreen({ lang, busy, message, languageError, canUseBiometrics, verifyingActivation,
  canReturnToPin, onLanguage, onPin, onBiometrics, onRecovery, onReturnToPin }: {
  lang: Language;
  busy: boolean;
  message: string;
  languageError: boolean;
  canUseBiometrics: boolean;
  verifyingActivation: boolean;
  canReturnToPin: boolean;
  onLanguage: () => void;
  onPin: (pin: string) => Promise<void>;
  onBiometrics: () => void;
  onRecovery: () => void;
  onReturnToPin: () => void;
}) {
  const t = copy[lang];
  const { width, height } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const keySize = Math.max(48, Math.floor(Math.min((width - 80) / 3, height * 0.11, 104)));
  const pin = useRef('');
  const submitting = useRef(false);
  const [entered, setEntered] = useState(0);
  const [supportOpen, setSupportOpen] = useState(false);

  function edit(next: string) {
    pin.current = next;
    setEntered(next.length);
  }

  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'background') edit('');
    });
    return () => listener.remove();
  }, []);

  async function enter(digit: string) {
    if (busy || submitting.current || AppState.currentState !== 'active') return;
    const next = pin.current + digit;
    edit(next);
    if (next.length !== 4) return;
    submitting.current = true;
    pin.current = '';
    try {
      await onPin(next);
    } finally {
      edit('');
      submitting.current = false;
    }
  }

  const key = { width: keySize, height: keySize, borderRadius: keySize / 2 };
  function renderKey(id: string, label: string, onPress: () => void, disabled: boolean, icon = false) {
    return <Pressable key={id} testID={`unlock-key-${id}`} accessibilityRole="button" accessibilityLabel={label}
      disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
      style={({ pressed }) => [styles.key, key, disabled && styles.disabled, pressed && styles.pressed]}>
      {icon ? <FinanceIcon name="biometrics" color={foreground} size={28} />
        : <Text maxFontSizeMultiplier={1.5} style={[styles.digit, { fontSize: Math.round(keySize * 0.43) }]}>
          {id === 'delete' ? '⌫' : label}
        </Text>}
    </Pressable>;
  }

  return <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']} testID="unlock-screen">
    <ScrollView contentInsetAdjustmentBehavior="never"
      contentContainerStyle={[styles.page, { paddingBottom: styles.page.paddingBottom + bottom }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={lang === 'en' ? 'Русский' : 'English'}
          style={styles.linkTarget} onPress={onLanguage}>
          <Text style={styles.language}>{lang === 'en' ? 'RU' : 'EN'}</Text>
        </Pressable>
      </View>
      <View style={styles.main}>
        <Text accessibilityRole="header" style={styles.heading}>
          {verifyingActivation ? t.verifyActivationPin : t.enterUnlockPin}
        </Text>
        <View accessible accessibilityLabel={t.pinProgress(entered)} style={styles.dots}>
          {[0, 1, 2, 3].map((index) => <View key={index} style={[styles.dot, index < entered && styles.filled]} />)}
        </View>
        <View style={styles.feedback} accessibilityLiveRegion="polite">
          {busy ? <Text style={styles.message}>{t.checking}</Text>
            : !!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
          {languageError && <Text accessibilityRole="alert" style={styles.message}>{t.languageSaveFailed}</Text>}
        </View>
        <View style={styles.grid}>
          {digits.map((row) => <View key={row[0]} style={styles.row}>
            {row.map((digit) => renderKey(digit, digit, () => void enter(digit), busy))}
          </View>)}
          <View style={styles.row}>
            {canUseBiometrics ? renderKey('biometrics', t.biometrics, () => {
              if (submitting.current) return;
              edit('');
              onBiometrics();
            }, busy, true) : <View style={key} />}
            {renderKey('0', '0', () => void enter('0'), busy)}
            {renderKey('delete', t.deletePinDigit, () => {
              if (!submitting.current) edit(pin.current.slice(0, -1));
            }, busy || entered === 0)}
          </View>
        </View>
        <View style={styles.footer}>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
            style={styles.linkTarget} onPress={onRecovery} testID="unlock-recovery">
            <Text style={[styles.recovery, busy && styles.disabled]}>{verifyingActivation ? t.activateAgain : t.forgotPin}</Text>
          </Pressable>
          {canReturnToPin && <Pressable accessibilityRole="button" disabled={busy} style={styles.linkTarget}
            onPress={onReturnToPin} testID="unlock-previous-pin">
            <Text style={styles.language}>{t.returnToPin}</Text>
          </Pressable>}
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: supportOpen }}
            style={styles.linkTarget} onPress={() => setSupportOpen(!supportOpen)} testID="support-open">
            <Text style={styles.language}>{t.support}</Text>
          </Pressable>
        </View>
      </View>
      {supportOpen && <View style={styles.support}><SupportScreen lang={lang} showHeading={false} /></View>}
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: unlockBackground },
  page: { flexGrow: 1, width: '100%', maxWidth: 540, alignSelf: 'center', paddingHorizontal: 20, paddingBottom: 8 },
  header: { flexDirection: 'row', justifyContent: 'flex-end' },
  main: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 4, paddingBottom: 12 },
  heading: { color: foreground, fontSize: 22, fontWeight: '500', textAlign: 'center' },
  dots: { flexDirection: 'row', gap: 16, marginTop: 14 },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: foreground },
  filled: { backgroundColor: foreground },
  feedback: { minHeight: 36, justifyContent: 'center', paddingVertical: 4 },
  message: { color: foreground, fontSize: 14, textAlign: 'center' },
  grid: { gap: 14 },
  row: { flexDirection: 'row', gap: 14 },
  key: { borderWidth: 2, borderColor: isWallet ? '#93B2A4' : '#8895BF', alignItems: 'center', justifyContent: 'center' },
  digit: { color: foreground, fontVariant: ['tabular-nums'] },
  pressed: { backgroundColor: isWallet ? '#356959' : '#3D4D8C', borderColor: foreground },
  disabled: { opacity: 0.52 },
  footer: { alignItems: 'center', marginTop: 28 },
  linkTarget: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  language: { color: isWallet ? '#DEEFE4' : '#E0E6FF', textAlign: 'center', fontSize: 14, fontWeight: '600' },
  recovery: { color: foreground, textAlign: 'center', fontSize: 18, fontWeight: '600', textDecorationLine: 'underline' },
  support: { backgroundColor: foreground, borderRadius: 12, padding: 14 },
});
