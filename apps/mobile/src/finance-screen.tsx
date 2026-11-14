import { useEffect, useRef, useState } from 'react';
import type { ComponentRef, ReactNode } from 'react';
import {
  ActivityIndicator, Alert, BackHandler, InputAccessoryView, Keyboard, Platform, Pressable, RefreshControl, ScrollView,
  StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import type { Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { AccountManagement } from './finance-account-management';
import { apiErrorCode, useFinanceCommand } from './finance-commands';
import type { CommandResult, FinanceAccess, FinanceCommand, TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import { currencies, formatFinancialDate, formatMoney, formatProfileMoment, formatRate } from './finance-format';
import type { Currency } from './finance-format';
import { AccountForm, TransactionForm } from './finance-forms';
import { ReconciliationForm, reconciliationConflict } from './finance-reconciliation';
import { ScheduleScreen, scheduleOffset } from './finance-schedule';
import type { SchedulePage } from './finance-schedule';
import { scheduleCopy } from './finance-schedule-copy';
import { StatisticsScreen, useStatistics } from './finance-statistics';
import { statisticsCopy } from './finance-statistics-copy';
import { revisionFields, TransactionVersions } from './finance-transaction';
import type { TransactionHistory } from './finance-transaction';
import { FinanceAlert, FinanceButton, palette, styles } from './finance-ui';
import { SupportScreen } from './support-screen';

type Account = Result<'listAccounts'>['accounts'][number];
type History = Result<'listAccountHistory'>;
type Category = Result<'listCategories'>['categories'][number];
type TransactionPage = { name: 'transaction'; accountId: string | null; transactionId: string;
  scheduleOrigin?: SchedulePage; fromStatistics?: true };
type Page = { name: 'products' | 'payments' | 'statistics' | 'support' } | { name: 'addAccount' } | SchedulePage |
  { name: 'history'; accountId: string } | { name: 'record'; kind: TransactionFields['type']; accountId: string | null;
    fromPayments?: boolean } |
  { name: 'manage' | 'reconcile'; accountId: string } |
  TransactionPage | { name: 'revise'; origin: TransactionPage; initial: TransactionFields; version: number };
type Receipt = { command: FinanceCommand; result: CommandResult };
const products: Page = { name: 'products' };
const payments: Page = { name: 'payments' };
const statisticsPage: Page = { name: 'statistics' };
const supportPage: Page = { name: 'support' };

function localizedError(code: string, lang: Language, context?: 'reconcile' | 'schedule' | 'replace') {
  const t = financeCopy[lang];
  const s = scheduleCopy[lang];
  switch (code) {
    case 'INVALID_REQUEST': return t.invalidRequest;
    case 'ACCOUNT_UNAVAILABLE':
    case 'NOT_FOUND': return t.unavailable;
    case 'IDEMPOTENCY_CONFLICT': return t.conflict;
    case 'VERSION_CONFLICT': return context === 'replace' ? s.replacementChanged
      : context === 'reconcile' ? t.accountVersionConflict : t.versionConflict;
    case 'SCHEDULE_DATES_PENDING': return t.reconcilePendingDates;
    case 'SCHEDULE_DATE_CONFLICT': return context === 'schedule' ? s.skipChanged : t.reconcileScheduleChanged;
    case 'SCHEDULE_REPLACEMENT_CONFLICT': return s.replacementChanged;
    case 'SCHEDULE_RULE_STATE_CONFLICT': return s.conflict;
    case 'TRANSACTION_VOID': return t.transactionAlreadyVoided;
    case 'COMMAND_CLOSED': return t.commandClosed;
    case 'REVIEW_CONFIRMED': return t.reviewConfirmed;
    case 'STORAGE': return t.storage;
    default: return copy[lang].errors[code] ?? t.error;
  }
}

export function FinanceScreen({ access, lang, visible, timeZoneSuggestion }: {
  access: FinanceAccess; lang: Language; visible: boolean; timeZoneSuggestion?: ReactNode;
}) {
  const t = financeCopy[lang];
  const s = scheduleCopy[lang];
  const reportCopy = statisticsCopy[lang];
  const { width, fontScale } = useWindowDimensions();
  const wrapTabs = Math.min(width, 540) / Math.min(fontScale, 1.35) < 360;
  const [page, setPage] = useState<Page>(products);
  const statistics = useStatistics(access, visible && page.name === 'statistics');
  const [accounts, setAccounts] = useState<Account[]>();
  const [categories, setCategories] = useState<Category[]>();
  const [listError, setListError] = useState('');
  const [categoryError, setCategoryError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState<History>();
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [transaction, setTransaction] = useState<TransactionHistory>();
  const [transactionError, setTransactionError] = useState('');
  const [transactionBusy, setTransactionBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const scheduleSaving = useRef(false);
  const currentPage = useRef(page);
  currentPage.current = page;
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleRefresh, setScheduleRefresh] = useState(0);
  const accountsRequest = useRef(0);
  const categoriesRequest = useRef(0);
  const historyRequest = useRef(0);
  const transactionRequest = useRef(0);
  const activeAccounts = accounts?.filter((account) => !account.archived) ?? [];
  const archivedAccounts = accounts?.filter((account) => account.archived) ?? [];
  const historyId = page.name === 'history' ? page.accountId : null;
  const accountId = page.name === 'history' || page.name === 'manage' || page.name === 'reconcile' ? page.accountId : null;
  const account = accountId && accounts?.find((entry) => entry.accountId === accountId);

  async function loadAccounts() {
    if (!access.isCurrent()) return;
    const attempt = ++accountsRequest.current;
    const current = () => attempt === accountsRequest.current && access.isCurrent();
    setListError('');
    setRefreshing(true);
    try {
      const result = await request('listAccounts', { token: access.token });
      if (current()) {
        setAccounts(result.accounts);
        return result.accounts;
      }
    } catch (error) {
      if (current()) {
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setListError(code);
      }
    } finally {
      if (current()) setRefreshing(false);
    }
  }

  function updateAccount(account: Account) {
    if (!access.isCurrent()) return;
    accountsRequest.current += 1;
    setRefreshing(false);
    setAccounts((previous) => previous?.map((entry) => entry.accountId === account.accountId &&
      entry.accountVersion <= account.accountVersion ? account : entry));
  }

  async function loadCategories() {
    if (!access.isCurrent()) return;
    const attempt = ++categoriesRequest.current;
    const current = () => attempt === categoriesRequest.current && access.isCurrent();
    setCategoryError('');
    try {
      const result = await request('listCategories', { token: access.token });
      if (current()) setCategories(result.categories);
    } catch (error) {
      if (current()) {
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setCategoryError(code);
      }
    }
  }

  async function loadHistory(accountId: string, before?: string) {
    if (!access.isCurrent()) return;
    const attempt = ++historyRequest.current;
    const current = () => attempt === historyRequest.current && access.isCurrent();
    setHistoryBusy(true);
    setHistoryError('');
    try {
      const result = await request('listAccountHistory', { token: access.token, params: { accountId },
        query: before ? new URLSearchParams({ before }) : undefined });
      if (current()) {
        setHistory((previous) => before && previous?.accountId === result.accountId
          ? { ...result, entries: [...previous.entries, ...result.entries] } : result);
      }
    } catch (error) {
      if (current()) {
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setHistoryError(code);
      }
    } finally {
      if (current()) setHistoryBusy(false);
    }
  }

  async function loadTransaction(transactionId: string) {
    if (!access.isCurrent()) return;
    const attempt = ++transactionRequest.current;
    const current = () => attempt === transactionRequest.current && access.isCurrent();
    setTransactionBusy(true);
    setTransactionError('');
    try {
      const result = await request('listTransactionVersions', { token: access.token, params: { transactionId } });
      if (current()) setTransaction(result);
    } catch (error) {
      if (current()) {
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setTransactionError(code);
      }
    } finally {
      if (current()) setTransactionBusy(false);
    }
  }

  function go(next: Page, result: Receipt | null = null) {
    historyRequest.current += 1;
    transactionRequest.current += 1;
    setHistory(undefined);
    setHistoryError('');
    setHistoryBusy(false);
    setTransaction(undefined);
    setTransactionError('');
    setTransactionBusy(false);
    setReceipt(result);
    setPage(next);
    if (next.name === 'statistics' && currentPage.current.name !== 'statistics') statistics.refresh();
    if (next.name === 'schedule') scroll.current?.scrollTo({ y: 0, animated: false });
    if (next.name === 'history') void loadHistory(next.accountId);
    if (next.name === 'transaction') void loadTransaction(next.transactionId);
  }

  function back() {
    if (page.name === 'schedule' && (scheduleSaving.current || command.busy)) return;
    command.clearError();
    if (page.name === 'revise') go(page.origin);
    else if (page.name === 'reconcile') go({ name: 'manage', accountId: page.accountId });
    else if (page.name === 'manage') go({ name: 'history', accountId: page.accountId });
    else if (page.name === 'transaction' && page.scheduleOrigin) go(page.scheduleOrigin);
    else if (page.name === 'transaction' && page.fromStatistics) go(statisticsPage);
    else if (page.name === 'schedule') {
      if (page.editor || page.skipDate) go({ ...page, editor: undefined, skipDate: undefined });
      else if (page.ruleId) go({ ...page, ruleId: undefined });
      else if (page.accountId) go({ name: 'history', accountId: page.accountId });
      else go(payments);
    }
    else if ((page.name === 'record' || page.name === 'transaction') && page.accountId) go({ name: 'history', accountId: page.accountId });
    else if (page.name === 'record' && page.fromPayments) go(payments);
    else go(products);
  }

  const command = useFinanceCommand(access, (result, kind) => {
    const receipt = { command: kind, result };
    void loadAccounts();
    if ('occurrenceId' in result || 'replacementRule' in result) {
      const origin = currentPage.current.name === 'schedule' ? currentPage.current : undefined;
      const target = 'occurrenceId' in result ? { ruleId: result.ruleId, date: result.date }
        : { ruleId: result.replacementRule.ruleId, date: result.replacementRule.firstDate };
      setScheduleRefresh((signal) => signal + 1);
      go({ name: 'schedule', accountId: origin?.accountId ?? null, ruleId: target.ruleId,
        offset: scheduleOffset(access.profile.today, target.date) }, receipt);
    }
    else if ('accountId' in result) go({ name: 'history', accountId: result.accountId }, receipt);
    else if ('fromAccount' in result) go({ name: 'history', accountId: result.fromAccount.accountId }, receipt);
    else if ('accounts' in result) {
      const origin = page.name === 'revise' ? page.origin : page.name === 'transaction' ? page : null;
      go({ name: 'transaction', transactionId: result.transactionId,
        accountId: origin?.transactionId === result.transactionId ? origin.accountId : null,
        scheduleOrigin: origin?.transactionId === result.transactionId ? origin.scheduleOrigin : undefined,
        fromStatistics: origin?.transactionId === result.transactionId ? origin.fromStatistics : undefined }, receipt);
    } else go(products, receipt);
  });

  function openRecord(kind: TransactionFields['type'], accountId: string | null) {
    command.clearError();
    go({ name: 'record', kind, accountId, fromPayments: page.name === 'payments' });
  }

  function submitTransaction(fields: TransactionFields) {
    if (page.name === 'revise') {
      void command.submit({ kind: 'transaction.revise', transactionId: page.origin.transactionId,
        body: { ...fields, expectedTransactionVersion: page.version } });
    } else if (fields.type === 'transfer') {
      void command.submit({ kind: 'transfer.record', body: fields });
    } else {
      const { type, ...body } = fields;
      void command.submit({ kind: type === 'expense' ? 'expense.record' : 'income.record', body });
    }
  }

  useEffect(() => {
    void loadAccounts();
    void loadCategories();
  }, []);

  useEffect(() => {
    if (!visible || page.name === 'products') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => subscription.remove();
  }, [page, visible, command.busy]);

  function refresh() {
    if (scheduleSaving.current) return;
    void loadAccounts();
    if (!categories) void loadCategories();
    if (historyId) void loadHistory(historyId);
    if (page.name === 'transaction') void loadTransaction(page.transactionId);
    if (page.name === 'schedule') setScheduleRefresh((signal) => signal + 1);
    if (page.name === 'statistics') statistics.refresh();
  }

  const blocked = command.busy || command.reading || command.pending !== null;
  const showingSupport = page.name === 'support';
  const onMainPage = showingSupport || page.name === 'products' || page.name === 'payments' || page.name === 'statistics';
  const balanceByCurrency = new Map<Currency, bigint>();
  for (const entry of activeAccounts) {
    balanceByCurrency.set(entry.currency, (balanceByCurrency.get(entry.currency) ?? 0n) + BigInt(entry.balanceMinor));
  }
  const historyTitles = {
    opening: t.opening, adjustment: t.adjustment, expense: t.expenseEntry, income: t.incomeEntry, transfer: t.transfer,
  };
  const transactionLabels = { expense: t.expense, income: t.income, transfer: t.newTransfer };
  const commandLabels: Record<FinanceCommand, string> = {
    'account.create': t.addAccount, 'expense.record': t.expense, 'income.record': t.income, 'transfer.record': t.newTransfer,
    'transaction.revise': t.editTransaction, 'transaction.void': t.voidTransaction,
    'account.reconcile': t.reconcileAccount,
    'schedule.skip': s.skip, 'schedule.replace': s.replace,
  };
  const receiptLabels: Record<FinanceCommand, string> = {
    'account.create': t.accountCreated, 'expense.record': t.expenseSaved, 'income.record': t.incomeSaved,
    'transfer.record': t.transferSaved, 'transaction.revise': t.revisionSaved, 'transaction.void': t.transactionVoided,
    'account.reconcile': t.reconciled,
    'schedule.skip': s.dateSkipped, 'schedule.replace': s.ruleReplaced,
  };
  const activeTransaction = page.name === 'transaction' && transaction?.transactionId === page.transactionId ? transaction : undefined;
  const currentVersion = activeTransaction?.versions.find(({ version }) => version === activeTransaction.transactionVersion);
  const initialRevision = activeTransaction && currentVersion && revisionFields(activeTransaction.type, currentVersion);
  const archivedTransaction = currentVersion?.movements.some(({ accountId }) => accounts?.find((item) => item.accountId === accountId)?.archived);
  const transactionChanged = command.error === 'VERSION_CONFLICT' || command.error === 'TRANSACTION_VOID';
  const transactionPage = page.name === 'revise' ? page.origin : page.name === 'transaction' ? page : undefined;
  const formKind = page.name === 'record' ? page.kind : page.name === 'revise' ? page.initial.type : undefined;
  const receiptResult = receipt?.result;
  const receiptAccounts = receiptResult && ('fromAccount' in receiptResult ? [receiptResult.fromAccount, receiptResult.toAccount]
    : 'accounts' in receiptResult ? receiptResult.accounts : 'balanceMinor' in receiptResult ? [receiptResult] : []);
  const activeHistory = history?.accountId === historyId ? history : undefined;
  const adjustment = receiptResult && 'adjustmentId' in receiptResult ? receiptResult : undefined;
  const reconciling = page.name === 'reconcile';

  useEffect(() => {
    if (!reconciling) return;
    if (reconciliationConflict(command.error)) scroll.current?.scrollTo({ y: 0, animated: false });
    if (command.error === 'ACCOUNT_UNAVAILABLE') void loadAccounts();
  }, [reconciling, command.error]);

  return <View style={[layout.container, !visible && layout.hidden]}>
    <ScrollView ref={scroll} key={page.name + (historyId ?? '')} automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={layout.page}
      refreshControl={(onMainPage && !showingSupport) || page.name === 'history' || page.name === 'transaction' ||
        (page.name === 'schedule' && !page.editor && !page.skipDate)
        ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={palette.mint} colors={[palette.mint]} />
        : undefined}>
      {!onMainPage && <View style={layout.leading}>
        <FinanceButton title={t.back} onPress={back} disabled={page.name === 'schedule' && (scheduleBusy || command.busy)}
          testID="finance-back" />
      </View>}
      {page.name === 'products' && <Text accessibilityRole="header" testID="finance-products" style={styles.heading}>{t.products}</Text>}
      {page.name === 'statistics' && <Text accessibilityRole="header" testID="finance-statistics" style={styles.heading}>{reportCopy.title}</Text>}
      {page.name === 'payments' && <Text accessibilityRole="header" testID="finance-payments" style={styles.heading}>{s.payments}</Text>}
      {page.name === 'addAccount' && <Text accessibilityRole="header" style={styles.heading}>{t.addAccount}</Text>}
      {page.name === 'manage' && <Text accessibilityRole="header" style={styles.heading}>{t.manageAccount}</Text>}
      {reconciling && <Text accessibilityRole="header" style={styles.heading}>{t.reconcileAccount}</Text>}
      {page.name === 'record' && <Text accessibilityRole="header" style={styles.heading}>{transactionLabels[page.kind]}</Text>}
      {page.name === 'revise' && <Text accessibilityRole="header" style={styles.heading}>{t.editTransaction}</Text>}
      {page.name === 'transaction' && <Text accessibilityRole="header" style={styles.heading}>
        {activeTransaction ? historyTitles[activeTransaction.type] : t.transactionVersions}
      </Text>}
      {page.name === 'history' && account && <View style={layout.detailHeader}>
        <Text accessibilityRole="header" style={styles.heading}>{account.name}</Text>
        <Text style={styles.heroValue} testID="finance-detail-balance">{formatMoney(account.balanceMinor, account.currency, lang)}</Text>
        <Text style={styles.meta}>{formatFinancialDate(account.startDate, lang)} · {accountType(account, lang)}</Text>
        {'type' in account && account.type === 'deposit' && <Text style={styles.meta}>{depositTerms(account, lang)}</Text>}
        {account.needsReconciliation && <FinanceAlert>{t.needsReconciliation}</FinanceAlert>}
        <View style={layout.actions}>
          {!account.archived && <>
            <FinanceButton title={t.expense} onPress={() => openRecord('expense', account.accountId)}
              disabled={blocked} primary testID="finance-expense" />
            <FinanceButton title={t.income} onPress={() => openRecord('income', account.accountId)}
              disabled={blocked} testID="finance-income" />
            {activeAccounts.length > 1 && <FinanceButton title={t.newTransfer} onPress={() => openRecord('transfer', account.accountId)}
              disabled={blocked} testID="finance-transfer" />}
          </>}
          <FinanceButton title={t.manageAccount} onPress={() => {
            command.clearError();
            go({ name: 'manage', accountId: account.accountId });
          }} testID="finance-manage-account" />
          <FinanceButton title={s.schedule} onPress={() => go({ name: 'schedule', accountId: account.accountId })}
            testID="finance-account-schedule" />
        </View>
      </View>}

      {showingSupport && visible && <SupportScreen lang={lang} />}
      {!showingSupport && <>
      {command.reading && <View style={layout.panel}>
        {command.error ? <>
          <FinanceAlert>{localizedError(command.error, lang)}</FinanceAlert>
          <FinanceButton title={t.retryStorage} onPress={() => void command.initialize()} disabled={command.busy} />
        </> : <Text style={styles.meta}>{t.commandChecking}</Text>}
      </View>}
      {command.pending && <View style={layout.panel} testID="finance-pending-command">
        <Text accessibilityRole="header" style={styles.section}>{t.commandPending}</Text>
        <Text style={styles.title}>{commandLabels[command.pending.command]}</Text>
        <Text style={styles.meta}>{command.outcome === 'review' ? t.commandReview : t.commandUnknown}</Text>
        {command.outcome === 'review' ? <FinanceButton title={t.confirmReview} testID="finance-confirm-review"
          disabled={command.busy} onPress={() => Alert.alert(t.reviewTitle, t.reviewExplanation, [
            { text: copy[lang].cancel, style: 'cancel' },
            { text: t.confirmReview, onPress: () => void command.confirmReview() },
          ])} /> : <View style={layout.actions}>
          {command.canRetry && <FinanceButton title={t.retryCommand} onPress={() => void command.retry()}
            disabled={command.busy} testID="finance-retry-command" />}
          <FinanceButton title={t.checkCommand} onPress={() => void command.check()}
            disabled={command.busy} testID="finance-check-command" />
          <FinanceButton title={t.closeCommand} testID="finance-close-command" disabled={command.busy}
            onPress={() => Alert.alert(t.closeTitle, t.closeExplanation, [
              { text: copy[lang].cancel, style: 'cancel' },
              { text: t.closeCommand, style: 'destructive', onPress: () => void command.close() },
            ])} />
        </View>}
      </View>}
      {!command.reading && command.error !== '' &&
        <FinanceAlert testID="finance-command-message">{localizedError(command.error, lang,
          page.name === 'schedule' ? page.editor === 'replace' ? 'replace' : 'schedule' : reconciling ? 'reconcile' : undefined)}</FinanceAlert>}
      {transactionPage && transactionChanged && <FinanceButton title={t.reloadTransaction}
        onPress={() => {
          command.clearError();
          void loadAccounts();
          go(transactionPage);
        }} disabled={blocked} testID="finance-reload-transaction" />}
      {receipt && <View style={layout.panel} testID="finance-receipt" accessibilityLiveRegion="polite">
        <Text style={styles.title}>{receiptLabels[receipt.command]}</Text>
        {receiptResult && 'occurrenceId' in receiptResult && <>
          <Text style={styles.label}>{formatFinancialDate(receiptResult.date, lang)}</Text>
          <Text style={styles.meta}>{receiptResult.reason}</Text>
        </>}
        {receiptResult && 'replacementRule' in receiptResult && <>
          <Text style={styles.label}>{s.replacementDate} · {formatFinancialDate(receiptResult.transitionDate, lang)}</Text>
          <Text style={styles.meta}>{formatProfileMoment(receiptResult.transitionAt, access.profile.timeZone, lang)}</Text>
        </>}
        {adjustment && <>
          <View style={layout.currencyRow}>
            <Text style={styles.meta}>{t.actualBalance}</Text>
            <Text style={styles.value}>{formatMoney(adjustment.actualBalanceMinor, adjustment.currency, lang)}</Text>
          </View>
          <View style={layout.currencyRow}>
            <Text style={styles.meta}>{t.reconciliationDelta}</Text>
            <Text style={styles.value} testID="finance-reconciled-delta">
              {formatMoney(adjustment.deltaMinor, adjustment.currency, lang, true)}
            </Text>
          </View>
          {!!adjustment.skippedDates?.length && <>
            <Text style={styles.title}>{t.reconcileSkippedDates}</Text>
            {adjustment.skippedDates.map(({ ruleId, date, reason }) =>
              <View key={ruleId + date} style={layout.section} testID={'finance-reconciled-skip-' + ruleId + '-' + date}>
                <Text style={styles.label}>{formatFinancialDate(date, lang)}</Text>
                <Text style={styles.meta}>{reason}</Text>
              </View>)}
          </>}
        </>}
        {!!receiptAccounts?.length && <>
          <Text style={styles.meta}>{t.confirmedBalance}</Text>
          {receiptAccounts.map((item) => <View key={item.accountId} style={layout.currencyRow}>
            {receiptAccounts.length > 1 && <Text style={styles.meta}>
              {accounts?.find(({ accountId }) => accountId === item.accountId)?.name ?? item.currency}
            </Text>}
            <Text style={styles.value}>{formatMoney(item.balanceMinor, item.currency, lang)}</Text>
          </View>)}
        </>}
        <FinanceButton title={t.dismiss} onPress={() => setReceipt(null)} />
      </View>}

      {(onMainPage || page.name === 'schedule' || page.name === 'history' || page.name === 'transaction' || reconciling || !!formKind) && listError !== '' && <>
        <FinanceAlert>{localizedError(listError, lang, reconciling ? 'reconcile' : undefined)}</FinanceAlert>
        <FinanceButton title={copy[lang].retry} onPress={() => void loadAccounts()} />
      </>}
      {!accounts && refreshing && <ActivityIndicator color={palette.mint} accessibilityLabel={t.loading} />}
      </>}
      {page.name === 'products' && <>
        {timeZoneSuggestion}
        {accounts && <View style={layout.summary}>
          <Text accessibilityRole="header" style={styles.section}>{t.balances}</Text>
          {currencies.map((currency) => <View key={currency} style={layout.currencyRow}>
            <Text style={styles.meta}>{currency}</Text>
            <Text style={styles.value}>{formatMoney(String(balanceByCurrency.get(currency) ?? 0n), currency, lang)}</Text>
          </View>)}
        </View>}
        <View style={layout.actions}>
          <FinanceButton title={t.addAccount} onPress={() => { command.clearError(); go({ name: 'addAccount' }); }}
            disabled={blocked} primary testID="finance-add-account" />
          {activeAccounts.length > 0 && <>
            <FinanceButton title={t.expense} disabled={blocked} onPress={() => openRecord('expense', null)} testID="finance-expense" />
            <FinanceButton title={t.income} disabled={blocked} onPress={() => openRecord('income', null)} testID="finance-income" />
          </>}
          {activeAccounts.length > 1 && <FinanceButton title={t.newTransfer} disabled={blocked}
            onPress={() => openRecord('transfer', null)} testID="finance-transfer" />}
        </View>
        {accounts && <View style={layout.section}>
          <Text accessibilityRole="header" style={styles.section}>{t.accounts}</Text>
          {activeAccounts.length ? <View style={layout.rows}>
            {activeAccounts.map((entry) => <AccountRow key={entry.accountId} account={entry} lang={lang}
              open={() => go({ name: 'history', accountId: entry.accountId })} />)}
          </View> : <Text style={styles.meta}>{t.noAccounts}</Text>}
        </View>}
        {archivedAccounts.length > 0 && <View style={layout.section}>
          <Text accessibilityRole="header" style={styles.section}>{t.archived}</Text>
          <View style={layout.rows}>
            {archivedAccounts.map((entry) => <AccountRow key={entry.accountId} account={entry} lang={lang}
              open={() => go({ name: 'history', accountId: entry.accountId })} />)}
          </View>
        </View>}
      </>}
      {page.name === 'statistics' && <>
        {categoryError && <View style={layout.section}>
          <FinanceAlert>{localizedError(categoryError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadCategories()} />
        </View>}
        <StatisticsScreen statistics={statistics} accounts={accounts} categories={categories} lang={lang}
          today={access.profile.today} scrollToTop={() => scroll.current?.scrollTo({ y: 0, animated: false })}
          onTransaction={({ transactionId, accountId }) => {
            command.clearError();
            go({ name: 'transaction', transactionId, accountId, fromStatistics: true });
          }} />
      </>}
      {page.name === 'payments' && <View style={layout.section}>
        <View style={layout.actions}>
          <FinanceButton title={t.expense} disabled={blocked || !activeAccounts.length} onPress={() => openRecord('expense', null)}
            primary testID="finance-expense" />
          <FinanceButton title={t.income} disabled={blocked || !activeAccounts.length} onPress={() => openRecord('income', null)}
            testID="finance-income" />
          <FinanceButton title={t.newTransfer} disabled={blocked || activeAccounts.length < 2} onPress={() => openRecord('transfer', null)}
            testID="finance-transfer" />
        </View>
        <FinanceButton title={s.schedule} onPress={() => go({ name: 'schedule', accountId: null })} testID="finance-payments-schedule" />
      </View>}
      {page.name === 'schedule' && <>
        {categoryError && <View style={layout.section}>
          <FinanceAlert>{localizedError(categoryError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadCategories()} />
        </View>}
        <ScheduleScreen page={page} access={access} accounts={accounts} categories={categories} lang={lang}
          disabled={blocked || refreshing} visible={visible} refreshSignal={scheduleRefresh} commandError={command.error}
          onSubmit={command.submit} onPage={go} onSaving={(saving) => {
            scheduleSaving.current = saving;
            setScheduleBusy(saving);
          }} onTransaction={({ transactionId, accountId }) => {
            if (transactionId) go({ name: 'transaction', transactionId, accountId, scheduleOrigin: page });
          }} />
      </>}
      {page.name === 'addAccount' && <AccountForm lang={lang} today={access.profile.today} disabled={blocked} onSubmit={command.submit} />}
      {page.name === 'manage' && account && <AccountManagement account={account} access={access} lang={lang}
        disabled={blocked} onAccountChanged={updateAccount}
        onReconcile={() => go({ name: 'reconcile', accountId: account.accountId })} />}
      {reconciling && account && (account.archived ? <FinanceAlert>{t.unavailable}</FinanceAlert>
        : <ReconciliationForm key={account.accountId} account={account} categories={categories} access={access}
          lang={lang} visible={visible} disabled={blocked || command.error === 'ACCOUNT_UNAVAILABLE'}
          commandError={command.error}
          onSubmit={(body) => void command.submit({ kind: 'account.reconcile', accountId: account.accountId, body })} />)}
      {formKind && <>
        {formKind !== 'transfer' && categoryError && <>
          <FinanceAlert>{localizedError(categoryError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadCategories()} />
        </>}
        {formKind !== 'transfer' && !categories && !categoryError &&
          <ActivityIndicator color={palette.mint} accessibilityLabel={t.loading} />}
        {accounts && (categories || formKind === 'transfer') && <TransactionForm lang={lang} today={access.profile.today}
          disabled={blocked || transactionChanged} onSubmit={submitTransaction} accounts={activeAccounts}
          categories={categories ?? []} selectedAccountId={page.name === 'record' ? page.accountId : null}
          kind={formKind} initial={page.name === 'revise' ? page.initial : undefined} />}
      </>}
      {page.name === 'transaction' && <>
        {transactionBusy && <ActivityIndicator color={palette.mint} accessibilityLabel={t.loading} />}
        {transactionError && <>
          <FinanceAlert>{localizedError(transactionError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadTransaction(page.transactionId)} />
        </>}
        {activeTransaction && <>
          {archivedTransaction && currentVersion?.status === 'posted' && <Text style={styles.meta}>{t.archivedTransaction}</Text>}
          {accounts && initialRevision && !archivedTransaction && <View style={layout.actions}>
            <FinanceButton title={t.editTransaction} onPress={() => go({ name: 'revise', origin: page,
              initial: initialRevision, version: activeTransaction.transactionVersion })}
              disabled={blocked || transactionBusy || transactionChanged} testID="finance-edit-transaction" />
            <FinanceButton title={t.voidTransaction} testID="finance-void-transaction"
              disabled={blocked || transactionBusy || transactionChanged}
              onPress={() => Alert.alert(t.voidTitle, t.voidExplanation, [
                { text: copy[lang].cancel, style: 'cancel' },
                { text: t.voidTransaction, style: 'destructive', onPress: () => void command.submit({
                  kind: 'transaction.void', transactionId: page.transactionId,
                  body: { expectedTransactionVersion: activeTransaction.transactionVersion },
                }) },
              ])} />
          </View>}
          <TransactionVersions history={activeTransaction} lang={lang} accounts={accounts ?? []} categories={categories ?? []} />
        </>}
      </>}
      {page.name === 'history' && <View style={layout.section}>
        <Text accessibilityRole="header" style={styles.section} testID="finance-history">{t.history}</Text>
        {historyBusy && <ActivityIndicator color={palette.mint} accessibilityLabel={t.loading} />}
        {historyError && <>
          <FinanceAlert>{localizedError(historyError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadHistory(page.accountId)} />
        </>}
        {activeHistory && !activeHistory.entries.length && <Text style={styles.meta}>{t.noHistory}</Text>}
        {activeHistory && activeHistory.entries.length > 0 && <View style={layout.rows}>
          {activeHistory.entries.map((entry, index) => {
            const isVoided = 'status' in entry && entry.status === 'void';
            const category = 'categoryId' in entry && categories?.find(({ id }) => id === entry.categoryId);
            const title = category ? (lang === 'ru' ? category.nameRu : category.nameEn) : historyTitles[entry.type];
            const details = 'comment' in entry ? entry.comment : 'explanation' in entry ? entry.explanation : null;
            const row = <>
                <View style={layout.identity}>
                  <Text style={styles.title}>{title}</Text>
                  {details && <Text style={styles.meta}>{details}</Text>}
                  {isVoided && <Text style={styles.meta}>{t.void}</Text>}
                  {'actorRole' in entry && entry.actorRole === 'admin' &&
                    <Text style={styles.meta}>{t.changedByAdmin}</Text>}
                </View>
                <Text style={[layout.historyValue, isVoided && styles.mutedValue]}>
                  {formatMoney(entry.amountMinor, activeHistory.currency, lang, entry.type !== 'opening')}
                </Text>
            </>;
            return <View key={entry.type + '-' + entry.id}>
              {(index === 0 || activeHistory.entries[index - 1].date !== entry.date) &&
                <Text style={layout.dateLabel}>{formatFinancialDate(entry.date, lang)}</Text>}
              {'status' in entry ? <Pressable accessibilityRole="button" testID={'finance-transaction-' + entry.id}
                onPress={() => {
                  command.clearError();
                  go({ name: 'transaction', transactionId: entry.id, accountId: activeHistory.accountId });
                }} style={({ pressed }) => [layout.historyRow, pressed && layout.pressed]}>{row}</Pressable>
                : <View style={layout.historyRow}>{row}</View>}
            </View>;
          })}
        </View>}
        {activeHistory?.next && <FinanceButton title={t.loadMore} disabled={historyBusy} onPress={() => {
          if (activeHistory.next) void loadHistory(page.accountId, activeHistory.next);
        }} />}
      </View>}
    </ScrollView>
    {onMainPage && <View style={layout.tabBar}>
      {([{ page: products, label: t.products }, { page: statisticsPage, label: reportCopy.title },
        { page: payments, label: s.payments }, { page: supportPage, label: copy[lang].support }] as const).map((tab) => (
        <Pressable key={tab.page.name} accessibilityRole="tab" accessibilityLabel={tab.label}
          accessibilityState={{ selected: page.name === tab.page.name }} onPress={() => go(tab.page)}
          testID={'finance-tab-' + tab.page.name} style={[layout.tab, wrapTabs && layout.wideTab]}>
          <Text maxFontSizeMultiplier={1.35} style={[layout.tabLabel, page.name === tab.page.name && layout.tabActive]}>
            {tab.page.name === 'payments' && !wrapTabs ? tab.label.replace(/\s*\/\s*/, '/\n') : tab.label}
          </Text>
        </Pressable>
      ))}
    </View>}
    {visible && Platform.OS === 'ios' && (page.name === 'addAccount' || page.name === 'manage' || page.name === 'statistics' || reconciling || !!formKind ||
      (page.name === 'schedule' && (!!page.editor || !!page.skipDate))) &&
      <InputAccessoryView nativeID="finance-keyboard" backgroundColor={palette.ground}>
        <View style={layout.keyboardBar}>
          <FinanceButton title={t.done} onPress={Keyboard.dismiss} testID="finance-keyboard-done" />
        </View>
      </InputAccessoryView>}
  </View>;
}

function accountType(account: Account, lang: Language) {
  return financeCopy[lang]['type' in account ? account.type : 'regular'];
}

function depositTerms(account: Extract<Account, { type: 'deposit' }>, lang: Language) {
  const rate = formatRate(account.annualRatePercent, lang);
  return rate + '% · ' + formatFinancialDate(account.maturityDate, lang);
}

function AccountRow({ account, lang, open }: { account: Account; lang: Language; open: () => void }) {
  return <Pressable accessibilityRole="button" testID={'finance-account-' + account.accountId}
    onPress={open} style={({ pressed }) => [layout.accountRow, pressed && layout.pressed]}>
    <View style={layout.identity}>
      <Text style={styles.title}>{account.name}</Text>
      <Text style={styles.meta}>{accountType(account, lang)}</Text>
      {'type' in account && account.type === 'deposit' && <Text style={styles.meta}>{depositTerms(account, lang)}</Text>}
      {account.needsReconciliation && <Text style={styles.meta}>{financeCopy[lang].needsReconciliation}</Text>}
    </View>
    <Text style={layout.accountValue}>{formatMoney(account.balanceMinor, account.currency, lang)}</Text>
  </Pressable>;
}

const layout = StyleSheet.create({
  container: { flex: 1 },
  hidden: { display: 'none' },
  page: { width: '100%', maxWidth: 540, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 28, gap: 18 },
  summary: { backgroundColor: palette.panel, padding: 16, borderRadius: 16, gap: 6 },
  currencyRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
  leading: { alignItems: 'flex-start' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  section: { gap: 10 },
  rows: { backgroundColor: palette.panel, borderRadius: 16, paddingHorizontal: 12 },
  detailHeader: { gap: 8 },
  panel: { backgroundColor: palette.raised, padding: 14, borderRadius: 16, gap: 8 },
  keyboardBar: { paddingHorizontal: 12, paddingVertical: 4, alignItems: 'flex-end' },
  tabBar: { flexDirection: 'row', flexWrap: 'wrap', width: '100%', maxWidth: 540, alignSelf: 'center',
    borderTopColor: palette.line, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 4 },
  tab: { flexBasis: '25%', minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2, paddingVertical: 6 },
  wideTab: { flexBasis: '50%' },
  tabLabel: { color: palette.muted, fontSize: 15, textAlign: 'center' },
  tabActive: { color: palette.ink, fontWeight: '600' },
  accountRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, minHeight: 62, borderBottomColor: palette.line, borderBottomWidth: StyleSheet.hairlineWidth },
  pressed: { opacity: 0.58 },
  identity: { flexGrow: 1, flexBasis: '44%', minWidth: 96, gap: 3 },
  accountValue: { color: palette.ink, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right',
    flexShrink: 1 },
  dateLabel: { color: palette.muted, fontSize: 13, paddingTop: 12 },
  historyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    paddingVertical: 10, borderBottomColor: palette.line, borderBottomWidth: StyleSheet.hairlineWidth },
  historyValue: { color: palette.ink, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right',
    flexShrink: 1 },
});
