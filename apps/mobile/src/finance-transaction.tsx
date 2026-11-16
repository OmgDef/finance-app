import { StyleSheet, Text, View } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import type { TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import { formatFinancialDate, formatMoney, formatProfileMoment, formatTransferRate } from './finance-format';
import { palette, styles, transactionAmountColor } from './finance-ui';

export type TransactionHistory = Result<'listTransactionVersions'>;
export type TransactionVersion = TransactionHistory['versions'][number];
type Account = Result<'listAccounts'>['accounts'][number];
type Category = Result<'listCategories'>['categories'][number];

export function revisionFields(type: TransactionHistory['type'], version: TransactionVersion): TransactionFields | undefined {
  if (version.status !== 'posted') return undefined;
  const fields = { date: version.date, ...(version.comment === null ? {} : { comment: version.comment }) };
  if (type === 'transfer') {
    const from = version.movements.find(({ amountMinor }) => amountMinor.startsWith('-'));
    const to = version.movements.find(({ amountMinor }) => !amountMinor.startsWith('-') && amountMinor !== '0');
    if (!from || !to) return undefined;
    return { ...fields, type, fromAccountId: from.accountId, toAccountId: to.accountId,
      fromAmountMinor: from.amountMinor.slice(1), toAmountMinor: to.amountMinor };
  }
  const movement = version.movements[0];
  if (!movement || !version.categoryId) return undefined;
  const source = version.source ?? version.incomeSource;
  return { ...fields, type, accountId: movement.accountId, amountMinor: movement.amountMinor.replace(/^-/, ''),
    categoryId: version.categoryId, ...(source && { source }) };
}

export function TransactionSummary({ history, current, lang, timeZone, accounts, categories }: {
  history: TransactionHistory; current: TransactionVersion; lang: Language; timeZone: string;
  accounts: Account[]; categories: Category[];
}) {
  const t = financeCopy[lang];
  const voided = current.status === 'void';
  const details = voided ? history.versions.slice().reverse().find(({ status }) => status === 'posted') ?? current : current;
  const category = categories.find(({ id }) => id === details.categoryId);
  const categoryName = lang === 'ru' ? category?.nameRu : category?.nameEn;
  const date = formatFinancialDate(details.date, lang);
  const createdAt = history.versions.find(({ version }) => version === 1)?.createdAt;
  const addedAt = createdAt ? formatProfileMoment(Date.parse(createdAt), timeZone, lang, 'second') : undefined;
  const accountNames = new Map(accounts.map(({ accountId, name }) => [accountId, name]));
  const fields = revisionFields(history.type, details);
  const from = fields?.type === 'transfer' ? details.movements.find(({ accountId }) => accountId === fields.fromAccountId) : undefined;
  const to = fields?.type === 'transfer' ? details.movements.find(({ accountId }) => accountId === fields.toAccountId) : undefined;
  const movements = from && to ? [from, to] : details.movements;
  const rate = fields?.type === 'transfer' && from && to && from.currency !== to.currency
    ? formatTransferRate(fields.fromAmountMinor, fields.toAmountMinor, from.currency, to.currency, lang) : undefined;
  const transfer = history.type === 'transfer';
  const source = details.source ?? details.incomeSource;
  const amount = transfer ? undefined : movements[0];

  return <View style={[styles.surface, layout.summary]} testID="finance-transaction-summary">
    <View style={layout.overview}>
      {voided && <Text style={styles.title}>{t.void}</Text>}
      {amount && <Text style={[styles.heroValue, layout.amount, { color: voided ? palette.muted : transactionAmountColor(amount.amountMinor) }]}>
        {formatMoney(amount.amountMinor, amount.currency, lang, true)}
      </Text>}
      {!transfer && (source ? <View style={layout.source}>
        <Text style={styles.meta}>{t.transactionSource}</Text>
        <Text style={layout.sourceName} testID="finance-transaction-source">{source}</Text>
      </View> : <Text style={[styles.meta, layout.source]}>{t.noTransactionSource}</Text>)}
      <Text style={styles.meta}>{categoryName ? `${categoryName} · ${date}` : date}</Text>
    </View>
    {movements.map((movement) => <View key={movement.accountId} style={[layout.detail, layout.movement]}>
      <View style={layout.account}>
        <Text style={styles.meta}>{movement === from ? t.fromAccount : movement === to ? t.toAccount : t.account}</Text>
        <Text style={styles.title}>{accountNames.get(movement.accountId) ?? '—'}</Text>
      </View>
      {transfer && <Text style={[styles.value, { color: voided ? palette.muted : transactionAmountColor(movement.amountMinor) }]}>
        {formatMoney(movement.amountMinor, movement.currency, lang, true)}
      </Text>}
    </View>)}
    {rate && <View style={layout.detail}>
      <Text style={styles.meta}>{t.transferRate}</Text>
      <Text style={styles.label}>{rate}</Text>
    </View>}
    {details.comment && <View style={layout.detail}>
      <Text style={styles.meta}>{t.transactionNote}</Text>
      <Text style={layout.comment} testID="finance-transaction-comment">{details.comment}</Text>
    </View>}
    {addedAt && <View style={layout.detail}>
      <Text style={styles.meta}>{t.transactionAddedAt}</Text>
      <Text style={styles.meta} testID="finance-transaction-added-at">{addedAt}</Text>
    </View>}
    {(current.actorRole === 'admin' || current.reason) && <View style={layout.detail}>
      {current.actorRole === 'admin' && <Text style={styles.meta}>{t.changedByAdmin}</Text>}
      {current.reason && <Text style={styles.label}>{current.reason}</Text>}
    </View>}
  </View>;
}

const layout = StyleSheet.create({
  summary: { paddingHorizontal: 16 },
  overview: { paddingVertical: 16, gap: 4 },
  amount: { fontSize: 36 },
  source: { marginVertical: 4, gap: 2 },
  sourceName: { color: palette.ink, fontSize: 20, fontWeight: '600' },
  comment: { color: palette.ink, fontSize: 18 },
  detail: { paddingVertical: 12, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  movement: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  account: { flexShrink: 1, gap: 4 },
});
