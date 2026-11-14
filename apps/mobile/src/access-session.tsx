import { createContext, use, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert, AppState, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getCalendars, getLocales } from 'expo-localization';
import * as Store from 'expo-secure-store';
import * as Capture from 'expo-screen-capture';
import type { Language, Result } from '@teta/contracts';
import { ApiError, request } from './api';
import { copy } from './copy';
import type { FinanceAccess } from './finance-commands';
import { dateInTimeZone } from './finance-format';
import { FinanceBrand, FinanceButton, palette } from './finance-ui';
import { SettingsScreen } from './settings-screen';
import { SupportScreen } from './support-screen';
import {
  clearBiometrics, forgetInstallation, hasBiometrics, initializeInstallation,
  readBiometrics, saveBiometrics, saveInstallation, secret,
} from './installation';

type Mode = 'loading' | 'activate' | 'unlock' | 'checking' | 'profile' | 'storage';

const AccessContext = createContext<{
  access: FinanceAccess | null;
  lang: Language;
  settings: ReactNode;
  settingsBusy: boolean;
  clearSettingsDraft: () => void;
  restoreSettings: boolean;
  setSettingsFocused: (focused: boolean) => void;
  startupReady: boolean;
  timeZoneSuggestion: ReactNode;
  signedOut: ReactNode;
} | null>(null);

