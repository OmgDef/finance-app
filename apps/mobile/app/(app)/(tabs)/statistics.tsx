import { useLocalSearchParams } from 'expo-router';
import { currencies, financialDate } from '../../../src/finance-format';
import { FinanceTabScreen } from '../../../src/finance-screen';

export default function Tab() {
  const params = useLocalSearchParams();
  const fromDate = typeof params.fromDate === 'string' ? financialDate(params.fromDate, 'en') : undefined;
  const throughDate = typeof params.throughDate === 'string' ? financialDate(params.throughDate, 'en') : undefined;
  const currency = currencies.find((code) => code === params.currency);
  const preset = fromDate && throughDate && fromDate <= throughDate && currency ? { fromDate, throughDate, currency } : undefined;
  return <FinanceTabScreen key={preset ? JSON.stringify([params.overview, preset]) : 'statistics'}
    tab="statistics" statisticsPreset={preset} />;
}
