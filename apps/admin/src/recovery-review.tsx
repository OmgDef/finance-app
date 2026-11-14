import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Body, Language, Result } from '@teta/contracts';
import { auditWords } from './audit-copy';
import { financeWords } from './finance-copy';
import { AdminLink, adminPaths, navigate } from './navigation';
import './audit.css';

type User = Result<'createUser'>;
type Decision = Body<'adminReviewRecoveredUser'>;

export function RecoveryReview({ user, lang, busy, error, onSave }: {
  user: User; lang: Language; busy: boolean; error?: string; onSave: (decision: Decision) => void;
}) {
  const t = auditWords[lang];
  const f = financeWords[lang];
  const [invalid, setInvalid] = useState(false);
  const done = user.status !== 'review';
  const conflicted = error === 'ACCOUNT_REVIEW_CONFLICT';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || conflicted) return;
    const fields = new FormData(event.currentTarget);
    const status = fields.get('status');
    const source = fields.get('source');
    const reason = String(fields.get('reason') ?? '').trim();
    if ((status !== 'active' && status !== 'blocked') || !reason ||
        (source !== 'post_snapshot_records' && source !== 'service_owner_confirmation')) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSave({ status, source, reason });
  }

  return <section data-testid="admin-recovery-review" className="audit-shell recovery-review">
    <AdminLink className="text-button" href={adminPaths.users} disabled={busy}>← {f.back}</AdminLink>
    <h1>{t.reviewTitle}</h1>
    <p className="muted recovery-owner">{user.email}</p>
    {done ? <p role="status" className="finance-notice">{user.status === 'active' ? t.savedActive : t.savedBlocked}</p> : <>
      <p>{t.reviewHelp}</p>
      <form onSubmit={submit} onChange={() => setInvalid(false)}>
        <fieldset disabled={busy || conflicted} className="finance-fields">
          <div className="finance-form-grid">
            <label>{t.decision}<select name="status" required defaultValue="">
              <option value="" disabled>{t.choose}</option>
              <option value="active">{t.active}</option>
              <option value="blocked">{t.blocked}</option>
            </select></label>
            <label>{t.source}<select name="source" required defaultValue="" data-testid="admin-recovery-source">
              <option value="" disabled>{t.choose}</option>
              <option value="post_snapshot_records">{t.post_snapshot_records}</option>
              <option value="service_owner_confirmation">{t.service_owner_confirmation}</option>
            </select></label>
            <label className="full-row">{t.reviewReason}<textarea name="reason" required maxLength={500} rows={3} /></label>
          </div>
          <div className="row-actions"><button className="primary">{t.save}</button>
            <button type="button" className="text-button" onClick={() => navigate(adminPaths.users)}>{t.keepReview}</button></div>
        </fieldset>
      </form>
      {(error || invalid) && <p role="alert" className="error">{conflicted ? t.reviewConflict :
        f.errors[error ?? 'INVALID_REQUEST'] ?? f.errors.NETWORK}</p>}
    </>}
  </section>;
}
