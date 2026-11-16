import { Stack } from 'expo-router';
import { useAccessSession } from '../../src/access-session';
import { financeCopy } from '../../src/finance-copy';
import { FinanceWorkspace } from '../../src/finance-screen';
import { palette } from '../../src/finance-ui';
import { profileCopy } from '../../src/profile-copy';
import { ProfileSummaryProvider } from '../../src/profile-header';

export const unstable_settings = { initialRouteName: '(tabs)' };

export default function FinanceLayout() {
  const { access, lang } = useAccessSession();
  if (!access) return null;
  return <ProfileSummaryProvider key={access.token}><FinanceWorkspace access={access} lang={lang}>
    <Stack screenOptions={{ headerStyle: { backgroundColor: palette.panel },
      headerTintColor: palette.accent, headerTitleStyle: { color: palette.ink }, headerBackButtonDisplayMode: 'minimal',
      contentStyle: { backgroundColor: palette.ground }, statusBarStyle: 'dark' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="profile" options={{ title: profileCopy[lang].title }} />
      <Stack.Screen name="settings/profile" options={{ title: profileCopy[lang].details }} />
      <Stack.Screen name="accounts/[accountId]/cards/[cardId]/details" options={{ title: financeCopy[lang].cardDetails,
        headerShown: false, presentation: 'fullScreenModal' }} />
    </Stack>
  </FinanceWorkspace></ProfileSummaryProvider>;
}
