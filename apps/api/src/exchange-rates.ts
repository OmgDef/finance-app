import { DOMParser } from '@xmldom/xmldom';
import type { Result } from '@teta/contracts';
import { localDateAt } from './calendar.ts';
import { AccessError } from './errors.ts';
import { minute } from './rates.ts';

type Snapshot = Result<'getExchangeRates'>;
type Quote = Snapshot['rates'][number];
const codes = { USD: 'R01235', EUR: 'R01239' } as const;
const currencies = ['USD', 'EUR'] as const;
const origin = 'https://www.cbr.ru/scripts/';

function sourceDate(date: string) {
  return date.split('-').reverse().join('/');
}

function parseHistory(xml: string, code: string) {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('Unexpected exchange rate XML');
  const document = new DOMParser({ errorHandler: () => { throw new Error('Invalid exchange rate XML'); } })
    .parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (root?.tagName !== 'ValCurs' || root.getAttribute('ID') !== code) throw new Error('Invalid exchange rate feed');

  const points = new Map<string, Quote['current']>();
  const records = root.getElementsByTagName('Record');
  for (let i = 0; i < records.length; i += 1) {
    const record = records.item(i)!;
    const rawDate = record.getAttribute('Date');
    const value = record.getElementsByTagName('Value').item(0)?.textContent?.trim().replace(',', '.');
    const nominal = Number(record.getElementsByTagName('Nominal').item(0)?.textContent);
    if (!rawDate || !/^\d{2}\.\d{2}\.\d{4}$/.test(rawDate) || record.getAttribute('Id') !== code ||
        !value || !/^\d+(\.\d{1,4})?$/.test(value) || !Number.isSafeInteger(nominal) || nominal <= 0) {
      throw new Error('Invalid exchange rate record');
    }
    const date = Temporal.PlainDate.from(rawDate.split('.').reverse().join('-')).toString();
    const rate = Number(value) / nominal;
    if (!(rate >= 0.0001 && rate < 1_000_000)) throw new Error('Invalid exchange rate value');
    points.set(date, { date, rate: rate.toFixed(4) });
  }
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function exchangeRates(clock: () => number, transport: typeof fetch = fetch) {
  let cached: { day: string; rates: Quote[] } | undefined;
  let validUntil = 0;
  let retryAfter = 0;
  let refresh: Promise<Snapshot> | undefined;

  async function read(currency: Quote['currency'], day: string): Promise<Quote> {
    const end = Temporal.PlainDate.from(day);
    const start = end.subtract({ days: 29 }).toString();
    const code = codes[currency];
    const url = new URL('XML_dynamic.asp', origin);
    url.search = new URLSearchParams({
      date_req1: sourceDate(end.subtract({ days: 44 }).toString()),
      date_req2: sourceDate(day),
      VAL_NM_RQ: code,
    }).toString();
    const response = await transport(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error('Exchange rate feed unavailable');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 128 * 1024) throw new Error('Exchange rate feed too large');
    const prefix = new TextDecoder().decode(bytes.slice(0, 128));
    const encoding = /encoding=["']windows-1251["']/i.test(prefix) ? 'windows-1251' : 'utf-8';
    const points = parseHistory(new TextDecoder(encoding).decode(bytes), code).filter(({ date }) => date <= day);
    const current = points.at(-1);
    if (!current || current.date < start) throw new Error('No current exchange rate');
    return { currency, current, previous: points.at(-2) ?? null, history: points.filter(({ date }) => date >= start) };
  }

  return async (): Promise<Snapshot> => {
    const now = clock();
    const day = localDateAt(now, 'Europe/Moscow');
    if (now < validUntil && cached?.day === day) return { stale: false, rates: cached.rates };
    if (now < retryAfter) {
      if (cached) return { stale: true, rates: cached.rates };
      throw new AccessError(503, 'TEMPORARY_FAILURE');
    }
    refresh ??= Promise.allSettled(currencies.map((currency) => read(currency, day)))
      .then((results) => {
        const rates = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
        if (rates.length === currencies.length) {
          cached = { day, rates };
          validUntil = clock() + 30 * minute;
          return { stale: false, rates };
        }
        retryAfter = clock() + minute;
        if (cached) return { stale: true, rates: cached.rates };
        throw new AccessError(503, 'TEMPORARY_FAILURE');
      }).finally(() => { refresh = undefined; });
    return refresh;
  };
}
