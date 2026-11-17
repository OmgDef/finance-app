import { Image } from 'react-native';
import type { ImageSourcePropType } from 'react-native';

export const financeIconSources = {
  wallet: require('../assets/icons/wallet.png'),
  statistics: require('../assets/icons/statistics.png'),
  transfer: require('../assets/icons/transfer.png'),
  help: require('../assets/icons/help.png'),
  settings: require('../assets/icons/settings.png'),
  card: require('../assets/icons/card.png'),
  cash: require('../assets/icons/cash.png'),
  deposit: require('../assets/icons/deposit.png'),
  archive: require('../assets/icons/archive.png'),
  plus: require('../assets/icons/plus.png'),
  expense: require('../assets/icons/expense.png'),
  income: require('../assets/icons/income.png'),
  profile: require('../assets/icons/profile.png'),
  clock: require('../assets/icons/clock.png'),
  language: require('../assets/icons/language.png'),
  biometrics: require('../assets/icons/biometrics.png'),
  'sign-out': require('../assets/icons/sign-out.png'),
  chevron: require('../assets/icons/chevron.png'),
  'chevron-down': require('../assets/icons/chevron-down.png'),
  check: require('../assets/icons/check.png'),
  close: require('../assets/icons/close.png'),
  calendar: require('../assets/icons/calendar.png'),
  filters: require('../assets/icons/filters.png'),
  mail: require('../assets/icons/mail.png'),
  phone: require('../assets/icons/phone.png'),
  utilities: require('../assets/icons/utilities.png'),
  groceries: require('../assets/icons/groceries.png'),
  transport: require('../assets/icons/transport.png'),
  dining: require('../assets/icons/dining.png'),
  shopping: require('../assets/icons/shopping.png'),
  health: require('../assets/icons/health.png'),
  entertainment: require('../assets/icons/entertainment.png'),
  travel: require('../assets/icons/travel.png'),
  copy: require('../assets/icons/copy.png'),
  statement: require('../assets/icons/statement.png'),
  refresh: require('../assets/icons/refresh.png'),
} satisfies Record<string, ImageSourcePropType>;

export type FinanceIconName = keyof typeof financeIconSources;

export function FinanceIcon({ name, color, size = 20 }: { name: FinanceIconName; color: string; size?: number }) {
  return <Image accessible={false} importantForAccessibility="no"
    source={financeIconSources[name]} style={{ width: size, height: size, tintColor: color }} />;
}
