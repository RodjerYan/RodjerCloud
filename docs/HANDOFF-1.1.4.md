# RodjerCloud — HANDOFF v1.1.4 (2026-09-27)

Инструкция для продолжения на другом ПК / в следующей сессии. Самодостаточна.

## 1. Продукт и стек

- **RodjerCloud** — десктопное облачное хранилище через Telegram (MTProto, gramjs), паритет с Google/Yandex Disk.
- Electron 33 (arm64 mac + Windows), React 18 + TS + Vite (electron-vite), gramjs, ffmpeg-static, hls.js 1.7.3, **plyr 3.8.4** (новый в 1.1.4).
- Репо: https://github.com/RodjerYan/RodjerCloud (main).

## 2. Репо / версия / CI

| Поле | Значение |
|---|---|
| Версия | **1.1.4** (package.json) |
| Коммит | `e944aab` «v1.1.4: Plyr-плеер …🚀» |
| Тег | `v1.1.4` (annotated) |
| CI | GitHub Actions «Build and Release», run **36348146349** — см. статус ниже |
| Матрица | `windows-latest` → `build:ci:win` → `*.exe` + blockmap; `macos-latest` → `build:ci:mac:arm64` → `*.dmg` + blockmap; затем job `release` создаёт GitHub Release с ассетами |

**Статус CI:** ✅ run 36348146349 `completed / success` — build(macos) ✓, build(windows) ✓, release ✓. GitHub Release v1.1.4 опубликован, ассеты: `RodjerCloud-1.1.4.exe` (134MB), `RodjerCloud-1.1.4-arm64.dmg` (164MB), `RodjerCloud-1.1.4.dmg` (168MB) + blockmaps.

Команды:
```bash
npm ci --legacy-peer-deps   # как в CI
npm run dev                 # дев (ТОЛЬКО так, НЕ собирать локально!)
npm run build:ci:win        # локально НЕ запускать — только CI
npm run build:ci:mac:arm64  # локально НЕ запускать — только CI
npx tsc --noEmit            # обязательная проверка перед каждым коммитом (=0)
```

## 3. Что ПРОЙДЕНО (закрыто и проверено в 1.1.4)

| # | Что | Корень/суть | Verify (доказательство) |
|---|---|---|---|
| 1 | **Буферизация52KB/s** (главный баг тяжёлых видео) | `launchFetchWindow.onChunk` вычислял `chunkStart = pos + offset` с offset=0 в КАЖДОМ чанке → каждый 512KB перезаписывал окно `[pos..pos+512K)` | R5d: `let written=0` вне onChunk, `chunkStart = winStart + written + offset` (video-stream-server ≈433, 487-491). Замер: буфер рос ~+4.4-5s/4s цикла, стыки пропали |
| 2 | Прямой `/stream` — первый кадр ~1s | mov раньше шёл HLS-first (ffmpeg), теперь direct | `/tmp/vtest.mjs 13741`: firstFrame **1005-2014ms, 1080x1920**, 0 пауз за 35s; `/tmp/directtest.mjs`: 1018ms, 0/90 stall, 1.0x, HEVC нативно |
| 3 | HLS-путь (fallback/mkv/avi) | autoLevelCapping release, RESOLUTION-фикс | firstFrame 1516ms 240p→1080p, 3/90 stall, played 0.97x |
| 4 | **Plyr-плеер** (S1) | `plyr@3.8.4` в deps, инлайн `loadPlyrJsInline/loadPlyrCssInline` в preview-шаблон (ТОЛЬКО внутри `${}` main-шаблона, не в клиентском JS), ru-i18n, тёмная тема | audit: `plyrActive:true`, `bar:"none"`; fill-CSS `#media .plyr{100%}` (скриншот: видео заполняет окно) |
| 5 | **Две шкалы + стабильная длительность** | `.plyr__progress__buffer` (загрузка) отдельным слоем, played через input-fill; `Object.defineProperty(vid,'duration')` только при `realDur>0` | duration `dur:372` не растёт при буферизации (audit DURATION_STABLE) |
| 6 | **MOV direct-first** (S1x) | `resolvePreviewSrc`: mov → `/stream` как mp4/webm; hlsPending остался ТОЛЬКО для mkv/avi (Chromium их не декодирует) | tsc=0; замеры п.2 |
| 7 | Битый preview-cache (баг-репорт «Не удалось загрузить файл») | Скачанный обрывок → ffmpeg «moov atom not found» → convert мёртв | previewConverter: `expectedSize`-проверка после скачивания, несовпадение → удалить dst (следующая попытка перекачает); call-sites в index.ts (`f.fileSize`) и hlsServer (`meta.message.file.size`) |
| 8 | Залипающая «Буферизация…» | `video.onwaiting`/прогресс-хендлеры ПОКАЗЫВАЛИ `#dl` после `showVideoError` | централизованный гард в `dlShow` (не показывать при видимом `#error`) + сброс `#error` в начале `renderMedia` |
| 9 | Self-heal reconnect (S2x) | Защита от мёртвого клиента после gramjs «Disconnecting...» | telegram-service: таймер 20s, `client.disconnected` → `reconnect(lastSession)`, кулдаун 30s, подавление 60s после штатных reconnect/startAuth/logout — **работу в бою НЕ проверял (см. §4)** |
| 10 | TypeScript | — | `npx tsc --noEmit` → **0** перед коммитом |

