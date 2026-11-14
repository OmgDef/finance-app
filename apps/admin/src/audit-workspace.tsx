import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuditQuery, Language, Result } from '@teta/contracts';
import { api, errorCode } from './api';
import { auditEvents, auditWords } from './audit-copy';
import { financeWords } from './finance-copy';
import { Failure, useQuery } from './finance-ui';
import { scheduleWords } from './schedule-copy';
import './audit.css';

type Filters = Omit<AuditQuery, 'before'>;
type Page = Result<'adminListAudit'>;
type Event = Page['events'][number];

function displayEvent(event: string, lang: Language) {
  return auditEvents[event]?.[lang === 'en' ? 0 : 1] ?? event;
}

function displayTransition(value: string | undefined, lang: Language) {
  if (value === undefined) return auditWords[lang].missing;
  const schedule = scheduleWords[lang];
  const states: Record<string, string> = {
    active: schedule.active, blocked: auditWords[lang].blockedState, review: auditWords[lang].reviewState,
    paused: schedule.paused, ended: schedule.ended, posted: schedule.posted, void: financeWords[lang].void,
    planned: schedule.planned, skipped: schedule.skipped, due: schedule.due, retrying: schedule.retrying,
    needs_intervention: schedule.needs_intervention,
  };
  return states[value] ?? value;
}

function AuditRow({ entry, lang }: { entry: Event; lang: Language }) {
  const t = auditWords[lang];
  const transition = entry.transition;
  const roles = { operator: t.operator, admin: t.admin, user: t.userRole };
  const role = roles[entry.actorRole];
  const actor = entry.actorLogin ?? (entry.actorRole === 'user' && entry.actorId === entry.userId ? entry.userEmail : entry.actorId);
  const instant = new Date(entry.happenedAt);
  const time = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(instant) + ' · ' +
    instant.toISOString().slice(11, 23) + ' UTC';
  return <article className="audit-event" data-testid={'admin-audit-event-' + entry.id}>
    <div className="audit-event-title">
      <h2>{displayEvent(entry.event, lang)}</h2><time dateTime={entry.happenedAt}>{time}</time>
    </div>
    <dl className="audit-fields">
      <div><dt>{t.actor}</dt><dd>{role}{actor && ' · ' + actor}</dd></div>
      <div><dt>{t.owner}</dt><dd>{entry.userEmail ?? entry.userId ?? t.missing}</dd></div>
      <div><dt>{t.object}</dt><dd>{entry.objectId ?? t.missing}</dd></div>
      {(transition?.from !== undefined || transition?.to !== undefined) && <div>
        <dt>{t.transition}</dt><dd>{displayTransition(transition.from, lang)} → {displayTransition(transition.to, lang)}</dd>
      </div>}
      {transition?.source && <div><dt>{t.source}</dt><dd>{t[transition.source]}</dd></div>}
      {transition?.reason && <div className="audit-reason"><dt>{t.reason}</dt><dd>{transition.reason}</dd></div>}
    </dl>
  </article>;
}

export function AuditWorkspace({ lang, onExpired }: { lang: Language; onExpired: () => void }) {
  const t = auditWords[lang];
  const f = financeWords[lang];
  const [filters, setFilters] = useState<Filters>({});
  const [invalidRange, setInvalidRange] = useState(false);
  const [pages, setPages] = useState<{ first: Page; page: Page }>();
  const [pageError, setPageError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const scope = JSON.stringify(filters);
  const query = useQuery(scope, (signal) => api('adminListAudit', { query: filters, signal }), onExpired);
  const first = query.data;
  const report = pages?.first === first ? pages?.page : first;

  function resetPages() {
    pending.current?.abort();
    pending.current = undefined;
    setLoadingMore(false);
    setPages(undefined);
    setPageError('');
  }

  useEffect(() => () => pending.current?.abort(), []);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (key: string) => String(values.get(key) ?? '').trim() || undefined;
    const from = text('from');
    const through = text('through');
    if (from && through && from > through) { setInvalidRange(true); return; }
    setInvalidRange(false);
    resetPages();
    setFilters({ userEmail: text('userEmail'), adminLogin: text('adminLogin'), event: text('event'),
      from: from && from + 'T00:00:00.000Z', through: through && through + 'T23:59:59.999Z' });
    query.reload();
  }

  async function more() {
    if (!first || !report?.next || pending.current) return;
    const abort = new AbortController();
    pending.current = abort;
    setLoadingMore(true);
    setPageError('');
    try {
      const page = await api('adminListAudit', { query: { ...filters, before: report.next }, signal: abort.signal });
      if (abort.signal.aborted) return;
      setPages({ first, page: { events: [...report.events, ...page.events], next: page.next } });
    } catch (error) {
      if (abort.signal.aborted) return;
      const code = errorCode(error);
      if (code === 'ADMIN_AUTH_INVALID') onExpired();
      else setPageError(code);
    } finally {
      if (pending.current === abort) {
        pending.current = undefined;
        setLoadingMore(false);
      }
    }
  }

  return <section data-testid="admin-audit" className="audit-shell">
    <h1>{t.title}</h1>
    <form data-testid="admin-audit-filters" aria-label={t.filters} className="audit-filter" onSubmit={apply}
      onChange={() => setInvalidRange(false)} onReset={() => {
        setInvalidRange(false);
        resetPages();
        setFilters({});
        query.reload();
      }}>
      <div className="audit-filter-grid">
        <label>{t.user}<input name="userEmail" type="email" maxLength={254} /></label>
        <label>{t.administrator}<input name="adminLogin" type="email" maxLength={254} /></label>
        <label>{t.from}<input name="from" type="date" min="1000-01-01" max="9999-12-31" /></label>
        <label>{t.through}<input name="through" type="date" min="1000-01-01" max="9999-12-31" /></label>
        <label>{t.type}<input name="event" list="audit-event-types" maxLength={64} pattern="[a-z][a-z0-9_.\-]{0,63}" />
          <datalist id="audit-event-types">
            {Object.keys(auditEvents).map((name) => <option key={name} value={name}>{displayEvent(name, lang)}</option>)}
          </datalist>
        </label>
      </div>
      {invalidRange && <p className="error" role="alert">{t.invalidRange}</p>}
      <div className="row-actions"><button className="primary">{t.search}</button><button type="reset">{t.clear}</button></div>
    </form>
    {query.error === 'INVALID_REQUEST' ? <p className="error" role="alert">{t.invalidFilters}</p> :
      query.error && <Failure code={query.error} lang={lang} retry={query.reload} />}
    {!query.error && !report && <p role="status" className="muted">{f.loading}</p>}
    {report && !report.events.length && <p className="finance-empty" role="status">{t.empty}</p>}
    {!!report?.events.length && <div className="audit-events" aria-busy={loadingMore}>
      {report.events.map((entry) => <AuditRow key={entry.id} entry={entry} lang={lang} />)}
    </div>}
    {pageError && <Failure code={pageError} lang={lang} />}
    {report?.next && <button type="button" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? f.loading : f.more}</button>}
  </section>;
}
