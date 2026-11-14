import type { ExpoConfig } from 'expo/config';
import { copy } from './src/copy.ts';

export default {
  name: copy.en.appName,
  slug: 'tetafinance',
  version: '0.1.0',
  scheme: 'tetafinance',
  platforms: ['ios', 'android'],
  plugins: [
    'expo-router',
    ['expo-secure-store', { configureAndroidBackup: false, faceIDPermission: `Unlock ${copy.en.appName} with Face ID.` }],
    './src/installation-backup.cjs',
  ],
  ios: {
    bundleIdentifier: 'com.tetafinance.app',
    infoPlist: { CFBundleAllowMixedLocalizations: true, CFBundleLocalizations: ['en', 'ru'] },
  },
  android: { package: 'com.tetafinance.app', allowBackup: false },
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
