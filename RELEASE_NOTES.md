## Что нового в v1.1.16

- **Массовое удаление в корзину стало мгновенным.** Раньше для каждого файла отдельно запрашивалось сообщение, правился caption и добавлялась пауза — на 4 файла это уходило в ~10 секунд. Теперь заголовки берутся одним чтением кэша/канала, правки идут параллельно, а файлы исчезают из списка сразу после подтверждения. «Готово» показывается без ожидания сети.
- **Удаление и очистка в корзине больше не «висят».** Сканирование осиротевших multipart-чанков вынесено в фон: оно могло ждать до 8 секунд после того, как файлы уже удалены. Удаление выбранных файлов теперь одним запросом, а не по одному.
- **Массовое восстановление тоже ускорено** — все выбранные файлы восстанавливаются одной операцией.
- **Свайп-выделение больше не выделяет текст.** При выделении рамкой браузерный выбор текста отключается, поэтому названия файлов не подсвечиваются.
- Сохранены все предыдущие исправления: файлы только из приватного канала, новые загрузки не попадают в прошлое, мини-плеер с мягкой пульсацией.

---

## What's new in v1.1.16

- **Bulk move to trash is instant.** Each file used to be fetched and edited one by one with an extra pause, so 4 files took ~10 seconds. Captions are now read in one batch, edits run in parallel, and files disappear from the list as soon as you confirm. “Done” no longer waits for the network.
- **Deleting and clearing the trash no longer hangs.** The orphaned multipart-chunk scan now runs in the background — it could wait up to 8 seconds after the files were already gone. Selected files are deleted in one request instead of one by one.
- **Bulk restore is faster too** — all selected files are restored in a single operation.
- **Marquee selection no longer selects text.** Browser text selection is disabled while dragging the selection box, so file names are not highlighted.
- All previous fixes remain: files come only from the private channel, new uploads no longer land in the past, and the mini-player keeps its gentle pulsing animation.

---

## Что нового в v1.1.15

- **Исправлено: новая загрузка «пропадала» в «Моих файлах».** Файл попадал в канал и в кэш, но получал дату создания самого файла вместо времени загрузки. Из-за этого он оказывался в старом дне и не находился в списке. Теперь `uploadedAt` — это реальное время загрузки в облако, а дата создания файла хранится отдельно в `originalDate`. Уже существующие записи такого вида автоматически исправляются при следующем запуске.
- **Загрузка сверяется с каналом.** После успешной отправки приложение перечитывает сообщение из канала по `messageId` и добавляет файл по серверным данным. Ошибки добавления в кэш больше не гасятся молча — они пишутся в лог.
- **Источник файлов — только канал.** Пересланные сообщения из диалогов и Saved Messages по-прежнему не попадают в общий список; выбор канала привязан к сохранённому ID broadcast-канала.
- **Мини-плеер.** Мягкая пульсация панели, кнопки, прогресса и эквалайзера на обложке сохранена.

---

## What's new in v1.1.15

- **Fixed: a new upload disappeared from “My files”.** The file reached the channel and the cache, but was stamped with the file’s creation date instead of the upload time, so it landed in an old day and could not be found. Now `uploadedAt` is the real cloud upload time and the file’s own creation date is kept separately in `originalDate`. Existing entries of this kind are repaired automatically on the next launch.
- **Uploads are verified against the channel.** After a successful send, the app re-reads the message from the channel by `messageId` and adds the file using server data. Cache-add errors are no longer silently swallowed — they are written to the log.
- **Files still come only from the channel.** Forwarded messages from private chats and Saved Messages remain excluded; the channel is pinned to a saved broadcast-channel ID.
- **Mini-player.** The gentle breathing/pulsing animation of the bar, play button, progress and cover equalizer is retained.

---

## Что нового в v1.1.14

- **Файлы только из облачного канала.** Источник списка — история приватного канала `My area`. Пересланные сообщения из личных диалогов и Saved Messages («Избранное») больше не попадают в общий список файлов, а старые такие записи удаляются при фоновой сверке с сервером.
- **Канал нельзя подменить.** ID канала сохраняется в `channel-id.json` и проверяется при каждом входе: это должен быть именно broadcast-канал, не группа и не личный чат. Переименование канала больше не создаёт новый канал.
- **Избранное осталось только метками.** Оно по-прежнему отмечает файлы по `messageId`, но само по себе файлы не добавляет — как и папки, которые только группируют уже существующие записи канала.
- **Живой мини-плеер.** Панель музыки мягко «дышит», кнопка play пульсирует, прогресс подсвечивается, а на обложке во время воспроизведения появляется маленький эквалайзер. При паузе анимация останавливается; системная настройка «уменьшить движение» уважается.
- **Сборки.** GitHub Actions собирает установщик для Windows и macOS ARM64 (M1/M2/M3, не Intel).

---

## What's new in v1.1.14

