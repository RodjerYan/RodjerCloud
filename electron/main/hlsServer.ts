import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import { convertVideoToMp4, downloadPreviewSourceOnce, resolveFfmpegPath, runFfmpeg } from './previewConverter'

// T-20260925-010 S1: mov/mkv/avi идут в HLS ПОКА файл качается —
//   1) resolveInput: сначала http://127.0.0.1:<port>/stream/<id> (ffmpeg
//      demux'ит mov/matroska/avi по HTTP Range — проверено прогоном, см.
//      .ai/tasks/T-20260925-010/artifacts/progcheck.log); если probe по
//      stream не даёт видеопоток → fallback: полное скачивание +
//      convertVideoToMp4 (прежняя ветка);
//   2) для этих форматов buildFfmpegArgs идёт БЕЗ -hls_playlist_type vod →
//      master.m3u8 + stream_N.m3u8 пишутся сразу после старта (ранний master),
//      плейлист растёт по мере транскода, ENDLIST добавляется на finalize →
//      hls.js играет live→vod (событийный плейлист поддерживается);
//   3) mp4/webm остаются на прежнем пути (vod + upgrade direct→HLS, T-003).

// T-20260925-003 S1: HLS-пайплайн main-процесса.
//   GET /hls/<token>/<messageId>/master.m3u8  → старт ffmpeg-сессии (если нет) + отдача
//   GET /hls/<token>/<messageId>/stream_N.m3u8, .../seg_N_00000.ts → отдача файлов
// ffmpeg читает исходник через наш же http-сервер (/stream/<id>); mov/mkv/avi —
// напрямую по stream (T-20260925-010 S1), только probe fail → скачивание +
// convertVideoToMp4 (тот же каталог preview-cache, что у resolvePreviewSrc).
//
// ВАЖНО (проверено прогоном ffmpeg 6/7 из node_modules/ffmpeg-static):
//   * при -hls_playlist_type vod плейлисты (master + stream_N.m3u8) пишутся только
//     по finalize транскода, .ts-сегменты появляются инкрементально;
//   * var_stream_map адресует ВЫХОДНЫЕ потоки по типу: "v:0,a:0 v:1,a:1"
//     (повторное "a:0" → «Same elementary stream found more than once»);
//   * master.m3u8 ложится в каталог вывода (каталог сессии), ссылки в нём —
//     плоские (stream_0.m3u8), без подкаталогов → простая отдача файлов.
// Поэтому master ждём с таймаутом (HTTP-путь: 15s → 503; IPC-путь REWORK#1:
// 60s — см. IPC_START_TIMEOUT_MS). Первый кадр от этого НЕ зависит: preview
// ставит прямой src сразу, а hlsStart идёт в фоне (upgrade direct→HLS);
// сессия после таймаута остаётся живой — повторный вызов ensureHlsSession
// дождётся готовности.

export type HlsResult = { hlsUrl: string } | { error: string }

type HlsMeta = { message: any; fileName: string; mimeType: string }

type HlsCtx = {
  telegramService: any
  port: number
  getMeta: (messageId: number) => Promise<HlsMeta | null>
}

let ctx: HlsCtx | null = null

function hlog(msg: string) {
  // [hls] → rodjercloud.log через console-override в electron/main/index.ts
  console.log(`[hls] ${msg}`)
}

// ==== T-20260925-010 S2: фазы fallback-ветки → preview-окна (T-005 progress) ====
// Пока mov/mkv/avi шли в HLS-first, их сессия может уйти во внутренний fallback
// (probe по stream не удался → скачивание + конвертация). Эти фазы раньше не
// были видны preview-окну (resolvePreviewSrc сразу вернул hlsPending) —
// index.ts вешает handler, который шлёт preview:progress окнам с этим messageId.
export type HlsProgress = { phase: 'download' | 'convert'; sent?: number; total?: number }
let progressHandler: ((messageId: number, ev: HlsProgress) => void) | null = null
export function setHlsProgressHandler(fn: (messageId: number, ev: HlsProgress) => void): void {
  progressHandler = fn
}
function sendProgress(messageId: number, ev: HlsProgress): void {
  if (!progressHandler) return
  try {
    progressHandler(messageId, ev)
  } catch {}
}

