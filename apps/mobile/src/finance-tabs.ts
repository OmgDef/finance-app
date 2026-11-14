import type { Language } from '@teta/contracts';
import { copy } from './copy';
import { financeCopy } from './finance-copy';
import { scheduleCopy } from './finance-schedule-copy';
import { statisticsCopy } from './finance-statistics-copy';

export function appTabs(lang: Language) {
  return [
    { route: 'accounts', page: 'products', title: financeCopy[lang].accounts, icon: 'wallet' },
    { route: 'statistics', page: 'statistics', title: statisticsCopy[lang].title, icon: 'statistics' },
    { route: 'payments', page: 'payments', title: scheduleCopy[lang].payments, icon: 'transfer' },
    { route: 'help', page: 'support', title: copy[lang].help, icon: 'help' },
    { route: 'settings', page: 'settings', title: copy[lang].settings, icon: 'settings' },
  ] as const;
}

export type FinanceTab = ReturnType<typeof appTabs>[number]['page'];
