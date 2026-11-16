import type { ExpoConfig } from 'expo/config';
import bootsplash from 'react-native-bootsplash/expo';
import { appVariants } from './src/app-variants.ts';

const appVariant = process.env.APP_VARIANT ?? 'a';
if (appVariant !== 'a' && appVariant !== 'b') throw new Error('APP_VARIANT must be a or b.');
const { name, brandColor } = appVariants[appVariant];
const assets = appVariant === 'b' ? './assets/app-icon/wallet' : './assets/app-icon';
const appIconForeground = `${assets}/android-foreground.png`;

export default {
  name: name.en,
  slug: 'tetafinance',
  version: '0.1.0',
  scheme: 'tetafinance',
  icon: `${assets}/icon.png`,
  platforms: ['ios', 'android'],
  extra: { appVariant },
  plugins: [
    'expo-router',
    bootsplash({
      logo: `${assets}/splash-logo.png`,
      logoWidth: 134,
      background: brandColor,
      assetsOutput: '.expo/bootsplash',
      android: { darkContentBarsStyle: false },
    }),
    ['expo-secure-store', { configureAndroidBackup: false, faceIDPermission: `Unlock ${name.en} with Face ID.` }],
    ['expo-image-picker', { photosPermission: 'Choose a photo for your profile.', cameraPermission: false, microphonePermission: false }],
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
      backgroundColor: brandColor,
    },
  },
  locales: {
    ru: {
      ios: {
        CFBundleDisplayName: name.ru,
        NSFaceIDUsageDescription: `Разблокируйте ${name.ru} с помощью Face ID.`,
        NSPhotoLibraryUsageDescription: 'Выберите фото для своего профиля.',
      },
      android: { app_name: name.ru },
    },
  },
} satisfies ExpoConfig;
