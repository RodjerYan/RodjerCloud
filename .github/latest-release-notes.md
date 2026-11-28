## Что нового в v1.1.17

- **Первичная загрузка файлов теперь возобновляется после выхода из приложения.** При чтении канала сохраняется не только найденные файлы, но и курсор сканирования: если закрыть приложение на 4 тысячах, следующий запуск продолжит именно с этого места, а не решит, что список уже полный.
- **Старые прерванные кэши больше не застревают.** Кэш без пометки о завершении сканирования один раз дочитывается заново с начала, уже найденные файлы при этом сохраняются и не дублируются.
- **Счётчик загрузки не сбрасывается** при возобновлении: UI сразу показывает уже прочитанные файлы и продолжает увеличивать число по мере чтения остальных.
- Сохранены все предыдущие исправления: файлы только из приватного канала, корректные даты новых загрузок, быстрые массовые операции с корзиной и выделение рамкой без подсветки текста.

---

## What's new in v1.1.17

- **Initial file loading now resumes after quitting the app.** While reading the channel, the app now persists the scan cursor along with the files. If you leave at 4,000 files, the next launch continues from that point instead of treating the partial list as complete.
- **Old interrupted caches no longer get stuck.** A cache without a “scan complete” marker is re-read once from the beginning; already cached files are kept and never duplicated.
- **The progress counter no longer resets** on resume: the UI immediately shows the files already read and keeps increasing the count as the rest are loaded.
- All previous fixes remain: files only from the private channel, correct dates for new uploads, fast bulk trash operations, and marquee selection without highlighting file text.
