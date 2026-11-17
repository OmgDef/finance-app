import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import type { Language, Result } from '@teta/contracts';
import { requireOptionalNativeModule } from 'expo';
import { randomUUID } from 'expo-crypto';
import type { Directory, File } from 'expo-file-system';
import { requestAccountStatement } from './api';
import { appVariant } from './app-variant';
import { apiErrorCode } from './finance-commands';
import type { FinanceAccess } from './finance-commands';
import { FinanceDateField } from './finance-date-field';
import { formatFinancialDate } from './finance-format';
import { FinanceAlert, FinanceButton, palette, styles } from './finance-ui';

export const statementCopy = {
  en: {
    title: 'PDF statement', from: 'From', through: 'Through', generate: 'Generate PDF',
    loading: 'Generating PDF…', ready: 'PDF ready', open: 'Open PDF', share: 'Save or share PDF',
    invalid: 'Select dates between the account opening date and today.',
    future: 'You can generate a statement starting',
    tooLarge: 'This period contains too many entries. Choose a shorter period.',
    busy: 'Statement generation is busy. Try again in a moment.',
    downloadError: 'Could not download the PDF. Try again.',
    downloadUpdate: 'Update the app to download PDF statements.',
    storageError: 'Could not save the PDF to temporary storage. Try again.',
    unavailable: 'This account is unavailable.',
    statementUnavailable: 'PDF statements are not available on this server yet.',
    previewError: 'Could not open the PDF. Use “Save or share PDF”.',
    shareError: 'Could not share the PDF on this device.',
    shareUpdate: 'Update the app to save or share PDFs.',
  },
  ru: {
    title: 'Выписка PDF', from: 'С даты', through: 'По дату', generate: 'Сформировать PDF',
    loading: 'Формируем PDF…', ready: 'PDF готов', open: 'Открыть PDF', share: 'Сохранить или поделиться PDF',
    invalid: 'Выберите даты от начала учёта по счёту до сегодняшнего дня.',
    future: 'Выписку можно будет сформировать с',
    tooLarge: 'За этот период слишком много операций. Выберите более короткий период.',
    busy: 'Сейчас формируются другие выписки. Попробуйте ещё раз чуть позже.',
    downloadError: 'Не удалось загрузить PDF. Попробуйте ещё раз.',
    downloadUpdate: 'Обновите приложение, чтобы скачивать выписки PDF.',
    storageError: 'Не удалось сохранить PDF во временное хранилище. Попробуйте ещё раз.',
    unavailable: 'Счёт недоступен.',
    statementUnavailable: 'На этом сервере выписки PDF пока недоступны.',
    previewError: 'Не удалось открыть PDF. Воспользуйтесь кнопкой «Сохранить или поделиться PDF».',
    shareError: 'Не удалось поделиться PDF на этом устройстве.',
    shareUpdate: 'Обновите приложение, чтобы сохранять PDF и делиться им.',
  },
} as const;

const cacheLifetime = 24 * 60 * 60 * 1_000;

function removeTemporaryDirectory(directory: Directory | undefined) {
  try {
    if (directory?.exists) directory.delete();
  } catch {
    // The OS may have already removed files from the cache.
  }
}

function purgeStatements({ Directory, Paths }: typeof import('expo-file-system')) {
  try {
    const root = new Directory(Paths.cache, 'account-statements');
    if (!root.exists) return;
    for (const entry of root.list()) {
      const createdAt = Number(entry.name.split('-', 1)[0]);
      if (entry instanceof Directory && createdAt > 0 && Date.now() - createdAt > cacheLifetime) {
        removeTemporaryDirectory(entry);
      }
    }
  } catch {
    // Cache cleanup must not prevent a new export.
  }
}

function statementError(code: string, lang: Language) {
  const t = statementCopy[lang];
  switch (code) {
    case 'INVALID_REQUEST': return t.invalid;
    case 'STATEMENT_TOO_LARGE': return t.tooLarge;
    case 'TEMPORARY_FAILURE': return t.busy;
    case 'NOT_FOUND': return t.unavailable;
    case 'STATEMENT_UNAVAILABLE': return t.statementUnavailable;
    case 'STORAGE': return t.storageError;
    default: return t.downloadError;
  }
}

