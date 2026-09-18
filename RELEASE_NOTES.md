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
