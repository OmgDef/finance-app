import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Body, Language, Result } from '@teta/contracts';
import { currencyName, formatMoney } from '@teta/contracts/money';
import type { Currency } from '@teta/contracts/money';
import { api, errorCode } from './api';
import type { AdminCommands } from './commands';
import { financeWords } from './finance-copy';
import { categoryLabel, dateLabel, EditorHeading, Failure, firstFinancialDate, lastFinancialDate, LabeledInput,
  transactionAmountClass, useAmount, useQuery } from './finance-ui';
import type { Account, Category, Session } from './finance-ui';
import { AdminLink, adminPaths, navigate } from './navigation';
import type { FinanceRoute } from './navigation';
import { ReconciliationEditor } from './reconciliation-editor';
import { scheduleWords } from './schedule-copy';
import { ScheduleWorkspace } from './schedule-workspace';
import { TransactionEditor } from './transaction-editor';
import './finance.css';

type Owner = Result<'createUser'>;
type History = Result<'adminListAccountHistory'>;
type AccountEdit = 'rename' | 'changeStartDate';

export function FinanceWorkspace({ owner, route, session, lang, commands, onExpired }: {
  owner: Owner; route: FinanceRoute; session: Session; lang: Language; commands: AdminCommands; onExpired: () => void;
}) {
  const t = financeWords[lang];
  const schedule = scheduleWords[lang];
  const { id: userId } = owner;
  const ledger = useQuery(userId, (signal) => api('adminListAccounts', { params: { userId }, signal }), onExpired);
  const catalog = useQuery(session.id, (signal) => api('adminListCategories', { signal }), onExpired);
  const [editor, setEditor] = useState<AccountEdit | 'create' | 'reconcile'>();
  const [refresh, setRefresh] = useState(0);
  const [operation, setOperation] = useState(false);
  const [feedback, setFeedback] = useState<{ accountId: string; error?: string;
    notice?: 'archivedSaved' | 'restoredSaved' | 'renamed' | 'startDateSaved' }>();
  const active = useRef(true);
  const data = ledger.data ?? ledger.previous;
  const { accountId, transactionId } = route;
  const account = accountId ? data?.accounts.find((item) => item.accountId === accountId) : data?.accounts[0];
  const params = account && { userId, accountId: account.accountId };
  const disabled = !ledger.data || operation || commands.busy || !commands.ready || !!commands.pending;
  const outcome = commands.outcome;
  const committed = outcome?.reference.userId === userId ? outcome.reference.idempotencyKey : '';

  useEffect(() => () => { active.current = false; }, []);

  function reloadLedger() {
    ledger.reload();
    setRefresh((value) => value + 1);
  }

  useEffect(() => {
    if (!committed || !outcome) return;
    reloadLedger();
    if (editor === 'create' && outcome.reference.command === 'account.create' && 'startDate' in outcome.result) {
      setEditor(undefined);
      navigate(adminPaths.account(userId, outcome.result.accountId));
    }
  }, [committed]);
  useEffect(() => {
    setEditor(undefined);
  }, [accountId, route.schedule !== undefined, transactionId]);
  useEffect(() => { setFeedback(undefined); }, [accountId]);

  async function archive() {
    if (disabled || !account || !params) return;
    const restoring = !!account.archived;
    if (!window.confirm(restoring ? t.confirmRestore : t.confirmArchive)) return;
    setOperation(true);
    setFeedback(undefined);
    try {
      await api(restoring ? 'adminRestoreAccount' : 'adminArchiveAccount', { params, csrf: session.csrf, body: {} });
      if (!active.current) return;
      setEditor(undefined);
      setFeedback({ accountId: account.accountId, notice: restoring ? 'restoredSaved' : 'archivedSaved' });
      reloadLedger();
    } catch (error) {
      if (!active.current) return;
      const code = errorCode(error);
      if (code === 'ADMIN_AUTH_INVALID') onExpired();
      else setFeedback({ accountId: account.accountId, error: code });
    } finally { if (active.current) setOperation(false); }
  }

  return <div className="finance-workspace">
    <div className="finance-title">
      <AdminLink className="text-button breadcrumb" href={adminPaths.users}>← {t.back}</AdminLink>
      <div className="finance-section-heading">
        <div><h1>{t.finance}</h1><p className="muted">{owner.email}</p></div>
        {!route.schedule && !transactionId && editor !== 'create' && <button type="button" className="primary" disabled={disabled}
          onClick={() => setEditor('create')}>{t.createAccount}</button>}
      </div>
    </div>
    {ledger.error && <Failure code={ledger.error} lang={lang} retry={ledger.reload} />}
    {!ledger.data && !ledger.error && <p role="status" className="muted">{t.loading}</p>}
    {data && !account && editor !== 'create' && (accountId
      ? ledger.data && <Failure code="NOT_FOUND" lang={lang} /> : <p className="finance-empty">{t.emptyAccounts}</p>)}
    {data && (data.accounts.length > 0 || editor === 'create') && <div className={account && route.schedule ? 'ledger-layout ledger-layout-schedule' : 'ledger-layout'}>
      <aside className="ledger-account-list" aria-label={t.accounts}>
        <h2>{t.accounts}</h2>
        {data.accounts.length ? <div className="ledger-account-rows">{data.accounts.map((item) => <AdminLink key={item.accountId}
          disabled={operation} aria-current={account?.accountId === item.accountId ? 'page' : undefined} className="ledger-account-button"
          href={route.schedule ? adminPaths.schedule(userId, item.accountId) : adminPaths.account(userId, item.accountId)}>
          <span><strong>{item.name}</strong><span className="muted">{t['type' in item ? item.type : 'regular']}
            {item.archived && ` · ${t.archived}`}</span></span>
          <span className="money">{formatMoney(item.balanceMinor, item.currency, lang)}</span>
        </AdminLink>)}</div> : <p className="finance-empty">{t.emptyAccounts}</p>}
      </aside>
      {editor === 'create' ? <EditorHeading title={t.createAccount} onClose={() => setEditor(undefined)}>
        <CreateAccount today={data.today} userId={userId} session={session} lang={lang} commands={commands} disabled={disabled} />
      </EditorHeading> : account && <section className="ledger-detail" aria-label={account.name}>
        {route.schedule ? <ScheduleWorkspace key={account.accountId} account={account} accounts={data.accounts}
          userId={userId} today={data.today} timeZone={data.timeZone} lang={lang} session={session} commands={commands}
          categories={catalog.data?.categories} ruleId={route.schedule.ruleId} onExpired={onExpired} /> : <>
        <div className="ledger-balance">
          <div className="finance-section-heading"><h2>{account.name}</h2><span className="muted">{t[account.archived ? 'archived' : 'active']}</span></div>
          <p className="muted">{t.balance}</p><p className="balance-number money">{formatMoney(account.balanceMinor, account.currency, lang)}</p>
          <p className="muted">{t.startDate} · {dateLabel(account.startDate, lang)}</p>
          {account.needsReconciliation && <p className="finance-notice">{t.needsReconciliation}</p>}
          {'annualRatePercent' in account && typeof account.annualRatePercent === 'string' && 'maturityDate' in account &&
            typeof account.maturityDate === 'string' && <p className="muted">{t.rate} {account.annualRatePercent}% · {t.maturity} {dateLabel(account.maturityDate, lang)}</p>}
          <div className="row-actions">
            <AdminLink className="page-link" href={adminPaths.schedule(userId, account.accountId)}>{schedule.open}</AdminLink>
            {!account.archived && <><button className="primary" disabled={disabled} onClick={() => setEditor('reconcile')}>{t.reconcile}</button>
              <button disabled={disabled} onClick={() => setEditor('rename')}>{t.rename}</button>
              <button disabled={disabled} onClick={() => setEditor('changeStartDate')}>{t.changeStartDate}</button></>}
            <button disabled={disabled} onClick={() => void archive()}>{account.archived ? t.restore : t.archive}</button>
          </div>
          {feedback?.accountId === account.accountId && feedback.error && <Failure code={feedback.error} lang={lang} />}
          {feedback?.accountId === account.accountId && feedback.notice && <p role="status" className="muted">{t[feedback.notice]}</p>}
        </div>
        {(editor === 'rename' || editor === 'changeStartDate') && <EditorHeading title={t[editor]} onClose={() => setEditor(undefined)}>
          <EditAccount key={account.accountId + editor} mode={editor} account={account} today={data.today} userId={userId}
            session={session} lang={lang} disabled={disabled} onExpired={onExpired} onChanged={() => {
              setEditor(undefined);
              setFeedback({ accountId: account.accountId, notice: editor === 'rename' ? 'renamed' : 'startDateSaved' });
              reloadLedger();
            }} />
        </EditorHeading>}
        {editor === 'reconcile' && <EditorHeading title={t.reconcile} onClose={() => setEditor(undefined)}>
          <ReconciliationEditor key={account.accountId} account={account} userId={userId} today={data.today}
            categories={catalog.data?.categories ?? []} session={session} commands={commands} lang={lang}
            onExpired={onExpired} />
        </EditorHeading>}
        {catalog.error && <Failure code={catalog.error} lang={lang} retry={catalog.reload} />}
        {transactionId && <EditorHeading title={t.operation} closeHref={adminPaths.account(userId, account.accountId)}>
          <TransactionEditor key={transactionId} userId={userId} transactionId={transactionId} accounts={data.accounts}
            categories={catalog.data?.categories ?? []} session={session} commands={commands} lang={lang}
            onExpired={onExpired} onConflict={reloadLedger} />
        </EditorHeading>}
        <AccountHistory key={account.accountId} accountId={account.accountId} userId={userId} lang={lang} refresh={refresh}
          categories={catalog.data?.categories ?? []} onExpired={onExpired} />
        </>}
      </section>}
    </div>}
  </div>;
}

