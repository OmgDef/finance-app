import { useEffect } from 'react';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import BootSplash from 'react-native-bootsplash';
import { AccessProvider, useAccessSession } from '../src/access-session';
import { palette } from '../src/finance-ui';

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: palette.accent, background: palette.ground, card: palette.panel,
    text: palette.ink, border: palette.line },
};

function RootStack() {
  const { access, restoreSettings, startupReady } = useAccessSession();
  useEffect(() => {
    if (!startupReady) return;
    const frame = requestAnimationFrame(() => {
      void BootSplash.hide({ fade: true }).catch((error: unknown) => {
        console.warn('Could not hide the launch screen', error);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [startupReady]);

  return <Stack screenOptions={{ headerShown: false, statusBarStyle: 'dark', contentStyle: { backgroundColor: palette.ground } }}>
    <Stack.Protected guard={!access} redirectTo={restoreSettings ? '/settings' : '/accounts'}>
      <Stack.Screen name="index" />
    </Stack.Protected>
    <Stack.Protected guard={!!access} redirectTo="/">
      <Stack.Screen name="(app)" />
    </Stack.Protected>
  </Stack>;
}

export default function Layout() {
  return <ThemeProvider value={theme}>
    <AccessProvider><RootStack /></AccessProvider>
  </ThemeProvider>;
}
