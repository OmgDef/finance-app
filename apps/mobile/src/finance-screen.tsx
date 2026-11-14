import { createContext, use, useEffect, useRef, useState } from 'react';
import type { ComponentRef, ReactNode } from 'react';
import { Redirect, Stack, useGlobalSearchParams, useIsFocused, useLocalSearchParams, usePathname, usePreventRemove, useRouter } from 'expo-router';
import {
  ActivityIndicator, Alert, Platform, Pressable, RefreshControl,
  StyleSheet, Text, View,
} from 'react-native';
import { KeyboardAwareScrollView, KeyboardController, KeyboardToolbar } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAccessSession } from './access-session';
import type { Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { AccountManagement } from './finance-account-management';
import { AccountOverview } from './finance-account-overview';
import { apiErrorCode, useFinanceCommand } from './finance-commands';
import type { CommandResult, FinanceAccess, FinanceCommand, TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import type { FinanceCopyKey } from './finance-copy';
import { BalanceCard, CashFlowCard, ExchangeRatesCard, NextPaymentCard, OverviewAccountCard } from './finance-dashboard';
import { addFinancialDays, formatAmount, formatFinancialDate, formatMoney, formatProfileMoment, formatRate } from './finance-format';
import { AccountForm, TransactionForm } from './finance-forms';
import { FinanceIcon } from './finance-icon';
import { PaymentsScreen } from './finance-payments';
import { ReconciliationForm, reconciliationConflict } from './finance-reconciliation';
import { ScheduleScreen, scheduleOffset } from './finance-schedule';
import { financeHref, financePage, financePath, routeParameter } from './finance-navigation';
import type { FinancePage, FinanceRoute } from './finance-navigation';
import { scheduleCopy } from './finance-schedule-copy';
import { StatisticsScreen, useStatistics } from './finance-statistics';
import type { StatisticsPreset } from './finance-statistics';
import { appTabs } from './finance-tabs';
import type { FinanceTab } from './finance-tabs';
import { revisionFields, TransactionVersions } from './finance-transaction';
import { FinanceAlert, FinanceButton, palette, styles } from './finance-ui';
import { SupportScreen } from './support-screen';

type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];
type Page = { name: Exclude<FinanceTab, 'settings'> } | FinancePage;
type Receipt = { command: FinanceCommand; result: CommandResult };
type RouteReceipt = Receipt & { path: string; returnFrom?: string };
type Destination = { page: FinancePage; returnToOrigin?: boolean; dismissTo?: boolean; receipt?: Receipt };
type AccountNotice = { accountId: string; key: FinanceCopyKey };

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

function useWorkspaceModel(access: FinanceAccess, lang: Language) {
  const router = useRouter();
  const pathname = usePathname();
  const { accountId } = useGlobalSearchParams();
  const location = useRef({ pathname, accountId: routeParameter(accountId) });
  location.current = { pathname, accountId: routeParameter(accountId) };
  const [accounts, setAccounts] = useState<Account[]>();
  const [cardPreviews, setCardPreviews] = useState<Result<'listAccounts'>['cardPreviews']>([]);
  const [categories, setCategories] = useState<Category[]>();
  const [listError, setListError] = useState('');
  const [categoryError, setCategoryError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [receipt, setReceipt] = useState<RouteReceipt | null>(null);
  const [destination, setDestination] = useState<Destination>();
  const [accountNotice, setAccountNotice] = useState<AccountNotice>();
  const [revision, setRevision] = useState(0);
  const accountsRequest = useRef(0);
  const categoriesRequest = useRef(0);
  const activeAccounts = accounts?.filter((account) => !account.archived) ?? [];
  const archivedAccounts = accounts?.filter((account) => account.archived) ?? [];

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
        setCardPreviews(result.cardPreviews ?? []);
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

  function go(next: FinancePage) {
    void KeyboardController.dismiss();
    command.clearError();
    router.push(financeHref(next));
  }

  function invalidate() {
    setRevision((value) => value + 1);
  }

  const command = useFinanceCommand(access, (result, kind) => {
    const receipt = { command: kind, result };
    const current = location.current;
    void loadAccounts();
    invalidate();
    if ('occurrenceId' in result || 'replacementRule' in result) {
      const skipping = 'occurrenceId' in result;
      const ruleId = skipping ? result.ruleId : result.replacementRule.ruleId;
      const date = skipping ? result.date : result.replacementRule.firstDate;
      setDestination({ page: { name: 'schedule', accountId: current.accountId ?? null, ruleId,
        offset: scheduleOffset(access.profile.today, date) }, returnToOrigin: skipping && current.pathname.includes('/skip/'), receipt });
    } else if ('transactionId' in result) {
      const page = { name: 'transaction' as const, transactionId: result.transactionId };
      const path = financePath(page);
      if (current.pathname === path) setReceipt({ ...receipt, path });
      else setDestination({ page, returnToOrigin: current.pathname === path + '/edit', receipt });
    } else if ('accountId' in result) {
      const page: FinancePage = { name: kind === 'account.reconcile' ? 'manage' : 'history', accountId: result.accountId };
      const dismissTo = kind === 'account.reconcile' &&
        current.pathname === financePath({ name: 'reconcile', accountId: result.accountId });
      setDestination({ page, dismissTo, receipt });
    }
  });

  useEffect(() => {
    if (!destination || command.busy || !access.isCurrent()) return;
    setDestination(undefined);
    const path = financePath(destination.page);
    const back = destination.returnToOrigin && router.canDismiss();
    if (destination.receipt) setReceipt({ ...destination.receipt, path,
      ...(back && { returnFrom: pathname }) });
    if (back) router.back();
    else if (pathname === path) return;
    else if (destination.dismissTo) router.dismissTo(financeHref(destination.page));
    else if (appTabs(lang).some(({ route }) => pathname === '/' + route)) router.push(financeHref(destination.page));
    else router.replace(financeHref(destination.page));
  }, [destination, command.busy]);

  useEffect(() => {
    if (!command.reading) command.clearError();
    setAccountNotice((notice) => notice && pathname.startsWith('/accounts/' + encodeURIComponent(notice.accountId) + '/')
      ? notice : undefined);
    setReceipt((previous) => {
      if (!previous) return null;
      if (previous.returnFrom && pathname !== previous.returnFrom) {
        const { returnFrom: _origin, ...receipt } = previous;
        return { ...receipt, path: pathname };
      }
      return previous.path === pathname || previous.returnFrom === pathname ? previous : null;
    });
  }, [pathname]);

  useEffect(() => {
    void loadAccounts();
    void loadCategories();
  }, []);

  const blocked = command.busy || command.reading || command.pending !== null;
  return { access, lang, blocked, accounts, cardPreviews, categories, activeAccounts, archivedAccounts, listError, categoryError, refreshing,
    receipt: receipt?.path === pathname ? receipt : undefined, setReceipt, revision, command,
    accountNotice, setAccountNotice, loadAccounts, loadCategories, updateAccount, invalidate, go,
  };
}

const FinanceContext = createContext<ReturnType<typeof useWorkspaceModel> | null>(null);

export function FinanceWorkspace({ access, lang, children }: { access: FinanceAccess; lang: Language; children: ReactNode }) {
  const model = useWorkspaceModel(access, lang);
  return <FinanceContext value={model}>{children}</FinanceContext>;
}

export function useFinanceWorkspace() {
  const workspace = use(FinanceContext);
  if (!workspace) throw new Error('FinanceWorkspace is missing');
  return workspace;
}

export function FinanceTabScreen({ tab, statisticsPreset }: { tab: Exclude<FinanceTab, 'settings'>; statisticsPreset?: StatisticsPreset }) {
  return <FinanceScreen page={{ name: tab }} statisticsPreset={statisticsPreset} />;
}

export function FinanceRouteScreen({ route }: { route: FinanceRoute }) {
  const params = useLocalSearchParams();
  const page = financePage(route, params);
  return page ? <FinanceScreen page={page} inStack /> : <Redirect href="/accounts" />;
}

function useFinanceRead<T>(key: string | undefined, revision: number, access: FinanceAccess,
  read: (key: string, before?: string) => Promise<T>, enabled = true) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string; busy: boolean }>();
  const latest = useRef(0);
  const inFlight = useRef<number | undefined>(undefined);
  const visible = state?.key === key ? state : undefined;

  async function load(before?: string, append?: (previous: T, next: T) => T) {
    if (!key || !access.isCurrent() || (before && inFlight.current !== undefined)) return;
    const attempt = ++latest.current;
    inFlight.current = attempt;
    const current = () => attempt === latest.current && access.isCurrent();
    setState({ key, data: visible?.data, busy: true });
    try {
      const data = await read(key, before);
      if (current()) setState({ key, data: append && visible?.data ? append(visible.data, data) : data, busy: false });
    } catch (error) {
      if (!current()) return;
      const code = apiErrorCode(error);
      if (!access.onAccessFailure(code)) setState({ key, data: visible?.data, error: code, busy: false });
    } finally {
      if (inFlight.current === attempt) inFlight.current = undefined;
    }
  }

  useEffect(() => {
    if (enabled) void load();
    return () => { latest.current += 1; };
  }, [key, revision, enabled]);

  return { data: visible?.data, error: visible?.error, busy: !!key && (visible?.busy ?? true), load };
}

