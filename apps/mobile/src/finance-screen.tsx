import { createContext, use, useEffect, useRef, useState } from 'react';
import type { ComponentRef, ReactNode } from 'react';
import { Redirect, Stack, useGlobalSearchParams, useIsFocused, useLocalSearchParams, usePathname, usePreventRemove, useRouter } from 'expo-router';
import {
  ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, RefreshControl,
  StyleSheet, Text, View,
} from 'react-native';
import { KeyboardController, KeyboardStickyView, KeyboardToolbar } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccessSession } from './access-session';
import type { Language, Result } from '@teta/contracts';
import { request } from './api';
import { copy } from './copy';
import { AccountManagement } from './finance-account-management';
import { AccountOverview } from './finance-account-overview';
import { CardDetails } from './finance-card-details';
import { apiErrorCode, useFinanceCommand } from './finance-commands';
import type { CommandResult, FinanceAccess, FinanceCommand, TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import type { FinanceCopyKey } from './finance-copy';
import { BalanceCard, CashFlowCard, ExchangeRatesCard, OverviewAccountCard } from './finance-dashboard';
import { formatFinancialDate, formatMoney, formatProfileMoment, formatRate, recentStatisticsPeriod } from './finance-format';
import { AccountForm, TransactionForm } from './finance-forms';
import { FinanceIcon } from './finance-icon';
import { PaymentsScreen } from './finance-payments';
import { ReconciliationForm, reconciliationConflict } from './finance-reconciliation';
import { ScheduleScreen, scheduleOffset } from './finance-schedule';
import { financeHref, financePage, financePath, routeParameter } from './finance-navigation';
import type { FinancePage, FinanceRoute } from './finance-navigation';
import { scheduleCopy } from './finance-schedule-copy';
import { AccountStatementForm, statementCopy } from './finance-statement';
import { StatisticsScreen, useStatistics } from './finance-statistics';
import type { StatisticsFilterEditor, StatisticsPreset } from './finance-statistics';
import { statisticsCopy } from './finance-statistics-copy';
import { appTabs } from './finance-tabs';
import type { FinanceTab } from './finance-tabs';
import { revisionFields, TransactionSummary } from './finance-transaction';
import { FinanceAlert, FinanceButton, FinanceScrollView, palette, styles } from './finance-ui';
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
  const [statisticsFilterEditor, setStatisticsFilterEditor] = useState<StatisticsFilterEditor>();
  const [revision, setRevision] = useState(0);
  const [lastExpenseAccountId, setLastExpenseAccountId] = useState<string>();
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

  function openStatisticsFilters(editor: StatisticsFilterEditor) {
    setStatisticsFilterEditor(editor);
    router.navigate('/(app)/statistics-filters');
  }

  function invalidate() {
    setRevision((value) => value + 1);
  }

  const command = useFinanceCommand(access, (result, kind) => {
    const receipt = { command: kind, result };
    const current = location.current;
    if (kind === 'expense.record' && 'transactionId' in result && 'accountId' in result) {
      setLastExpenseAccountId(result.accountId);
    }
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
    if (destination.page.name === 'schedule' && pathname !== '/schedule' && !pathname.startsWith('/schedule/')) {
      const result = destination.receipt?.result;
      const s = scheduleCopy[lang];
      if (result && 'occurrenceId' in result) {
        Alert.alert(s.dateSkipped, formatFinancialDate(result.date, lang));
      } else if (result && 'replacementRule' in result) {
        Alert.alert(s.ruleReplaced, `${s.replacementDate} · ${formatFinancialDate(result.transitionDate, lang)}`);
      }
      return;
    }
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
    if (pathname !== '/statistics-filters') setStatisticsFilterEditor(undefined);
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
    statisticsFilterEditor, openStatisticsFilters, lastExpenseAccountId,
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
    loadAccounts, loadCategories, updateAccount, invalidate, go, openStatisticsFilters, lastExpenseAccountId,
  } = useFinanceWorkspace();
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const [footerHeight, setFooterHeight] = useState(0);
  const [localWrite, setLocalWrite] = useState(false);
  const [afterSave, setAfterSave] = useState<{ page: FinancePage; replace?: boolean; dismissTo?: boolean }>();
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
      query: new URLSearchParams({ ...recentStatisticsPeriod(throughDate), byWeek: 'true' }) }), focused);
  const exchangeRates = useFinanceRead(showOverview ? 'rates' : undefined, 0, access, () =>
    request('getExchangeRates', { token: access.token }), focused);
  const scroll = useRef<ComponentRef<typeof FinanceScrollView>>(null);
  const accountId = 'accountId' in page ? page.accountId : null;
  const account = accountId ? accounts?.find((entry) => entry.accountId === accountId) : undefined;
  const historyId = page.name === 'history' ? page.accountId : undefined;
  const transactionId = 'transactionId' in page ? page.transactionId : undefined;
  const linkedCards = useFinanceRead(page.name === 'cardDetails' ? page.accountId : historyId, revision, access, (accountId) =>
    request('listAccountCards', { token: access.token, params: { accountId } }), focused);
  const history = useFinanceRead(historyId, revision, access, (accountId, before) =>
    request('listAccountHistory', { token: access.token, params: { accountId },
      query: before ? new URLSearchParams({ before }) : undefined }));
  const balanceSeries = useFinanceRead(historyId && account ? `${historyId}:${today}:${account.accountVersion}` : undefined,
    revision, access, (key) => request('getAccountBalanceSeries', {
      token: access.token, params: { accountId: key.split(':')[0] },
    }));
  const month = access.profile.today.slice(0, 7);
  const monthlyActivity = useFinanceRead(historyId && month + ':' + historyId, revision, access, (key) => {
    const [, accountId] = key.split(':');
    return request('getStatistics', { token: access.token, query: new URLSearchParams({ accountId, byWeek: 'true' }) });
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
  const defaultCategoryId = page.name === 'record' ? page.categoryId : undefined;
  const quickExpense = formKind === 'expense' && !!defaultCategoryId;
  const receiptResult = receipt?.result;
  const receiptAccounts = receiptResult && ('fromAccount' in receiptResult ? [receiptResult.fromAccount, receiptResult.toAccount]
    : 'accounts' in receiptResult ? receiptResult.accounts : 'balanceMinor' in receiptResult ? [receiptResult] : []);
  const adjustment = receiptResult && 'adjustmentId' in receiptResult ? receiptResult : undefined;
  const reconciling = page.name === 'reconcile';
  const isForm = page.name === 'addAccount' || page.name === 'accountEditor' || reconciling || !!formKind ||
    (page.name === 'schedule' && (!!page.editor || !!page.skipDate));
  const showKeyboardToolbar = Platform.OS === 'ios' && isForm && !quickExpense;

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
    if (afterSave.dismissTo) router.dismissTo(financeHref(afterSave.page));
    else if (afterSave.replace) router.replace(financeHref(afterSave.page));
    else returnTo(afterSave.page);
  }, [afterSave, writing, focused]);

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
    if (!categories || page.name === 'payments') void loadCategories();
    if (showOverview) {
      void cashFlow.load();
      void exchangeRates.load();
    }
    if (historyId) {
      void linkedCards.load();
      void history.load();
      void balanceSeries.load();
      void monthlyActivity.load();
    }
    if (transactionId) void transaction.load();
    if (page.name === 'schedule') setScheduleRefresh((signal) => signal + 1);
    if (page.name === 'payments') setPaymentsRefresh((signal) => signal + 1);
    if (page.name === 'statistics') statistics.refresh();
  }

  function showTransactionActions(transactionId: string, version: number) {
    const edit = () => go({ name: 'revise', transactionId, version });
    const confirmVoid = () => Alert.alert(t.voidTitle, t.voidExplanation, [
      { text: copy[lang].cancel, style: 'cancel' },
      { text: t.voidTransaction, style: 'destructive', onPress: () => void command.submit({
        kind: 'transaction.void', transactionId, body: { expectedTransactionVersion: version },
      }) },
    ]);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({
        options: [t.editTransaction, t.voidTransaction, copy[lang].cancel], destructiveButtonIndex: 1, cancelButtonIndex: 2,
      }, (button) => {
        if (button === 0) edit();
        if (button === 1) confirmVoid();
      });
    } else {
      Alert.alert(t.transactionActions, undefined, [
        { text: t.editTransaction, onPress: edit },
        { text: copy[lang].cancel, style: 'cancel' },
        { text: t.voidTransaction, style: 'destructive', onPress: confirmVoid },
      ], { cancelable: true });
    }
  }

  function screenTitle() {
    switch (page.name) {
      case 'archive': return t.archived;
      case 'accountSettings': return t.manageAccounts;
      case 'addAccount': return t.addAccount;
      case 'manage': return t.manageAccount;
      case 'reconcile': return t.reconcileAccount;
      case 'statement': return statementCopy[lang].title;
      case 'history': return account?.name ?? t.history;
      case 'accountEditor': {
        const { editor } = page;
        if (editor.kind === 'card') return editor.cardId ? t.editCard : t.addCard;
        return editor.kind === 'rename' ? t.renameAccount : t.changeStartDate;
      }
      case 'record': return transactionLabels[page.kind];
      case 'revise': return t.editTransaction;
      case 'transaction': return activeTransaction ? historyTitles[activeTransaction.type] : t.transactionDetails;
      case 'schedule': {
        if (page.editor) return { create: s.newRule, edit: s.edit, replace: s.replacing }[page.editor];
        if (page.skipDate) return s.skip;
        return page.ruleId ? s.rule : s.scheduleSettings;
      }
      default: return '';
    }
  }

  if (page.name === 'cardDetails') {
    const { accountId, cardId } = page;
    const card = linkedCards.data?.cards.find((entry) => entry.cardId === cardId);
    const accountHistory = { name: 'history' as const, accountId };
    return <CardDetails card={card} accountName={account?.name} lang={lang} loading={linkedCards.busy}
      error={linkedCards.error && linkedCards.error !== 'NOT_FOUND' ? t.cardsLoadError : undefined}
      editDisabled={blocked || !account} onClose={() => returnTo(accountHistory)}
      onOpenAccount={() => router.dismissTo(financeHref(accountHistory))} onRetry={() => void linkedCards.load()}
      onEdit={() => go({ name: 'accountEditor', accountId, editor: { kind: 'card', cardId }, fromCardDetails: true })} />;
  }

  if (page.name === 'history') {
    return <SafeAreaView style={layout.container} edges={['left', 'right']}>
      <Stack.Screen options={{ title: screenTitle(), gestureEnabled: !writing }} />
      <AccountOverview key={page.accountId} account={account} depositTerms={account ? depositTerms(account, lang) : ''}
        lang={lang} categories={categories} month={monthlyActivity.data?.fromDate.slice(0, 7) ?? month}
        cards={linkedCards.data?.cards} cardsError={!!linkedCards.error}
        balanceSeries={balanceSeries.data} balanceSeriesError={!!balanceSeries.error} monthlyActivity={monthlyActivity.data}
        totalsError={!!monthlyActivity.error} history={history.data} historyBusy={history.busy} historyError={!!history.error}
        accountError={listError ? t.accountOverviewError : accounts && !account ? t.unavailable : undefined}
        refreshing={refreshing} onRefresh={refresh}
        statementTitle={statementCopy[lang].title} onStatement={() => go({ name: 'statement', accountId: page.accountId })}
        created={receipt?.command === 'account.create'}
        onOpenCard={(cardId) => go({ name: 'cardDetails', accountId: page.accountId, cardId })}
        onManageCards={() => go({ name: 'manage', accountId: page.accountId })}
        onReloadCards={() => void linkedCards.load()}
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

  const footerOffset = quickExpense ? Math.max(0, footerHeight - bottom) : 0;
  const renderScreen = (transactionForm?: ReactNode, footer?: ReactNode) => <SafeAreaView style={layout.container}
    edges={inStack ? ['left', 'right'] : ['top', 'left', 'right']}>
    {inStack && <Stack.Screen options={{
      title: screenTitle(), gestureEnabled: !writing,
      headerRight: page.name === 'transaction' && activeTransaction && accounts && initialRevision && !archivedTransaction
        ? () => <Pressable accessibilityRole="button" accessibilityLabel={t.transactionActions}
          disabled={blocked || transaction.busy || transactionChanged} testID="finance-transaction-actions"
          onPress={() => showTransactionActions(page.transactionId, activeTransaction.transactionVersion)}
          style={({ pressed }) => [layout.transactionActions, (pressed || blocked || transaction.busy || transactionChanged) && styles.dimmed]}>
          <Text accessible={false} style={layout.transactionActionsIcon}>⋯</Text>
        </Pressable> : undefined,
    }} />}
    <FinanceScrollView ref={scroll} key={page.name + (historyId ?? '')} nativeTab={!inStack}
      bottomOffset={showKeyboardToolbar ? 64 : footerOffset + 12} extraKeyboardSpace={showKeyboardToolbar ? 42 : footerOffset}
      disableScrollOnKeyboardHide
      keyboardDismissMode={isForm ? 'none' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      refreshControl={financeTab || page.name === 'archive' || page.name === 'accountSettings' || page.name === 'transaction' ||
        (page.name === 'schedule' && !page.editor && !page.skipDate)
        ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={palette.accent} colors={[palette.accent]} />
        : undefined}>
      {page.name === 'statistics' && <Text accessibilityRole="header" style={styles.heading}>{statisticsCopy[lang].title}</Text>}
      {showingSupport && <Text accessibilityRole="header" style={styles.heading}>{copy[lang].help}</Text>}
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
              {accounts?.find(({ accountId }) => accountId === item.accountId)?.name ?? t.account}
            </Text>}
            <Text style={styles.value}>{formatMoney(item.balanceMinor, item.currency, lang)}</Text>
          </View>)}
        </>}
        <FinanceButton title={t.dismiss} onPress={() => setReceipt(null)} />
      </View>}

      {(financeTab || page.name === 'archive' || page.name === 'schedule' || page.name === 'accountSettings' ||
        page.name === 'manage' || page.name === 'accountEditor' || page.name === 'statement' ||
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
          {activeAccounts.length ? <View style={[styles.surface, layout.accountGroup]}>
            {activeAccounts.map((entry, index) => <OverviewAccountCard key={entry.accountId}
              account={entry} preview={previewsByAccount.get(entry.accountId)} lang={lang} divider={index > 0}
              onOpen={() => go({ name: 'history', accountId: entry.accountId })} />)}
          </View>
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
          onEditFilters={openStatisticsFilters} scrollToTop={() => scroll.current?.scrollTo({ y: 0, animated: false })}
          onTransaction={({ transactionId }) => go({ name: 'transaction', transactionId })} />
      </>}
      {page.name === 'payments' && <>
        {categoryError && <View style={layout.section}>
          <FinanceAlert>{localizedError(categoryError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadCategories()} />
        </View>}
        <PaymentsScreen access={access} lang={lang} accountCount={activeAccounts.length}
          categories={categories} blocked={blocked} focused={focused} refreshSignal={paymentsRefresh}
          onRecord={(kind, categoryId) => go({ name: 'record', kind, accountId: null, categoryId })} />
      </>}
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
          if (page.name === 'accountEditor' && page.fromCardDetails && page.editor.kind === 'card' && page.editor.cardId) {
            const details: FinancePage = { name: 'cardDetails', accountId: account.accountId, cardId: page.editor.cardId };
            if (!key) returnTo(details);
            else {
              invalidate();
              setAfterSave(key === 'cardDeleted' ? { page: { name: 'history', accountId: account.accountId }, dismissTo: true }
                : { page: details });
            }
            return;
          }
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
      {page.name === 'statement' && (account
        ? <AccountStatementForm key={account.accountId + account.startDate + today + lang}
          account={account} access={access} lang={lang} focused={focused} />
        : !accounts && !listError && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />)}
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
      {accountId && (page.name === 'manage' || page.name === 'reconcile' || page.name === 'accountEditor' || page.name === 'statement') &&
        accounts && !account && !listError && <FinanceAlert>{t.unavailable}</FinanceAlert>}
      {formKind && <>
        {formKind !== 'transfer' && categoryError && <>
          <FinanceAlert>{localizedError(categoryError, lang)}</FinanceAlert>
          <FinanceButton title={copy[lang].retry} onPress={() => void loadCategories()} />
        </>}
        {formKind !== 'transfer' && !categories && !categoryError &&
          <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
        {transactionForm}
      </>}
      {page.name === 'transaction' && activeTransaction && currentVersion && <>
        <TransactionSummary history={activeTransaction} current={currentVersion} lang={lang} timeZone={timeZone}
          accounts={accounts ?? []} categories={categories ?? []} />
        {archivedTransaction && currentVersion.status === 'posted' && <Text style={styles.meta}>{t.archivedTransaction}</Text>}
      </>}
    </FinanceScrollView>
    {footer && <KeyboardStickyView enabled={focused} offset={{ opened: bottom }} style={layout.formFooter}
      onLayout={({ nativeEvent }) => setFooterHeight(nativeEvent.layout.height)}>
      <View style={[layout.formFooterContent, { paddingBottom: bottom + 8 }]}>{footer}</View>
    </KeyboardStickyView>}
    {focused && showKeyboardToolbar && <KeyboardToolbar>
      <KeyboardToolbar.Content>
        <Pressable accessibilityRole="button" onPress={() => void KeyboardController.dismiss()}
          style={layout.keyboardDone} testID="finance-keyboard-done">
          <Text style={styles.buttonText}>{t.done}</Text>
        </Pressable>
      </KeyboardToolbar.Content>
    </KeyboardToolbar>}
  </SafeAreaView>;

  if (!formKind || !accounts || (!categories && formKind !== 'transfer') || archivedTransaction) return renderScreen();

  const preferredAccount = quickExpense ? activeAccounts.find(({ accountId }) => accountId === lastExpenseAccountId) : undefined;
  const form = <TransactionForm key={page.name === 'revise' ? transactionId : [formKind, defaultCategoryId].join(':')}
    lang={lang} today={today} disabled={blocked || transactionChanged || transaction.busy || !!transaction.error}
    onSubmit={submitTransaction} accounts={activeAccounts} categories={categories ?? []}
    selectedAccountId={page.name === 'record' ? page.accountId ?? preferredAccount?.accountId ?? null : null}
    kind={formKind} defaultCategoryId={defaultCategoryId} initial={page.name === 'revise' ? initialRevision : undefined}
    renderQuickLayout={quickExpense ? renderScreen : undefined} />;
  return quickExpense ? form : renderScreen(form);
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
    <Text style={layout.accountValue}>{formatMoney(account.balanceMinor, account.currency, lang)}</Text>
  </Pressable>;
}

const layout = StyleSheet.create({
  transactionActions: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  transactionActionsIcon: { color: palette.ink, fontSize: 24, fontWeight: '600' },
  container: { flex: 1, backgroundColor: palette.ground },
  accountGroup: { overflow: 'hidden' },
  formFooter: { backgroundColor: palette.panel, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  formFooterContent: { width: '100%', maxWidth: 540, alignSelf: 'center', paddingTop: 10, paddingHorizontal: 18 },
  currencyRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline',
    gap: 8, paddingVertical: 3 },
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
