import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { avatarMaxBytes, avatarMaxPixels } from '@teta/contracts';
import type { Body, ProfileFields, Result } from '@teta/contracts';
import { sealBytes, unsealBytes } from './crypto.ts';
import { one } from './db.ts';
import type { Tx } from './db.ts';
import { AccessError } from './errors.ts';
import { readProfileCalendar } from './profile.ts';

type Keyring = ReadonlyMap<number, Buffer> | undefined;
type Summary = Result<'getProfileSummary'>;
type Identity = Pick<Summary, 'firstName' | 'lastName' | 'initials'>;
type StoredIdentity = Omit<Identity, 'lastName'> & { lastName?: Identity['lastName'] };
type ProfileRow = {
  version: number;
  key_version: number;
  avatar_version: number | null;
  avatar_jpeg: Buffer | null;
};

const emptyFields: ProfileFields = {
  firstName: null, lastName: null, patronymic: null, birthDate: null,
  passportSeries: null, passportNumber: null, registrationAddress: null,
};

function summarize(fields: ProfileFields, avatarVersion: number | null): Summary {
  const initials = [fields.firstName, fields.lastName]
    .flatMap((name) => name ? Array.from(name).slice(0, 1) : []).join('').toUpperCase();
  return { firstName: fields.firstName, lastName: fields.lastName, initials: initials || null, avatarVersion };
}

function keyFor(keys: Keyring, version: number) {
  const key = keys?.get(version);
  if (!key) throw new AccessError(503, 'PROFILE_UNAVAILABLE');
  return key;
}

function encrypt(key: Buffer, userId: string, part: string, data: Buffer) {
  return sealBytes(key, 'personal-profile:' + userId + ':' + part, data);
}

function decrypt(key: Buffer, userId: string, part: string, data: Buffer) {
  return unsealBytes(key, 'personal-profile:' + userId + ':' + part, data);
}

export async function readProfileSummary(tx: Tx, userId: string, keys: Keyring): Promise<Summary> {
  const row = await one<Pick<ProfileRow, 'key_version' | 'avatar_version'> & { identity_summary: Buffer }>(
    tx, sql`SELECT key_version, avatar_version, identity_summary FROM personal_profiles WHERE user_id = ${userId}`);
  if (!row) return summarize(emptyFields, null);
  const key = keyFor(keys, row.key_version);
  const identity = JSON.parse(decrypt(key, userId, 'summary', row.identity_summary).toString('utf8')) as StoredIdentity;
  if (identity.lastName === undefined) {
    // Older summaries did not store the last name. It is already present in the encrypted profile.
    return (await readPersonalProfile(tx, userId, keys)).summary;
  }
  return { ...identity, lastName: identity.lastName, avatarVersion: row.avatar_version };
}

export async function readPersonalProfile(tx: Tx, userId: string, keys: Keyring): Promise<Result<'getPersonalProfile'>> {
  const row = await one<Omit<ProfileRow, 'avatar_jpeg'> & { personal_fields: Buffer }>(tx, sql`
    SELECT version, key_version, avatar_version, personal_fields FROM personal_profiles WHERE user_id = ${userId}`);
  const fields = row ? JSON.parse(decrypt(keyFor(keys, row.key_version), userId, 'fields', row.personal_fields)
    .toString('utf8')) as ProfileFields : emptyFields;
  return { fields, version: row?.version ?? 0, summary: summarize(fields, row?.avatar_version ?? null) };
}

export async function readProfileAvatar(tx: Tx, userId: string, keys: Keyring): Promise<Result<'getProfileAvatar'>> {
  const row = await one<Omit<ProfileRow, 'version'>>(tx, sql`
    SELECT key_version, avatar_version, avatar_jpeg FROM personal_profiles WHERE user_id = ${userId}`);
  if (!row?.avatar_jpeg || row.avatar_version === null) throw new AccessError(404, 'NOT_FOUND');
  const jpeg = decrypt(keyFor(keys, row.key_version), userId, 'avatar', row.avatar_jpeg).toString('base64');
  return { version: row.avatar_version, jpeg };
}

async function normalizeAvatar(base64: string) {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > avatarMaxBytes || bytes.toString('base64') !== base64 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new AccessError(400, 'INVALID_AVATAR');
  }
  try {
    const image = sharp(bytes, { limitInputPixels: avatarMaxPixels ** 2, failOn: 'warning' });
    const { format, width, height } = await image.metadata();
    if (format !== 'jpeg' || !width || width !== height || width > avatarMaxPixels) throw new Error();
    const jpeg = await image.autoOrient().jpeg({ quality: 83 }).toBuffer();
    if (jpeg.length > avatarMaxBytes) throw new Error();
    return jpeg;
  } catch {
    throw new AccessError(400, 'INVALID_AVATAR');
  }
}

export async function savePersonalProfile(tx: Tx, userId: string, now: number, keys: Keyring,
  input: Body<'savePersonalProfile'>): Promise<Result<'savePersonalProfile'>> {
  const keyVersion = Math.max(0, ...keys?.keys() ?? []);
  const key = keyFor(keys, keyVersion);
  const row = await one<ProfileRow>(tx, sql`
    SELECT version, key_version, avatar_version, avatar_jpeg FROM personal_profiles WHERE user_id = ${userId}`);
  if (input.expectedVersion !== (row?.version ?? 0)) throw new AccessError(409, 'VERSION_CONFLICT');

  const fields: ProfileFields = { ...input.fields };
  for (const name of Object.keys(fields) as (keyof ProfileFields)[]) fields[name] = fields[name]?.trim() || null;
  if (fields.birthDate) {
    const { today } = await readProfileCalendar(tx, userId, now);
    if (fields.birthDate > today) throw new AccessError(400, 'INVALID_BIRTH_DATE');
  }

  const version = input.expectedVersion + 1;
  let avatarVersion = row?.avatar_version ?? null;
  let avatar = row?.avatar_jpeg ?? null;
  if (input.avatarJpeg === null) {
    avatar = null;
    avatarVersion = null;
  } else if (input.avatarJpeg !== undefined) {
    avatar = encrypt(key, userId, 'avatar', await normalizeAvatar(input.avatarJpeg));
    avatarVersion = version;
  } else if (avatar && row && row.key_version !== keyVersion) {
    avatar = encrypt(key, userId, 'avatar', decrypt(keyFor(keys, row.key_version), userId, 'avatar', avatar));
  }

  const summary = summarize(fields, avatarVersion);
  const identity: Identity = { firstName: summary.firstName, lastName: summary.lastName, initials: summary.initials };
  const identitySummary = encrypt(key, userId, 'summary', Buffer.from(JSON.stringify(identity)));
  const personalFields = encrypt(key, userId, 'fields', Buffer.from(JSON.stringify(fields)));
  // The mobile session locks the owner row for the whole write.
  await tx.execute(sql`
    INSERT INTO personal_profiles (user_id, version, key_version, identity_summary, personal_fields, avatar_version, avatar_jpeg)
    VALUES (${userId}, ${version}, ${keyVersion}, ${identitySummary}, ${personalFields}, ${avatarVersion}, ${avatar}) AS incoming
    ON DUPLICATE KEY UPDATE version = incoming.version, key_version = incoming.key_version,
      identity_summary = incoming.identity_summary, personal_fields = incoming.personal_fields,
      avatar_version = incoming.avatar_version, avatar_jpeg = incoming.avatar_jpeg`);
  return { fields, version, summary };
}
