import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ProfileFields, Result } from '@teta/contracts';
import { useAccessSession } from './access-session';
import { request } from './api';
import { copy } from './copy';
import { financeCopy } from './finance-copy';
import { FinanceDateField } from './finance-date-field';
import { formatFinancialDate } from './finance-format';
import { FinanceAlert, FinanceButton, FinanceField, FinanceScrollView, palette, styles } from './finance-ui';
import { profileCopy } from './profile-copy';
import { ProfileAvatar, profileErrorCode, useProfileAvatar, useProfileSummary } from './profile-header';
import { chooseProfilePhoto } from './profile-photo';

type Profile = Result<'getPersonalProfile'>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <View style={layout.section}>
    <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text>
    {children}
  </View>;
}

function DataRow({ title, value, extra }: { title: string; value: string | null; extra?: ReactNode }) {
  const { lang } = useAccessSession();
  return <View style={layout.dataRow}>
    <View style={layout.dataValue}>
      <Text style={styles.meta}>{title}</Text>
      <Text style={value ? styles.title : styles.meta}>{value ?? profileCopy[lang].unspecified}</Text>
    </View>
    {extra}
  </View>;
}

function PassportNumber({ number }: { number: string | null }) {
  const { lang } = useAccessSession();
  const t = profileCopy[lang];
  const [visible, setVisible] = useState(false);
  return <DataRow title={t.passportNumber} value={number && (visible ? number : '••••••')}
    extra={number && <Pressable accessibilityRole="button" onPress={() => setVisible(!visible)}
      testID="profile-toggle-passport" style={({ pressed }) => [layout.textButton, pressed && styles.dimmed]}>
      <Text style={layout.link}>{visible ? t.hidePassport : t.showPassport}</Text>
    </Pressable>} />;
}

function ProfileDetails({ profile }: { profile: Profile }) {
  const { access, lang } = useAccessSession();
  const { fields, summary } = profile;
  const t = profileCopy[lang];
  const jpeg = useProfileAvatar(access, summary.avatarVersion);
  const name = [fields.lastName, fields.firstName, fields.patronymic].filter(Boolean).join(' ');
  return <>
    <View style={layout.identity}>
      <ProfileAvatar size={84} initials={summary.initials} jpeg={jpeg} testID="profile-avatar" />
      <Text accessibilityRole="header" style={layout.fullName} testID="profile-full-name">{name || t.unspecified}</Text>
    </View>
    <Section title={t.details}>
      <View style={styles.surface}>
        <DataRow title={t.birthDate} value={fields.birthDate && formatFinancialDate(fields.birthDate, lang)} />
      </View>
    </Section>
    <Section title={t.passport}>
      <View style={styles.surface}>
        <DataRow title={t.passportSeries} value={fields.passportSeries} />
        <View style={layout.rule} />
        <PassportNumber number={fields.passportNumber} />
      </View>
    </Section>
    <Section title={t.registrationAddress}>
      <View style={styles.surface}>
        <Text style={[fields.registrationAddress ? styles.title : styles.meta, layout.address]}>
          {fields.registrationAddress ?? t.unspecified}
        </Text>
      </View>
    </Section>
  </>;
}