export function useAccessSession() {
  const value = use(AccessContext);
  if (!value) throw new Error('AccessProvider is missing');
  return value;
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>(getLocales()[0]?.languageCode === 'ru' ? 'ru' : 'en');
  const [languageError, setLanguageError] = useState(false);
  const languageWrite = useRef<Promise<void> | undefined>(undefined);
  const t = copy[lang];
  const [startupReady, setStartupReady] = useState(false);
  const [mode, setMode] = useState<Mode>('loading');
  const [installation, setInstallation] = useState<string | null>(null);
  const [profile, setProfile] = useState<Result<'me'> | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const settingsFocused = useRef(false);
  const [timeZoneDraft, setTimeZoneDraft] = useState<string | null>(null);
  const [timeZoneNotice, setTimeZoneNotice] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [checkingFailed, setCheckingFailed] = useState(false);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const session = useRef<Result<'activate'> | null>(null);
  const epoch = useRef(0);
  const lastAway = useRef<number | null>(null);
  const expired = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invalidatedBiometrics = useRef(false);
  const operation = useRef(false);
  const zoneOperation = useRef(false);
  const zoneRevision = useRef(0);
  const protectedPreview = useRef(false);

  function clearSettingsDraft() {
    if (operation.current || zoneOperation.current) return;
    setTimeZoneDraft(null);
    setTimeZoneNotice('');
    setSetup(false);
    setPin('');
    setNotice('');
  }

  function lock(next: Mode) {
    epoch.current += 1;
    session.current = null;
    clearTimeout(expired.current);
    setProfile(null);
    settingsFocused.current = false;
    setTimeZoneDraft(null);
    setTimeZoneNotice('');
    setPin('');
    setConfirm('');
    setSetup(false);
    setMode(next);
  }

  async function initialize() {
    setMode('loading');
    try {
      if (!protectedPreview.current) {
        if (Platform.OS === 'ios') await Capture.enableAppSwitcherProtectionAsync(1);
        else await Capture.preventScreenCaptureAsync('teta-access');
        protectedPreview.current = true;
      }
      const saved = await initializeInstallation();
      setInstallation(saved);
      setEnabled(await hasBiometrics());
      setMode(saved ? 'unlock' : 'activate');
    } catch {
      setMode('storage');
      setNotice('STORAGE');
    }
  }

  async function checkAccess() {
    const active = session.current;
    if (!active || AppState.currentState !== 'active') return;
    const attempt = ++epoch.current;
    setProfile(null);
    setCheckingFailed(false);
    setMode('checking');
    try {
      const profile = await request('me', { token: active.token });
      if (epoch.current !== attempt || AppState.currentState !== 'active') return;
      setProfile(profile);
      setMode('profile');
      setNotice('');
    } catch (error) {
      if (epoch.current !== attempt) return;
      const reason = errorCode(error);
      setNotice(reason);
      setCheckingFailed(true);
      if (reason === 'SESSION_EXPIRED') lock('unlock');
      if (reason === 'DEVICE_REVOKED' || reason === 'PIN_LOCKED') lock('activate');
    }
  }

  useEffect(() => {
    let disposed = false;
    const restoreLanguage = Store.getItemAsync('language').then((saved) => {
      if (!disposed && !languageWrite.current && (saved === 'en' || saved === 'ru')) setLang(saved);
    }).catch(() => {});
    void Promise.all([restoreLanguage, initialize()]).then(() => {
      if (!disposed) setStartupReady(true);
    });
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        lastAway.current ??= Date.now();
        epoch.current += 1;
        if (zoneOperation.current) {
          zoneOperation.current = false;
          zoneRevision.current += 1;
          setBusy(false);
        }
        if (session.current) {
          setProfile(null);
          setTimeZoneDraft(null);
          setTimeZoneNotice('');
          if (state === 'background' && !operation.current) {
            setSetup(false);
            setPin('');
          }
          setMode('checking');
        }
        return;
      }
      const away = lastAway.current;
      lastAway.current = null;
      if (!session.current) return;
      if ((away !== null && Date.now() - away >= 120_000) || Date.now() >= Date.parse(session.current.expiresAt)) {
        lock('unlock');
      } else {
        void checkAccess();
      }
    });
    return () => {
      disposed = true;
      listener.remove();
      clearTimeout(expired.current);
      epoch.current += 1;
    };
  }, []);

  const today = profile?.today;
  const timeZone = profile?.timeZone;
  useEffect(() => {
    const active = session.current;
    if (!today || !timeZone || !active) return;
    const attempt = epoch.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => !stopped && epoch.current === attempt && session.current === active &&
      AppState.currentState === 'active' && Date.now() < Date.parse(active.expiresAt);
    const tick = async () => {
      if (!current()) return;
      const revision = zoneRevision.current;
      if (!zoneOperation.current && dateInTimeZone(new Date(), timeZone) !== today) {
        try {
          const next = await request('me', { token: active.token });
          if (current() && revision === zoneRevision.current) setProfile(next);
        } catch (error) {
          if (current() && revision === zoneRevision.current) rejectAccess(errorCode(error));
        }
      }
      if (current()) scheduleTick();
    };
    const scheduleTick = () => { timer = setTimeout(() => void tick(), 60_000 - Date.now() % 60_000); };
    scheduleTick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [today, timeZone]);

  async function run(action: () => Promise<void>) {
    if (operation.current || zoneOperation.current) return;
    operation.current = true;
    Keyboard.dismiss();
    setBusy(true);
    setNotice('');
    try { await action(); }
    catch (error) { setNotice(errorCode(error)); }
    finally {
      setPin('');
      setConfirm('');
      operation.current = false;
      setBusy(false);
    }
  }

  async function accept(next: Result<'activate'>, attempt: number) {
    if (epoch.current !== attempt || AppState.currentState !== 'active') return;
    session.current = next;
    clearTimeout(expired.current);
    expired.current = setTimeout(() => lock('unlock'), Math.max(0, Date.parse(next.expiresAt) - Date.now()));
    await checkAccess();
  }

  async function activate() {
    if (!/^[0-9]{4}$/.test(pin) || pin !== confirm) throw new ApiError('PIN_MISMATCH');
    const attempt = epoch.current;
    const value = installation ?? await secret();
    await saveInstallation(value);
    setInstallation(value);
    if (epoch.current !== attempt) {
      setMode('unlock');
      return;
    }
    try {
      const result = await request('activate', { body: { email, code, pin, installationSecret: value } });
      setCode('');
      setMode('unlock');
      await accept(result, attempt);
    } catch (error) {
      if (errorCode(error) === 'NETWORK') setMode('unlock');
      throw error;
    }
  }

  async function unlock(withBiometrics: boolean) {
    if (!installation) return;
    let biometricSecret: string | null = null;
    if (withBiometrics) {
      if (!Store.canUseBiometricAuthentication()) throw new ApiError('BIOMETRICS_INVALID');
      try {
        biometricSecret = await readBiometrics();
      } catch {
        throw new ApiError('BIOMETRICS_INVALID');
      }
      if (!biometricSecret) {
        invalidatedBiometrics.current = true;
        throw new ApiError('BIOMETRICS_INVALID');
      }
    }
    if (AppState.currentState !== 'active') return;
    const attempt = epoch.current;
    try {
      const result = await request('unlock', { body: biometricSecret
        ? { installationSecret: installation, biometricSecret }
        : { installationSecret: installation, pin } });
      if (!withBiometrics && invalidatedBiometrics.current) {
        try {
          await request('disableBiometrics', { token: result.token });
          await clearBiometrics();
          invalidatedBiometrics.current = false;
          setEnabled(false);
        } catch {
          setNotice('BIOMETRICS_INVALID');
        }
      }
      await accept(result, attempt);
    } catch (error) {
      if (errorCode(error) === 'BIOMETRICS_INVALID') invalidatedBiometrics.current = true;
      if (errorCode(error) === 'PIN_LOCKED' || errorCode(error) === 'DEVICE_REVOKED') lock('activate');
      throw error;
    }
  }

  async function logout() {
    const value = session.current?.token;
    lock('activate');
    setInstallation(null);
    setEnabled(false);
    invalidatedBiometrics.current = false;
    try {
      await forgetInstallation();
    } catch (error) {
      setMode('storage');
      throw error;
    }
    if (value) {
      try {
        await request('logout', { body: {}, token: value });
        setNotice('onlineLogout');
        return;
      } catch (error) {
        if (errorCode(error) === 'DEVICE_REVOKED') {
          setNotice('onlineLogout');
          return;
        }
      }
    }
    setNotice('offlineLogout');
  }

  function reset() {
    Alert.alert(t.resetTitle, undefined, [
      { text: t.cancel, style: 'cancel' },
      { text: t.reset, style: 'destructive', onPress: () => void run(logout) },
    ]);
  }

  async function changeBiometrics() {
    const value = session.current?.token;
    if (!value) return;
    if (enabled) {
      await request('disableBiometrics', { token: value });
      await clearBiometrics();
      setEnabled(false);
      return;
    }
    if (!Store.canUseBiometricAuthentication()) throw new ApiError('BIOMETRICS_INVALID');
    const biometricSecret = await secret();
    await saveBiometrics(biometricSecret);
    try {
      await request('enableBiometrics', { token: value, body: { pin, biometricSecret } });
      setEnabled(true);
      setSetup(false);
    } catch (error) {
      await clearBiometrics();
      if (errorCode(error) === 'PIN_LOCKED' || errorCode(error) === 'DEVICE_REVOKED') lock('activate');
      throw error;
    }
  }

  const activeSession = session.current;
  const financeEpoch = epoch.current;
  function rejectAccess(code: string) {
    if (code !== 'SESSION_EXPIRED' && code !== 'DEVICE_REVOKED' && code !== 'PIN_LOCKED') return false;
    if (epoch.current === financeEpoch && session.current === activeSession) {
      setNotice(code);
      lock(code === 'SESSION_EXPIRED' ? 'unlock' : 'activate');
    }
    return true;
  }
  const access = profile && activeSession && mode === 'profile' ? {
    token: activeSession.token,
    profile,
    isCurrent: () => epoch.current === financeEpoch && session.current === activeSession &&
      Date.now() < Date.parse(activeSession.expiresAt) && AppState.currentState === 'active',
    onAccessFailure: rejectAccess,
  } : null;
  const deviceZone = getCalendars()[0]?.timeZone;
  const suggestedZone = deviceZone && /^[A-Za-z][A-Za-z0-9_+/-]*$/.test(deviceZone) ? deviceZone : null;

  async function saveTimeZone(value: string) {
    if (!access?.isCurrent() || zoneOperation.current || operation.current) return;
    const selected = value.trim();
    if (selected.length > 64 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(selected)) {
      setTimeZoneNotice('INVALID_REQUEST');
      return;
    }
    zoneOperation.current = true;
    const revision = ++zoneRevision.current;
    Keyboard.dismiss();
    setBusy(true);
    setTimeZoneNotice('');
    try {
      const next = await request('setTimeZone', { token: access.token, body: { timeZone: selected } });
      if (!access.isCurrent()) return;
      setProfile(next);
      setTimeZoneDraft(null);
      setTimeZoneNotice('saved');
    } catch (error) {
      if (!access.isCurrent()) return;
      const reason = errorCode(error);
      if (!access.onAccessFailure(reason)) setTimeZoneNotice(reason);
    } finally {
      if (revision === zoneRevision.current) {
        zoneOperation.current = false;
        setBusy(false);
      }
    }
  }
  const zoneMessage = timeZoneNotice === 'saved' ? t.timeZoneSaved : timeZoneNotice === 'INVALID_REQUEST' ? t.invalidTimeZone
    : timeZoneNotice ? t.errors[timeZoneNotice] ?? t.generic : '';
  function selectLanguage(next: Language) {
    setLang(next);
    setLanguageError(false);
    const pending = (languageWrite.current ?? Promise.resolve()).then(() => Store.setItemAsync('language', next));
    const handled = pending.catch(() => {
      if (languageWrite.current === handled) setLanguageError(true);
    });
    languageWrite.current = handled;
  }
  const action = (label: string, handler: () => void, primary = false) => (
    <Pressable accessibilityRole="button" disabled={busy} onPress={handler}
      style={[styles.button, primary && styles.primary, busy && styles.disabled]}>
      <Text style={primary ? styles.primaryText : styles.link}>{label}</Text>
    </Pressable>
  );
  const field = (label: string, value: string, setter: (value: string) => void,
    options: { secure?: boolean; numeric?: boolean; email?: boolean } = {}) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={setter} editable={!busy}
        style={styles.input} autoCorrect={false} autoCapitalize="none"
        secureTextEntry={options.secure} maxLength={options.numeric ? 4 : undefined}
        keyboardType={options.numeric ? 'number-pad' : options.email ? 'email-address' : 'default'} />
    </View>
  );

  const noticeMessage = notice === 'onlineLogout' || notice === 'offlineLogout' ? t[notice] : t.errors[notice] ?? t.generic;
  const status = notice !== '' && <Text accessibilityRole="alert" style={styles.notice}>{noticeMessage}</Text>;

  const settings = access && <SettingsScreen lang={lang} profile={access.profile} busy={busy} languageError={languageError}
    zoneEditing={timeZoneDraft !== null}
    biometricsEnabled={enabled} onLanguage={selectLanguage}
    onTimeZone={() => {
      setTimeZoneNotice('');
      setTimeZoneDraft(timeZoneDraft === null ? access.profile.timeZone : null);
    }}
    onBiometrics={() => {
      if (enabled) void run(changeBiometrics);
      else {
        setPin('');
        setSetup(!setup);
        setNotice('');
      }
    }}
    onSignOut={() => void run(logout)}
    notice={status}
    zoneEditor={timeZoneDraft !== null || !!zoneMessage ? <View style={styles.settingsEditor}>
      {timeZoneDraft !== null && <>
        <Text style={styles.label}>{t.timeZoneIdentifier}</Text>
        <TextInput accessibilityLabel={t.timeZoneIdentifier} value={timeZoneDraft} onChangeText={setTimeZoneDraft}
          style={styles.input} editable={!busy} autoCorrect={false} autoCapitalize="none" maxLength={64}
          returnKeyType="done" onSubmitEditing={Keyboard.dismiss} testID="finance-time-zone-input" />
        {suggestedZone && suggestedZone !== timeZoneDraft && <FinanceButton title={t.usePhoneTimeZone + ' · ' + suggestedZone}
          onPress={() => setTimeZoneDraft(suggestedZone)} disabled={busy} />}
        <FinanceButton title={t.saveTimeZone} onPress={() => void saveTimeZone(timeZoneDraft)} primary disabled={busy}
          testID="finance-save-time-zone" />
        <FinanceButton title={t.cancel} onPress={() => { setTimeZoneDraft(null); setTimeZoneNotice(''); }} disabled={busy} />
      </>}
      {!!zoneMessage && <Text accessibilityRole={timeZoneNotice === 'saved' ? undefined : 'alert'}
        accessibilityLiveRegion="polite" style={timeZoneNotice === 'saved' ? styles.label : styles.notice}>{zoneMessage}</Text>}
    </View> : undefined}
    biometricEditor={setup && <View style={styles.settingsEditor}>
      {field(t.pin, pin, setPin, { secure: true, numeric: true })}
      <FinanceButton title={t.enable} onPress={() => void run(changeBiometrics)}
        primary disabled={busy || !/^\d{4}$/.test(pin)} testID="finance-enable-biometrics" />
      <FinanceButton title={t.cancel} onPress={() => { setPin(''); setSetup(false); }} disabled={busy} />
    </View>}
  />;
  const timeZoneSuggestion = access && !access.profile.timeZoneConfigured ? <View style={styles.zoneSuggestion}>
    <Text style={styles.label}>{t.timeZoneSuggestion}</Text>
    {suggestedZone && suggestedZone !== 'UTC' && <FinanceButton title={t.usePhoneTimeZone + ' · ' + suggestedZone}
      onPress={() => void saveTimeZone(suggestedZone)} disabled={busy} testID="finance-suggest-time-zone" />}
    <FinanceButton title={t.keepUtc} onPress={() => void saveTimeZone('UTC')} disabled={busy} testID="finance-suggest-utc" />
    {!!zoneMessage && <Text accessibilityRole="alert" style={styles.notice}>{zoneMessage}</Text>}
  </View> : undefined;

  const signedOut = <SafeAreaView style={styles.safe}>
    <ScrollView automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
      <View style={styles.header}>
        <FinanceBrand title={t.appName} />
        <Pressable accessibilityRole="button" accessibilityLabel={lang === 'en' ? 'Русский' : 'English'}
          onPress={() => selectLanguage(lang === 'en' ? 'ru' : 'en')}>
          <Text style={styles.language}>{lang === 'en' ? 'RU' : 'EN'}</Text>
        </Pressable>
      </View>
      {languageError && <Text accessibilityRole="alert" style={styles.notice}>{t.languageSaveFailed}</Text>}
      {mode === 'activate' && <>
        <Text style={styles.heading}>{t.activate}</Text>
        {field(t.email, email, setEmail, { email: true })}
        {field(t.code, code, setCode)}
        {field(t.pin, pin, setPin, { secure: true, numeric: true })}
        {field(t.repeat, confirm, setConfirm, { secure: true, numeric: true })}
        {action(t.activate, () => void run(activate), true)}
        {installation && action(t.usePin, () => setMode('unlock'))}
        {installation && action(t.reset, reset)}
      </>}
      {mode === 'unlock' && <>
        <Text style={styles.heading}>{t.unlock}</Text>
        {field(t.pin, pin, setPin, { secure: true, numeric: true })}
        {action(t.usePin, () => void run(() => unlock(false)), true)}
        {enabled && action(t.biometrics, () => void run(() => unlock(true)))}
        {action(t.activateAgain, () => setMode('activate'))}
        {action(t.reset, reset)}
      </>}
      {(mode === 'loading' || mode === 'checking') && <Text style={styles.heading}>{t.checking}</Text>}
      {mode === 'checking' && checkingFailed && session.current && <>
        {action(t.retry, () => void checkAccess(), true)}
        {action(t.signOut, () => void run(logout))}
      </>}
      {mode === 'storage' && action(t.retry, () => void initialize(), true)}
      {status}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: supportOpen }}
        onPress={() => setSupportOpen(!supportOpen)} testID="support-open" style={styles.button}>
        <Text style={styles.link}>{t.support}</Text>
      </Pressable>
      {supportOpen && <View style={styles.support}><SupportScreen lang={lang} /></View>}
    </ScrollView>
  </SafeAreaView>;

  return <AccessContext value={{ access, lang, settings, settingsBusy: busy, clearSettingsDraft,
    restoreSettings: settingsFocused.current, setSettingsFocused: (focused) => { settingsFocused.current = focused; },
    startupReady, timeZoneSuggestion, signedOut }}>
    {children}
  </AccessContext>;
}

