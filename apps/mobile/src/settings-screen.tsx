import { requireOptionalNativeModule } from 'expo';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Language, Result } from '@teta/contracts';
import { copy } from './copy';
import { financeCopy } from './finance-copy';
import { FinanceIcon } from './finance-icon';
import type { FinanceIconName } from './finance-icon';
import { scheduleCopy } from './finance-schedule-copy';
import { FinanceAlert, FinanceBrand, palette, styles } from './finance-ui';
import { profileCopy } from './profile-copy';
import { timeZoneLabel } from './time-zones';

const languageNames = { ru: 'Русский', en: 'English' } as const;

const application = requireOptionalNativeModule<{
  nativeApplicationVersion: string | null;
  nativeBuildVersion: string | null;
}>('ExpoApplication');

function AppInfo({ lang }: { lang: Language }) {
  const t = copy[lang];
  // Older iOS development builds can reload the UI before ExpoApplication is linked.
  const version = application?.nativeApplicationVersion ?? Constants.expoConfig?.version;
  const build = application?.nativeBuildVersion ?? Constants.platform?.ios?.buildNumber;

  return <View style={layout.appInfo}>
    <FinanceBrand title={t.appName} />
    <View style={layout.appVersions}>
      <Text style={styles.meta}>{t.appVersion} {version ?? '—'}</Text>
      <Text style={styles.meta}>{t.appBuild} {build ?? '—'}</Text>
    </View>
  </View>;
}

export function FinanceSettingsLinks({ lang, onAccounts, onSchedule }: {
  lang: Language;
  onAccounts: () => void;
  onSchedule: () => void;
}) {
  return <View style={styles.surface}>
    <SettingRow icon="wallet" title={financeCopy[lang].manageAccounts} onPress={onAccounts} testID="finance-account-settings" />
    <View style={layout.divider}>
      <SettingRow icon="calendar" title={scheduleCopy[lang].scheduleSettings} onPress={onSchedule} testID="finance-schedule-settings" />
    </View>
  </View>;
}

export function SettingsScreen({ lang, profile, busy, languageError, zoneEditing, zoneNotice, notice,
  biometricsEnabled, onLanguage, onTimeZone, onBiometrics, onSignOut }: {
  lang: Language;
  profile: Result<'me'>;
  busy: boolean;
  languageError: boolean;
  zoneEditing: boolean;
  zoneNotice?: ReactNode;
  notice?: ReactNode;
  biometricsEnabled: boolean;
  onLanguage: (language: Language) => void;
  onTimeZone: () => void;
  onBiometrics: () => void;
  onSignOut: () => void;
}) {
  const t = copy[lang];
  const router = useRouter();
  const [languageOpen, setLanguageOpen] = useState(false);
  const closeLanguage = () => setLanguageOpen(false);
  return <>
    <View style={layout.group}>
      <Text accessibilityRole="header" style={styles.groupTitle}>{t.profile}</Text>
      <View style={styles.surface}>
        <View style={layout.row}>
          <View style={layout.avatar}><FinanceIcon name="profile" color={palette.ink} size={17} /></View>
          <View style={layout.identity}>
            <Text style={styles.title}>{profile.email}</Text>
            <Text style={styles.meta}>{t.accountEmail}</Text>
          </View>
        </View>
        <View style={layout.divider}>
          <SettingRow icon="profile" title={profileCopy[lang].details} onPress={() => router.push('/settings/profile')}
            testID="profile-edit-open" />
        </View>
        <View style={layout.divider}>
          <SettingRow icon="clock" title={t.timeZone} hint={t.editTimeZone} value={timeZoneLabel(profile.timeZone, lang)}
            valueID="finance-current-time-zone" onPress={onTimeZone} expanded={zoneEditing}
            disabled={busy}
            testID="finance-edit-time-zone" />
          {zoneNotice}
        </View>
      </View>
    </View>
    <View style={layout.group}>
      <Text accessibilityRole="header" style={styles.groupTitle}>{t.interface}</Text>
      <View style={styles.surface}>
        <SettingRow icon="language" title={t.language} value={languageNames[lang]} onPress={() => setLanguageOpen(true)}
          expanded={languageOpen} testID="finance-language" />
      </View>
      {languageError && <FinanceAlert>{t.languageSaveFailed}</FinanceAlert>}
    </View>
    <View style={layout.group}>
      <Text accessibilityRole="header" style={styles.groupTitle}>{t.security}</Text>
      <View style={styles.surface}>
        <SettingRow icon="biometrics" title={t.biometricSignIn} value={biometricsEnabled ? t.biometricOn : t.biometricOff}
          hint={biometricsEnabled ? t.disable : t.enable} onPress={onBiometrics}
          disabled={busy} testID="finance-biometrics" />
      </View>
      {notice}
    </View>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onSignOut}
      style={({ pressed }) => [layout.row, (busy || pressed) && styles.dimmed]} testID="finance-sign-out">
      <FinanceIcon name="sign-out" color={palette.danger} />
      <Text style={[styles.title, layout.signOut]}>{t.signOut}</Text>
    </Pressable>
    <AppInfo lang={lang} />
    <Modal visible={languageOpen} transparent animationType="fade" onRequestClose={closeLanguage}
      statusBarTranslucent navigationBarTranslucent>
      <SafeAreaProvider style={layout.modal}>
        <Pressable accessible={false} importantForAccessibility="no" onPress={closeLanguage} style={layout.backdrop} />
        <View style={layout.sheet} accessibilityViewIsModal>
          <ScrollView bounces={false} contentInsetAdjustmentBehavior="never">
            <SafeAreaView edges={['bottom']} style={layout.sheetContent}>
              <View style={layout.sheetHeader}>
                <Text accessibilityRole="header" style={styles.section}>{t.interfaceLanguage}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t.close} onPress={closeLanguage}
                  style={({ pressed }) => [layout.close, pressed && styles.dimmed]}>
                  <FinanceIcon name="close" color={palette.muted} />
                </Pressable>
              </View>
              <View accessibilityRole="radiogroup" style={layout.options}>
                {(['ru', 'en'] as const).map((option) => {
                  const checked = option === lang;
                  return <Pressable key={option} accessibilityRole="radio" accessibilityLanguage={option}
                    accessibilityState={{ checked }} testID={'finance-language-' + option}
                    style={({ pressed }) => [layout.option, checked && layout.selected, pressed && styles.dimmed]}
                    onPress={() => { onLanguage(option); closeLanguage(); }}>
                    <Text style={[styles.title, checked && layout.selectedText]}>{languageNames[option]}</Text>
                    {checked && <FinanceIcon name="check" color={palette.accent} />}
                  </Pressable>;
                })}
              </View>
            </SafeAreaView>
          </ScrollView>
        </View>
      </SafeAreaProvider>
    </Modal>
  </>;
}

