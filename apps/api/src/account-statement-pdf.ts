import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { appVariants } from '@teta/contracts/client';
import type { AppVariant } from '@teta/contracts/client';
import { currencySymbol, formatAmount } from '@teta/contracts/money';
import PDFDocument from 'pdfkit';
import type { AccountStatement } from './finance.ts';

const regular = fileURLToPath(new URL('../fonts/NotoSans-Regular.ttf', import.meta.url));
const bold = fileURLToPath(new URL('../fonts/NotoSans-Bold.ttf', import.meta.url));
const themes = {
  a: {
    logo: fileURLToPath(new URL('../../mobile/assets/theta.png', import.meta.url)),
    headerFill: '#E9F1FF', headerInk: '#17263A',
    ink: '#17263A', muted: '#53647A', panel: '#F0F4F9', rule: '#DFE6EF',
  },
  b: {
    logo: fileURLToPath(new URL('../../mobile/assets/app-icon/wallet/splash-logo.png', import.meta.url)),
    headerFill: '#1A1325', headerInk: '#F6F4FA',
    ink: '#24212C', muted: '#625D70', panel: '#F3EBFC', rule: '#E6DDEF',
  },
};
const margin = 48;

const labels = {
  en: {
    title: 'Account statement', generated: 'Generated', holder: 'Account holder',
    opening: 'Opening balance', closing: 'Closing balance', incoming: 'Money in', outgoing: 'Money out', adjustments: 'Reconciliations',
    date: 'Date', kind: 'Type', description: 'Description', amount: 'Amount', income: 'Income', expense: 'Expense',
    inTransfer: 'Transfer in', outTransfer: 'Transfer out', adjustment: 'Reconciliation',
    empty: 'No entries for this period.', note: (brand: string) => `Generated from ${brand} records for personal bookkeeping.`,
  },
  ru: {
    title: 'Выписка по счёту', generated: 'Сформировано', holder: 'Владелец счёта',
    opening: 'Входящий остаток', closing: 'Исходящий остаток', incoming: 'Поступления', outgoing: 'Списания', adjustments: 'Сверки',
    date: 'Дата', kind: 'Тип', description: 'Описание', amount: 'Сумма', income: 'Доход', expense: 'Расход',
    inTransfer: 'Перевод на счёт', outTransfer: 'Перевод со счёта', adjustment: 'Сверка',
    empty: 'За период нет операций.', note: (brand: string) => `Сформировано по записям ${brand} для личного учёта.`,
  },
};