export function AccountStatementForm({ account, access, lang, focused }: {
  account: Result<'getAccountBalance'>; access: FinanceAccess; lang: Language; focused: boolean;
}) {
  const t = statementCopy[lang];
  const today = access.profile.today;
  const monthStart = today.slice(0, 8) + '01';
  const [fromDate, setFromDate] = useState(account.startDate > monthStart ? account.startDate : monthStart);
  const [throughDate, setThroughDate] = useState(today);
  const [file, setFile] = useState<File>();
  const [error, setError] = useState('');
  const [working, setWorking] = useState<'generate' | 'open' | 'share'>();
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') request.current?.abort();
    });
    return () => {
      subscription.remove();
      request.current?.abort();
      request.current = null;
    };
  }, []);

  useEffect(() => {
    if (!focused) request.current?.abort();
  }, [focused]);

  function resetResult() {
    setFile(undefined);
    setError('');
  }

  async function generate() {
    if (working || request.current || !focused || !access.isCurrent()) return;
    if (!requireOptionalNativeModule('FileSystem')) {
      setError(t.downloadUpdate);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    resetResult();
    setWorking('generate');
    const current = () => !controller.signal.aborted && access.isCurrent();
    let directory: Directory | undefined;
    try {
      const fileSystem = await import('expo-file-system');
      if (!current()) return;
      purgeStatements(fileSystem);
      const bytes = await requestAccountStatement(account.accountId, { fromDate, throughDate, lang, variant: appVariant },
        access.token, controller.signal);
      if (!current()) return;
      const { Directory, File, Paths } = fileSystem;
      directory = new Directory(Paths.cache, 'account-statements', `${Date.now()}-${randomUUID()}`);
      directory.create({ intermediates: true });
      const next = new File(directory, `statement-${fromDate}-${throughDate}.pdf`);
      await next.write(bytes);
      if (current()) {
        setFile(next);
        directory = undefined;
      }
    } catch (failure) {
      if (current()) {
        const code = directory ? 'STORAGE' : apiErrorCode(failure);
        if (!access.onAccessFailure(code)) setError(statementError(code, lang));
      }
    } finally {
      removeTemporaryDirectory(directory);
      if (request.current === controller) {
        request.current = null;
        setWorking(undefined);
      }
    }
  }

  async function useFile(action: 'open' | 'share') {
    if (!file || working || !focused || !access.isCurrent()) return;
    setError('');
    setWorking(action);
    try {
      if (!file.exists) {
        setFile(undefined);
        setError(t.storageError);
      } else if (action === 'open') {
        await file.preview({ title: t.title, mimeType: 'application/pdf' });
      } else if (!requireOptionalNativeModule('ExpoSharing')) {
        setError(t.shareUpdate);
      } else {
        const sharing = await import('expo-sharing');
        if (!await sharing.isAvailableAsync()) {
          if (access.isCurrent()) setError(t.shareError);
          return;
        }
        if (access.isCurrent()) await sharing.shareAsync(file.uri, {
          dialogTitle: t.share, mimeType: 'application/pdf', UTI: 'com.adobe.pdf',
        });
      }
    } catch {
      if (access.isCurrent()) setError(action === 'open' ? t.previewError : t.shareError);
    } finally {
      setWorking(undefined);
    }
  }

  return <>
    <View style={layout.identity}>
      <Text accessibilityRole="header" style={styles.section}>{account.name}</Text>
      <Text style={styles.meta}>{account.currency}</Text>
    </View>
    {account.startDate > today
      ? <Text style={styles.meta}>{t.future} {formatFinancialDate(account.startDate, lang)}.</Text>
      : <>
        <FinanceDateField title={t.from} lang={lang} value={fromDate} today={today}
          min={account.startDate} max={throughDate} disabled={!!working} testID="finance-statement-from"
          onChange={(date) => { setFromDate(date); resetResult(); }} />
        <FinanceDateField title={t.through} lang={lang} value={throughDate} today={today}
          min={fromDate} max={today} disabled={!!working} testID="finance-statement-through"
          onChange={(date) => { setThroughDate(date); resetResult(); }} />
        <FinanceButton title={working === 'generate' ? t.loading : t.generate} primary disabled={!!working}
          testID="finance-statement-generate" onPress={() => void generate()} />
        {working === 'generate' && <ActivityIndicator color={palette.accent} accessibilityLabel={t.loading} />}
        {file && <View style={layout.result} testID="finance-statement-ready">
          <Text style={styles.groupTitle} accessibilityLiveRegion="polite">{t.ready}</Text>
          <FinanceButton title={t.open} disabled={!!working} testID="finance-statement-open" onPress={() => void useFile('open')} />
          <FinanceButton title={t.share} disabled={!!working} testID="finance-statement-share" onPress={() => void useFile('share')} />
        </View>}
      </>}
    {error !== '' && <FinanceAlert>{error}</FinanceAlert>}
  </>;
}

const layout = StyleSheet.create({
  identity: { gap: 3 },
  result: { gap: 8 },
});