function SettingRow({ icon, title, value, valueID, hint, onPress, expanded, disabled, testID }: {
  icon: FinanceIconName;
  title: string;
  value?: string;
  valueID?: string;
  hint?: string;
  onPress: () => void;
  expanded?: boolean;
  disabled?: boolean;
  testID: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={value ? title + ', ' + value : title} accessibilityHint={hint}
    accessibilityState={{ expanded, disabled }} onPress={onPress} disabled={disabled} testID={testID}
    style={({ pressed }) => [layout.row, (pressed || disabled) && styles.dimmed]}>
    <FinanceIcon name={icon} color={palette.muted} />
    <View style={layout.rowLabels}>
      <Text style={[styles.title, layout.rowTitle]}>{title}</Text>
      {value !== undefined && <Text style={styles.meta} testID={valueID}>{value}</Text>}
    </View>
    <FinanceIcon name={expanded ? 'chevron-down' : 'chevron'} color={palette.muted} size={15} />
  </Pressable>;
}

const layout = StyleSheet.create({
  appInfo: { alignItems: 'center', gap: 4 },
  appVersions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 12, rowGap: 4 },
  group: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, minHeight: 52, gap: 10 },
  rowLabels: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 },
  rowTitle: { flexGrow: 1 },
  identity: { flex: 1, gap: 2 },
  avatar: { width: 33, height: 33, borderRadius: 17, backgroundColor: palette.raised,
    alignItems: 'center', justifyContent: 'center' },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.line },
  signOut: { color: palette.danger },
  modal: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(23, 38, 58, 0.35)' },
  sheet: { width: '100%', maxWidth: 540, maxHeight: '90%', backgroundColor: palette.panel,
    borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  sheetContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20, gap: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  close: { width: 44, height: 44, borderRadius: 8, backgroundColor: palette.ground,
    alignItems: 'center', justifyContent: 'center' },
  options: { backgroundColor: palette.ground, padding: 3, borderRadius: 12, gap: 3 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    minHeight: 51, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: palette.panel },
  selected: { backgroundColor: palette.selected },
  selectedText: { color: palette.accent },
});
