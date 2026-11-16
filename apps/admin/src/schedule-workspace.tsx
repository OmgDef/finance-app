import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Language, Result } from '@teta/contracts';
import { formatMoney } from '@teta/contracts/money';
import { api, errorCode } from './api';
import type { AdminCommands } from './commands';
import { financeWords } from './finance-copy';
import { categoryLabel, dateLabel, EditorHeading, Failure, firstFinancialDate, lastFinancialDate, LabeledInput,
  shiftDate, transactionAmountClass, useQuery } from './finance-ui';
import type { Account, Category, Session } from './finance-ui';
import { AdminLink, adminPaths, navigate } from './navigation';
import { scheduleWords } from './schedule-copy';
import { ReplacementEditor, RuleEditor, utcMoment } from './schedule-rule-editor';

type Rule = Result<'adminGetScheduleRule'>;
type Entry = Result<'adminListScheduleOccurrences'>['occurrences'][number];
type Editor = 'create' | 'edit' | 'pause' | 'resume' | 'end' | 'replace';
type DateAction = { key: string; mode: 'skip' | 'retry'; revision: string };
type Range = { fromDate: string; throughDate: string };

const occurrenceKey = ({ ruleId, date }: Entry) => ruleId + '-' + date;

export function ScheduleWorkspace({ account, accounts, userId, today, timeZone, lang, session, commands, categories, ruleId,
  onExpired }: {
  account: Account; accounts: Account[]; userId: string; today: string; timeZone: string; lang: Language; session: Session;
  commands: AdminCommands; categories: Category[] | undefined; ruleId?: string;
  onExpired: () => void;
}) {
  const t = scheduleWords[lang];
  const f = financeWords[lang];
  const [editor, setEditor] = useState<Editor>();
  const [action, setAction] = useState<DateAction>();
  const [range, setRange] = useState<Range>();
  const [editingPeriod, setEditingPeriod] = useState(false);
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [notice, setNotice] = useState<'queued' | 'saved' | 'failureChanged' | 'unknownWrite'>();
  const period = range ?? { fromDate: shiftDate(today, -30), throughDate: shiftDate(today, 59) };
  const params = { userId };
  const rulesQuery = useQuery(ruleId ? '' : account.accountId,
    (signal) => api('adminListScheduleRules', { params, query: { accountId: account.accountId }, signal }), onExpired);
  const ruleQuery = useQuery(ruleId ?? '',
    (signal) => api('adminGetScheduleRule', { params: { ...params, ruleId: ruleId! }, signal }), onExpired);
  const calendar = useQuery([ruleId ?? account.accountId, period.fromDate, period.throughDate].join(':'),
    (signal) => api('adminListScheduleOccurrences', { params, query: {
      ...period, ...(ruleId ? { ruleId } : { accountId: account.accountId }),
    }, signal }), onExpired);
  const rule = ruleQuery.data ?? ruleQuery.previous;
  const rules = rulesQuery.data?.rules ?? rulesQuery.previous?.rules;
  const ruleAccount = rule ? accounts.find(({ accountId }) => accountId === rule.accountId) : account;
  const entries = (calendar.data ?? calendar.previous)?.occurrences;
  const rows = onlyFailures ? entries?.filter(({ status }) => status === 'needs_intervention') : entries;
  const commandBlocked = !commands.ready || commands.busy || !!commands.pending;
  const canChange = !!ruleQuery.data && !commandBlocked && rule?.state !== 'ended' && !rule?.recoveryHeld &&
    !!ruleAccount && !ruleAccount.archived;
  const activeOutcome = commands.outcome;
  const handled = useRef(activeOutcome?.reference.idempotencyKey);
  const schedulePath = (id?: string) => adminPaths.schedule(userId, account.accountId, id);

  function refresh() {
    if (ruleId) ruleQuery.reload();
    else rulesQuery.reload();
    calendar.reload();
  }

  useEffect(() => {
    if (!activeOutcome || handled.current === activeOutcome.reference.idempotencyKey) return;
    handled.current = activeOutcome.reference.idempotencyKey;
    const { reference, result } = activeOutcome;
    if (reference.userId !== userId) return;
    if (reference.command === 'schedule.replace' && 'replacementRule' in result && result.ruleId === ruleId) {
      setEditor(undefined);
      setOnlyFailures(false);
      setNotice('saved');
      openRule(result.replacementRule.ruleId, result.replacementRule.firstDate);
    }
    if (reference.command === 'schedule.skip' && 'occurrenceId' in result) {
      setAction(undefined);
      calendar.reload();
    }
  }, [activeOutcome]);
  useEffect(() => {
    setEditor(undefined);
    setAction(undefined);
  }, [ruleId]);

  function prepareRule(date?: string) {
    setEditor(undefined);
    setAction(undefined);
    if (date && (date < period.fromDate || date > period.throughDate)) {
      setRange({ fromDate: shiftDate(date, -30), throughDate: shiftDate(date, 59) });
    }
  }

  function openRule(next: string, date: string) {
    prepareRule(date);
    if (ruleId === next) refresh();
    else navigate(schedulePath(next));
  }

  function showRule(next: Rule) {
    openRule(next.ruleId, next.firstDate);
    setNotice('saved');
  }

  function chooseAction(entry: Entry, mode: DateAction['mode']) {
    if (!entry.failureRevision) return;
    setNotice(undefined);
    setAction({ key: occurrenceKey(entry), mode, revision: entry.failureRevision });
  }

  return <section className="schedule-stack" aria-label={t.title}>
    <AdminLink className="text-button schedule-back" href={adminPaths.account(userId, account.accountId)}>← {t.back}</AdminLink>
    <div className="finance-section-heading">
      <div><h2>{t.title}</h2><p className="muted">{ruleAccount?.name ?? account.name} · {timeZone}</p></div>
      {!ruleId && <button type="button" className="primary" disabled={account.archived || commandBlocked || !categories}
        onClick={() => { setEditor('create'); setNotice(undefined); }}>{t.create}</button>}
    </div>
    {notice && <p className="finance-notice" role="status">{t[notice]}</p>}
    {ruleId ? <div className="schedule-stack">
      <AdminLink className="text-button schedule-back" href={schedulePath()} onClick={() => setNotice(undefined)}>{t.allRules}</AdminLink>
      {ruleQuery.error && <Failure code={ruleQuery.error} lang={lang} retry={ruleQuery.reload} />}
      {!rule && !ruleQuery.error && <p className="muted" role="status">{f.loading}</p>}
      {rule && <div className="ledger-balance">
        <div className="finance-section-heading">
          <h3>{categoryLabel(rule.categoryId, categories ?? [], lang) ?? f[rule.kind]}</h3>
          <strong className="money">{ruleAmount(rule, lang)}</strong>
        </div>
        <p className="muted">{ruleAccount?.name ?? rule.accountId} · {f[rule.kind]} · {t[rule.frequency]} · {t[rule.state]}</p>
        {rule.recoveryHeld && <p className="muted">{t.recoveryHeld}</p>}
        <p className="muted">{t.first} · {dateLabel(rule.firstDate, lang)}
          {rule.endDate && ' – ' + dateLabel(rule.endDate, lang)} · {f.version} {rule.ruleVersion}</p>
        <p className="muted">{t.effective} · {utcMoment(rule.effectiveAt, lang)}</p>
        {(rule.source ?? rule.incomeSource) && <p><strong>{f.transactionSource}</strong> · {rule.source ?? rule.incomeSource}</p>}
        {rule.comment && <p>{rule.comment}</p>}
        {(rule.replaces || rule.replacedBy) && <div className="schedule-links">
          {rule.replaces && <div className="finance-line">
            <AdminLink className="text-button" href={schedulePath(rule.replaces.ruleId)}
              onClick={() => prepareRule(rule.replaces?.transitionDate)}>
              {t.previousRule}
            </AdminLink>
            <span className="muted">{dateLabel(rule.replaces.transitionDate, lang)} · {utcMoment(rule.replaces.transitionAt, lang)}</span>
          </div>}
          {rule.replacedBy && <div className="finance-line">
            <AdminLink className="text-button" href={schedulePath(rule.replacedBy.ruleId)}
              onClick={() => prepareRule(rule.replacedBy?.transitionDate)}>
              {t.nextRule}
            </AdminLink>
            <span className="muted">{dateLabel(rule.replacedBy.transitionDate, lang)} · {utcMoment(rule.replacedBy.transitionAt, lang)}</span>
          </div>}
        </div>}
        {rule.state !== 'ended' && !ruleAccount?.archived && <div className="row-actions">
          {(['edit', rule.state === 'paused' ? 'resume' : 'pause', 'end', 'replace'] as const).map((name) =>
            <button type="button" key={name}
              disabled={!canChange || ((name === 'edit' || name === 'replace') && !categories) ||
                (name === 'replace' && !!rule.replaces && rule.replaces.transitionAt > Date.now())}
              onClick={() => { setEditor(name); setNotice(undefined); }}>{t[name]}</button>)}
        </div>}
      </div>}
    </div> : <section className="schedule-stack" aria-label={t.rules}>
      <h3>{t.rules}</h3>
      {rulesQuery.error && <Failure code={rulesQuery.error} lang={lang} retry={rulesQuery.reload} />}
      {!rules && !rulesQuery.error && <p className="muted" role="status">{f.loading}</p>}
      {rules && <div className="history-list">
        {!rules.length && <p className="finance-empty">{t.noneRules}</p>}
        {rules.map((entry) => <AdminLink className="history-row" key={entry.ruleId} href={schedulePath(entry.ruleId)}
          onClick={() => { setNotice(undefined); prepareRule(entry.firstDate); }}>
          <span className="history-description">
            <strong>{categoryLabel(entry.categoryId, categories ?? [], lang) ?? f[entry.kind]}</strong>
            <span className="muted">{[dateLabel(entry.firstDate, lang), t[entry.frequency], t[entry.state],
              entry.recoveryHeld && t.recoveryHeld, entry.source ?? entry.incomeSource, entry.comment].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="money">{ruleAmount(entry, lang)}</span>
        </AdminLink>)}
      </div>}
    </section>}
    {editor === 'replace' && rule && categories && <EditorHeading title={t.replace} onClose={() => setEditor(undefined)}>
      <ReplacementEditor key={rule.ruleId} rule={rule} accounts={accounts} today={today} categories={categories}
        userId={userId} session={session} lang={lang} disabled={!canChange} onExpired={onExpired} commands={commands}
        onCancel={() => setEditor(undefined)} onRefresh={refresh} />
    </EditorHeading>}
    {editor && editor !== 'replace' && ruleAccount && categories && <EditorHeading title={t[editor]} onClose={() => setEditor(undefined)}>
      <RuleEditor key={editor} action={editor} rule={rule} account={ruleAccount}
        categories={categories} today={today} userId={userId} session={session} lang={lang}
        disabled={editor === 'create' ? commandBlocked || ruleAccount.archived === true : !canChange}
        onExpired={onExpired} onCancel={() => setEditor(undefined)} onSaved={showRule} onRefresh={refresh} />
    </EditorHeading>}
    <section className="schedule-stack" aria-label={t.dates}>
      <div className="finance-section-heading">
        <div><h3>{t.dates}</h3><p className="muted">{dateLabel(period.fromDate, lang)} – {dateLabel(period.throughDate, lang)}</p></div>
        <div className="row-actions">
          <button type="button" className="text-button" onClick={refresh}>{t.refresh}</button>
          <button type="button" className="text-button" aria-expanded={editingPeriod}
            onClick={() => setEditingPeriod(!editingPeriod)}>{t.changePeriod}</button>
        </div>
      </div>
      {editingPeriod && <PeriodForm key={period.fromDate + period.throughDate} period={period} lang={lang} onSubmit={(next) => {
        setAction(undefined);
        setRange(next);
        setEditingPeriod(false);
      }} />}
      <label className="check-control schedule-filter"><input type="checkbox" checked={onlyFailures}
        onChange={(event) => { setAction(undefined); setOnlyFailures(event.target.checked); }} />{t.onlyFailures}</label>
      {calendar.error && <Failure code={calendar.error} lang={lang} retry={calendar.reload} />}
      {!calendar.data && !calendar.error && <p className="muted" role="status">{f.loading}</p>}
      {rows && <div className="history-list" aria-busy={!calendar.data && !calendar.error}>
        {!rows.length && <p className="finance-empty">{onlyFailures ? t.noneFailures : t.noneDates}</p>}
        {rows.map((entry) => {
          const key = occurrenceKey(entry);
          const eligible = entry.status === 'needs_intervention' && !!entry.failureRevision && !entry.recoveryHeld &&
            !accounts.find(({ accountId }) => accountId === entry.accountId)?.archived;
          const amountMinor = entry.kind === 'expense' ? '-' + entry.amountMinor : entry.amountMinor;
          return <div className="schedule-date-row" key={key} data-testid={'admin-schedule-date-' + key}>
            <div className="finance-line">
              <strong>{dateLabel(entry.date, lang)} · {categoryLabel(entry.categoryId, categories ?? [], lang) ?? f[entry.kind]}</strong>
              <span className={entry.status === 'posted' ? transactionAmountClass(amountMinor) : 'money'}>
                {formatMoney(amountMinor, entry.currency, lang, true)}
              </span>
            </div>
            <p className={entry.status === 'needs_intervention' ? 'schedule-attention' : 'muted'}>{t[entry.status]}</p>
            {entry.recoveryHeld && <p className="muted">{t.recoveryHeld}</p>}
            {entry.errorCode === 'RECOVERY_UNCERTAIN' && <p className="muted">{t.recoveryUncertain}</p>}
            {entry.errorCode && <p className="muted">{t.failureCode} · <code>{entry.errorCode}</code>
              {entry.attempts !== undefined && ' · ' + t.attempts + ' ' + entry.attempts}</p>}
            {entry.nextAttemptAt !== undefined && <p className="muted">{t.retryAt} · {utcMoment(entry.nextAttemptAt, lang)}</p>}
            {(entry.source ?? entry.incomeSource) && <p>{entry.source ?? entry.incomeSource}</p>}
            {entry.comment && <p>{entry.comment}</p>}
            {entry.reason && <p className="muted">{f.reason} · {entry.reason}</p>}
            {entry.sourceOccurrenceId && <p className="muted">{t.carried}</p>}
            {(!ruleId || entry.transactionId || eligible) && <div className="row-actions">
              {!ruleId && <AdminLink className="text-button" href={schedulePath(entry.ruleId)}
                onClick={() => prepareRule(entry.date)}>{t.reviewRule}</AdminLink>}
              {entry.transactionId && <AdminLink className="text-button"
                href={adminPaths.transaction(userId, entry.accountId, entry.transactionId)}>{t.operation}</AdminLink>}
              {eligible && <>
                <button type="button" disabled={commandBlocked || !calendar.data} onClick={() => chooseAction(entry, 'retry')}>{t.retryDate}</button>
                <button type="button" disabled={commandBlocked || !calendar.data} onClick={() => chooseAction(entry, 'skip')}>{t.skipDate}</button>
              </>}
            </div>}
            {eligible && action?.key === key && action.revision === entry.failureRevision && <OccurrenceAction key={action.mode}
              entry={entry} revision={action.revision} mode={action.mode} userId={userId} lang={lang} session={session}
              commands={commands} disabled={commandBlocked || !calendar.data} onExpired={onExpired} onCancel={() => setAction(undefined)}
              onSettled={(result) => { setAction(undefined); setNotice(result); calendar.reload(); }}
              onUnknown={() => { setNotice('unknownWrite'); calendar.reload(); }} />}
          </div>;
        })}
      </div>}
    </section>
  </section>;
}

function ruleAmount({ amountMinor, kind, currency }: Pick<Rule, 'amountMinor' | 'kind' | 'currency'>, lang: Language) {
  return formatMoney(kind === 'expense' ? '-' + amountMinor : amountMinor, currency, lang, true);
}

function PeriodForm({ period, lang, onSubmit }: { period: Range; lang: Language; onSubmit: (period: Range) => void }) {
  const t = scheduleWords[lang];
  const [invalid, setInvalid] = useState(false);
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    const fromDate = String(input.get('fromDate'));
    const throughDate = String(input.get('throughDate'));
    if (fromDate > throughDate || throughDate > shiftDate(fromDate, 366)) {
      setInvalid(true);
      return;
    }
    onSubmit({ fromDate, throughDate });
  }
  return <form className="finance-fields" onSubmit={apply} onChange={() => setInvalid(false)}>
    <div className="finance-form-grid">
      <LabeledInput label={t.from} name="fromDate" type="date" min={firstFinancialDate} max={lastFinancialDate}
        defaultValue={period.fromDate} required />
      <LabeledInput label={t.through} name="throughDate" type="date" min={firstFinancialDate} max={lastFinancialDate}
        defaultValue={period.throughDate} required />
    </div>
    {invalid && <p role="alert" className="error">{t.invalidPeriod}</p>}
    <div className="row-actions"><button>{t.showPeriod}</button></div>
  </form>;
}

