import { useEffect } from 'react';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import BootSplash from 'react-native-bootsplash';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { AccessProvider, useAccessSession } from '../src/access-session';
import { palette } from '../src/finance-ui';
import { unlockBackground } from '../src/unlock-screen';

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: palette.accent, background: palette.ground, card: palette.panel,
    text: palette.ink, border: palette.line },
};

function RootStack() {
  const { access, restoreSettings, startupReady, setSplashHidden, showsUnlockScreen } = useAccessSession();
  useEffect(() => {
    if (!startupReady) return;
    const frame = requestAnimationFrame(() => {
      void BootSplash.hide({ fade: true }).catch((error: unknown) => {
        console.warn('Could not hide the launch screen', error);
      }).finally(() => setSplashHidden(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [startupReady, setSplashHidden]);

  return <Stack screenOptions={{ headerShown: false, statusBarStyle: 'dark', contentStyle: { backgroundColor: palette.ground } }}>
    <Stack.Protected guard={!access} redirectTo={restoreSettings ? '/settings' : '/accounts'}>
      <Stack.Screen name="index" options={showsUnlockScreen ? {
        statusBarStyle: 'light', contentStyle: { backgroundColor: unlockBackground },
      } : undefined} />
    </Stack.Protected>
    <Stack.Protected guard={!!access} redirectTo="/">
      <Stack.Screen name="(app)" />
    </Stack.Protected>
  </Stack>;
}

export default function Layout() {
  return <ThemeProvider value={theme}>
    <KeyboardProvider preload={false}>
      <AccessProvider><RootStack /></AccessProvider>
    </KeyboardProvider>
  </ThemeProvider>;
}
