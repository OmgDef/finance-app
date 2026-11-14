import { createHash } from 'node:crypto';
import type { Body, Result } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import { hasDatabaseError, one } from './db.ts';
import type { Tx } from './db.ts';
import { AccessError } from './errors.ts';

export type ActorRole = 'user' | 'admin';
export type WithCommandAccess = <T>(
  write: (tx: Tx, userId: string, now: number, actorId: string) => Promise<T>,
  reserve?: (tx: Tx, userId: string, actorId: string) => Promise<void>,
) => Promise<T>;
type CommandKey = Body<'commandStatus'>;
type CommittedCommand = Result<'closeCommand'>;
type CommandResult = CommittedCommand['result'];
type Command = CommandKey['command'];
type CommandOutcome<T> = { result: T | null; closed_target: string[] | null };

// Older servers compare this value to a SHA-256 hex digest and refuse a replay.
const closedFingerprint = 'closed';
const commandClosed = new AccessError(409, 'COMMAND_CLOSED');
const commandNeedsReview = new AccessError(409, 'COMMAND_REQUIRES_REVIEW');
const notFound = new AccessError(404, 'NOT_FOUND');

function commandScope(role: ActorRole, actorId: string, command: Command, key: string) {
  return sql`actor_role = ${role} AND actor_id = ${actorId} AND command = ${command} AND command_key = ${key}`;
}

async function reserveCommand(tx: Tx, role: ActorRole, actorId: string, command: Command, key: string, fingerprint: string) {
  await tx.execute(sql`INSERT INTO idempotency_keys (actor_role, actor_id, command, command_key, fingerprint)
    VALUES (${role}, ${actorId}, ${command}, ${key}, ${fingerprint})
    ON DUPLICATE KEY UPDATE command_key = idempotency_keys.command_key`);
}

export async function runCommand<T>(withAccess: WithCommandAccess, command: Command, recoveryVersion: string,
  idempotencyKey: string, targets: string[], parameters: (string | null)[],
  execute: (tx: Tx, userId: string, now: number, apply: (write: () => Promise<T>) => Promise<T>, actorId: string) => Promise<T>,
  actorRole: ActorRole = 'user',
) {
  const fingerprint = (userId: string) => createHash('sha256')
    .update(JSON.stringify([userId, ...targets, ...parameters])).digest('hex');
  const reserve = (tx: Tx, userId: string, actorId: string) =>
    reserveCommand(tx, actorRole, actorId, command, idempotencyKey, fingerprint(userId));

  return retryFinanceWrite(() => withAccess((tx, userId, now, actorId) => execute(tx, userId, now, async (write) => {
    const scope = commandScope(actorRole, actorId, command, idempotencyKey);
    const key = await one<CommandOutcome<T> & { fingerprint: string }>(tx,
      sql`SELECT fingerprint, result, closed_target FROM idempotency_keys WHERE ${scope}`);
    if (!key) throw new Error('Missing reserved command key');
    if (key.closed_target) {
      if (!sameTarget(key.closed_target, [userId, ...targets])) throw notFound;
      throw commandClosed;
    }
    if (key.fingerprint !== fingerprint(userId)) throw new AccessError(409, 'IDEMPOTENCY_CONFLICT');
    if (key.result !== null) return key.result;
    if (idempotencyKey.split('.')[0] !== recoveryVersion) throw commandNeedsReview;
    const result = await write();
    await tx.execute(sql`UPDATE idempotency_keys SET result = ${JSON.stringify(result)} WHERE ${scope}`);
    return result;
  }, actorId), reserve));
}

function commandTarget(input: CommandKey): string[] {
  if (input.command === 'schedule.skip') return [input.ruleId, input.date];
  if (input.command === 'schedule.replace') return [input.ruleId, input.accountId];
  if ('transactionId' in input) return [input.transactionId];
  if ('fromAccountId' in input) return [input.fromAccountId, input.toAccountId];
  if ('accountId' in input) return [input.accountId];
  return [];
}

