import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ComponentProps, ReactNode } from 'react';
import type { Language, Result } from '@teta/contracts';
import { amountInMinorUnits, currencySymbol, formatAmount, formatMoney } from '@teta/contracts/money';
import type { Currency } from '@teta/contracts/money';
import { errorCode } from './api';
import { financeWords } from './finance-copy';
import { AdminLink } from './navigation';

export type Account = Result<'adminListAccounts'>['accounts'][number];
export type Category = Result<'adminListCategories'>['categories'][number];
export type Session = Result<'adminMe'>;

export function transactionAmountClass(amountMinor: string) {
  if (amountMinor === '0') return 'money';
  return amountMinor.startsWith('-') ? 'money money-debit' : 'money money-credit';
}

export function useQuery<T>(key: string, load: (signal: AbortSignal) => Promise<T>, onExpired: () => void) {
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; revision: number; data?: T; error?: string }>();
  const current = useRef(key);
  current.current = key;
  useEffect(() => {
    if (!key) return;
    const abort = new AbortController();
    void load(abort.signal).then((data) => {
      if (!abort.signal.aborted && current.current === key) setSnapshot({ key, revision, data });
    }).catch((error: unknown) => {
      if (abort.signal.aborted || current.current !== key) return;
      const code = errorCode(error);
      if (code === 'ADMIN_AUTH_INVALID') onExpired();
      else setSnapshot({ key, revision, error: code });
    });
    return () => abort.abort();
  }, [key, revision]);
  const visible = snapshot?.key === key && snapshot.revision === revision ? snapshot : undefined;
  return { ...visible, previous: snapshot?.key === key ? snapshot.data : undefined, reload: () => setRevision((value) => value + 1) };
}

export function useAmount(initial: string | undefined, lang: Language) {
  const [input, setInput] = useState<{ text: string; lang: Language }>();
  const value = input ? amountInMinorUnits(input.text, input.lang) : initial;
  const text = input && input.lang === lang ? input.text : value !== undefined ? formatAmount(value, lang) : input?.text ?? '';
  return { value, field: { value: text, inputMode: 'decimal' as const, maxLength: 30,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setInput({ text: event.target.value, lang }) } };
}

export function dateLabel(value: string, lang: Language) {
  const [year, month, day] = value.split('-');
  return lang === 'ru' ? `${day}.${month}.${year}` : `${month}/${day}/${year}`;
}

export const firstFinancialDate = '1000-01-01';
export const lastFinancialDate = '9999-12-31';

export function shiftDate(iso: string, days: number) {
  const value = new Date(iso + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  const date = value.toISOString().split('T')[0];
  if (date.startsWith('-') || date < firstFinancialDate) return firstFinancialDate;
  if (date.startsWith('+') || date > lastFinancialDate) return lastFinancialDate;
  return date;
}

export function categoryLabel(id: string | null, categories: Category[], lang: Language) {
  const item = categories.find((category) => category.id === id);
  return item ? (lang === 'ru' ? item.nameRu : item.nameEn) : id;
}

export function Failure({ code, lang, retry }: { code: string; lang: Language; retry?: () => void }) {
  const t = financeWords[lang];
  return <div className="finance-failure"><p role="alert" className="error">{t.errors[code] ?? t.errors.NETWORK}</p>
    {retry && <button type="button" className="text-button" onClick={retry}>{t.retry}</button>}
  </div>;
}

export function LabeledInput({ label, currency, ...input }: ComponentProps<'input'> & { label: string; currency?: Currency }) {
  const unit = currency && currencySymbol(currency);
  const field = <input {...input} aria-label={unit ? `${label} (${unit})` : input['aria-label']}
    placeholder={input.placeholder ?? (unit ? '0' : undefined)} />;
  return <label>{label}{unit ? <span className="currency-input">{field}<span aria-hidden="true">{unit}</span></span> : field}</label>;
}

export function AccountPicker({ label, accounts, value, onChange }: {
  label: string; accounts: Account[]; value: string; onChange: (value: string) => void;
}) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)} required>
    {accounts.map(({ accountId, name }) => <option key={accountId} value={accountId}>{name}</option>)}
  </select></label>;
}

export function BalanceImpact({ rows, lang }: { lang: Language; rows: {
  id: string; name: string; currency: Account['currency']; before: string; after: string;
}[] }) {
  const t = financeWords[lang];
  return <section className="balance-impact" aria-label={t.balanceImpact}>
    <h3>{t.balanceImpact}</h3>
    {rows.map((row) => {
      const delta = BigInt(row.after) - BigInt(row.before);
      return <div className="impact-row" key={row.id}>
        <strong>{row.name}</strong>
        <dl><div><dt>{t.before}</dt><dd>{formatMoney(row.before, row.currency, lang)}</dd></div>
          <div><dt>{t.after}</dt><dd>{formatMoney(row.after, row.currency, lang)}</dd></div>
          <div><dt>{t.delta}</dt><dd className={delta === 0n ? 'muted' : 'changed-amount'}>{formatMoney(String(delta), row.currency, lang, true)}</dd></div>
        </dl>
      </div>;
    })}
  </section>;
}

export function EditorHeading({ title, onClose, closeHref, children }: { title: string; children: ReactNode } &
  ({ onClose: () => void; closeHref?: never } | { closeHref: string; onClose?: never })) {
  return <section className="finance-editor">
    <div className="finance-section-heading">
      <h2>{title}</h2>
      {closeHref ? <AdminLink className="text-button" href={closeHref} aria-label={title + ' ×'}>×</AdminLink>
        : <button className="text-button" onClick={onClose} type="button" aria-label={title + ' ×'}>×</button>}
    </div>
    {children}
  </section>;
}

export function ConfirmDeletion({ label, message, lang, disabled, feedback, onConfirm, onCancel }: {
  label: string; message: string; lang: Language; disabled: boolean; feedback?: ReactNode;
  onConfirm: (reason: string) => void; onCancel: () => void;
}) {
  const t = financeWords[lang];
  const [reason, setReason] = useState('');
  const explanation = reason.trim();
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (!disabled && explanation) onConfirm(explanation);
  }}>
    {feedback}
    <fieldset className="finance-fields" disabled={disabled}>
      <p>{message}</p>
      <label>{t.reason}<textarea value={reason} maxLength={500} rows={2} required
        onChange={(event) => setReason(event.target.value)} /></label>
      <div className="row-actions">
        <button type="submit" className="destructive" disabled={!explanation}>{label}</button>
        <button type="button" className="text-button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </fieldset>
  </form>;
}
