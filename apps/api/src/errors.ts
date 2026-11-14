import type { ErrorCode } from '@teta/contracts';

export class AccessError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryAfter?: number;

  constructor(status: number, code: ErrorCode, retryAfter?: number) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const authInvalid = new AccessError(401, 'ADMIN_AUTH_INVALID');
export const deviceRevoked = new AccessError(403, 'DEVICE_REVOKED');
export const sessionExpired = new AccessError(401, 'SESSION_EXPIRED');
export const pinInvalid = new AccessError(401, 'PIN_INVALID');
export const pinLocked = new AccessError(403, 'PIN_LOCKED');

export function limited(expiresAt: number, now: number) {
  return new AccessError(429, 'RATE_LIMITED', Math.max(1, Math.ceil((expiresAt - now) / 1000)));
}
