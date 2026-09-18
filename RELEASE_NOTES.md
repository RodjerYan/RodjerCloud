## Что нового в v1.0.260

- Исправлен краш при массовой загрузке файлов — заменены синхронные операции (execFileSync, readFileSync) на асинхронные
- Добавлен семафор для thumbnail-операций (макс 2 одновременно) для предотвращения пиков потребления памяти
- FFmpeg и sips теперь запускаются асинхронно — UI больше не замерзает при генерации превью

---

## What's new in v1.0.260

- Fixed crash during bulk file upload — replaced synchronous operations (execFileSync, readFileSync) with async equivalents
- Added semaphore for thumbnail generation (max 2 concurrent) to prevent memory spikes
- FFmpeg and sips now run asynchronously — UI no longer freezes during thumbnail generation
