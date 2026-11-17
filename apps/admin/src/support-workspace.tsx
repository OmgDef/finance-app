import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Body, Language, Result, SupportVariant } from '@teta/contracts';
import { supportVariants } from '@teta/contracts/client';
import { api, errorCode } from './api';
import { financeWords } from './finance-copy';
import { Failure, LabeledInput, useQuery } from './finance-ui';
import type { Session } from './finance-ui';
import './support.css';

type Support = Result<'adminGetSupport'>;
type Article = Support['faq'][number];
type Edit = { entry?: Article; position: number };
const variantNames = { a: 'A · TetaFinance', b: 'B · ComaBank' } satisfies Record<SupportVariant, string>;
const words = {
  en: {
    title: 'Support', variant: 'App variant', contacts: 'Public contacts', contactsHelp: 'Visible before sign-in. Leave a field blank to hide that contact.',
    email: 'Support email', phone: 'Support phone', saveContacts: 'Save contacts',
    faq: 'Frequently asked questions', add: 'Add question', edit: 'Edit question', remove: 'Delete question',
    removeConfirm: 'Delete this FAQ entry?', none: 'No questions have been added.', published: 'Published', draft: 'Draft',
    publish: 'Publish this question', position: 'Position', positionHelp: 'Lower positions appear first.',
    question: 'Question', answer: 'Answer', english: 'English', russian: 'Russian',
    badContacts: 'Enter a valid email and a phone number with 7–15 digits.',
    badArticle: 'Enter a valid position. To publish, complete both translations.',
    staleContacts: 'Contacts were changed by another session. Review the current settings and try again.',
    staleArticle: 'This question has changed. Open the current version before saving.',
    saved: 'Contacts saved.', savedArticle: 'Question saved.', deleted: 'Question deleted.',
  },
  ru: {
    title: 'Поддержка', variant: 'Вариант приложения', contacts: 'Публичные контакты', contactsHelp: 'Видны до входа. Пустое поле скрывает контакт.',
    email: 'Email поддержки', phone: 'Телефон поддержки', saveContacts: 'Сохранить контакты',
    faq: 'Частые вопросы', add: 'Добавить вопрос', edit: 'Изменить вопрос', remove: 'Удалить вопрос',
    removeConfirm: 'Удалить эту статью FAQ?', none: 'Вопросов пока нет.', published: 'Опубликован', draft: 'Черновик',
    publish: 'Опубликовать вопрос', position: 'Позиция', positionHelp: 'Меньшие позиции отображаются первыми.',
    question: 'Вопрос', answer: 'Ответ', english: 'Английский', russian: 'Русский',
    badContacts: 'Укажите корректный email и номер телефона из 7–15 цифр.',
    badArticle: 'Укажите корректную позицию. Для публикации заполните оба перевода.',
    staleContacts: 'Контакты изменены в другой сессии. Проверьте актуальные настройки и попробуйте снова.',
    staleArticle: 'Вопрос изменился. Откройте актуальную версию перед сохранением.',
    saved: 'Контакты сохранены.', savedArticle: 'Вопрос сохранён.', deleted: 'Вопрос удалён.',
  },
} as const;

export const supportTitle = { en: words.en.title, ru: words.ru.title } as const;

