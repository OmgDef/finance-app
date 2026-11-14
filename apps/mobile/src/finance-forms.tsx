import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import type { Language, Result } from '@teta/contracts';
import type { FinanceDraft, TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import type { FinanceCopyKey } from './finance-copy';
import { FinanceDateField } from './finance-date-field';
import {
  amountInMinorUnits, currencies, depositRate, formatAmount, formatRate, formatTransferRate,
} from './finance-format';
import type { Currency } from './finance-format';
import { Choice, FinanceAlert, FinanceButton, FinanceField, styles as uiStyles } from './finance-ui';

type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];
type Kind = 'regular' | 'cash' | 'deposit';
type Props = { lang: Language; disabled: boolean; onSubmit: (draft: FinanceDraft) => void };

export function useLocalizedInput(lang: Language, defaultText: string, parse: (text: string, lang: Language) => string | undefined,
  format: (value: string, lang: Language) => string,
) {
  const [edited, setInput] = useState<{ text: string; lang: Language }>();
  const input = edited ?? { text: defaultText, lang };
  const value = parse(input.text, input.lang);
  const text = input.lang !== lang && value !== undefined ? format(value, lang) : input.text;
  return { value, text, setText: (text: string) => setInput({ text, lang }) };
}

export function AccountForm({ lang, today, disabled, onSubmit }: Props & { today: string }) {
  const t = financeCopy[lang];
  const [kind, setKind] = useState<Kind>('regular');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [start, setStart] = useState<string>();
  const startDate = start ?? today;
  const opening = useLocalizedInput(lang, '0', amountInMinorUnits, formatAmount);
  const rate = useLocalizedInput(lang, '', depositRate, formatRate);
  const [maturityDate, setMaturityDate] = useState<string | null>(null);
  const [error, setError] = useState<FinanceCopyKey>();
  const validate = (code: FinanceCopyKey) => setError(code);

  function submit() {
    if (disabled) return;
    void KeyboardController.dismiss();
    if (!name.trim()) return validate('invalidName');
    if (startDate > today) return validate('futureStartDate');
    const openingBalanceMinor = opening.value;
    if (openingBalanceMinor === undefined) return validate('invalidAmount');
    const base = { name: name.trim(), currency, startDate, openingBalanceMinor };
    if (kind === 'deposit') {
      const annualRatePercent = rate.value;
      if (annualRatePercent === undefined) return validate('invalidRate');
      if (!maturityDate) return validate('invalidDate');
      if (maturityDate < startDate) return validate('invalidMaturity');
      setError(undefined);
      onSubmit({ kind: 'account.create', body: { ...base, type: kind, annualRatePercent, maturityDate } });
    } else {
      setError(undefined);
      onSubmit({ kind: 'account.create', body: kind === 'cash' ? { ...base, type: kind } : base });
    }
  }

  return <View style={styles.form}>
    <Choice title={t.type} value={kind} options={(['regular', 'cash', 'deposit'] as const)
      .map((id) => ({ id, label: t[id] }))} onChange={setKind} disabled={disabled} testID="finance-account-type" />
    <FinanceField title={t.accountName} value={name} onChangeText={setName} editable={!disabled} maxLength={255}
      testID="finance-account-name" />
    <Choice title={t.currency} value={currency} options={currencies.map((id) => ({ id, label: id }))}
      onChange={setCurrency} disabled={disabled} testID="finance-account-currency" />
    <FinanceField title={t.opening + ' (' + currency + ')'} value={opening.text} onChangeText={opening.setText} editable={!disabled}
      keyboardType="numbers-and-punctuation" maxLength={30} testID="finance-account-opening" />
    <FinanceDateField title={t.startDate} lang={lang} today={today} value={startDate} onChange={setStart} max={today}
      disabled={disabled} testID="finance-account-date" />
    {kind === 'deposit' && <>
      <FinanceField title={t.rate} value={rate.text} onChangeText={rate.setText} editable={!disabled} keyboardType="numbers-and-punctuation"
        maxLength={8} testID="finance-account-rate" />
      <FinanceDateField title={t.maturity} lang={lang} today={today} value={maturityDate} onChange={setMaturityDate}
        min={startDate} disabled={disabled} testID="finance-account-maturity" />
    </>}
    {error && <FinanceAlert>{t[error]}</FinanceAlert>}
    <FinanceButton title={t.submitAccount} onPress={submit} primary disabled={disabled} testID="finance-submit" />
  </View>;
}

type TransactionKind = TransactionFields['type'];

