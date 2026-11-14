import Fastify, { LogController } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { routes, errorSchema } from '@teta/contracts';
import type { AuditQuery, Body, Params, Route, Result, StatisticsQuery } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import { listAccountHistory } from './account-history.ts';
import { adminAccess } from './admin.ts';
import { listAuditEvents } from './audit.ts';
import { checkCommandStatus, closeCommand } from './commands.ts';
import type { WithCommandAccess } from './commands.ts';
import type { Config } from './config.ts';
import { token } from './crypto.ts';
import { one } from './db.ts';
import type { Db } from './db.ts';
import { AccessError, sessionExpired } from './errors.ts';
import {
  changeTransaction, createAccount, createAccountCard, deleteAccountCard, getAccountBalance, getCurrencySummary,
  listAccountCards, listAccounts, listBalanceAdjustments, listCategories, listTransactionVersions, previewBalanceAdjustment,
  previewTransactionChange, reconcileAccountBalance, recordTransaction, renameAccount, setAccountArchived, updateAccountCard,
  updateAccountStartDate,
} from './finance.ts';
import { mobileAccess } from './mobile.ts';
import { readProfileCalendar } from './profile.ts';
import { minute } from './rates.ts';
import {
  changeScheduleRule, createScheduleRule, getScheduleRule, listScheduleOccurrences, listScheduleRules,
  previewScheduleRuleReplacement, replaceScheduleRule, retryScheduleOccurrence, skipScheduleOccurrence,
} from './schedule.ts';
import { getStatistics } from './statistics.ts';
import { adminSupport, createFaq, deleteFaq, publicSupport, updateFaq, updateSupportContacts } from './support.ts';

const ok = { ok: true } as const;
const tokenPattern = /^[a-f0-9]{64}$/;
type OccurrenceQuery = { fromDate: string; throughDate: string; accountId?: string; ruleId?: string };
function readCookie(request: FastifyRequest, name: string) {
  const prefix = name + '=';
  const value = request.headers.cookie?.split(';').map((item) => item.trim())
    .find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? '';
  return tokenPattern.test(value) ? value : '';
}
function bearer(request: FastifyRequest) {
  const value = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if (!value || !tokenPattern.test(value)) throw sessionExpired;
  return value;
}

