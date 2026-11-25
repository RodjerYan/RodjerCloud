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