function displayText(value: string) {
  return value.normalize('NFC').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function renderAccountStatement(statement: AccountStatement & { holderName?: string | null },
  variant: AppVariant = 'a'): Promise<Buffer> {
  const { lang, currency } = statement;
  const { name, brandColor } = appVariants[variant];
  const brand = name[lang];
  const { logo, headerFill, headerInk, ink, muted, panel, rule } = themes[variant];
  const t = labels[lang];
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  const dateFormat = new Intl.DateTimeFormat(locale, {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  });
  const date = (value: string) => dateFormat.format(new Date(value + 'T00:00:00Z'));
  const generated = new Intl.DateTimeFormat(locale, {
    dateStyle: 'short', timeStyle: 'short', timeZone: statement.timeZone,
  }).format(statement.generatedAt);
  const period = date(statement.fromDate) + ' - ' + date(statement.throughDate);
  const amount = (minor: string, showPlus = false) => formatAmount(minor, lang, showPlus).replace(/^−/, '-');
  const money = (minor: string) => amount(minor) + '\u00a0' + currencySymbol(currency);
  const doc = new PDFDocument({
    size: 'A4', margins: { top: margin, left: margin, right: margin, bottom: 0 },
    font: regular, info: { Title: `${t.title} | ${brand}`, Author: brand, CreationDate: new Date(statement.generatedAt) },
  });
  doc.registerFont('regular', regular).registerFont('bold', bold);
  const width = doc.page.width - 2 * margin;
  const bottom = doc.page.height - 82;
  const columns = [72, 100, width - 72 - 100 - 147, 147];
  const positions = [margin, margin + columns[0], margin + columns[0] + columns[1], margin + width - columns[3]];
  const tableHeaderHeight = 20;
  let y = header();
  let page = 1;

  function fitted(value: string, x: number, at: number, available: number, size: number) {
    doc.fontSize(size);
    if (doc.widthOfString(value) > available) doc.fontSize(size * available / doc.widthOfString(value));
    doc.text(value, x, at, { width: available, lineBreak: false });
  }

  function header(continued = false) {
    const height = continued ? 54 : 104;
    const inset = 18;
    const left = margin + inset;
    const top = margin + 12;
    doc.roundedRect(margin, margin, width, height, 9).fill(headerFill);
    doc.image(logo, left, top, { width: 30 });
    doc.font('bold').fontSize(11).fillColor(brandColor).text(brand, left + 38, top + 7, { lineBreak: false });
    doc.fontSize(continued ? 13 : 28).fillColor(headerInk)
      .text(t.title, left, top + (continued ? 6 : 39), {
        width: width - 2 * inset, align: continued ? 'right' : 'left',
      });
    return margin + height + 18;
  }

  doc.font('bold').fontSize(14).fillColor(ink).text(displayText(statement.name), margin, y, { width });
  y = doc.y + 6;
  doc.font('regular').fontSize(11).fillColor(muted).text(period + '  |  ' + currency, margin, y);
  doc.fontSize(9).text(t.generated + ' ' + generated + ' (' + statement.timeZone + ')', margin, doc.y + 4);
  const holderName = displayText(statement.holderName ?? '');
  if (holderName) {
    const holderY = doc.y + 4;
    const labelWidth = doc.widthOfString(t.holder) + 8;
    doc.text(t.holder, margin, holderY, { lineBreak: false });
    doc.font('bold').fillColor(ink);
    const holderOptions = {
      lineBreak: false,
      horizontalScaling: Math.min(100, (width - labelWidth) * 100 / doc.widthOfString(holderName)),
    };
    doc.text(holderName, margin + labelWidth, holderY, holderOptions).moveDown();
  }
  y = doc.y + 22;

  doc.roundedRect(margin, y, width, 72, 6).fill(panel);
  const balances = [[t.opening, statement.openingMinor], [t.closing, statement.closingMinor]];
  for (const [index, [label, minor]] of balances.entries()) {
    const x = margin + 16 + index * width / 2;
    doc.font('regular').fontSize(10).fillColor(muted).text(label, x, y + 12);
    doc.font('bold').fillColor(ink);
    fitted(money(minor), x, y + 29, width / 2 - 32, 23);
  }
  y += 86;
  const totals = [[t.incoming, statement.incomingMinor], [t.outgoing, statement.outgoingMinor],
    [t.adjustments, statement.adjustmentsMinor]];
  for (const [index, [label, minor]] of totals.entries()) {
    const x = margin + index * width / 3;
    doc.font('regular').fontSize(10).fillColor(muted).text(label, x, y);
    doc.font('bold').fillColor(ink);
    fitted(money(minor), x, y + 16, width / 3 - 10, 13);
  }
  y += 54;

  function line(at: number) {
    doc.lineWidth(0.6).strokeColor(rule).moveTo(margin, at).lineTo(margin + width, at).stroke();
  }

  function tableHeader() {
    doc.font('bold').fontSize(9).fillColor(muted);
    [t.date, t.kind, t.description, t.amount].forEach((label, index) =>
      doc.text(label, positions[index], y, { width: columns[index], align: index === 3 ? 'right' : 'left' }));
    line(y + tableHeaderHeight - 1);
    y += tableHeaderHeight;
  }

  function footer() {
    line(bottom + 8);
    doc.font('regular').fontSize(8).fillColor(muted);
    doc.text(t.note(brand), margin, bottom + 20, { width: width - 42 });
    doc.text(String(page), margin + width - 42, bottom + 20, { width: 42, align: 'right' });
  }

  if (!statement.entries.length) {
    tableHeader();
    doc.font('regular').fontSize(10).fillColor(muted).text(t.empty, margin, y + 12);
  }
  for (const [index, { date: entryDate, kind, amountMinor, category, description }] of statement.entries.entries()) {
    const type = kind === 'transfer' ? (amountMinor.startsWith('-') ? t.outTransfer : t.inTransfer) : t[kind];
    const detail = [category, description].flatMap((value) => value ? [displayText(value)] : []).join('\n');
    doc.font('regular').fontSize(9);
    const height = Math.max(27, doc.heightOfString(detail || ' ', { width: columns[2] - 10 }) + 14);
    const pageBreak = y + height + (index === 0 ? tableHeaderHeight : 0) > bottom;
    if (pageBreak) {
      footer();
      doc.addPage();
      page++;
      const top = header(true);
      doc.font('regular').fontSize(10).fillColor(muted).text(period + '  |  ' + currency, margin, top);
      y = doc.y + 20;
    }
    if (index === 0 || pageBreak) tableHeader();
    doc.font('regular').fontSize(9).fillColor(ink);
    const at = y + 6;
    doc.text(date(entryDate), positions[0], at, { width: columns[0] - 8 });
    doc.text(type, positions[1], at, { width: columns[1] - 8 });
    if (detail) doc.text(detail, positions[2], at, { width: columns[2] - 10 });
    doc.text(amount(amountMinor, true), positions[3], at, { width: columns[3], align: 'right' });
    y += height;
    line(y);
  }

  footer();
  doc.end();
  return buffer(doc);
}
