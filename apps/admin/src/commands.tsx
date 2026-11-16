import { useEffect, useRef, useState } from 'react';
import type { Body, Language, Result } from '@teta/contracts';
import { formatMoney } from '@teta/contracts/money';
import { api, ApiError, errorCode } from './api';
import { financeWords } from './finance-copy';
import { dateLabel } from './finance-ui';
import { scheduleWords } from './schedule-copy';

type Command = Body<'adminCommandStatus'>;
type WithoutKey<T> = T extends Command ? Omit<T, 'idempotencyKey'> : never;
export type CommandTarget = WithoutKey<Command>;
export type CommandResult = Result<'adminCloseCommand'>['result'];
type Reference = Command & { actorId: string };
type Session = Result<'adminMe'>;
type Send = (idempotencyKey: string) => Promise<CommandResult>;
type Outcome = { reference: Reference; result: CommandResult };

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const prefix = (actorId: string) => `finance-command.${actorId}.`;
const storageKey = (reference: Reference) => prefix(reference.actorId) + reference.idempotencyKey;
const rejected = new Set(['INVALID_REQUEST', 'VERSION_CONFLICT', 'SCHEDULE_DATES_PENDING', 'SCHEDULE_DATE_CONFLICT',
  'SCHEDULE_REPLACEMENT_CONFLICT', 'SCHEDULE_RULE_STATE_CONFLICT', 'TRANSACTION_VOID', 'ACCOUNT_UNAVAILABLE']);

function readReferences(actorId: string): Reference[] {
  const entries: Reference[] = [];
  const keys = Object.keys(localStorage).filter((key) => key.startsWith(prefix(actorId)));
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('actorId' in value) || value.actorId !== actorId ||
      !('userId' in value) || !id(value.userId) || !('idempotencyKey' in value) || typeof value.idempotencyKey !== 'string' ||
      !/^[1-9][0-9]{0,9}\.[a-f0-9]{64}$/.test(value.idempotencyKey) || key !== prefix(actorId) + value.idempotencyKey ||
      !('command' in value)) throw new ApiError('STORAGE');
    const base = { actorId, userId: value.userId, idempotencyKey: value.idempotencyKey };
    if (value.command === 'account.create') {
      entries.push({ ...base, command: value.command });
    } else if ((value.command === 'account.reconcile' || value.command === 'account.delete') &&
      'accountId' in value && id(value.accountId)) {
      entries.push({ ...base, command: value.command, accountId: value.accountId });
    } else if ((value.command === 'transaction.revise' || value.command === 'transaction.void') &&
      'transactionId' in value && id(value.transactionId)) {
      entries.push({ ...base, command: value.command, transactionId: value.transactionId });
    } else if (value.command === 'schedule.skip' && 'ruleId' in value && id(value.ruleId) &&
      'date' in value && typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
      entries.push({ ...base, command: value.command, ruleId: value.ruleId, date: value.date });
    } else if (value.command === 'schedule.replace' && 'ruleId' in value && id(value.ruleId) &&
      'accountId' in value && id(value.accountId)) {
      entries.push({ ...base, command: value.command, ruleId: value.ruleId, accountId: value.accountId });
    } else if (value.command === 'schedule.delete' && 'ruleId' in value && id(value.ruleId)) {
      entries.push({ ...base, command: value.command, ruleId: value.ruleId });
    } else throw new ApiError('STORAGE');
  }
  return entries;
}

function resultMatches(reference: Reference, result: CommandResult) {
  if (reference.command === 'account.create') return 'startDate' in result;
  if (reference.command === 'account.delete') {
    return 'accountId' in result && 'status' in result && result.status === 'deleted' && result.accountId === reference.accountId;
  }
  if (reference.command === 'account.reconcile') return 'adjustmentId' in result && result.accountId === reference.accountId;
  if (reference.command === 'schedule.skip') {
    return 'occurrenceId' in result && result.ruleId === reference.ruleId && result.date === reference.date;
  }
  if (reference.command === 'schedule.replace') {
    return 'replacementRule' in result && result.ruleId === reference.ruleId && result.accountId === reference.accountId;
  }
  if (reference.command === 'schedule.delete') {
    return 'ruleId' in result && 'status' in result && result.status === 'deleted' && result.ruleId === reference.ruleId;
  }
  return 'accounts' in result && result.transactionId === reference.transactionId &&
    result.status === (reference.command === 'transaction.void' ? 'void' : 'posted');
}

