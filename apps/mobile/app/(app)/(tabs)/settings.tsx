import { useEffect, useRef } from 'react';
import { useIsFocused } from 'expo-router';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAccessSession } from '../../../src/access-session';
import { useFinanceWorkspace } from '../../../src/finance-screen';
import { styles } from '../../../src/finance-ui';
import { AccountSettingsLink } from '../../../src/settings-screen';

export default function Settings() {
  const { access, lang, settings, clearSettingsDraft, setSettingsFocused } = useAccessSession();
  const { go } = useFinanceWorkspace();
  const focused = useIsFocused();
  const wasFocused = useRef(false);

  useEffect(() => {
    if (focused) setSettingsFocused(true);
    else if (wasFocused.current && access?.isCurrent()) {
      setSettingsFocused(false);
      clearSettingsDraft();
    }
    wasFocused.current = focused;
  }, [focused]);

  return <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
    <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" bottomOffset={12}
      keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
      <AccountSettingsLink lang={lang} onPress={() => go({ name: 'accountSettings' })} />
      {settings}
    </KeyboardAwareScrollView>
  </SafeAreaView>;
}
