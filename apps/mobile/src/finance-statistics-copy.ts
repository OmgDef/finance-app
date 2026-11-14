export const statisticsCopy = {
  en: {
    title: 'Statistics', period: 'Period', filters: 'Filters', apply: 'Apply filters', reset: 'Clear filters',
    month: 'Current month', custom: 'Custom dates', from: 'From date', through: 'Through date',
    invalidPeriod: 'Enter a start date and an end date in order.',
    allAccounts: 'All accounts', allCategories: 'All categories', allTypes: 'All types', allCurrencies: 'All currencies',
    currency: 'Currency', type: 'Transaction type', totals: 'Totals by currency', income: 'Income', expenses: 'Expenses',
    expensesByCategory: 'Expenses by category', transactions: 'Transactions', report: 'Back to report',
    unavailable: 'This account is no longer available. Choose another account or clear the filter.',
    reportChanged: 'The report changed. Refresh it before loading more transactions.',
    empty: 'No income or expenses match these filters.', emptyExpenses: 'No expenses for these filters.',
  },
  ru: {
    title: 'Статистика', period: 'Период', filters: 'Фильтры', apply: 'Применить фильтры', reset: 'Сбросить фильтры',
    month: 'Текущий месяц', custom: 'Свой период', from: 'Дата начала', through: 'Дата окончания',
    invalidPeriod: 'Укажите даты начала и окончания по порядку.',
    allAccounts: 'Все счета', allCategories: 'Все категории', allTypes: 'Все типы', allCurrencies: 'Все валюты',
    currency: 'Валюта', type: 'Тип операции', totals: 'Итоги по валютам', income: 'Доходы', expenses: 'Расходы',
    expensesByCategory: 'Расходы по категориям', transactions: 'Операции', report: 'Назад к отчёту',
    unavailable: 'Счёт больше недоступен. Выберите другой счёт или сбросьте фильтр.',
    reportChanged: 'Данные отчёта изменились. Обновите его перед загрузкой следующих операций.',
    empty: 'По этим фильтрам нет доходов и расходов.', emptyExpenses: 'По этим фильтрам нет расходов.',
  },
} as const;
