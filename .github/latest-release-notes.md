## Что нового в v1.1.14

- **Файлы только из облачного канала.** Источник списка — историю приватного канала `My area`. Пересланные сообщения из личных диалогов и Saved Messages («Избранное») больше не попадают в общий список файлов, а старые такие записи удаляются при фоновой сверке с сервером.
- **Канал нельзя подменить.** ID канала сохраняется в `channel-id.json` и проверяется при каждом входе: это должен быть именно broadcast-канал, не группа и не личный чат. Переименование канала больше не создаёт новый канал.
- **Избранное осталось только метками.** Оно по-прежнему отмечает файлы по `messageId`, но само по себе файлы не добавляет — как и папки, которые только группируют уже существующие записи канала.
- **Живой мини-плеер.** Панель музыки мягко «дышит», кнопка play пульсирует, прогресс подсвечивается, а на обложке во время воспроизведения появляется маленький эквалайзер. При паузе анимация останавливается; системная настройка «уменьшить движение» уважается.
- **Сборки.** GitHub Actions собирает установщик для Windows и macOS ARM64 (M1/M2/M3, не Intel).

---

## What's new in v1.1.14

- **Files come only from the cloud channel.** The list is read from the private `My area` channel history. Messages forwarded from private chats or Saved Messages are no longer added to the file list; old entries like that are removed during the background server check.
- **The channel cannot be swapped.** The channel ID is saved in `channel-id.json` and validated on every login: it must be a broadcast channel, not a group or a private chat. Renaming the channel no longer creates a new one.
- **Favorites are still just marks.** They tag files by `messageId` but do not create files; folders likewise only group entries that already exist in the channel.
- **Live mini-player.** The music bar gently breathes, the play button pulses, the progress line glows and a small equalizer appears on the cover while playing. Animation stops when paused and respects `prefers-reduced-motion`.
- **Builds.** GitHub Actions produces a Windows installer and a macOS ARM64 build (M1/M2/M3, not Intel).