// REWORK#1 F7: секретный сегмент пути /hls/<token>/<id>/<file>.
//   * локальная web-страница не знает токен (случайные 16 байт на процесс,
//     передаётся только через IPC preview:hls-start) → её запрос → 404 ДО
//     ensureHlsSession, т.е. никакой чужой страницой нельзя запустить/удержать
//     ffmpeg (CPU-DoS) — и ответы она прочитать не может;
//   * ACAO:* при этом ставится ТОЛЬКО на ответах с валидным токеном: preview-
//     окно грузится с file:// (Origin: null) и hls.js читает манифесты через
//     XHR — без ACAO HLS с file:// не заработал бы (это не «читаемо всеми»:
//     без токена ответа с ACAO вообще нет).
const HLS_TOKEN = crypto.randomBytes(16).toString('hex')

export function getHlsToken(): string {
  return HLS_TOKEN
}

function hlsTokenOk(seg: string): boolean {
  if (seg.length !== HLS_TOKEN.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(seg, 'utf8'), Buffer.from(HLS_TOKEN, 'utf8'))
  } catch {
    return false
  }
}

// максимум параллельных сессий: 3-й запрос → {error} → preview продолжает по
// прямому stream (это ок), ffmpeg-нагрузка ограничена
const MAX_SESSIONS = 2
// ожидание master.m3u8 после старта ffmpeg (HTTP-путь: master обычно уже есть)
const START_TIMEOUT_MS = 15 * 1000
// REWORK#1 F1: ожидание master для IPC preview:hls-start — вызов идёт в ФОНЕ
// (первый кадр не ждёт HLS), поэтому можно ждать дольше: 60s покрывает почти
// все транскоды (5:00/1080p → master ≈ 45s) и позволяет сделать upgrade
// direct→HLS уже во время просмотра. Не успело → {error:'hls-not-ready'} →
// preview остаётся на direct (non-event), сессию приберёт TTL/close.
export const IPC_START_TIMEOUT_MS = 60 * 1000
// TTL-джанк: простой сессии без запросов → kill + удалить каталог
const IDLE_TTL_MS = 10 * 60 * 1000
// суммарный лимит hls-cache (старые каталоги удаляются по mtime)
const CACHE_MAX_BYTES = 500 * 1024 * 1024
const JUNK_INTERVAL_MS = 60 * 1000

type HlsSession = {
  id: number
  dir: string
  masterPath: string
  proc: ChildProcess | null
  ready: boolean
  exited: boolean
  // REWORK#1 F3: dropSession во время launch (getMeta/resolveInput/probe ещё
  // идут, proc=null) — флаг не даёт launch заспавнить ffmpeg уже вне sessions
  killed: boolean
  lastTouched: number
}

const sessions = new Map<number, HlsSession>()
let junkTimer: ReturnType<typeof setInterval> | null = null

// вызывается из startVideoStreamServer (общий порт/сервер → контекст один)
export function initHlsServer(c: HlsCtx): void {
  ctx = c
  ensureJunkTimer()
}

