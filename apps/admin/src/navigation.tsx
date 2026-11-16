import { useSyncExternalStore } from 'react';
import type { ComponentProps } from 'react';

const base = import.meta.env.BASE_URL.slice(0, -1);

export const adminPaths = {
  home: import.meta.env.BASE_URL,
  users: base + '/users',
  audit: base + '/audit',
  support: base + '/support',
  finance: (userId: string) => `${base}/users/${userId}/finance`,
  recoveryReview: (userId: string) => `${base}/users/${userId}/recovery-review`,
  account: (userId: string, accountId: string) => `${base}/users/${userId}/finance/accounts/${accountId}`,
  schedule: (userId: string, accountId: string, ruleId?: string) =>
    `${base}/users/${userId}/finance/accounts/${accountId}/schedule${ruleId ? '/' + ruleId : ''}`,
  transaction: (userId: string, accountId: string, transactionId: string) =>
    `${base}/users/${userId}/finance/accounts/${accountId}/transactions/${transactionId}`,
};

export type FinanceRoute = {
  page: 'finance'; userId: string; accountId?: string; transactionId?: string; schedule?: { ruleId?: string };
};

type AdminRoute = FinanceRoute | { page: 'recoveryReview'; userId: string } |
  { page: 'users' | 'audit' | 'support' | 'notFound' };

const id = /^[a-f0-9-]{36}$/;
const locationChanged = 'admin-location-changed';
const pathname = () => window.location.pathname;

export function adminRoute(path: string): AdminRoute {
  const clean = path.replace(/\/$/, '');
  if (clean === base || clean === adminPaths.users) return { page: 'users' };
  if (clean === adminPaths.audit) return { page: 'audit' };
  if (clean === adminPaths.support) return { page: 'support' };

  if (!clean.startsWith(adminPaths.home)) return { page: 'notFound' };
  const [section, userId, page, accounts, accountId, detail, detailId, extra] = clean.slice(adminPaths.home.length).split('/');
  if (section === 'users' && id.test(userId ?? '') && extra === undefined) {
    if (page === 'recovery-review' && accounts === undefined) return { page: 'recoveryReview', userId };
    if (page === 'finance') {
      if (accounts === undefined) return { page: 'finance', userId };
      if (accounts === 'accounts' && id.test(accountId ?? '')) {
        const account = { page: 'finance' as const, userId, accountId };
        if (detail === undefined) return account;
        if (detail === 'schedule' && (detailId === undefined || id.test(detailId))) {
          return { ...account, schedule: { ruleId: detailId } };
        }
        if (detail === 'transactions' && id.test(detailId ?? '')) return { ...account, transactionId: detailId };
      }
    }
  }
  return { page: 'notFound' };
}

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener(locationChanged, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(locationChanged, listener);
  };
}

export function useAdminPath() {
  return useSyncExternalStore(subscribe, pathname);
}

export function navigate(path: string, replace = false) {
  if (path === pathname()) return;
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(locationChanged));
}

export function AdminLink({ href, disabled, onClick, ...props }: ComponentProps<'a'> & { href: string; disabled?: boolean }) {
  return <a {...props} href={disabled ? undefined : href} role={disabled ? 'link' : undefined}
    aria-disabled={disabled || undefined} onClick={(event) => {
      if (disabled || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      onClick?.(event);
      if (!event.defaultPrevented) {
        event.preventDefault();
        navigate(href);
      }
    }} />;
}
