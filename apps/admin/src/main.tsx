import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Language, Result } from '@teta/contracts';
import { api, ApiError } from './api';
import { auditWords } from './audit-copy';
import { AuditWorkspace } from './audit-workspace';
import { CommandRecovery, useAdminCommands } from './commands';
import { financeWords } from './finance-copy';
import { useQuery } from './finance-ui';
import { FinanceWorkspace } from './finance-workspace';
import { AdminLink, adminPaths, adminRoute, navigate, useAdminPath } from './navigation';
import { RecoveryReview } from './recovery-review';
import { supportTitle, SupportWorkspace } from './support-workspace';
import '@fontsource-variable/dm-sans';
import './styles.css';

const words = {
  en: {
    console: 'Administration', title: 'Sign in', login: 'Administrator email', password: 'Password',
    continue: 'Continue', totp: 'Authenticator code', verify: 'Verify code', recover: 'Set up or recover access',
    recovery: 'Recovery secret', setup: 'Add this key to your authenticator, then enter its current code.',
    back: 'Back to sign in', users: 'User access', create: 'Create account', email: 'User email',
    issue: 'Issue code', revoke: 'Revoke all devices', block: 'Block account', unblock: 'Activate account',
    confirmRevoke: 'Revoke access on all devices for this account?', confirmBlock: 'Block the account and revoke all devices and codes?',
    signOut: 'Sign out', active: 'Active', blocked: 'Blocked', review: 'Awaiting review', registered: 'Has active devices',
    unregistered: 'No active devices', empty: 'No accounts yet.', more: 'Load more', expires: 'Expires',
    close: 'Dismiss code', configured: 'Authenticator saved. Sign in with a new code from the next 30-second window.',
    waiting: 'Working…', generic: 'The request could not be completed.',
    pageMissing: 'Page not found', userMissing: 'User not found.',
    ADMIN_AUTH_INVALID: 'Check your credentials or sign in again.', RATE_LIMITED: 'Too many attempts. Try again in',
    CSRF_INVALID: 'The request could not be verified. Reload this page.', EMAIL_EXISTS: 'An account already uses this email.',
    ACCOUNT_UNAVAILABLE: 'Activation codes are available for active accounts.',
    ACCOUNT_REVIEW_REQUIRED: 'Review this restored account before changing its access.',
  },
  ru: {
    console: 'Администрирование', title: 'Вход', login: 'Email администратора', password: 'Пароль',
    continue: 'Продолжить', totp: 'Код из приложения-аутентификатора', verify: 'Подтвердить код',
    recover: 'Настроить или восстановить доступ', recovery: 'Секрет восстановления',
    setup: 'Добавьте этот ключ в приложение-аутентификатор и введите текущий код.',
    back: 'Вернуться ко входу', users: 'Доступ пользователей', create: 'Создать аккаунт', email: 'Email пользователя',
    issue: 'Выдать код', revoke: 'Отозвать все устройства', block: 'Заблокировать', unblock: 'Активировать аккаунт',
    confirmRevoke: 'Отозвать доступ на всех устройствах этого аккаунта?', confirmBlock: 'Заблокировать аккаунт и отозвать все устройства и коды?',
    signOut: 'Выйти', active: 'Активен', blocked: 'Заблокирован', review: 'Ожидает проверки',
    registered: 'Есть активные устройства', unregistered: 'Нет активных устройств', empty: 'Аккаунтов пока нет.',
    more: 'Загрузить ещё', expires: 'Действует до', close: 'Скрыть код',
    configured: 'Аутентификатор настроен. Для входа дождитесь следующего 30-секундного кода.',
    waiting: 'Подождите…', generic: 'Не удалось выполнить запрос.',
    pageMissing: 'Страница не найдена', userMissing: 'Пользователь не найден.',
    ADMIN_AUTH_INVALID: 'Проверьте данные или войдите снова.', RATE_LIMITED: 'Слишком много попыток. Повторите через',
    CSRF_INVALID: 'Не удалось подтвердить запрос. Перезагрузите страницу.', EMAIL_EXISTS: 'Аккаунт с таким email уже есть.',
    ACCOUNT_UNAVAILABLE: 'Коды выдаются для активных аккаунтов.',
    ACCOUNT_REVIEW_REQUIRED: 'Проверьте восстановленный аккаунт перед изменением доступа.',
  },
};

