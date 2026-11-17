import { useEffect, useRef, useState } from 'react';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Language } from '@teta/contracts';
import { isComaBank } from './app-variant';
import { copy } from './copy';
import { financeCopy } from './finance-copy';
import { dateForPicker, dateFromPicker, formatFinancialDate } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { FinanceButton, palette, styles } from './finance-ui';

type Props = {
  title: string;
  lang: Language;
  value: string | null;
  today: string;
  onChange: (date: string) => void;
  onClear?: () => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  testID: string;
};

export function FinanceDateField({ title, lang, value, today, onChange, onClear, min = '1000-01-01',
  max = '9999-12-31', disabled, testID }: Props) {
  const t = financeCopy[lang];
  const [draft, setDraft] = useState<string>();
  const androidOpen = useRef(false);
  const unavailable = !!disabled || min > max;
  const allowClear = !!(onClear && value);
  const label = value ? formatFinancialDate(value, lang) : t.chooseDate;

  useEffect(() => {
    if (unavailable) setDraft(undefined);
    return () => {
      if (androidOpen.current) {
        androidOpen.current = false;
        void DateTimePickerAndroid.dismiss('date');
      }
    };
  }, [unavailable]);

  function clamp(date: string) {
    return date < min ? min : date > max ? max : date;
  }

  function open() {
    if (unavailable || androidOpen.current) return;
    const initial = clamp(value ?? today);
    void KeyboardController.dismiss();
    if (Platform.OS !== 'android') {
      setDraft(initial);
      return;
    }
    androidOpen.current = true;
    const onDismiss = () => { androidOpen.current = false; };
    DateTimePickerAndroid.open({
      mode: 'date', value: dateForPicker(initial), minimumDate: dateForPicker(min), maximumDate: dateForPicker(max),
      positiveButton: { label: copy[lang].done }, negativeButton: { label: copy[lang].cancel },
      onValueChange: (_, date) => {
        if (androidOpen.current) onChange(clamp(dateFromPicker(date)));
        onDismiss();
      },
      onDismiss,
      onError: onDismiss,
      ...(allowClear && {
        neutralButton: { label: t.clearDate },
        onNeutralButtonPress: () => {
          if (androidOpen.current) onClear?.();
          onDismiss();
        },
      }),
    });
  }

  const close = () => setDraft(undefined);
  return <View style={styles.field}>
    <Text style={styles.label}>{title}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityValue={{ text: label }}
      accessibilityState={{ disabled: unavailable, expanded: draft !== undefined }} disabled={unavailable}
      onPress={open} testID={testID} style={({ pressed }) => [styles.input, layout.trigger,
        (unavailable || pressed) && styles.dimmed]}>
      <Text style={[layout.date, !value && layout.placeholder]}>{label}</Text>
      <FinanceIcon name="calendar" color={palette.accent} size={18} />
    </Pressable>
    {draft !== undefined && !unavailable && <Modal transparent animationType="fade" onRequestClose={close}>
      <SafeAreaProvider style={layout.modal}>
        <Pressable accessible={false} onPress={close} style={layout.backdrop} />
        <View style={layout.sheet} accessibilityViewIsModal>
          <ScrollView bounces={false} contentInsetAdjustmentBehavior="never">
            <SafeAreaView edges={['bottom']} style={layout.sheetContent}>
              <Text style={styles.section} accessibilityRole="header">{title}</Text>
              <DateTimePicker mode="date" display="inline" locale={lang === 'ru' ? 'ru-RU' : 'en-US'}
                style={layout.calendar} themeVariant={isComaBank ? 'dark' : 'light'} accentColor={palette.accent}
                value={dateForPicker(clamp(draft), true)}
                minimumDate={new Date(min + 'T00:00:00Z')} maximumDate={new Date(max + 'T23:59:59.999Z')} timeZoneName="UTC"
                onValueChange={(_, date) => setDraft(dateFromPicker(date, true))} />
              <View style={layout.actions}>
                <FinanceButton title={copy[lang].cancel} onPress={close} testID={testID + '-cancel'} />
                {allowClear && <FinanceButton title={t.clearDate} testID={testID + '-clear'}
                  onPress={() => { onClear?.(); close(); }} />}
                <FinanceButton title={copy[lang].done} primary testID={testID + '-done'}
                  onPress={() => { onChange(clamp(draft)); close(); }} />
              </View>
            </SafeAreaView>
          </ScrollView>
        </View>
      </SafeAreaProvider>
    </Modal>}
  </View>;
}

const layout = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  date: { color: palette.ink, fontSize: 17, fontVariant: ['tabular-nums'], flexShrink: 1 },
  placeholder: { color: palette.muted },
  modal: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: palette.scrim },
  sheet: { width: '100%', maxWidth: 420, maxHeight: '90%', backgroundColor: palette.panel,
    borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  sheetContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 12 },
  calendar: { height: 336 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
});
