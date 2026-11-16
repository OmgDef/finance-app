import { NativeTabs } from 'expo-router/native-tabs';
import { useAccessSession } from '../../../src/access-session';
import { appTabs } from '../../../src/finance-tabs';
import { financeIconSources } from '../../../src/finance-icon';
import { palette } from '../../../src/finance-ui';

export const unstable_settings = { initialRouteName: 'accounts' };

export default function TabLayout() {
  const { lang, settingsBusy } = useAccessSession();
  return <NativeTabs backgroundColor={palette.panel} tintColor={palette.accent} iconColor={{ default: palette.muted, selected: palette.accent }}
    labelStyle={{ default: { color: palette.muted }, selected: { color: palette.accent } }}
    indicatorColor={palette.selected} labelVisibilityMode="labeled" backBehavior="initialRoute"
    minimizeBehavior="never" disableTransparentOnScrollEdge>
    {appTabs(lang).map(({ route, page, title, icon }) => (
      <NativeTabs.Trigger key={route} name={route} accessibilityLabel={title} testID={'finance-tab-' + page} disableAutomaticContentInsets
        disabled={settingsBusy && route !== 'settings'}>
        <NativeTabs.Trigger.Icon src={financeIconSources[icon]} renderingMode="template" />
        <NativeTabs.Trigger.Label>{title}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    ))}
  </NativeTabs>;
}
