## Что нового в v1.1.15

- **Исправлено: новая загрузка «пропадала» в «Моих файлах».** Файл попадал в канал и в кэш, но получал дату создания самого файла вместо времени загрузки. Из-за этого он оказывался в старом дне и не находился в списке. Теперь `uploadedAt` — это реальное время загрузки в облако, а дата создания файла хранится отдельно в `originalDate`. Уже существующие записи такого вида автоматически исправляются при следующем запуске.
- **Загрузка сверяется с каналом.** После успешной отправки приложение перечитывает сообщение из канала по `messageId` и добавляет файл по серверным данным. Ошибки добавления в кэш больше не гасятся молча — они пишутся в лог.
- **Источник файлов — только канал.** Пересланные сообщения из диалогов и Saved Messages по-прежнему не попадают в общий список; выбор канала привязан к сохранённому ID broadcast-канала.
- **Мини-плеер.** Мягкая пульсация панели, кнопки, прогресса и эквалайзера на обложке сохранена.

---

## What's new in v1.1.15

- **Fixed: a new upload disappeared from “My files”.** The file reached the channel and the cache, but was stamped with the file’s creation date instead of the upload time, so it landed in an old day and could not be found. Now `uploadedAt` is the real cloud upload time and the file’s own creation date is kept separately in `originalDate`. Existing entries of this kind are repaired automatically on the next launch.
- **Uploads are verified against the channel.** After a successful send, the app re-reads the message from the channel by `messageId` and adds the file using server data. Cache-add errors are no longer silently swallowed — they are written to the log.
- **Files still come only from the channel.** Forwarded messages from private chats and Saved Messages remain excluded; the channel is pinned to a saved broadcast-channel ID.
- **Mini-player.** The gentle breathing/pulsing animation of the bar, play button, progress and cover equalizer is retained.
