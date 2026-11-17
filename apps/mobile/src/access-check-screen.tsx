import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Language } from '@teta/contracts';
import { isComaBank } from './app-variant';
import { copy } from './copy';
import { FinanceIcon } from './finance-icon';
import { FinanceAlert, FinanceButton, FinanceMark, palette } from './finance-ui';
import { SupportScreen } from './support-screen';

type AccessCheckScreenProps = {
  lang: Language;
  languageError: boolean;
  onLanguage: () => void;
  supportOpen: boolean;
  onToggleSupport: () => void;
  error?: string;
  busy: boolean;
  onRetry?: () => void;
  onSignOut?: () => void;
};

function useCheckMotion(pending: boolean, duration: number) {
  const phase = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pending) return;
    let subscribed = true;
    let settingChanged = false;
    const animation = Animated.loop(Animated.timing(phase, {
      toValue: 1, duration, easing: Easing.linear, useNativeDriver: true, isInteraction: false,
    }));
    const updateMotion = (reduceMotion: boolean) => {
      animation.reset();
      if (!reduceMotion) animation.start();
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
      animation.reset();
    };
  }, [pending, duration, phase]);

  return phase;
}

function AccessCheckMark({ pending }: { pending: boolean }) {
  const turn = useCheckMotion(pending, 1350);

  return <View style={styles.mark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={styles.markFill}><FinanceMark size={48} /></View>
    {pending ? <Animated.View style={[styles.arc, {
      transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
    }]} /> : <View style={styles.errorDot} />}
  </View>;
}

export function AccessCheckScreen(props: AccessCheckScreenProps) {
  return isComaBank ? <ComaBankAccessCheckScreen {...props} /> : <TetaAccessCheckScreen {...props} />;
}

function TetaAccessCheckScreen({ lang, languageError, onLanguage, supportOpen, onToggleSupport,
  error, busy, onRetry, onSignOut }: AccessCheckScreenProps) {
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

const trackWidth = 112;
const segmentWidth = 36;

function ComaBankCheckIndicator() {
  const phase = useCheckMotion(true, 1600);
  const translateX = phase.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, trackWidth - segmentWidth, 0] });
  return <View style={comaStyles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Animated.View style={[comaStyles.segment, { transform: [{ translateX }] }]} />
  </View>;
}

function ComaBankAccessCheckScreen({ lang, languageError, onLanguage, supportOpen, onToggleSupport,
  error, busy, onRetry, onSignOut }: AccessCheckScreenProps) {
  const t = copy[lang];
  const { width, height } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const markSize = Math.round(Math.min(width * 0.68, height * 0.32, 272));
  const pending = error === undefined;

  return <SafeAreaView edges={['top', 'left', 'right']} style={comaStyles.safe} testID="access-check-screen">
    <ScrollView style={comaStyles.scroll} contentInsetAdjustmentBehavior="never"
      contentContainerStyle={comaStyles.page} indicatorStyle="white">
      <View style={comaStyles.cover}>
        <View style={comaStyles.column}>
          <Text style={comaStyles.wordmark}>{t.appName}</Text>
          <View style={[comaStyles.coverMark, { marginBottom: -Math.round(markSize * 0.16) }]}
            accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <FinanceMark size={markSize} />
          </View>
        </View>
      </View>

      <View style={[comaStyles.column, comaStyles.body, { paddingBottom: bottom + 8 }]}>
        <View style={comaStyles.main}>
          <View style={comaStyles.copy} accessibilityLiveRegion="polite">
            <Text accessibilityRole="header" style={comaStyles.title}>{pending ? t.checking : t.checkingFailed}</Text>
            <Text accessibilityRole={pending ? undefined : 'alert'} style={comaStyles.message}>
              {pending ? t.checkingHint : error}
            </Text>
          </View>
          {pending && <ComaBankCheckIndicator />}
          {(onRetry || onSignOut) && <View style={comaStyles.actions}>
            {onRetry && <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
              onPress={onRetry} testID="access-check-retry"
              style={({ pressed }) => [comaStyles.retry, (busy || pressed) && styles.pressed]}>
              <Text style={comaStyles.retryLabel}>{t.retry}</Text>
            </Pressable>}
            {onSignOut && <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
              onPress={onSignOut} style={({ pressed }) => [comaStyles.utility, (busy || pressed) && styles.pressed]}>
              <Text style={comaStyles.utilityLabel}>{t.signOut}</Text>
            </Pressable>}
          </View>}
        </View>

        {languageError && <FinanceAlert>{t.languageSaveFailed}</FinanceAlert>}
        <View style={comaStyles.utilities}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: supportOpen }} testID="support-open"
            onPress={onToggleSupport} style={({ pressed }) => [comaStyles.utility, pressed && styles.pressed]}>
            <FinanceIcon name="help" color={palette.muted} size={18} />
            <Text style={comaStyles.utilityLabel}>{t.support}</Text>
            <FinanceIcon name={supportOpen ? 'chevron-down' : 'chevron'} color={palette.muted} size={12} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={lang === 'en' ? 'Русский' : 'English'}
            onPress={onLanguage} style={({ pressed }) => [comaStyles.utility, pressed && styles.pressed]}>
            <FinanceIcon name="language" color={palette.muted} size={18} />
            <Text style={comaStyles.utilityLabel}>{lang === 'en' ? 'RU' : 'EN'}</Text>
          </Pressable>
        </View>
        {supportOpen && <SupportScreen lang={lang} showHeading={false} />}
      </View>
    </ScrollView>
  </SafeAreaView>;
}

const comaStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.panel },
  scroll: { backgroundColor: palette.ground },
  page: { flexGrow: 1 },
  cover: { overflow: 'hidden', backgroundColor: palette.panel, paddingTop: 12 },
  column: { width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: 28 },
  wordmark: { color: palette.ink, fontSize: 22, fontWeight: '700', letterSpacing: -0.7 },
  coverMark: { alignSelf: 'flex-end', marginTop: 14 },
  body: { flexGrow: 1, gap: 12 },
  main: { flexGrow: 1, justifyContent: 'center', paddingVertical: 32, gap: 22 },
  copy: { gap: 8 },
  title: { color: palette.ink, fontSize: 32, fontWeight: '600', letterSpacing: -0.9 },
  message: { color: palette.muted, fontSize: 15, lineHeight: 22 },
  track: { width: trackWidth, height: 3, borderRadius: 2, backgroundColor: palette.line },
  segment: { width: segmentWidth, height: '100%', borderRadius: 2, backgroundColor: palette.accent },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16 },
  retry: { minHeight: 44, flexShrink: 1, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 8,
    borderRadius: 22, backgroundColor: palette.ink },
  retryLabel: { color: palette.ground, fontSize: 15, fontWeight: '600' },
  utilities: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 },
  utility: { flexDirection: 'row', flexShrink: 1, alignItems: 'center', minHeight: 44, minWidth: 44, gap: 8 },
  utilityLabel: { flexShrink: 1, color: palette.muted, fontSize: 15, fontWeight: '600' },
});