function ensureJunkTimer() {
  if (junkTimer) return
  junkTimer = setInterval(runJunk, JUNK_INTERVAL_MS)
  // не мешаем выходу процесса
  ;(junkTimer as any).unref?.()
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

function fileUsable(p: string): boolean {
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

async function waitForFile(p: string, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    if (fileUsable(p)) return true
    if (Date.now() - t0 >= timeoutMs) return false
    await sleep(200)
  }
}

function cacheRoot(): string {
  return path.join(app.getPath('userData'), 'hls-cache')
}

function sessionDir(messageId: number): string {
  return path.join(cacheRoot(), String(messageId))
}

function masterUrlFor(messageId: number): string {
  // REWORK#1 F7: токен в пути — без него страница не запустит и не прочитает HLS
  return `http://127.0.0.1:${ctx!.port}/hls/${HLS_TOKEN}/${messageId}/master.m3u8`
}

// сессия ещё «наша»: не drop'нута и не вытеснена (F3)
function sessionAlive(session: HlsSession): boolean {
  return !session.killed && sessions.get(session.id) === session
}

// ===== публичный API (вызывается из IPC preview:hls-start) =====

export async function ensureHlsSession(messageId: number, waitMs: number = START_TIMEOUT_MS): Promise<HlsResult> {
  if (!ctx) return { error: 'hls-not-ready' }

  const existing = sessions.get(messageId)
  if (existing) {
    // in-flight dedup: повторный запрос того же id не плодит ffmpeg —
    // просто ждём (или сразу отдаём) его master.m3u8
    existing.lastTouched = Date.now()
    return waitForMaster(existing, waitMs)
  }

  if (sessions.size >= MAX_SESSIONS) {
    hlog(`limit ${MAX_SESSIONS} sessions → reject id=${messageId}`)
    return { error: 'hls-session-limit' }
  }

  const session: HlsSession = {
    id: messageId,
    dir: sessionDir(messageId),
    masterPath: path.join(sessionDir(messageId), 'master.m3u8'),
    proc: null,
    ready: false,
    exited: false,
    killed: false,
    lastTouched: Date.now(),
  }
  sessions.set(messageId, session)
  ensureJunkTimer()

  try {
    await launch(session)
  } catch (e) {
    hlog(`start fail id=${messageId}: ${(e as Error).message}`)
    dropSession(session)
    return { error: (e as Error).message || 'hls-start-failed' }
  }

  // REWORK#1 F3: окно закрыли/сессию сняли, пока launch был на await-точках
  if (!sessionAlive(session)) return { error: 'hls-session-dropped' }

  return waitForMaster(session, waitMs)
}

// cleanup на preview:close — kill ffmpeg + удалить каталоги сессий файлов окна
export function cleanupHlsForIds(ids: number[]): void {
  for (const id of ids) {
    const s = sessions.get(id)
    if (!s) continue
    hlog(`preview close → cleanup id=${id}`)
    dropSession(s)
  }
}

// ===== HTTP-отдача =====

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
}

export async function handleHlsRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = req.url || ''
    // REWORK#1 F7: /hls/<token>/<id>/<file> — проверка токена ПЕРЕД чем-либо:
    // чужой запрос не читает ответы и не стартует ffmpeg (см. hlsTokenOk)
    const m = url.match(/^\/hls\/([^/?#]+)\/(\d+)\/([^?#]+)/)
    let tok = m ? m[1] : ''
    try { tok = decodeURIComponent(tok) } catch {}
    if (!m || !hlsTokenOk(tok)) {
      res.writeHead(404)
      return void res.end('Not found')
    }
    // авторизованный запрос: CORS только здесь — preview-окно с file:// читает
    // манифесты hls.js через XHR (Origin: null → нужен ACAO); глобальный ACAO
    // в video-stream-server на /hls/ больше НЕ ставится
    res.setHeader('Access-Control-Allow-Origin', '*')

    const messageId = parseInt(m[2], 10)
    let rel = ''
    try {
      rel = decodeURIComponent(m[3])
    } catch {
      rel = m[3]
    }
    // защита от path traversal и подмены каталогов
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
      res.writeHead(404)
      return void res.end('Not found')
    }

    const isMaster = rel === 'master.m3u8'
    if (isMaster) {
      // первый запрос master стартует ffmpeg-сессию
      const r = await ensureHlsSession(messageId)
      if ('error' in r) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        return void res.end(r.error)
      }
    } else {
      const s = sessions.get(messageId)
      if (s) {
        s.lastTouched = Date.now()
        s.ready = s.ready || fileUsable(s.masterPath)
      }
    }

    const dir = sessionDir(messageId)
    const resolved = path.resolve(path.join(dir, rel))
    const dirResolved = path.resolve(dir)
    if (resolved !== dirResolved && !resolved.startsWith(dirResolved + path.sep)) {
      res.writeHead(404)
      return void res.end('Not found')
    }

    if (!fileUsable(resolved)) {
      // master дописывается в finalize одновременно с плейлистами вариантов —
      // короткое ожидание закрывает гонку «master есть, stream_0.m3u8 ещё нет».
      // REWORK#1 F10: 5s → 3s (повторяющийся битый запрос не держит соединение)
      const waited = await waitForFile(resolved, sessions.has(messageId) ? 3000 : 0)
      if (!waited) {
        res.writeHead(404)
        return void res.end('Not found')
      }
    }

    const data = await fs.promises.readFile(resolved)
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return void res.end()
    res.end(data)
  } catch (e: any) {
    hlog(`serve error: ${e?.message || e}`)
    if (!res.headersSent) {
      res.writeHead(500)
      res.end('Internal Server Error')
    } else {
      try {
        res.destroy()
      } catch {}
    }
  }
}

