## Что нового в v1.0.261

- Ограничено количество workers до 8 (было 32 в turbo mode) — главная причина OOM крашей при загрузке
- Снижена максимальная параллельность загрузки с 5 до 3 для снижения потребления памяти
- Добавлены обработчики unhandledRejection и uncaughtException — приложение больше не падает без лога
- Добавлено логирование каждой загрузки (старт/успех/ошибка) в rodjercloud.log
- Асинхронные execFile/readFile для ffmpeg и HEIC thumbnail

---

## What's new in v1.0.261

- Capped upload workers to 8 max (was 32 in turbo mode) — main cause of OOM crashes
- Reduced max concurrent uploads from 5 to 3 to reduce memory pressure
- Added unhandledRejection and uncaughtException handlers — app no longer crashes silently
- Added upload logging (start/success/error) to rodjercloud.log
- Async execFile/readFile for ffmpeg and HEIC thumbnail generation