function FinanceScreen({ page, inStack = false, statisticsPreset }: { page: Page; inStack?: boolean; statisticsPreset?: StatisticsPreset }) {
  const { timeZoneSuggestion } = useAccessSession();
  const { access, lang, blocked, accounts, cardPreviews, categories, activeAccounts, archivedAccounts, listError, categoryError,
    refreshing, receipt, setReceipt, revision, command, accountNotice, setAccountNotice,
    loadAccounts, loadCategories, updateAccount, invalidate, go,
  } = useFinanceWorkspace();
  const router = useRouter();
  const [localWrite, setLocalWrite] = useState(false);
  const [afterSave, setAfterSave] = useState<{ page: FinancePage; replace?: boolean }>();
  const [scheduleRefresh, setScheduleRefresh] = useState(0);
  const [paymentsRefresh, setPaymentsRefresh] = useState(0);
  const t = financeCopy[lang];
  const s = scheduleCopy[lang];
  const focused = useIsFocused();
  const wasFocused = useRef(false);
  if (focused) wasFocused.current = true;
  const statistics = useStatistics(access, page.name === 'statistics' && wasFocused.current, revision, statisticsPreset);
  const showOverview = page.name === 'products';
  const previewsByAccount = new Map(cardPreviews.map((preview) => [preview.accountId, preview]));
  const overviewOpened = useRef(false);
  useEffect(() => {
    if (showOverview && focused) {
      if (overviewOpened.current) void loadAccounts();
      overviewOpened.current = true;
    }
  }, [showOverview, focused]);
  const { today, timeZone } = access.profile;
  const cashFlow = useFinanceRead(showOverview ? today : undefined, revision, access, (throughDate) =>
    request('getStatistics', { token: access.token,
      query: new URLSearchParams({ throughDate, fromDate: addFinancialDays(throughDate, -29), byWeek: 'true' }) }), focused);
  const exchangeRates = useFinanceRead(showOverview ? 'rates' : undefined, 0, access, () =>
    request('getExchangeRates', { token: access.token }), focused);
  const nextPayment = useFinanceRead(showOverview ? today + ':' + timeZone : undefined, revision, access, () =>
    request('getNextPayment', { token: access.token }), focused);
  const scroll = useRef<ComponentRef<typeof KeyboardAwareScrollView>>(null);
  const accountId = 'accountId' in page ? page.accountId : null;
  const account = accountId ? accounts?.find((entry) => entry.accountId === accountId) : undefined;
  const historyId = page.name === 'history' ? page.accountId : undefined;
  const transactionId = 'transactionId' in page ? page.transactionId : undefined;
  const history = useFinanceRead(historyId, revision, access, (accountId, before) =>
    request('listAccountHistory', { token: access.token, params: { accountId },
      query: before ? new URLSearchParams({ before }) : undefined }));
  const month = access.profile.today.slice(0, 7);
  const monthlyActivity = useFinanceRead(historyId && month + ':' + historyId, revision, access, (key) => {
    const [, accountId] = key.split(':');
    return request('getStatistics', { token: access.token, query: new URLSearchParams({ accountId }) });
  });
  const transaction = useFinanceRead(transactionId, revision, access, (transactionId) =>
    request('listTransactionVersions', { token: access.token, params: { transactionId } }));
  const showingSupport = page.name === 'support';
  const financeTab = page.name === 'products' || page.name === 'payments' || page.name === 'statistics';
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
  const activeTransaction = transaction.data;
  const currentVersion = activeTransaction?.versions.find(({ version }) => version === activeTransaction.transactionVersion);
  const initialRevision = activeTransaction && currentVersion && revisionFields(activeTransaction.type, currentVersion);
  const archivedTransaction = currentVersion?.movements.some(({ accountId }) => accounts?.find((item) => item.accountId === accountId)?.archived);
  const transactionChanged = command.error === 'VERSION_CONFLICT' || command.error === 'TRANSACTION_VOID' ||
    (page.name === 'revise' && page.version !== undefined && !!activeTransaction && page.version !== activeTransaction.transactionVersion);
  const formKind = page.name === 'record' ? page.kind : page.name === 'revise' ? initialRevision?.type : undefined;
  const receiptResult = receipt?.result;
  const receiptAccounts = receiptResult && ('fromAccount' in receiptResult ? [receiptResult.fromAccount, receiptResult.toAccount]
    : 'accounts' in receiptResult ? receiptResult.accounts : 'balanceMinor' in receiptResult ? [receiptResult] : []);
  const adjustment = receiptResult && 'adjustmentId' in receiptResult ? receiptResult : undefined;
  const reconciling = page.name === 'reconcile';
  const isForm = page.name === 'addAccount' || page.name === 'accountEditor' || reconciling || !!formKind ||
    (page.name === 'schedule' && (!!page.editor || !!page.skipDate));
  const showKeyboardToolbar = Platform.OS === 'ios' && isForm;

  useEffect(() => {
    if (!reconciling) return;
    if (reconciliationConflict(command.error)) scroll.current?.scrollTo({ y: 0, animated: false });
    if (command.error === 'ACCOUNT_UNAVAILABLE') void loadAccounts();
  }, [reconciling, command.error]);

  const writing = inStack && (localWrite || (focused && command.busy));
  usePreventRemove(writing);

  function returnTo(previous: FinancePage) {
    void KeyboardController.dismiss();
    if (router.canDismiss()) router.back();
    else router.replace(financeHref(previous));
  }

  useEffect(() => {
    if (!afterSave || writing || !focused) return;
    setAfterSave(undefined);
    if (afterSave.replace) router.replace(financeHref(afterSave.page));
    else returnTo(afterSave.page);
  }, [afterSave, writing, focused]);

  function openRecord(kind: TransactionFields['type'], accountId: string | null) {
    go({ name: 'record', kind, accountId });
  }

  function submitTransaction(fields: TransactionFields) {
    if (page.name === 'revise') {
      if (!activeTransaction || transactionChanged) return;
      void command.submit({ kind: 'transaction.revise', transactionId: page.transactionId,
        body: { ...fields, expectedTransactionVersion: page.version ?? activeTransaction.transactionVersion } });
    } else if (fields.type === 'transfer') {
      void command.submit({ kind: 'transfer.record', body: fields });
    } else {
      const { type, ...body } = fields;
      void command.submit({ kind: type === 'expense' ? 'expense.record' : 'income.record', body });
    }
  }

  function refresh() {
    if (writing) return;
    void loadAccounts();
    if (!categories) void loadCategories();
    if (showOverview) {
      void cashFlow.load();
      void exchangeRates.load();
      void nextPayment.load();
    }
    if (historyId) void history.load();
    if (historyId) void monthlyActivity.load();
    if (transactionId) void transaction.load();
    if (page.name === 'schedule') setScheduleRefresh((signal) => signal + 1);
    if (page.name === 'payments') setPaymentsRefresh((signal) => signal + 1);
    if (page.name === 'statistics') statistics.refresh();
  }

  function screenTitle() {
    switch (page.name) {
      case 'archive': return t.archived;
      case 'accountSettings': return t.manageAccounts;
      case 'addAccount': return t.addAccount;
      case 'manage': return t.manageAccount;
      case 'reconcile': return t.reconcileAccount;
      case 'history': return account?.name ?? t.history;
      case 'accountEditor': {
        const { editor } = page;
        if (editor.kind === 'card') return editor.cardId ? t.editCard : t.addCard;
        return editor.kind === 'rename' ? t.renameAccount : t.changeStartDate;
      }
      case 'record': return transactionLabels[page.kind];
      case 'revise': return t.editTransaction;
      case 'transaction': return activeTransaction ? historyTitles[activeTransaction.type] : t.transactionVersions;
      case 'schedule': {
        if (page.editor) return { create: s.newRule, edit: s.edit, replace: s.replacing }[page.editor];
        if (page.skipDate) return s.skip;
        return page.ruleId ? s.rule : s.schedule;
      }
      default: return '';
    }
  }

  if (page.name === 'history') {
    return <SafeAreaView style={layout.container} edges={['left', 'right', 'bottom']}>
      <Stack.Screen options={{ title: screenTitle(), gestureEnabled: !writing }} />
      <AccountOverview key={page.accountId} account={account} depositTerms={account ? depositTerms(account, lang) : ''}
        lang={lang} categories={categories} month={monthlyActivity.data?.fromDate.slice(0, 7) ?? month}
        totals={monthlyActivity.data?.totals}
        totalsError={!!monthlyActivity.error} history={history.data} historyBusy={history.busy} historyError={!!history.error}
        accountError={listError ? t.accountOverviewError : accounts && !account ? t.unavailable : undefined}
        refreshing={refreshing} onRefresh={refresh}
        created={receipt?.command === 'account.create'}
        onTransaction={(transactionId) => go({ name: 'transaction', transactionId })}
        onMore={() => {
          const cursor = history.data?.next;
          if (!cursor || history.busy || history.error || !focused) return;
          void history.load(cursor, (previous, next) => {
            const shown = new Set(previous.entries.map(({ type, id }) => type + ':' + id));
            return { ...next, entries: [...previous.entries, ...next.entries.filter(({ type, id }) => !shown.has(type + ':' + id))] };
          });
        }} />
    </SafeAreaView>;
  }

  return <SafeAreaView style={layout.container} edges={inStack ? ['left', 'right', 'bottom'] : ['top', 'left', 'right']}>
    {inStack && <Stack.Screen options={{ title: screenTitle(), gestureEnabled: !writing }} />}
    <KeyboardAwareScrollView ref={scroll} key={page.name + (historyId ?? '')}
      bottomOffset={showKeyboardToolbar ? 64 : 12} extraKeyboardSpace={showKeyboardToolbar ? 42 : 0}
      disableScrollOnKeyboardHide
      contentInsetAdjustmentBehavior={inStack ? 'never' : 'automatic'}
      keyboardDismissMode={isForm ? 'none' : 'on-drag'}
      keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}
      refreshControl={financeTab || page.name === 'archive' || page.name === 'accountSettings' || page.name === 'transaction' ||
        (page.name === 'schedule' && !page.editor && !page.skipDate)
        ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={palette.accent} colors={[palette.accent]} />
        : undefined}>
      {showingSupport && focused && <SupportScreen lang={lang} showHeading={false} />}
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
      {transactionId && transactionChanged && <FinanceButton title={t.reloadTransaction}
        onPress={() => {
          command.clearError();
          void loadAccounts();
          if (page.name === 'revise') router.dismissTo(financeHref({ name: 'transaction', transactionId }));
          else void transaction.load();
        }} disabled={blocked} testID="finance-reload-transaction" />}
      {focused && receipt && <View style={layout.panel} testID="finance-receipt" accessibilityLiveRegion="polite">
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

      {(financeTab || page.name === 'archive' || page.name === 'schedule' || page.name === 'accountSettings' ||
        page.name === 'manage' || page.name === 'accountEditor' ||
        page.name === 'transaction' || reconciling || !!formKind) && listError !== '' && <>
        <FinanceAlert>{localizedError(listError, lang, reconciling ? 'reconcile' : undefined)}</FinanceAlert>
        <FinanceButton title={copy[lang].retry} onPress={() => void loadAccounts()} />
      </>}
      {page.name === 'accountSettings' && <>
        <FinanceButton title={t.addAccount} icon="plus" primary disabled={blocked} testID="finance-add-account"
          onPress={() => go({ name: 'addAccount' })} />
        {accounts && [
          { title: t.activeAccounts, entries: activeAccounts, empty: t.noAccounts },
          { title: t.archived, entries: archivedAccounts, empty: t.noArchived },
        ].map(({ title, entries, empty }) => <View key={title} style={layout.section}>
          <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text>
          <View style={styles.surface}>
            {entries.length ? entries.map((entry, index) =>
              <AccountRow key={entry.accountId} account={entry} lang={lang} divider={index > 0}
                open={() => go({ name: 'manage', accountId: entry.accountId })} />)
              : <Text style={[styles.meta, layout.accountSettingsEmpty]}>{empty}</Text>}
          </View>
        </View>)}
      </>}
      {!accounts && refreshing && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
      </>}
      {page.name === 'products' && <>
        {timeZoneSuggestion}
        {accounts && <BalanceCard accounts={activeAccounts} lang={lang} />}
        {accounts && <View style={layout.section}>
          <Text accessibilityRole="header" style={styles.section}>{t.myAccounts}</Text>
          {activeAccounts.length ? activeAccounts.map((entry) => <OverviewAccountCard key={entry.accountId}
            account={entry} preview={previewsByAccount.get(entry.accountId)} lang={lang}
            onOpen={() => go({ name: 'history', accountId: entry.accountId })} />)
            : <Text style={styles.meta}>{t.addAccountInSettings}</Text>}
          {archivedAccounts.length > 0 && <Pressable accessibilityRole="button" onPress={() => go({ name: 'archive' })}
            style={({ pressed }) => [layout.archiveLink, pressed && layout.pressed]} testID="finance-archive">
            <FinanceIcon name="archive" color={palette.muted} size={16} />
            <Text style={styles.meta}>{t.archived}</Text>
          </Pressable>}
        </View>}
        <CashFlowCard read={cashFlow} accounts={accounts && activeAccounts} lang={lang}
          onStatistics={(preset) => router.navigate({ pathname: '/(app)/(tabs)/statistics',
            params: { ...preset, overview: String(Date.now()) } })} />
        <ExchangeRatesCard read={exchangeRates} lang={lang} />
        <NextPaymentCard read={nextPayment} categories={categories} lang={lang}
          onSchedule={(ruleId, date) => go({ name: 'schedule', accountId: null, ruleId,
            offset: date ? scheduleOffset(today, date) : undefined })} />
      </>}
      {page.name === 'archive' && accounts && (archivedAccounts.length > 0
        ? <View style={styles.surface}>
            {archivedAccounts.map((entry, index) => <AccountRow key={entry.accountId} account={entry} lang={lang}
              divider={index > 0}
              open={() => go({ name: 'history', accountId: entry.accountId })} />)}
          </View>
        : <Text style={styles.meta}>{t.noArchived}</Text>)}
      {page.name === 'statistics' && <>
        {categoryError && <View style={layout.section}>
          <FinanceAlert>{localizedError(categoryError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadCategories()} />
        </View>}
        <StatisticsScreen statistics={statistics} accounts={accounts} categories={categories} lang={lang}
          today={access.profile.today} scrollToTop={() => scroll.current?.scrollTo({ y: 0, animated: false })}
          onTransaction={({ transactionId }) => go({ name: 'transaction', transactionId })} />
      </>}
      {page.name === 'payments' && <PaymentsScreen access={access} lang={lang} accountCount={activeAccounts.length}
        categories={categories} blocked={blocked} focused={focused} refreshSignal={paymentsRefresh}
        onRecord={(kind) => openRecord(kind, null)}
        onSchedule={(ruleId) => go({ name: 'schedule', accountId: null, ruleId })} />}
      {page.name === 'schedule' && <>
        {categoryError && <View style={layout.section}>
          <FinanceAlert>{localizedError(categoryError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadCategories()} />
        </View>}
        <ScheduleScreen page={page} access={access} accounts={accounts} categories={categories} lang={lang}
          disabled={blocked || refreshing} visible={focused} refreshSignal={scheduleRefresh + revision} commandError={command.error}
          onSubmit={command.submit} onPage={(next) => {
            if (financePath(next) !== financePath(page)) go(next);
            else router.setParams({ accountId: next.accountId ?? '', offset: next.offset ?? 0, section: next.section ?? 'dates' });
          }} onSaving={setLocalWrite}
          onCancel={() => returnTo({ name: 'schedule', accountId: page.accountId })}
          onSaved={(next, created) => {
            invalidate();
            setAfterSave({ page: next, replace: created });
          }}
          onTransaction={({ transactionId }) => {
            if (transactionId) go({ name: 'transaction', transactionId });
          }} />
      </>}
      {page.name === 'addAccount' && <AccountForm lang={lang} today={access.profile.today} disabled={blocked} onSubmit={command.submit} />}
      {(page.name === 'manage' || page.name === 'accountEditor') && account && <AccountManagement
        key={account.accountId} account={account} access={access} lang={lang} disabled={blocked}
        editor={page.name === 'accountEditor' ? page.editor : undefined} onAccountChanged={updateAccount}
        notice={page.name === 'manage' && accountNotice?.accountId === account.accountId ? accountNotice.key : undefined}
        onBusy={setLocalWrite}
        onEdit={(editor) => {
          setAccountNotice(undefined);
          go({ name: 'accountEditor', accountId: account.accountId, editor });
        }}
        onFinish={(key) => {
          const management: FinancePage = { name: 'manage', accountId: account.accountId };
          if (!key) returnTo(management);
          else {
            setAccountNotice({ accountId: account.accountId, key });
            invalidate();
            setAfterSave({ page: management });
          }
        }}
        onReconcile={() => go({ name: 'reconcile', accountId: account.accountId })} />}
      {reconciling && account && (account.archived ? <FinanceAlert>{t.unavailable}</FinanceAlert>
        : <ReconciliationForm key={account.accountId} account={account} categories={categories} access={access}
          lang={lang} visible={focused} disabled={blocked || command.error === 'ACCOUNT_UNAVAILABLE'}
          commandError={command.error}
          onSubmit={(body) => void command.submit({ kind: 'account.reconcile', accountId: account.accountId, body })} />)}
      {transactionId && <>
        {transaction.busy && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
        {transaction.error && <>
          <FinanceAlert>{localizedError(transaction.error, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void transaction.load()} />
        </>}
      </>}
      {page.name === 'revise' && activeTransaction && (!initialRevision || archivedTransaction) &&
        <FinanceAlert>{t.unavailable}</FinanceAlert>}
      {page.name === 'revise' && transactionChanged && command.error === '' &&
        <FinanceAlert>{t.versionConflict}</FinanceAlert>}
      {accountId && (page.name === 'manage' || page.name === 'reconcile' || page.name === 'accountEditor') &&
        accounts && !account && !listError && <FinanceAlert>{t.unavailable}</FinanceAlert>}
      {formKind && <>
        {formKind !== 'transfer' && categoryError && <>
          <FinanceAlert>{localizedError(categoryError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadCategories()} />
        </>}
        {formKind !== 'transfer' && !categories && !categoryError &&
          <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
        {accounts && (categories || formKind === 'transfer') && !archivedTransaction && <TransactionForm
          key={page.name === 'revise' ? transactionId : formKind} lang={lang} today={access.profile.today}
          disabled={blocked || transactionChanged || transaction.busy || !!transaction.error} onSubmit={submitTransaction} accounts={activeAccounts}
          categories={categories ?? []} selectedAccountId={page.name === 'record' ? page.accountId : null}
          kind={formKind} initial={page.name === 'revise' ? initialRevision : undefined} />}
      </>}
      {page.name === 'transaction' && <>
        {activeTransaction && <>
          {archivedTransaction && currentVersion?.status === 'posted' && <Text style={styles.meta}>{t.archivedTransaction}</Text>}
          {accounts && initialRevision && !archivedTransaction && <View style={layout.actions}>
            <FinanceButton title={t.editTransaction} onPress={() => go({ name: 'revise', transactionId: page.transactionId, version: activeTransaction.transactionVersion })}
              disabled={blocked || transaction.busy || transactionChanged} testID="finance-edit-transaction" />
            <FinanceButton title={t.voidTransaction} testID="finance-void-transaction"
              disabled={blocked || transaction.busy || transactionChanged}
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
    </KeyboardAwareScrollView>
    {focused && showKeyboardToolbar && <KeyboardToolbar>
      <KeyboardToolbar.Content>
        <Pressable accessibilityRole="button" onPress={() => void KeyboardController.dismiss()}
          style={layout.keyboardDone} testID="finance-keyboard-done">
          <Text style={styles.buttonText}>{t.done}</Text>
        </Pressable>
      </KeyboardToolbar.Content>
    </KeyboardToolbar>}
  </SafeAreaView>;
}

function accountType(account: Account, lang: Language) {
  return financeCopy[lang]['type' in account ? account.type : 'regular'];
}

function depositTerms(account: Account, lang: Language) {
  if (!('type' in account) || account.type !== 'deposit') return '';
  const rate = formatRate(account.annualRatePercent, lang);
  return rate + '% · ' + formatFinancialDate(account.maturityDate, lang);
}

function AccountRow({ account, lang, divider, open }: { account: Account; lang: Language; divider: boolean; open: () => void }) {
  const type = 'type' in account ? account.type : 'regular';
  const terms = depositTerms(account, lang);
  return <Pressable accessibilityRole="button" testID={'finance-account-' + account.accountId}
    onPress={open} style={({ pressed }) => [layout.accountRow, divider && layout.rowDivider, pressed && layout.pressed]}>
    <View style={layout.accountIdentity}>
      <FinanceIcon name={type === 'regular' ? 'card' : type} color={palette.muted} />
      <View style={layout.accountLabels}>
        <Text style={styles.title}>{account.name}</Text>
        <Text style={styles.meta}>{accountType(account, lang)}
          {terms ? ' · ' + terms : ''}</Text>
        {account.needsReconciliation && <Text style={styles.meta}>{financeCopy[lang].needsReconciliation}</Text>}
      </View>
    </View>
    <Text style={layout.accountValue}>{formatAmount(account.balanceMinor, lang)} <Text style={layout.currencyCode}>{account.currency}</Text></Text>
  </Pressable>;
}

const layout = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.ground },
  currencyRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline',
    gap: 8, paddingVertical: 3 },
  currencyCode: { color: palette.muted, fontSize: 11, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  section: { gap: 10 },
  panel: { backgroundColor: palette.raised, padding: 14, borderRadius: 16, gap: 8 },
  keyboardDone: { minHeight: 42, justifyContent: 'center', alignSelf: 'flex-end', paddingHorizontal: 16 },
  archiveLink: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  accountRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', paddingHorizontal: 12,
    paddingVertical: 9, minHeight: 59 },
  rowDivider: { borderTopColor: palette.line, borderTopWidth: StyleSheet.hairlineWidth },
  pressed: { backgroundColor: palette.ground },
  accountSettingsEmpty: { padding: 12 },
  accountIdentity: { flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexBasis: '44%', minWidth: 104, gap: 10 },
  accountLabels: { flex: 1, gap: 2 },
  accountValue: { color: palette.ink, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'],
    textAlign: 'right', marginLeft: 'auto', flexShrink: 1 },
});
