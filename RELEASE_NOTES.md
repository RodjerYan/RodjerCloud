## Что нового в v1.0.218

- Исправлены ошибки `net::ERR_FILE_NOT_FOUND` на Windows — protocol handler теперь корректно формирует file:// URL для Windows путей
- Исправлен битый аватар в сайдбаре на Windows — конвертация backslashes в forward slashes
- Исправлен preview контента на Windows — аналогичная проблема с путями
- Прогресс-модалка для массового удаления файлов — реальное время обработки пофайлов
- Прогресс-модалка для удаления навсегда в корзине
- Задержка 400ms между удалениями для обхода Telegram rate limit
- FloodWaitError теперь ждёт и повторяет запрос вместо тихой ошибки

---

## What's new in v1.0.218

- Fixed `net::ERR_FILE_NOT_FOUND` errors on Windows — protocol handler now correctly builds file:// URLs for Windows paths
- Fixed broken avatar in sidebar on Windows — backslash to forward slash conversion
- Fixed content preview on Windows — same path issue
- Progress modal for bulk file deletion — real-time per-file processing
- Progress modal for permanent deletion in trash
- 400ms delay between deletions to bypass Telegram rate limit
- FloodWaitError now waits and retries instead of failing silently
