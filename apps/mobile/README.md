# Тестовые сборки Teta

`APP_VARIANT=a` собирает TetaFinance с синим оформлением. Это вариант по умолчанию.
`APP_VARIANT=b` собирает Teta Wallet («Тета Кошелёк») с иконкой кошелька, зелёным оформлением, остатками по всем валютам и кнопкой записи расхода на экране счетов.

Собирайте из каталога `apps/mobile`. Для второго телефона замените `a` на `b` в обеих командах выбранной платформы.
Укажите адрес тестового HTTPS API в `EXPO_PUBLIC_API_ORIGIN` или `.env.local` и подключите нужный телефон.

## iOS

```sh
APP_VARIANT=a node scripts/expo.cjs prebuild --platform ios --no-clean --no-install
APP_VARIANT=a node scripts/expo.cjs run:ios --device --configuration Release --no-bundler
```

Для установки на iPhone нужна подпись Xcode для `com.tetafinance.app`. При первой сборке выполните `pod install` в каталоге `ios`.

## Android

```sh
APP_VARIANT=a node scripts/expo.cjs prebuild --platform android --no-clean --no-install
APP_VARIANT=a node scripts/expo.cjs run:android --device --variant release --no-bundler
```

На обоих телефонах проверьте название и иконку на домашнем экране, затем откройте приложение и сравните экран счетов.
У вариантов один идентификатор. Установка другого варианта на тот же телефон заменяет приложение при совпадении подписи.
