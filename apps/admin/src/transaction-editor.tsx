import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Body, Language, Result } from '@teta/contracts';
import { formatMoney } from '@teta/contracts/money';
import { api, errorCode } from './api';
import type { AdminCommands } from './commands';
import { financeWords } from './finance-copy';
import { AccountPicker, BalanceImpact, categoryLabel, dateLabel, Failure, LabeledInput, transactionAmountClass,
  useAmount, useQuery } from './finance-ui';
import type { Account, Category, Session } from './finance-ui';

type History = Result<'adminListTransactionVersions'>;
type Version = History['versions'][number];
type Revision = Body<'adminPreviewTransactionRevision'>;
type Preview = Result<'adminPreviewTransactionRevision'>;
type Draft = { reason: string; replacement?: Revision };
type Review = { draft: Draft; preview: Preview; current: Version };

export function TransactionEditor({ userId, transactionId, accounts, categories, session, commands, lang, onExpired, onConflict }: {
  userId: string; transactionId: string; accounts: Account[]; categories: Category[]; session: Session; commands: AdminCommands;
  lang: Language; onExpired: () => void; onConflict: () => void;
}) {
  const t = financeWords[lang];
  const [mode, setMode] = useState<'revise' | 'void'>();
  const [latest, setLatest] = useState<History>();
  const params = { userId, transactionId };
  const outcome = commands.outcome;
  const committed = outcome?.reference.userId === userId && 'transactionId' in outcome.reference &&
    outcome.reference.transactionId === transactionId ? outcome.reference.idempotencyKey : '';
  const query = useQuery([userId, transactionId, committed].join(':'), (signal) =>
    api('adminListTransactionVersions', { params, signal }), onExpired);
  const history = !committed && latest ? latest : query.data;
  const current = history?.versions.find((version) => version.version === history.transactionVersion);
  const name = (id: string) => accounts.find(({ accountId }) => accountId === id)?.name ?? id;
  const canChange = current?.status === 'posted' && !current.movements.some(({ accountId }) =>
    accounts.find((account) => account.accountId === accountId)?.archived);
  const disabled = !commands.ready || !!commands.pending || commands.busy;
  useEffect(() => {
    if (committed) {
      setMode(undefined);
      setLatest(undefined);
    }
  }, [committed]);

  if (query.error) return <Failure code={query.error} lang={lang} retry={query.reload} />;
  if (!history || !current) return <p role="status" className="muted">{t.loading}</p>;

  return <>
    <div className="finance-section-heading">
      <div><h3>{t[history.type]}</h3><p className="muted">{dateLabel(current.date, lang)} · {t[current.status]}</p></div>
      {canChange && <div className="row-actions">
        <button type="button" disabled={disabled} onClick={() => setMode('revise')}>{t.revise}</button>
        <button type="button" disabled={disabled} onClick={() => setMode('void')}>{t.voidAction}</button>
      </div>}
    </div>
    {mode && canChange && <TransactionForm key={mode} mode={mode} current={current}
      type={history.type} params={params} accounts={accounts} categories={categories} session={session} commands={commands}
      lang={lang} onCancel={() => setMode(undefined)} onExpired={onExpired} onRefresh={(next) => {
        if (next) setLatest(next);
        onConflict();
      }} />}
    <h3>{t.versions}</h3>
    <div className="version-list">
      {[...history.versions].reverse().map((version) => <section key={version.version} className="version-row">
        <div className="finance-section-heading">
          <strong>{t.version} {version.version} · {t[version.status]}</strong>
          <span className="muted">{new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
            .format(new Date(version.createdAt))} UTC</span>
        </div>
        <p className="muted">{[dateLabel(version.date, lang), categoryLabel(version.categoryId, categories, lang), t[version.actorRole]].filter(Boolean).join(' · ')}</p>
        {version.comment && <p>{version.comment}</p>}
        {version.reason && <p><strong>{t.reason}</strong> · {version.reason}</p>}
        {version.movements.map(({ accountId, currency, amountMinor }) => <div className="finance-line" key={accountId}>
          <span>{name(accountId)}</span>
          <span className={transactionAmountClass(amountMinor)}>{formatMoney(amountMinor, currency, lang, true)}</span>
        </div>)}
      </section>)}
    </div>
  </>;
}