function CreateAccount({ today, userId, session, lang, commands, disabled }: {
  today: string; userId: string; session: Session; lang: Language; commands: AdminCommands; disabled: boolean;
}) {
  const t = financeWords[lang];
  const [type, setType] = useState<'regular' | 'cash' | 'deposit'>('regular');
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [startDate, setStartDate] = useState(today);
  const [error, setError] = useState('');
  const opening = useAmount('0', lang);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get('name')).trim();
    const reason = String(fields.get('reason')).trim();
    if (!name || !reason || !startDate || startDate > today) return setError('INVALID_REQUEST');
    if (opening.value === undefined) return setError('invalidOpeningBalance');
    const base = { name, currency, startDate, openingBalanceMinor: opening.value, reason };
    let terms: { type?: 'cash' } | Pick<Extract<Body<'adminCreateAccount'>, { type: 'deposit' }>,
      'type' | 'annualRatePercent' | 'maturityDate'> = {};
    if (type === 'deposit') {
      const annualRatePercent = String(fields.get('rate')).trim().replace(',', '.');
      const maturityDate = String(fields.get('maturity'));
      if (!/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,4})?$/.test(annualRatePercent)) return setError('invalidRate');
      if (!maturityDate || maturityDate < startDate) return setError('INVALID_REQUEST');
      terms = { type, annualRatePercent, maturityDate };
    } else if (type === 'cash') terms = { type };
    setError('');
    try {
      await commands.submit({ command: 'account.create', userId }, (idempotencyKey) =>
        api('adminCreateAccount', { params: { userId }, csrf: session.csrf, body: { ...base, ...terms, idempotencyKey } }));
    } catch (failure) {
      setError(errorCode(failure));
    }
  }

  return <form onSubmit={(event) => void submit(event)} onChange={() => setError('')}>
    <fieldset disabled={disabled} className="finance-fields">
      <div className="finance-form-grid">
        <LabeledInput className="full-row" label={t.name} name="name" maxLength={255} required />
        <label>{t.accountType}<select value={type} onChange={(event) => setType(event.target.value as typeof type)}>
          {(['regular', 'cash', 'deposit'] as const).map((value) => <option key={value} value={value}>{t[value]}</option>)}
        </select></label>
        <label>{t.currency}<select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}>
          {(['EUR', 'USD', 'RUB'] as const).map((value) => <option key={value} value={value}>{currencyName(value, lang)}</option>)}
        </select></label>
        <LabeledInput label={t.startDate} type="date" value={startDate} min={firstFinancialDate} max={today} required
          onChange={(event) => setStartDate(event.target.value)} />
        <LabeledInput label={t.opening} currency={currency} {...opening.field} required />
        {type === 'deposit' && <>
          <LabeledInput label={t.rate + ' (%)'} name="rate" inputMode="decimal" maxLength={8} required />
          <LabeledInput label={t.maturity} name="maturity" type="date" min={startDate || firstFinancialDate} max={lastFinancialDate} required />
        </>}
      </div>
      <label>{t.reason}<textarea name="reason" required maxLength={500} rows={2} /></label>
      {error && <Failure code={error} lang={lang} />}
      <div className="row-actions"><button className="primary">{t.createAccount}</button></div>
    </fieldset>
  </form>;
}

