import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import type { Language, Result } from '@teta/contracts';
import type { FinanceDraft, TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import type { FinanceCopyKey } from './finance-copy';
import { FinanceDateField } from './finance-date-field';
import {
  amountInMinorUnits, currencies, currencyName, currencySymbol, depositRate, formatAmount, formatRate, formatTransferRate,
  formatFinancialDate,
} from './finance-format';
import type { Currency } from './finance-format';
import { FinanceIcon } from './finance-icon';
import { Choice, FinanceAlert, FinanceButton, FinanceField, palette, styles as uiStyles } from './finance-ui';

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
    <Choice title={t.currency} value={currency} options={currencies.map((id) => ({ id, label: currencyName(id, lang) }))}
      onChange={setCurrency} disabled={disabled} testID="finance-account-currency" />
    <FinanceField title={t.opening} currency={currency} value={opening.text} onChangeText={opening.setText} editable={!disabled}
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

type QuickLayout = (form: ReactNode, footer: ReactNode) => ReactNode;

function quickAmountInMinorUnits(text: string) {
  return amountInMinorUnits(text.trim().replaceAll(',', '.').replace(/^\./, '0.'), 'en');
}

export function TransactionForm({ lang, today, disabled, onSubmit, accounts, categories, selectedAccountId, kind, initial,
  defaultCategoryId, renderQuickLayout }: {
  lang: Language; today: string; disabled: boolean; onSubmit: (fields: TransactionFields) => void; accounts: Account[];
  categories: Category[]; selectedAccountId: string | null; kind: TransactionKind; initial?: TransactionFields;
  defaultCategoryId?: string; renderQuickLayout?: QuickLayout;
}) {
  const t = financeCopy[lang];
  const [accountId, setAccountId] = useState(() => initial
    ? initial.type === 'transfer' ? initial.fromAccountId : initial.accountId
    : selectedAccountId ?? accounts[0]?.accountId ?? '');
  const [toAccountId, setToAccountId] = useState(() => initial?.type === 'transfer' ? initial.toAccountId
    : accounts.find((entry) => entry.accountId !== accountId)?.accountId ?? '');
  const [categoryId, setCategoryId] = useState(() => {
    if (initial && initial.type !== 'transfer') return initial.categoryId;
    return categories.find(({ id, type }) => id === defaultCategoryId && type === kind)?.id ?? '';
  });
  const amount = useLocalizedInput(lang, initial ? formatAmount(
    initial.type === 'transfer' ? initial.fromAmountMinor : initial.amountMinor, lang,
  ) : '', renderQuickLayout ? quickAmountInMinorUnits : amountInMinorUnits,
  renderQuickLayout ? (value) => formatAmount(value, 'en').replaceAll(',', '') : formatAmount);
  const received = useLocalizedInput(lang, initial?.type === 'transfer'
    ? formatAmount(initial.toAmountMinor, lang) : '', amountInMinorUnits, formatAmount);
  const [date, setDate] = useState<string>();
  const operationDate = date ?? initial?.date ?? today;
  const originalSource = initial && initial.type !== 'transfer' ? initial.source ?? initial.incomeSource : undefined;
  const [sourceText, setSourceText] = useState(originalSource ?? '');
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [error, setError] = useState<FinanceCopyKey>();
  const [expanded, setExpanded] = useState<'account' | 'category' | 'source' | 'details'>();
  const account = accounts.find((entry) => entry.accountId === accountId);
  const isTransfer = kind === 'transfer';
  const destination = isTransfer ? accounts.find((entry) => entry.accountId === toAccountId) : undefined;
  const earliestDate = destination && (!account || destination.startDate > account.startDate)
    ? destination.startDate : account?.startDate;
  const crossCurrency = !!account && !!destination && account.currency !== destination.currency;
  const rate = crossCurrency && amount.value && received.value
    ? formatTransferRate(amount.value, received.value, account.currency, destination.currency, lang) : undefined;
  const prefix = 'finance-' + kind;
  const accountOptions = accounts.map(({ accountId, name }) => ({ id: accountId, label: name }));
  const categoryOptions = categories.filter((category) => category.type === kind);
  const submitTitle = initial ? t.saveChanges : {
    expense: t.submitExpense, income: t.submitIncome, transfer: t.submitTransfer,
  }[kind];

  function submit() {
    if (disabled) return;
    if (!renderQuickLayout) void KeyboardController.dismiss();
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
    if (renderQuickLayout) void KeyboardController.dismiss();
    setError(undefined);
    const source = sourceText.trim();
    onSubmit({ ...fields, type: kind, accountId, amountMinor, categoryId,
      ...((source || originalSource) && { source: source || null }) });
  }

  const dateField = <FinanceDateField title={t.date} lang={lang} today={today} value={operationDate} onChange={setDate}
    min={earliestDate} disabled={disabled} testID={prefix + '-date'} />;
  const sourceField = <FinanceField title={t.transactionSource} placeholder={kind === 'expense' ? t.expenseSourceHint : t.incomeSourceHint}
    value={sourceText} onChangeText={setSourceText} editable={!disabled} maxLength={120} testID={prefix + '-source'} />;
  const commentField = <FinanceField title={t.comment} value={comment} onChangeText={setComment} editable={!disabled} maxLength={500}
    multiline testID={prefix + '-comment'} />;
  const submitButton = <FinanceButton title={submitTitle} onPress={submit} primary disabled={disabled} testID="finance-submit" />;
  const localizedCategories = categoryOptions.map((category) => ({ id: category.id, label: lang === 'ru' ? category.nameRu : category.nameEn }));

  if (renderQuickLayout) {
    const amountError = error === 'invalidAmount' || error === 'positiveAmount';
    function toggle(field: typeof expanded) {
      void KeyboardController.dismiss();
      setExpanded(expanded === field ? undefined : field);
    }
    function choose(update: (value: string) => void, value: string) {
      update(value);
      setExpanded(undefined);
    }
    return renderQuickLayout(<View style={styles.quickForm}>
      <View style={styles.amountGroup}>
        <Text style={uiStyles.label}>{t.amount}</Text>
        <View style={[uiStyles.surface, styles.amountBox, amountError && styles.amountError]}>
          <TextInput editable={!disabled} keyboardType="decimal-pad"
            style={[styles.amountText, styles.amountInput]} value={amount.text} onChangeText={(value) => {
              amount.setText(value);
              if (amountError) setError(undefined);
            }}
            placeholder={formatAmount('0', lang)} placeholderTextColor={palette.muted} selectionColor={palette.accent}
            maxLength={30} accessibilityLabel={account ? `${t.amount} (${currencySymbol(account.currency)})` : t.amount}
            testID={prefix + '-amount'} />
          {account && <Text style={styles.amountText} accessible={false} importantForAccessibility="no">{currencySymbol(account.currency)}</Text>}
        </View>
        {amountError && <FinanceAlert testID={prefix + '-amount-error'}>{t[error]}</FinanceAlert>}
      </View>
      <View style={[uiStyles.surface, styles.quickFields]}>
        <QuickField title={t.account} value={accountOptions.find(({ id }) => id === accountId)?.label}
          expanded={expanded === 'account'} disabled={disabled} onPress={() => toggle('account')} testID={prefix + '-account'}>
          <QuickOptions options={accountOptions} selected={accountId} disabled={disabled}
            onSelect={(id) => choose(setAccountId, id)} testID={prefix + '-account'} />
        </QuickField>
        <View style={styles.fieldDivider}>
          <QuickField title={t.category} value={localizedCategories.find(({ id }) => id === categoryId)?.label}
            expanded={expanded === 'category'} disabled={disabled} onPress={() => toggle('category')} testID={prefix + '-category'}>
            <QuickOptions options={localizedCategories} selected={categoryId} disabled={disabled}
              onSelect={(id) => choose(setCategoryId, id)} testID={prefix + '-category'} />
          </QuickField>
        </View>
        <View style={styles.fieldDivider}>
          <QuickField title={t.transactionSource} value={sourceText.trim() || undefined} expanded={expanded === 'source'}
            disabled={disabled} onPress={() => toggle('source')} testID={prefix + '-source-toggle'}>
            <View style={styles.detailFields}>{sourceField}</View>
          </QuickField>
        </View>
        <View style={styles.fieldDivider}>
          <QuickField title={t.dateAndNote} value={formatFinancialDate(operationDate, lang)} expanded={expanded === 'details'}
            disabled={disabled} onPress={() => toggle('details')} testID={prefix + '-details'}>
            <View style={styles.detailFields}>{dateField}{commentField}</View>
          </QuickField>
        </View>
      </View>
      {error && !amountError && <FinanceAlert>{t[error]}</FinanceAlert>}
    </View>, submitButton);
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
    <FinanceField title={amountLabel} currency={account?.currency}
      value={amount.text} onChangeText={amount.setText} editable={!disabled} keyboardType="numbers-and-punctuation" maxLength={30}
      testID={prefix + (isTransfer ? '-from-amount' : '-amount')} />
    {crossCurrency && <FinanceField title={t.creditAmount} currency={destination.currency}
      value={received.text} onChangeText={received.setText} editable={!disabled}
      keyboardType="numbers-and-punctuation" maxLength={30} testID={prefix + '-to-amount'} />}
    {rate && <View style={styles.rate}>
      <Text style={uiStyles.meta}>{t.transferRate}</Text>
      <Text style={uiStyles.value} testID="finance-transfer-rate">{rate}</Text>
    </View>}
    {dateField}
    {!isTransfer && <Choice title={t.category} value={categoryId} onChange={setCategoryId} disabled={disabled}
      options={localizedCategories}
      testID={prefix + '-category'} />}
    {!isTransfer && sourceField}
    {commentField}
    {error && <FinanceAlert>{t[error]}</FinanceAlert>}
    {submitButton}
  </View>;
}

function QuickField({ title, value, expanded, disabled, onPress, testID, children }: {
  title: string; value?: string; expanded: boolean; disabled: boolean; onPress(): void; testID: string; children: ReactNode;
}) {
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityValue={value ? { text: value } : undefined}
      accessibilityState={{ expanded, disabled }} disabled={disabled} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.quickField, pressed && styles.optionPressed, disabled && uiStyles.dimmed]}>
      <Text style={styles.quickLabel}>{title}</Text>
      {value && <Text style={styles.quickValue}>{value}</Text>}
      <FinanceIcon name="chevron" color={palette.muted} size={14} />
    </Pressable>
    {expanded && children}
  </>;
}