export function buildApp(config: Config, db: Db, clock = Date.now, logger = false) {
  const app = Fastify({
    logger, logController: new LogController({ disableRequestLogging: true }), trustProxy: config.proxyIp,
    bodyLimit: 8192, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const mobile = mobileAccess(db, config.accessKey, clock);
  const admin = adminAccess(db, config, clock);
  const apiOrigin = new URL(config.apiOrigin);
  const adminOrigin = new URL(config.adminOrigin);
  const secureCookies = adminOrigin.protocol === 'https:';
  const adminCookie = secureCookies ? '__Host-teta-admin' : 'teta-local-admin';
  const browserCookie = secureCookies ? '__Host-teta-browser' : 'teta-local-browser';
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; ${secureCookies ? 'Secure; ' : ''}SameSite=Strict; Max-Age=${maxAge}`;

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.routeOptions.url && request.routeOptions.url !== '*') {
      const expected = request.routeOptions.url.startsWith('/api/v1/admin/') ? adminOrigin : apiOrigin;
      if (request.headers.host !== expected.host || `${request.protocol}:` !== expected.protocol) {
        throw new AccessError(404, 'NOT_FOUND');
      }
    }
  });
  app.setNotFoundHandler(() => { throw new AccessError(404, 'NOT_FOUND'); });
  app.setErrorHandler((error, request, reply) => {
    const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const failure = error instanceof AccessError ? error :
      typeof status === 'number' && status >= 400 && status < 500
        ? new AccessError(status, 'INVALID_REQUEST') : new AccessError(500, 'INTERNAL_ERROR');
    if (failure.status === 500) request.log.error({ requestId: request.id, code: failure.code });
    if (failure.retryAfter) reply.header('Retry-After', failure.retryAfter);
    void reply.code(failure.status).send({ code: failure.code, requestId: request.id, retryAfter: failure.retryAfter });
  });

  function add<K extends Route>(key: K, handler: (
    request: FastifyRequest<{ Body: Body<K>; Params: Params<K> }>, reply: FastifyReply,
  ) => Promise<Result<K>>) {
    const route = routes[key];
    const changes = route.method !== 'GET';
    app.route<{ Body: Body<K>; Params: Params<K> }>({
      method: route.method, url: route.url,
      ...((key === 'replaceScheduleRule' || key === 'adminReplaceScheduleRule') && { bodyLimit: 256 * 1024 }),
      ...((key === 'adminCreateFaq' || key === 'adminUpdateFaq') && { bodyLimit: 64 * 1024 }),
      schema: {
        ...((route.method === 'POST' || route.method === 'PUT') && !('optionalBody' in route) && { body: route.body }),
        ...('params' in route && { params: route.params }),
        ...('query' in route && { querystring: route.query }),
        response: { 200: route.result, '4xx': errorSchema, '5xx': errorSchema },
      },
      preValidation: async (request) => {
        if ((route.access === 'admin-step' || (route.access === 'admin' && changes)) &&
            request.headers.origin !== config.adminOrigin) throw new AccessError(403, 'CSRF_INVALID');
      },
      handler,
    });
  }

  function adminSession<T>(request: FastifyRequest, action: Parameters<typeof admin.withSession<T>>[3]) {
    const header = request.headers['x-csrf-token'];
    return admin.withSession(readCookie(request, adminCookie), typeof header === 'string' ? header : undefined,
      request.method !== 'GET', action);
  }

  function mobileCommandAccess(request: FastifyRequest): WithCommandAccess {
    const session = bearer(request);
    return (write, reserve) => mobile.withSession(session, (tx, user, _device, now) => write(tx, user.id, now, user.id),
      reserve && ((tx, userId) => reserve(tx, userId, userId)));
  }

  function adminCommandAccess(request: FastifyRequest, userId: string): WithCommandAccess {
    return (write, reserve) => adminSession(request, async (tx, admin) => {
      await reserve?.(tx, userId, admin.id);
      const user = await one(tx, sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
      if (!user) throw new AccessError(404, 'NOT_FOUND');
      return write(tx, userId, clock(), admin.id);
    });
  }

  function startBrowser(request: FastifyRequest, reply: FastifyReply) {
    const browser = readCookie(request, browserCookie) || token();
    reply.header('Set-Cookie', cookie(browserCookie, browser, 15 * minute / 1000));
    return browser;
  }

  add('health', async () => { await db.execute(sql`SELECT 1`); return ok; });
  add('support', async (request) => publicSupport(db, (request.query as { lang?: 'en' | 'ru' }).lang ?? 'en'));
  add('activate', async (request) => ({ ...await mobile.activate(request.body, request.ip), recoveryVersion: config.recoveryVersion }));
  add('unlock', async (request) => ({ ...await mobile.unlock(request.body, request.ip), recoveryVersion: config.recoveryVersion }));
  add('me', async (request) => ({ ...await mobile.profile(bearer(request)), recoveryVersion: config.recoveryVersion }));
  add('setTimeZone', async (request) =>
    ({ ...await mobile.setTimeZone(bearer(request), request.body.timeZone), recoveryVersion: config.recoveryVersion }));
  add('logout', async (request) => { await mobile.logout(bearer(request)); return ok; });
  add('enableBiometrics', async (request) => { await mobile.setBiometrics(bearer(request), request.body); return ok; });
  add('disableBiometrics', async (request) => { await mobile.setBiometrics(bearer(request)); return ok; });
  add('createAccount', async (request) =>
    createAccount(mobileCommandAccess(request), config.recoveryVersion, request.body));
  add('listAccounts', async (request) => mobile.withSession(bearer(request), (tx, user) => listAccounts(tx, user.id)));
  add('getCurrencySummary', async (request) => mobile.withSession(bearer(request), (tx, user) =>
    getCurrencySummary(tx, user.id)));
  add('getAccountBalance', async (request) => mobile.withSession(bearer(request), (tx, user) =>
    getAccountBalance(tx, user.id, request.params.accountId)));
  add('renameAccount', async (request) => renameAccount(mobileCommandAccess(request), request.params.accountId, request.body));
  add('updateAccountStartDate', async (request) =>
    updateAccountStartDate(mobileCommandAccess(request), request.params.accountId, request.body));
  add('listAccountHistory', async (request) => mobile.withSession(bearer(request), (tx, user) =>
    listAccountHistory(tx, user.id, request.params.accountId, (request.query as { before?: string }).before)));
  add('listCategories', async (request) => mobile.withSession(bearer(request), listCategories));
  add('getStatistics', async (request) => mobile.withSession(bearer(request), (tx, user, _device, now) =>
    getStatistics(tx, user.id, now, request.query as StatisticsQuery)));
  add('archiveAccount', async (request) => setAccountArchived(mobileCommandAccess(request), request.params.accountId, true));
  add('restoreAccount', async (request) => setAccountArchived(mobileCommandAccess(request), request.params.accountId, false));
  add('listBalanceAdjustments', async (request) => mobile.withSession(bearer(request), (tx, user) =>
    listBalanceAdjustments(tx, user.id, request.params.accountId, (request.query as { beforeVersion?: string }).beforeVersion)));
  add('reconcileAccountBalance', async (request) =>
    reconcileAccountBalance(mobileCommandAccess(request), config.recoveryVersion, request.params.accountId, request.body));
  add('previewBalanceAdjustment', async (request) => mobile.withSession(bearer(request), (tx, user, _device, now) =>
    previewBalanceAdjustment(tx, user.id, request.params.accountId, now, request.query as { fromDate: string; throughDate: string })));
  add('listAccountCards', async (request) => mobile.withSession(bearer(request), (tx, user) =>
    listAccountCards(tx, user.id, request.params.accountId)));
  add('createAccountCard', async (request) =>
    createAccountCard(mobileCommandAccess(request), request.params.accountId, request.body));
  add('updateAccountCard', async (request) =>
    updateAccountCard(mobileCommandAccess(request), request.params, request.body));
  add('deleteAccountCard', async (request) =>
    deleteAccountCard(mobileCommandAccess(request), request.params));
  add('recordTransaction', async (request) =>
    recordTransaction(mobileCommandAccess(request), config.recoveryVersion, request.body));
  add('listTransactionVersions', async (request) => mobile.withSession(bearer(request), (tx, user) =>
    listTransactionVersions(tx, user.id, request.params.transactionId)));
  add('reviseTransaction', async (request) =>
    changeTransaction(mobileCommandAccess(request), config.recoveryVersion, request.params.transactionId, request.body));
  add('voidTransaction', async (request) =>
    changeTransaction(mobileCommandAccess(request), config.recoveryVersion, request.params.transactionId, request.body));
  add('listScheduleRules', async (request) => mobile.withSession(bearer(request), (tx, user, _device, now) =>
    listScheduleRules(tx, user.id, now, (request.query as { accountId?: string }).accountId)));
  add('createScheduleRule', async (request) => createScheduleRule(mobileCommandAccess(request), request.body));
  add('getScheduleRule', async (request) => mobile.withSession(bearer(request), (tx, user, _device, now) =>
    getScheduleRule(tx, user.id, request.params.ruleId, now)));
  add('changeScheduleRule', async (request) =>
    changeScheduleRule(mobileCommandAccess(request), request.params.ruleId, request.body));
  add('previewScheduleRuleReplacement', async (request) => mobileCommandAccess(request)((tx, userId, now) =>
    previewScheduleRuleReplacement(tx, userId, now, request.params.ruleId, (request.query as { accountId: string }).accountId,
      config.accessKey)));
  add('replaceScheduleRule', async (request) =>
    replaceScheduleRule(mobileCommandAccess(request), config.recoveryVersion, request.params.ruleId, request.body, config.accessKey));
  add('listScheduleOccurrences', async (request) => mobile.withSession(bearer(request), (tx, user, _device, now) => {
    const { fromDate, throughDate, ...filter } = request.query as OccurrenceQuery;
    return listScheduleOccurrences(tx, user.id, { fromDate, throughDate, asOf: now }, filter);
  }));
  add('skipScheduleOccurrence', async (request) =>
    skipScheduleOccurrence(mobileCommandAccess(request), config.recoveryVersion, request.params, request.body));
  add('commandStatus', async (request) =>
    checkCommandStatus(mobileCommandAccess(request), request.body, config.recoveryVersion));
  add('closeCommand', async (request) =>
    closeCommand(mobileCommandAccess(request), request.body, config.recoveryVersion));

  add('password', async (request, reply) => admin.password(request.body, startBrowser(request, reply), request.ip));
  add('recovery', async (request, reply) => admin.recovery(request.body, startBrowser(request, reply), request.ip));
  add('totp', async (request, reply) => {
    const session = await admin.login(request.body, readCookie(request, browserCookie), request.ip);
    if (!session) throw new AccessError(401, 'ADMIN_AUTH_INVALID');
    reply.header('Set-Cookie', cookie(adminCookie, session.session, 8 * 60 * 60));
    return { id: session.id, login: session.login, csrf: session.csrf, recoveryVersion: config.recoveryVersion };
  });
  add('setup', async (request) => { await admin.setup(request.body, readCookie(request, browserCookie), request.ip); return ok; });
  add('adminMe', async (request) => adminSession(request, async (_tx, { id, login, csrf }) =>
    ({ id, login, csrf, recoveryVersion: config.recoveryVersion })));
  add('adminLogout', async (request, reply) => adminSession(request, async (tx, { hash }) => {
    await tx.execute(sql`UPDATE admin_sessions SET revoked = TRUE WHERE verifier = ${hash}`);
    reply.header('Set-Cookie', cookie(adminCookie, '', 0));
    return ok;
  }));
  add('listUsers', async (request) => adminSession(request, async (tx) => {
    const { after, search } = request.query as { after?: string; search?: string };
    return mobile.list(tx, after, search);
  }));
  add('adminGetUser', async (request) => adminSession(request, (tx) => mobile.getUser(tx, request.params.userId)));
  add('createUser', async (request) => adminSession(request, (tx, { id }, now) => mobile.create(tx, id, request.body.email, now)));
  add('adminListAccounts', async (request) => adminCommandAccess(request, request.params.userId)(async (tx, userId, now) => {
    const { today, timeZone } = await readProfileCalendar(tx, userId, now);
    return { ...await listAccounts(tx, userId), today, timeZone };
  }));
  add('adminCreateAccount', async (request) =>
    createAccount(adminCommandAccess(request, request.params.userId), config.recoveryVersion, request.body));
  add('adminListAccountHistory', async (request) => adminSession(request, (tx) =>
    listAccountHistory(tx, request.params.userId, request.params.accountId, (request.query as { before?: string }).before)));
  add('adminListCategories', async (request) => adminSession(request, listCategories));
  add('adminRenameAccount', async (request) =>
    renameAccount(adminCommandAccess(request, request.params.userId), request.params.accountId, request.body));
  add('adminUpdateAccountStartDate', async (request) =>
    updateAccountStartDate(adminCommandAccess(request, request.params.userId), request.params.accountId, request.body));
  add('adminArchiveAccount', async (request) =>
    setAccountArchived(adminCommandAccess(request, request.params.userId), request.params.accountId, true, 'admin'));
  add('adminRestoreAccount', async (request) =>
    setAccountArchived(adminCommandAccess(request, request.params.userId), request.params.accountId, false, 'admin'));
  add('adminListBalanceAdjustments', async (request) => adminSession(request, (tx) =>
    listBalanceAdjustments(tx, request.params.userId, request.params.accountId,
      (request.query as { beforeVersion?: string }).beforeVersion)));
  add('adminReconcileAccountBalance', async (request) =>
    reconcileAccountBalance(adminCommandAccess(request, request.params.userId), config.recoveryVersion,
      request.params.accountId, request.body, 'admin'));
  add('adminPreviewBalanceAdjustment', async (request) =>
    adminCommandAccess(request, request.params.userId)((tx, userId, now) =>
      previewBalanceAdjustment(tx, userId, request.params.accountId, now, request.query as { fromDate: string; throughDate: string })));
  add('adminListTransactionVersions', async (request) => adminSession(request, (tx) =>
    listTransactionVersions(tx, request.params.userId, request.params.transactionId)));
  add('adminPreviewTransactionRevision', async (request) =>
    previewTransactionChange(adminCommandAccess(request, request.params.userId), request.params.transactionId, request.body));
  add('adminPreviewTransactionVoid', async (request) =>
    previewTransactionChange(adminCommandAccess(request, request.params.userId), request.params.transactionId));
  add('adminReviseTransaction', async (request) =>
    changeTransaction(adminCommandAccess(request, request.params.userId), config.recoveryVersion,
      request.params.transactionId, request.body, 'admin'));
  add('adminVoidTransaction', async (request) =>
    changeTransaction(adminCommandAccess(request, request.params.userId), config.recoveryVersion,
      request.params.transactionId, request.body, 'admin'));
  add('adminListScheduleRules', async (request) => adminCommandAccess(request, request.params.userId)((tx, userId, now) =>
    listScheduleRules(tx, userId, now, (request.query as { accountId?: string }).accountId)));
  add('adminCreateScheduleRule', async (request) =>
    createScheduleRule(adminCommandAccess(request, request.params.userId), request.body, 'admin'));
  add('adminGetScheduleRule', async (request) => adminCommandAccess(request, request.params.userId)((tx, userId, now) =>
    getScheduleRule(tx, userId, request.params.ruleId, now)));
  add('adminChangeScheduleRule', async (request) =>
    changeScheduleRule(adminCommandAccess(request, request.params.userId), request.params.ruleId, request.body, 'admin'));
  add('adminPreviewScheduleRuleReplacement', async (request) =>
    adminCommandAccess(request, request.params.userId)((tx, userId, now) =>
      previewScheduleRuleReplacement(tx, userId, now, request.params.ruleId, (request.query as { accountId: string }).accountId,
        config.accessKey)));
  add('adminReplaceScheduleRule', async (request) =>
    replaceScheduleRule(adminCommandAccess(request, request.params.userId), config.recoveryVersion, request.params.ruleId,
      request.body, config.accessKey, 'admin'));
  add('adminListScheduleOccurrences', async (request) => adminCommandAccess(request, request.params.userId)((tx, userId, now) => {
    const { fromDate, throughDate, ...filter } = request.query as OccurrenceQuery;
    return listScheduleOccurrences(tx, userId, { fromDate, throughDate, asOf: now }, filter);
  }));
  add('adminSkipScheduleOccurrence', async (request) =>
    skipScheduleOccurrence(adminCommandAccess(request, request.params.userId), config.recoveryVersion, request.params, request.body,
      { role: 'admin', expectedFailureRevision: request.body.expectedFailureRevision }));
  add('adminRetryScheduleOccurrence', async (request) =>
    retryScheduleOccurrence(adminCommandAccess(request, request.params.userId), request.params, request.body));
  add('adminCommandStatus', async (request) =>
    checkCommandStatus(adminCommandAccess(request, request.body.userId), request.body, config.recoveryVersion, 'admin'));
  add('adminCloseCommand', async (request) =>
    closeCommand(adminCommandAccess(request, request.body.userId), request.body, config.recoveryVersion, 'admin'));
  add('issue', async (request) => adminSession(request, (tx, { id }, now) => mobile.issue(tx, id, request.body.userId, now)));
  add('revoke', async (request) => adminSession(request, async (tx, { id }, now) => {
    await mobile.revoke(tx, id, request.body.userId, now);
    return ok;
  }));
  add('setStatus', async (request) => adminSession(request, async (tx, { id }, now) => {
    await mobile.status(tx, id, request.body.userId, request.body.status, now);
    return ok;
  }));
  add('adminReviewRecoveredUser', async (request) => adminSession(request, (tx, { id }, now) =>
    mobile.reviewRecoveredUser(tx, id, request.params.userId, request.body, now)));
  add('adminListAudit', async (request) => adminSession(request, (tx) => listAuditEvents(tx, request.query as AuditQuery)));
  add('adminGetSupport', async (request) => adminSession(request, adminSupport));
  add('adminUpdateSupportContacts', async (request) =>
    adminSession(request, (tx, { id }, now) => updateSupportContacts(tx, id, now, request.body)));
  add('adminCreateFaq', async (request) => adminSession(request, (tx, { id }, now) => createFaq(tx, id, now, request.body)));
  add('adminUpdateFaq', async (request) =>
    adminSession(request, (tx, { id }, now) => updateFaq(tx, id, now, request.params.faqId, request.body)));
  add('adminDeleteFaq', async (request) => adminSession(request, async (tx, { id }, now) => {
    await deleteFaq(tx, id, now, request.params.faqId, Number((request.query as { expectedVersion: string }).expectedVersion));
    return ok;
  }));
  return app;
}