export function TransactionForm({ lang, today, disabled, onSubmit, accounts, categories, selectedAccountId, kind, initial }: {
  lang: Language; today: string; disabled: boolean; onSubmit: (fields: TransactionFields) => void; accounts: Account[];
  categories: Category[]; selectedAccountId: string | null; kind: TransactionKind; initial?: TransactionFields;
}) {
  const t = financeCopy[lang];
  const [accountId, setAccountId] = useState(() => initial
    ? initial.type === 'transfer' ? initial.fromAccountId : initial.accountId
    : selectedAccountId ?? accounts[0]?.accountId ?? '');
  const [toAccountId, setToAccountId] = useState(() => initial?.type === 'transfer' ? initial.toAccountId
    : accounts.find((entry) => entry.accountId !== accountId)?.accountId ?? '');
  const [categoryId, setCategoryId] = useState(initial && initial.type !== 'transfer' ? initial.categoryId : '');
  const amount = useLocalizedInput(lang, initial ? formatAmount(
    initial.type === 'transfer' ? initial.fromAmountMinor : initial.amountMinor, lang,
  ) : '', amountInMinorUnits, formatAmount);
  const received = useLocalizedInput(lang, initial?.type === 'transfer'
    ? formatAmount(initial.toAmountMinor, lang) : '', amountInMinorUnits, formatAmount);
  const [date, setDate] = useState<string>();
  const operationDate = date ?? initial?.date ?? today;
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [error, setError] = useState<FinanceCopyKey>();
  const account = accounts.find((entry) => entry.accountId === accountId);
  const isTransfer = kind === 'transfer';
  const destination = isTransfer ? accounts.find((entry) => entry.accountId === toAccountId) : undefined;
  const earliestDate = destination && (!account || destination.startDate > account.startDate)
    ? destination.startDate : account?.startDate;
  const crossCurrency = !!account && !!destination && account.currency !== destination.currency;
  const rate = crossCurrency && amount.value && received.value
    ? formatTransferRate(amount.value, received.value, account.currency, destination.currency, lang) : undefined;
  const prefix = 'finance-' + kind;
  const accountOptions = accounts.map((entry) => ({ id: entry.accountId, label: entry.name + ' · ' + entry.currency }));
  const categoryOptions = categories.filter((category) => category.type === kind);
  const submitTitle = initial ? t.saveChanges : {
    expense: t.submitExpense, income: t.submitIncome, transfer: t.submitTransfer,
  }[kind];

  function submit() {
    if (disabled) return;
    void KeyboardController.dismiss();
    if (!account) return setError('unavailable');
    const amountMinor = amount.value;
    if (amountMinor === undefined) return setError('invalidAmount');
    if (amountMinor === '0' || amountMinor.startsWith('-')) return setError('positiveAmount');
    if (operationDate < account.startDate) return setError('invalidStart');
    const fields = { date: operationDate, ...(comment && { comment }) };
    if (kind === 'transfer') {
      if (!destination || destination.accountId === account.accountId) return setError('distinctAccounts');
      if (operationDate < destination.startDate) return setError('invalidStart');
      const toAmountMinor = crossCurrency ? received.value : amountMinor;
      if (toAmountMinor === undefined) return setError('invalidAmount');
      if (toAmountMinor === '0' || toAmountMinor.startsWith('-')) return setError('positiveAmount');
      setError(undefined);
      onSubmit({ ...fields, type: kind, fromAccountId: accountId, toAccountId, fromAmountMinor: amountMinor, toAmountMinor });
      return;
    }
    if (!categoryOptions.some(({ id }) => id === categoryId)) return setError(kind === 'income' ? 'chooseIncomeCategory' : 'chooseCategory');
    setError(undefined);
    onSubmit({ ...fields, type: kind, accountId, amountMinor, categoryId });
  }

  const amountLabel = crossCurrency ? t.debitAmount : t.amount;
  return <View style={styles.form}>
    <Choice title={isTransfer ? t.fromAccount : t.account} value={accountId}
      onChange={(id) => {
        setAccountId(id);
        if (isTransfer && toAccountId === id) setToAccountId(accountId);
      }} disabled={disabled} options={accountOptions} testID={prefix + (isTransfer ? '-from' : '-account')} />
    {isTransfer && <Choice title={t.toAccount} value={toAccountId} onChange={setToAccountId} disabled={disabled}
      options={accountOptions.filter(({ id }) => id !== accountId)} testID={prefix + '-to'} />}
    <FinanceField title={account ? amountLabel + ' (' + account.currency + ')' : amountLabel}
      value={amount.text} onChangeText={amount.setText} editable={!disabled} keyboardType="numbers-and-punctuation" maxLength={30}
      testID={prefix + (isTransfer ? '-from-amount' : '-amount')} />
    {crossCurrency && <FinanceField title={t.creditAmount + ' (' + destination.currency + ')'}
      value={received.text} onChangeText={received.setText} editable={!disabled}
      keyboardType="numbers-and-punctuation" maxLength={30} testID={prefix + '-to-amount'} />}
    {rate && <View style={styles.rate}>
      <Text style={uiStyles.meta}>{t.transferRate}</Text>
      <Text style={uiStyles.value} testID="finance-transfer-rate">{rate}</Text>
    </View>}
    <FinanceDateField title={t.date} lang={lang} today={today} value={operationDate} onChange={setDate}
      min={earliestDate} disabled={disabled} testID={prefix + '-date'} />
    {!isTransfer && <Choice title={t.category} value={categoryId} onChange={setCategoryId} disabled={disabled}
      options={categoryOptions.map((category) => ({ id: category.id, label: lang === 'ru' ? category.nameRu : category.nameEn }))}
      testID={prefix + '-category'} />}
    <FinanceField title={t.comment} value={comment} onChangeText={setComment} editable={!disabled} maxLength={500}
      multiline testID={prefix + '-comment'} />
    {error && <FinanceAlert>{t[error]}</FinanceAlert>}
    <FinanceButton title={submitTitle} onPress={submit} primary disabled={disabled} testID="finance-submit" />
  </View>;
}

const styles = StyleSheet.create({ form: { gap: 16 }, rate: { gap: 4 } });