export function SupportWorkspace({ session, lang, onExpired }: {
  session: Session; lang: Language; onExpired: () => void;
}) {
  const t = words[lang];
  const f = financeWords[lang];
  const [variant, setVariant] = useState<SupportVariant>('a');
  const variantQuery = { variant };
  const query = useQuery(`${session.id}:${variant}`, (signal) => api('adminGetSupport', { signal, query: variantQuery }), onExpired);
  const [edit, setEdit] = useState<Edit>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'savedArticle' | 'deleted'>();
  const [failure, setFailure] = useState<{ code: string; area: 'contacts' | 'article' }>();
  const operation = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function changeVariant(next: SupportVariant) {
    if (operation.current) return;
    setVariant(next);
    setEdit(undefined);
    setNotice(undefined);
    setFailure(undefined);
  }

  async function save(area: 'contacts' | 'article', complete: 'saved' | 'savedArticle' | 'deleted',
    write: () => Promise<unknown>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      await write();
      if (!mounted.current) return;
      if (area === 'article') setEdit(undefined);
      setNotice(complete);
      query.reload();
    } catch (error) {
      if (!mounted.current) return;
      const code = errorCode(error);
      if (code === 'ADMIN_AUTH_INVALID') { onExpired(); return; }
      setFailure({ code, area });
      if (code === 'VERSION_CONFLICT' || code === 'NOT_FOUND') {
        if (area === 'article') setEdit(undefined);
        query.reload();
      }
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function submitContacts(event: FormEvent<HTMLFormElement>, expectedVersion: number) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = { email: String(data.get('email') ?? '').trim() || null,
      phone: String(data.get('phone') ?? '').trim() || null, expectedVersion };
    void save('contacts', 'saved', () => api('adminUpdateSupportContacts', { body, query: variantQuery, csrf: session.csrf }));
  }

  function submitArticle(fields: Body<'adminCreateFaq'>, current?: Article) {
    void save('article', 'savedArticle', () => current
      ? api('adminUpdateFaq', { body: { ...fields, expectedVersion: current.version },
        params: { faqId: current.id }, query: variantQuery, csrf: session.csrf })
      : api('adminCreateFaq', { body: fields, query: variantQuery, csrf: session.csrf }));
  }

  function removeArticle(entry: Article) {
    if (!window.confirm(t.removeConfirm)) return;
    void save('article', 'deleted', () => api('adminDeleteFaq', {
      params: { faqId: entry.id }, query: { ...variantQuery, expectedVersion: String(entry.version) }, csrf: session.csrf,
    }));
  }

  function showFailure(area: 'contacts' | 'article') {
    if (failure?.area !== area) return null;
    if (failure.code === 'VERSION_CONFLICT' || failure.code === 'NOT_FOUND') {
      return <p className="error" role="alert">{area === 'contacts' ? t.staleContacts : t.staleArticle}</p>;
    }
    if (failure.code === 'INVALID_REQUEST') {
      return <p className="error" role="alert">{area === 'contacts' ? t.badContacts : t.badArticle}</p>;
    }
    return <Failure code={failure.code} lang={lang} />;
  }

  const current = query.data;
  const position = Math.min(2147483647, (current?.faq.at(-1)?.position ?? 0) + 10);

  return <section className="support-workspace" data-testid="admin-support">
    <div className="finance-section-heading">
      <h1>{t.title}</h1>
      <label className="finance-fields">{t.variant}<select value={variant} disabled={busy} data-testid="admin-support-variant"
        onChange={(event) => changeVariant(event.target.value as SupportVariant)}>
        {supportVariants.map((item) => <option key={item} value={item}>{variantNames[item]}</option>)}
      </select></label>
    </div>
    {notice && <p className="finance-notice" role="status">{t[notice]}</p>}
    {query.error && <Failure code={query.error} lang={lang} retry={query.reload} />}
    {!current && !query.error && <p className="muted" role="status">{f.loading}</p>}
    {current && <>
      <section className="support-settings" aria-label={t.contacts}>
        <div><h2>{t.contacts}</h2><p className="muted">{t.contactsHelp}</p></div>
        <form className="support-panel" key={`${variant}:${current.contacts.version}`} data-testid="admin-support-contacts"
          onSubmit={(event) => submitContacts(event, current.contacts.version)}>
          <fieldset className="finance-fields" disabled={busy}>
            <LabeledInput label={t.email} name="email" type="email" maxLength={254} defaultValue={current.contacts.email ?? ''} />
            <LabeledInput label={t.phone} name="phone" type="tel" maxLength={32} defaultValue={current.contacts.phone ?? ''} />
            {showFailure('contacts')}
            <div className="row-actions"><button className="primary">{t.saveContacts}</button></div>
          </fieldset>
        </form>
      </section>
      <section className="support-faq" aria-label={t.faq}>
        <div className="finance-section-heading"><h2>{t.faq}</h2>
          <button type="button" disabled={busy} onClick={() => { setFailure(undefined); setEdit({ position }); }}
            data-testid="admin-support-add-faq">{t.add}</button></div>
        {showFailure('article')}
        {edit && <ArticleEditor key={edit.entry?.id ?? 'new'} edit={edit} lang={lang} busy={busy}
          onCancel={() => { setEdit(undefined); setFailure(undefined); }} onSave={submitArticle} />}
        {!current.faq.length && <p className="finance-empty">{t.none}</p>}
        {!!current.faq.length && <div className="history-list">
          {current.faq.map((entry) => <article key={entry.id} className="support-faq-row" data-testid={'admin-support-faq-' + entry.id}>
            <div>
              <h3>{(lang === 'en' ? entry.questionEn || entry.questionRu : entry.questionRu || entry.questionEn) || t.draft}</h3>
              <p className="muted">{entry.published ? t.published : t.draft} · {t.position} {entry.position}</p>
            </div>
            <div className="row-actions">
              <button type="button" disabled={busy} onClick={() => {
                setFailure(undefined);
                setEdit({ entry, position: entry.position });
              }}>{t.edit}</button>
              <button type="button" className="text-button" disabled={busy} onClick={() => removeArticle(entry)}>{t.remove}</button>
            </div>
          </article>)}
        </div>}
      </section>
    </>}
  </section>;
}

