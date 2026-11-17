# Сборки TetaFinance и ComaBank

Выполняйте команды из каталога `apps/mobile`. Задайте адрес тестового API через `EXPO_PUBLIC_API_ORIGIN` в `.env.local`.
Для проверки контактов и вопросов поддержки по вариантам используйте API с миграцией `0025_support_variants.sql`.

## iOS

### Подготовка проекта

С установленными npm-зависимостями сгенерируйте проект и обновите CocoaPods. Подготовка проверена с CocoaPods 1.16.2.

```sh
APP_VARIANT=a node scripts/expo.cjs prebuild --platform ios --no-clean --no-install
(cd ios && pod install)
```

### Запуск из Xcode

Откройте `ios/TetaFinance.xcworkspace`. Выберите схему и устройство в верхней панели Xcode, затем нажмите **⌘R**.

| Схема | Конфигурация | API |
| --- | --- | --- |
| **Debug TetaFinance** | `DebugTetaFinance` | `EXPO_PUBLIC_API_ORIGIN` из `.env.local` |
| **Debug ComaBank** | `DebugComaBank` | `EXPO_PUBLIC_API_ORIGIN` из `.env.local` |
| **Release TetaFinance** | `ReleaseTetaFinance` | `https://teta.zslon.ru` |
| **Release ComaBank** | `ReleaseComaBank` | `https://teta.zslon.ru` |

Для Debug запустите Metro командой `npm start` и оставьте его работающим при переключении между брендами. Для Debug на iPhone Mac и телефон должны видеть друг друга по сети. Release встраивает JavaScript и продакшн-адрес при сборке.

Для установки на iPhone выберите свою команду в **Signing & Capabilities**. У двух Debug-сборок отдельные Bundle ID для хранения тестовой активации. Обе Release-сборки используют `com.tetafinance.app` и при установке на один телефон заменяют друг друга.

### Запуск из терминала

```sh
npm run ios -- --device
node scripts/expo.cjs run:ios --scheme 'Release TetaFinance' --configuration ReleaseTetaFinance --device --no-bundler
```

Первая команда запускает Debug TetaFinance. Для ComaBank укажите в команде `run:ios` его схему и конфигурацию из таблицы. Флаг `--no-bundler` используйте для Release.

## Android

`APP_VARIANT=a` собирает TetaFinance с синим оформлением. Это вариант по умолчанию.
`APP_VARIANT=b` собирает ComaBank с тёмной темой, остатками в трёх валютах (RUB, USD и EUR) и миниатюрами привязанных карт на экране счетов.

```sh
APP_VARIANT=a node scripts/expo.cjs prebuild --platform android --no-clean --no-install
APP_VARIANT=a node scripts/expo.cjs run:android --device --variant release --no-bundler
```

Для ComaBank замените `a` на `b` в обеих командах. Адрес API задаётся через `EXPO_PUBLIC_API_ORIGIN`. У вариантов один идентификатор. Установка другого варианта на тот же телефон заменяет приложение при совпадении подписи.
