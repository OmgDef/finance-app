# Тестовые сборки TetaFinance и ComaBank

`APP_VARIANT=a` собирает TetaFinance с синим оформлением. Это вариант по умолчанию.
`APP_VARIANT=b` собирает ComaBank с тёмной темой, остатками в трёх валютах (RUB, USD и EUR) и миниатюрами привязанных карт на экране счетов.

Собирайте из каталога `apps/mobile`. Для второго телефона замените `a` на `b` в обеих командах выбранной платформы.
Укажите адрес тестового HTTPS API в `EXPO_PUBLIC_API_ORIGIN` или `.env.local` и подключите нужный телефон.
Для проверки контактов и вопросов поддержки по вариантам используйте API с миграцией `0025_support_variants.sql`.

## iOS

### Запуск из Xcode

Откройте `ios/TetaFinance.xcworkspace`. Выберите в верхней панели схему **TetaFinance** для A или **ComaBank** для B, укажите iOS Simulator и нажмите **⌘R**. Схема задаёт вариант приложения и запускает Release-сборку со встроенным JavaScript. Адрес API берётся из `EXPO_PUBLIC_API_ORIGIN` в `.env.local`. При смене схемы менять файл не нужно.

После чистого checkout с установленными npm-зависимостями сгенерируйте проект из `apps/mobile`. Подготовка обеих схем проверена с CocoaPods 1.16.2.

```sh
node scripts/expo.cjs prebuild --platform ios --no-clean --no-install
(cd ios && pod install)
```

### Сборка из терминала

```sh
APP_VARIANT=a node scripts/expo.cjs prebuild --platform ios --no-clean --no-install
APP_VARIANT=a node scripts/expo.cjs run:ios --scheme TetaFinance --device --configuration Release --no-bundler
```

Для установки на iPhone нужна подпись Xcode для `com.tetafinance.app`. При первой сборке выполните `pod install` в каталоге `ios`.

Для проверки в Simulator загрузите нужное устройство и выполните команду `run:ios` с `--device` и именем симулятора.

## Android

```sh
APP_VARIANT=a node scripts/expo.cjs prebuild --platform android --no-clean --no-install
APP_VARIANT=a node scripts/expo.cjs run:android --device --variant release --no-bundler
```

На обоих телефонах проверьте название и иконку на домашнем экране, затем откройте приложение и сравните экран счетов.
У вариантов один идентификатор. Установка другого варианта на тот же телефон заменяет приложение при совпадении подписи.