// ===== старт ffmpeg-сессии =====

// REWORK#1 F3: сессию сняли (preview:close / hls-drop / TTL) пока launch был
// на await-точке → добиваем остатки запуска (proc ещё null) и не даём
// ensureHlsSession/waitForMaster зависнуть на мёртвой сессии
function abortLaunch(session: HlsSession): void {
  const proc = session.proc
  if (proc && !session.exited) {
    try { proc.kill() } catch {}
  }
  try {
    fs.rmSync(session.dir, { recursive: true, force: true })
  } catch {}
  hlog(`launch aborted (session dropped) id=${session.id}`)
}

async function launch(session: HlsSession): Promise<void> {
  const getMeta = ctx!.getMeta
  const meta = await getMeta(session.id)
  if (!sessionAlive(session)) return abortLaunch(session)
  if (!meta || !meta.message) throw new Error('message-not-found')

  const bin = resolveFfmpegPath()
  if (!bin) throw new Error('ffmpeg-unavailable')

  // ==== T-20260925-010 S1: вход сначала по http-stream ====
  // ffmpeg demux'ит mp4/webm/mov/mkv/avi по HTTP Range (сервер отдаёт 206 +
  // Accept-Ranges) → транскод стартует ПОКА файл качается из Telegram.
  // probe по stream не даёт видеопотока → mov/mkv/avi: прежний путь
  // (полное скачивание + convertVideoToMp4); mp4/webm: как раньше probe-failed.
  const ext = fileExt(meta)
  const progressive = ext !== 'mp4' && ext !== 'webm' // растущий HLS без vod
  let input = streamInput(meta)
  let probe = await probeInput(bin, input)
  if (!sessionAlive(session)) return abortLaunch(session)
  if (!probe.hasVideo) {
    if (!progressive) throw new Error('probe-failed')
    hlog(`stream probe fail id=${session.id} → full download+convert`)
    input = await resolveInputFallback(meta)
    if (!sessionAlive(session)) return abortLaunch(session)
    probe = await probeInput(bin, input)
    if (!sessionAlive(session)) return abortLaunch(session)
    if (!probe.hasVideo) throw new Error('probe-failed')
  }

  // вариантность: 480p + source (кап 1080p задаёт сам source) либо один
  // «source», когда высота неизвестна/мала (спека S1 п.2)
  const height = probe.height || Number(meta.message?.file?.height) || 0
  const twoVariants = height > 480

  // Явные битрейты НЕ влияют на качество (x264 остаётся на -crf — проверено
  // одинаковым размером выхода), но без них ffmpeg не может посчитать
  // BANDWIDTH для master.m3u8: для видео без аудио-дорожки он вообще не пишет
  // EXT-X-STREAM-INF («Bandwidth info not available») → у hls.js не будет
  // уровней. Оценка — из битрейта исходника (парсинг probe), фолбэк по высоте.
  const srcKbps = probe.videoKbps > 0
    ? probe.videoKbps
    : height >= 1080 ? 4000 : height >= 720 ? 2500 : 1500
  const mainKbps = Math.min(20000, Math.max(300, srcKbps))
  const loKbps = twoVariants
    ? Math.max(
        100,
        Math.min(mainKbps - 100, Math.round((mainKbps * 480 * 480) / Math.max(height * height, 1)))
      )
    : 0

  // REWORK#1 F3: последняя проверка перед mkdir/spawn — иначе spawn-ffmpeg
  // оказался бы вне sessions (TTL/джанк его не видят, каталог живого сессии
  // кеш-лимит попытался бы удалить)
  if (!sessionAlive(session)) return abortLaunch(session)

  // каталог мог пережить рестарт приложения (crash без cleanup) — вычищаем,
  // иначе waitForMaster увидит старый master.m3u8, а ffmpeg ещё транскодит
  try { fs.rmSync(session.dir, { recursive: true, force: true }) } catch {}
  fs.mkdirSync(session.dir, { recursive: true })
  const args = buildFfmpegArgs(input, session.dir, {
    twoVariants,
    hasAudio: probe.hasAudio,
    mainKbps,
    loKbps,
    progressive,
  })
  hlog(
    `start id=${session.id} variants=${twoVariants ? 2 : 1} audio=${probe.hasAudio} ` +
      `src=${height ? height + 'p' : 'unknown'} kbps=${mainKbps}${twoVariants ? '/' + loKbps : ''} ` +
      `${progressive ? 'growing-hls' : 'vod'} input=${input.slice(0, 120)}`
  )

  const proc = spawn(bin, args, { windowsHide: true })
  session.proc = proc
  proc.stdout?.resume() // дренируем, чтобы ffmpeg не упёрся в pipe

  let pending = ''
  proc.stderr?.on('data', (d: Buffer) => {
    pending += d.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() || ''
    for (const raw of lines) {
      const line = raw.trim()
      // прогресс (frame= … time= …) идёт через \r — в лог не пишем
      if (!line || /^frame=/.test(line) || /^size=/.test(line)) continue
      hlog(`ffmpeg: ${line}`)
    }
  })
  proc.on('error', (e) => {
    session.exited = true
    hlog(`spawn error id=${session.id}: ${e.message}`)
  })
  proc.on('exit', (code, sig) => {
    session.exited = true
    hlog(`exit id=${session.id} code=${code} sig=${sig}`)
    // каталог остаётся (vod можно переигрывать) — чистит preview:close / TTL-джанк
  })
}