function errorCode(error: unknown) {
  return error instanceof ApiError ? error.message : 'STORAGE';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.panel },
  page: { width: '100%', maxWidth: 540, alignSelf: 'center', padding: 24, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 26 },
  language: { color: palette.accent, padding: 12, minHeight: 44, fontWeight: '700' },
  heading: { color: palette.ink, fontSize: 30, fontWeight: '700', marginBottom: 12 },
  field: { gap: 6 }, label: { fontSize: 15, color: palette.ink },
  input: { minHeight: 48, borderWidth: 1, borderColor: palette.control, borderRadius: 8,
    color: palette.ink, padding: 12, fontSize: 17, backgroundColor: palette.panel },
  button: { minHeight: 44, justifyContent: 'center', alignItems: 'flex-start' },
  primary: { backgroundColor: palette.accent, borderRadius: 8, alignItems: 'center', padding: 8, marginTop: 8 },
  primaryText: { color: palette.panel, fontSize: 16, fontWeight: '700' },
  link: { color: palette.accent, fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.55 }, notice: { color: palette.danger, fontSize: 15 },
  support: { paddingVertical: 12, borderTopWidth: 1, borderColor: palette.line },
  zoneSuggestion: { gap: 8, padding: 12, backgroundColor: palette.panel, borderRadius: 12, borderWidth: 1, borderColor: palette.line },
  settingsEditor: { gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
});