## 4. НЕ доделано / известные проблемы (С ЧЕГО ПРОДОЛЖИТЬ)

1. **Видео встаёт на паузу, когда окно превью перекрыто/скрыто** (не «как на YouTube» в фоне).
   - Диагностика: при `document.visibilityState=hidden` (macOS occlusion — окно перекрыто главным окном/DevTools) Chromium ставит `pause`; корреляция 1:1 (vis hidden → pause в тот же мс). Когда окно на поверхности — не воспроизводится (35s чисто).
   - Фикс: `webPreferences: { backgroundThrottling: false }` в BrowserWindow превью (index.ts ≈2208) + проверка; при необходимости `pw.setAlwaysOnTop` при воспроизведении. **Не входит в 1.1.4** (нет проверки).
2. **Disconnect-шторм gramjs в dev-сессиях**: «Disconnecting...» каждые ~80-100s (MTProtoSender.js:189). Self-heal из §3.9 в логах **ни разу не сработал** — проверить: действительно ли `client.disconnected===true` после этих варнов (кандидат: это cleanup borrowed-sender'а после cross-DC, а main client жив), осмотреть `_cleanupExportedSender` (telegram/network/MTProtoSender.js).
3. **`cache coverage mismatch` warnings** в логе — ложная тревога self-check: `RANGE_CACHE_MAX_BYTES=128MB` → `evictBehind` вытесняет начало окна, tee отдаёт данные напрямую, playback не страдает. Опционально: поднять лимит / смягчить проверку (video-stream-server ≈517-528).
4. **Матрица ST8 на CI-артефактах не прогонялась** (проверялось только в dev): 5728 mp4, 13741 mov (direct), 15074 mov (битый кэш → должен восстановиться), 9897 4K (low-first), mkv/avi (hlsPending), фоновый HLS-upgrade по меню качества.
5. Тег `v1.1.3` отсутствует локально (CI для него был) — не влияет на 1.1.4.

## 5. Подводные камни (НЕ наступать)

- **Никогда не собирать локально** — только правки + `npx tsc --noEmit`; релиз = коммит → тег `v*` → push → CI.
- **Не закачивать тест-файлы** в облако (11115 файлов / 202.8GB — только существующие).
- **Не локализовать клиентский JS в main-шаблон**: функции инлайна (`loadPlyrJsInline` и т.п.) вызывать ТОЛЬКО внутри `${}` шаблона preview-HTML, иначе ReferenceError в renderer.
- electron-vite **не пересобирает main автоматически** — после правок index.ts/main нужен полкий pkill + рестарт dev; dev-джоб: `ctx_shell run_in_background, timeout_ms=3600000`, лог `/tmp/rodjer-dev.log`, CDP 9223.
- Тестовые скрипты лежат в `/tmp` (vtest/directtest/audit2/pausewatch) — **не переносимы**, на новом ПК переписать (см. паттерн: CDP → preview.open → поллинг video state).
- `.opencode/`, `.ai/` — локальные, в git не тащить (`.ai/` в .gitignore, `.opencode/` стейджить никогда).
- Открытые dispatch-ид сессий: S1x `ses_f1ba1a7fbffejB3yrbU3OCist7`, dlShow-guard `ses_f1b941eebffeK51xiUk9Pf9TFY` (tsc=0 подтверждён).

## 6. Чек-лист продолжения

- [ ] Убедиться, что CI run 36348146349 зелёный: артефакты `installer-Windows (*.exe)` и `installer-macOS (*.dmg)` + GitHub Release v1.1.4 создан
- [ ] Скачать оба артефакта, установить на mac И windows: открыть видео (mp4/mov), проверить первый кадр ≤5s, две шкалы, полную длительность сразу, нет залипшей «Буферизация…»
- [ ] Фоновое воспроизведение при перекрытии окна → фикс §4.1 (`backgroundThrottling:false`)
- [ ] Разобрать disconnect/self-heal §4.2 (проверить `client.disconnected` реально ли true)
- [ ] Прогнать матрицу §4.4
- [ ] После фиксов: tsc=0 → коммит → тег v1.1.5 → push → CI → новый handoff

## 7. Workspace задачи

`.ai/tasks/T-20260927-004/` (request.md, state.json, execution.log, result.md) — полный след релиза.
Предыдущая линия (T-20260926-001, ST1-ST7/R4/R5b-d/S1) — `.ai/tasks/T-20260926-001/execution.log`.
