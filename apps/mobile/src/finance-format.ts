import type { Language } from '@teta/contracts';
import { currencySymbol } from '@teta/contracts/money';
import type { Currency } from '@teta/contracts/money';

export { amountInMinorUnits, currencyName, currencySymbol, formatAmount, formatMoney } from '@teta/contracts/money';
export type { Currency } from '@teta/contracts/money';
export const currencies: readonly Currency[] = ['USD', 'EUR', 'RUB'];

export function formatFinancialDate(date: string, lang: Language) {
  const [year, month, day] = date.split('-');
  return lang === 'ru' ? [day, month, year].join('.') : [month, day, year].join('/');
}

// Android's system dialog applies its bounds in the device time zone. On iOS the picker uses UTC.
export function dateForPicker(date: string, utc = false) {
  if (utc) return new Date(date + 'T12:00:00Z');
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

export function dateFromPicker(date: Date, utc = false) {
  if (utc) return date.toISOString().slice(0, 10);
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  return parts.map((part) => String(part).padStart(2, '0')).join('-');
}

export function dateInTimeZone(date: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date);
    const part = (name: string) => parts.find(({ type }) => type === name)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    if (year && month && day) return [year.padStart(4, '0'), month, day].join('-');
  } catch {
    // The device can have older time zone data than the server.
  }
}

export function addFinancialDays(date: string, days: number) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function formatChartAmount(minor: bigint | number, lang: Language) {
  return new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-US', {
    notation: 'compact', maximumFractionDigits: 2,
  }).format(Number(minor) / 100);
}

export function recentStatisticsPeriod(throughDate: string) {
  return { fromDate: addFinancialDays(throughDate, -89), throughDate };
}

export function formatProfileMoment(milliseconds: number, timeZone: string, lang: Language) {
  try {
    return new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
      timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZoneName: 'shortOffset',
    }).format(milliseconds);
  } catch {
    return new Date(milliseconds).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

export function financialDate(value: string, lang: Language): string | undefined {
  const input = value.trim();
  const iso = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(input);
  const localized = (lang === 'ru' ? /^(\d{2})\.(\d{2})\.([1-9]\d{3})$/ : /^(\d{2})\/(\d{2})\/([1-9]\d{3})$/).exec(input);
  const parts = iso?.slice(1) ?? (localized && (lang === 'ru'
    ? [localized[3], localized[2], localized[1]] : [localized[3], localized[1], localized[2]]));
  if (!parts) return undefined;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const result = [year, month, day].join('-');
  if (date.toISOString().slice(0, 10) === result) return result;
}

export function depositRate(value: string, lang: Language): string | undefined {
  const normalized = value.trim().replace(lang === 'ru' ? ',' : '.', '.');
  if (/^(0|[1-9][0-9]{0,2})(\.\d{1,4})?$/.test(normalized)) return normalized;
}

export function formatRate(rate: string, lang: Language) {
  return rate.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('.', lang === 'ru' ? ',' : '.');
}

export function formatTransferRate(fromMinor: string, toMinor: string, from: Currency, to: Currency, lang: Language) {
  const debit = BigInt(fromMinor);
  const credit = BigInt(toMinor);
  if (debit <= 0n || credit <= 0n) return undefined;

  // Show six decimal places, extending the precision for small ratios so a positive rate never displays as zero.
  let places = 6;
  let scale = 1000000n;
  while (credit * scale < debit) {
    scale *= 10n;
    places++;
  }
  const numerator = credit * scale;
  const remainder = numerator % debit;
  const rounded = numerator / debit + (remainder * 2n >= debit ? 1n : 0n);
  const digits = String(rounded).padStart(places + 1, '0');
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, '');
  const formatted = fraction ? whole + (lang === 'ru' ? ',' : '.') + fraction : whole;
  return '1\u00a0' + currencySymbol(from) + (remainder ? ' ≈ ' : ' = ') + formatted + '\u00a0' + currencySymbol(to);
}
