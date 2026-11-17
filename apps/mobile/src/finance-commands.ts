import { useEffect, useRef, useState } from 'react';
import * as Store from 'expo-secure-store';
import type { Body, Result } from '@teta/contracts';
import { ApiError, request } from './api';
import { financialDate } from './finance-format';
import { secret } from './installation';

type CreateAccount = Omit<Body<'createAccount'>, 'idempotencyKey'> &
  ({ type?: 'cash' } | { type: 'deposit'; annualRatePercent: string; maturityDate: string });
type WithoutKey<T> = T extends { idempotencyKey: string } ? Omit<T, 'idempotencyKey'> : never;
export type TransactionFields = WithoutKey<Body<'recordTransaction'>>;
type SingleAccountFields = Omit<Extract<TransactionFields, { accountId: string }>, 'type'>;
export type FinanceDraft = { kind: 'account.create'; body: CreateAccount }
  | { kind: 'account.delete'; accountId: string; body: WithoutKey<Body<'deleteAccount'>> }
  | { kind: 'account.reconcile'; accountId: string; body: WithoutKey<Body<'reconcileAccountBalance'>> }
  | { kind: 'deposit.interest.apply'; accountId: string; body: WithoutKey<Body<'applyDepositInterest'>> }
  | { kind: 'expense.record' | 'income.record'; body: SingleAccountFields }
  | { kind: 'transfer.record'; body: Extract<TransactionFields, { type: 'transfer' }> }
  | { kind: 'transaction.revise'; transactionId: string; body: WithoutKey<Body<'reviseTransaction'>> }
  | { kind: 'transaction.void'; transactionId: string; body: WithoutKey<Body<'voidTransaction'>> }
  | { kind: 'schedule.skip'; ruleId: string; date: string; body: WithoutKey<Body<'skipScheduleOccurrence'>> }
  | { kind: 'schedule.replace'; ruleId: string; body: WithoutKey<Body<'replaceScheduleRule'>> }
  | { kind: 'schedule.delete'; ruleId: string; body: WithoutKey<Body<'deleteScheduleRule'>> };
type CommandKey = Extract<Body<'commandStatus'>, { command: FinanceDraft['kind'] }>;
type CommandReference = CommandKey & { actorId: string };
export type FinanceCommand = CommandReference['command'];
export type CommandResult = Result<'closeCommand'>['result'];

