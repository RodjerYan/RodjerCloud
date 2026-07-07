# Сборка RodjerCloud для macOS

## Требования

- macOS 13+ (Ventura или новее)
- Node.js 20+
- Xcode 15+ (для codesign и notarization)
- Apple Developer account (для notarization)

## Подготовка

```bash
# 1. Клонировать репозиторий
git clone https://github.com/RodjerYan/RodjerCloud.git
cd RodjerCloud

# 2. Установить зависимости
npm install
```

## 3. Сгенерировать иконку .icns

```bash
bash scripts/generate-icons.sh
```

## 4. Сборка DMG

```bash
# Обычная сборка (x64)
npm run build:mac

# Универсальная сборка (x64 + arm64)
npm run build:mac:universal
```

Результат: `dist/RodjerCloud-1.0.0.dmg`

## Нотаризация (для распространения)

Установите переменные окружения:

```bash
export APPLE_ID="your@apple.id"
export APPLE_ID_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="team-id-here"
```

Сборка с нотаризацией произойдёт автоматически через `afterSign` хук.

## GitHub Actions

Включите Secrets в репозитории:
- `APPLE_ID`
- `APPLE_ID_PASSWORD`
- `APPLE_TEAM_ID`

При пуше в `main` GitHub Actions соберёт DMG и загрузит как artifact.

## Структура файлов для macOS

```
build/
  entitlements.mac.plist   # sandbox entitlements
  notarize.js              # notarization hook
resources/
  icon.icns                # macOS icon (auto-generated)
  icon-256.png             # source for .icns
```