function EditAccount({ mode, account, today, userId, session, lang, disabled, onChanged, onExpired }: {
  mode: AccountEdit; account: Account; today: string; userId: string; session: Session; lang: Language; disabled: boolean;
  onChanged: () => void; onExpired: () => void;
}) {
  const t = financeWords[lang];
  const renaming = mode === 'rename';
  const [value, setValue] = useState(renaming ? account.name : account.startDate);
  const [reason, setReason] = useState('');
  const [baseline, setBaseline] = useState(account);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const maxDate = 'maturityDate' in baseline && baseline.maturityDate < today ? baseline.maturityDate : today;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working.current || disabled) return;
    if (!value.trim() || !reason.trim()) { setError('INVALID_REQUEST'); return; }
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const options = { csrf: session.csrf, params: { userId, accountId: account.accountId } };
      const fields = { expectedAccountVersion: baseline.accountVersion, reason: reason.trim() };
      if (renaming) await api('adminRenameAccount', { ...options, body: { ...fields, name: value.trim() } });
      else await api('adminUpdateAccountStartDate', { ...options, body: { ...fields, startDate: value } });
      if (mounted.current) onChanged();
    } catch (error) {
      if (!mounted.current) return;
      const code = errorCode(error);
      if (code === 'ADMIN_AUTH_INVALID') onExpired();
      else {
        setError(code);
        if (code === 'VERSION_CONFLICT') {
          try {
            const next = (await api('adminListAccounts', { params: { userId } })).accounts
              .find(({ accountId }) => accountId === account.accountId);
            if (mounted.current && next) setBaseline(next);
          } catch (refreshError) {
            if (mounted.current && errorCode(refreshError) === 'ADMIN_AUTH_INVALID') onExpired();
          }
        }
      }
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  return <form onSubmit={(event) => void submit(event)}>
    <fieldset disabled={disabled || busy || baseline.archived === true} className="finance-fields">
      <LabeledInput label={renaming ? t.name : t.startDate} value={value} required
        {...(renaming ? { maxLength: 255 } : { type: 'date', min: firstFinancialDate, max: maxDate })}
        onChange={(event) => setValue(event.target.value)} />
      {error === 'VERSION_CONFLICT' && <p className="muted">{renaming ? t.name : t.startDate} · {' '}
        {renaming ? baseline.name : dateLabel(baseline.startDate, lang)} · {t.version} {baseline.accountVersion}</p>}
      <label>{t.reason}<textarea required maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      {error && <Failure code={error} lang={lang} />}
      <div className="row-actions"><button className="primary">{t.save}</button></div>
    </fieldset>
  </form>;
}

