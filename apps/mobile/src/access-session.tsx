import { createContext, use, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ComponentRef, ReactNode, RefObject } from 'react';
import {
  AppState, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { KeyboardAwareScrollView, KeyboardController, KeyboardToolbar } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { getCalendars, getLocales } from 'expo-localization';
import * as Store from 'expo-secure-store';
import * as Capture from 'expo-screen-capture';
import type { Language, Result } from '@teta/contracts';
import { AccessCheckScreen } from './access-check-screen';
import { ApiError, request } from './api';
import { copy } from './copy';
import type { FinanceAccess } from './finance-commands';
import { dateInTimeZone } from './finance-format';
import { FinanceBrand, FinanceButton, palette } from './finance-ui';
import { SettingsScreen } from './settings-screen';
import { SupportScreen } from './support-screen';
import { TimeZonePicker } from './time-zone-picker';
import { timeZoneCityId, timeZoneLabel } from './time-zones';
import { UnlockScreen } from './unlock-screen';
import {
  clearBiometrics, clearPendingInstallation, enableScenePrivacy, forgetInstallation, hasBiometrics, initializeInstallation,
  markBiometricsEnabled, readBiometrics, saveBiometrics, saveInstallation, secret,
} from './installation';

type Mode = 'loading' | 'activate' | 'recovery' | 'verify' | 'unlock' | 'checking' | 'profile' | 'storage';
type ActivationInput = ComponentRef<typeof TextInput>;

const AccessContext = createContext<{
  access: FinanceAccess | null;
  lang: Language;
  settings: ReactNode;
  settingsBusy: boolean;
  clearSettingsDraft: () => void;
  restoreSettings: boolean;
  setSettingsFocused: (focused: boolean) => void;
  runProfilePhotoPicker: <T>(pick: () => Promise<T>) => Promise<T | undefined>;
  startupReady: boolean;
  setSplashHidden: (hidden: boolean) => void;
  showsUnlockScreen: boolean;
  timeZoneSuggestion: ReactNode;
  signedOut: ReactNode;
} | null>(null);

export function useAccessSession() {
  const value = use(AccessContext);
  if (!value) throw new Error('AccessProvider is missing');
  return value;
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const { bottom } = useSafeAreaInsets();
  const [lang, setLang] = useState<Language>(getLocales()[0]?.languageCode === 'ru' ? 'ru' : 'en');
  const [languageError, setLanguageError] = useState(false);
  const languageWrite = useRef<Promise<void> | undefined>(undefined);
  const t = copy[lang];
  const [startupReady, setStartupReady] = useState(false);
  const [splashHidden, setSplashHidden] = useState(false);
  const [mode, setMode] = useState<Mode>('loading');
  const [installation, setInstallation] = useState<string | null>(null);
  const [pendingInstallation, setPendingInstallation] = useState<string | null>(null);
  const [installationBlocked, setInstallationBlocked] = useState(false);
  const [profile, setProfile] = useState<Result<'me'> | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const settingsFocused = useRef(false);
  const [timeZoneDraft, setTimeZoneDraft] = useState<string | null>(null);
  const [timeZoneNotice, setTimeZoneNotice] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [biometricsReset, setBiometricsReset] = useState(false);
  const [biometricNotice, setBiometricNotice] = useState('');
  const [checkingFailed, setCheckingFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const codeInput = useRef<ActivationInput>(null);
  const pinInput = useRef<ActivationInput>(null);
  const confirmInput = useRef<ActivationInput>(null);
  const session = useRef<Result<'activate'> | null>(null);
  const epoch = useRef(0);
  const lastAway = useRef<number | null>(null);
  const expired = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invalidatedBiometrics = useRef(false);
  const biometricPrompt = useRef(false);
  const triedStartupBiometrics = useRef(false);
  const operation = useRef(false);
  const zoneOperation = useRef(false);
  const zoneRevision = useRef(0);
  const protectedPreview = useRef(false);
  const profilePhotoPicker = useRef<symbol | undefined>(undefined);

  function clearSettingsDraft() {
    if (operation.current || zoneOperation.current) return;
    setTimeZoneDraft(null);
    setTimeZoneNotice('');
    setBiometricNotice('');
    setNotice('');
  }

  function lock(next: Mode) {
    epoch.current += 1;
    profilePhotoPicker.current = undefined;
    session.current = null;
    clearTimeout(expired.current);
    setProfile(null);
    settingsFocused.current = false;
    setTimeZoneDraft(null);
    setTimeZoneNotice('');
    setPin('');
    setConfirm('');
    setBiometricNotice('');
    if (next === 'recovery') setInstallationBlocked(true);
    setMode(next);
  }

  async function initialize() {
    setMode('loading');
    try {
      if (!protectedPreview.current) {
        if (Platform.OS === 'ios') {
          if (enableScenePrivacy) await enableScenePrivacy();
          else await Capture.enableAppSwitcherProtectionAsync(1);
        } else await Capture.preventScreenCaptureAsync('teta-access');
        protectedPreview.current = true;
      }
      const { active, pending } = await initializeInstallation();
      setInstallation(active);
      setPendingInstallation(pending);
      setInstallationBlocked(false);
      setEnabled(await hasBiometrics());
      setNotice('');
      setMode(pending ? 'verify' : active ? 'unlock' : 'activate');
    } catch {
      setMode('storage');
      setNotice('STORAGE');
    }
  }

  async function checkAccess(keepUnlockScreen = false) {
    const active = session.current;
    if (!active || AppState.currentState !== 'active') return;
    const attempt = ++epoch.current;
    setProfile(null);
    setCheckingFailed(false);
    if (!keepUnlockScreen) setMode('checking');
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
      else if (reason === 'DEVICE_REVOKED' || reason === 'PIN_LOCKED') lock('recovery');
      else setMode('checking');
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
      // The system dialog can briefly make iOS inactive while the app is still in the foreground.
      if (state === 'inactive' && biometricPrompt.current) return;
      if (state !== 'active') {
        lastAway.current ??= Date.now();
        // The native photo picker can move the editor to the background briefly.
        if (profilePhotoPicker.current) return;
        epoch.current += 1;
        if (zoneOperation.current) {
          zoneOperation.current = false;
          zoneRevision.current += 1;
          setBusy(false);
        }
        if (state === 'background') {
          setPin('');
          setConfirm('');
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
      if (away === null || !session.current) return;
      if (Date.now() - away >= 120_000 || Date.now() >= Date.parse(session.current.expiresAt)) {
        lock('unlock');
      } else if (!profilePhotoPicker.current) {
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

  const tryStartupBiometrics = useEffectEvent(() => {
    if (triedStartupBiometrics.current || AppState.currentState !== 'active') return;
    triedStartupBiometrics.current = true;
    if (mode === 'unlock' && enabled && Store.canUseBiometricAuthentication()) {
      void run(() => unlock({ biometrics: true }));
    }
  });

  useEffect(() => {
    if (!splashHidden) return;
    tryStartupBiometrics();
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') tryStartupBiometrics();
    });
    return () => listener.remove();
  }, [splashHidden]);

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
    void KeyboardController.dismiss();
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
    await checkAccess(true);
  }

  async function finishActivation(value: string, result: Result<'activate'>, attempt: number) {
    await clearBiometrics();
    setEnabled(false);
    invalidatedBiometrics.current = false;
    setBiometricsReset(false);
    await saveInstallation(value);
    setInstallation(value);
    setInstallationBlocked(false);
    setPendingInstallation(null);
    // A stale pending entry that matches the active installation is ignored on startup.
    await clearPendingInstallation().catch(() => {});
    setCode('');
    setMode('unlock');
    await accept(result, attempt);
  }

  async function activate() {
    if (!/^[0-9]{4}$/.test(pin) || pin !== confirm) throw new ApiError('PIN_MISMATCH');
    const attempt = epoch.current;
    const value = pendingInstallation ?? await secret();
    if (epoch.current !== attempt || AppState.currentState !== 'active') return;
    await saveInstallation(value, true);
    setPendingInstallation(value);
    if (epoch.current !== attempt || AppState.currentState !== 'active') return;
    let result: Result<'activate'>;
    try {
      result = await request('activate', { body: { email, code, pin, installationSecret: value } });
    } catch (error) {
      const reason = errorCode(error);
      if (['ACTIVATION_INVALID', 'RATE_LIMITED', 'INVALID_REQUEST', 'API_CONFIGURATION'].includes(reason)) {
        if (!pendingInstallation) {
          await clearPendingInstallation();
          setPendingInstallation(null);
        }
      } else setMode('verify');
      throw error;
    }
    setMode('verify');
    if (epoch.current !== attempt || AppState.currentState !== 'active') return;
    await finishActivation(value, result, attempt);
  }

  async function unlock(method: { pin: string } | { biometrics: true }) {
    const verifyingActivation = mode === 'verify';
    const value = verifyingActivation ? pendingInstallation : installation;
    if (!value || AppState.currentState !== 'active') return;
    const attempt = epoch.current;
    const current = () => epoch.current === attempt && AppState.currentState === 'active';
    let credentials: { pin: string } | { biometricSecret: string };
    if ('biometrics' in method) {
      if (!Store.canUseBiometricAuthentication()) throw new ApiError('BIOMETRICS_INVALID');
      let biometricSecret: string | null;
      try {
        biometricSecret = await withBiometricPrompt(attempt, () => readBiometrics(t.biometrics));
      } catch {
        if (epoch.current !== attempt) return;
        throw new ApiError('BIOMETRICS_INVALID');
      }
      if (!current()) return;
      if (!biometricSecret) {
        invalidatedBiometrics.current = true;
        throw new ApiError('BIOMETRICS_INVALID');
      }
      credentials = { biometricSecret };
    } else credentials = method;
    if (!current()) return;
    let result: Result<'unlock'>;
    try {
      result = await request('unlock', { body: { installationSecret: value, ...credentials } });
    } catch (error) {
      if (!current()) return;
      const reason = errorCode(error);
      if (reason === 'BIOMETRICS_INVALID') invalidatedBiometrics.current = true;
      if (reason === 'PIN_LOCKED' || reason === 'DEVICE_REVOKED') {
        if (verifyingActivation) {
          await clearPendingInstallation();
          setPendingInstallation(null);
          setMode(installation ? 'recovery' : 'activate');
        } else lock('recovery');
      }
      throw error;
    }
    if (!current()) return;
    if (verifyingActivation) {
      await finishActivation(value, result, attempt);
      return;
    }
    if ('pin' in method && invalidatedBiometrics.current) {
      try {
        await request('disableBiometrics', { token: result.token });
        await clearBiometrics();
        invalidatedBiometrics.current = false;
        setEnabled(false);
        setBiometricsReset(true);
      } catch {
        // Keep the reset pending for the next PIN unlock if revocation could not be completed.
      }
    }
    await accept(result, attempt);
  }

  async function logout() {
    const value = session.current?.token;
    lock('activate');
    setInstallation(null);
    setPendingInstallation(null);
    setInstallationBlocked(false);
    setEnabled(false);
    setBiometricsReset(false);
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

  async function withBiometricPrompt<T>(attempt: number, action: () => Promise<T>) {
    biometricPrompt.current = true;
    try {
      return await action();
    } finally {
      if (epoch.current === attempt && Platform.OS === 'ios' && AppState.currentState === 'inactive') {
        await waitForActive();
      }
      biometricPrompt.current = false;
    }
  }

  async function changeBiometrics() {
    const active = session.current;
    if (!active || !installation || AppState.currentState !== 'active') return;
    const attempt = epoch.current;
    const current = () => epoch.current === attempt && session.current === active && AppState.currentState === 'active';
    setBiometricNotice('');
    let clearPendingSecret = false;
    try {
      if (enabled) {
        await request('disableBiometrics', { token: active.token });
        setEnabled(false);
        await clearBiometrics();
        return;
      }
      if (!Store.canUseBiometricAuthentication()) throw new ApiError('BIOMETRICS_SETUP_UNAVAILABLE');
      const biometricSecret = await secret();
      if (!current()) return;
      clearPendingSecret = true;
      try {
        await withBiometricPrompt(attempt, () => saveBiometrics(biometricSecret, t.enable));
      } catch (error) {
        // SecureStore exposes cancellation through its native exception messages.
        if (error instanceof Error && /user canceled the (operation|authentication)/i.test(error.message)) return;
        throw new ApiError('BIOMETRICS_SETUP_FAILED');
      }
      if (!current()) return;
      await request('enableBiometrics', { token: active.token, body: { installationSecret: installation, biometricSecret } });
      await markBiometricsEnabled();
      clearPendingSecret = false;
      invalidatedBiometrics.current = false;
      setEnabled(true);
      setBiometricsReset(false);
    } catch (error) {
      const code = errorCode(error);
      if (current() && !rejectAccess(code)) {
        setBiometricNotice(!enabled && (code === 'BIOMETRICS_INVALID' || code === 'INVALID_REQUEST')
          ? 'BIOMETRICS_REGISTRATION_REJECTED' : code);
      }
    } finally {
      if (clearPendingSecret) await clearBiometrics().catch(() => {});
    }
  }

  const activeSession = session.current;
  const financeEpoch = epoch.current;
  function rejectAccess(code: string) {
    if (code !== 'SESSION_EXPIRED' && code !== 'DEVICE_REVOKED' && code !== 'PIN_LOCKED') return false;
    if (epoch.current === financeEpoch && session.current === activeSession) {
      setNotice(code);
      lock(code === 'SESSION_EXPIRED' ? 'unlock' : 'recovery');
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

  async function runProfilePhotoPicker<T>(pick: () => Promise<T>): Promise<T | undefined> {
    if (!access?.isCurrent() || profilePhotoPicker.current) return;
    const attempt = Symbol();
    profilePhotoPicker.current = attempt;
    try {
      const result = await pick();
      if (AppState.currentState !== 'active') await waitForActive();
      if (profilePhotoPicker.current !== attempt || !access.isCurrent()) return;
      await request('me', { token: access.token });
      if (profilePhotoPicker.current === attempt && access.isCurrent()) return result;
    } catch (error) {
      if (profilePhotoPicker.current !== attempt || !access.isCurrent()) return;
      if (!rejectAccess(errorCode(error))) throw error;
    } finally {
      if (profilePhotoPicker.current === attempt) profilePhotoPicker.current = undefined;
    }
  }
  const deviceZone = getCalendars()[0]?.timeZone;
  const suggestedZone = deviceZone && /^[A-Za-z][A-Za-z0-9_+/-]*$/.test(deviceZone) ? deviceZone : null;

  function openTimeZonePicker() {
    if (!access || operation.current || zoneOperation.current) return;
    setTimeZoneNotice('');
    setTimeZoneDraft(access.profile.timeZone);
  }

  function closeTimeZonePicker() {
    if (zoneOperation.current) return;
    setTimeZoneNotice('');
    setTimeZoneDraft(null);
  }

  async function saveTimeZone(value: string) {
    if (!access?.isCurrent() || zoneOperation.current || operation.current) return;
    const selected = value.trim();
    if (selected.length > 64 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(selected)) {
      setTimeZoneNotice('INVALID_REQUEST');
      return;
    }
    zoneOperation.current = true;
    const revision = ++zoneRevision.current;
    void KeyboardController.dismiss();
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
  const field = (label: string, value: string, setter: (value: string) => void, {
    numeric, email, testID, ref, next,
  }: { numeric?: boolean; email?: boolean; testID: string;
    ref?: RefObject<ActivationInput | null>; next?: RefObject<ActivationInput | null> }) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput ref={ref} accessibilityLabel={label} value={value} onChangeText={setter}
        editable={!busy} testID={testID}
        style={styles.input} autoCorrect={false} autoCapitalize="none"
        returnKeyType={numeric && Platform.OS === 'ios' ? undefined : next ? 'next' : 'done'}
        submitBehavior={next ? 'submit' : 'blurAndSubmit'}
        onSubmitEditing={next ? () => next.current?.focus() : undefined}
        secureTextEntry={numeric} maxLength={numeric ? 4 : undefined}
        keyboardType={numeric ? 'number-pad' : email ? 'email-address' : 'default'} />
    </View>
  );

  const noticeMessage = notice === 'onlineLogout' || notice === 'offlineLogout' ? t[notice] : t.errors[notice] ?? t.generic;
  const status = notice !== '' && <Text accessibilityRole="alert" style={styles.notice}>{noticeMessage}</Text>;
  const switchLanguage = () => selectLanguage(lang === 'en' ? 'ru' : 'en');

  function showAccessForm(next: Mode) {
    if (operation.current) return;
    setNotice('');
    setPin('');
    setConfirm('');
    setMode(next);
  }

  const settings = access && <SettingsScreen lang={lang} profile={access.profile} busy={busy} languageError={languageError}
    zoneEditing={timeZoneDraft !== null}
    biometricsEnabled={enabled} onLanguage={selectLanguage}
    onTimeZone={openTimeZonePicker}
    onBiometrics={() => void run(changeBiometrics)}
    onSignOut={() => void run(logout)}
    notice={biometricNotice
      ? <Text accessibilityRole="alert" style={styles.notice}>{t.errors[biometricNotice] ?? t.generic}</Text>
      : status || (biometricsReset && <Text style={styles.label}>{t.biometricSetupAgain}</Text>)}
    zoneNotice={timeZoneDraft === null && !!zoneMessage && <Text accessibilityRole={timeZoneNotice === 'saved' ? undefined : 'alert'}
      accessibilityLiveRegion="polite" style={[styles.settingsNotice, timeZoneNotice === 'saved' ? styles.label : styles.notice]}>
      {zoneMessage}
    </Text>}
  />;
  const timeZoneSuggestion = access && !access.profile.timeZoneConfigured ? <View style={styles.zoneSuggestion}>
    <Text style={styles.label}>{t.timeZoneSuggestion}</Text>
    <FinanceButton title={t.chooseTimeZone} onPress={openTimeZonePicker} primary disabled={busy}
      testID="finance-choose-time-zone" />
    {suggestedZone && timeZoneCityId(suggestedZone) !== 'UTC' && <FinanceButton
      title={t.usePhoneTimeZone + ' · ' + timeZoneLabel(suggestedZone, lang)}
      onPress={() => void saveTimeZone(suggestedZone)} disabled={busy} testID="finance-suggest-time-zone" />}
    <FinanceButton title={t.keepUtc} onPress={() => void saveTimeZone('UTC')} disabled={busy} testID="finance-suggest-utc" />
    {timeZoneDraft === null && !!zoneMessage && <Text accessibilityRole="alert" style={styles.notice}>{zoneMessage}</Text>}
  </View> : undefined;

  const showsUnlockScreen = mode === 'unlock' || mode === 'verify';
  const showsActivationForm = mode === 'activate' || mode === 'recovery';
  const showsKeyboardToolbar = showsActivationForm && Platform.OS === 'ios';
  // The keyboard controller scrolls to the caret. Leave room for the rest of the input below it.
  const keyboardBottomOffset = showsKeyboardToolbar ? 88 : 28;
  const canReturnToPin = !!installation && !installationBlocked;
  const showsAccessCheck = mode === 'loading' || mode === 'checking';
  const accessCheckFailed = mode === 'checking' && checkingFailed;
  const signedOut = showsUnlockScreen ? <UnlockScreen key={mode} lang={lang} busy={busy} message={notice ? noticeMessage : ''}
    languageError={languageError} onLanguage={switchLanguage} verifyingActivation={mode === 'verify'}
    canReturnToPin={mode === 'verify' && canReturnToPin}
    canUseBiometrics={mode === 'unlock' && enabled && !invalidatedBiometrics.current}
    onPin={(pin) => run(() => unlock({ pin }))} onBiometrics={() => void run(() => unlock({ biometrics: true }))}
    onRecovery={() => showAccessForm(installation ? 'recovery' : 'activate')}
    onReturnToPin={() => showAccessForm('unlock')} /> : showsAccessCheck ? <AccessCheckScreen
    lang={lang} languageError={languageError} onLanguage={switchLanguage} supportOpen={supportOpen}
    onToggleSupport={() => setSupportOpen(!supportOpen)} error={accessCheckFailed ? noticeMessage : undefined} busy={busy}
    onRetry={accessCheckFailed && session.current ? () => void checkAccess() : undefined}
    onSignOut={accessCheckFailed && session.current ? () => void run(logout) : undefined} />
    : <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
    <KeyboardAwareScrollView bottomOffset={keyboardBottomOffset}
      extraKeyboardSpace={showsKeyboardToolbar ? 42 : 0} disableScrollOnKeyboardHide
      contentInsetAdjustmentBehavior="never"
      keyboardDismissMode={showsActivationForm ? 'none' : 'on-drag'}
      keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingBottom: styles.page.padding + bottom }]}>
      <View style={styles.header}>
        <FinanceBrand title={t.appName} />
        <Pressable accessibilityRole="button" accessibilityLabel={lang === 'en' ? 'Русский' : 'English'}
          onPress={switchLanguage}>
          <Text style={styles.language}>{lang === 'en' ? 'RU' : 'EN'}</Text>
        </Pressable>
      </View>
      {languageError && <Text accessibilityRole="alert" style={styles.notice}>{t.languageSaveFailed}</Text>}
      {showsActivationForm && <>
        <Text accessibilityRole="header" style={styles.heading}>{mode === 'recovery' ? t.recoverAccess : t.activate}</Text>
        {mode === 'recovery' && <Text style={styles.label}>{t.recoveryHint}</Text>}
        {field(t.email, email, setEmail, { email: true, testID: 'activation-email', next: codeInput })}
        {field(t.code, code, setCode, { testID: 'activation-code', ref: codeInput, next: pinInput })}
        {field(mode === 'recovery' ? t.newPin : t.pin, pin, setPin,
          { numeric: true, testID: 'activation-pin', ref: pinInput, next: confirmInput })}
        {field(t.repeat, confirm, setConfirm, { numeric: true, testID: 'activation-confirm', ref: confirmInput })}
        {action(t.activate, () => void run(activate), true)}
        {pendingInstallation && action(t.verifyActivationPin, () => showAccessForm('verify'))}
        {canReturnToPin && action(t.usePin, () => showAccessForm('unlock'))}
      </>}
      {mode === 'storage' && action(t.retry, () => void initialize(), true)}
      {status}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: supportOpen }}
        onPress={() => setSupportOpen(!supportOpen)} testID="support-open" style={styles.button}>
        <Text style={styles.link}>{t.support}</Text>
      </Pressable>
      {supportOpen && <View style={styles.support}><SupportScreen lang={lang} /></View>}
    </KeyboardAwareScrollView>
    {showsKeyboardToolbar && <KeyboardToolbar doneText={t.done} />}
  </SafeAreaView>;

  return <AccessContext value={{ access, lang, settings, settingsBusy: busy, clearSettingsDraft,
    restoreSettings: settingsFocused.current, setSettingsFocused: (focused) => { settingsFocused.current = focused; },
    runProfilePhotoPicker, startupReady, setSplashHidden, showsUnlockScreen, timeZoneSuggestion, signedOut }}>
    {children}
    {access && timeZoneDraft !== null && <TimeZonePicker lang={lang} current={access.profile.timeZone} device={suggestedZone}
      selected={timeZoneDraft} busy={busy} error={zoneMessage}
      onSelect={setTimeZoneDraft} onSave={() => void saveTimeZone(timeZoneDraft)} onClose={closeTimeZonePicker} />}
  </AccessContext>;
}

function waitForActive() {
  return new Promise<void>((resolve) => {
    const finish = () => {
      listener.remove();
      clearTimeout(timeout);
      resolve();
    };
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' || state === 'background') finish();
    });
    // Face ID can return a match before iOS finishes dismissing its success animation.
    const timeout = setTimeout(finish, 5_000);
  });
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
  settingsNotice: { paddingHorizontal: 12, paddingBottom: 12 },
});
