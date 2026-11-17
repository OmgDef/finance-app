import type { ExpoConfig } from 'expo/config';
import bootsplash from 'react-native-bootsplash/expo';
import { appVariants, comabankBackground, comabankIconBackground } from './src/app-variants.ts';

const variants = ['a', 'b'] as const;
const iosConfigurations = { a: 'ReleaseTetaFinance', b: 'ReleaseComaBank' } as const;
const iosVariant = variants.find((variant) => iosConfigurations[variant] === process.env.CONFIGURATION);
const appVariant = iosVariant ?? process.env.APP_VARIANT ?? 'a';
if (appVariant !== 'a' && appVariant !== 'b') throw new Error('APP_VARIANT must be a or b.');
const assetDirectories = { a: './assets/app-icon', b: './assets/app-icon/wallet' } as const;
const splashBackgrounds = { a: appVariants.a.brandColor, b: comabankBackground } as const;
const iosStyle = { a: 'automatic', b: 'dark' } as const;
const logoWidth = 134;
const { name, brandColor } = appVariants[appVariant];
const isComaBank = appVariant === 'b';
const assets = assetDirectories[appVariant];
const appIconForeground = `${assets}/android-foreground.png`;

const faceIdPermission = (displayName: string) => `Unlock ${displayName} with Face ID.`;
const russianInfo = (displayName: string) => ({
  CFBundleDisplayName: displayName,
  NSFaceIDUsageDescription: `Разблокируйте ${displayName} с помощью Face ID.`,
  NSPhotoLibraryUsageDescription: 'Выберите фото для своего профиля.',
});

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
      logoWidth,
      background: splashBackgrounds[appVariant],
      assetsOutput: '.expo/bootsplash',
      android: { darkContentBarsStyle: false },
    }),
    ['expo-secure-store', { configureAndroidBackup: false, faceIDPermission: faceIdPermission(name.en) }],
    ['expo-image-picker', { photosPermission: 'Choose a photo for your profile.', cameraPermission: false, microphonePermission: false }],
    './src/installation-backup.cjs',
    ['./scripts/with-ios-schemes.cjs', { logoWidth, variants: variants.map((variant) => {
      const { name } = appVariants[variant];
      return {
        name: name.en,
        configuration: iosConfigurations[variant],
        assets: assetDirectories[variant],
        splashBackground: splashBackgrounds[variant],
        infoPlist: {
          CFBundleDisplayName: name.en,
          NSFaceIDUsageDescription: faceIdPermission(name.en),
          UIUserInterfaceStyle: iosStyle[variant] === 'dark' ? 'Dark' : null,
        },
        russianInfo: russianInfo(name.ru),
      };
    }) }],
  ],
  ios: {
    bundleIdentifier: 'com.tetafinance.app',
    ...(isComaBank && { userInterfaceStyle: iosStyle.b }),
    infoPlist: { CFBundleAllowMixedLocalizations: true, CFBundleLocalizations: ['en', 'ru'] },
  },
  android: {
    package: 'com.tetafinance.app',
    allowBackup: false,
    adaptiveIcon: {
      foregroundImage: appIconForeground,
      monochromeImage: isComaBank ? `${assets}/android-monochrome.png` : appIconForeground,
      backgroundColor: isComaBank ? comabankIconBackground : brandColor,
    },
  },
  locales: {
    ru: {
      ios: russianInfo(name.ru),
      android: { app_name: name.ru },
    },
  },
} satisfies ExpoConfig;