export function useAdminCommands(session: Session | undefined, onExpired: () => void) {
  const active = useRef<Session | undefined>(undefined);
  active.current = session;
  const task = useRef<symbol | undefined>(undefined);
  const draft = useRef<{ key: string; send: Send } | undefined>(undefined);
  const [state, setState] = useState<{ actorId: string; refs: Reference[]; storageError?: boolean }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState('');
  const [outcome, setOutcome] = useState<Outcome>();
  const pending = state?.actorId === session?.id ? state?.refs[0] : undefined;
  const ready = !!session && state?.actorId === session.id && !state.storageError;

  function read(owner: Session) {
    try {
      const refs = readReferences(owner.id);
      if (active.current === owner) setState({ actorId: owner.id, refs });
      return refs;
    } catch {
      if (active.current === owner) setState({ actorId: owner.id, refs: [], storageError: true });
      throw new ApiError('STORAGE');
    }
  }

  useEffect(() => {
    task.current = undefined;
    draft.current = undefined;
    setBusy(false);
    setError('');
    setReview('');
    setOutcome(undefined);
    if (!session) { setState(undefined); return; }
    function refresh() { try { read(session!); } catch { /* Storage status is shown by the recovery panel. */ } }
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(prefix(session.id))) refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [session]);

  async function run(action: (owner: Session) => Promise<void>, propagate = false) {
    if (!session || active.current !== session || task.current) {
      if (propagate) throw new ApiError('COMMAND_PENDING');
      return;
    }
    const ticket = Symbol();
    task.current = ticket;
    setError('');
    setBusy(true);
    try { await action(session); }
    catch (error) {
      if (active.current !== session || task.current !== ticket) return;
      const code = errorCode(error);
      if (code === 'ADMIN_AUTH_INVALID') {
        active.current = undefined;
        onExpired();
      }
      else if (propagate) throw error;
      else setError(code);
    } finally {
      if (task.current === ticket) {
        task.current = undefined;
        if (active.current === session) setBusy(false);
      }
    }
  }

  function clear(owner: Session, reference: Reference) {
    if (active.current !== owner) return false;
    try { localStorage.removeItem(storageKey(reference)); }
    catch { throw new ApiError('STORAGE'); }
    if (draft.current?.key === reference.idempotencyKey) draft.current = undefined;
    setReview('');
    read(owner);
    return true;
  }

  function commit(owner: Session, reference: Reference, result: CommandResult) {
    if (!resultMatches(reference, result)) throw new ApiError('INVALID_RESPONSE');
    if (clear(owner, reference)) setOutcome({ reference, result });
  }

  async function send(owner: Session, reference: Reference, write: Send, first: boolean) {
    try { commit(owner, reference, await write(reference.idempotencyKey)); }
    catch (error) {
      if (active.current !== owner) return;
      const code = errorCode(error);
      if (code === 'COMMAND_REQUIRES_REVIEW') { setReview(reference.idempotencyKey); return; }
      if (code === 'COMMAND_CLOSED' || rejected.has(code) || (first && code === 'NOT_FOUND')) clear(owner, reference);
      throw error;
    }
  }

  function resolve(reference: Reference, close: boolean) {
    return run(async (owner) => {
      const { actorId: _actorId, ...body } = reference;
      try {
        const response = close ? await api('adminCloseCommand', { csrf: owner.csrf, body })
          : await api('adminCommandStatus', { csrf: owner.csrf, body });
        if (active.current !== owner) return;
        if (response.state === 'committed') commit(owner, reference, response.result);
        else setError('OUTCOME_UNKNOWN');
      } catch (error) {
        if (active.current !== owner) return;
        const code = errorCode(error);
        if (code === 'COMMAND_CLOSED') { clear(owner, reference); setError(code); }
        else if (code === 'COMMAND_REQUIRES_REVIEW') setReview(reference.idempotencyKey);
        else throw error;
      }
    });
  }

  useEffect(() => {
    if (pending && ready) void resolve(pending, false);
  }, [ready, pending?.idempotencyKey]);

  return {
    pending, ready, busy, error: state?.storageError ? 'STORAGE' : error,
    outcome: outcome?.reference.actorId === session?.id ? outcome : undefined,
    reviewing: pending !== undefined && review === pending.idempotencyKey,
    canRetry: pending !== undefined && draft.current?.key === pending.idempotencyKey,
    dismiss: () => { setOutcome(undefined); setError(''); },
    submit: (target: CommandTarget, write: Send) => run(async (owner) => {
      if (read(owner).length) throw new ApiError('COMMAND_PENDING');
      const random = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => (0x100 + byte).toString(16).slice(1)).join('');
      const reference: Reference = { ...target, actorId: owner.id, idempotencyKey: owner.recoveryVersion + '.' + random };
      try {
        localStorage.setItem(storageKey(reference), JSON.stringify(reference));
        if (!read(owner).some((value) => value.idempotencyKey === reference.idempotencyKey)) throw new ApiError('STORAGE');
      } catch { throw new ApiError('STORAGE'); }
      setOutcome(undefined);
      draft.current = { key: reference.idempotencyKey, send: write };
      await send(owner, reference, write, true);
    }, true),
    retry: () => {
      const write = draft.current;
      if (pending && write?.key === pending.idempotencyKey) return run((owner) => send(owner, pending, write.send, false));
    },
    check: () => pending && resolve(pending, false),
    close: () => pending && resolve(pending, true),
    confirmReview: () => pending && review === pending.idempotencyKey && run(async (owner) => {
      clear(owner, pending);
      setError('REVIEW_CONFIRMED');
    }),
  };
}

