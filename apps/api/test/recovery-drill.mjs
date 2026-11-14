import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { routes } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import { processScheduleDate } from '../src/finance.ts';
import { connect, one, rows } from '../src/db.ts';
import { token, totpAt } from '../src/crypto.ts';

const { DRILL_SOURCE_URL, DRILL_RESTORED_URL, DRILL_WORK_DIR, DRILL_BACKUP_DIR, DRILL_MYSQL_CNF,
  DRILL_CADDY = 'caddy', DRILL_KEY_FILE } = process.env;
const source = new URL(DRILL_SOURCE_URL);
const restored = new URL(DRILL_RESTORED_URL);
assert.equal(source.host, restored.host);
assert.equal(source.hostname, '127.0.0.1');
assert.match(source.pathname, /^\/teta_drill_source(?:_[a-z0-9]+)?$/);
assert.match(restored.pathname, /^\/teta_drill_restored(?:_[a-z0-9]+)?$/);
assert.ok(DRILL_WORK_DIR && DRILL_BACKUP_DIR && DRILL_MYSQL_CNF && DRILL_KEY_FILE);
const sourceSchema = source.pathname.slice(1);
const restoredSchema = restored.pathname.slice(1);
const node = process.execPath;
const apiOrigin = 'https://127.0.0.1:18843';
const adminOrigin = 'https://127.0.0.1:18844';
const accessEnv = { ACCESS_KEY: token(), TOTP_KEY: token(), API_ORIGIN: apiOrigin, ADMIN_ORIGIN: adminOrigin,
  API_BIND_HOST: '127.0.0.1', API_PORT: '31886', PROXY_IP: '127.0.0.1' };
const appEnv = (database, version) => ({ ...process.env, ...accessEnv, DATABASE_URL: database.href, RECOVERY_VERSION: version });
const proc = new Set();
const pin = '2837';
const key = (version = '1') => `${version}.${token()}`;
let ca;
let lastCheck = 'initializing';

function run(program, args, { env, input, fail = false } = {}) {
  const result = spawnSync(program, args, { env, input, encoding: 'utf8', timeout: 45_000 });
  if (result.error) throw new Error(`${program} failed to execute`, { cause: result.error });
  if (fail) {
    assert.ok(result.status > 0, `${program} should exit unsuccessfully`);
    return result.stderr;
  }
  assert.equal(result.status, 0, `${program} ${args[0]} failed`);
  return result.stdout.trim();
}

function start(program, args, env) {
  const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.add(child);
  child.once('exit', () => proc.delete(child));
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function waitFor(probe, child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(child.exitCode, null, 'Process exited before readiness');
    assert.equal(child.signalCode, null, 'Process stopped before readiness');
    try { const result = await probe(); if (result) return result; } catch { /* still starting */ }
    await setTimeout(50);
  }
  throw new Error('Local readiness timed out');
}

