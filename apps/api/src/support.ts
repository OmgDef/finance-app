import { randomUUID } from 'node:crypto';
import type { Body, Language, Result, SupportVariant } from '@teta/contracts';
import { sql } from 'drizzle-orm';
import type { Runner, Tx } from './db.ts';
import { audit, one, rows } from './db.ts';
import { AccessError } from './errors.ts';

type Support = Result<'adminGetSupport'>;
type Contacts = Support['contacts'];
type Faq = Support['faq'][number];
type FaqInput = Body<'adminCreateFaq'>;
const notFound = new AccessError(404, 'NOT_FOUND');
const conflict = new AccessError(409, 'VERSION_CONFLICT');
const invalid = new AccessError(400, 'INVALID_REQUEST');
const supportIds = { a: 1, b: 2 } satisfies Record<SupportVariant, number>;

const faqSelect = sql`SELECT id, version, position, published, question_en AS questionEn,
  answer_en AS answerEn, question_ru AS questionRu, answer_ru AS answerRu FROM faq_entries`;

export async function publicSupport(db: Runner, variant: SupportVariant, lang: Language): Promise<Result<'support'>> {
  const snapshot = await rows<Pick<Contacts, 'email' | 'phone'> & {
    id: string | null; question: string | null; answer: string | null;
  }>(db, sql`
    SELECT s.email, s.phone, f.id, ${sql.identifier('question_' + lang)} AS question,
      ${sql.identifier('answer_' + lang)} AS answer
    FROM (SELECT ${supportIds[variant]} AS id) AS anchor
    LEFT JOIN support_settings s ON s.id = anchor.id
    LEFT JOIN faq_entries f ON f.support_id = anchor.id AND f.published = TRUE
      AND REGEXP_LIKE(f.question_en, '[^[:space:]]') AND REGEXP_LIKE(f.answer_en, '[^[:space:]]')
      AND REGEXP_LIKE(f.question_ru, '[^[:space:]]') AND REGEXP_LIKE(f.answer_ru, '[^[:space:]]')
    ORDER BY f.position, f.id`);
  const first = snapshot[0];
  const faq = snapshot.flatMap(({ id, question, answer }) =>
    id === null || question === null || answer === null ? [] : [{ id, question, answer }]);
  return { email: first?.email?.trim() || null, phone: first?.phone?.trim() || null, faq };
}

async function contacts(tx: Tx, supportId: number, lock = false): Promise<Contacts> {
  const row = await one<Contacts>(tx, sql`SELECT email, phone, version FROM support_settings
    WHERE id = ${supportId} ${lock ? sql`FOR UPDATE` : sql``}`);
  return row ?? { email: null, phone: null, version: 1 };
}

export async function adminSupport(tx: Tx, variant: SupportVariant): Promise<Support> {
  const supportId = supportIds[variant];
  const settings = await contacts(tx, supportId);
  const faq = await rows<Omit<Faq, 'published'> & { published: number }>(tx, sql`${faqSelect} WHERE support_id = ${supportId} ORDER BY position, id`);
  return { contacts: settings, faq: faq.map(({ published, ...entry }) => ({ ...entry, published: Boolean(published) })) };
}

const contactEmail = /^[a-z0-9!#$%&'*+/=?^`{|}~_.-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export async function updateSupportContacts(tx: Tx, variant: SupportVariant, actor: string, now: number,
  input: Body<'adminUpdateSupportContacts'>,
): Promise<Contacts> {
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  if (email) {
    const local = email.split('@')[0];
    if (!contactEmail.test(email) || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
      throw invalid;
    }
  }
  if (phone && (!/^\+?[\d ().-]+$/.test(phone) || !/^\+?\d{7,15}$/.test(phone.replace(/[ ().-]/g, '')))) throw invalid;

  const supportId = supportIds[variant];
  await tx.execute(sql`INSERT INTO support_settings (id) VALUES (${supportId}) ON DUPLICATE KEY UPDATE id = support_settings.id`);
  const previous = await contacts(tx, supportId, true);
  if (input.expectedVersion !== previous.version) throw conflict;
  if (previous.email === email && previous.phone === phone) return previous;
  const version = previous.version + 1;
  await tx.execute(sql`UPDATE support_settings SET email = ${email}, phone = ${phone}, version = ${version} WHERE id = ${supportId}`);
  await audit(tx, now, 'admin', 'support.contacts.updated', actor, null, variant === 'a' ? 'support' : 'support:b', {
    from: String(previous.version), to: String(version),
  });
  return { email, phone, version };
}

function normalizedFaq(input: FaqInput): FaqInput {
  const { position, published } = input;
  const questionEn = input.questionEn.trim();
  const answerEn = input.answerEn.trim();
  const questionRu = input.questionRu.trim();
  const answerRu = input.answerRu.trim();
  if (published && (!questionEn || !answerEn || !questionRu || !answerRu)) throw invalid;
  return { position, published, questionEn, answerEn, questionRu, answerRu };
}

export async function createFaq(tx: Tx, variant: SupportVariant, actor: string, now: number, input: FaqInput): Promise<Faq> {
  const fields = normalizedFaq(input);
  const id = randomUUID();
  const { position, published, questionEn, answerEn, questionRu, answerRu } = fields;
  await tx.execute(sql`INSERT INTO faq_entries (id, support_id, position, published, question_en, answer_en, question_ru, answer_ru)
    VALUES (${id}, ${supportIds[variant]}, ${position}, ${published}, ${questionEn}, ${answerEn}, ${questionRu}, ${answerRu})`);
  await audit(tx, now, 'admin', 'support.faq.created', actor, null, id, { from: '0', to: '1' });
  return { id, version: 1, ...fields };
}

async function lockFaq(tx: Tx, supportId: number, id: string, expectedVersion: number) {
  const entry = await one<{ version: number }>(tx, sql`SELECT version FROM faq_entries WHERE support_id = ${supportId} AND id = ${id} FOR UPDATE`);
  if (!entry) throw notFound;
  if (entry.version !== expectedVersion) throw conflict;
}

export async function updateFaq(tx: Tx, variant: SupportVariant, actor: string, now: number, id: string,
  input: Body<'adminUpdateFaq'>,
): Promise<Faq> {
  const fields = normalizedFaq(input);
  const { position, published, questionEn, answerEn, questionRu, answerRu } = fields;
  const supportId = supportIds[variant];
  await lockFaq(tx, supportId, id, input.expectedVersion);
  const version = input.expectedVersion + 1;
  await tx.execute(sql`UPDATE faq_entries SET position = ${position}, published = ${published}, question_en = ${questionEn},
    answer_en = ${answerEn}, question_ru = ${questionRu}, answer_ru = ${answerRu}, version = ${version}
    WHERE support_id = ${supportId} AND id = ${id}`);
  await audit(tx, now, 'admin', 'support.faq.updated', actor, null, id, {
    from: String(input.expectedVersion), to: String(version),
  });
  return { id, version, ...fields };
}

export async function deleteFaq(tx: Tx, variant: SupportVariant, actor: string, now: number, id: string, expectedVersion: number) {
  if (expectedVersion > 4_294_967_295) throw invalid;
  const supportId = supportIds[variant];
  await lockFaq(tx, supportId, id, expectedVersion);
  await tx.execute(sql`DELETE FROM faq_entries WHERE support_id = ${supportId} AND id = ${id}`);
  await audit(tx, now, 'admin', 'support.faq.deleted', actor, null, id, { from: String(expectedVersion), to: 'deleted' });
}