function OccurrenceAction({ entry, revision, mode, userId, lang, session, commands, disabled, onExpired, onCancel, onSettled, onUnknown }: {
  entry: Entry; revision: string; mode: DateAction['mode']; userId: string; lang: Language; session: Session;
  commands: AdminCommands; disabled: boolean; onExpired: () => void; onCancel: () => void;
  onSettled: (result: 'queued' | 'failureChanged') => void; onUnknown: () => void;
}) {
  const t = scheduleWords[lang];
  const f = financeWords[lang];
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || working.current || uncertain) return;
    if (!reason.trim()) { setError('INVALID_REQUEST'); return; }
    const { ruleId, date } = entry;
    const params = { userId, ruleId, date };
    const body = { reason: reason.trim(), expectedFailureRevision: revision };
    working.current = true;
    setBusy(true);
    setError('');
    try {
      if (mode === 'retry') {
        await api('adminRetryScheduleOccurrence', { params, csrf: session.csrf, body });
        if (alive.current) onSettled('queued');
      } else {
        await commands.submit({ command: 'schedule.skip', ...params }, (idempotencyKey) =>
          api('adminSkipScheduleOccurrence', { params, csrf: session.csrf, body: { ...body, idempotencyKey } }));
      }
    } catch (failure) {
      if (!alive.current) return;
      const code = errorCode(failure);
      if (code === 'ADMIN_AUTH_INVALID') onExpired();
      else if (code === 'SCHEDULE_DATE_CONFLICT' || code === 'ACCOUNT_UNAVAILABLE') onSettled('failureChanged');
      else if (mode === 'retry' && (code === 'NETWORK' || code === 'INTERNAL_ERROR')) {
        setUncertain(true);
        onUnknown();
      } else setError(code);
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <form className="schedule-action" onSubmit={(event) => void submit(event)}>
    <fieldset className="finance-fields" disabled={busy || disabled || uncertain}>
      <label>{f.reason}<textarea required rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      {error && <Failure code={error} lang={lang} />}
      <div className="row-actions"><button className="primary">{mode === 'skip' ? t.confirmSkip : t.confirmRetry}</button></div>
    </fieldset>
    <div className="row-actions"><button type="button" className="text-button" onClick={onCancel}>{f.cancel}</button></div>
  </form>;
}
