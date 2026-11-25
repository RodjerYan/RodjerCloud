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
