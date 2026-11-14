# Этап 1. Технические проверки TэтаФинанс

13 ноября 2026 года. **Локальные проверки этапа 1 пройдены.** Серверная связка, два локальных HTTPS-хоста и Release-сборки в обоих эмуляторах проверены на синтетических данных. Доступ к тестовой VM и параметры рабочего маршрута ещё предстоит подтвердить. Физические телефоны входят в [приёмку этапа 6](../PROJECT_PLAN.md#критерии-приёмки).

## Результаты

| Проверка | Результат | Что осталось проверить |
| --- | --- | --- |
| Node.js 26, Fastify, Drizzle и MySQL 8.4 | **Пройдено локально в Docker на Linux arm64.** Транзакция InnoDB сохранила строку. Исключение в следующей транзакции откатило вторую строку. Fastify вернул HTTP `200`, число строк `1` и точное значение `9007199254740993` в строковых полях записи и `SUM`. | Повторить на тестовой VM. Проверка на целевом Ubuntu 24.04 предусмотрена при подготовке выпуска. |
| Два HTTPS-хоста | **Пройдено локально.** В Docker клиент отклонил сертификат Caddy без доверенного CA. После явного добавления CA мобильный health-маршрут, HTML админки и административный маршрут вернули `200` на своих хостах. Перекрёстные запросы вернули `404`. | Проверить публичные DNS, доверие системным CA, браузер из интернета и телефоны по Wi-Fi и мобильной сети. |
| HTTPS из мобильных Release-сборок | **Пройдено на iPhone 17 Pro Simulator и Pixel 9 Emulator.** При выключенном Metro оба клиента получили HTTP `200` от `https://localhost:18443/api/v1/health` и сверили версии Node.js и MySQL, InnoDB, число строк, точную сумму и `SUM`. iOS до добавления тестового CA отклонил запрос, после добавления выполнил его. | Проверить системное доверие к сертификатам рабочих хостов при приёмке. |
| iOS Release | **Пройдено в симуляторе iPhone 17 Pro на iOS 26.5.** Release со штатной подписью Xcode запустился при выключенном Metro. Установка поверх предыдущей версии обновила `CFBundleVersion` с 1 до 2, маркер SecureStore сохранился. Неподписанный `iphoneos` Release содержит `main.jsbundle` (1 496 381 байт). | Подпись для физического iPhone остановилась с ошибкой Xcode `requires a development team`. Установка и обновление на телефоне открыты. |
| Android Release | **Пройдено в эмуляторе Pixel 9 на Android 15 (API 35).** Собраны два APK для `arm64-v8a` со встроенным `assets/index.android.bundle`. Оба APK подписаны одним временным ключом, совпадение сертификата проверено через `apksigner`. Команда `adb install -r` обновила `versionCode` с 1 до 2. При холодном запуске без Metro маркер SecureStore сохранился. | Повторить на целевом телефоне с ключом выбранной схемы распространения. |
| PIN и SecureStore | **Пройдено на обоих виртуальных устройствах.** Неверный локальный тестовый PIN отклонён. Верный тестовый PIN позволил записать и прочитать маркер SecureStore. При отсутствии зарегистрированной биометрии приложение предложило PIN. В симуляторе iOS имитация Face ID позволила прочитать защищённое значение, а отключение имитации вернуло приложение к PIN. | Проверить на целевых телефонах чтение биометрического секрета, отмену, смену набора и отказ для слабой биометрии Android. |
| Доступ к тестовой VM | **TCP 22 доступен** на `192.168.139.211`. SSH с `StrictHostKeyChecking=yes` вернул `No ED25519 host key is known`. | Нужны подтверждённый ключ хоста и настроенный SSH-доступ. Версия Ubuntu, архитектура и Docker на VM ожидают проверки. |

В неподписанной iOS-сборке для симулятора Keychain вернул `-34018` из-за отсутствия entitlements. Повторная сборка со штатной подписью Xcode добавила `application-identifier`, после чего сценарий PIN и SecureStore прошёл.

В исходниках установленного `expo-secure-store 58.0.3` iOS использует `.biometryCurrentSet`, а Android проверяет `BIOMETRIC_STRONG` и передаёт шифр Keystore в `BiometricPrompt.CryptoObject`. Решение о нативном модуле зависит от поведения целевых телефонов при отмене, временной недоступности и необратимой инвалидизации ключа. [Expo SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/), [реализация iOS](https://github.com/expo/expo/blob/sdk-58/packages/expo-secure-store/ios/SecureStoreModule.swift), [реализация Android](https://github.com/expo/expo/tree/sdk-58/packages/expo-secure-store/android/src/main/java/expo/modules/securestore)

## Версии прогона

| Компонент | Версии |
| --- | --- |
| Mac и Docker | macOS `26.7.2 (25G332)`, arm64. Docker Client и Engine `29.8.2`, Docker Compose `5.5.0`. |
| API и БД | Node.js `26.13.1` и npm `11.20.0` в `node:26.13.1-bookworm-slim`. Fastify `5.12.8`, Drizzle ORM `0.45.4`, mysql2 `3.24.6`, MySQL `8.4.13`. [Релизы Node.js](https://nodejs.org/dist/index.json), [релизы MySQL 8.4](https://dev.mysql.com/doc/relnotes/mysql/8.4/en/) |
| Локальный HTTPS | Caddy `2.11.9`. DNS-алиасы `api.tetafinance.test` и `admin.tetafinance.test` действовали внутри Docker. |
| Expo | Node.js `24.14.1`, npm `11.11.0`, шаблон `expo-template-blank-typescript 58.0.34`, Expo `58.0.25`, React Native `0.88.1`, React `19.3.0`, TypeScript `6.0.3`, SecureStore `58.0.3`. Прошли `npm ci`, `tsc --noEmit` и `expo prebuild --no-install`. [Матрица Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/), [требования к Node.js](https://expo.dev/changelog/sdk-58#tool-version-bumps) |
| iOS | Xcode `26.6 (17F113)`, SDK `26.5`, CocoaPods `1.14.3`, deployment target `16.4`. |
| Android | Zulu JDK `21.0.4+7-LTS`, Gradle `9.4.1`, AGP `9.2.1`, SDK Platform `37.0` rev 2, Build Tools `37.0.0`, NDK `27.1.12297006`, CMake `3.22.1`, Platform Tools `37.0.0-14910828`. Итоговый APK имеет `compileSdk 37`, `targetSdk 36`, `minSdk 24`. SDK 37 и Build Tools 37 добавлены во временный каталог SDK. Oracle JDK `26.0.1` обнаружен при инвентаризации. Gradle работал под Zulu 21. [Шаблон Gradle Expo](https://github.com/expo/expo/blob/sdk-58/templates/expo-template-bare-minimum/android/gradle/wrapper/gradle-wrapper.properties), [репозиторий Android SDK](https://dl.google.com/android/repository/repository2-3.xml) |

## Команды и контрольные суммы

Пробные проекты собраны во временном каталоге. Для API использован чистый запуск `npm ci` в образе Node.js. Для запросов из эмуляторов Caddy слушал `127.0.0.1:18443` на Mac. На Android использован `adb reverse tcp:18443 tcp:18443`, а тестовый CA задан в Network Security Configuration пробной сборки только для `localhost`. На iOS CA добавлен только в тестовый симулятор командой `simctl keychain add-root-cert`. Проверка сертификатов была включена. [Android Network Security Configuration](https://developer.android.com/privacy-and-security/security-config)

Для iOS после `pod install` использован `xcodebuild -configuration Release` с `-sdk iphoneos CODE_SIGNING_ALLOWED=NO` и отдельной сборкой `-sdk iphonesimulator` со штатной подписью. Для Android использован `./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a`. Запуск проверен через `simctl` и ADB. Сценарии PIN и SecureStore прогнаны через Maestro.

| Артефакт прогона | SHA-256 |
| --- | --- |
| `node:26.13.1-bookworm-slim` | `5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1` |
| `mysql:8.4.13` | `a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902` |
| `caddy:2-alpine` | `78bd35025c7ba85961dd149ae670315129954e77abe2383ac47c89106b35ade9` |
| Временный `api/package-lock.json` | `5e3d0ab7abf4d0abfbe29a6eeb8c05af88a02d874c8ddd7b02dc2cf481601cb4` |
| Временный `mobile/package-lock.json` | `190667dcea6db474e33b493cc58f1f4bf9e7c445c3d9631c532bfd390209067d` |
| Временный `mobile/ios/Podfile.lock` | `44c0d8840f9f031fec4f72356d35fc9f673ccb8b561dc3ce40402988e0d0b108` |

## Доступ к VM и параметры рабочего маршрута

Подтвердить ключ SSH тестовой VM и доступ оператора, записать фактические версии Ubuntu и Docker. Согласовать оператора, публичные имена API и админки, тестовые имена и точку TLS-терминации.

## Приёмка на этапе 6

На целевых iPhone и Android проверить подпись, установку, обновление, сохранение состояния, PIN и аппаратную биометрию. Для iPhone подтвердить команду Apple, способ подписи и владельца. Для Android подтвердить идентификатор пакета, ключ подписи и владельца его зашифрованной резервной копии. Проверить HTTPS с системным доверием к сертификатам. Мобильный API проверить по Wi-Fi и мобильной сети при выключенном Metro, административный хост — из внешнего браузера. [Apple о Personal Team](https://developer.apple.com/help/account/basics/about-your-developer-account), [Expo об ad hoc](https://docs.expo.dev/build/internal-distribution/#ios-ad-hoc-distribution), [Android о подписи](https://developer.android.com/studio/publish/app-signing)

Версии из таблицы описывают фактический прогон. Идентификатор `com.tetafinance.stage1probe`, временный ключ APK и домены `.test` использовались для эксперимента.
