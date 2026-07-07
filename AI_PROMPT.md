# RodjerCloud — AI портирование на iOS / macOS

## О проекте

RodjerCloud — это десктопное Electron-приложение (React + TypeScript), которое использует Telegram MTProto API как облачное хранилище. Пользователь входит в Telegram, приложение создаёт приватный канал "My area" и загружает/скачивает файлы через gramjs.

Репозиторий: https://github.com/RodjerYan/RodjerCloud

## Что нужно сделать

Создать **точную копию** RodjerCloud для **iOS** (или **macOS** на выбор) со всеми функциями:

### Экраны (см. docs/IOS_SPEC.md)
- SplashScreen → LoginScreen (телефон → код → 2FA) → Dashboard → 18 страниц
- Каждый экран идентичен десктопной версии

### Telegram API (см. docs/API_REFERENCE.md)
- api_id=35766547, api_hash=`5e37a0cba3964d7ca0814147562452ce`
- Автосоздание канала "My area" при первом входе
- Восстановление сессии через StringSession
- Загрузка/скачивание/удаление файлов через Telegram messages

### Рекомендуемый стек
- **iOS:** React Native + Expo + `telegrammer` или TDLib Swift wrapper
- **macOS:** React Native macOS (react-native-macos) или Electron с macOS-таргетом (уже настроен в `electron-builder.json`)

### Ключевые файлы в репозитории

| Файл | Описание |
|------|----------|
| `AI_PROMPT.md` | Этот файл — стартовая точка |
| `docs/IOS_SPEC.md` | Полная спецификация всех экранов и поведения |
| `docs/API_REFERENCE.md` | Telegram API, IPC, хранилище — документация для портирования |
| `ios/` | Заготовка React Native Expo проекта |
| `electron/main/telegram-service.ts` | **Оригинал** — весь Telegram MTProto клиент |
| `electron/main/index.ts` | **Оригинал** — все IPC обработчики (аналог бэкенда) |
| `src/App.tsx` | **Оригинал** — корневой компонент с роутингом |
| `src/components/LoginScreen.tsx` | **Оригинал** — экран входа (телефон → код → 2FA) |
| `src/pages/` | **Оригинал** — все 18 страниц приложения |

## Процесс

1. Прочитать `docs/IOS_SPEC.md` — полная спецификация
2. Прочитать `docs/API_REFERENCE.md` — API слой
3. Изучить оригинальные файлы в `electron/` и `src/`
4. Использовать заготовку в `ios/` как стартовую точку
5. Собрать и протестировать на симуляторе/реальном устройстве

## Архитектура iOS

```
ios/
  App.tsx                  # Корневой компонент (аналог src/App.tsx)
  src/
    screens/               # 18 экранов (см. IOS_SPEC.md)
    components/            # Переиспользуемые компоненты
    services/
      telegram.ts          # Telegram MTProto клиент (аналог telegram-service.ts)
      storage.ts           # Локальное хранилище (аналог v3store.ts)
    navigation/            # Tab/Stack навигация
    theme/                 # Тёмная тема, цвета
```

## Важно

- Все строки UI на **русском языке**
- Канал называется **"My area"** (англ., так в оригинале)
- При первом входе канал создаётся автоматически
- При повторном входе канал находится по названию среди диалогов
