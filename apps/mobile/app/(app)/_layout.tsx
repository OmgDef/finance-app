import { Stack } from 'expo-router';
import { useAccessSession } from '../../src/access-session';
import { FinanceWorkspace } from '../../src/finance-screen';
import { palette } from '../../src/finance-ui';

export const unstable_settings = { initialRouteName: '(tabs)' };

export default function FinanceLayout() {
  const { access, lang } = useAccessSession();
  if (!access) return null;
  return <FinanceWorkspace access={access} lang={lang}>
    <Stack screenOptions={{ headerStyle: { backgroundColor: palette.panel },
      headerTintColor: palette.accent, headerTitleStyle: { color: palette.ink }, headerBackButtonDisplayMode: 'minimal',
      contentStyle: { backgroundColor: palette.ground }, statusBarStyle: 'dark' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  </FinanceWorkspace>;
}
