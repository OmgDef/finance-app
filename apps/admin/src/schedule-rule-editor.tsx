import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Body, Language, Result } from '@teta/contracts';
import { api, errorCode } from './api';
import type { AdminCommands } from './commands';
import { financeWords } from './finance-copy';
import { AccountPicker, dateLabel, Failure, lastFinancialDate, LabeledInput, useAmount, useQuery } from './finance-ui';
import type { Account, Category, Session } from './finance-ui';
import { scheduleWords } from './schedule-copy';

type Rule = Result<'adminGetScheduleRule'>;
type Preview = Result<'adminPreviewScheduleRuleReplacement'>;
type Create = Body<'adminCreateScheduleRule'>;
type Change = Body<'adminChangeScheduleRule'>;
type Replacement = Omit<Body<'adminReplaceScheduleRule'>, 'idempotencyKey'>;
type Context = { userId: string; session: Session; lang: Language; disabled: boolean; onExpired: () => void };
type Terms = Omit<Create, 'accountId' | 'reason'>;
const lifecycleConflict = ['VERSION_CONFLICT', 'SCHEDULE_RULE_STATE_CONFLICT', 'ACCOUNT_UNAVAILABLE'];
const replacementConflict = [...lifecycleConflict, 'SCHEDULE_REPLACEMENT_CONFLICT'];

export function utcMoment(value: number, lang: Language) {
  const moment = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  return moment.format(value) + ' UTC';
}

function validateDecisions(form: HTMLFormElement, preview: Preview, terms: Terms) {
  const values = new FormData(form);
  const targets = new Set<string>();
  const decisions: Replacement['decisions'] = [];
  const first = Date.parse(terms.firstDate + 'T00:00:00Z');
  for (const { date: sourceDate } of preview.skippedDates) {
    const choice = values.get('decision-' + sourceDate);
    if (choice !== 'carry' && choice !== 'omit') return { error: 'selectDecisions' as const };
    if (choice === 'omit') {
      decisions.push({ sourceDate, targetDate: null });
      continue;
    }
    const targetDate = values.get('target-' + sourceDate);
    if (typeof targetDate !== 'string' || targetDate < terms.firstDate ||
      (terms.endDate && targetDate > terms.endDate) || targets.has(targetDate)) return { error: 'invalidDecision' as const };
    const target = new Date(targetDate + 'T00:00:00Z');
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    const matches = terms.frequency === 'once' ? targetDate === terms.firstDate : terms.frequency === 'weekly'
      ? (target.getTime() - first) % (7 * 86_400_000) === 0
      : target.getUTCDate() === Math.min(Number(terms.firstDate.slice(-2)), last);
    if (!matches) return { error: 'invalidDecision' as const };
    targets.add(targetDate);
    decisions.push({ sourceDate, targetDate });
  }
  return { decisions };
}

function DecisionRow({ source, preview, lang }: { source: Preview['skippedDates'][number]; preview: Preview; lang: Language }) {
  const t = scheduleWords[lang];
  const f = financeWords[lang];
  const [choice, setChoice] = useState('');
  const date = dateLabel(source.date, lang);
  return <div className="schedule-decision">
    <strong>{date}</strong><p className="muted">{source.reason}</p>
    <label>{t.decision}<select name={'decision-' + source.date} aria-label={t.decision + ' · ' + date}
      value={choice} onChange={(event) => setChoice(event.target.value)} required>
      <option value="" disabled>{f.choose}</option>
      <option value="carry">{t.carry}</option>
      <option value="omit">{t.omit}</option>
    </select></label>
    {choice === 'carry' && <LabeledInput label={t.newDate} aria-label={t.newDate + ' · ' + date}
      name={'target-' + source.date} type="date" min={preview.earliestFirstDate} max={lastFinancialDate} required />}
  </div>;
}

