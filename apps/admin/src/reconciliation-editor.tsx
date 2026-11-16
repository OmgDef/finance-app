import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Body, Language, Result } from '@teta/contracts';
import { formatMoney } from '@teta/contracts/money';
import { api, errorCode } from './api';
import type { AdminCommands } from './commands';
import { financeWords } from './finance-copy';
import { scheduleWords } from './schedule-copy';
import { BalanceImpact, categoryLabel, dateLabel, Failure, firstFinancialDate, lastFinancialDate, LabeledInput, shiftDate,
  useAmount, useQuery } from './finance-ui';
import type { Account, Category, Session } from './finance-ui';

type Preview = Result<'adminPreviewBalanceAdjustment'>;
type Entry = Preview['dates'][number];
type Draft = Omit<Body<'adminReconcileAccountBalance'>, 'idempotencyKey'>;
type Selection = NonNullable<Draft['skippedDates']>[number];
type Choices = Record<string, Selection>;

const windowDays = 90;
const maxMinor = 9223372036854775807n;
const minMinor = -9223372036854775808n;
const conflict = new Set(['VERSION_CONFLICT', 'SCHEDULE_DATE_CONFLICT', 'SCHEDULE_DATES_PENDING']);
const dateKey = ({ ruleId, date }: Pick<Selection, 'ruleId' | 'date'>) => `${ruleId}-${date}`;

function needsRecoveryReview(date: Entry) {
  return date.recoveryHeld || date.errorCode === 'RECOVERY_UNCERTAIN';
}

function selectionOf({ ruleId, date, ruleVersion, dueAt, kind, amountMinor, categoryId, comment }: Entry, reason = ''): Selection {
  return { ruleId, date, ruleVersion, dueAt, kind, amountMinor, categoryId, comment, reason };
}