function ProfileEditor({ initial }: { initial: Profile }) {
  const { access, lang, runProfilePhotoPicker } = useAccessSession();
  const router = useRouter();
  const { setSummary } = useProfileSummary();
  const t = profileCopy[lang];
  const [base, setBase] = useState(initial);
  const [fields, setFields] = useState(initial.fields);
  const [avatar, setAvatar] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reloaded, setReloaded] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const savedAvatar = useProfileAvatar(access, avatar === undefined ? base.summary.avatarVersion : null);
  const hasAvatar = avatar === undefined ? base.summary.avatarVersion !== null : avatar !== null;
  useEffect(() => () => inFlight.current?.abort(), []);

  if (!access) return null;
  const user = access;

  function change(key: keyof ProfileFields, value: string | null) {
    setFields((current) => ({ ...current, [key]: value }));
    setReloaded(false);
  }

  async function run(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (inFlight.current || !user.isCurrent()) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setError(undefined);
    setReloaded(false);
    try {
      await action(controller.signal);
    } catch (failure) {
      if (controller.signal.aborted || !user.isCurrent()) return;
      const code = profileErrorCode(failure);
      if (user.onAccessFailure(code)) return;
      setError(code === 'VERSION_CONFLICT' ? 'VERSION_CONFLICT' :
        code === 'INVALID_AVATAR' ? t.photoFailed : code === 'INVALID_BIRTH_DATE' ? t.invalidBirthDate : fallback);
    } finally {
      inFlight.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function pick() {
    void run(async (signal) => {
      const photo = await runProfilePhotoPicker(chooseProfilePhoto);
      if (photo && !signal.aborted && user.isCurrent()) setAvatar(photo);
    }, t.photoFailed);
  }

  function save() {
    void run(async (signal) => {
      const updated = await request('savePersonalProfile', {
        token: user.token, signal, body: { expectedVersion: base.version, fields, avatarJpeg: avatar },
      });
      if (!signal.aborted && user.isCurrent()) {
        setSummary(updated.summary);
        router.back();
      }
    }, t.saveFailed);
  }

  function reload() {
    void run(async (signal) => {
      const latest = await request('getPersonalProfile', { token: user.token, signal });
      if (signal.aborted || !user.isCurrent()) return;
      const merged = { ...latest.fields };
      for (const name of Object.keys(fields) as (keyof ProfileFields)[]) {
        if ((fields[name]?.trim() || null) !== base.fields[name]) merged[name] = fields[name];
      }
      setBase(latest);
      setFields(merged);
      setReloaded(true);
    }, t.loadFailed);
  }

  function field(key: Exclude<keyof ProfileFields, 'birthDate'>, maxLength: number, multiline = false) {
    return <FinanceField title={t[key]} testID={'profile-input-' + key} value={fields[key] ?? ''} editable={!busy}
      keyboardType="default" autoComplete="off" textContentType="none" importantForAutofill="no"
      autoCapitalize={key.startsWith('passport') ? 'none' : 'words'} maxLength={maxLength} multiline={multiline}
      onChangeText={(value) => change(key, value)} />;
  }

  return <>
    <View style={[styles.surface, layout.photoEditor]}>
      <ProfileAvatar size={68} initials={base.summary.initials} jpeg={avatar === undefined ? savedAvatar : avatar}
        testID="profile-avatar-preview" />
      <View style={layout.photoActions}>
        <Text accessibilityRole="header" style={styles.title}>{t.photo}</Text>
        <FinanceButton title={hasAvatar ? t.replacePhoto : t.choosePhoto} onPress={pick}
          disabled={busy} testID="profile-choose-photo" />
        {hasAvatar && <Pressable accessibilityRole="button" onPress={() => setAvatar(null)} disabled={busy}
          testID="profile-remove-photo" style={({ pressed }) => [layout.textButton, (pressed || busy) && styles.dimmed]}>
          <Text style={[layout.link, layout.remove]}>{t.removePhoto}</Text>
        </Pressable>}
      </View>
    </View>
    <Section title={t.details}>
      {field('lastName', 100)}
      {field('firstName', 100)}
      {field('patronymic', 100)}
      <FinanceDateField title={t.birthDate} lang={lang} value={fields.birthDate} today={user.profile.today}
        max={user.profile.today} testID="profile-input-birthDate" disabled={busy}
        onChange={(value) => change('birthDate', value)} onClear={() => change('birthDate', null)} />
    </Section>
    <Section title={t.passport}>
      {field('passportSeries', 32)}
      {field('passportNumber', 64)}
    </Section>
    {field('registrationAddress', 500, true)}
    {error && <FinanceAlert>{error === 'VERSION_CONFLICT' ? t.conflict : error}</FinanceAlert>}
    {reloaded && <Text accessibilityLiveRegion="polite" style={styles.meta}>{t.merged}</Text>}
    {error === 'VERSION_CONFLICT' && <FinanceButton title={t.reloadLatest} onPress={reload} disabled={busy} />}
    <FinanceButton title={t.save} onPress={save} primary
      disabled={busy || error === 'VERSION_CONFLICT'} testID="profile-save" />
  </>;
}

export function ProfileScreen({ editing = false }: { editing?: boolean }) {
  const { access, lang } = useAccessSession();
  const t = profileCopy[lang];
  const [profile, setProfile] = useState<Profile>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const load = useEffectEvent(async (signal: AbortSignal) => {
    if (!access?.isCurrent()) return;
    try {
      const next = await request('getPersonalProfile', { token: access.token, signal });
      if (!signal.aborted && access.isCurrent()) setProfile(next);
    } catch (failure) {
      if (!signal.aborted && access.isCurrent() && !access.onAccessFailure(profileErrorCode(failure))) setError(true);
    }
  });
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [retry, access?.token]);

  return <FinanceScrollView bottomOffset={16} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
    {profile ? editing ? <ProfileEditor initial={profile} /> : <ProfileDetails profile={profile} /> :
      error ? <>
        <FinanceAlert>{t.loadFailed}</FinanceAlert>
        <FinanceButton title={copy[lang].retry} onPress={() => { setError(false); setRetry(retry + 1); }} />
      </> : <ActivityIndicator color={palette.accent} accessibilityLabel={financeCopy[lang].loading} />}
  </FinanceScrollView>;
}

const layout = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: 17, paddingVertical: 12 },
  fullName: { flex: 1, color: palette.ink, fontSize: 25, fontWeight: '700' },
  section: { gap: 8 },
  dataRow: { minHeight: 58, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row',
    alignItems: 'center', flexWrap: 'wrap', columnGap: 12 },
  dataValue: { flex: 1, minWidth: 100, gap: 4 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.line },
  address: { padding: 14, lineHeight: 23 },
  textButton: { minHeight: 44, justifyContent: 'center' },
  link: { color: palette.accent, fontSize: 14, fontWeight: '600' },
  remove: { color: palette.danger },
  photoEditor: { flexDirection: 'row', alignItems: 'center', columnGap: 16, padding: 14 },
  photoActions: { flex: 1, alignItems: 'flex-start', gap: 6 },
});
