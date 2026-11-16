import {
  argon2, createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(argon2);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function token() {
  return randomBytes(32).toString('hex');
}

export function base32(bytes: Buffer) {
  let result = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

export function verifier(key: Buffer, scope: string, value: string) {
  return createHmac('sha256', key).update(scope).update('\0').update(value).digest('hex');
}

export function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function hashPassword(value: string, salt = randomBytes(16)): Promise<string> {
  const hash = await derive('argon2id', {
    message: value, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32,
  });
  return `v1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(value: string, hash: string) {
  return same(await hashPassword(value, Buffer.from(hash.split(':')[1], 'hex')), hash);
}

export function seal(key: Buffer, id: string, plain: Buffer) {
  return sealBytes(key, id, plain).toString('hex');
}

export function sealBytes(key: Buffer, id: string, plain: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function unseal(key: Buffer, id: string, encrypted: string) {
  return unsealBytes(key, id, Buffer.from(encrypted, 'hex'));
}

export function unsealBytes(key: Buffer, id: string, bytes: Buffer) {
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
}

export function totpAt(secret: Buffer, step: number, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(number).padStart(digits, '0');
}