export function ReconciliationEditor({ account, userId, today, categories, lang, session, commands, onExpired }: {
  account: Account; userId: string; today: string; categories: Category[]; lang: Language; session: Session;
  commands: AdminCommands; onExpired: () => void;
}) {
  const t = financeWords[lang];
  const schedule = scheduleWords[lang];
  const actual = useAmount(undefined, lang);
  const [explanation, setExplanation] = useState('');
  const [choices, setChoices] = useState<Choices>({});
  const [sawDates, setSawDates] = useState(false);
  const [none, setNone] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const [review, setReview] = useState<{ snapshot: Preview; draft: Draft }>();
  const [outstanding, setOutstanding] = useState<Pick<Entry, 'ruleId' | 'date'>[]>([]);
  const last = useRef<Preview | undefined>(undefined);
  const mounted = useRef(true);
  const params = { userId, accountId: account.accountId };
  const fromDate = shiftDate(today, offset * windowDays - 30);
  const throughDate = shiftDate(today, (offset + 1) * windowDays - 31);
  const preview = useQuery([userId, account.accountId, fromDate, throughDate].join(':'), (signal) =>
    api('adminPreviewBalanceAdjustment', { params, query: { fromDate, throughDate }, signal }), onExpired);
  const snapshot = preview.data;
  const selected = Object.values(choices);
  const unsettled = snapshot?.dates.filter(({ status }) => status !== 'posted' && status !== 'skipped') ?? [];
  const unselectedDue = outstanding.some((entry) => !choices[dateKey(entry)]);
  const disabled = !snapshot || !commands.ready || !!commands.pending || commands.busy;
  const delta = snapshot && actual.value !== undefined ? BigInt(actual.value) - BigInt(snapshot.balanceMinor) : undefined;
  const outcome = commands.outcome;
  const receipt = outcome?.reference.userId === userId && 'adjustmentId' in outcome.result &&
    outcome.result.accountId === account.accountId ? outcome.result : undefined;

  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (!snapshot) return;
    const prior = last.current;
    last.current = snapshot;
    const reset = prior !== undefined && prior.accountVersion !== snapshot.accountVersion;
    const entries = snapshot.dates.filter(({ status }) => status !== 'posted' && status !== 'skipped');
    const byKey = new Map(entries.filter((entry) => !needsRecoveryReview(entry)).map((entry) => [dateKey(entry), entry]));
    setOutstanding((previous) => [
      ...previous.filter(({ date }) => date < fromDate || date > throughDate),
      ...entries.filter(({ status }) => status === 'due' || status === 'retrying' || status === 'needs_intervention')
        .map(({ ruleId, date }) => ({ ruleId, date })),
    ]);
    setChoices((previous) => reset ? {} : Object.fromEntries(Object.entries(previous).filter(([key, choice]) => {
      if (choice.date < fromDate || choice.date > throughDate) return true;
      const next = byKey.get(key);
      return next !== undefined && JSON.stringify(selectionOf(next, choice.reason)) === JSON.stringify(choice);
    })));
    setSawDates((previous) => entries.length > 0 || (!reset && previous));
    setNone(false);
  }, [snapshot]);

  function refresh(changed = false) {
    setChoices({});
    setSawDates(false);
    setNone(false);
    setReview(undefined);
    setError('');
    setChanged(changed);
    preview.reload();
  }

  function showReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !snapshot) return;
    if (actual.value === undefined || !explanation.trim() || delta === undefined || delta < minMinor || delta > maxMinor) {
      setError('invalidReconciliation');
      return;
    }
    if (unselectedDue) { setError('SCHEDULE_DATES_PENDING'); return; }
    if ((!selected.length && sawDates && !none) || selected.some((entry) => !entry.reason.trim())) {
      setError('chooseDates');
      return;
    }
    setError('');
    setReview({ snapshot, draft: { expectedAccountVersion: snapshot.accountVersion, actualBalanceMinor: actual.value,
      explanation: explanation.trim(), skippedDates: selected.map((entry) => ({ ...entry, reason: entry.reason.trim() })) } });
  }

  async function confirm() {
    if (disabled || !review || review.snapshot !== snapshot) return;
    try {
      const { draft } = review;
      await commands.submit({ command: 'account.reconcile', ...params }, (idempotencyKey) =>
        api('adminReconcileAccountBalance', { csrf: session.csrf, params, body: { ...draft, idempotencyKey } }));
    } catch (error) {
      if (!mounted.current) return;
      const code = errorCode(error);
      if (conflict.has(code)) { refresh(true); setError(code); }
      else { setReview(undefined); setError(code); }
    }
  }

  if (receipt) return <div className="finance-confirm" role="status">
    <strong>{t.committed} · {formatMoney(receipt.actualBalanceMinor, receipt.currency, lang)}</strong>
    <p>{t.delta} · {formatMoney(receipt.deltaMinor, receipt.currency, lang, true)}</p>
    {receipt.skippedDates?.map((entry) => <p key={dateKey(entry)}>{dateLabel(entry.date, lang)} · {entry.reason}</p>)}
  </div>;

  return <>
    {changed && <p role="status" className="finance-notice">{t.changed}</p>}
    {error && <Failure code={error} lang={lang} />}
    {preview.error && <Failure code={preview.error} lang={lang} retry={() => refresh()} />}
    {!snapshot && !preview.error && <p role="status" className="muted">{t.loading}</p>}
    <form onSubmit={showReview} onChange={() => setReview(undefined)}>
      <fieldset disabled={disabled} className="finance-fields">
        <div className="finance-line"><span>{t.balance}</span><strong className="money">{snapshot
          ? formatMoney(snapshot.balanceMinor, account.currency, lang) : '—'}</strong></div>
        <div className="finance-form-grid">
          <LabeledInput label={t.actual} currency={account.currency} {...actual.field} required />
          <label>{t.reconciliationReason}<textarea required maxLength={500} rows={2} value={explanation}
            onChange={(event) => setExplanation(event.target.value)} /></label>
        </div>
        <h3>{t.dates}</h3>
        <div className="finance-section-heading">
          <p className="muted">{dateLabel(fromDate, lang)} – {dateLabel(throughDate, lang)}</p>
          <div className="row-actions">
            <button type="button" disabled={fromDate === firstFinancialDate} onClick={() => setOffset((value) => value - 1)}>{t.earlier}</button>
            <button type="button" disabled={throughDate === lastFinancialDate} onClick={() => setOffset((value) => value + 1)}>{t.later}</button>
            <button type="button" onClick={() => refresh()}>{t.refresh}</button>
          </div>
        </div>
        {snapshot && <p className="muted">{unsettled.length ? t.dateInstructions : t.noDates}</p>}
        {unselectedDue && <p className="finance-notice">{t.errors.SCHEDULE_DATES_PENDING}</p>}
        {unsettled.map((entry) => {
          const key = dateKey(entry);
          const choice = choices[key];
          const amount = entry.kind === 'expense' ? '-' + entry.amountMinor : entry.amountMinor;
          return <div key={key} className="schedule-date-row">
            <div className="finance-line"><strong>{dateLabel(entry.date, lang)} · {categoryLabel(entry.categoryId, categories, lang)}</strong>
              <strong className="money">{formatMoney(amount, account.currency, lang, true)}</strong></div>
            <p className="muted">{t[entry.status]}</p>
            {needsRecoveryReview(entry) && <p className="muted">
              {entry.recoveryHeld ? schedule.recoveryHeld : schedule.recoveryUncertain}
            </p>}
            <label className="check-control"><input type="checkbox" checked={!!choice} disabled={needsRecoveryReview(entry)} onChange={(event) => {
              const include = event.target.checked;
              setNone(false);
              setChoices((previous) => {
                const next = { ...previous };
                if (include) next[key] = selectionOf(entry);
                else delete next[key];
                return next;
              });
            }} />{t.included}</label>
            {choice && <label>{t.skipReason}<textarea required maxLength={500} rows={2} value={choice.reason}
              onChange={(event) => {
                const reason = event.target.value;
                setChoices((previous) => ({ ...previous, [key]: { ...choice, reason } }));
              }} /></label>}
          </div>;
        })}
        {!unselectedDue && !selected.length && sawDates && <label className="check-control"><input type="checkbox" checked={none}
          onChange={(event) => setNone(event.target.checked)} />{t.noIncluded}</label>}
        <div className="row-actions"><button className={review?.snapshot === snapshot ? undefined : 'primary'}>{t.reconcilePreview}</button></div>
      </fieldset>
    </form>
    {review && review.snapshot === snapshot && <div className="finance-confirm" aria-live="polite">
      <BalanceImpact lang={lang} rows={[{ id: account.accountId, name: account.name, currency: account.currency,
        before: review.snapshot.balanceMinor, after: review.draft.actualBalanceMinor }]} />
      <p><strong>{t.reason}</strong> · {review.draft.explanation}</p>
      {review.draft.skippedDates?.length ? <><h3>{t.skippedDates}</h3>
        {review.draft.skippedDates.map((entry) => <p key={dateKey(entry)}>{dateLabel(entry.date, lang)} · {entry.reason}</p>)}</>
        : <p className="muted">{t.noSkips}</p>}
      <button type="button" className="primary" disabled={disabled} onClick={() => void confirm()}>{t.confirmReconcile}</button>
    </div>}
  </>;
}