function resultTarget(command: Command, result: CommandResult): string[] {
  if (command === 'account.create') return [];
  if ('occurrenceId' in result) return [result.ruleId, result.date];
  if ('replacementRule' in result) return [result.ruleId, result.accountId];
  if ('fromAccount' in result) return [result.fromAccount.accountId, result.toAccount.accountId];
  if ('accountId' in result) return [result.accountId];
  return [result.transactionId];
}

function sameTarget(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function readOutcome(tx: Tx, owner: string, actorId: string, role: ActorRole, input: CommandKey,
  recoveryVersion: string,
): Promise<CommittedCommand | undefined> {
  if (input.userId !== owner) throw notFound;
  const targets = commandTarget(input);
  if ('ruleId' in input) {
    if (!await one(tx, sql`SELECT r.id FROM schedule_rules r JOIN accounts a ON a.id = r.account_id
      WHERE r.id = ${input.ruleId} AND a.user_id = ${owner}`)) throw notFound;
  }
  if (input.command === 'schedule.replace') {
    if (!await one(tx, sql`SELECT id FROM accounts WHERE id = ${input.accountId} AND user_id = ${owner}`)) throw notFound;
  } else if (input.command !== 'schedule.skip') {
    const table = 'transactionId' in input ? 'transactions' : 'accounts';
    for (const id of new Set(targets)) {
      if (!await one(tx, sql`SELECT id FROM ${sql.identifier(table)} WHERE id = ${id} AND user_id = ${owner}`)) throw notFound;
    }
  }

  const scope = commandScope(role, actorId, input.command, input.idempotencyKey);
  const key = await one<CommandOutcome<CommandResult>>(tx, sql`SELECT result, closed_target FROM idempotency_keys WHERE ${scope}`);
  if (key?.closed_target) {
    if (!sameTarget(key.closed_target, [owner, ...targets])) throw notFound;
    throw commandClosed;
  }
  if (key?.result) {
    if (!sameTarget(resultTarget(input.command, key.result), targets)) throw notFound;
    if (input.command === 'account.create' && 'accountId' in key.result &&
        !await one(tx, sql`SELECT id FROM accounts WHERE id = ${key.result.accountId} AND user_id = ${owner}`)) throw notFound;
    return { state: 'committed', result: key.result };
  }
  if (input.idempotencyKey.split('.')[0] !== recoveryVersion) throw commandNeedsReview;
}

export function checkCommandStatus(withAccess: WithCommandAccess, input: CommandKey, recoveryVersion: string,
  actorRole: ActorRole = 'user',
): Promise<Result<'commandStatus'>> {
  return retryFinanceWrite(() => withAccess(async (tx, owner, _now, actorId) =>
    await readOutcome(tx, owner, actorId, actorRole, input, recoveryVersion) ?? { state: 'unknown' }));
}

export async function closeCommand(withAccess: WithCommandAccess, input: CommandKey, recoveryVersion: string,
  actorRole: ActorRole = 'user',
): Promise<CommittedCommand> {
  const result = await retryFinanceWrite(() => withAccess(async (tx, owner, _now, actorId) => {
    const outcome = await readOutcome(tx, owner, actorId, actorRole, input, recoveryVersion);
    if (outcome) return outcome;
    const scope = commandScope(actorRole, actorId, input.command, input.idempotencyKey);
    const target = JSON.stringify([owner, ...commandTarget(input)]);
    await tx.execute(sql`UPDATE idempotency_keys SET fingerprint = ${closedFingerprint}, closed_target = ${target} WHERE ${scope}`);
  }, (tx, _owner, actorId) =>
    reserveCommand(tx, actorRole, actorId, input.command, input.idempotencyKey, closedFingerprint)));
  if (!result) throw commandClosed;
  return result;
}

export async function retryFinanceWrite<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!hasDatabaseError(error, 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT')) throw error;
      if (attempt === 2) throw new AccessError(503, 'TEMPORARY_FAILURE');
    }
  }
}
