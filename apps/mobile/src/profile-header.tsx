import { createContext, use, useEffect, useEffectEvent, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Result } from '@teta/contracts';
import { useAccessSession } from './access-session';
import { ApiError, request } from './api';
import type { FinanceAccess } from './finance-commands';
import { FinanceIcon } from './finance-icon';
import { palette } from './finance-ui';
import { profileCopy } from './profile-copy';

type Summary = Result<'getProfileSummary'>;
const SummaryContext = createContext<{ summary?: Summary; setSummary: (value: Summary) => void } | null>(null);

export function ProfileSummaryProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<Summary>();
  return <SummaryContext value={{ summary, setSummary }}>{children}</SummaryContext>;
}

export function useProfileSummary() {
  const value = use(SummaryContext);
  if (!value) throw new Error('ProfileSummaryProvider is missing');
  return value;
}

export function profileErrorCode(error: unknown) {
  return error instanceof ApiError ? error.message : 'NETWORK';
}

export function useProfileAvatar(access: FinanceAccess | null, avatarVersion: number | null | undefined) {
  const [photo, setPhoto] = useState<Result<'getProfileAvatar'> & { token: string }>();
  const load = useEffectEvent(async (signal: AbortSignal) => {
    if (avatarVersion == null || !access?.isCurrent()) return;
    try {
      const avatar = await request('getProfileAvatar', { token: access.token, signal });
      if (!signal.aborted && access.isCurrent() && avatar.version === avatarVersion) setPhoto({ ...avatar, token: access.token });
    } catch (error) {
      if (!signal.aborted && access.isCurrent()) access.onAccessFailure(profileErrorCode(error));
    }
  });
  const token = access?.token;
  useEffect(() => {
    const controller = new AbortController();
    setPhoto(undefined);
    void load(controller.signal);
    return () => controller.abort();
  }, [token, avatarVersion]);
  return photo && photo.version === avatarVersion && photo.token === token ? photo.jpeg : undefined;
}

export function ProfileAvatar({ jpeg, initials, size, testID }: {
  jpeg?: string | null; initials?: string | null; size: number; testID?: string;
}) {
  return <View accessible={false} importantForAccessibility="no-hide-descendants" testID={testID}
    style={[layout.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
    {jpeg ? <Image source={{ uri: 'data:image/jpeg;base64,' + jpeg }} style={layout.image}
      testID={testID && testID + '-photo'} /> :
      initials ? <Text allowFontScaling={false} style={[layout.initials, { fontSize: size * 0.34 }]}>{initials}</Text> :
        <FinanceIcon name="profile" color={palette.panel} size={size * 0.48} />}
  </View>;
}

export function ProfileHeader({ focused, refresh }: { focused: boolean; refresh: number }) {
  const { access, lang } = useAccessSession();
  const router = useRouter();
  const t = profileCopy[lang];
  const { summary, setSummary } = useProfileSummary();
  const jpeg = useProfileAvatar(access, summary?.avatarVersion);
  const name = [summary?.firstName, summary?.lastName].filter(Boolean).join(' ') || t.title;
  const read = useEffectEvent(async (signal: AbortSignal) => {
    if (!access?.isCurrent()) return;
    try {
      const next = await request('getProfileSummary', { token: access.token, signal });
      if (!signal.aborted && access.isCurrent()) setSummary(next);
    } catch (error) {
      if (!signal.aborted && access.isCurrent()) access.onAccessFailure(profileErrorCode(error));
    }
  });
  useEffect(() => {
    if (!focused) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [focused, refresh, access?.token]);
  return <Pressable testID="profile-open" accessibilityRole="button" accessibilityHint={t.open}
    accessibilityLabel={name} onPress={() => router.push('/profile')}
    style={({ pressed }) => [layout.header, pressed && layout.headerPressed]}>
    <View style={layout.avatarFrame}>
      <ProfileAvatar size={50} initials={summary?.initials} jpeg={jpeg} />
    </View>
    <View style={layout.identity}>
      <Text style={layout.name} numberOfLines={2} testID="profile-home-name">{name}</Text>
      <Text style={layout.detail}>{t.details}</Text>
    </View>
    <FinanceIcon name="chevron" color={palette.muted} size={18} />
  </Pressable>;
}

const layout = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 78, gap: 12, paddingHorizontal: 14,
    paddingVertical: 11, borderRadius: 18, backgroundColor: palette.panel, borderWidth: 1, borderColor: palette.line },
  headerPressed: { backgroundColor: palette.raised },
  avatarFrame: { padding: 3, borderRadius: 28, backgroundColor: palette.panel },
  identity: { flex: 1, gap: 3 },
  name: { fontSize: 21, fontWeight: '700', color: palette.ink },
  detail: { fontSize: 13, color: palette.muted },
  avatar: { alignItems: 'center', justifyContent: 'center', backgroundColor: palette.balanceSurface, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  initials: { color: palette.panel, fontWeight: '700' },
});
