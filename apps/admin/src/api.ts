import { endpoints } from '@teta/contracts/client';
import type { Body, Params, Result, Route } from '@teta/contracts';

export class ApiError extends Error {
  constructor(code: string, readonly retryAfter?: number) { super(code); }
}

export const errorCode = (error: unknown) => error instanceof ApiError ? error.message : 'NETWORK';

export async function api<K extends Route>(name: K, options: {
  body?: Body<K>; csrf?: string; params?: Params<K>; query?: Record<string, string | undefined>; signal?: AbortSignal;
} = {}): Promise<Result<K>> {
  const route = endpoints[name];
  const params: Record<string, string> | undefined = options.params;
  const path = route.url.replace(/:([^/]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new ApiError('INVALID_REQUEST');
    return encodeURIComponent(value);
  });
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.csrf) headers.set('X-CSRF-Token', options.csrf);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) query.set(key, value);
  }
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(path + (query.size ? '?' + query : ''), {
    method: route.method, credentials: 'same-origin', headers,
    body: options.body && JSON.stringify(options.body),
    signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
  });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.code, value.retryAfter);
  return value;
}
