import { useMemo, useRef, useState } from 'react';
import {
  FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Language } from '@teta/contracts';
import { copy } from './copy';
import { FinanceIcon } from './finance-icon';
import { FinanceAlert, FinanceButton, palette, styles } from './finance-ui';
import { filterTimeZones, timeZoneOptions } from './time-zones';
import type { TimeZoneOption } from './time-zones';

export function TimeZonePicker({ lang, current, device, selected, busy, error, onSelect, onSave, onClose }: {
  lang: Language;
  current: string;
  device: string | null;
  selected: string;
  busy: boolean;
  error: string;
  onSelect: (id: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const t = copy[lang];
  const [query, setQuery] = useState('');
  const list = useRef<FlatList<TimeZoneOption>>(null);
  const options = useMemo(() => timeZoneOptions(lang, current, device), [lang, current, device]);
  const results = useMemo(() => filterTimeZones(options, query), [options, query]);

  return <Modal animationType="slide" onRequestClose={onClose}>
    <SafeAreaProvider style={layout.modal}>
      <SafeAreaView style={layout.safe} accessibilityViewIsModal>
        <KeyboardAvoidingView style={layout.panel} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={layout.header}>
            <View style={layout.titleRow}>
              <Text accessibilityRole="header" style={styles.section}>{t.timeZone}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t.close} accessibilityState={{ disabled: busy }}
                disabled={busy} onPress={onClose} style={({ pressed }) => [layout.close, (busy || pressed) && styles.dimmed]}>
                <FinanceIcon name="close" color={palette.muted} />
              </Pressable>
            </View>
            <TextInput accessibilityLabel={t.searchTimeZones} placeholder={t.searchTimeZones}
              placeholderTextColor={palette.muted} style={styles.input} value={query}
              onChangeText={(value) => { setQuery(value); list.current?.scrollToOffset({ offset: 0, animated: false }); }}
              editable={!busy} autoCorrect={false} autoCapitalize="none" returnKeyType="search"
              clearButtonMode="while-editing" testID="finance-time-zone-search" />
          </View>
          <FlatList ref={list} style={layout.list} contentContainerStyle={layout.rows} data={results}
            keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
            ListEmptyComponent={<Text style={layout.empty} accessibilityLiveRegion="polite">{t.noTimeZones}</Text>}
            renderItem={({ item }) => {
              const checked = item.id === selected;
              const detail = [item.offset !== item.name ? item.offset : '', item.device ? t.phoneTimeZone : '']
                .filter(Boolean).join(' · ');
              return <Pressable accessibilityRole="radio" accessibilityState={{ checked, disabled: busy }} disabled={busy}
                testID={'finance-time-zone-option-' + item.id} onPress={() => { onSelect(item.id); Keyboard.dismiss(); }}
                style={({ pressed }) => [layout.row, checked && layout.selected, pressed && styles.dimmed]}>
                <View style={layout.rowText}>
                  <Text style={styles.title}>{item.name}</Text>
                  {!!detail && <Text style={styles.meta}>{detail}</Text>}
                </View>
                {checked && <FinanceIcon name="check" color={palette.accent} />}
              </Pressable>;
            }} />
          <View style={layout.footer}>
            {!!error && <FinanceAlert>{error}</FinanceAlert>}
            <FinanceButton title={t.saveTimeZone} onPress={onSave} primary disabled={busy} testID="finance-save-time-zone" />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}

const layout = StyleSheet.create({
  modal: { flex: 1, backgroundColor: palette.panel },
  safe: { flex: 1 },
  panel: { flex: 1, width: '100%', maxWidth: 540, alignSelf: 'center' },
  header: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12, gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  rows: { paddingHorizontal: 18 },
  row: { minHeight: 52, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center',
    gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.line },
  rowText: { flex: 1, gap: 2 },
  selected: { backgroundColor: palette.selected },
  empty: { padding: 12, color: palette.muted, fontSize: 15 },
  footer: { paddingHorizontal: 18, paddingVertical: 12, gap: 8, borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line },
});