function fileExt(meta: HlsMeta): string {
  const fileName = path.basename(String(meta.fileName || ''))
  return (fileName.split('.').pop() || '').toLowerCase()
}

// T-20260925-010 S1: базовый вход — наш http-stream (Range/206). Остальные
// форматы (wmv/…) по-прежнему не поддерживаются.
function streamInput(meta: HlsMeta): string {
  const ext = fileExt(meta)
  if (!['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) throw new Error('unsupported-format')
  return `http://127.0.0.1:${ctx!.port}/stream/${meta.message?.id}`
}

// Fallback, когда probe по stream не дал видеопотока: прежняя ветка mov/mkv/avi —
// полное скачивание исходника + конвертация в preview-cache → локальный mp4.
// Пути те же, что у preview:convert-fallback (index.ts) → кеш общий, а скачка
// дедуплицируется downloadPreviewSourceOnce (нет двойного скачивания).
async function resolveInputFallback(meta: HlsMeta): Promise<string> {
  const fileName = path.basename(String(meta.fileName || ''))
  if (!['mov', 'mkv', 'avi'].includes(fileExt(meta))) throw new Error('probe-failed')
  const messageId = meta.message?.id
  const previewDir = path.join(app.getPath('userData'), 'preview-cache')
  fs.mkdirSync(previewDir, { recursive: true })
  const srcPath = path.join(previewDir, `${messageId}_${fileName}`)
  const mp4Path = path.join(previewDir, `${messageId}_preview.mp4`)
  // уже готовый mp4 (его же готовит preview:load) → не перекачиваем
  if (fs.existsSync(mp4Path)) {
    try {
      if (fs.statSync(mp4Path).size > 0) return mp4Path
    } catch {}
  }
  const src = await downloadPreviewSourceOnce(ctx!.telegramService, messageId, srcPath, (sent, total) => {
    // фаза download → preview-окна (T-005 progress продолжает работать)
    sendProgress(messageId, { phase: 'download', sent, total })
  })
  if (!src) throw new Error('download-failed')
  sendProgress(messageId, { phase: 'convert' })
  const converted = await convertVideoToMp4(srcPath, mp4Path)
  if (!converted) throw new Error('convert-failed')
  return converted
}

type Probe = { hasVideo: boolean; hasAudio: boolean; width: number; height: number; videoKbps: number }

// «ffmpeg -i <input>» без выхода: печатает сводку потоков и сразу завершается
// (код 1 — это норма). Нужны height (решение 1 vs 2 варианта) и наличие аудио
// (var_stream_map обязан ссылаться на существующие потоки).
async function probeInput(bin: string, input: string): Promise<Probe> {
  const r = await runFfmpeg(bin, ['-hide_banner', '-i', input], 30 * 1000)
  return parseProbe(r.stderrHead || r.stderrTail || '')
}

// exported для самопроверки (чистая функция, логика проверяется на выводе ffmpeg)
export function parseProbe(out: string): Probe {
  let hasVideo = false
  let hasAudio = false
  let width = 0
  let height = 0
  let videoKbps = 0
  for (const line of out.split(/\r?\n/)) {
    if (!/Stream #\d+:\d+/.test(line)) continue
    if (/Video:/.test(line)) {
      if (/attached pic/i.test(line)) continue // обложка — не видеопоток
      hasVideo = true
      // «yuv420p(progressive), 1280x720 [SAR …], 102 kb/s, …» — «0x31637661»
      // (avc1/0x…) не матчится: перед x нужно ≥2 цифр, после — разделитель
      const m = line.match(/(?:^|[\s,])(\d{2,5})x(\d{2,5})(?=[\s,\]])/)
      if (m) {
        width = parseInt(m[1], 10)
        height = parseInt(m[2], 10)
      }
      const br = line.match(/(?:^|[\s,])(\d{2,6})\s*kb\/s/i)
      if (br) videoKbps = parseInt(br[1], 10)
    } else if (/Audio:/.test(line)) {
      hasAudio = true
    }
  }
  return { hasVideo, hasAudio, width, height, videoKbps }
}

// раскладка проверена прогоном ffmpeg: 2 варианта (480p+source) и 1 вариант,
// с аудио и без — master.m3u8 + stream_%v.m3u8 + seg_%v_%05d.ts в одном каталоге
// T-20260925-010 S1: progressive=true (mov/mkv/avi) → БЕЗ -hls_playlist_type vod:
//   * vod держит плейлисты и пишет master/variant только на finalize (доказано
//     T-003: 5мин видео → master через 44s) — для HLS-first потока блокер;
//     без vod master.m3u8 + stream_N.m3u8 создаются сразу после старта
//     (прогон: .ai/tasks/T-20260925-010/artifacts/progcheck.log), плейлист
//     растёт, ENDLIST ffmpeg дописывает на finalize → hls.js переключается
//     live→vod (event playlist поддерживается);
//   * temp_file: сегмент/плейлист пишутся во временный файл и переименовываются
//     по готовности → hls.js не читает недописанные .ts/.m3u8.
// exported для самопроверки (команда гоняется на реальном ffmpeg)
export function buildFfmpegArgs(
  input: string,
  dir: string,
  o: { twoVariants: boolean; hasAudio: boolean; mainKbps: number; loKbps: number; progressive?: boolean }
): string[] {
  const a: string[] = ['-y', '-hide_banner', '-loglevel', 'warning', '-i', input]

  if (o.twoVariants) {
    a.push('-map', '0:v:0', '-map', '0:v:0', '-filter:v:1', 'scale=-2:480')
    if (o.hasAudio) a.push('-map', '0:a:0', '-map', '0:a:0')
    a.push('-var_stream_map', o.hasAudio ? 'v:0,a:0 v:1,a:1' : 'v:0 v:1')
    // b:v:0 — source, b:v:1 — 480p (нужны ffmpeg для BANDWIDTH в master.m3u8)
    a.push('-b:v:0', `${o.mainKbps}k`, '-b:v:1', `${Math.max(o.loKbps, 100)}k`)
  } else {
    a.push('-map', '0:v:0')
    if (o.hasAudio) a.push('-map', '0:a:0')
    a.push('-var_stream_map', o.hasAudio ? 'v:0,a:0' : 'v:0')
    a.push('-b:v', `${o.mainKbps}k`)
  }

  a.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    // keyframe каждые 4s → сегменты ровно по hls_time (иначе x264-GOP 250 кадров)
    '-force_key_frames', 'expr:gte(t,n_forced*4)'
  )
  if (o.hasAudio) a.push('-c:a', 'aac', '-b:a', '128k')

  a.push('-f', 'hls', '-hls_time', '4')
  if (!o.progressive) a.push('-hls_playlist_type', 'vod')
  a.push(
    '-hls_list_size', '0',
    '-hls_flags', o.progressive ? 'temp_file+independent_segments' : 'independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%v_%05d.ts'),
    '-master_pl_name', 'master.m3u8',
    path.join(dir, 'stream_%v.m3u8')
  )
  return a
}