function RuleForm({ account, rule, mode, today, categories, lang, disabled, preview, onSave, onCancel }: {
  account: Account; rule?: Rule; mode: 'create' | 'edit' | 'replace'; today: string; categories: Category[];
  lang: Language; disabled: boolean; preview?: Preview; onSave: (terms: Terms, reason: string, decisions: Replacement['decisions']) => void;
  onCancel: () => void;
}) {
  const t = scheduleWords[lang];
  const f = financeWords[lang];
  const [kind, setKind] = useState<Terms['kind']>(rule?.kind ?? 'expense');
  const [frequency, setFrequency] = useState<Terms['frequency']>(rule?.frequency ?? 'once');
  const earliest = preview?.earliestFirstDate ?? account.startDate;
  const defaultFirst = mode === 'create' && today > earliest ? today : earliest;
  const initial = rule && (mode === 'edit' || rule.firstDate >= earliest) ? rule.firstDate : defaultFirst;
  const [firstDate, setFirstDate] = useState(initial);
  const [endDate, setEndDate] = useState(rule?.endDate && rule.endDate >= initial ? rule.endDate : '');
  const [categoryId, setCategory] = useState(rule?.categoryId ?? '');
  const originalSource = rule?.source ?? rule?.incomeSource;
  const [sourceText, setSourceText] = useState(originalSource ?? '');
  const [comment, setComment] = useState(rule?.comment ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const amount = useAmount(rule?.currency === account.currency ? rule.amountMinor : undefined, lang);
  const options = categories.filter((entry) => entry.type === kind);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const amountMinor = amount.value;
    if (!reason.trim() || !amountMinor || BigInt(amountMinor) <= 0n || !options.some(({ id }) => id === categoryId) ||
      (mode !== 'edit' && firstDate < earliest) || (frequency !== 'once' && endDate && endDate < firstDate)) {
      setError('INVALID_REQUEST');
      return;
    }
    const source = sourceText.trim();
    const terms = { kind, frequency, amountMinor, categoryId, firstDate, comment: comment.trim() || null,
      ...((source || originalSource) && { source: source || null }),
      endDate: frequency === 'once' || !endDate ? null : endDate };
    const decision = preview ? validateDecisions(event.currentTarget, preview, terms) : { decisions: [] };
    if (decision.error) {
      setError(decision.error);
      return;
    }
    setError('');
    onSave(terms, reason.trim(), decision.decisions);
  }

  return <form onSubmit={submit} onChange={() => setError('')}>
    <fieldset className="finance-fields" disabled={disabled}>
      <div className="finance-form-grid">
        {mode !== 'edit' && <>
          <label>{t.kind}<select value={kind} onChange={(event) => {
            setKind(event.target.value as Terms['kind']);
            setCategory('');
            setSourceText('');
          }}>
            <option value="expense">{f.expense}</option><option value="income">{f.income}</option>
          </select></label>
          <label>{t.frequency}<select value={frequency} onChange={(event) => setFrequency(event.target.value as Terms['frequency'])}>
            <option value="once">{t.once}</option><option value="weekly">{t.weekly}</option><option value="monthly">{t.monthly}</option>
          </select></label>
          <LabeledInput label={t.first} type="date" required value={firstDate} min={earliest} max={lastFinancialDate}
            onChange={(event) => setFirstDate(event.target.value)} />
        </>}
        {frequency !== 'once' && <LabeledInput label={t.last} type="date" value={endDate} min={firstDate} max={lastFinancialDate}
          onChange={(event) => setEndDate(event.target.value)} />}
        <LabeledInput label={f.amount} currency={account.currency} {...amount.field} required />
        <label>{f.category}<select required value={categoryId} onChange={(event) => setCategory(event.target.value)}>
          <option value="" disabled>{f.choose}</option>
          {options.map(({ id, nameEn, nameRu }) => <option key={id} value={id}>{lang === 'ru' ? nameRu : nameEn}</option>)}
        </select></label>
        <LabeledInput label={f.transactionSource} maxLength={120} value={sourceText}
          onChange={(event) => setSourceText(event.target.value)} />
        <label className="full-row">{f.comment}<textarea value={comment} maxLength={500} rows={2}
          onChange={(event) => setComment(event.target.value)} /></label>
      </div>
      {mode === 'create' && firstDate && firstDate < today && <p className="muted">{t.pastDates}</p>}
      {preview && preview.skippedDates.length > 0 && <section className="schedule-decisions">
        <h3>{t.decisions}</h3>
        {preview.skippedDates.map((source) => <DecisionRow key={preview.previewToken + source.date}
          source={source} preview={preview} lang={lang} />)}
      </section>}
      <label>{f.reason}<textarea required maxLength={500} rows={2} value={reason}
        onChange={(event) => setReason(event.target.value)} /></label>
      {error === 'selectDecisions' || error === 'invalidDecision' ? <p role="alert" className="error">{t[error]}</p>
        : error && <Failure code={error} lang={lang} />}
      {mode === 'edit' && <p className="muted">{t.lifecycle}</p>}
      <div className="row-actions">
        <button className="primary">{mode === 'replace' ? t.confirmReplace : f.save}</button>
        <button type="button" className="text-button" onClick={onCancel}>{f.cancel}</button>
      </div>
    </fieldset>
  </form>;
}

