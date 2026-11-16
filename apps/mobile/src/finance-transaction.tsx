import { StyleSheet, Text, View } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import type { TransactionFields } from './finance-commands';
import { financeCopy } from './finance-copy';
import { formatFinancialDate, formatMoney, formatTransferRate } from './finance-format';
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
  return { ...fields, type, accountId: movement.accountId, amountMinor: movement.amountMinor.replace(/^-/, ''),
    categoryId: version.categoryId };
}

export function TransactionVersions({ history, lang, accounts, categories }: {
  history: TransactionHistory; lang: Language; accounts: Account[]; categories: Category[];
}) {
  const t = financeCopy[lang];
  const accountNames = new Map(accounts.map(({ accountId, name }) => [accountId, name]));
  const categoryNames = new Map(categories.map(({ id, nameEn, nameRu }) => [id, lang === 'ru' ? nameRu : nameEn]));
  const eventTime = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' });
  return <View style={layout.section}>
    <Text accessibilityRole="header" style={styles.section} testID="finance-transaction-versions">{t.transactionVersions}</Text>
    <View style={layout.versions}>
      {history.versions.slice().reverse().map((version) => {
        const current = version.version === history.transactionVersion;
        const category = version.categoryId && categoryNames.get(version.categoryId);
        const fields = revisionFields(history.type, version);
        const from = fields?.type === 'transfer' ? version.movements.find(({ accountId }) => accountId === fields.fromAccountId) : undefined;
        const to = fields?.type === 'transfer' ? version.movements.find(({ accountId }) => accountId === fields.toAccountId) : undefined;
        const rate = fields?.type === 'transfer' && from && to && from.currency !== to.currency
          ? formatTransferRate(fields.fromAmountMinor, fields.toAmountMinor, from.currency, to.currency, lang) : undefined;
        const movements = from && to ? [from, to] : version.movements;
        return <View key={version.version} style={[layout.version, current && layout.current]}
          testID={'finance-transaction-version-' + version.version}>
          <View style={layout.heading}>
            <Text style={styles.title}>{t.version} {version.version}</Text>
            {current && <Text style={styles.meta}>{t.currentVersion}</Text>}
          </View>
          <Text style={styles.meta}>{eventTime.format(new Date(version.createdAt))}</Text>
          <Text style={styles.label}>{formatFinancialDate(version.date, lang)}{category ? ' · ' + category : ''}</Text>
          {version.status === 'void' && <Text style={styles.meta}>{t.void}</Text>}
          {version.actorRole === 'admin' && <Text style={styles.meta}>{t.changedByAdmin}</Text>}
          {movements.map((movement) => <View key={movement.accountId} style={layout.movement}>
            <Text style={styles.meta}>{accountNames.get(movement.accountId) ?? t.account}</Text>
            <Text style={[styles.value, { color: transactionAmountColor(movement.amountMinor) }]}>
              {formatMoney(movement.amountMinor, movement.currency, lang, true)}
            </Text>
          </View>)}
          {rate && <Text style={styles.meta}>{rate}</Text>}
          {version.comment && <Text style={styles.meta}>{version.comment}</Text>}
          {version.reason && <Text style={styles.meta}>{version.reason}</Text>}
        </View>;
      })}
    </View>
  </View>;
}

const layout = StyleSheet.create({
  section: { gap: 10 },
  versions: { borderRadius: 16, backgroundColor: palette.panel, overflow: 'hidden' },
  version: { padding: 14, gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.line },
  current: { borderTopWidth: 0, backgroundColor: palette.raised },
  heading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  movement: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
});
