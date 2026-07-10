# Сборка RodjerCloud для macOS (Apple Silicon)

## Общая архитектура

RodjerCloud — Electron-приложение (React + TypeScript + Vite), использующее Telegram MTProto API (gramjs) как облачное хранилище.

Репозиторий **приватный** — все API-запросы к GitHub требуют `Authorization: token ...`.

### Стек
- Electron 33, electron-vite, electron-builder 25
- React 18, TypeScript, Vite 6
- Telegram API: gramjs (MTProto)
- Авто-обновление: **кастомное** (не electron-updater), через GitHub API

### Структура репозитория
```
electron/
  main/
    index.ts              # Main process: IPC, update, download
    telegram-service.ts   # Telegram MTProto клиент
    bot-service.ts        # Telegram Bot API (дубликаты, ссылки)
    auto-sync.ts          # Автосинхронизация
  preload/
    index.ts              # Bridge IPC → renderer
src/
  App.tsx                 # Корневой компонент + роутинг
  pages/                  # 18 страниц
  components/             # UI компоненты
  lib/                    # Утилиты, albums, v3store
  types/electron.d.ts     # Типы IPC
resources/                # Иконки
build/
  entitlements.mac.plist  # Sandbox entitlements
  notarize.js             # Notarization hook
  portable.nsi            # NSIS (только Windows)
scripts/
  generate-icons.sh       # Генерация .icns из PNG (macOS)
  generate-icons.ps1      # То же для Windows
```

---

## 1. Первоначальная настройка

### Требования
- macOS 13+ (Ventura или новее) на Apple Silicon
- Node.js 20+
- Xcode 15+ (для codesign и notarization)
- Apple Developer Program аккаунт (для notarization)

### Клонирование
```bash
git clone https://github.com/RodjerYan/RodjerCloud.git
cd RodjerCloud
npm install
```

### Иконка .icns
```bash
# На macOS — конвертирует resources/icon-256.png в .icns
bash scripts/generate-icons.sh
```
Убедись, что `resources/icon.icns` создан — без него сборка упадёт.

### GitHub токен (обязательно!)
Репозиторий приватный. Токен нужен для `githubFetch()` в рантайме (проверка обновлений).
```bash
# Способ 1: через gh CLI (авто-логин)
gh auth login

# Способ 2: через git-credentials
git config --global credential.helper store

# Способ 3: переменная окружения (для билда)
export GITHUB_TOKEN="gho_..."
```

---

## 2. Сборка

```bash
# Только arm64 (Apple Silicon)
npm run build:mac

# Результат в dist/:
#   RodjerCloud-1.0.x.dmg       — установщик
#   RodjerCloud-1.0.x-mac.zip   — портативная версия (для авто-обновления)
#   latest-mac.yml              — метаданные (не используется, но генерируется)
```

### Варианты команд (из package.json)
| Команда | Что собирает |
|---------|-------------|
| `npm run build:mac` | DMG + ZIP для arm64 |
| `npm run build:mac:arm64` | То же (алиас) |

### Примечание по архитектуре
`electron-builder.json` настроен **только на arm64**. Если нужна поддержка Intel Mac, добавь `arch: ["x64", "arm64"]` в mac.target.

---

## 3. Авто-обновление (кастомное)

**Важно:** приложение НЕ использует `electron-updater`. Обновление работает так:

1. **`checkUpdate()`** (`electron/main/index.ts:107`)
   - GET `/repos/RodjerYan/RodjerCloud/releases/latest` с `Authorization: token`
   - Сравнивает `tag_name` с текущей версией
   - Находит ассет по паттерну: `*.exe` (win) или `*.dmg` / `*-mac.zip` (mac)
   - Шлёт `app:update-available` с `assetId` в renderer

2. **`app:download-update`** (IPC handler, `index.ts:685`)
   - Скачивает по `https://api.github.com/repos/.../releases/assets/{assetId}`
   - Заголовки: `Authorization: token`, `Accept: application/octet-stream`
   - Следит за `302` редиректами (GitHub → CDN)
   - Сохраняет во временную папку как `update.exe` / `update.dmg`

3. **`app:install-update`** (IPC handler, `index.ts:697`)
   - **Windows**: пишет `ZoneId=0` в `:Zone.Identifier` (чтобы не блокировало SmartScreen), запускает через `shell.openPath()`, вызывает `app.quit()`
   - **macOS**: открывает DMG (пользователь вручную перетаскивает в /Applications) или запускает ZIP

### Для macOS авто-обновление пока требует ручного действия:
- `platformAssetPattern()` (`index.ts:619`) находит `.dmg` или `-mac.zip`
- DMG открывается Finder'ом — пользователь должен перетащить приложение в /Applications
- Рекомендуется в будущем: подписанный ZIP с ` electron-updater` для бесшовного обновления

---

## 4. Подпись кода (Code Signing) и Нотаризация

