import type { ExpoConfig } from 'expo/config';
import bootsplash from 'react-native-bootsplash/expo';
import { copy } from './src/copy.ts';

const appIconBackground = '#2459B2';
const appIconForeground = './assets/app-icon/android-foreground.png';

export default {
  name: copy.en.appName,
  slug: 'tetafinance',
  version: '0.1.0',
  scheme: 'tetafinance',
  icon: './assets/app-icon/icon.png',
  platforms: ['ios', 'android'],
  plugins: [
    'expo-router',
    bootsplash({
      logo: appIconForeground,
      logoWidth: 134,
      background: appIconBackground,
      assetsOutput: '.expo/bootsplash',
      android: { darkContentBarsStyle: false },
    }),
    ['expo-secure-store', { configureAndroidBackup: false, faceIDPermission: `Unlock ${copy.en.appName} with Face ID.` }],
    './src/installation-backup.cjs',
  ],
  ios: {
    bundleIdentifier: 'com.tetafinance.app',
    infoPlist: { CFBundleAllowMixedLocalizations: true, CFBundleLocalizations: ['en', 'ru'] },
  },
  android: {
    package: 'com.tetafinance.app',
    allowBackup: false,
    adaptiveIcon: {
      foregroundImage: appIconForeground,
      monochromeImage: appIconForeground,
      backgroundColor: appIconBackground,
    },
  },
  locales: {
    ru: {
      ios: {
        CFBundleDisplayName: copy.ru.appName,
        NSFaceIDUsageDescription: `Разблокируйте ${copy.ru.appName} с помощью Face ID.`,
      },
      android: { app_name: copy.ru.appName },
    },
  },
} satisfies ExpoConfig;
