# RodjerCloud — API Reference для iOS/macOS порта

## 1. Telegram MTProto

### Учётные данные
```typescript
const API_ID = 35766547
const API_HASH = '5e37a0cba3964d7ca0814147562452ce'
```

### Аутентификация (3 шага)

```
Шаг 1: client.start({ phoneNumber })
  → сервер присылает код
  → ждём phoneCode

Шаг 2: client.start({ phoneCode })
  → если код верный → сессия создана
  → если запрошен пароль → переходим к шагу 3

Шаг 3: client.start({ password: '2fa_password' })
  → если пароль верный → сессия создана
```

### Работа с каналом

```typescript
// Поиск канала по имени
const dialogs = await client.getDialogs({ limit: 200 })
for (const dialog of dialogs) {
  if (dialog.entity.title === 'My area') {
    channelId = dialog.entity.id
  }
}

// Создание канала
const result = await client.invoke(
  new Api.channels.CreateChannel({
    title: 'My area',
    about: 'RodjerCloud Storage Channel',
    megagroup: false,
  })
)
```

### Основные операции

```typescript
// Загрузка файла
await client.sendFile(channelId, {
  file: filePath,
  caption: `${fileName}\nSize: ${fileSize}\nUploaded: ${date}`,
  forceDocument: true,
  workers: 4,
  progressCallback: (sent, total) => {},
})

// Список файлов
const messages = await client.getMessages(channelId, { limit: 200 })
messages.filter(m => m.file).map(m => ({
  messageId: m.id,
  fileName: m.file.name,
  fileSize: m.file.size,
  mimeType: m.file.mimeType,
  uploadedAt: m.date,
  caption: m.message,
}))

// Скачивание
await client.downloadMedia(message, { outputFile: downloadPath })

// Удаление
await client.invoke(
  new Api.channels.DeleteMessages({ channel: channelId, id: [messageId] })
)
```

### Сессия

```typescript
// Сохранение
const sessionString = client.session.save() // StringSession

// Восстановление
const session = new StringSession(savedString)
const client = new TelegramClient(session, API_ID, API_HASH)
await client.connect()
```

### Для iOS
- Рекомендуемая библиотека: **TDLib** (Telegram Database Library) через Swift wrapper
- Или **MTProtoKit** (Objective-C)
- Альтернатива: React Native + `telegrammer` (Swift MTProto)

## 2. IPC → iOS-эквивалент

Десктоп использует IPC (Inter-Process Communication) через `window.electronAPI`. На iOS это заменяется прямым импортом сервиса:

| Десктоп (IPC) | iOS (прямой вызов) |
|---|---|
| `window.electronAPI.telegram.login(phone)` | `TelegramService.shared.login(phone)` |
| `window.electronAPI.telegram.verifyCode(code)` | `TelegramService.shared.verifyCode(code)` |
| `window.electronAPI.telegram.verify2FA(password)` | `TelegramService.shared.verify2FA(password)` |
| `window.electronAPI.telegram.listFiles()` | `TelegramService.shared.listFiles()` |
| `window.electronAPI.telegram.uploadFile(path)` | `TelegramService.shared.uploadFile(url)` |
| `window.electronAPI.telegram.downloadFile(id, name)` | `TelegramService.shared.downloadFile(id, name)` |
| `window.electronAPI.telegram.deleteFile(id)` | `TelegramService.shared.deleteFile(id)` |
| `window.electronAPI.telegram.checkSession()` | `TelegramService.shared.checkSession()` |
| `window.electronAPI.telegram.reconnect()` | `TelegramService.shared.reconnect()` |
| `window.electronAPI.telegram.logout()` | `TelegramService.shared.logout()` |
| `window.electronAPI.app.copyToClipboard(text)` | `UIPasteboard.general.string = text` |
| `window.electronAPI.app.getVersion()` | `Bundle.main.infoDictionary["CFBundleShortVersionString"]` |
| `window.electronAPI.dialog.pickFile()` | `UIDocumentPickerViewController` |
| `window.electronAPI.storage.getDownloadPath()` | `FileManager.default.urls(for: .documentDirectory, ...)` |

## 3. Локальное хранилище (v3store → iOS)

Десктоп использует `localStorage` через `v3store.ts`. На iOS — `UserDefaults` или CoreData/SwiftData:

| v3store | iOS |
|---------|-----|
| `v3store.getFavs()` | `UserDefaults.standard.array(forKey: "favs")` |
| `v3store.toggleFav(item)` | `UserDefaults.standard.set()` |
| `v3store.logActivity(type, msg)` | append to array in UserDefaults |
| `v3store.getTags()` | `UserDefaults.standard.array(forKey: "tags")` |
| `v3store.addTag(tag)` | `UserDefaults.standard.set()` |
| `v3store.getPrefs()` | `UserDefaults.standard.dictionary(forKey: "prefs")` |
| `v3store.setPrefs(p)` | `UserDefaults.standard.set()` |

### Ключи хранилища
```
v3.trash, v3.favs, v3.shared, v3.activity,
v3.tags, v3.fileTags, v3.notes, v3.albums,
v3.meta, v3.prefs, v3.smartFilters, v3.recent,
v3.thumbCache, v3.audit
```

## 4. Форматы данных

```typescript
// trash
{ messageId: number, fileName: string, size: number, deletedAt: number }

// favorites
{ messageId: number, fileName: string, addedAt: number }

// shared link
{ id: string, fileName: string, messageId: number, createdAt: number,
  expiresAt?: number, password?: string, useCount: number }

// activity
{ id: string, type: "upload"|"download"|"delete"|"rename"|"share"|"tag"|"login"|"lock",
  message: string, ts: number }

// tags
{ name: string, color: string, createdAt: number }

// file tags
{ messageId: number, tags: string[] }

// notes
{ messageId: number, markdown: string, updatedAt: number }

// albums
{ id: string, name: string, messageIds: number[], createdAt: number }

// file meta
{ messageId: number, pinned?: boolean, color?: string, folder?: string }

// preferences
{ theme: "dark", accent: "cyan-purple", density: "comfortable",
  animations: "full", font: "inter", sidebarCollapsed: false }
```

## 5. Ограничения

- Максимальный размер файла: 2GB (Telegram API limit)
- Файлы больше 2GB нужно сплитить на 1.9GB части и объединять при скачивании
- Лимит сообщений в канале: 200 при listFiles (можно увеличить пагинацией)