export type AdminCommands = ReturnType<typeof useAdminCommands>;

export function CommandRecovery({ commands, lang, userId }: { commands: AdminCommands; lang: Language; userId?: string }) {
  const t = financeWords[lang];
  const s = scheduleWords[lang];
  const { pending, error, busy, outcome } = commands;
  const result = outcome?.reference.userId === userId ? outcome?.result : undefined;
  if (!pending && !outcome && !error) return null;
  return <section className="recovery-panel" aria-live="polite">
    {pending && <>
      <h2>{t.commandLabels[pending.command]}</h2>
      <p>{commands.reviewing ? t.reviewCommand : t.pendingCommand}</p>
      <div className="row-actions">
        {commands.reviewing ? <button disabled={busy} onClick={() => {
          if (window.confirm(t.confirmReview)) void commands.confirmReview();
        }}>{t.confirmReviewed}</button> : <>
          <button disabled={busy} onClick={() => void commands.check()}>{t.checkCommand}</button>
          {commands.canRetry && <button disabled={busy} onClick={() => void commands.retry()}>{t.retryCommand}</button>}
          <button disabled={busy} onClick={() => {
            if (window.confirm(t.confirmClose)) void commands.close();
          }}>{t.closeCommand}</button>
        </>}
      </div>
    </>}
    {error && <p role="status">{t.errors[error] ?? t.errors.NETWORK}</p>}
    {outcome && <div role="status">
      <p>{outcome.reference.command === 'schedule.delete' ? s.deleted : `${t.commandLabels[outcome.reference.command]} · ${t.committed}`}</p>
      {result && 'startDate' in result && <p>{result.name} · {dateLabel(result.startDate, lang)} · {formatMoney(result.balanceMinor, result.currency, lang)}</p>}
      {result && 'adjustmentId' in result && <p>{dateLabel(result.date, lang)} · {t.actual} {formatMoney(result.actualBalanceMinor, result.currency, lang)} ·
        {' '}{t.delta} {formatMoney(result.deltaMinor, result.currency, lang, true)}</p>}
      {result && 'accounts' in result && <p>{t.version} {result.transactionVersion} · {t[result.status]}</p>}
      {result && 'occurrenceId' in result && <p>{dateLabel(result.date, lang)} · {s.skipped} · {result.reason}</p>}
      {result && 'replacementRule' in result && <p>{s.transition} · {dateLabel(result.transitionDate, lang)}</p>}
    </div>}
    {!pending && error !== 'STORAGE' && <button className="text-button" onClick={commands.dismiss}>{t.dismiss}</button>}
  </section>;
}