// ===== ожидание готовности / cleanup =====

async function waitForMaster(session: HlsSession, waitMs: number = START_TIMEOUT_MS): Promise<HlsResult> {
  const t0 = Date.now()
  for (;;) {
    if (fileUsable(session.masterPath)) {
      if (!session.ready) hlog(`master ready id=${session.id} after ${Date.now() - t0}ms`)
      session.ready = true
      return { hlsUrl: masterUrlFor(session.id) }
    }
    if (session.exited) {
      // ffmpeg упал до записи master → убираем сессию, retry стартует заново
      hlog(`ffmpeg exited before master id=${session.id}`)
      dropSession(session)
      return { error: 'ffmpeg-failed' }
    }
    if (Date.now() - t0 >= waitMs) {
      // транскод ещё идёт — сессию НЕ убиваем: повторный ensureHlsSession
      // дождётся master; preview к этому времени уже играет прямой stream
      hlog(`master timeout ${waitMs}ms id=${session.id} (still transcoding)`)
      return { error: 'hls-not-ready' }
    }
    await sleep(200)
  }
}

function dropSession(session: HlsSession): void {
  // REWORK#1 F3: флаг останавливает launch на следующей await-точке
  session.killed = true
  if (sessions.get(session.id) === session) sessions.delete(session.id)
  const proc = session.proc
  if (proc && !session.exited) {
    try {
      proc.kill()
    } catch {}
  }
  try {
    fs.rmSync(session.dir, { recursive: true, force: true })
  } catch (e) {
    hlog(`rm ${session.dir} fail: ${(e as Error).message}`)
  }
}

