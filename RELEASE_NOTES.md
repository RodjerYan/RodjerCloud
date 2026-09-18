## Что нового в v1.0.255

- Исправлен краш при массовой загрузке файлов — дедупликация очереди uploads
- Увеличен throttle прогресса загрузки до 300ms для снижения нагрузки на UI
- Обновления теперь проверяются напрямую через GitHub API (без Vercel proxy)
- Скачивание обновлений напрямую с GitHub Releases (без Vercel proxy)

---

## What's new in v1.0.255

- Fixed crash during bulk file upload — deduplicated upload queue
- Increased upload progress throttle to 300ms to reduce UI load
- Update checks now use GitHub API directly (no Vercel proxy)
- Update downloads use GitHub Releases directly (no Vercel proxy)
