import { useEffect, useRef } from 'react';
import { useIsFocused } from 'expo-router';
import { Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAccessSession } from '../../../src/access-session';
import { styles } from '../../../src/finance-ui';

export default function Settings() {
  const { access, settings, clearSettingsDraft, setSettingsFocused } = useAccessSession();
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

  return <SafeAreaView edges={['left', 'right']} style={{ flex: 1 }}>
    <ScrollView contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
      {settings}
    </ScrollView>
  </SafeAreaView>;
}
