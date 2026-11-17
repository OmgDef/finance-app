import Constants from 'expo-constants';
import { endpoints } from '@teta/contracts/client';
import type { AccountStatementQuery, Body, Params, Result, Route } from '@teta/contracts';

export class ApiError extends Error {
  constructor(code: string) { super(code); }
}
const embeddedOrigin = Constants.expoConfig?.extra?.apiOrigin;
const configuredOrigin = typeof embeddedOrigin === 'string' ? embeddedOrigin : process.env.EXPO_PUBLIC_API_ORIGIN;
const origin = (() => {
  if (!configuredOrigin) return undefined;
  const url = new URL(configuredOrigin);
  const httpAllowed = __DEV__ && url.protocol === 'http:';
  if ((url.protocol === 'https:' || httpAllowed) && url.origin === configuredOrigin) return url.origin;
  return undefined;
})();

type RequestOptions<K extends Route> = {
  body?: Body<K>; token?: string; query?: URLSearchParams; params?: Params<K>; signal?: AbortSignal;
};

export function request<K extends Exclude<Route, 'getAccountStatement'>>(name: K, options: RequestOptions<K> = {}): Promise<Result<K>> {
  return readResponse(name, options, (response) => response.json());
}

export async function requestAccountStatement(accountId: string, query: AccountStatementQuery, token: string, signal: AbortSignal) {
  const accountRequest = { token, params: { accountId }, signal };
  try {
    return await readResponse('getAccountStatement', { ...accountRequest, query: new URLSearchParams(query) }, async (response) => {
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf') {
        throw new ApiError('INVALID_STATEMENT');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new ApiError('INVALID_STATEMENT');
      return bytes;
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.message !== 'NOT_FOUND' || signal.aborted) throw error;
    // Older servers return the same 404 for a missing statement route and a missing account.
    await request('getAccountBalance', accountRequest);
    throw new ApiError('STATEMENT_UNAVAILABLE');
  }
}

async function readResponse<K extends Route, T>(name: K, options: RequestOptions<K>,
  read: (response: Pick<Response, 'json' | 'arrayBuffer' | 'headers'>) => Promise<T>,
): Promise<T> {
  if (!origin) throw new ApiError('API_CONFIGURATION');
  const route = endpoints[name];
  const params: Record<string, string> | undefined = options.params;
  const path = route.url.replace(/:([^/]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new ApiError('INVALID_REQUEST');
    return encodeURIComponent(value);
  });
  const pdf = name === 'getAccountStatement';
  const headers: Record<string, string> = { Accept: pdf ? 'application/pdf' : 'application/json' };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  const { signal } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort);
  const timeout = setTimeout(abort, pdf ? 30_000 : 10_000);
  try {
    const send = pdf ? (await import('expo/fetch')).fetch : fetch;
    const response = await send(origin + path + (options.query ? '?' + options.query.toString() : ''), {
      method: route.method, headers, body: options.body && JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json();
      throw new ApiError(data.code);
    }
    return await read(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('NETWORK');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
