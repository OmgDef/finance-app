import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { setStringAsync } from 'expo-clipboard';
import type { Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { FinanceAlert, FinanceButton, palette, styles } from './finance-ui';

const words = {
  en: { contacts: 'Contacts', email: 'Email support', phone: 'Call support', faq: 'Frequently asked questions',
    loading: 'Loading support…', empty: 'Support information is unavailable.', refresh: 'Refresh support',
    network: 'Could not load support information. Check your connection and try again.', clipboard: 'Could not copy the contact.' },
  ru: { contacts: 'Контакты', email: 'Написать на email', phone: 'Позвонить', faq: 'Частые вопросы',
    loading: 'Загружаем поддержку…', empty: 'Информация о поддержке недоступна.', refresh: 'Обновить поддержку',
    network: 'Не удалось загрузить поддержку. Проверьте подключение и попробуйте снова.', clipboard: 'Не удалось скопировать контакт.' },
} as const;

type Snapshot = { lang: Language; revision: number } & ({ data: Result<'support'> } | { error: true });
type Notice = 'copyDone' | 'contactAction' | 'clipboard';

export function SupportScreen({ lang }: { lang: Language }) {
  const t = words[lang];
  const common = copy[lang];
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [expanded, setExpanded] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const activeAction = useRef(0);
  const current = snapshot?.lang === lang && snapshot.revision === revision ? snapshot : undefined;
  const data = current && 'data' in current ? current.data : undefined;

  useEffect(() => {
    let live = true;
    void request('support', { query: new URLSearchParams({ lang }) })
      .then((data) => { if (live) setSnapshot({ lang, revision, data }); })
      .catch(() => { if (live) setSnapshot({ lang, revision, error: true }); });
    return () => { live = false; activeAction.current += 1; };
  }, [lang, revision]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') setRevision((value) => value + 1);
    });
    return () => listener.remove();
  }, []);

  function contact(value: string, type: 'email' | 'phone', copyOnly = false) {
    const attempt = ++activeAction.current;
    setNotice(undefined);
    const target = type === 'email' ? 'mailto:' + encodeURIComponent(value).replace('%40', '@')
      : 'tel:' + value.replace(/[^+0-9]/g, '');
    const action = copyOnly ? setStringAsync(value) : Linking.openURL(target);
    void action.then((result) => {
      if (copyOnly && activeAction.current === attempt) setNotice(result ? 'copyDone' : 'clipboard');
    }).catch(() => {
      if (activeAction.current === attempt) setNotice(copyOnly ? 'clipboard' : 'contactAction');
    });
  }

  return <View style={layout.screen} testID="support-screen">
    <Text accessibilityRole="header" style={styles.heading}>{common.support}</Text>
    {!current && <ActivityIndicator color={palette.mint} accessibilityLabel={t.loading} testID="support-loading" />}
    {current && 'error' in current && <FinanceAlert testID="support-error">{t.network}</FinanceAlert>}
    {data && <>
      {(data.email || data.phone) && <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section}>{t.contacts}</Text>
        <View style={layout.surface}>
          {(['email', 'phone'] as const).map((type) => {
            const value = data[type];
            if (!value) return null;
            return <View key={type} style={layout.contact}>
              <Text selectable style={styles.label}>{value}</Text>
              <View style={layout.actions}>
                <FinanceButton title={t[type]} onPress={() => contact(value, type)} testID={'support-' + type} primary />
                <FinanceButton title={type === 'email' ? common.copyEmail : common.copyPhone}
                  onPress={() => contact(value, type, true)} testID={'support-copy-' + type} />
              </View>
            </View>;
          })}
          {notice === 'copyDone' && <Text style={styles.meta} accessibilityLiveRegion="polite" testID="support-copied">{common.copyDone}</Text>}
          {notice === 'contactAction' && <FinanceAlert>{common.contactAction}</FinanceAlert>}
          {notice === 'clipboard' && <FinanceAlert>{t.clipboard}</FinanceAlert>}
        </View>
      </View>}
      {!!data.faq.length && <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section}>{t.faq}</Text>
        <View style={layout.list}>
          {data.faq.map((entry, index) => {
            const open = expanded === entry.id;
            return <View key={entry.id} style={index ? layout.divider : undefined}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} testID={'support-faq-' + entry.id}
                style={({ pressed }) => [layout.question, pressed && styles.dimmed]} onPress={() => setExpanded(open ? undefined : entry.id)}>
                <Text style={[styles.title, layout.questionText]}>{entry.question}</Text>
                <Text accessible={false} importantForAccessibility="no" style={layout.indicator}>{open ? '−' : '+'}</Text>
              </Pressable>
              {open && <Text selectable style={layout.answer} testID={'support-answer-' + entry.id}>{entry.answer}</Text>}
            </View>;
          })}
        </View>
      </View>}
      {!data.email && !data.phone && !data.faq.length && <Text style={styles.meta}>{t.empty}</Text>}
    </>}
    {current && <View style={layout.refresh}>
      <FinanceButton title={'error' in current ? common.retry : t.refresh}
        onPress={() => { setNotice(undefined); setRevision((value) => value + 1); }} testID="support-refresh" />
    </View>}
  </View>;
}

const layout = StyleSheet.create({
  screen: { gap: 20 },
  section: { gap: 8 },
  surface: { backgroundColor: palette.panel, borderRadius: 16, padding: 14, gap: 14 },
  contact: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  list: { backgroundColor: palette.panel, borderRadius: 16 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  question: { minHeight: 48, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 10, gap: 12 },
  questionText: { flex: 1 },
  indicator: { color: palette.muted, fontSize: 20 },
  answer: { color: palette.muted, fontSize: 15, paddingHorizontal: 14, paddingBottom: 14 },
  refresh: { alignItems: 'flex-start' },
});