function ArticleEditor({ edit, lang, busy, onSave, onCancel }: {
  edit: Edit; lang: Language; busy: boolean;
  onSave: (fields: Body<'adminCreateFaq'>, current?: Article) => void; onCancel: () => void;
}) {
  const t = words[lang];
  const f = financeWords[lang];
  const [invalid, setInvalid] = useState(false);
  const { entry } = edit;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const value = (name: string) => String(fields.get(name) ?? '').trim();
    const position = Number(value('position'));
    const published = fields.has('published');
    const translations = { questionEn: value('questionEn'), answerEn: value('answerEn'),
      questionRu: value('questionRu'), answerRu: value('answerRu') };
    if (!Number.isInteger(position) || position < 0 || position > 2147483647 ||
        (published && Object.values(translations).some((field) => !field))) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSave({ ...translations, position, published }, entry);
  }

  return <form className="support-panel support-article" data-testid="admin-support-faq-editor" onSubmit={submit}
    onChange={() => setInvalid(false)}>
    <h3>{entry ? t.edit : t.add}</h3>
    <fieldset className="finance-fields" disabled={busy}>
      <div className="support-translations">
        <div className="finance-fields">
          <h4>{t.english}</h4>
          <LabeledInput label={t.question + ' · EN'} name="questionEn" maxLength={255} defaultValue={entry?.questionEn} />
          <label>{t.answer + ' · EN'}<textarea name="answerEn" rows={5} maxLength={4000} defaultValue={entry?.answerEn} /></label>
        </div>
        <div className="finance-fields">
          <h4>{t.russian}</h4>
          <LabeledInput label={t.question + ' · RU'} name="questionRu" maxLength={255} defaultValue={entry?.questionRu} />
          <label>{t.answer + ' · RU'}<textarea name="answerRu" rows={5} maxLength={4000} defaultValue={entry?.answerRu} /></label>
        </div>
      </div>
      <div className="support-publish">
        <label>{t.position}<input type="number" name="position" required min={0} max={2147483647} step={1}
          defaultValue={edit.position} aria-describedby="support-faq-position-help" />
          <span id="support-faq-position-help" className="muted">{t.positionHelp}</span></label>
        <label className="check-control"><input name="published" type="checkbox" defaultChecked={entry?.published} />{t.publish}</label>
      </div>
      {invalid && <p className="error" role="alert">{t.badArticle}</p>}
      <div className="row-actions"><button className="primary">{f.save}</button>
        <button type="button" className="text-button" onClick={onCancel}>{f.cancel}</button></div>
    </fieldset>
  </form>;
}
