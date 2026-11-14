import type { Language } from './index.ts';

export type Currency = 'USD' | 'EUR' | 'RUB';

export function amountInMinorUnits(value: string, lang: Language): string | undefined {
  const normalized = value.trim().replace(/^−/, '-').replace(/[\u00a0\u202f]/g, ' ');
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const decimal = lang === 'ru' ? ',' : '.';
  const grouping = lang === 'ru' ? ' ' : ',';
  const parts = unsigned.split(decimal);
  const [whole, fraction] = parts;
  if (parts.length > 2 || (fraction !== undefined && !/^[0-9]{1,2}$/.test(fraction))) return undefined;
  const groups = whole.split(grouping);
  if (!/^[0-9]+$/.test(groups[0]) ||
      (groups.length > 1 && (groups[0].length > 3 || groups.slice(1).some((group) => !/^[0-9]{3}$/.test(group))))) {
    return undefined;
  }
  const digits = (groups.join('') + (fraction ?? '').padEnd(2, '0')).replace(/^0+(?=[0-9])/, '');
  const limit = negative ? '9223372036854775808' : '9223372036854775807';
  if (digits.length > limit.length || (digits.length === limit.length && digits > limit)) return undefined;
  return negative && digits !== '0' ? '-' + digits : digits;
}

export function formatAmount(minor: string, lang: Language, showPlus = false) {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'ru' ? '\u202f' : ',');
  const sign = negative ? '−' : showPlus && minor !== '0' ? '+' : '';
  return sign + whole + (lang === 'ru' ? ',' : '.') + digits.slice(-2);
}

export function formatMoney(minor: string, currency: Currency, lang: Language, showPlus = false) {
  return formatAmount(minor, lang, showPlus) + ' ' + currency;
}
