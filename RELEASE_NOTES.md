## Что нового в v1.0.219

- Исправлен прогресс-бар загрузки — теперь корректно пересчитывается при добавлении файлов во время ongoing загрузки
- Прогресс загрузки считается по байтам вместо среднего арифметического
- Исправлен цикл загрузки — новые файлы, добавленные во время загрузки, теперь подхватываются
- Русские названия статусов в очереди загрузки (готово, загрузка, ожидание, ошибка)

---

## What's new in v1.0.219

- Fixed upload progress bar — now recalculates correctly when adding files during an ongoing upload
- Upload progress is now bytes-based instead of naive average
- Fixed upload loop — new files added during upload are now picked up
- Russian status labels in upload queue (done→готово, uploading→загрузка, etc.)
