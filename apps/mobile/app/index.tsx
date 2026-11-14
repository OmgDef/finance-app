import { useEffect, useRef, useState } from 'react';
import {
  Alert, AppState, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getCalendars, getLocales } from 'expo-localization';
import * as Store from 'expo-secure-store';
import * as Capture from 'expo-screen-capture';
import type { Language, Result } from '@teta/contracts';
import { ApiError, request } from '../src/api';
import { copy } from '../src/copy';
import { FinanceScreen } from '../src/finance-screen';
import { financeCopy } from '../src/finance-copy';
import { dateInTimeZone } from '../src/finance-format';
import { FinanceButton } from '../src/finance-ui';
import { SupportScreen } from '../src/support-screen';
import {
  clearBiometrics, forgetInstallation, hasBiometrics, initializeInstallation,
  readBiometrics, saveBiometrics, saveInstallation, secret,
} from '../src/installation';

type Mode = 'loading' | 'activate' | 'unlock' | 'checking' | 'profile' | 'storage';

export default function AccessScreen() {
  const [lang, setLang] = useState<Language>(getLocales()[0]?.languageCode === 'ru' ? 'ru' : 'en');
  const t = copy[lang];
  const [mode, setMode] = useState<Mode>('loading');
  const [installation, setInstallation] = useState<string | null>(null);
  const [profile, setProfile] = useState<Result<'me'> | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
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

  function lock(next: Mode) {
    epoch.current += 1;
    session.current = null;
    clearTimeout(expired.current);
    setProfile(null);
    setShowProfile(false);
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
    void Store.getItemAsync('language').then((saved) => {
      if (!disposed && (saved === 'en' || saved === 'ru')) setLang(saved);
    }).catch(() => {});
    void initialize();
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
    if (operation.current) return;
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
  function toggleLanguage() {
    const next = lang === 'en' ? 'ru' : 'en';
    setLang(next);
    void Store.setItemAsync('language', next).catch(() => {});
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

  return <SafeAreaView style={styles.safe}>
    {access && <View style={styles.financeHeader}>
      <Text style={styles.brand}>{t.appName}</Text>
      <View style={styles.financeControls}>
        <Pressable accessibilityRole="button" accessibilityLabel={lang === 'en' ? 'Русский' : 'English'}
          onPress={toggleLanguage} testID="finance-language"><Text style={styles.language}>{lang === 'en' ? 'RU' : 'EN'}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => {
          setShowProfile(!showProfile);
          setTimeZoneDraft(null);
          setTimeZoneNotice('');
        }} testID="finance-toggle-profile">
          <Text style={styles.language}>{showProfile ? financeCopy[lang].products : t.profile}</Text>
        </Pressable>
      </View>
    </View>}
    {access && <FinanceScreen key={financeEpoch} access={access} lang={lang} visible={!showProfile}
      timeZoneSuggestion={profile && !profile.timeZoneConfigured ? <View style={styles.zoneSuggestion}>
        <Text style={styles.label}>{t.timeZoneSuggestion}</Text>
        {suggestedZone && suggestedZone !== 'UTC' && <FinanceButton title={t.usePhoneTimeZone + ' · ' + suggestedZone}
          onPress={() => void saveTimeZone(suggestedZone)} disabled={busy} testID="finance-suggest-time-zone" />}
        <FinanceButton title={t.keepUtc} onPress={() => void saveTimeZone('UTC')} disabled={busy} testID="finance-suggest-utc" />
        {!!zoneMessage && <Text accessibilityRole="alert" style={styles.notice}>{zoneMessage}</Text>}
      </View> : undefined} />}
    {(!access || showProfile) && <ScrollView automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
      {!access && <View style={styles.header}>
        <Text style={styles.brand}>{t.appName}</Text>
        <Pressable accessibilityRole="button" onPress={toggleLanguage}>
          <Text style={styles.language}>{lang === 'en' ? 'RU' : 'EN'}</Text>
        </Pressable>
      </View>}
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
      {mode === 'profile' && profile && <>
        <Text style={styles.heading}>{t.profile}</Text>
        <Text style={styles.label}>{profile.email}</Text>
        <View style={styles.zoneSuggestion}>
          <Text style={styles.brand}>{t.timeZone}</Text>
          <Text style={styles.label} testID="finance-current-time-zone">{profile.timeZone}</Text>
          {timeZoneDraft === null ? <FinanceButton title={t.editTimeZone} onPress={() => setTimeZoneDraft(profile.timeZone)}
            disabled={busy} testID="finance-edit-time-zone" /> : <>
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
        </View>
        {setup && field(t.pin, pin, setPin, { secure: true, numeric: true })}
        {action(enabled ? t.disable : t.enable, () => {
          if (enabled || setup) void run(changeBiometrics);
          else setSetup(true);
        })}
        {action(t.signOut, () => void run(logout))}
      </>}
      {(mode === 'loading' || mode === 'checking') && <Text style={styles.heading}>{t.checking}</Text>}
      {mode === 'checking' && checkingFailed && session.current && <>
        {action(t.retry, () => void checkAccess(), true)}
        {action(t.signOut, () => void run(logout))}
      </>}
      {mode === 'storage' && action(t.retry, () => void initialize(), true)}
      {notice !== '' && <Text accessibilityRole="alert" style={styles.notice}>
        {notice === 'onlineLogout' || notice === 'offlineLogout'
          ? t[notice] : t.errors[notice] ?? t.generic}
      </Text>}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: supportOpen }}
        onPress={() => setSupportOpen(!supportOpen)} testID="support-open" style={styles.button}>
        <Text style={styles.link}>{t.support}</Text>
      </Pressable>
      {supportOpen && <View style={styles.support}><SupportScreen lang={lang} /></View>}
    </ScrollView>}
  </SafeAreaView>;
}

function errorCode(error: unknown) {
  return error instanceof ApiError ? error.message : 'STORAGE';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#111715' },
  page: { width: '100%', maxWidth: 540, alignSelf: 'center', padding: 24, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 26 },
  financeHeader: { width: '100%', maxWidth: 540, alignSelf: 'center', paddingHorizontal: 20, flexDirection: 'row',
    flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', minHeight: 48 },
  financeControls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  brand: { fontSize: 17, fontWeight: '700', color: '#ebf2ee' },
  language: { color: '#a5dec1', padding: 12, minHeight: 44, fontWeight: '700' },
  heading: { color: '#ebf2ee', fontSize: 30, fontWeight: '700', marginBottom: 12 },
  field: { gap: 6 }, label: { fontSize: 15, color: '#c0cec6' },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#516258', borderRadius: 8,
    color: '#ebf2ee', padding: 12, fontSize: 17, backgroundColor: '#1a241f' },
  button: { minHeight: 44, justifyContent: 'center', alignItems: 'flex-start' },
  primary: { backgroundColor: '#b9e9cc', borderRadius: 8, alignItems: 'center', padding: 8, marginTop: 8 },
  primaryText: { color: '#17241b', fontSize: 16, fontWeight: '700' },
  link: { color: '#b9e9cc', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.55 }, notice: { color: '#f8c3a8', fontSize: 15 },
  support: { paddingVertical: 12, borderTopWidth: 1, borderColor: '#516258' },
  zoneSuggestion: { gap: 8, padding: 12, backgroundColor: '#1a241f', borderRadius: 8 },
});