function TransactionForm({ mode, current, type, params, accounts, categories, session, commands, lang, onCancel, onExpired, onRefresh }: {
  mode: 'revise' | 'void'; current: Version; type: History['type']; params: { userId: string; transactionId: string };
  accounts: Account[]; categories: Category[]; session: Session; commands: AdminCommands; lang: Language;
  onCancel: () => void; onExpired: () => void; onRefresh: (latest: History | undefined) => void;
}) {
  const t = financeWords[lang];
  const debit = current.movements.find(({ amountMinor }) => amountMinor.startsWith('-'));
  const credit = current.movements.find(({ amountMinor }) => !amountMinor.startsWith('-'));
  const [accountId, setAccount] = useState((type === 'income' ? credit : debit)?.accountId ?? '');
  const [toAccountId, setToAccount] = useState(credit?.accountId ?? '');
  const [date, setDate] = useState(current.date);
  const [categoryId, setCategory] = useState(current.categoryId ?? '');
  const [comment, setComment] = useState(current.comment ?? '');
  const [reason, setReason] = useState('');
  const amount = useAmount(type === 'income' ? credit?.amountMinor : debit?.amountMinor.slice(1), lang);
  const received = useAmount(credit?.amountMinor, lang);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [review, setReview] = useState<Review>();
  const operation = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const activeAccounts = accounts.filter(({ archived }) => !archived);
  const sourceAccount = activeAccounts.find((item) => item.accountId === accountId);
  const destinationAccount = activeAccounts.find((item) => item.accountId === toAccountId);
  const disabled = busy || commands.busy || !commands.ready || !!commands.pending;

  useEffect(() => () => { mounted.current = false; operation.current?.abort(); }, []);

  async function loadPreview(draft: Draft, conflict: boolean) {
    if (!mounted.current || operation.current) return;
    const abort = new AbortController();
    operation.current = abort;
    setReview(undefined);
    setError('');
    setBusy(true);
    try {
      const options = { csrf: session.csrf, params, signal: abort.signal };
      const preview = draft.replacement
        ? await api('adminPreviewTransactionRevision', { ...options, body: draft.replacement })
        : await api('adminPreviewTransactionVoid', { ...options, body: {} });
      const history = preview.transactionVersion === current.version ? undefined : await api('adminListTransactionVersions', options);
      const latest = history ? history.versions.find(({ version }) => version === preview.transactionVersion) : current;
      if (!latest) throw new Error('Missing transaction version');
      if (!abort.signal.aborted) {
        setChanged(conflict || preview.transactionVersion !== current.version);
        setReview({ draft, preview, current: latest });
        if (conflict || history) onRefresh(history);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      const code = errorCode(error);
      if (code === 'ADMIN_AUTH_INVALID') onExpired();
      else setError(code);
    } finally {
      if (operation.current === abort) operation.current = undefined;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || operation.current) return;
    if (!reason.trim()) { setError('INVALID_REQUEST'); return; }
    if (mode === 'void') { void loadPreview({ reason: reason.trim() }, false); return; }
    const base = { date, ...(comment && { comment }) };
    const amountMinor = amount.value;
    if (!amountMinor || BigInt(amountMinor) <= 0n) { setError('INVALID_REQUEST'); return; }
    let replacement: Revision;
    if (type === 'transfer') {
      const toAmountMinor = received.value;
      if (!toAmountMinor || BigInt(toAmountMinor) <= 0n) { setError('INVALID_REQUEST'); return; }
      replacement = { ...base, type, fromAccountId: accountId, toAccountId, fromAmountMinor: amountMinor, toAmountMinor };
    } else replacement = { ...base, type, accountId, categoryId, amountMinor };
    void loadPreview({ replacement, reason: reason.trim() }, false);
  }

  async function save() {
    if (disabled || !review || !mounted.current) return;
    setError('');
    const { draft, preview } = review;
    const body = { reason: draft.reason, expectedTransactionVersion: preview.transactionVersion,
      expectedAccounts: preview.accounts.map(({ accountId, accountVersion }) => ({ accountId, accountVersion })) };
    try {
      if (draft.replacement) {
        const replacement = draft.replacement;
        await commands.submit({ command: 'transaction.revise', ...params }, (idempotencyKey) =>
          api('adminReviseTransaction', { params, csrf: session.csrf, body: { ...replacement, ...body, idempotencyKey } }));
      } else {
        await commands.submit({ command: 'transaction.void', ...params }, (idempotencyKey) =>
          api('adminVoidTransaction', { params, csrf: session.csrf, body: { ...body, idempotencyKey } }));
      }
    } catch (error) {
      if (!mounted.current) return;
      const code = errorCode(error);
      if (code === 'VERSION_CONFLICT') void loadPreview(draft, true);
      else { setReview(undefined); setError(code); }
    }
  }

  return <div className="finance-form-panel">
    <h3>{mode === 'void' ? t.voidAction : t.revise}</h3>
    <form onSubmit={preview} onChange={() => { setReview(undefined); setError(''); setChanged(false); }}>
      <fieldset disabled={disabled} className="finance-fields">
        {mode === 'revise' && <div className="finance-form-grid">
          <LabeledInput label={t.date} type="date" min="1000-01-01" max="9999-12-31" required value={date}
            onChange={(event) => setDate(event.target.value)} />
          <AccountPicker label={type === 'transfer' ? t.debit : t.account} accounts={activeAccounts} value={accountId} onChange={setAccount} />
          <LabeledInput label={type === 'transfer' ? t.sent : t.amount} {...amount.field} required
            currency={sourceAccount?.currency} />
          {type === 'transfer' ? <>
            <AccountPicker label={t.credit} accounts={activeAccounts} value={toAccountId} onChange={setToAccount} />
            <LabeledInput label={t.received} {...received.field} required
              currency={destinationAccount?.currency} />
          </> : <label>{t.category}<select required value={categoryId} onChange={(event) => setCategory(event.target.value)}>
            <option value="" disabled>{t.choose}</option>
            {categories.filter((item) => item.type === type).map(({ id, nameRu, nameEn }) =>
              <option value={id} key={id}>{lang === 'ru' ? nameRu : nameEn}</option>)}
          </select></label>}
          <label className="full-row">{t.comment}<textarea maxLength={500} rows={2} value={comment}
            onChange={(event) => setComment(event.target.value)} /></label>
        </div>}
        <label>{mode === 'void' ? t.voidReason : t.revisionReason}<textarea required maxLength={500} rows={2} value={reason}
          onChange={(event) => setReason(event.target.value)} /></label>
        <div className="row-actions"><button className={review ? undefined : 'primary'}>{t.preview}</button>
          <button type="button" className="text-button" onClick={onCancel}>{t.cancel}</button></div>
      </fieldset>
    </form>
    {busy && <p role="status" className="muted">{t.loading}</p>}
    {error && <Failure code={error} lang={lang} />}
    {review && <div className="finance-confirm" aria-live="polite">
      {changed && <p role="status" className="finance-notice">{t.changed}</p>}
      <p className="muted">{t.version} {review.preview.transactionVersion} · {dateLabel(review.current.date, lang)}</p>
      <BalanceImpact lang={lang} rows={review.preview.accounts.map(({ accountId, currency, balanceMinor, balanceAfterMinor }) => ({
        id: accountId, name: accounts.find((account) => account.accountId === accountId)?.name ?? accountId, currency,
        before: balanceMinor, after: balanceAfterMinor,
      }))} />
      <p><strong>{t.reason}</strong> · {review.draft.reason}</p>
      <button type="button" className="primary" disabled={disabled} onClick={() => void save()}>
        {mode === 'void' ? t.confirmVoid : t.confirmRevision}
      </button>
    </div>}
  </div>;
}