### Сертификаты
Получи в Apple Developer:
- **Certificate: Developer ID Application** (для распространения вне App Store)
- Загрузи в связку ключей (Keychain)

### Настройка notarize.js
`build/notarize.js` уже есть. Подключается в `electron-builder.json`:

```json
{
  "afterSign": "build/notarize.js",
  "mac": {
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist"
  }
}
```

### Переменные окружения для нотаризации
```bash
export APPLE_ID="your@apple.id"
export APPLE_ID_PASSWORD="app-specific-password"  # сгенерировать в appleid.apple.com
export APPLE_TEAM_ID="team-id-here"                # Team ID из Apple Developer
```

`build/entitlements.mac.plist` уже содержит права на:
- `allow-unsigned-executable-memory` (нужно для V8)
- `disable-library-validation`
- `network.client` / `network.server`
- `files.user-selected.read-write`
- `files.downloads.read-write`

---

## 5. Публикация релиза

### Через gh CLI (рекомендуется)
После сборки:
```bash
gh release create v1.0.x \
  "dist/RodjerCloud-1.0.x.dmg" \
  "dist/RodjerCloud-1.0.x-mac.zip" \
  "dist/latest-mac.yml" \
  --title "v1.0.x" \
  --notes "описание изменений"
```

### Что попадает на GitHub Releases:
| Файл | Для чего |
|------|----------|
| `RodjerCloud-1.0.x.dmg` | Ручная установка |
| `RodjerCloud-1.0.x-mac.zip` | Авто-обновление (кастомное) |
| `latest-mac.yml` | Метаданные (необязательно) |

GitHub Releases tag должен быть **без префикса `v` в версии** или с ним — `checkUpdate()` обрезает `v` через `.replace(/^v/, '')`.

---

## 6. Ключевые модули (что нужно знать AI)

### telegram-service.ts — MTProto клиент
- Инициализация через `api_id=35766547`, `api_hash=5e37a0cba3964d7ca0814147562452ce`
- Автосоздание канала "My area" при первом входе
- StringSession сохраняется в userData (`bot-session.json`)
- Методы: `listFiles()`, `downloadMediaToTemp()`, `uploadFile()`, `deleteMessages()`, `getUserId()`

### bot-service.ts — Telegram Bot API
- Отдельный сервис для работы с Bot API (не MTProto)
- Токен бота сохраняется в `bot-config.json`
- Сканирование дубликатов: только `image/*` и `video/*` (фильтр mimeType)
- HashDb хранится в `bot-hash-db.json` (первые 64KB sha256 + размер файла)
- `getDuplicateGroups(mediaOnly=true)` — возвращает только медиа-дубликаты

### index.ts — IPC handlers
- `app:check-update` — проверка новой версии
- `app:download-update` — скачивание через GitHub API
- `app:install-update` — запуск установщика / открытие DMG
- `bot:scan-duplicates` — запуск сканирования дубликатов
- `bot:get-duplicate-groups` — получение групп дубликатов

---

## 7. Известные особенности и подводные камни

### GitHub Private Repo
❌ `browser_download_url` возвращает 404 для приватных репо
✅ Используется `https://api.github.com/repos/.../releases/assets/{assetId}` + `Accept: application/octet-stream`

### macOS Gatekeeper
- Без подписи: `"RodjerCloud" cannot be opened because the developer cannot be verified`
- Для тестирования: `xattr -dr com.apple.quarantine /Applications/RodjerCloud.app`
- Для продакшна: обязательна Developer ID подпись + нотаризация

### Blockmap (latest-mac.yml / latest.yml)
Генерируется автоматически electron-builder. Не используется в кастомном обновлении, но можно загружать на GitHub — не мешает.

### Сборка на ARM64 (Apple Silicon)
- `electron-vite build` собирает JS/TS платформонезависимо
- `electron-builder --mac --arm64` пакует в DMG под arm64
- На ARM64 Mac можно собрать и x64 версию через `arch -x86_64`

### Очистка перед сборкой
```bash
# Удалить старые артефакты
rm -rf out/ dist/
npm run build:mac
```

---

## 8. Чеклист для первого релиза на macOS

- [ ] `npm install` выполнен без ошибок
- [ ] `resources/icon.icns` существует (сгенерирован через `scripts/generate-icons.sh`)
- [ ] GitHub токен работает (`gh auth status`)
- [ ] `npm run build:mac` собирает DMG успешно
- [ ] DMG открывается и приложение запускается (обойти Gatekeeper через `xattr`)
- [ ] Вход через Telegram работает (телефон → код → 2FA)
- [ ] Файлы загружаются/скачиваются из канала "My area"
- [ ] Проверка обновлений показывает новую версию
- [ ] Скачивание обновления через `app:download-update` работает
- [ ] **Если для продакшна**: сертификат Developer ID + нотаризация
- [ ] `gh release create v1.0.x` с DMG/ZIP/latest-mac.yml
