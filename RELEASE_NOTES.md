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