- **Files come only from the cloud channel.** The list is read from the private `My area` channel history. Messages forwarded from private chats or Saved Messages are no longer added to the file list; old entries like that are removed during the background server check.
- **The channel cannot be swapped.** The channel ID is saved in `channel-id.json` and validated on every login: it must be a broadcast channel, not a group or a private chat. Renaming the channel no longer creates a new one.
- **Favorites are still just marks.** They tag files by `messageId` but do not create files; folders likewise only group entries that already exist in the channel.
- **Live mini-player.** The music bar gently breathes, the play button pulses, the progress line glows and a small equalizer appears on the cover while playing. Animation stops when paused and respects `prefers-reduced-motion`.
- **Builds.** GitHub Actions produces a Windows installer and a macOS ARM64 build (M1/M2/M3, not Intel).

---

## Что нового в v1.1.13

- **Поиск дубликатов стал фоновым.** Раньше он считал хеши прямо в окне «Альбомы» и останавливался визуально при переходе в другую папку. Теперь задача живёт в основной части приложения: можно спокойно переключаться между разделами — поиск продолжается, а прогресс виден в плавающем индикаторе.
- **Не пересчитывает старые хеши.** Хеши, посчитанные в v1.1.12 и ранее, переносятся в общую базу `bot-hash-db.json`; при повторном запуске обрабатываются только новые кандидаты.
- **Гораздо меньше запросов к Telegram.** Сообщения читаются пачками по 40 ID вместо одного запроса на файл; хеши считаются 4 потоками с паузами между пачками — это снижает риск flood-wait.
- **Прогресс и отмена.** Показывается число обработанных кандидатов, текущий файл и процент; поиск можно остановить кнопкой как в окне дубликатов, так и в плавающем индикаторе.
- **Результаты не теряются.** Группы дубликатов берутся из базы хешей в основной части приложения и доступны сразу при возврате в «Альбомы».
- **Сборки.** GitHub Actions по-прежнему собирает установщик для Windows и macOS ARM64 (M1/M2/M3, не Intel).

---

## What's new in v1.1.13

- **Duplicate scan now runs in the background.** It used to compute hashes inside the Albums page and appeared to stop when you switched folders. The job now lives in the main process: you can navigate anywhere, the scan keeps running, and a floating indicator shows progress.
- **No needless re-hashing.** Hashes computed in v1.1.12 and earlier are imported into `bot-hash-db.json`; later runs only process new candidates.
- **Far fewer Telegram requests.** Messages are fetched in batches of 40 IDs instead of one request per file, with 4 hash workers and small pauses between batches to reduce flood-wait risk.
- **Progress and cancel.** The UI shows processed candidates, the current file and a percent; the scan can be stopped from the duplicates page or from the floating indicator.
- **Results persist.** Duplicate groups come from the hash database in the main process and are available immediately when you return to Albums.
- **Builds.** GitHub Actions still produces a Windows installer and a macOS ARM64 build (M1/M2/M3, not Intel).

---

## Что нового в v1.1.12

- **Загрузка в облако больше не запускается сама.** Даже если в старом конфиге остался `autoSync.enabled=true`, при старте он сбрасывается в `false`, а сохранённая очередь загрузок очищается. Файлы уходят в облако только по явному нажатию пользователя.
- **Быстрый вход в приложение.** Проверка/создание бота и чтение структуры папок больше не блокируют подключение: они уходят в фон. Медленные послескановые проверки тоже выполняются после открытия интерфейса. Если локальные папки уже есть, канал при открытии «Мои файлы» повторно не сканируется.
- **Настоящий прогресс вместо фиктивного таймера.** Экран загрузки показывает реальные этапы, процент, количество прочитанных сообщений, число файлов и номер пакета в стиле приложения. Кнопка «Открыть файлы» позволяет пропустить ожидание.
- **Файлы и миниатюры появляются пакетами.** Кэш списка обновляется каждые 3 пакета, поэтому облако видно ещё до окончания полного сканирования канала.
- **Надёжный старт.** Если синхронизация завершилась до появления экрана загрузки, он сразу закрывается; защитный таймер не даёт ему заблокировать интерфейс.
- **Сборки.** GitHub Actions собирает установщик для Windows и macOS ARM64 (M1/M2/M3, не Intel).

---

## What's new in v1.1.12

- **No more automatic uploads.** Even if an old config still had `autoSync.enabled=true`, it is reset to `false` on startup and the persisted upload queue is cleared. Files are uploaded only after an explicit user action.
- **Faster startup.** Bot verification/creation and folder-structure loading no longer block reconnect — they run in the background. Slow post-scan checks also run after the UI is open. When local folders already exist, opening "My Files" no longer rescans the channel.
- **Real progress instead of a fake timer.** The loading screen shows actual stages, percent, scanned messages, file count and batch number in the app's style. The "Open files" button lets you skip the wait.
- **Files and thumbnails arrive in batches.** The file cache is updated every 3 batches, so cloud contents appear before the full channel scan finishes.
- **Reliable start.** If sync completes before the loading screen mounts, it closes immediately; a safety timer prevents it from blocking the UI.
- **Builds.** GitHub Actions produces a Windows installer and a macOS ARM64 build (M1/M2/M3, not Intel).

