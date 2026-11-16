import type { Language } from '@teta/contracts';
import { timeZoneAliases, timeZoneCities } from './time-zone-data.ts';

export type TimeZoneOption = {
  id: string;
  name: string;
  offset?: string;
  device: boolean;
  search: string;
};

export function timeZoneCityId(id: string) {
  return timeZoneAliases[id] ?? id;
}

function cityName(id: string, lang: Language) {
  const names = timeZoneCities[timeZoneCityId(id)];
  return names?.[lang === 'ru' ? 1 : 0] ?? id.split('/').at(-1)!.replaceAll('_', ' ');
}

function utcOffset(id: string, now: number) {
  if (timeZoneCityId(id) === 'UTC') return 'UTC';
  try {
    // Date parts also work on runtimes whose Intl does not support offset-style names.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: id, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const { year, month, day, hour, minute } = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
    const localTime = Date.UTC(year, month - 1, day, hour % 24, minute);
    const offset = localTime / 60_000 - Math.floor(now / 60_000);
    if (!Number.isFinite(offset)) return undefined;
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
    return `UTC${offset < 0 ? '-' : '+'}${hours}:${minutes}`;
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

function zoneName(id: string, lang: Language, offset?: string) {
  if (timeZoneCityId(id) === 'UTC') return 'UTC';
  if (id.startsWith('Etc/GMT') && offset) return offset;
  return cityName(id, lang);
}

export function timeZoneLabel(id: string, lang: Language, now = Date.now()) {
  const offset = utcOffset(id, now);
  const name = zoneName(id, lang, offset);
  return offset && name !== offset ? `${name} · ${offset}` : name;
}

function searchKey(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[_/]/g, ' ').replace(/([+-])0(?=\d)/g, '$1');
}

export function filterTimeZones(options: TimeZoneOption[], query: string) {
  const terms = searchKey(query).trim().split(/\s+/).filter(Boolean);
  return terms.length ? options.filter((option) => terms.every((term) => option.search.includes(term))) : options;
}

export function timeZoneOptions(lang: Language, current: string, device: string | null, now = Date.now()) {
  const deviceCity = device && timeZoneCityId(device);
  const seen = new Set<string>();
  const preferred: TimeZoneOption[] = [];
  const others: TimeZoneOption[] = [];
  for (const id of [current, device, 'UTC', ...Object.keys(timeZoneCities)]) {
    if (!id) continue;
    const city = timeZoneCityId(id);
    if (seen.has(city)) continue;
    const offset = utcOffset(id, now);
    if (!offset && id !== current) continue;
    seen.add(city);
    const name = zoneName(id, lang, offset);
    const option = {
      id, name, offset, device: city === deviceCity,
      search: searchKey([name, cityName(id, 'en'), cityName(id, 'ru'), id, city, offset].join(' ')),
    };
    (id === current || id === device || id === 'UTC' ? preferred : others).push(option);
  }
  return [...preferred, ...others.sort((a, b) => a.name.localeCompare(b.name, lang))];
}
