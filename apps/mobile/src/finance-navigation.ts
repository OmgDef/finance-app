import type { TransactionFields } from './finance-commands';
import { financialDate } from './finance-format';
import type { SchedulePage } from './finance-schedule';

export type AccountEditor = { kind: 'rename' | 'startDate' } | { kind: 'card'; cardId?: string };
type AccountPage = { name: 'history' | 'manage' | 'reconcile'; accountId: string } |
  { name: 'accountEditor'; accountId: string; editor: AccountEditor };
export type FinancePage = { name: 'archive' | 'addAccount' | 'accountSettings' } | AccountPage | SchedulePage |
  { name: 'record'; kind: TransactionFields['type']; accountId: string | null } |
  { name: 'transaction'; transactionId: string } | { name: 'revise'; transactionId: string; version?: number };

export type FinanceRoute = Exclude<FinancePage['name'], 'schedule' | 'accountEditor'> |
  'accountRename' | 'accountStartDate' | 'cardCreate' | 'cardEdit' |
  'schedule' | 'scheduleRule' | 'scheduleCreate' | 'scheduleEdit' | 'scheduleReplace' | 'scheduleSkip';

export function routeParameter(value: string | string[] | undefined) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function financePage(route: FinanceRoute, params: Record<string, string | string[] | undefined>): FinancePage | undefined {
  const accountId = routeParameter(params.accountId);
  const transactionId = routeParameter(params.transactionId);
  switch (route) {
    case 'archive':
    case 'accountSettings':
    case 'addAccount': return { name: route };
    case 'history':
    case 'manage':
    case 'reconcile': return accountId ? { name: route, accountId } : undefined;
    case 'accountRename':
    case 'accountStartDate':
    case 'cardCreate':
    case 'cardEdit': {
      const cardId = routeParameter(params.cardId);
      if (!accountId || (route === 'cardEdit' && !cardId)) return;
      const editor: AccountEditor = route === 'accountRename' ? { kind: 'rename' } : route === 'accountStartDate'
        ? { kind: 'startDate' } : { kind: 'card', cardId };
      return { name: 'accountEditor', accountId, editor };
    }
    case 'transaction': return transactionId ? { name: route, transactionId } : undefined;
    case 'revise': {
      const version = Number(routeParameter(params.version));
      return transactionId ? { name: route, transactionId,
        version: Number.isSafeInteger(version) && version > 0 ? version : undefined } : undefined;
    }
    case 'record': {
      const kind = params.kind;
      if (kind === 'expense' || kind === 'income' || kind === 'transfer') return { name: route, kind, accountId: accountId ?? null };
      return;
    }
    default: {
      const ruleId = routeParameter(params.ruleId);
      if (route !== 'schedule' && route !== 'scheduleCreate' && !ruleId) return;
      const date = routeParameter(params.date);
      if (route === 'scheduleSkip' && (!date || financialDate(date, 'en') !== date)) return;
      const offset = Number(routeParameter(params.offset));
      return {
        name: 'schedule', accountId: accountId ?? null, ruleId,
        editor: route === 'scheduleCreate' ? 'create' : route === 'scheduleEdit' ? 'edit'
          : route === 'scheduleReplace' ? 'replace' : undefined,
        skipDate: route === 'scheduleSkip' ? date : undefined,
        offset: Number.isInteger(offset) && Math.abs(offset) < 10_000 ? offset : 0,
        section: params.section === 'rules' ? 'rules' : 'dates',
      };
    }
  }
}

export function financePath(page: FinancePage): string {
  switch (page.name) {
    case 'archive': return '/accounts/archive';
    case 'accountSettings': return '/settings/accounts';
    case 'addAccount': return '/accounts/new';
    case 'history': return '/accounts/' + encodeURIComponent(page.accountId);
    case 'manage': return '/accounts/' + encodeURIComponent(page.accountId) + '/manage';
    case 'reconcile': return '/accounts/' + encodeURIComponent(page.accountId) + '/reconcile';
    case 'accountEditor': {
      const account = '/accounts/' + encodeURIComponent(page.accountId);
      const { editor } = page;
      if (editor.kind === 'card') return account + '/cards/' + (editor.cardId ? encodeURIComponent(editor.cardId) : 'new');
      return account + (editor.kind === 'rename' ? '/rename' : '/start-date');
    }
    case 'transaction': return '/transactions/' + encodeURIComponent(page.transactionId);
    case 'revise': return '/transactions/' + encodeURIComponent(page.transactionId) + '/edit';
    case 'record': return '/transactions/new/' + page.kind;
    case 'schedule': {
      if (page.editor === 'create') return '/schedule/new';
      if (!page.ruleId) return '/schedule';
      const rule = '/schedule/' + encodeURIComponent(page.ruleId);
      if (page.editor) return rule + '/' + page.editor;
      return page.skipDate ? rule + '/skip/' + encodeURIComponent(page.skipDate) : rule;
    }
  }
}

export function financeHref(page: FinancePage) {
  const query = new URLSearchParams();
  if ((page.name === 'schedule' || page.name === 'record') && page.accountId) query.set('accountId', page.accountId);
  if (page.name === 'revise' && page.version) query.set('version', String(page.version));
  if (page.name === 'schedule') {
    if (page.offset) query.set('offset', String(page.offset));
    if (page.section === 'rules') query.set('section', 'rules');
  }
  const params = query.toString();
  return financePath(page) + (params ? '?' + params : '');
}