---

## Что нового в v1.0.270

- **Критическое исправление:** загрузки зависали на 0% навсегда — adaptiveSync был остановлен во время загрузок, Telegram connection пропадал
- Вернул adaptiveSync во время загрузок (как в v250 где всё работало)
- computeFileHash теперь имеет 5с timeout (не блокирует загрузку файлов с OneDrive)
- Добавлена diagnostic logging перед sendFile для отладки

---

## Что нового в v1.0.268

- **Критическое исправление:** OOM (нехватка памяти) renderer при загрузке больших MOV файлов
- DashboardHome больше не загружает все 12550+ файлов — использует пагинированный API
- Throttle для `files:changed` событий — max раз в 5 секунд вместо каждого цикла синхронизации
- Auto-recovery renderer после OOM или crash — окно автоматически перезагружается
- Debounce для обработчиков `files:changed` в DashboardHome и MyFilesPage (3 сек)

---

## Что нового в v1.0.267

- Полная диагностика жизненного цикла окна: close/closed/unresponsive с stack traces
- Renderer beforeunload handler для логирования попыток закрытия
- Window-all-closed и before-quit/will-quit логирование с состоянием загрузок
- Защита от закрытия окна во время активных загрузок (e.preventDefault)
- Force-quit IPC для принудительного закрытия
- SIGINT/SIGTERM обработчики
- App:close-blocked event для renderer

---

## What's new in v1.0.267

- Full window lifecycle diagnostics: close/closed/unresponsive/did-crash with stack traces
- Renderer beforeunload handler to log close attempts
- Window-all-closed and before-quit/will-quit logging with upload state
- Close protection during active uploads (e.preventDefault)
- Force-quit IPC for forced shutdown
- SIGINT/SIGTERM handlers
- App:close-blocked event for renderer

---

## Что нового в v1.0.266

- React.memo для FileThumb — предотвращает каскадные re-renders при progress updates
- React.memo для QueueItem — предотвращает re-render завершённых файлов
- Progress throttle увеличен до 1000ms (было 250ms) — снижает нагрузку на IPC
- progress batch только если есть изменения — skip если ничего не изменилось
- crashReporter для диагностики native crashes
- render-process-gone handler для логирования renderer crashes

---

## What's new in v1.0.266

- React.memo for FileThumb — prevents cascade re-renders on progress updates
- React.memo for QueueItem — prevents re-rendering completed files
- Progress throttle increased to 1000ms (was 250ms) — reduces IPC load
- Progress batch only if changes detected — skip if nothing changed
- crashReporter for native crash diagnostics
- render-process-gone handler for renderer crash logging

---

## Что нового в v1.0.265

- Адаптивный timeout: min 30мин, +20мин/GB (для 10GB файла timeout ~3.5 часа)
- Очистка temp-чанков при ошибке/отмене загрузки
- Проверка свободного места на диске перед multipart загрузкой
- Логирование размера части и timeout перед каждым sendFile

---

## What's new in v1.0.265

- Adaptive timeout: min 30min, +20min/GB (for 10GB file timeout ~3.5 hours)
- Temp chunk cleanup on error/cancel
- Disk space check before multipart upload
- Log part size and timeout before each sendFile

---

## Что нового в v1.0.264

- Пауза фоновой синхронизации во время загрузок (устраняет crash при параллельном getMessages + sendFile)
- 10-минутный timeout на каждую часть sendFile (защита от зависания)
- Логирование памяти до/после каждой загрузки
- process.on('exit') handler для логирования кодов выхода
- Watchdog теперь показывает использование памяти

---

## What's new in v1.0.264

- Pauses background sync during uploads (fixes crash from concurrent getMessages + sendFile)
- 10-minute timeout per sendFile part (prevents hanging)
- Memory logging before/after each upload
- process.on('exit') handler to log exit codes
- Watchdog now shows memory usage

---

## Что нового в v1.0.263

- Адаптивное количество workers в зависимости от размера файла (>500MB: 1 worker, >100MB: 2, <100MB: 2-4)
- Адаптивная параллельность загрузки (>500MB файлы: 1 загрузка, >100MB: 2, <100MB: до 3)
- Фронтенд и бэкенд синхронизированы по логике адаптивной параллельности
- Загрузка 10GB файла теперь безопасна: 6 частей по ~1.95GB, по 1 штуке, с 1 worker

---

## What's new in v1.0.263

- Adaptive worker count based on file size (>500MB: 1 worker, >100MB: 2, <100MB: 2-4)
- Adaptive upload concurrency (>500MB files: 1 upload, >100MB: 2, <100MB: up to 3)
- Frontend and backend synced on adaptive concurrency logic
- 10GB file upload now safe: 6 parts × ~1.95GB, 1 at a time, 1 worker each
