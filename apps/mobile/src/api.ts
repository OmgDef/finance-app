import { endpoints } from '@teta/contracts/client';
import type { Body, Params, Result, Route } from '@teta/contracts';

export class ApiError extends Error {
  constructor(code: string) { super(code); }
}
const configuredOrigin = process.env.EXPO_PUBLIC_API_ORIGIN;
const origin = (() => {
  if (!configuredOrigin) return undefined;
  const url = new URL(configuredOrigin);
  const httpAllowed = __DEV__ && url.protocol === 'http:';
  if ((url.protocol === 'https:' || httpAllowed) && url.origin === configuredOrigin) return url.origin;
  return undefined;
})();

export async function request<K extends Route>(
  name: K, options: { body?: Body<K>; token?: string; query?: URLSearchParams; params?: Params<K> } = {},
): Promise<Result<K>> {
  if (!origin) throw new ApiError('API_CONFIGURATION');
  const route = endpoints[name];
  const params: Record<string, string> | undefined = options.params;
  const path = route.url.replace(/:([^/]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new ApiError('INVALID_REQUEST');
    return encodeURIComponent(value);
  });
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(origin + path + (options.query ? '?' + options.query.toString() : ''), {
      method: route.method, headers, body: options.body && JSON.stringify(options.body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.code);
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('NETWORK');
  } finally {
    clearTimeout(timeout);
  }
}
