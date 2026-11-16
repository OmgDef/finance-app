import { Redirect, Stack, useRouter } from 'expo-router';
import { useFinanceWorkspace } from '../../src/finance-screen';
import { statisticsCopy } from '../../src/finance-statistics-copy';
import { StatisticsFiltersScreen } from '../../src/finance-statistics-filters';

export default function StatisticsFiltersRoute() {
  const router = useRouter();
  const { access, accounts, categories, lang, statisticsFilterEditor: editor } = useFinanceWorkspace();
  if (!editor) return <Redirect href="/(app)/(tabs)/statistics" />;

  return <>
    <Stack.Screen options={{ title: statisticsCopy[lang].filters, headerBackTitle: statisticsCopy[lang].title }} />
    <StatisticsFiltersScreen {...editor} today={access.profile.today} accounts={accounts} categories={categories}
      lang={lang} onApply={(filters, period) => {
        editor.onApply(filters, period);
        router.back();
      }} />
  </>;
}