function QuickOptions({ options, selected, disabled, onSelect, testID }: {
  options: { id: string; label: string }[]; selected: string; disabled: boolean; onSelect(id: string): void; testID: string;
}) {
  return <View style={styles.optionList} accessibilityRole="radiogroup">
    {options.map(({ id, label }) => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: id === selected, disabled }}
      disabled={disabled} onPress={() => onSelect(id)} testID={testID + '-' + id}
      style={({ pressed }) => [styles.option, (pressed || id === selected) && styles.optionPressed]}>
      <Text style={uiStyles.title}>{label}</Text>
      {id === selected && <FinanceIcon name="check" color={palette.accent} size={16} />}
    </Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  form: { gap: 16 },
  rate: { gap: 4 },
  quickForm: { gap: 14 },
  amountGroup: { gap: 6 },
  amountBox: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 14, minHeight: 72 },
  amountError: { borderColor: palette.danger },
  amountText: { color: palette.ink, fontSize: 34, fontWeight: '600', fontVariant: ['tabular-nums'] },
  amountInput: { flex: 1, paddingVertical: 12, textAlign: 'right' },
  quickFields: { overflow: 'hidden' },
  quickField: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 49, paddingHorizontal: 12, paddingVertical: 9 },
  quickLabel: { color: palette.ink, fontSize: 15, flexShrink: 1 },
  quickValue: { color: palette.muted, fontSize: 15, marginLeft: 'auto', flexShrink: 1, textAlign: 'right' },
  fieldDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  optionList: { backgroundColor: palette.ground, padding: 4 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    minHeight: 46, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  optionPressed: { backgroundColor: palette.selected },
  detailFields: { gap: 12, paddingHorizontal: 12, paddingBottom: 12 },
});
