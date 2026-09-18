## Что нового в v1.0.262

- Thumbnail генерация пропускается для файлов >50MB — главная причина native crash на MOV файлах
- Таймаут ffmpeg/sips снижен до 5 секунд (было 10-15)
- Добавлен maxBuffer в execFile вызовы для ffmpeg и sips
- Добавлен watchdog для загрузок — предупреждение в лог если загрузка длится >60 секунд
- Добавлено время выполнения в лог завершённых загрузок

---

## What's new in v1.0.262

- Thumbnail generation skipped for files >50MB — main cause of native crash on MOV files
- Reduced ffmpeg/sips timeout to 5 seconds (was 10-15)
- Added maxBuffer to execFile calls for ffmpeg and sips
- Added upload watchdog — logs warning if upload takes >60 seconds
- Added elapsed time to upload completion logs