const storageOptions = { keychainAccessible: Store.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const storageQueues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = (storageQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  storageQueues.set(key, pending);
  return pending.finally(() => {
    if (storageQueues.get(key) === pending) storageQueues.delete(key);
  });
}

function commandReference(raw: string, actorId: string): CommandReference {
  const value: unknown = JSON.parse(raw);
  if (typeof value === 'object' && value !== null && 'actorId' in value && value.actorId === actorId &&
      'userId' in value && value.userId === actorId && 'idempotencyKey' in value && typeof value.idempotencyKey === 'string' &&
      /^[1-9][0-9]{0,9}\.[a-f0-9]{64}$/.test(value.idempotencyKey) && 'command' in value) {
    const base = { actorId, userId: actorId, idempotencyKey: value.idempotencyKey };
    if (value.command === 'account.create') return { ...base, command: value.command };
    if ((value.command === 'expense.record' || value.command === 'income.record' || value.command === 'account.reconcile' ||
        value.command === 'account.delete' || value.command === 'deposit.interest.apply') &&
        'accountId' in value && isId(value.accountId)) {
      return { ...base, command: value.command, accountId: value.accountId };
    }
    if (value.command === 'transfer.record' && 'fromAccountId' in value && isId(value.fromAccountId) &&
        'toAccountId' in value && isId(value.toAccountId) && value.fromAccountId !== value.toAccountId) {
      return { ...base, command: value.command, fromAccountId: value.fromAccountId, toAccountId: value.toAccountId };
    }
    if ((value.command === 'transaction.revise' || value.command === 'transaction.void') &&
        'transactionId' in value && isId(value.transactionId)) {
      return { ...base, command: value.command, transactionId: value.transactionId };
    }
    if ('ruleId' in value && isId(value.ruleId)) {
      if (value.command === 'schedule.delete') return { ...base, command: value.command, ruleId: value.ruleId };
      if (value.command === 'schedule.skip' && 'date' in value && typeof value.date === 'string' &&
          financialDate(value.date, 'en') === value.date) {
        return { ...base, command: value.command, ruleId: value.ruleId, date: value.date };
      }
      if (value.command === 'schedule.replace' && 'accountId' in value && isId(value.accountId)) {
        return { ...base, command: value.command, ruleId: value.ruleId, accountId: value.accountId };
      }
    }
  }
  throw new Error('Invalid saved command reference');
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
}

function newReference(data: FinanceDraft, actorId: string, idempotencyKey: string): CommandReference {
  const base = { actorId, userId: actorId, idempotencyKey };
  switch (data.kind) {
    case 'account.create': return { ...base, command: data.kind };
    case 'account.delete': return { ...base, command: data.kind, accountId: data.accountId };
    case 'account.reconcile': return { ...base, command: data.kind, accountId: data.accountId };
    case 'deposit.interest.apply': return { ...base, command: data.kind, accountId: data.accountId };
    case 'expense.record':
    case 'income.record': return { ...base, command: data.kind, accountId: data.body.accountId };
    case 'transfer.record': {
      const { fromAccountId, toAccountId } = data.body;
      return { ...base, command: data.kind, fromAccountId, toAccountId };
    }
    case 'transaction.revise':
    case 'transaction.void': return { ...base, command: data.kind, transactionId: data.transactionId };
    case 'schedule.skip': return { ...base, command: data.kind, ruleId: data.ruleId, date: data.date };
    case 'schedule.replace': return { ...base, command: data.kind, ruleId: data.ruleId, accountId: data.body.accountId };
    case 'schedule.delete': return { ...base, command: data.kind, ruleId: data.ruleId };
  }
}

function writeCommand(token: string, data: FinanceDraft, idempotencyKey: string): Promise<CommandResult> {
  switch (data.kind) {
    case 'account.create':
      return request('createAccount', { token, body: { ...data.body, idempotencyKey } });
    case 'account.delete':
      return request('deleteAccount', { token, params: { accountId: data.accountId }, body: { ...data.body, idempotencyKey } });
    case 'account.reconcile':
      return request('reconcileAccountBalance', { token, params: { accountId: data.accountId },
        body: { ...data.body, idempotencyKey } });
    case 'deposit.interest.apply':
      return request('applyDepositInterest', { token, params: { accountId: data.accountId },
        body: { ...data.body, idempotencyKey } });
    case 'expense.record':
    case 'income.record':
      return request('recordTransaction', { token, body: { ...data.body, idempotencyKey,
        type: data.kind === 'expense.record' ? 'expense' : 'income' } });
    case 'transfer.record':
      return request('recordTransaction', { token, body: { ...data.body, idempotencyKey } });
    case 'transaction.revise':
      return request('reviseTransaction', { token, params: { transactionId: data.transactionId },
        body: { ...data.body, idempotencyKey } });
    case 'transaction.void':
      return request('voidTransaction', { token, params: { transactionId: data.transactionId },
        body: { ...data.body, idempotencyKey } });
    case 'schedule.skip':
      return request('skipScheduleOccurrence', { token, params: { ruleId: data.ruleId, date: data.date },
        body: { ...data.body, idempotencyKey } });
    case 'schedule.replace':
      return request('replaceScheduleRule', { token, params: { ruleId: data.ruleId },
        body: { ...data.body, idempotencyKey } });
    case 'schedule.delete':
      return request('deleteScheduleRule', { token, params: { ruleId: data.ruleId },
        body: { ...data.body, idempotencyKey } });
  }
}

export const apiErrorCode = (error: unknown) => error instanceof ApiError ? error.message : 'STORAGE';

export interface FinanceAccess {
  token: string;
  profile: Result<'me'>;
  isCurrent(): boolean;
  onAccessFailure(code: string): boolean;
}

export function useFinanceCommand(access: FinanceAccess, onCommitted: (result: CommandResult, command: FinanceCommand) => void) {
  const { profile, token } = access;
  const storeKey = 'finance-command.' + profile.id;
  const activeTask = useRef<symbol | null>(null);
  const mounted = useRef(false);
  const draft = useRef<FinanceDraft | null>(null);
  const [pending, setPending] = useState<CommandReference | null>(null);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<'unknown' | 'review'>('unknown');

  const current = () => mounted.current && access.isCurrent();
  const readReference = async () => {
    const raw = await Store.getItemAsync(storeKey, storageOptions);
    return raw === null ? null : commandReference(raw, profile.id);
  };

  async function perform(action: () => Promise<void>) {
    if (activeTask.current || !current()) return;
    const task = Symbol();
    activeTask.current = task;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      if (current() && activeTask.current === task) {
        const code = apiErrorCode(error);
        if (!access.onAccessFailure(code)) setError(code);
      }
    } finally {
      if (activeTask.current === task) {
        activeTask.current = null;
        if (current()) setBusy(false);
      }
    }
  }

  async function clear(reference: CommandReference) {
    if (!current()) return false;
    const removed = await serialize(storeKey, async () => {
      const saved = await readReference();
      if (!current() || saved?.idempotencyKey !== reference.idempotencyKey) return false;
      await Store.deleteItemAsync(storeKey, storageOptions);
      return true;
    });
    if (!removed || !current()) return false;
    draft.current = null;
    setPending(null);
    setOutcome('unknown');
    return true;
  }

  async function markCommitted(reference: CommandReference, result: CommandResult) {
    if (await clear(reference)) onCommitted(result, reference.command);
  }

  async function resolve(reference: CommandReference, close: boolean) {
    const { actorId: _actorId, ...body } = reference;
    try {
      const response = close
        ? await request('closeCommand', { token, body })
        : await request('commandStatus', { token, body });
      if (!current()) return;
      if (response.state === 'committed') {
        await markCommitted(reference, response.result);
      } else setOutcome('unknown');
    } catch (error) {
      if (!current()) return;
      const code = apiErrorCode(error);
      if (code === 'COMMAND_CLOSED') {
        if (await clear(reference)) setError(code);
      } else if (code === 'COMMAND_REQUIRES_REVIEW') {
        setOutcome('review');
      } else {
        throw error;
      }
    }
  }

  function initialize() {
    return perform(async () => {
      setReading(true);
      const saved = await serialize(storeKey, readReference);
      if (!current()) return;
      setPending(saved);
      setReading(false);
      if (saved) await resolve(saved, false);
    });
  }

  useEffect(() => {
    mounted.current = true;
    void initialize();
    return () => {
      mounted.current = false;
      activeTask.current = null;
      draft.current = null;
    };
  }, []);

  async function send(reference: CommandReference, data: FinanceDraft, firstAttempt: boolean) {
    const { idempotencyKey } = reference;
    try {
      const response = await writeCommand(token, data, idempotencyKey);
      await markCommitted(reference, response);
    } catch (error) {
      if (!current()) return;
      const code = apiErrorCode(error);
      if (code === 'COMMAND_REQUIRES_REVIEW') {
        setOutcome('review');
        return;
      }
      const stale = ['VERSION_CONFLICT', 'TRANSACTION_VOID', 'SCHEDULE_DATES_PENDING', 'SCHEDULE_DATE_CONFLICT',
        'SCHEDULE_REPLACEMENT_CONFLICT', 'SCHEDULE_RULE_STATE_CONFLICT'].includes(code);
      const rejected = firstAttempt && ['INVALID_REQUEST', 'ACCOUNT_UNAVAILABLE', 'NOT_FOUND', 'API_CONFIGURATION'].includes(code);
      if (code === 'COMMAND_CLOSED' || stale || rejected) await clear(reference);
      throw error;
    }
  }

  function submit(data: FinanceDraft) {
    if (pending || reading) return;
    return perform(async () => {
      const idempotencyKey = profile.recoveryVersion + '.' + await secret();
      const reference = newReference(data, profile.id, idempotencyKey);
      const saved = await serialize(storeKey, async () => {
        const previous = await readReference();
        if (!current()) return null;
        if (previous) return previous;
        try {
          await Store.setItemAsync(storeKey, JSON.stringify(reference), storageOptions);
          const stored = await readReference();
          if (stored?.idempotencyKey !== idempotencyKey) throw new Error('Saved command key mismatch');
        } catch (error) {
          if (current()) setReading(true);
          throw error;
        }
        return reference;
      });
      if (!current() || !saved) return;
      setPending(saved);
      if (saved !== reference) {
        await resolve(saved, false);
        return;
      }
      draft.current = data;
      await send(reference, data, true);
    });
  }

  return {
    pending, reading, busy, error, outcome,
    canRetry: draft.current !== null && outcome === 'unknown',
    submit, initialize, clearError: () => { if (!activeTask.current && !pending) setError(''); },
    retry: () => {
      const data = draft.current;
      if (pending && data && outcome === 'unknown') return perform(() => send(pending, data, false));
    },
    check: () => pending && perform(() => resolve(pending, false)),
    close: () => pending && perform(() => resolve(pending, true)),
    confirmReview: () => pending && outcome === 'review' && perform(async () => {
      if (await clear(pending)) setError('REVIEW_CONFIRMED');
    }),
  };
}
