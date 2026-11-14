import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { setStringAsync } from 'expo-clipboard';
import type { Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { FinanceIcon } from './finance-icon';
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

export function SupportScreen({ lang, showHeading = true }: { lang: Language; showHeading?: boolean }) {
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

  function refresh() {
    setNotice(undefined);
    setRevision((value) => value + 1);
  }

  const contacts = (['email', 'phone'] as const).flatMap((type) => {
    const value = data?.[type];
    return value ? [{ type, value }] : [];
  });

  return <View style={layout.screen} testID="support-screen">
    {showHeading && <Text accessibilityRole="header" style={styles.heading}>{common.support}</Text>}
    {!current && <View style={[styles.surface, layout.message]}>
      <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} testID="support-loading" />
    </View>}
    {current && 'error' in current && <View style={[styles.surface, layout.message]}>
      <FinanceAlert testID="support-error">{t.network}</FinanceAlert>
      <View style={layout.refresh}>
        <FinanceButton title={common.retry} icon="refresh" onPress={refresh} testID="support-refresh" />
      </View>
    </View>}
    {data && <>
      {contacts.length > 0 && <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.groupTitle}>{t.contacts}</Text>
        <View style={styles.surface}>
          {contacts.map(({ type, value }, index) => (
            <View key={type} style={[layout.contact, index > 0 && layout.divider]}>
              <Pressable accessibilityRole="button" onPress={() => contact(value, type)} testID={'support-' + type}
                style={({ pressed }) => [layout.contactLink, pressed && layout.pressed]}>
                <FinanceIcon name={type === 'email' ? 'mail' : 'phone'} color={palette.accent} />
                <View style={layout.contactText}>
                  <Text style={styles.title}>{t[type]}</Text>
                  <Text style={styles.meta}>{value}</Text>
                </View>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={type === 'email' ? common.copyEmail : common.copyPhone}
                onPress={() => contact(value, type, true)} testID={'support-copy-' + type}
                style={({ pressed }) => [layout.copy, pressed && styles.checked]}>
                <FinanceIcon name="copy" color={palette.accent} size={17} />
              </Pressable>
            </View>
          ))}
        </View>
        {notice === 'copyDone' && <Text style={styles.meta} accessibilityLiveRegion="polite" testID="support-copied">{common.copyDone}</Text>}
        {notice === 'contactAction' && <FinanceAlert>{common.contactAction}</FinanceAlert>}
        {notice === 'clipboard' && <FinanceAlert>{t.clipboard}</FinanceAlert>}
      </View>}
      {!!data.faq.length && <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.groupTitle}>{t.faq}</Text>
        <View style={styles.surface}>
          {data.faq.map((entry, index) => {
            const open = expanded === entry.id;
            return <View key={entry.id} style={index ? layout.divider : undefined}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} testID={'support-faq-' + entry.id}
                style={({ pressed }) => [layout.question, pressed && layout.pressed]} onPress={() => setExpanded(open ? undefined : entry.id)}>
                <Text style={[styles.title, layout.questionText]}>{entry.question}</Text>
                <FinanceIcon name={open ? 'chevron-down' : 'chevron'} color={open ? palette.accent : palette.muted} size={16} />
              </Pressable>
              {open && <Text selectable style={layout.answer} testID={'support-answer-' + entry.id}>{entry.answer}</Text>}
            </View>;
          })}
        </View>
      </View>}
      {!contacts.length && !data.faq.length && <View style={[styles.surface, layout.message]}>
        <Text style={styles.meta}>{t.empty}</Text>
      </View>}
      <View style={layout.refresh}>
        <FinanceButton title={t.refresh} icon="refresh" onPress={refresh} testID="support-refresh" />
      </View>
    </>}
  </View>;
}

const layout = StyleSheet.create({
  screen: { gap: 18 },
  section: { gap: 8 },
  message: { gap: 8, padding: 12 },
  contact: { flexDirection: 'row', alignItems: 'center', paddingRight: 8, gap: 4 },
  contactLink: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 62,
    paddingHorizontal: 12, paddingVertical: 8, gap: 10 },
  contactText: { flex: 1, gap: 2 },
  copy: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, backgroundColor: palette.ground },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  question: { minHeight: 48, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  questionText: { flex: 1 },
  pressed: { backgroundColor: palette.ground },
  answer: { color: palette.muted, fontSize: 15, paddingHorizontal: 12, paddingBottom: 12 },
  refresh: { alignItems: 'flex-start' },
});