type Step = { kind: 'login'; token: string } | { kind: 'setup'; token: string; seed: string };
type Account = Result<'createUser'>;

function App() {
  const [lang, setLang] = useState<Language>(() => {
    const saved = localStorage.getItem('language');
    return saved === 'ru' || (saved !== 'en' && navigator.language.toLowerCase().startsWith('ru')) ? 'ru' : 'en';
  });
  const [session, setSession] = useState<Result<'adminMe'>>();
  const [checkingSession, setCheckingSession] = useState(true);
  const [step, setStep] = useState<Step>();
  const [recovery, setRecovery] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [issued, setIssued] = useState<(Result<'issue'> & { email: string })>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [configured, setConfigured] = useState(false);
  const [reviewed, setReviewed] = useState<{ before: Account; after: Account }>();
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const running = useRef(false);
  const authEpoch = useRef(0);
  const loadedUsers = useRef<Result<'adminMe'> | undefined>(undefined);
  const path = useAdminPath();
  const route = adminRoute(path);
  const onUsersPage = route.page === 'users';
  const userId = 'userId' in route ? route.userId : undefined;
  const ownerQuery = useQuery(session && userId ? `${session.id}:${userId}` : '',
    (signal) => api('adminGetUser', { params: { userId: userId! }, signal }), expire);
  const owner = reviewed && ownerQuery.data === reviewed.before ? reviewed.after : ownerQuery.data;
  const t = words[lang];
  const f = financeWords[lang];
  const a = auditWords[lang];
  const commands = useAdminCommands(session, expire);

  function expire() {
    authEpoch.current += 1;
    setSession(undefined);
    setIssued(undefined);
    setAccounts([]);
    setReviewed(undefined);
    setSearch('');
    setSearchInput('');
    setNext(null);
  }

  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => {
    const epoch = authEpoch.current;
    void api('adminMe').then((current) => {
      if (epoch !== authEpoch.current) return;
      setSession(current);
    }).catch(() => {}).finally(() => setCheckingSession(false));
  }, []);
  useEffect(() => {
    if (session && path === adminPaths.home) navigate(adminPaths.users, true);
  }, [path, session]);
  useEffect(() => {
    setIssued(undefined);
    setError(undefined);
  }, [path]);
  useEffect(() => {
    if (!session || !onUsersPage) {
      loadedUsers.current = undefined;
      return;
    }
    if (path === adminPaths.home || busy || loadedUsers.current === session) return;
    loadedUsers.current = session;
    void run(() => load());
  }, [session, onUsersPage, path, busy]);

  async function load(after?: string, prefix = search) {
    const epoch = authEpoch.current;
    const result = await api('listUsers', { query: { after, search: prefix || undefined } });
    if (epoch !== authEpoch.current) return;
    setAccounts((accounts) => after ? [...accounts, ...result.users] : result.users);
    setNext(result.next);
  }

  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError('generic');
      if (session && failure.message === 'ADMIN_AUTH_INVALID') {
        expire();
      }
      if (path === window.location.pathname) setError(failure);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, action: (fields: FormData) => Promise<void>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void run(() => action(fields));
  }

  function begin(fields: FormData) {
    const login = String(fields.get('login'));
    const password = String(fields.get('password'));
    if (!recovery) {
      return api('password', { body: { login, password } }).then(({ step }) => setStep({ kind: 'login', token: step }));
    }
    const recoverySecret = String(fields.get('secret')).trim();
    return api('recovery', { body: { login, password, recoverySecret } }).then(({ step, totpSecret }) =>
      setStep({ kind: 'setup', token: step, seed: totpSecret }));
  }

  async function confirm(fields: FormData) {
    if (!step) return;
    const body = { step: step.token, code: String(fields.get('code')) };
    if (step.kind === 'setup') {
      await api('setup', { body });
      setStep(undefined);
      setRecovery(false);
      setConfigured(true);
    } else {
      const current = await api('totp', { body });
      authEpoch.current += 1;
      setSession(current);
      setStep(undefined);
      setConfigured(false);
    }
  }

  function back() {
    setRecovery(false);
    setStep(undefined);
    setError(undefined);
  }

  const errorText = error && (t[error.message as keyof typeof t] ?? t.generic);
  function field(label: string, name: string, props: React.ComponentProps<'input'> = {}) {
    return <label>{label}<input name={name} required {...props} /></label>;
  }
  const messages = <>
    {errorText && <p className="error" role="alert">{errorText}{error?.retryAfter ? ' ' + error.retryAfter + ' s.' : ''}</p>}
    {busy && <p className="status" role="status">{t.waiting}</p>}
  </>;
  function accessForm(): ReactNode {
    if (step) return <form key={step.kind} onSubmit={(event) => submit(event, confirm)}>
      {step.kind === 'setup' && <><p>{t.setup}</p><code className="secret">{step.seed}</code></>}
      {field(t.totp, 'code', { inputMode: 'numeric', pattern: '[0-9]{6}', autoComplete: 'one-time-code' })}
      {messages}
      <button className="primary" disabled={busy}>{t.verify}</button>
    </form>;
    return <form key={recovery ? 'recovery' : 'password'} onSubmit={(event) => submit(event, begin)}>
      {field(t.login, 'login', { type: 'email', autoComplete: 'username' })}
      {field(t.password, 'password', { type: 'password', autoComplete: 'current-password' })}
      {recovery && field(t.recovery, 'secret', { autoComplete: 'off', spellCheck: false })}
      {messages}
      <button className="primary" disabled={busy}>{t.continue}</button>
    </form>;
  }

  return <>
    <header>
      <div className="brand"><span aria-hidden="true" className="mark">Θ</span><span>TэтаФинанс</span><span className="scope">{t.console}</span></div>
      <div className="header-actions">
        <button onClick={() => {
          const selected = lang === 'en' ? 'ru' : 'en';
          setLang(selected);
          localStorage.setItem('language', selected);
        }}>{lang === 'en' ? 'RU' : 'EN'}</button>
        {session && <button disabled={busy} onClick={() => void run(async () => {
          await api('adminLogout', { body: {}, csrf: session.csrf });
          expire();
        })}>{t.signOut}</button>}
      </div>
    </header>
    {checkingSession ? <main className="access"><p role="status">{f.loading}</p></main> : !session ? <main className="access">
      <h1>{recovery ? t.recover : t.title}</h1>
      {configured && <p role="status">{t.configured}</p>}
      {accessForm()}
      {recovery || step
        ? <button className="secondary" onClick={back}>{t.back}</button>
        : <button className="secondary" onClick={() => { setRecovery(true); setError(undefined); }}>{t.recover}</button>}
    </main> : <main className={route.page === 'finance' || route.page === 'audit' || route.page === 'support' ? 'workspace finance-main' : 'workspace'}>
      <nav aria-label={t.console} className="audit-nav">
        <AdminLink className="page-link" href={adminPaths.users} aria-current={onUsersPage ? 'page' : undefined}
          disabled={busy}>{t.users}</AdminLink>
        <AdminLink className="page-link" href={adminPaths.audit} aria-current={route.page === 'audit' ? 'page' : undefined}
          data-testid="admin-audit-open" disabled={busy}>{a.title}</AdminLink>
        <AdminLink className="page-link" href={adminPaths.support} aria-current={route.page === 'support' ? 'page' : undefined}
          data-testid="admin-support-open" disabled={busy}>{supportTitle[lang]}</AdminLink>
      </nav>
      <CommandRecovery commands={commands} lang={lang} userId={route.page === 'finance' ? route.userId : undefined} />
      {route.page === 'support' ? <SupportWorkspace session={session} lang={lang} onExpired={expire} /> :
        route.page === 'audit' ? <AuditWorkspace lang={lang} onExpired={expire} /> :
        route.page === 'notFound' ? <h1>{t.pageMissing}</h1> : userId && !owner ? <>
          <AdminLink className="text-button" href={adminPaths.users}>← {f.back}</AdminLink>
          {ownerQuery.error ? <>
            <p role="alert" className="error">{ownerQuery.error === 'NOT_FOUND' ? t.userMissing : t.generic}</p>
            {ownerQuery.error !== 'NOT_FOUND' && <button type="button" onClick={ownerQuery.reload}>{f.retry}</button>}
          </> : <p role="status" className="muted">{f.loading}</p>}
        </> : route.page === 'recoveryReview' && owner ?
        <RecoveryReview key={owner.id} user={owner} lang={lang} busy={busy} error={error?.message}
          onSave={(decision) => void run(async () => {
            const epoch = authEpoch.current;
            const updated = await api('adminReviewRecoveredUser', {
              params: { userId: owner.id }, body: decision, csrf: session.csrf,
            });
            if (epoch !== authEpoch.current) return;
            setAccounts((list) => list.map((user) => user.id === updated.id ? updated : user));
            setReviewed({ before: owner, after: updated });
          })} /> : route.page === 'finance' && owner ? <FinanceWorkspace key={owner.id} owner={owner}
        route={route} session={session} lang={lang} commands={commands} onExpired={expire} /> : <>
      <h1>{t.users}</h1>
      <form className="create" onSubmit={(event) => {
        const form = event.currentTarget;
        submit(event, async (fields) => {
          await api('createUser', { body: { email: String(fields.get('email')) }, csrf: session.csrf });
          form.reset();
          await load();
        });
      }}>
        {field(t.email, 'email', { type: 'email' })}
        <button className="primary" disabled={busy}>{t.create}</button>
      </form>
      <form className="create user-search" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const prefix = searchInput.trim();
          await load(undefined, prefix);
          setSearch(prefix);
        });
      }}>
        <label>{f.searchLabel}<input type="search" maxLength={254} value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)} /></label>
        <div className="row-actions"><button disabled={busy}>{f.search}</button>
          {search && <button disabled={busy} type="button" onClick={() => void run(async () => {
            await load(undefined, '');
            setSearch('');
            setSearchInput('');
          })}>{f.clearSearch}</button>}</div>
      </form>
      {messages}
      {issued && <section className="issued" aria-live="polite">
        <div><strong>{issued.email}</strong><code className="secret">{issued.code}</code>
        <span>{t.expires} {new Date(issued.expiresAt).toLocaleString(lang)}</span></div>
        <button onClick={() => setIssued(undefined)}>{t.close}</button>
      </section>}
      <ul>
        {accounts.map((user) => <li key={user.id}>
          <div className="account"><strong>{user.email}</strong><span>{t[user.status]} · {user.deviceActive ? t.registered : t.unregistered}</span></div>
          <div className="row-actions">
            <AdminLink className="page-link" href={adminPaths.finance(user.id)} disabled={busy}>{f.openFinance}</AdminLink>
            {user.status === 'review' && <AdminLink className="page-link" href={adminPaths.recoveryReview(user.id)} disabled={busy}
              data-testid={'admin-review-user-' + user.id}>{a.review}</AdminLink>}
            <button disabled={busy || user.status !== 'active'} onClick={() => void run(async () => {
              const epoch = authEpoch.current;
              setIssued(undefined);
              const result = await api('issue', { body: { userId: user.id }, csrf: session.csrf });
              if (path === window.location.pathname && authEpoch.current === epoch) setIssued({ ...result, email: user.email });
            })}>{t.issue}</button>
            {user.deviceActive && <button disabled={busy} onClick={() => {
              if (window.confirm(t.confirmRevoke)) void run(async () => {
                await api('revoke', { body: { userId: user.id }, csrf: session.csrf });
                await load();
              });
            }}>{t.revoke}</button>}
            {user.status === 'active' && <button disabled={busy} onClick={() => {
              if (window.confirm(t.confirmBlock)) void run(async () => {
                setIssued(undefined);
                await api('setStatus', { body: { userId: user.id, status: 'blocked' }, csrf: session.csrf });
                await load();
              });
            }}>{t.block}</button>}
            {user.status === 'blocked' && <button disabled={busy} onClick={() => void run(async () => {
              await api('setStatus', { body: { userId: user.id, status: 'active' }, csrf: session.csrf });
              await load();
            })}>{t.unblock}</button>}
          </div>
        </li>)}
      </ul>
      {accounts.length === 0 && <p>{search ? f.noUsers : t.empty}</p>}
      {next && <button disabled={busy} onClick={() => void run(() => load(next))}>{t.more}</button>}
      </>}
    </main>}
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