// ===== TTL-джанк + лимит кеша =====

function runJunk(): void {
  try {
    const now = Date.now()
    for (const s of [...sessions.values()]) {
      if (now - s.lastTouched > IDLE_TTL_MS) {
        hlog(`idle ${IDLE_TTL_MS}ms → cleanup id=${s.id}`)
        dropSession(s)
      }
    }
    enforceCacheLimit()
  } catch (e) {
    hlog(`junk error: ${(e as Error).message}`)
  }
}

function dirSize(p: string): number {
  let total = 0
  try {
    for (const name of fs.readdirSync(p)) {
      const fp = path.join(p, name)
      try {
        const st = fs.statSync(fp)
        total += st.isDirectory() ? dirSize(fp) : st.size
      } catch {}
    }
  } catch {}
  return total
}

function enforceCacheLimit(): void {
  try {
    const root = cacheRoot()
    if (!fs.existsSync(root)) return
    const entries: { id: number; p: string; mtime: number; size: number }[] = []
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name)
      try {
        const st = fs.statSync(p)
        if (!st.isDirectory()) continue
        entries.push({ id: parseInt(name, 10), p, mtime: st.mtimeMs, size: dirSize(p) })
      } catch {}
    }
    let total = entries.reduce((a, e) => a + e.size, 0)
    if (total <= CACHE_MAX_BYTES) return
    // старые по mtime первыми; активные сессии чистятся через dropSession (kill)
    entries.sort((a, b) => a.mtime - b.mtime)
    for (const e of entries) {
      if (total <= CACHE_MAX_BYTES) break
      const live = Number.isFinite(e.id) ? sessions.get(e.id) : undefined
      hlog(`cache limit → remove ${path.basename(e.p)} (${(e.size / 1048576).toFixed(1)}MB)`)
      if (live) dropSession(live)
      else fs.rmSync(e.p, { recursive: true, force: true })
      total -= e.size
    }
  } catch (e) {
    hlog(`cache-limit error: ${(e as Error).message}`)
  }
}
