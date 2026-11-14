import { useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import type { Body, Language, Result } from '@teta/contracts';
import { financeCopy } from './finance-copy';
import { amountInMinorUnits, financialDate, formatAmount, formatFinancialDate } from './finance-format';
import { useLocalizedInput } from './finance-forms';
import { scheduleCopy } from './finance-schedule-copy';
import { Choice, FinanceAlert, FinanceButton, FinanceField, styles } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];
type ScheduleRule = Result<'getScheduleRule'>;
type Create = Body<'createScheduleRule'>;

export type EditorValues = Pick<Create, 'amountMinor' | 'categoryId' | 'comment' | 'endDate'>;
type EditorProps = {
  lang: Language;
  accounts: Account[];
  categories: Category[];
  today: string;
  scopedAccountId: string | null;
  disabled: boolean;
} & ({ mode: 'create'; onSave: (fields: Create) => void } |
  { mode: 'replace'; rule: ScheduleRule; destination: Account; earliestFirstDate: string;
    skipDecisions: ReactNode; onSave: (fields: Create) => void } |
  { mode: 'edit'; rule: ScheduleRule; onSave: (fields: EditorValues) => void });

export function ScheduleEditor(props: EditorProps) {
  const { lang, accounts, categories, today, scopedAccountId, disabled } = props;
  const t = scheduleCopy[lang];
  const f = financeCopy[lang];
  const rule = props.mode !== 'create' ? props.rule : undefined;
  const [accountChoice, setAccount] = useState(rule?.accountId ?? scopedAccountId ?? accounts[0]?.accountId ?? '');
  const accountId = props.mode === 'replace' ? props.destination.accountId : accountChoice;
  const [kind, setKind] = useState<Create['kind']>(rule?.kind ?? 'expense');
  const [frequency, setFrequency] = useState<Create['frequency']>(rule?.frequency ?? 'once');
  const [categoryId, setCategory] = useState(rule?.categoryId ?? '');
  const [comment, setComment] = useState(rule?.comment ?? '');
  const [error, setError] = useState('');
  const account = accounts.find((item) => item.accountId === accountId);
  const earliest = props.mode === 'replace' ? props.earliestFirstDate : account?.startDate ?? today;
  const defaultStart = props.mode === 'create' && today > earliest ? today : earliest;
  const originalFirst = rule?.firstDate;
  const defaultFirst = originalFirst && (props.mode === 'edit' || originalFirst >= earliest) ? originalFirst : defaultStart;
  const defaultEnd = rule?.endDate && (props.mode === 'edit' || rule.endDate >= defaultFirst) ? rule.endDate : null;
  const amount = useLocalizedInput(lang, rule && rule.currency === account?.currency ? formatAmount(rule.amountMinor, lang) : '',
    amountInMinorUnits, formatAmount);
  const first = useLocalizedInput(lang, formatFinancialDate(defaultFirst, lang), financialDate, formatFinancialDate);
  const end = useLocalizedInput(lang, defaultEnd ? formatFinancialDate(defaultEnd, lang) : '', financialDate, formatFinancialDate);
  const matching = categories.filter((entry) => entry.type === kind);

  function submit() {
    if (disabled) return;
    void KeyboardController.dismiss();
    if (!account || account.archived) return setError('account');
    if (!amount.value || amount.value === '0' || amount.value.startsWith('-')) return setError('amount');
    if (!matching.some(({ id }) => id === categoryId)) return setError('category');
    if (!first.value) return setError('date');
    if (props.mode !== 'edit' && first.value < earliest) return setError('first');
    const endDate = frequency !== 'once' && end.text.trim() ? end.value : null;
    if (endDate === undefined || (endDate !== null && endDate < first.value)) return setError('end');
    setError('');
    const fields = { amountMinor: amount.value, categoryId, comment: comment.trim() || null, endDate };
    if (props.mode === 'edit') props.onSave(fields);
    else props.onSave({ accountId, kind, frequency, firstDate: first.value, ...fields });
  }

  const errors: Record<string, string> = {
    account: t.unavailable, amount: f.positiveAmount, category: f.chooseCategory, date: f.invalidDate,
    first: props.mode === 'create' ? t.accountStartRange : t.dateRange, end: t.endRange,
  };
  return <View style={layout.section}>
    {props.mode === 'create' &&
      <Choice title={f.account} value={accountId} onChange={setAccount} disabled={disabled} testID="schedule-account"
        options={accounts.filter((item) => !item.archived && (!scopedAccountId || item.accountId === scopedAccountId))
          .map((item) => ({ id: item.accountId, label: item.name + ' · ' + item.currency }))} />}
    {props.mode !== 'edit' && <>
      <Choice title={t.kind} value={kind} onChange={(next) => { setKind(next); setCategory(''); }} disabled={disabled}
        testID="schedule-kind" options={[{ id: 'expense', label: f.expenseEntry }, { id: 'income', label: f.incomeEntry }]} />
      <Choice title={t.repeat} value={frequency} onChange={setFrequency} disabled={disabled} testID="schedule-frequency"
        options={(['once', 'weekly', 'monthly'] as const).map((id) => ({ id, label: t[id] }))} />
      <FinanceField title={t.first} hint={f.dateHint} value={first.text} onChangeText={first.setText} editable={!disabled}
        keyboardType="numbers-and-punctuation" maxLength={10} testID="schedule-first" />
    </>}
    <FinanceField title={account ? f.amount + ' (' + account.currency + ')' : f.amount}
      value={amount.text} onChangeText={amount.setText} editable={!disabled} keyboardType="numbers-and-punctuation"
      maxLength={30} testID="schedule-amount" />
    <Choice title={f.category} value={categoryId} onChange={setCategory} disabled={disabled} testID="schedule-category"
      options={matching.map(({ id, nameEn, nameRu }) => ({ id, label: lang === 'ru' ? nameRu : nameEn }))} />
    {frequency !== 'once' && <FinanceField title={t.last} hint={f.dateHint} value={end.text} onChangeText={end.setText}
      editable={!disabled} keyboardType="numbers-and-punctuation" maxLength={10} testID="schedule-end" />}
    <FinanceField title={f.comment} value={comment} onChangeText={setComment} editable={!disabled}
      multiline maxLength={500} testID="schedule-comment" />
    {props.mode === 'replace' && props.skipDecisions}
    {error && <FinanceAlert>{errors[error]}</FinanceAlert>}
    {props.mode === 'create' && first.value && first.value < today && <Text style={styles.meta}>{t.pastDates}</Text>}
    {props.mode === 'edit' && <Text style={styles.meta}>{t.pendingChange}</Text>}
    <FinanceButton title={props.mode === 'replace' ? t.replace : props.mode === 'edit' ? t.save : t.create}
      onPress={submit} primary disabled={disabled} testID={props.mode === 'replace' ? 'schedule-replace-save' : 'schedule-save'} />
  </View>;
}

const layout = StyleSheet.create({ section: { gap: 16 } });
