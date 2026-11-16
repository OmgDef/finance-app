import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Language } from '@teta/contracts';
import { copy } from './copy';
import { FinanceIcon } from './finance-icon';
import { FinanceAlert, FinanceButton, FinanceMark, palette } from './finance-ui';
import { SupportScreen } from './support-screen';

function AccessCheckMark({ pending }: { pending: boolean }) {
  const turn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pending) return;
    let subscribed = true;
    let settingChanged = false;
    const spin = Animated.loop(Animated.timing(turn, {
      toValue: 1, duration: 1350, easing: Easing.linear, useNativeDriver: true, isInteraction: false,
    }));
    const updateMotion = (reduceMotion: boolean) => {
      spin.reset();
      if (!reduceMotion) spin.start();
    };
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (reduceMotion) => {
      settingChanged = true;
      updateMotion(reduceMotion);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((reduceMotion) => {
      if (subscribed && !settingChanged) updateMotion(reduceMotion);
    }).catch(() => {});
    return () => {
      subscribed = false;
      subscription.remove();
      spin.reset();
    };
  }, [pending, turn]);

  return <View style={styles.mark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={styles.markFill}><FinanceMark size={48} /></View>
    {pending ? <Animated.View style={[styles.arc, {
      transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
    }]} /> : <View style={styles.errorDot} />}
  </View>;
}

export function AccessCheckScreen({ lang, languageError, onLanguage, supportOpen, onToggleSupport,
  error, busy, onRetry, onSignOut }: {
  lang: Language;
  languageError: boolean;
  onLanguage: () => void;
  supportOpen: boolean;
  onToggleSupport: () => void;
  error?: string;
  busy: boolean;
  onRetry?: () => void;
  onSignOut?: () => void;
}) {
  const t = copy[lang];
  const pending = error === undefined;

  return <SafeAreaView style={styles.safe} testID="access-check-screen">
    <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={styles.page}>
      <View style={styles.header}>
        <Text style={styles.brand}>{t.appName}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={lang === 'en' ? 'Русский' : 'English'}
          onPress={onLanguage} style={({ pressed }) => [styles.languageButton, pressed && styles.pressed]}>
          <Text style={styles.language}>{lang === 'en' ? 'RU' : 'EN'}</Text>
        </Pressable>
      </View>
      {languageError && <FinanceAlert>{t.languageSaveFailed}</FinanceAlert>}

      <View style={styles.main}>
        <View style={styles.card}>
          <AccessCheckMark pending={pending} />
          <View style={styles.copy} accessibilityLiveRegion="polite">
            <Text accessibilityRole="header" style={styles.title}>{pending ? t.checking : t.checkingFailed}</Text>
            <Text accessibilityRole={pending ? undefined : 'alert'} style={styles.message}>
              {pending ? t.checkingHint : error}
            </Text>
          </View>
          {(onRetry || onSignOut) && <View style={styles.actions}>
            {onRetry && <FinanceButton primary title={t.retry} icon="refresh" disabled={busy}
              onPress={onRetry} testID="access-check-retry" />}
            {onSignOut && <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }}
              onPress={onSignOut} style={({ pressed }) => [styles.signOut, (busy || pressed) && styles.pressed]}>
              <Text style={styles.signOutLabel}>{t.signOut}</Text>
            </Pressable>}
          </View>}
        </View>
      </View>

      <View style={styles.footer}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: supportOpen }} testID="support-open"
          onPress={onToggleSupport} style={({ pressed }) => [styles.supportButton, pressed && styles.pressed]}>
          <FinanceIcon name="help" color={palette.muted} size={19} />
          <Text style={styles.supportLabel}>{t.support}</Text>
          <FinanceIcon name={supportOpen ? 'chevron-down' : 'chevron'} color={palette.muted} size={14} />
        </Pressable>
        {supportOpen && <SupportScreen lang={lang} showHeading={false} />}
      </View>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.ground },
  page: { flexGrow: 1, width: '100%', maxWidth: 460, alignSelf: 'center', paddingHorizontal: 24,
    paddingTop: 8, paddingBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  brand: { flexShrink: 1, color: palette.ink, fontSize: 17, fontWeight: '700' },
  languageButton: { minWidth: 52, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: 12, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.panel, paddingHorizontal: 10 },
  language: { color: palette.accent, fontSize: 14, fontWeight: '700' },
  main: { flexGrow: 1, justifyContent: 'center', paddingVertical: 24 },
  card: { alignItems: 'center', gap: 20, paddingHorizontal: 22, paddingVertical: 32, borderRadius: 24,
    borderWidth: 1, borderColor: palette.line, backgroundColor: palette.panel },
  mark: { width: 80, height: 80, alignItems: 'center', justifyContent: 'center', borderRadius: 40,
    borderWidth: 2, borderColor: palette.line },
  markFill: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 32,
    backgroundColor: palette.selected },
  arc: { position: 'absolute', top: -2, left: -2, width: 80, height: 80, borderRadius: 40,
    borderWidth: 2, borderColor: 'transparent', borderTopColor: palette.accent },
  errorDot: { position: 'absolute', right: 1, bottom: 1, width: 14, height: 14, borderRadius: 7,
    borderWidth: 2, borderColor: palette.panel, backgroundColor: palette.danger },
  copy: { alignSelf: 'stretch', gap: 8 },
  title: { color: palette.ink, textAlign: 'center', fontSize: 26, fontWeight: '700', letterSpacing: -0.5 },
  message: { color: palette.muted, textAlign: 'center', fontSize: 15, lineHeight: 22 },
  actions: { alignSelf: 'stretch', gap: 4 },
  signOut: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  signOutLabel: { color: palette.muted, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  footer: { borderTopWidth: 1, borderTopColor: palette.line, gap: 8 },
  supportButton: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 2 },
  supportLabel: { flex: 1, color: palette.ink, fontSize: 15, fontWeight: '600' },
});
