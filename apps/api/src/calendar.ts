type CalendarDate = Temporal.PlainDate;
const compareDates = (a: CalendarDate, b: CalendarDate) => Temporal.PlainDate.compare(a, b);

export type Frequency = 'once' | 'weekly' | 'monthly';
export type ZoneVersion = { effectiveAt: number; timeZone: string };
type RuleState = 'active' | 'paused' | 'ended';
type RuleParameters = { amountMinor: string; categoryId: string; comment: string | null; source: string | null; endDate: string | null; state: RuleState };

export type RuleVersion = {
  version: number;
  acceptedAt: number;
  effectiveAt: number;
  changes: Partial<RuleParameters>;
};

export type CalendarRule = {
  id: string;
  accountId: string;
  kind: 'income' | 'expense';
  frequency: Frequency;
  firstDate: string;
  createdAt: number;
  startsAt: number | null;
  endsBeforeDate: string | null;
  versions: readonly RuleVersion[];
};

export type ScheduleWindow = { fromDate: string; throughDate: string; asOf: number };

export type ScheduledDate = {
  ruleId: string;
  accountId: string;
  kind: CalendarRule['kind'];
  date: string;
  dueAt: number;
  ruleVersion: number;
  amountMinor: string;
  categoryId: string;
  comment: string | null;
  source?: string;
  status: 'planned' | 'due' | 'paused';
};

export function localDateAt(instant: number, timeZone: string) {
  return Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function startOfLocalDay(date: CalendarDate, timeZone: string) {
  return date.toZonedDateTime(timeZone).epochMilliseconds;
}

export function nextLocalDayStart(instant: number, timeZone: string) {
  const nextDate = Temporal.PlainDate.from(localDateAt(instant, timeZone)).add({ days: 1 });
  return startOfLocalDay(nextDate, timeZone);
}

function* recurrence(first: CalendarDate, from: CalendarDate, through: CalendarDate, frequency: Frequency) {
  if (frequency === 'once') {
    if (compareDates(first, from) >= 0 && compareDates(first, through) <= 0) yield first;
    return;
  }

  const weeksFromStart = Math.floor(first.until(from, { largestUnit: 'day' }).days / 7);
  const monthsFromStart = (from.year - first.year) * 12 + from.month - first.month;
  let offset = Math.max(0, frequency === 'weekly' ? weeksFromStart : monthsFromStart);
  for (;;) {
    // Use the original day of month on every iteration, including after February.
    const date = frequency === 'weekly' ? first.add({ weeks: offset }) : first.add({ months: offset });
    if (compareDates(date, through) > 0) return;
    if (compareDates(date, from) >= 0) yield date;
    offset++;
  }
}

function dueInZoneHistory(date: CalendarDate, createdAt: number, zones: readonly ZoneVersion[]) {
  let timeZone = 'UTC';
  let activeSince = createdAt;
  for (const version of zones) {
    if (version.effectiveAt > createdAt) {
      const dueAt = Math.max(activeSince, startOfLocalDay(date, timeZone));
      if (dueAt <= version.effectiveAt) return dueAt;
      activeSince = version.effectiveAt;
    }
    timeZone = version.timeZone;
  }
  return Math.max(activeSince, startOfLocalDay(date, timeZone));
}

export function latestPossibleDueDate(asOf: number) {
  // An IANA offset is less than one day. Include tomorrow in UTC even if a zone moved its clock back.
  return Temporal.PlainDate.from(localDateAt(asOf, 'UTC')).add({ days: 1 }).toString();
}

export function scheduleSettingsAt(versions: readonly RuleVersion[], instant: number) {
  const settings: Partial<RuleParameters> = { comment: null, endDate: null, state: 'active' };
  let ruleVersion = 0;
  for (const version of versions) {
    if (version.effectiveAt > instant) continue;
    if (settings.state === 'ended') break;
    Object.assign(settings, version.changes);
    ruleVersion = version.version;
  }
  return { settings, ruleVersion };
}

export function* calculateScheduleDates(rule: CalendarRule, history: readonly ZoneVersion[],
  window: ScheduleWindow,
): Generator<ScheduledDate> {
  if (rule.createdAt > window.asOf) return;
  const zones = history.filter(({ effectiveAt }) => effectiveAt <= window.asOf).sort((a, b) => a.effectiveAt - b.effectiveAt);
  const versions = rule.versions.filter(({ acceptedAt }) => acceptedAt <= window.asOf).sort((a, b) => a.version - b.version);
  const lastEndDateEdit = versions.reduce((latest, version) => version.changes.endDate !== undefined
    ? Math.max(latest, version.effectiveAt) : latest, -Infinity);
  const first = Temporal.PlainDate.from(rule.firstDate);
  const from = Temporal.PlainDate.from(window.fromDate);
  const through = Temporal.PlainDate.from(window.throughDate);
  for (const candidate of recurrence(first, from, through, rule.frequency)) {
    const date = candidate.toString();
    if (rule.endsBeforeDate !== null && date >= rule.endsBeforeDate) return;
    const dueAt = Math.max(dueInZoneHistory(candidate, rule.createdAt, zones), rule.startsAt ?? rule.createdAt);
    const { settings, ruleVersion } = scheduleSettingsAt(versions, dueAt);
    const { amountMinor, categoryId, comment = null, source, endDate, state } = settings;
    if (state === 'ended') return;
    if (endDate && date > endDate) {
      if (dueAt >= lastEndDateEdit) return;
      continue;
    }
    if (!amountMinor || !categoryId) throw new Error(`Incomplete schedule parameters for rule ${rule.id}`);
    yield { ruleId: rule.id, accountId: rule.accountId, kind: rule.kind, date, dueAt, ruleVersion, amountMinor, categoryId, comment,
      ...(source && { source }), status: state === 'paused' ? 'paused' : dueAt <= window.asOf ? 'due' : 'planned' };
  }
}