export function RuleEditor({ action, rule, account, categories, today, onCancel, onSaved, onRefresh, ...context }: Context & {
  action: 'create' | Change['action']; rule?: Rule; account: Account; categories: Category[]; today: string;
  onCancel: () => void; onSaved: (rule: Rule) => void; onRefresh: () => void;
}) {
  const { lang, session, userId, disabled, onExpired } = context;
  const f = financeWords[lang];
  const t = scheduleWords[lang];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [reason, setReason] = useState('');
  const working = useRef(false);
  const alive = useRef(true);
  const lifecycle = action === 'pause' || action === 'resume' || action === 'end';

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function save(fields: Terms | undefined, reason: string) {
    if (disabled || working.current || uncertain) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const params = { userId };
      const options = { csrf: session.csrf };
      let updated: Rule | undefined;
      if (action === 'create' && fields) {
        updated = await api('adminCreateScheduleRule', { ...options, params, body: { ...fields, accountId: account.accountId, reason } });
      } else if (rule && action !== 'create') {
        const version = { expectedRuleVersion: rule.ruleVersion, reason };
        const body: Change = action === 'edit' && fields ? {
          ...version, action, amountMinor: fields.amountMinor, categoryId: fields.categoryId, comment: fields.comment,
          source: fields.source, endDate: fields.endDate,
        } : { ...version, action };
        updated = await api('adminChangeScheduleRule', { ...options, params: { ...params, ruleId: rule.ruleId }, body });
      }
      if (updated && alive.current) onSaved(updated);
    } catch (failure) {
      if (!alive.current) return;
      const code = errorCode(failure);
      if (code === 'ADMIN_AUTH_INVALID') onExpired();
      else {
        setError(code);
        if (code === 'NETWORK' || code === 'INTERNAL_ERROR') setUncertain(true);
        if (lifecycleConflict.includes(code) || code === 'NETWORK' || code === 'INTERNAL_ERROR') onRefresh();
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <>
    {uncertain ? <p role="status" className="finance-notice">{t.unknownWrite}</p>
      : error === 'VERSION_CONFLICT' ? <p role="status" className="finance-notice">{t.changed}</p>
      : error && <Failure code={error} lang={lang} />}
    {lifecycle ? <form onSubmit={(event) => {
      event.preventDefault();
      if (reason.trim()) void save(undefined, reason.trim());
      else setError('INVALID_REQUEST');
    }}>
      <fieldset className="finance-fields" disabled={disabled || busy || uncertain}>
        <p className="muted">{t.lifecycle}</p>
        <label>{f.reason}<textarea value={reason} maxLength={500} rows={2} required
          onChange={(event) => setReason(event.target.value)} /></label>
        <div className="row-actions"><button className="primary">{t[action]}</button>
          <button type="button" className="text-button" onClick={onCancel}>{f.cancel}</button></div>
      </fieldset>
    </form> : <RuleForm account={account} rule={rule} mode={action} today={today} categories={categories} lang={lang}
      disabled={disabled || busy || uncertain} onSave={(terms, text) => void save(terms, text)} onCancel={onCancel} />}
  </>;
}

export function ReplacementEditor({ rule, accounts, today, categories, commands, onCancel, onRefresh, ...context }: Context & {
  rule: Rule; accounts: Account[]; today: string; categories: Category[]; commands: AdminCommands;
  onCancel: () => void; onRefresh: () => void;
}) {
  const { userId, lang, session, disabled, onExpired } = context;
  const t = scheduleWords[lang];
  const [destinationId, setDestination] = useState(rule.accountId);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const alive = useRef(true);
  const active = accounts.filter(({ archived }) => !archived);
  const source = accounts.find(({ accountId }) => accountId === rule.accountId);
  const target = active.find(({ accountId }) => accountId === destinationId);
  const params = { userId, ruleId: rule.ruleId };
  const query = useQuery(target ? [userId, rule.ruleId, destinationId, rule.ruleVersion, today].join(':') : '',
    async (signal) => {
      const [preview, latest] = await Promise.all([
        api('adminPreviewScheduleRuleReplacement', { params, query: { accountId: destinationId }, signal }),
        api('adminGetScheduleRule', { params, signal }),
      ]);
      return { preview, latest };
    }, onExpired);
  const view = query.data ?? query.previous;
  const valid = view && view.latest.ruleVersion === view.preview.ruleVersion;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function replace(terms: Terms, reason: string, decisions: Replacement['decisions']) {
    if (!query.data || !valid || !target || disabled) return;
    const { preview } = query.data;
    const body = { ...terms, reason, accountId: target.accountId, expectedRuleVersion: preview.ruleVersion,
      previewToken: preview.previewToken, decisions };
    setError('');
    try {
      await commands.submit({ command: 'schedule.replace', ...params, accountId: target.accountId }, (idempotencyKey) =>
        api('adminReplaceScheduleRule', { csrf: session.csrf, params, body: { ...body, idempotencyKey } }));
    } catch (failure) {
      if (!alive.current) return;
      const code = errorCode(failure);
      if (replacementConflict.includes(code)) {
        setChanged(true);
        query.reload();
        onRefresh();
      } else setError(code);
    }
  }

  return <div className="schedule-stack">
    <fieldset className="finance-fields" disabled={disabled}>
      <p className="muted">{t.source} · {source?.name ?? rule.accountId}</p>
      <AccountPicker label={t.destination} accounts={active} value={destinationId} onChange={(id) => {
        setDestination(id);
        setError('');
        setChanged(false);
      }} />
    </fieldset>
    {changed && <p role="status" className="finance-notice">{t.changed}</p>}
    {error && <Failure code={error} lang={lang} />}
    {query.error && <Failure code={query.error} lang={lang} retry={query.reload} />}
    {!query.data && !query.error && target && <p className="muted" role="status">{financeWords[lang].loading}</p>}
    {!target && <Failure code="ACCOUNT_UNAVAILABLE" lang={lang} />}
    {(!view || !valid || !target) && <div className="row-actions">
      <button className="text-button" type="button" onClick={onCancel}>{financeWords[lang].cancel}</button>
    </div>}
    {view && !valid && <Failure code="VERSION_CONFLICT" lang={lang} retry={query.reload} />}
    {view && valid && target && <>
      <dl className="schedule-transition">
        <div><dt>{t.transition}</dt><dd>{dateLabel(view.preview.transitionDate, lang)}</dd></div>
        <div><dt>{t.boundary}</dt><dd>{utcMoment(view.preview.transitionAt, lang)}</dd></div>
        <div><dt>{t.earliest}</dt><dd>{dateLabel(view.preview.earliestFirstDate, lang)}</dd></div>
      </dl>
      <RuleForm key={target.accountId + ':' + view.latest.ruleVersion} account={target}
        rule={view.latest} mode="replace" today={today} categories={categories}
        lang={lang} disabled={disabled || !query.data} preview={view.preview} onSave={(terms, reason, decisions) => void replace(terms, reason, decisions)}
        onCancel={onCancel} />
    </>}
  </div>;
}