function send(name, body, { cookie, csrf, session, params, query } = {}) {
  const route = routes[name];
  const admin = route.url.includes('/admin/');
  const origin = admin ? adminOrigin : apiOrigin;
  const path = route.url.replace(/:([^/]+)/g, (_, part) => encodeURIComponent(params?.[part] ?? ''));
  const url = origin + path + (query ? '?' + new URLSearchParams(query) : '');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    ...(admin && { origin }), ...(cookie && { cookie }), ...(csrf && { 'x-csrf-token': csrf }),
    ...(session && { authorization: `Bearer ${session}` }),
    ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
  };
  return new Promise((resolveResponse, reject) => {
    const req = request(url, { method: route.method, headers, ca, timeout: 3_000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try { resolveResponse({ status: response.statusCode, data: JSON.parse(text),
          cookie: response.headers['set-cookie']?.[0]?.split(';')[0] }); }
        catch { resolveResponse({ status: response.statusCode }); }
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('HTTPS request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function expect(name, body, options, status = 200, code) {
  const result = await send(name, body, options);
  assert.equal(result.status, status, `${name} status (${result.data?.code ?? 'no error code'})`);
  if (code) assert.equal(result.data?.code, code, name);
  return result;
}

function totp(secret, age = 0) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = Array.from(secret, (char) => chars.indexOf(char).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
  return totpAt(seed, Math.floor(Date.now() / 30_000) - age);
}

function credentials(name, database, version) {
  const login = `${name}@example.test`;
  const password = token();
  const recoverySecret = run(node, ['apps/api/src/operator.ts', login], { env: appEnv(database, version), input: password });
  return { login, password, recoverySecret };
}

const passwordStep = ({ login, password }) => expect('password', { login, password });
async function setupStep(account) { return expect('recovery', account); }
async function enroll(account) {
  const { data, cookie } = await setupStep(account);
  await expect('setup', { step: data.step, code: totp(data.totpSecret, 1) }, { cookie });
  return { login: account.login, password: account.password, seed: data.totpSecret };
}
async function login(account) {
  const { data, cookie } = await passwordStep(account);
  const result = await expect('totp', { step: data.step, code: totp(account.seed) }, { cookie });
  return { cookie: result.cookie, csrf: result.data.csrf };
}

async function newUser(admin, name, activate) {
  const email = `${name}@example.test`;
  const { data: { id } } = await expect('createUser', { email }, admin);
  const { data: { code } } = await expect('issue', { userId: id }, admin);
  const installationSecret = token();
  const activation = { email, code, pin, installationSecret };
  const session = activate ? (await expect('activate', activation)).data.token : undefined;
  return { id, email, session, activation };
}

const ledgerTables = ['accounts', 'movements', 'transactions', 'transaction_versions', 'balance_adjustments',
  'schedule_rules', 'schedule_rule_versions', 'schedule_occurrences', 'schedule_date_failures', 'idempotency_keys'];
async function inventory(db, tables) {
  const contents = {};
  for (const name of tables) {
    const results = await rows(db, sql`SELECT * FROM ${sql.identifier(name)}`);
    contents[name] = results.map((row) => {
      const { recovery_held, ...fields } = row;
      return JSON.stringify(fields);
    }).sort();
  }
  return contents;
}

const count = async (db, table) => (await one(db, sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)}`)).count;
const occurrence = (db, ruleId) => one(db, sql`SELECT transaction_id AS transactionId FROM schedule_occurrences WHERE rule_id = ${ruleId}`);
const worker = (db) => one(db, sql`SELECT last_success_at AS lastSuccess FROM schedule_worker_state WHERE id = 1`);
const backup = (...args) => run('bash', ['infra/recovery-backup.sh', ...args]);
function review(database, ...args) {
  const reason = args.pop();
  return run(node, ['apps/api/src/recovery-operator.ts', args[0], restoredSchema, ...args.slice(1)],
    { env: appEnv(database, '2'), input: reason });
}
async function openApi(database, version) {
  const child = start(node, ['apps/api/src/server.ts'], appEnv(database, version));
  await waitFor(async () => (await send('health')).status === 200, child);
  return child;
}

async function voidTransaction(admin, userId, transactionId, version, reason) {
  const options = { ...admin, params: { userId, transactionId } };
  const { data: preview } = await expect('adminPreviewTransactionVoid', {}, options);
  const result = await expect('adminVoidTransaction', { idempotencyKey: key(version),
    expectedTransactionVersion: preview.transactionVersion, reason,
    expectedAccounts: preview.accounts.map(({ accountId, accountVersion }) => ({ accountId, accountVersion })) }, options);
  assert.equal(result.data.status, 'void');
  return result.data;
}

const original = connect(source.href);
const target = connect(restored.href);
try {
  for (const { db } of [original, target]) {
    const { total } = await one(db, sql`SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = DATABASE()`);
    assert.equal(total, 0, 'Use new empty drill schemas');
  }
  assert.notEqual(resolve(DRILL_WORK_DIR), resolve(DRILL_BACKUP_DIR));
  await mkdir(DRILL_WORK_DIR, { mode: 0o700 });
  await mkdir(DRILL_BACKUP_DIR, { mode: 0o700 });
  const startedAt = performance.now();
  run(node, ['apps/api/src/migrate.ts'], { env: appEnv(source, '1') });
  const gateway = start(DRILL_CADDY, ['run', '--config', 'infra/Caddyfile', '--adapter', 'caddyfile'], {
    ...process.env, TETA_BIND_IP: '127.0.0.1', TETA_LISTEN_IP: '127.0.0.1', TETA_API_PORT: '18843', TETA_ADMIN_PORT: '18844',
    TETA_UPSTREAM: '127.0.0.1:31886', XDG_CONFIG_HOME: resolve(DRILL_WORK_DIR, 'gateway-config'),
    XDG_DATA_HOME: resolve(DRILL_WORK_DIR, 'gateway-data'),
  });
  ca = await waitFor(() => readFile(resolve(DRILL_WORK_DIR, 'gateway-data/caddy/pki/authorities/local/root.crt')), gateway);
  const originalApi = await openApi(source, '1');

  lastCheck = 'source access and ledger setup';
  const operator = await enroll(credentials('recovery-operator', source, '1'));
  const pending = await enroll(credentials('pending-login', source, '1'));
  const pendingStep = await passwordStep(pending);
  const setupAccount = credentials('pending-setup', source, '1');
  const openSetup = await setupStep(setupAccount);
  const excluded = await enroll(credentials('excluded', source, '1'));
  await login(excluded);
  const admin = await login(operator);
  const blocked = await newUser(admin, 'blocked-after-snapshot', true);
  const active = await newUser(admin, 'revoked-after-snapshot', true);
  const unknown = await newUser(admin, 'no-review-evidence', false);
  const unknownForActive = (await expect('issue', { userId: active.id }, admin)).data.code;
  const biometricSecret = token();
  await expect('enableBiometrics', { installationSecret: active.activation.installationSecret, biometricSecret },
    { session: active.session });
  // Backdate only the schedule fixtures so a worker can post their synthetic dates immediately.
  const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const accountOf = async (user, name) => (await expect('createAccount', { name, currency: 'EUR', startDate: date,
    openingBalanceMinor: '100000', idempotencyKey: key() }, { session: user.session })).data.accountId;
  const accountId = await accountOf(active, 'Recovered account');
  const flaggedAccount = await accountOf(active, 'Statement reconciliation');
  const blockedAccount = await accountOf(blocked, 'Blocked owner account');
  const { db } = original;
  const makeRule = async (owner, accountId) => {
    const ruleId = randomUUID();
    const createdAt = Date.parse(date + 'T00:00:00Z') - 86_400_000;
    await db.execute(sql`INSERT INTO schedule_rules (id, account_id, kind, frequency, first_date, created_at)
      VALUES (${ruleId}, ${accountId}, 'expense', 'once', ${date}, ${createdAt})`);
    await db.execute(sql`INSERT INTO schedule_rule_versions (rule_id, version, accepted_at, effective_at, amount_minor, category_id)
      VALUES (${ruleId}, 1, ${createdAt}, ${createdAt}, 1000, 'groceries')`);
    return { userId: owner.id, accountId, ruleId, date };
  };
  const known = await makeRule(active, accountId);
  const uncertain = await makeRule(active, accountId);
  const verified = await makeRule(blocked, blockedAccount);
  const held = await makeRule(active, accountId);
  const postedUnverified = await makeRule(active, flaggedAccount);
  const scheduled = await processScheduleDate(db, known);
  assert.equal(scheduled.status, 'posted');
  assert.equal((await processScheduleDate(db, postedUnverified)).status, 'posted');
  const expense = { type: 'expense', date, amountMinor: '2500', categoryId: 'groceries', accountId, idempotencyKey: key() };
  const keptResult = (await expect('recordTransaction', expense, { session: active.session })).data;
  const lostExpense = { ...expense, amountMinor: '3000', idempotencyKey: key() };
  const command = (idempotencyKey) => ({ idempotencyKey, command: 'expense.record', accountId, userId: active.id });
  const closedKey = key();
  await expect('closeCommand', command(closedKey), { session: active.session }, 409, 'COMMAND_CLOSED');
  const { data: baselineBalance } = await expect('getAccountBalance', undefined, { params: { accountId }, session: active.session });
  assert.equal(baselineBalance.balanceMinor, '96500');
  const baseline = await inventory(db, [...ledgerTables, 'audit_events', '__drizzle_migrations']);

  lastCheck = 'encrypted backup and post-snapshot changes';
  const staging = resolve(DRILL_WORK_DIR, 'backup.gpg');
  const archive = resolve(DRILL_BACKUP_DIR, 'backup.gpg');
  const input = resolve(DRILL_WORK_DIR, 'restore.gpg');
  const snapshotAt = backup('dump', DRILL_MYSQL_CNF, sourceSchema, DRILL_KEY_FILE, staging);
  for (const suffix of ['', '.sha256']) {
    await copyFile(staging + suffix, archive + suffix);
    await chmod(archive + suffix, 0o600);
  }
  await expect('setStatus', { userId: blocked.id, status: 'blocked' }, admin);
  await expect('revoke', { userId: active.id }, admin);
  await voidTransaction(admin, active.id, scheduled.transactionId, '1', 'Synthetic payment cancellation');
  const newCode = (await expect('issue', { userId: active.id }, admin)).data.code;
  const sourceActive = (await expect('activate', { ...active.activation, code: newCode, installationSecret: token() })).data;
  await expect('recordTransaction', lostExpense, { session: sourceActive.token });
  const incidentAt = new Date().toISOString();
  await stop(originalApi);

  lastCheck = 'verified restore in an empty schema';
  for (const suffix of ['', '.sha256']) await copyFile(archive + suffix, input + suffix);
  const correctChecksum = await readFile(input + '.sha256');
  await writeFile(input + '.sha256', '0'.repeat(64) + '\n');
  run('bash', ['infra/recovery-backup.sh', 'restore', DRILL_MYSQL_CNF, restoredSchema, DRILL_KEY_FILE, input], { fail: true });
  await writeFile(input + '.sha256', correctChecksum);
  const wrongKey = resolve(DRILL_WORK_DIR, 'wrong.passphrase');
  await writeFile(wrongKey, token() + '\n', { mode: 0o600 });
  run('bash', ['infra/recovery-backup.sh', 'restore', DRILL_MYSQL_CNF, restoredSchema, wrongKey, input], { fail: true });
  const emptyTarget = await one(target.db, sql`SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = DATABASE()`);
  assert.equal(emptyTarget.total, 0);
  backup('restore', DRILL_MYSQL_CNF, restoredSchema, DRILL_KEY_FILE, input);
  assert.deepEqual(await inventory(target.db, [...ledgerTables, 'audit_events', '__drizzle_migrations']), baseline);
  const restoredAt = Date.now();

  lastCheck = 'pre-open access and version transaction';
  const allowlist = resolve(DRILL_WORK_DIR, 'allowlist.txt');
  await writeFile(allowlist, `${operator.login}\n${pending.login}\nmissing@example.test\n`, { mode: 0o600 });
  const prepare = ['apps/api/src/recovery-operator.ts', 'prepare', restoredSchema, snapshotAt, incidentAt, allowlist];
  run(node, prepare, { env: appEnv(restored, '2'), fail: true });
  assert.equal(await count(target.db, 'recovery_state'), 0);
  assert.deepEqual(await inventory(target.db, [...ledgerTables, 'audit_events']), Object.fromEntries(
    [...ledgerTables, 'audit_events'].map((name) => [name, baseline[name]])));
  await writeFile(allowlist, `${operator.login}\n${pending.login}\n${setupAccount.login}\n`);
  run(node, prepare, { env: appEnv(restored, '2') });
  assert.equal(await count(target.db, 'recovery_state'), 1);
  assert.deepEqual(await inventory(target.db, ledgerTables), Object.fromEntries(ledgerTables.map((name) => [name, baseline[name]])));
  assert.equal((await one(target.db, sql`SELECT COUNT(*) AS total FROM admin_steps WHERE spent = FALSE OR pending_totp_cipher IS NOT NULL`)).total, 0);
  assert.equal((await one(target.db, sql`SELECT COUNT(*) AS total FROM admin_users WHERE recovery_verifier IS NOT NULL`)).total, 0);
  for (const entry of ['server.ts', 'worker.ts']) {
    const failure = run(node, [`apps/api/src/${entry}`], { env: appEnv(restored, '1'), fail: true });
    assert.match(failure, /RECOVERY_VERSION does not match the database/);
  }
  run(node, prepare, { env: appEnv(restored, '2'), fail: true });
  const restoredApi = await openApi(restored, '2');
  const healthAt = Date.now();
  await expect('adminMe', undefined, admin, 401, 'ADMIN_AUTH_INVALID');
  await expect('totp', { step: pendingStep.data.step, code: totp(pending.seed) }, pendingStep, 401, 'ADMIN_AUTH_INVALID');
  await expect('setup', { step: openSetup.data.step, code: totp(openSetup.data.totpSecret) }, openSetup, 401, 'ADMIN_AUTH_INVALID');
  await expect('password', { login: excluded.login, password: excluded.password }, undefined, 401, 'ADMIN_AUTH_INVALID');
  for (const user of [active, blocked]) {
    await expect('me', undefined, { session: user.session }, 403, 'DEVICE_REVOKED');
    await expect('unlock', { installationSecret: user.activation.installationSecret, pin }, undefined, 403, 'DEVICE_REVOKED');
  }
  await expect('unlock', { installationSecret: active.activation.installationSecret, biometricSecret }, undefined, 403, 'DEVICE_REVOKED');
  await expect('activate', unknown.activation, undefined, 401, 'ACTIVATION_INVALID');

  lastCheck = 'evidence-based access review, command replay and lost commands';
  const afterReset = await enroll(credentials('recovery-operator', restored, '2'));
  const confirmed = await login(afterReset);
  const users = (await expect('listUsers', undefined, confirmed)).data.users;
  assert.equal(users.length, 3);
  assert.ok(users.every(({ status, deviceActive }) => status === 'review' && !deviceActive));
  await expect('issue', { userId: active.id }, confirmed, 409, 'ACCOUNT_UNAVAILABLE');
  await expect('activate', { ...active.activation, code: unknownForActive }, undefined, 401, 'ACTIVATION_INVALID');
  const evidence = { source: 'post_snapshot_records' };
  await expect('adminReviewRecoveredUser', { ...evidence, status: 'blocked', reason: 'Verified block recorded after snapshot' },
    { ...confirmed, params: { userId: blocked.id } });
  await expect('adminReviewRecoveredUser', { ...evidence, status: 'active', reason: 'Verified owner and device revocation' },
    { ...confirmed, params: { userId: active.id } });
  for (const user of [unknown, blocked]) await expect('issue', { userId: user.id }, confirmed, 409, 'ACCOUNT_UNAVAILABLE');
  await expect('activate', { ...active.activation, code: unknownForActive }, undefined, 401, 'ACTIVATION_INVALID');
  const replacement = (await expect('issue', { userId: active.id }, confirmed)).data.code;
  const installationSecret = token();
  await expect('activate', { email: active.email, code: replacement, installationSecret, pin });
  const { data: mobile } = await expect('unlock', { installationSecret, pin });
  assert.equal(mobile.recoveryVersion, '2');
  const current = { session: mobile.token };
  assert.equal((await expect('me', undefined, current)).data.recoveryVersion, '2');
  const accessAt = Date.now();
  assert.deepEqual((await expect('getAccountBalance', undefined, { ...current, params: { accountId } })).data, baselineBalance);
  const beforeRetry = await count(target.db, 'movements');
  const beforeKeys = await count(target.db, 'idempotency_keys');
  for (const route of ['commandStatus', 'closeCommand']) {
    await expect(route, command(lostExpense.idempotencyKey), current, 409, 'COMMAND_REQUIRES_REVIEW');
    await expect(route, command(closedKey), current, 409, 'COMMAND_CLOSED');
    assert.deepEqual((await expect(route, command(expense.idempotencyKey), current)).data, { state: 'committed', result: keptResult });
  }
  await expect('recordTransaction', lostExpense, current, 409, 'COMMAND_REQUIRES_REVIEW');
  assert.deepEqual((await expect('recordTransaction', expense, current)).data, keptResult);
  assert.equal(await count(target.db, 'movements'), beforeRetry);
  assert.equal(await count(target.db, 'idempotency_keys'), beforeKeys);

  lastCheck = 'manual recovery decisions and real worker startup';
  const restoredVoid = await voidTransaction(confirmed, active.id, scheduled.transactionId, '2', 'Confirmed post-snapshot cancellation');
  const versions = (await expect('listTransactionVersions', undefined,
    { ...current, params: { transactionId: scheduled.transactionId } })).data.versions;
  assert.equal(restoredVoid.transactionVersion, 2);
  assert.ok(versions.some(({ status, actorRole, reason }) => status === 'void' && actorRole === 'admin' && reason === 'Confirmed post-snapshot cancellation'));
  assert.equal(await count(target.db, 'movements'), beforeRetry);
  review(restored, 'flag-account', flaggedAccount, 'Synthetic later transaction requires checking against statement');
  review(restored, 'flag-date', uncertain.ruleId, date, 'Outcome missing in independent synthetic evidence');
  const readDate = async (ruleId) => (await expect('listScheduleOccurrences', undefined, { ...current,
    query: { ruleId, fromDate: date, throughDate: date } })).data.occurrences[0];
  assert.equal((await readDate(held.ruleId)).recoveryHeld, true);
  assert.equal((await readDate(uncertain.ruleId)).status, 'needs_intervention');
  assert.equal((await readDate(uncertain.ruleId)).errorCode, 'RECOVERY_UNCERTAIN');
  await expect('skipScheduleOccurrence', { idempotencyKey: key('2'), reason: 'Synthetic owner skip while held' },
    { ...current, params: { ruleId: held.ruleId, date } }, 409, 'SCHEDULE_DATE_CONFLICT');
  for (const [rule, reason] of [[known, 'Known cancellation restored'], [uncertain, 'Confirmed parameters, keep date for operator'],
    [verified, 'Confirmed payable date and rule']]) review(restored, 'release-rule', rule.ruleId, reason);
  const workerProcess = start(node, ['apps/api/src/worker.ts'], appEnv(restored, '2'));
  await waitFor(async () => (await worker(target.db))?.lastSuccess, workerProcess);
  assert.ok((await occurrence(target.db, verified.ruleId))?.transactionId);
  const resumedAt = Date.now();
  assert.equal((await occurrence(target.db, known.ruleId))?.transactionId, scheduled.transactionId);
  assert.equal(await occurrence(target.db, held.ruleId), undefined);
  assert.equal(await occurrence(target.db, uncertain.ruleId), undefined);
  assert.equal((await readDate(uncertain.ruleId)).status, 'needs_intervention');
  await expect('skipScheduleOccurrence', { idempotencyKey: key('2'), reason: 'Synthetic owner skip after rule release' },
    { ...current, params: { ruleId: uncertain.ruleId, date } }, 409, 'SCHEDULE_DATE_CONFLICT');
  assert.equal(await count(target.db, 'movements'), beforeRetry + 1);
  const userStatus = (await expect('listUsers', undefined, confirmed)).data.users;
  assert.deepEqual(Object.fromEntries(userStatus.map(({ id, status }) => [id, status])),
    { [blocked.id]: 'blocked', [active.id]: 'active', [unknown.id]: 'review' });
  assert.equal((await one(target.db, sql`SELECT needs_reconciliation AS marked FROM accounts WHERE id = ${flaggedAccount}`)).marked, 1);
  const { data: { events } } = await expect('adminListAudit', undefined, confirmed);
  for (const event of ['recovery.prepared', 'admin.recovery_disabled', 'account.recovery_pending', 'account.recovery_reviewed',
    'finance.account.recovery_flagged', 'schedule.recovery_released', 'schedule.occurrence.needs_intervention']) {
    assert.ok(events.some((entry) => entry.event === event), `Audit entry ${event}`);
  }
  await stop(workerProcess);
  await stop(restoredApi);
  const incident = Date.parse(incidentAt);
  console.log(JSON.stringify({ result: 'PASS', snapshotAt, incidentAt, restoredAt: new Date(restoredAt).toISOString(),
    apiReadyAt: new Date(healthAt).toISOString(), accessVerifiedAt: new Date(accessAt).toISOString(),
    scheduleResumedAt: new Date(resumedAt).toISOString(), rpoMs: incident - Date.parse(snapshotAt),
    restoreMs: restoredAt - incident, rtoMs: resumedAt - incident, elapsedMs: Math.round(performance.now() - startedAt),
    snapshotMovements: beforeRetry, finalMovements: await count(target.db, 'movements'), matchingTables: Object.keys(baseline).length }));
} catch (error) {
  // Driver diagnostics can include connection material and the contents of rows.
  const message = error?.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'Inspect the failed rehearsal step in the isolated VM';
  console.error(`FAIL ${lastCheck}: ${message}`);
  process.exitCode = 1;
} finally {
  await Promise.all([...proc].map(stop));
  await Promise.all([original.pool.end(), target.pool.end()]);
}
