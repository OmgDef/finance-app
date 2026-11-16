import { useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import type { Body, CardNetwork, Language, Result } from '@teta/contracts';
import { cardNetworks } from '@teta/contracts/client';
import { request } from './api';
import { copy } from './copy';
import { CardColorField } from './finance-card-color';
import { CardNetworkLogo, cardNetworkLabel } from './finance-card-network';
import { apiErrorCode } from './finance-commands';
import type { FinanceAccess } from './finance-commands';
import { financeCopy } from './finance-copy';
import type { FinanceCopyKey } from './finance-copy';
import { FinanceDateField } from './finance-date-field';
import { formatFinancialDate, formatMoney } from './finance-format';
import type { AccountEditor } from './finance-navigation';
import { Choice, FinanceAlert, FinanceButton, FinanceField, palette, styles } from './finance-ui';

type Account = Result<'getAccountBalance'>;
type Card = Result<'createAccountCard'>;
type CardInput = Body<'createAccountCard'>;
type Scope = 'account' | 'cards';
type LoadResult = 'loading' | 'ready' | 'failed';

const accountErrors: Record<string, FinanceCopyKey> = {
  ACCOUNT_BALANCE_NOT_ZERO: 'archiveBalanceRequired',
  SCHEDULE_FUTURE_DATES: 'archiveFutureDates',
  SCHEDULE_DATES_PENDING: 'archivePendingDates',
  VERSION_CONFLICT: 'accountVersionConflict',
  ACCOUNT_UNAVAILABLE: 'unavailable',
  ACCOUNT_START_DATE_CONFLICT: 'startDateConflict',
  INVALID_REQUEST: 'invalidRequest',
  NOT_FOUND: 'unavailable',
};
const ambiguousErrors = ['NETWORK', 'INTERNAL_ERROR', 'TEMPORARY_FAILURE'];

export function AccountManagement({ account, access, lang, disabled, editor, notice, onAccountChanged, onReconcile,
  onEdit, onBusy, onFinish }: {
  account: Account; access: FinanceAccess; lang: Language; disabled: boolean;
  editor?: AccountEditor;
  notice?: FinanceCopyKey;
  onAccountChanged: (account: Account) => void; onReconcile: () => void;
  onEdit: (editor: AccountEditor) => void; onBusy: (busy: boolean) => void; onFinish: (result?: FinanceCopyKey) => void;
}) {
  const t = financeCopy[lang];
  const accountId = account.accountId;
  const [snapshot, setSnapshot] = useState(account);
  const [cards, setCards] = useState<Card[]>([]);
  const [accountLoad, setAccountLoad] = useState<LoadResult>('loading');
  const [cardsLoad, setCardsLoad] = useState<LoadResult>('loading');
  const [message, setMessage] = useState<{ key: FinanceCopyKey; alert?: boolean }>();
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const focused = useIsFocused();
  const mounted = useRef(false);
  const writing = useRef(false);
  const loadGeneration = useRef({ account: 0, cards: 0 });
  const current = () => mounted.current && access.isCurrent();

  async function loadAccount() {
    const attempt = ++loadGeneration.current.account;
    setAccountLoad('loading');
    try {
      const result = await request('getAccountBalance', { token: access.token, params: { accountId } });
      if (!current() || attempt !== loadGeneration.current.account) return;
      setSnapshot(result);
      setAccountLoad('ready');
      onAccountChanged(result);
    } catch (error) {
      if (current() && attempt === loadGeneration.current.account && !access.onAccessFailure(apiErrorCode(error))) {
        setAccountLoad('failed');
      }
    }
  }

  async function loadCards() {
    const attempt = ++loadGeneration.current.cards;
    setCardsLoad('loading');
    try {
      const result = await request('listAccountCards', { token: access.token, params: { accountId } });
      if (!current() || attempt !== loadGeneration.current.cards) return;
      setCards(result.cards);
      setCardsLoad('ready');
    } catch (error) {
      if (current() && attempt === loadGeneration.current.cards && !access.onAccessFailure(apiErrorCode(error))) {
        setCardsLoad('failed');
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!focused) return;
    if (editor?.kind !== 'card') void loadAccount();
    if (!editor || (editor.kind === 'card' && editor.cardId)) void loadCards();
  }, [focused, accountId]);

  async function mutate(scope: Scope, success: FinanceCopyKey, write: () => Promise<void>) {
    if (!current() || disabled || writing.current) return;
    writing.current = true;
    setBusy(true);
    onBusy(true);
    setMessage(undefined);
    const refresh = scope === 'account' ? loadAccount : loadCards;
    try {
      await write();
      if (!current()) return;
      if (editor) onFinish(success);
      else {
        setMessage({ key: success });
        await refresh();
      }
    } catch (error) {
      if (!current()) return;
      const code = apiErrorCode(error);
      if (access.onAccessFailure(code)) return;
      const unknown = ambiguousErrors.includes(code);
      const message = unknown ? scope === 'account' ? 'accountOutcomeUnknown' : 'cardsOutcomeUnknown'
        : accountErrors[code] ?? 'error';
      setMessage({ key: message, alert: true });
      if (editor && unknown) setUncertain(true);
      else await refresh();
    } finally {
      writing.current = false;
      if (current()) {
        setBusy(false);
        onBusy(false);
      }
    }
  }

  function changeArchive() {
    const archived = snapshot.archived === true;
    const title = archived ? t.restoreAccount : t.archiveAccount;
    Alert.alert(archived ? t.restoreTitle : t.archiveTitle, archived ? t.restoreExplanation : t.archiveExplanation, [
      { text: copy[lang].cancel, style: 'cancel' },
      { text: title, style: archived ? 'default' : 'destructive', onPress: () => void mutate('account',
        archived ? 'accountRestored' : 'accountArchived', async () => {
          const result = await request(archived ? 'restoreAccount' : 'archiveAccount', { token: access.token, params: { accountId } });
          if (access.isCurrent()) {
            const { archived: _previous, ...account } = snapshot;
            const updated = { ...account, balanceMinor: result.balanceMinor, accountVersion: result.accountVersion,
              ...(result.archived && { archived: true as const }) };
            onAccountChanged(updated);
            if (current()) setSnapshot(updated);
          }
        }) },
    ]);
  }

  function saveCard(body: CardInput, card?: Card) {
    void mutate('cards', card ? 'cardUpdated' : 'cardAdded', async () => {
      if (card) await request('updateAccountCard', { token: access.token, params: { accountId, cardId: card.cardId }, body });
      else await request('createAccountCard', { token: access.token, params: { accountId }, body });
    });
  }

  function removeCard(card: Card) {
    Alert.alert(t.deleteCardTitle, t.deleteCardExplanation, [
      { text: copy[lang].cancel, style: 'cancel' },
      { text: t.deleteCard, style: 'destructive', onPress: () => void mutate('cards', 'cardDeleted', async () => {
        await request('deleteAccountCard', { token: access.token, params: { accountId, cardId: card.cardId } });
      }) },
    ]);
  }

  const blocked = disabled || busy;
  const cardId = editor?.kind === 'card' ? editor.cardId : undefined;
  const card = cardId ? cards.find((entry) => entry.cardId === cardId) : undefined;
  const needsAccount = !editor || editor.kind !== 'card';
  const needsCards = !editor || !!cardId;

  const feedback = message ?? (notice && { key: notice, alert: false });

  return <View style={layout.section}>
    {!editor && <View style={layout.section}>
      <Text style={styles.title}>{snapshot.name}</Text>
      <Text style={styles.heroValue} testID="finance-managed-balance">{formatMoney(snapshot.balanceMinor, snapshot.currency, lang)}</Text>
      <Text style={styles.meta}>{t.startDate} · {formatFinancialDate(snapshot.startDate, lang)}</Text>
      {snapshot.archived && <Text style={styles.meta}>{t.archivedAccount}</Text>}
    </View>}
    {feedback && (feedback.alert ? <FinanceAlert testID="finance-account-action-error">{t[feedback.key]}</FinanceAlert>
      : <Text style={styles.label} accessibilityLiveRegion="polite" testID="finance-account-action-result">{t[feedback.key]}</Text>)}
    {needsAccount && accountLoad === 'loading' && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
    {needsAccount && accountLoad === 'failed' && <View style={layout.section}>
      <FinanceAlert>{t.error}</FinanceAlert>
      <FinanceButton title={t.reloadAccount} disabled={busy} onPress={() => void loadAccount()} testID="finance-refresh-account" />
    </View>}
    {!editor && accountLoad === 'ready' && <View style={layout.actions}>
      {!snapshot.archived && <>
        <FinanceButton title={t.renameAccount} disabled={blocked} onPress={() => {
          setMessage(undefined);
          onEdit({ kind: 'rename' });
        }} testID="finance-rename-account" />
        <FinanceButton title={t.changeStartDate} disabled={blocked} onPress={() => {
          setMessage(undefined);
          onEdit({ kind: 'startDate' });
        }} testID="finance-change-start-date" />
        <FinanceButton title={t.reconcileAccount} disabled={blocked} onPress={onReconcile} testID="finance-reconcile-account" />
      </>}
      <FinanceButton title={snapshot.archived ? t.restoreAccount : t.archiveAccount} disabled={blocked} onPress={changeArchive}
        testID={snapshot.archived ? 'finance-restore-account' : 'finance-archive-account'} />
    </View>}
    {editor && accountLoad === 'ready' && snapshot.archived && <FinanceAlert>{t.unavailable}</FinanceAlert>}
    {!uncertain && editor?.kind === 'rename' && accountLoad === 'ready' && !snapshot.archived && <NameEditor
      key={snapshot.accountVersion} name={snapshot.name} lang={lang} disabled={blocked}
      onCancel={onFinish} onSave={(name) => void mutate('account', 'accountRenamed', async () => {
        const updated = await request('renameAccount', { token: access.token, params: { accountId },
          body: { name, expectedAccountVersion: snapshot.accountVersion } });
        if (access.isCurrent()) onAccountChanged(updated);
        if (current()) setSnapshot(updated);
      })} />}
    {!uncertain && editor?.kind === 'startDate' && accountLoad === 'ready' && !snapshot.archived && <StartDateEditor
      key={snapshot.accountVersion} account={snapshot} today={access.profile.today} lang={lang} disabled={blocked}
      onCancel={onFinish}
      onSave={(startDate) => void mutate('account', 'startDateSaved', async () => {
        const updated = await request('updateAccountStartDate', { token: access.token, params: { accountId },
          body: { startDate, expectedAccountVersion: snapshot.accountVersion } });
        if (access.isCurrent()) onAccountChanged(updated);
        if (current()) setSnapshot(updated);
      })} />}
    {!editor && <Text accessibilityRole="header" style={styles.section} testID="finance-cards">{t.cards}</Text>}
    {needsCards && <View style={layout.section}>
      {cardsLoad === 'loading' && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
      {cardsLoad === 'failed' && <>
        <FinanceAlert>{t.error}</FinanceAlert>
        <FinanceButton title={t.reloadCards} disabled={busy} onPress={() => void loadCards()} testID="finance-refresh-cards" />
      </>}
      {editor?.kind === 'card' && cardsLoad === 'ready' && !card && <FinanceAlert>{t.unavailable}</FinanceAlert>}
      {!editor && cardsLoad === 'ready' && <>
        {cards.length ? <View style={layout.cards}>
          {cards.map((card, index) => <Pressable accessibilityRole="button" disabled={blocked}
            accessibilityLabel={[card.name, cardNetworkLabel(card.network, lang), card.lastFour,
              formatMoney(snapshot.balanceMinor, snapshot.currency, lang)].filter(Boolean).join(', ')}
            key={card.cardId} testID={'finance-card-' + card.cardId} onPress={() => {
              setMessage(undefined);
              onEdit({ kind: 'card', cardId: card.cardId });
            }} style={({ pressed }) => [layout.card, index > 0 && layout.cardDivider, pressed && layout.pressed]}>
            <View style={layout.cardIdentity}>
              <CardNetworkLogo network={card.network} />
              <View style={layout.cardLabels}>
                <Text style={styles.title}>{card.name}</Text>
                {card.lastFour && <Text style={styles.meta}>{'•••• ' + card.lastFour}</Text>}
              </View>
            </View>
            <Text style={layout.cardBalance}>{formatMoney(snapshot.balanceMinor, snapshot.currency, lang)}</Text>
          </Pressable>)}
        </View> : <Text style={styles.meta}>{t.noCards}</Text>}
        <FinanceButton title={t.addCard} disabled={blocked} onPress={() => {
          setMessage(undefined);
          onEdit({ kind: 'card' });
        }} testID="finance-add-card" />
      </>}
    </View>}
    {!uncertain && editor?.kind === 'card' && (!cardId || card) && <CardEditor card={card} lang={lang} disabled={blocked}
      onCancel={onFinish} onSave={(body) => saveCard(body, card)} onDelete={card ? () => removeCard(card) : undefined} />}
  </View>;
}

function NameEditor({ name, lang, disabled, onSave, onCancel }: {
  name: string; lang: Language; disabled: boolean; onSave: (name: string) => void; onCancel: () => void;
}) {
  const t = financeCopy[lang];
  const [value, setValue] = useState(name);
  const [invalid, setInvalid] = useState(false);
  return <View style={layout.form}>
    <FinanceField title={t.accountName} value={value} onChangeText={setValue} editable={!disabled} maxLength={255}
      testID="finance-rename-name" />
    {invalid && <FinanceAlert>{t.invalidName}</FinanceAlert>}
    <View style={layout.actions}>
      <FinanceButton title={t.saveChanges} primary disabled={disabled} testID="finance-rename-save" onPress={() => {
        if (!value.trim()) return setInvalid(true);
        setInvalid(false);
        void KeyboardController.dismiss();
        onSave(value.trim());
      }} />
      <FinanceButton title={copy[lang].cancel} disabled={disabled} onPress={onCancel} />
    </View>
  </View>;
}

function StartDateEditor({ account, today, lang, disabled, onSave, onCancel }: {
  account: Account; today: string; lang: Language; disabled: boolean; onSave: (date: string) => void; onCancel: () => void;
}) {
  const t = financeCopy[lang];
  const [start, setStart] = useState<string>();
  const date = start ?? account.startDate;
  const latest = 'maturityDate' in account && account.maturityDate < today ? account.maturityDate : today;
  const [error, setError] = useState<FinanceCopyKey>();

  function submit() {
    if (date > today && date !== account.startDate) return setError('futureStartDate');
    if ('maturityDate' in account && date > account.maturityDate) return setError('startAfterMaturity');
    setError(undefined);
    void KeyboardController.dismiss();
    onSave(date);
  }

  return <View style={layout.form}>
    <FinanceDateField title={t.startDate} lang={lang} today={today} value={date} onChange={setStart} max={latest}
      disabled={disabled} testID="finance-edit-start-date" />
    {error && <FinanceAlert>{t[error]}</FinanceAlert>}
    <View style={layout.actions}>
      <FinanceButton title={t.saveChanges} primary disabled={disabled} testID="finance-start-date-save" onPress={submit} />
      <FinanceButton title={copy[lang].cancel} disabled={disabled} onPress={onCancel} />
    </View>
  </View>;
}

function CardEditor({ card, lang, disabled, onSave, onDelete, onCancel }: {
  card?: Card; lang: Language; disabled: boolean; onSave: (body: CardInput) => void; onDelete?: () => void; onCancel: () => void;
}) {
  const t = financeCopy[lang];
  const [name, setName] = useState(card?.name ?? '');
  const [color, setColor] = useState(card?.appearance ?? '#536F63');
  const [lastFour, setLastFour] = useState(card?.lastFour ?? '');
  const [network, setNetwork] = useState<CardNetwork | 'unspecified'>(card?.network ?? 'unspecified');
  const selectedNetwork = network === 'unspecified' ? null : network;
  const [error, setError] = useState<FinanceCopyKey>();
  function save() {
    if (!name.trim()) return setError('invalidName');
    if (lastFour && !/^[0-9]{4}$/.test(lastFour)) return setError('invalidCardLastFour');
    setError(undefined);
    void KeyboardController.dismiss();
    onSave({ name: name.trim(), appearance: color.toUpperCase(), lastFour: lastFour || null, network: selectedNetwork });
  }
  return <View style={layout.form}>
    <FinanceField title={t.cardName} value={name} onChangeText={setName} editable={!disabled} maxLength={255} testID="finance-card-name" />
    <FinanceField title={t.cardLastFour} value={lastFour} onChangeText={setLastFour} editable={!disabled} maxLength={4}
      keyboardType="number-pad" testID="finance-card-last-four" />
    <Choice title={t.cardNetwork} value={network} onChange={setNetwork} disabled={disabled} testID="finance-card-network"
      options={[
        ...cardNetworks.map((id) => ({ id, label: cardNetworkLabel(id, lang), icon: <CardNetworkLogo network={id} /> })),
        { id: 'unspecified', label: t.cardNetworkUnspecified },
      ]} />
    <CardColorField value={color} onChange={setColor} lang={lang} network={selectedNetwork} disabled={disabled} />
    {error && <FinanceAlert>{t[error]}</FinanceAlert>}
    <View style={layout.actions}>
      <FinanceButton title={t.saveChanges} primary disabled={disabled} onPress={save} testID="finance-card-save" />
      <FinanceButton title={copy[lang].cancel} disabled={disabled} onPress={onCancel} />
      {onDelete && <FinanceButton title={t.deleteCard} disabled={disabled} onPress={onDelete} testID="finance-delete-card" />}
    </View>
  </View>;
}

const layout = StyleSheet.create({
  section: { gap: 12 },
  form: { gap: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cards: { borderRadius: 16, backgroundColor: palette.panel, paddingHorizontal: 12 },
  card: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', minHeight: 58,
    paddingVertical: 10, gap: 10 },
  cardDivider: { borderTopColor: palette.line, borderTopWidth: StyleSheet.hairlineWidth },
  cardIdentity: { flexDirection: 'row', alignItems: 'center', gap: 10, flexGrow: 1, flexBasis: '44%', minWidth: 110 },
  cardLabels: { flex: 1, gap: 3 },
  cardBalance: { color: palette.ink, fontWeight: '600', fontSize: 16, fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 1 },
  pressed: { opacity: 0.58 },
});