function AccountHistory({ accountId, userId, lang, refresh, categories, onExpired }: {
  accountId: string; userId: string; lang: Language; refresh: number; categories: Category[];
  onExpired: () => void;
}) {
  const t = financeWords[lang];
  const params = { userId, accountId };
  const query = useQuery([userId, accountId, refresh].join(':'), (signal) => api('adminListAccountHistory', { params, signal }), onExpired);
  const [pages, setPages] = useState<{ first: History; entries: History['entries']; next: string | null }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef(query.data);
  current.current = query.data;
  const first = query.data;
  const visible = pages?.first === first ? pages : first;
  const next = visible?.next;
  const work = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => work.current?.abort(), []);

  async function more() {
    if (!first || !visible || !next || work.current) return;
    const abort = new AbortController();
    work.current = abort;
    setBusy(true);
    setError('');
    try {
      const page = await api('adminListAccountHistory', { params, query: { before: next }, signal: abort.signal });
      if (current.current !== first || abort.signal.aborted) return;
      const known = new Set(visible.entries.map(({ id }) => id));
      setPages({ first, entries: [...visible.entries, ...page.entries.filter(({ id }) => !known.has(id))], next: page.next });
    } catch (error) {
      if (current.current !== first || abort.signal.aborted) return;
      const code = errorCode(error);
      if (code === 'ADMIN_AUTH_INVALID') onExpired();
      else setError(code);
    } finally { work.current = undefined; if (!abort.signal.aborted) setBusy(false); }
  }

  return <section className="ledger-history">
    <h2>{t.history}</h2>
    {query.error && <Failure code={query.error} lang={lang} retry={query.reload} />}
    {!first && !query.error && <p className="muted" role="status">{t.loading}</p>}
    {first && visible && <div className="history-list">
      {visible.entries.length === 0 && <p className="finance-empty">{t.noHistory}</p>}
      {visible.entries.map((entry) => {
        const transaction = 'transactionVersion' in entry;
        const voided = transaction && entry.status === 'void';
        const label = transaction ? categoryLabel(entry.categoryId, categories, lang) : null;
        const title = transaction ? entry.comment || label || t[entry.type] : t[entry.type];
        const details = [dateLabel(entry.date, lang), transaction && t[entry.type], voided && t.void,
          transaction && entry.actorRole === 'admin' && t.admin, !transaction && entry.type === 'adjustment' && entry.explanation]
          .filter(Boolean).join(' · ');
        const amountClass = entry.type === 'opening' ? 'money' : transactionAmountClass(entry.amountMinor);
        const row = <><span className="history-description"><strong>{title}</strong><span className="muted">{details}</span></span>
          <span className={voided ? 'money void-amount' : amountClass}>
            {formatMoney(entry.amountMinor, first.currency, lang, true)}</span></>;
        return transaction ? <AdminLink key={entry.id} className="history-row"
          href={adminPaths.transaction(userId, accountId, entry.id)}>{row}</AdminLink>
          : <div key={entry.id} className="history-row">{row}</div>;
      })}
    </div>}
    {error && <Failure code={error} lang={lang} />}
    {next && <button type="button" disabled={busy} onClick={() => void more()}>{t.more}</button>}
  </section>;
}
