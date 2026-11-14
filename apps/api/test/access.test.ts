import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { routes } from '@teta/contracts';
import type { Body, Result, Route } from '@teta/contracts';
import { configureAdmin } from '../src/admin.ts';
import { buildApp } from '../src/app.ts';
import { configFromEnv } from '../src/config.ts';
import { token, totpAt, verifier } from '../src/crypto.ts';
import { connect, one } from '../src/db.ts';
import { minute } from '../src/rates.ts';

test('RFC 6238 SHA-1 reference vectors', () => {
  const seed = Buffer.from('12345678901234567890');
  assert.equal(totpAt(seed, Math.floor(59 / 30), 8), '94287082');
  assert.equal(totpAt(seed, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(totpAt(seed, Math.floor(20000000000 / 30), 8), '65353130');
});

test('Access API against migrated MySQL', async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL to a dedicated, migrated synthetic database');
  const connection = connect(databaseUrl);
  const { db } = connection;
  t.after(() => connection.pool.end());
  const env = {
    DATABASE_URL: databaseUrl, API_ORIGIN: 'https://192.0.2.2:18443', ADMIN_ORIGIN: 'https://192.0.2.2:18444',
    ACCESS_KEY: randomBytes(32).toString('hex'), TOTP_KEY: randomBytes(32).toString('hex'), PROXY_IP: '192.0.2.1',
  };
  assert.throws(() => configFromEnv({ ...env, ADMIN_ORIGIN: env.API_ORIGIN }), /separate API and admin origins/);
  const config = configFromEnv(env);
  let now = Date.now();
  let app = buildApp(config, db, () => now);
  t.after(async () => app.close());
  const password = token();
  const login = randomUUID() + '@example.test';
  let recoverySecret = await configureAdmin(db, config.accessKey, login, password, () => now);
  let browser = '';
  let adminCookie = '';
  let csrf = '';
  let seed: Buffer;
  let ipSequence = 2;
  const newIp = () => '198.51.100.' + ipSequence++;

  async function send<K extends Route>(
    name: K, body?: Body<K>, options: {
      host?: string; origin?: string; csrf?: string; cookie?: string; token?: string;
      ip?: string; query?: string; forwarded?: string; connection?: string; protocol?: string; params?: Record<string, string>;
      target?: typeof app;
    } = {},
  ) {
    const route = routes[name];
    const isAdmin = route.url.includes('/admin/');
    const headers: Record<string, string> = {
      host: options.host ?? new URL(isAdmin ? config.adminOrigin : config.apiOrigin).host,
      'x-forwarded-proto': options.protocol ?? 'https',
      'x-forwarded-for': options.forwarded ?? options.ip ?? '198.51.100.1',
      ...(isAdmin && { origin: options.origin ?? config.adminOrigin }),
    };
    const cookies = options.cookie ?? [browser, adminCookie].filter(Boolean).join('; ');
    if (cookies) headers.cookie = cookies;
    if (options.token) headers.authorization = 'Bearer ' + options.token;
    const csrfHeader = options.csrf ?? csrf;
    if (csrfHeader) headers['x-csrf-token'] = csrfHeader;
    const path = route.url.replace(/:([^/]+)/g, (_, name: string) => encodeURIComponent(options.params?.[name] ?? ''));
    const response = await (options.target ?? app).inject({
      method: route.method, url: path + (options.query ?? ''), headers,
      payload: body, remoteAddress: options.connection ?? '192.0.2.1',
    });
    return {
      status: response.statusCode, response,
      data: () => response.json<Result<K>>(),
      error: () => response.json<{ code: string; requestId: string; retryAfter?: number }>(),
      cookie: () => String(response.headers['set-cookie']).split(';')[0],
    };
  }

  function expect(result: Awaited<ReturnType<typeof send>>, status: number, code?: string) {
    assert.equal(result.status, status, result.status === 200 ? 'Unexpected success' : JSON.stringify(result.error()));
    if (code) {
      assert.equal(result.error().code, code);
      assert.ok(result.error().requestId);
    }
  }

  const wrong = (key: Buffer, now: number) => {
    const current = Math.floor(now / 30_000);
    return ['000000', '000001', '000002'].find((code) =>
      code !== totpAt(key, current) && code !== totpAt(key, current - 1))!;
  };
  const codeNow = () => totpAt(seed, Math.floor(now / 30_000));

  async function setupAdmin() {
    const started = await send('recovery', { login, password, recoverySecret });
    expect(started, 200);
    browser = started.cookie();
    const data = started.data();
    seed = decodeBase32(data.totpSecret);
    expect(await send('setup', { step: data.step, code: codeNow() }), 200);
    expect(await send('setup', { step: data.step, code: codeNow() }), 401, 'ADMIN_AUTH_INVALID');
    now += 30_000;
  }

  async function adminLogin() {
    const passwordResult = await send('password', { login, password }, { ip: newIp() });
    expect(passwordResult, 200);
    browser = passwordResult.cookie();
    const result = await send('totp', { step: passwordResult.data().step, code: codeNow() }, { ip: newIp() });
    expect(result, 200);
    adminCookie = result.cookie();
    csrf = result.data().csrf;
    assert.match(String(result.response.headers['set-cookie']), /^__Host-teta-admin=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
  }

  await t.test('Public support returns published localized fields and works without a token', async () => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO faq_entries (id, position, published, question_en, answer_en, question_ru, answer_ru) VALUES
      (${id}, 1, TRUE, 'Question', 'Answer', 'Вопрос', 'Ответ'),
      (${id + '-hidden'}, 2, FALSE, 'Private', 'Private', 'Скрыто', 'Скрыто')`);
    try {
      const initial = await send('support', undefined, { cookie: '' });
      expect(initial, 200);
      const starterIds = ['access', 'pin-or-phone', 'record-expense', 'currency-transfer',
        'deposit-interest', 'monthly-salary', 'negative-balance', 'contact-support'];
      assert.deepEqual(initial.data().faq.filter((item) => starterIds.includes(item.id)).map(({ id }) => id), starterIds);
      const publicSupport = await send('support', undefined, { query: '?lang=ru' });
      expect(publicSupport, 200);
      assert.equal(publicSupport.data().faq.find((item) => item.id === id)?.question, 'Вопрос');
      assert.ok(!publicSupport.data().faq.some((item) => item.id === id + '-hidden'));
      const english = await send('support');
      expect(english, 200);
      assert.equal(english.data().faq.find((item) => item.id === id)?.answer, 'Answer');
      assert.equal(publicSupport.response.headers['cache-control'], 'no-store');
      expect(await send('support', undefined, { query: '?lang=de' }), 400, 'INVALID_REQUEST');
    } finally {
      await db.execute(sql`DELETE FROM faq_entries WHERE id IN (${id}, ${id + '-hidden'})`);
    }
  });

  await t.test('Recovery expiry, one-time use, browser binding, origin and TOTP replay under concurrency', async () => {
    now += 15 * minute;
    expect(await send('recovery', { login, password, recoverySecret }), 401, 'ADMIN_AUTH_INVALID');
    recoverySecret = await configureAdmin(db, config.accessKey, login, password, () => now);
    await setupAdmin();
    expect(await send('recovery', { login, password, recoverySecret }), 401, 'ADMIN_AUTH_INVALID');
    expect(await send('password', { login, password }, { origin: 'https://other.test' }), 403, 'CSRF_INVALID');
    const a = await send('password', { login, password }, { ip: newIp() });
    expect(a, 200);
    browser = a.cookie();
    const b = await send('password', { login, password }, { ip: newIp() });
    expect(b, 200);
    assert.equal(b.cookie(), browser);
    const step = a.data().step;
    expect(await send('totp', { step, code: codeNow() }, { cookie: '', ip: newIp() }), 401, 'ADMIN_AUTH_INVALID');
    const results = await Promise.all([step, b.data().step].map((step) => send('totp', { step, code: codeNow() }, { ip: newIp() })));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
    const count = await one<{ n: number }>(db, sql`SELECT COUNT(*) AS n FROM admin_sessions s JOIN admin_users a
      ON s.admin_id = a.id WHERE a.login = ${login}`);
    assert.equal(Number(count?.n), 1);
    const success = results.find((result) => result.status === 200)!;
    adminCookie = success.cookie();
    csrf = success.data().csrf;
    const older = await send('password', { login, password }, { ip: newIp() });
    expect(older, 200);
    expect(await send('totp', { step: older.data().step, code: totpAt(seed, Math.floor(now / 30_000) - 1) },
      { ip: newIp() }), 401, 'ADMIN_AUTH_INVALID');
  });

  await t.test('Separate HTTPS ports, administrative session and origin checks', async () => {
    const input = { email: randomUUID() + '@example.test' };
    expect(await send('createUser', input, { host: new URL(config.apiOrigin).host }), 404, 'NOT_FOUND');
    expect(await send('health', undefined, { host: new URL(config.adminOrigin).host }), 404, 'NOT_FOUND');
    expect(await send('createUser', input, { csrf: '' }), 403, 'CSRF_INVALID');
    expect(await send('createUser', input, { origin: config.apiOrigin }), 403, 'CSRF_INVALID');
    expect(await send('createUser', input, { origin: 'https://other.test' }), 403, 'CSRF_INVALID');
    expect(await send('createUser', input, { cookie: '', token: token() }), 401, 'ADMIN_AUTH_INVALID');
    expect(await send('health', undefined, { connection: '198.51.100.250' }), 404, 'NOT_FOUND');
    expect(await send('adminMe'), 200);
    expect(await send('adminLogout', {}, { csrf: '' }), 403, 'CSRF_INVALID');
  });

  await t.test('Support contacts use nullable versioned settings and audit only changes', async () => {
    const read = await send('adminGetSupport');
    expect(read, 200);
    const before = read.data().contacts;
    const write = { email: '  help@example.test  ', phone: '  +1 (202) 555-0140 ', expectedVersion: before.version };
    const stale = { ...write, email: 'other@example.test' };
    expect(await send('adminGetSupport', undefined, { cookie: '' }), 401, 'ADMIN_AUTH_INVALID');
    expect(await send('adminGetSupport', undefined, { host: new URL(config.apiOrigin).host }), 404, 'NOT_FOUND');
    expect(await send('adminUpdateSupportContacts', write, { csrf: '' }), 403, 'CSRF_INVALID');
    expect(await send('adminUpdateSupportContacts', write, { origin: config.apiOrigin }), 403, 'CSRF_INVALID');
    expect(await send('adminUpdateSupportContacts', { ...write, email: 'hi@example' }), 400, 'INVALID_REQUEST');
    expect(await send('adminUpdateSupportContacts', { ...write, phone: '123-456#789' }), 400, 'INVALID_REQUEST');
    try {
      const saved = await send('adminUpdateSupportContacts', write);
      expect(saved, 200);
      assert.deepEqual(saved.data(), { email: 'help@example.test', phone: '+1 (202) 555-0140', version: before.version + 1 });
      const visible = await send('support', undefined, { cookie: '' });
      expect(visible, 200);
      assert.equal(visible.data().email, saved.data().email);
      assert.equal(visible.data().phone, saved.data().phone);
      expect(await send('adminUpdateSupportContacts', stale), 409, 'VERSION_CONFLICT');

      const cleared = await send('adminUpdateSupportContacts', { email: '   ', phone: null, expectedVersion: saved.data().version });
      expect(cleared, 200);
      assert.deepEqual(cleared.data(), { email: null, phone: null, version: before.version + 2 });
      const noContacts = await send('support', undefined, { cookie: '' });
      expect(noContacts, 200);
      assert.equal(noContacts.data().email, null);
      assert.equal(noContacts.data().phone, null);
      const admin = await send('adminMe');
      const audit = await send('adminListAudit', undefined, {
        query: '?' + new URLSearchParams({ adminId: admin.data().id, event: 'support.contacts.updated' }),
      });
      expect(audit, 200);
      assert.deepEqual(audit.data().events.map(({ transition }) => transition), [
        { from: String(before.version + 1), to: String(before.version + 2) },
        { from: String(before.version), to: String(before.version + 1) },
      ]);
      assert.doesNotMatch(JSON.stringify(audit.data()), /help@example\.test|555-0140/);
    } finally {
      await db.execute(sql`UPDATE support_settings SET email = ${before.email}, phone = ${before.phone},
        version = ${before.version} WHERE id = 1`);
    }
  });

  await t.test('FAQ drafts, bilingual publication, order, stable IDs and conflicting edits', async () => {
    const draft = { position: 0, published: false, questionEn: 'English question', answerEn: 'English answer',
      questionRu: '', answerRu: '' };
    expect(await send('adminCreateFaq', { ...draft, published: true }), 400, 'INVALID_REQUEST');
    expect(await send('adminCreateFaq', draft, { csrf: '' }), 403, 'CSRF_INVALID');
    const created = await send('adminCreateFaq', draft);
    expect(created, 200);
    const { id } = created.data();
    const params = { faqId: id };
    try {
      const hidden = await send('support', undefined, { cookie: '' });
      assert.ok(!hidden.data().faq.some((entry) => entry.id === id));
      const published = { ...draft, expectedVersion: 1, published: true, questionRu: ' Вопрос ', answerRu: ' Ответ ' };
      const edited = await send('adminUpdateFaq', published, { params });
      expect(edited, 200);
      assert.equal(edited.data().id, id);
      assert.equal(edited.data().version, 2);
      const ru = await send('support', undefined, { cookie: '', query: '?lang=ru' });
      expect(ru, 200);
      assert.deepEqual(ru.data().faq[0], { id, question: 'Вопрос', answer: 'Ответ' });
      const en = await send('support', undefined, { cookie: '', query: '?lang=en' });
      expect(en, 200);
      assert.deepEqual(en.data().faq[0], { id, question: 'English question', answer: 'English answer' });

      const racing = { ...published, expectedVersion: 2, position: 1000 };
      const results = await Promise.all([racing, { ...racing, answerEn: 'New answer' }]
        .map((input) => send('adminUpdateFaq', input, { params })));
      assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
      const reordered = await send('support', undefined, { cookie: '' });
      assert.equal(reordered.data().faq.at(-1)?.id, id);
      expect(await send('adminUpdateFaq', { ...racing, expectedVersion: 3, answerEn: ' ' }, { params }), 400, 'INVALID_REQUEST');
      expect(await send('adminDeleteFaq', undefined, { params, query: '?expectedVersion=2' }), 409, 'VERSION_CONFLICT');
      expect(await send('adminDeleteFaq', undefined, { params, query: '?expectedVersion=3', csrf: '' }), 403, 'CSRF_INVALID');
      expect(await send('adminDeleteFaq', undefined, { params, query: '?expectedVersion=3' }), 200);
      assert.ok(!(await send('support', undefined, { cookie: '' })).data().faq.some((entry) => entry.id === id));
      expect(await send('adminDeleteFaq', undefined, { params, query: '?expectedVersion=3' }), 404, 'NOT_FOUND');
    } finally {
      await db.execute(sql`DELETE FROM faq_entries WHERE id = ${id}`);
    }
  });

  await t.test('Activation retry, transaction races, fixed limits, revocation, biometric and PIN lock', async () => {
    const email = randomUUID() + '@example.test';
    const created = await send('createUser', { email: ' ' + email.toUpperCase() + ' ' });
    expect(created, 200);
    const { id } = created.data();
    assert.equal(created.data().email, email);
    expect(await send('createUser', { email }), 409, 'EMAIL_EXISTS');
    const userParams = { userId: id };
    const byId = await send('adminGetUser', undefined, { params: userParams });
    expect(byId, 200);
    assert.deepEqual(byId.data(), created.data());
    expect(await send('adminGetUser', undefined, { params: userParams, cookie: '' }), 401, 'ADMIN_AUTH_INVALID');
    expect(await send('adminGetUser', undefined, { params: userParams, host: new URL(config.apiOrigin).host }), 404, 'NOT_FOUND');
    expect(await send('adminGetUser', undefined, { params: { userId: randomUUID() } }), 404, 'NOT_FOUND');
    const issue = async () => {
      const response = await send('issue', { userId: id });
      expect(response, 200);
      assert.match(response.data().code, /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/);
      return response.data().code;
    };
    const pin = '4932';
    const activate = (code: string, installationSecret = token(), ip = newIp()) =>
      send('activate', { email, code, pin, installationSecret }, { ip });
    const firstSecret = token();
    const first = await activate(await issue(), firstSecret);
    expect(first, 200);
    assert.equal((await send('adminGetUser', undefined, { params: userParams })).data().deviceActive, true);
    const oldSession = first.data().token;
    expect(await send('me', undefined, { token: oldSession }), 200);
    const replaced = await issue();
    const valid = await issue();
    expect(await activate(replaced), 401, 'ACTIVATION_INVALID');
    expect(await send('me', undefined, { token: oldSession }), 200);
    const ip = newIp();
    for (let i = 0; i < 5; i++) expect(await activate('AAAA-AAAA-AAAA-AAAA', token(), ip), 401, 'ACTIVATION_INVALID');
    const limited = await activate(valid, token(), ip);
    expect(limited, 429, 'RATE_LIMITED');
    assert.equal(limited.response.headers['retry-after'], '900');
    now += 14 * minute;
    const stillLimited = await activate(valid, token(), ip);
    expect(stillLimited, 429, 'RATE_LIMITED');
    assert.equal(stillLimited.error().retryAfter, 60);
    now += minute;

    const newSecret = token();
    const altSecret = token();
    const replacements = await Promise.all([activate(valid, newSecret, ip), activate(valid, altSecret)]);
    assert.deepEqual(replacements.map((result) => result.status).sort(), [200, 401]);
    const winner = replacements[0].status === 200 ? newSecret : altSecret;
    const loser = winner === newSecret ? altSecret : newSecret;
    // Simulate losing the committed activation response by authenticating with the stored installation secret.
    const second = await send('unlock', { installationSecret: winner, pin }, { ip: newIp() });
    expect(second, 200);
    expect(await send('unlock', { installationSecret: loser, pin }, { ip: newIp() }), 403, 'DEVICE_REVOKED');
    expect(await send('me', undefined, { token: oldSession }), 403, 'DEVICE_REVOKED');
    expect(await activate(valid), 401, 'ACTIVATION_INVALID');

    const enrollment = { token: second.data().token };
    expect(await send('enableBiometrics', { biometricSecret: token(), pin }, enrollment), 200);
    const biometricSecret = token();
    expect(await send('enableBiometrics', { installationSecret: winner, biometricSecret }), 401, 'SESSION_EXPIRED');
    expect(await send('enableBiometrics', { installationSecret: winner, biometricSecret }, enrollment), 200);
    expect(await send('enableBiometrics', { installationSecret: loser, biometricSecret: token() }, enrollment), 401, 'BIOMETRICS_INVALID');
    const bio = await send('unlock', { installationSecret: winner, biometricSecret });
    expect(bio, 200);
    expect(await send('me', undefined, { token: second.data().token }), 401, 'SESSION_EXPIRED');
    for (let i = 0; i < 5; i++) {
      expect(await send('unlock', { installationSecret: token(), pin }), 403, 'DEVICE_REVOKED');
    }
    for (let i = 0; i < 4; i++) {
      expect(await send('unlock', { installationSecret: winner, pin: '0000' }), 401, 'PIN_INVALID');
    }
    expect(await send('unlock', { installationSecret: winner, pin }), 200);
    for (let i = 0; i < 5; i++) {
      expect(await send('unlock', { installationSecret: winner, pin: '0000' }),
        i === 4 ? 403 : 401, i === 4 ? 'PIN_LOCKED' : 'PIN_INVALID');
    }
    expect(await send('unlock', { installationSecret: winner, biometricSecret }), 403, 'PIN_LOCKED');
    expect(await send('me', undefined, { token: bio.data().token }), 403, 'PIN_LOCKED');

    now += 30_000;
    await adminLogin();
    const logoutSession = await activate(await issue());
    expect(logoutSession, 200);
    expect(await send('logout', {}, { token: logoutSession.data().token }), 200);
    expect(await send('me', undefined, { token: logoutSession.data().token }), 403, 'DEVICE_REVOKED');
    const active = await activate(await issue());
    expect(active, 200);
    expect(await send('revoke', { userId: id }), 200);
    expect(await send('me', undefined, { token: active.data().token }), 403, 'DEVICE_REVOKED');
    const expired = await issue();
    now += 24 * 60 * minute;
    expect(await activate(expired), 401, 'ACTIVATION_INVALID');

    await adminLogin();
    const validWhileReview = await issue();
    await db.execute(sql`UPDATE users SET status = 'review' WHERE id = ${id}`);
    expect(await activate(validWhileReview), 401, 'ACTIVATION_INVALID');
    expect(await send('issue', { userId: id }), 409, 'ACCOUNT_UNAVAILABLE');
    expect(await send('setStatus', { userId: id, status: 'active' }), 409, 'ACCOUNT_REVIEW_REQUIRED');
    expect(await send('adminReviewRecoveredUser', {
      status: 'active', source: 'service_owner_confirmation', reason: 'Verified by service owner after restore',
    }, { params: { userId: id } }), 200);
    expect(await activate(validWhileReview), 401, 'ACTIVATION_INVALID');
    const restored = await activate(await issue());
    expect(restored, 200);
    now += 30 * minute;
    expect(await send('me', undefined, { token: restored.data().token }), 401, 'SESSION_EXPIRED');
  });

  await t.test('Recovery decisions require evidence and serialize with another review', async () => {
    now += 30_000;
    await adminLogin();
    const email = randomUUID() + '@example.test';
    const { id: userId } = (await send('createUser', { email })).data();
    const issued = await send('issue', { userId });
    expect(issued, 200);
    await db.execute(sql`UPDATE users SET status = 'review' WHERE id = ${userId}`);
    const decision = { status: 'blocked', source: 'post_snapshot_records', reason: '  Block recorded after the snapshot  ' } as const;
    const params = { userId };
    const review = (body: Body<'adminReviewRecoveredUser'>, options = {}) =>
      send('adminReviewRecoveredUser', body, { params, ...options });
    expect(await review(decision, { cookie: '' }), 401, 'ADMIN_AUTH_INVALID');
    expect(await review(decision, { csrf: '' }), 403, 'CSRF_INVALID');
    expect(await review(decision, { origin: config.apiOrigin }), 403, 'CSRF_INVALID');
    expect(await review({ ...decision, reason: ' \t ' }), 400, 'INVALID_REQUEST');
    expect(await review({ ...decision, source: 'snapshot_only' } as unknown as typeof decision), 400, 'INVALID_REQUEST');
    expect(await review(decision, { params: { userId: randomUUID() } }), 404, 'NOT_FOUND');
    expect(await send('setStatus', { userId, status: 'blocked' }), 409, 'ACCOUNT_REVIEW_REQUIRED');
    expect(await send('issue', { userId }), 409, 'ACCOUNT_UNAVAILABLE');
    const secondAdmin = randomUUID();
    const secondLogin = secondAdmin + '@example.test';
    const secondSession = token();
    await db.execute(sql`INSERT INTO admin_users(id, login, password_hash) VALUES (${secondAdmin}, ${secondLogin}, 'fixture')`);
    await db.execute(sql`INSERT INTO admin_sessions(verifier, admin_id, created_at, last_seen_at)
      VALUES (${verifier(config.accessKey, 'admin-session', secondSession)}, ${secondAdmin}, ${now}, ${now})`);
    const outcomes = await Promise.all([review(decision), review(decision, {
      cookie: '__Host-teta-admin=' + secondSession, csrf: verifier(config.accessKey, 'csrf', secondSession),
    })]);
    assert.deepEqual(outcomes.map(({ status }) => status).sort(), [200, 409]);
    assert.deepEqual(outcomes.find(({ status }) => status === 200)?.data(), { id: userId, email, status: 'blocked', deviceActive: false });
    expect(outcomes.find(({ status }) => status === 409)!, 409, 'ACCOUNT_REVIEW_CONFLICT');
    expect(await send('issue', { userId }), 409, 'ACCOUNT_UNAVAILABLE');
    const audit = await send('adminListAudit', undefined, { query: '?' + new URLSearchParams({ userId, event: 'account.recovery_reviewed' }) });
    expect(audit, 200);
    assert.equal(audit.data().events.length, 1);
    assert.deepEqual(audit.data().events[0].transition,
      { from: 'review', to: 'blocked', source: decision.source, reason: decision.reason.trim() });
    assert.equal(audit.data().events[0].actorLogin, outcomes[0].status === 200 ? login : secondLogin);
    expect(await send('setStatus', { userId, status: 'active' }), 200);
    expect(await send('issue', { userId }), 200);
  });

  await t.test('Audit scopes filters and preserves exact cursor order for older and current rows', async () => {
    const current = await send('adminMe');
    expect(current, 200);
    const adminId = current.data().id;
    const owner = (await send('createUser', { email: randomUUID() + '@example.test' })).data();
    const dedicated = await connection.pool.getConnection();
    const temporaryDb = drizzle(dedicated);
    const target = buildApp(config, temporaryDb, () => now);
    try {
      // Large explicit IDs stay on this connection and never advance the shared test table's counter.
      await temporaryDb.execute(sql`CREATE TEMPORARY TABLE audit_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor_role VARCHAR(10) NOT NULL,
        actor_id CHAR(36) CHARACTER SET ascii, user_id CHAR(36) CHARACTER SET ascii, object_id CHAR(36) CHARACTER SET ascii,
        event VARCHAR(64) NOT NULL, happened_at BIGINT NOT NULL, transition JSON
      )`);
      const base = 9_007_199_254_740_992n;
      const event = 'transaction.revised';
      for (let i = 0; i < 52; i++) {
        const id = (base + BigInt(i)).toString();
        const transition = i === 0 ? null : JSON.stringify({ from: '1', to: '2', reason: 'Statement', pin: 'synthetic-private' });
        await temporaryDb.execute(sql`INSERT INTO audit_events(id, actor_role, actor_id, user_id, object_id, event, happened_at, transition)
          VALUES (CAST(${id} AS UNSIGNED), 'admin', ${adminId}, ${owner.id}, ${owner.id}, ${event}, ${now}, ${transition})`);
      }
      await temporaryDb.execute(sql`INSERT INTO audit_events(actor_role, actor_id, user_id, event, happened_at)
        VALUES ('user', ${adminId}, ${owner.id}, ${event}, ${now})`);
      const time = new Date(now).toISOString();
      const filters = { userEmail: owner.email.toUpperCase(), adminId, adminLogin: login.toUpperCase(), event, from: time, through: time };
      const get = (filters: Record<string, string>, options = {}) =>
        send('adminListAudit', undefined, { target, query: '?' + new URLSearchParams(filters), ...options });
      expect(await get(filters, { cookie: '' }), 401, 'ADMIN_AUTH_INVALID');
      expect(await get(filters, { host: new URL(config.apiOrigin).host }), 404, 'NOT_FOUND');
      expect(await get({ from: '2026-02-30T00:00:00.000Z' }), 400, 'INVALID_REQUEST');
      expect(await get({ ...filters, through: new Date(now - 1).toISOString() }), 400, 'INVALID_REQUEST');
      expect(await get({ before: now + '.18446744073709551616' }), 400, 'INVALID_REQUEST');
      const first = await get(filters);
      expect(first, 200);
      assert.equal(first.data().events.length, 50);
      assert.equal(first.data().events[0].id, (base + 51n).toString());
      assert.equal(first.data().events[49].id, (base + 2n).toString());
      assert.deepEqual(first.data().events[0].transition, { from: '1', to: '2', reason: 'Statement' });
      assert.ok(!first.response.body.includes('synthetic-private'));
      const next = first.data().next;
      assert.equal(next, `${now}.${base + 2n}`);
      const second = await get({ ...filters, before: next! });
      expect(second, 200);
      assert.deepEqual(second.data().events.map(({ id, transition }) => ({ id, transition })), [
        { id: (base + 1n).toString(), transition: { from: '1', to: '2', reason: 'Statement' } },
        { id: base.toString(), transition: null },
      ]);
      assert.equal(second.data().next, null);
      assert.deepEqual((await get({ userId: randomUUID(), adminId })).data(), { events: [], next: null });
    } finally {
      await target.close();
      await dedicated.query('DROP TEMPORARY TABLE IF EXISTS audit_events');
      dedicated.release();
    }
  });

  await t.test('Activation limits count all requests from the trusted IP', async () => {
    const ip = newIp();
    const installationSecret = token();
    const email = randomUUID() + '@example.test';
    const activation = { email, code: 'wrong', pin: '4932', installationSecret };
    for (let i = 0; i < 30; i++) {
      expect(await send('activate', activation, { forwarded: newIp() + ', ' + ip }),
        i < 5 ? 401 : 429, i < 5 ? 'ACTIVATION_INVALID' : 'RATE_LIMITED');
    }
    expect(await send('activate', { ...activation, email: randomUUID() + '@example.test' }, { ip }),
      429, 'RATE_LIMITED');
  });

  await t.test('Administrative limits persist across restart and apply across new TOTP steps', async () => {
    now += 15 * minute;
    const ip = newIp();
    for (let i = 0; i < 5; i++) expect(await send('password', { login, password: 'wrong' }, { ip }), 401, 'ADMIN_AUTH_INVALID');
    await app.close();
    app = buildApp(config, db, () => now);
    expect(await send('password', { login, password }, { ip }), 429, 'RATE_LIMITED');

    const steps = [];
    for (let i = 0; i < 3; i++) {
      const response = await send('password', { login, password }, { ip: newIp() });
      expect(response, 200);
      steps.push(response.data().step);
    }
    for (const step of steps.slice(0, 2)) {
      for (let i = 0; i < 5; i++) {
        expect(await send('totp', { step, code: wrong(seed, now) }, { ip: newIp() }), 401, 'ADMIN_AUTH_INVALID');
      }
      expect(await send('totp', { step, code: codeNow() }, { ip: newIp() }), 429, 'RATE_LIMITED');
    }
    expect(await send('totp', { step: steps[2], code: codeNow() }, { ip: newIp() }), 429, 'RATE_LIMITED');
    now += 15 * minute;
    expect(await send('totp', { step: steps[2], code: codeNow() }, { ip: newIp() }), 401, 'ADMIN_AUTH_INVALID');
    const recoveryIp = newIp();
    for (let i = 0; i < 5; i++) {
      expect(await send('recovery', { login, password, recoverySecret: token() }, { ip: recoveryIp }), 401, 'ADMIN_AUTH_INVALID');
    }
    expect(await send('recovery', { login, password, recoverySecret: token() }, { ip: recoveryIp }), 429, 'RATE_LIMITED');
    await adminLogin();
    const pending = await send('password', { login, password }, { ip: newIp() });
    expect(pending, 200);
    recoverySecret = await configureAdmin(db, config.accessKey, login, password, () => now);
    expect(await send('adminMe'), 401, 'ADMIN_AUTH_INVALID');
    expect(await send('totp', { step: pending.data().step, code: codeNow() }, { ip: newIp() }), 401, 'ADMIN_AUTH_INVALID');

    const recovery = await send('recovery', { login, password, recoverySecret }, { ip: newIp() });
    expect(recovery, 200);
    browser = recovery.cookie();
    const { step, totpSecret } = recovery.data();
    const pendingSeed = decodeBase32(totpSecret);
    for (let i = 0; i < 5; i++) expect(await send('setup', { step, code: wrong(pendingSeed, now) }, { ip: newIp() }),
      401, 'ADMIN_AUTH_INVALID');
    expect(await send('setup', { step, code: totpAt(pendingSeed, Math.floor(now / 30_000)) }, { ip: newIp() }),
      429, 'RATE_LIMITED');
    expect(await send('recovery', { login, password, recoverySecret }, { ip: newIp() }), 401, 'ADMIN_AUTH_INVALID');
  });

  await t.test('Administrative logout, inactivity and absolute lifetime', async () => {
    now += 15 * minute;
    recoverySecret = await configureAdmin(db, config.accessKey, login, password, () => now);
    await setupAdmin();
    await adminLogin();
    expect(await send('adminLogout', {}), 200);
    expect(await send('adminMe'), 401, 'ADMIN_AUTH_INVALID');
    now += 30_000;
    await adminLogin();
    now += 30 * minute;
    expect(await send('adminMe'), 401, 'ADMIN_AUTH_INVALID');
    await adminLogin();
    for (let i = 0; i < 16; i++) {
      now += 29 * minute;
      expect(await send('adminMe'), 200);
    }
    now += 16 * minute;
    expect(await send('adminMe'), 401, 'ADMIN_AUTH_INVALID');
  });

  await t.test('Local HTTP uses separate admin cookies and checks the origin', async (t) => {
    const localEnv = { ...env, API_ORIGIN: 'http://127.0.0.1:18443', ADMIN_ORIGIN: 'http://127.0.0.1:18444' };
    assert.throws(() => configFromEnv({ ...localEnv, ALLOW_HTTP: '0' }), /Invalid API_ORIGIN/);
    const target = buildApp(configFromEnv({ ...localEnv, ALLOW_HTTP: '1' }), db, () => now);
    t.after(() => target.close());
    const local = { target, host: '127.0.0.1:18444', origin: localEnv.ADMIN_ORIGIN, protocol: 'http', ip: newIp() };
    const credentials = { login, password };
    expect(await send('health', undefined, { ...local, host: '127.0.0.1:18443' }), 200);
    expect(await send('password', credentials, { ...local, protocol: 'https' }), 404, 'NOT_FOUND');
    expect(await send('password', credentials, { ...local, origin: localEnv.API_ORIGIN }), 403, 'CSRF_INVALID');
    const started = await send('password', credentials, { ...local, cookie: browser });
    expect(started, 200);
    assert.match(String(started.response.headers['set-cookie']), /^teta-local-browser=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict;/);
    const session = await send('totp', { step: started.data().step, code: codeNow() }, { ...local, cookie: started.cookie() });
    expect(session, 200);
    assert.match(String(session.response.headers['set-cookie']), /^teta-local-admin=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict;/);
    expect(await send('adminMe', undefined, { ...local, cookie: adminCookie }), 401, 'ADMIN_AUTH_INVALID');
    expect(await send('adminMe', undefined, { ...local, cookie: session.cookie() }), 200);
    const logout = await send('adminLogout', {}, { ...local, cookie: session.cookie(), csrf: session.data().csrf });
    expect(logout, 200);
    assert.match(String(logout.response.headers['set-cookie']), /^teta-local-admin=; .*Max-Age=0$/);
  });
});

function decodeBase32(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = Array.from(value, (char) => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
}
