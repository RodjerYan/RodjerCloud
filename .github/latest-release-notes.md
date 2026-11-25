## Что нового в v1.1.12

- **Загрузка в облако больше не запускается сама.** Даже если в старом конфиге остался `autoSync.enabled=true`, при старте он сбрасывается в `false`, а сохранённая очередь загрузок очищается. Файлы уходят в облако только по явному нажатию пользователя.
- **Быстрый вход в приложение.** Проверка/создание бота и чтение структуры папок больше не блокируют подключение: они уходят в фон. Медленные послескановые проверки (flood-wait, поиск локальных видео, ffmpeg) тоже выполняются после открытия интерфейса. Если локальные папки уже есть, канал при открытии «Мои файлы» повторно не сканируется.
- **Настоящий прогресс вместо фиктивного таймера.** Экран загрузки показывает реальные этапы (подключение → канал → папки → файлы → сверка), процент, количество прочитанных сообщений, число файлов и номер пакета — в стиле приложения. Кнопка «Открыть файлы» позволяет пропустить ожидание.
- **Файлы и миниатюры появляются пакетами.** Кэш списка обновляется каждые 3 пакета, поэтому облако видно ещё до окончания полного сканирования канала.
- **Надёжный старт.** Если синхронизация завершилась до появления экрана загрузки, он сразу закрывается; защитный таймер не даёт ему заблокировать интерфейс.
- **Сборки.** GitHub Actions собирает установщик для Windows и macOS ARM64 (M1/M2/M3, не Intel).

---

## What's new in v1.1.12

- **No more automatic uploads.** Even if an old config still had `autoSync.enabled=true`, it is reset to `false` on startup and the persisted upload queue is cleared. Files are uploaded only after an explicit user action.
- **Faster startup.** Bot verification/creation and folder-structure loading no longer block reconnect — they run in the background. Slow post-scan checks (flood-wait, local video lookup, ffmpeg) also run after the UI is open. When local folders already exist, opening "My Files" no longer rescans the channel.
- **Real progress instead of a fake timer.** The loading screen shows actual stages (connect → channel → folders → files → verify), percent, scanned messages, file count and batch number, in the app's style. The "Open files" button lets you skip the wait.
- **Files and thumbnails arrive in batches.** The file cache is updated every 3 batches, so cloud contents appear before the full channel scan finishes.
- **Reliable start.** If sync completes before the loading screen mounts, it closes immediately; a safety timer prevents it from blocking the UI.
- **Builds.** GitHub Actions produces a Windows installer and a macOS ARM64 build (M1/M2/M3, not Intel).
