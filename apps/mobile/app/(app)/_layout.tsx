import { Stack } from 'expo-router';
import { getFocusedRouteNameFromRoute } from 'expo-router/react-navigation';
import { Pressable, StyleSheet } from 'react-native';
import { useAccessSession } from '../../src/access-session';
import { financeCopy } from '../../src/finance-copy';
import { FinanceIcon } from '../../src/finance-icon';
import { FinanceWorkspace, useFinanceWorkspace } from '../../src/finance-screen';
import { appTabs } from '../../src/finance-tabs';
import { FinanceMark, palette } from '../../src/finance-ui';

export const unstable_settings = { initialRouteName: '(tabs)' };

function FinanceStack() {
  const { lang } = useAccessSession();
  const { blocked, openNewAccount } = useFinanceWorkspace();
  const tabs = appTabs(lang);
  const add = financeCopy[lang].addAccount;

  return <Stack screenOptions={{ headerStyle: { backgroundColor: palette.panel },
    headerTintColor: palette.accent, headerTitleStyle: { color: palette.ink }, headerBackButtonDisplayMode: 'minimal',
    contentStyle: { backgroundColor: palette.ground }, statusBarStyle: 'dark' }}>
    <Stack.Screen name="(tabs)" options={({ route }) => {
      const selected = getFocusedRouteNameFromRoute(route);
      const tab = tabs.find(({ route }) => route === selected) ?? tabs[0];
      return {
        title: tab.title,
        headerLeft: tab.page === 'products' ? () => <FinanceMark /> : undefined,
        headerRight: tab.page === 'products' ? () => (
          <Pressable accessibilityRole="button" accessibilityLabel={add} accessibilityState={{ disabled: blocked }}
            testID="finance-add-account" disabled={blocked} onPress={openNewAccount} style={styles.action}>
            <FinanceIcon name="plus" color={blocked ? palette.muted : palette.accent} size={24} />
          </Pressable>
        ) : undefined,
      };
    }} />
  </Stack>;
}

export default function FinanceLayout() {
  const { access, lang } = useAccessSession();
  if (!access) return null;
  return <FinanceWorkspace access={access} lang={lang}><FinanceStack /></FinanceWorkspace>;
}

const styles = StyleSheet.create({
  action: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
