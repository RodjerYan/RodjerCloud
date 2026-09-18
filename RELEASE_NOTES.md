## Что нового в v1.0.251

- Оптимизация памяти: ленивая загрузка файлов (30 за раз) вместо загрузки всех 14k
- Листовой чтение кэша через `listFilesFromCache` с пагинацией
- Глобальный listener для превью вместо 14k IPC подписок
- Debounce поиска 300ms + лимит 100 результатов
- Кэширование DOMRect + requestAnimationFrame для selection box
- Мемоизация `loadFolders` и `folderFilesCache`
- Очистка temp HTML при закрытии preview
- Archiver level 9 → 6
- Лимит uploadedIndex 50k записей
- `autoCleanTrash` через `localTrashedIds` вместо сканирования всех сообщений
- `deltaSync` push + Set dedup вместо merged array

---

## What's new in v1.0.251

- Memory optimization: lazy file loading (30 at a time) instead of loading all 14k files
- Leaf cache reading via `listFilesFromCache` with pagination
- Global listener for thumbnails instead of 14k IPC subscriptions
- Search debounce 300ms + 100 result limit
- Cached DOMRect + requestAnimationFrame for selection box
- Memoized `loadFolders` and `folderFilesCache`
- Temp HTML cleanup on preview window close
- Archiver compression level 9 → 6
- uploadedIndex capped at 50k entries
- `autoCleanTrash` uses `localTrashedIds` instead of scanning all messages
- `deltaSync` uses push + Set dedup instead of merged array
