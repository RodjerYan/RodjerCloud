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

// T-20260925-002 P4: пробе уже знает реальные width/height/duration —
// отдаём наверх, чтобы записать в file-cache (бейдж разрешения в сетке).
let probeHandler: ((messageId: number, width: number, height: number, duration: number) => void) | null = null
export function setHlsProbeHandler(fn: (messageId: number, width: number, height: number, duration: number) => void): void {
  probeHandler = fn
}
function reportProbe(messageId: number, width: number, height: number, duration: number): void {
  if (!probeHandler || !width || !height) return
  try { probeHandler(messageId, width, height, duration) } catch {}
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
  // Per-level transcoding state (lazy transcoding S3)
  qualityLadder: Array<{ height: number; label: string }>
  transcoding: Map<number, ChildProcess>  // levelIndex -> ffmpeg process
  masterGenerated: boolean
  ready: boolean
  exited: boolean
  killed: boolean
  lastTouched: number
  // Input/probe info for on-demand transcoding
  input: string
  hasAudio: boolean
  progressive: boolean
  srcKbps: number
  // M3+M4 FIX: real source dimensions from probe (not hardcoded 16:9)
  srcWidth: number
  srcHeight: number
  // M6 FIX: track completed levels to avoid re-transcoding from t=0
  completed: Set<number>
  // M6 FIX: track last requested level to protect active playback from kill
  lastRequestedLevel: number | null
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
    qualityLadder: [],
    transcoding: new Map(),
    masterGenerated: false,
    ready: false,
    exited: false,
    killed: false,
    lastTouched: Date.now(),
    input: '',
    hasAudio: false,
    progressive: false,
    srcKbps: 0,
    srcWidth: 0,
    srcHeight: 0,
    completed: new Set(),
    lastRequestedLevel: null,
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
        
        // S3: lazy transcoding — если запрашивается stream_N.m3u8, которого ещё нет,
        // запускаем транскодинг для этого уровня
        const streamMatch = rel.match(/^stream_(\d+)\.m3u8$/)
        if (streamMatch) {
          const levelIndex = parseInt(streamMatch[1], 10)
          if (levelIndex >= 0 && levelIndex < s.qualityLadder.length) {
            // M6 FIX: track last requested level to protect it from being killed
            s.lastRequestedLevel = levelIndex
            // M6 FIX: guard — if level already completed and playlist usable, skip start entirely
            const playlistPath = path.join(s.dir, `stream_${levelIndex}.m3u8`)
            if (s.completed.has(levelIndex) && fileUsable(playlistPath)) {
              hlog(`level ${levelIndex} already completed, serving existing playlist id=${messageId}`)
            } else {
              // Запускаем транскодинг в фоне (не ждём завершения)
              startLevelTranscoding(s, levelIndex).catch(e => {
                hlog(`lazy transcode error id=${messageId} level=${levelIndex}: ${e.message}`)
              })
            }
          }
        }
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
      // Для stream_N.m3u8 ждём дольше, так как транскодинг может только стартовать
      const isStreamPlaylist = rel.match(/^stream_\d+\.m3u8$/)
      let waitTimeout = sessions.has(messageId) ? 3000 : 0
      if (isStreamPlaylist) {
        // M7 FIX: timeout depends on level height — higher res takes longer to produce first segment
        const levelMatch = rel.match(/^stream_(\d+)\.m3u8$/)
        if (levelMatch) {
          const levelIndex = parseInt(levelMatch[1], 10)
          const s = sessions.get(messageId)
          const levelHeight = s?.qualityLadder?.[levelIndex]?.height || 720
          if (levelHeight >= 1440) waitTimeout = 30000      // 1440p/4K: up to 30s
          else if (levelHeight >= 1080) waitTimeout = 20000 // 1080p: up to 20s
          else waitTimeout = 10000                          // ≤720p: 10s
        } else {
          waitTimeout = 10000
        }
      }
      const waited = await waitForFile(resolved, waitTimeout)
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
  // Kill all transcoding processes
  for (const proc of session.transcoding.values()) {
    if (!session.exited) {
      try { proc.kill() } catch {}
    }
  }
  session.transcoding.clear()
  try {
    fs.rmSync(session.dir, { recursive: true, force: true })
  } catch {}
  hlog(`launch aborted (session dropped) id=${session.id}`)
}

/**
 * Генерирует master.m3u8 с заданной лестницей качества.
 * Вызывается синхронно при запуске сессии — master доступен сразу.
 */
function generateMasterPlaylist(session: HlsSession): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3']
  
  // M3+M4 FIX: use real source dimensions from probe (saved in session)
  // Fallback to qualityLadder if probe didn't provide dimensions
  const sourceHeight = session.srcHeight || 1080
  const sourceWidth = session.srcWidth || Math.round(sourceHeight * 16 / 9)
  
  for (let i = 0; i < session.qualityLadder.length; i++) {
    const level = session.qualityLadder[i]
    const isOriginal = level.height === 0
    const height = isOriginal ? sourceHeight : level.height
    const label = level.label
    
    // Примерная оценка битрейта для каждого уровня
    let bandwidth: number
    if (isOriginal) {
      bandwidth = session.srcKbps * 1000 // bps
    } else {
      // M4 FIX: scale bitrate proportionally to frame area using REAL sourceHeight
      const scale = (height * height) / (sourceHeight * sourceHeight)
      bandwidth = Math.round(session.srcKbps * 1000 * Math.max(0.1, scale))
    }
    bandwidth = Math.max(100000, Math.min(20000000, bandwidth)) // 100kbps - 20Mbps
    
    // M3 FIX: use real aspect ratio from probe, not hardcoded 16:9
    const width = isOriginal ? sourceWidth : Math.round(height * sourceWidth / sourceHeight)
    const resolution = isOriginal ? '' : `RESOLUTION=${width}x${height},`
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},${resolution}NAME="${label}"`)
    lines.push(`stream_${i}.m3u8`)
  }
  
  return lines.join('\n') + '\n'
}

/**
 * Запускает ffmpeg для конкретного уровня качества.
 * Каждый уровень получает свой stream_N.m3u8 и сегменты.
 */
async function startLevelTranscoding(session: HlsSession, levelIndex: number): Promise<void> {
  if (!sessionAlive(session)) return
  // M6 FIX: if level already completed successfully, don't re-transcode (avoids t=0 restart under player)
  if (session.completed.has(levelIndex)) return
  if (session.transcoding.has(levelIndex)) return // уже транскодится
  
  // M6 FIX: limit parallel transcodes to 2. Protect lastRequestedLevel and the new levelIndex.
  // Kill the oldest non-protected transcoding if we have 2+ already running.
  const running = Array.from(session.transcoding.entries())
  if (running.length >= 2) {
    // Find oldest that is NOT lastRequestedLevel and NOT the new levelIndex
    let victim: [number, ChildProcess] | null = null
    for (const entry of running) {
      const idx = entry[0]
      if (idx !== session.lastRequestedLevel && idx !== levelIndex) {
        victim = entry
        break
      }
    }
    // If both running are protected (lastRequested + new), allow 3rd parallel (rare)
    if (victim) {
      const [oldestIndex, oldestProc] = victim
      hlog(`stopping oldest transcode level ${oldestIndex} for new level ${levelIndex} id=${session.id}`)
      try { oldestProc.kill() } catch {}
      session.transcoding.delete(oldestIndex)
    }
    // else: both active are protected → allow 3rd parallel temporarily
  }
  
  const level = session.qualityLadder[levelIndex]
  const isOriginal = level.height === 0
  
  const bin = resolveFfmpegPath()
  if (!bin) throw new Error('ffmpeg-unavailable')
  
  // Определяем параметры для этого уровня
  let scaleFilter = ''
  let targetKbps: number
  let streamName = `stream_${levelIndex}`
  
  if (isOriginal) {
    // Оригинал — без масштабирования, битрейт как у источника (cap)
    targetKbps = Math.min(20000, Math.max(300, session.srcKbps))
  } else {
    // Масштабируем до целевой высоты
    scaleFilter = `scale=-2:${level.height}`
    // M4 FIX: use real sourceHeight from probe (session.srcHeight), not qualityLadder last element
    const sourceHeight = session.srcHeight || 1080
    const scale = (level.height * level.height) / (sourceHeight * sourceHeight)
    targetKbps = Math.max(100, Math.round(session.srcKbps * Math.max(0.1, scale)))
    targetKbps = Math.min(20000, Math.max(300, targetKbps))
  }
  
  // Подготавливаем аргументы ffmpeg для ОДНОГО варианта
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'warning', '-i', session.input]
  
  args.push('-map', '0:v:0')
  if (session.hasAudio) args.push('-map', '0:a:0')
  args.push('-var_stream_map', session.hasAudio ? 'v:0,a:0' : 'v:0')
  
  if (scaleFilter) {
    args.push('-filter:v:0', scaleFilter)
  }
  args.push('-b:v:0', `${targetKbps}k`)
  
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-force_key_frames', 'expr:gte(t,n_forced*4)'
  )
  if (session.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k')
  
  args.push('-f', 'hls', '-hls_time', '4')
  // Для lazy transcoding НЕ используем vod — master уже есть, плейлисты растут
  args.push('-hls_flags', session.progressive ? 'temp_file+independent_segments' : 'independent_segments')
  args.push('-hls_list_size', '0')
  args.push('-hls_segment_filename', path.join(session.dir, `seg_${levelIndex}_%05d.ts`))
  args.push(path.join(session.dir, `${streamName}.m3u8`))
  
  hlog(`start level ${levelIndex} (${level.label}) id=${session.id} kbps=${targetKbps} ${scaleFilter ? scaleFilter : 'original'} input=${session.input.slice(0, 120)}`)
  
  const proc = spawn(bin, args, { windowsHide: true })
  session.transcoding.set(levelIndex, proc)
  proc.stdout?.resume()
  
  let pending = ''
  proc.stderr?.on('data', (d: Buffer) => {
    pending += d.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() || ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || /^frame=/.test(line) || /^size=/.test(line)) continue
      hlog(`ffmpeg[${levelIndex}]: ${line}`)
    }
  })
  proc.on('error', (e) => {
    hlog(`spawn error level ${levelIndex} id=${session.id}: ${e.message}`)
    session.transcoding.delete(levelIndex)
  })
  proc.on('exit', (code, sig) => {
    hlog(`exit level ${levelIndex} id=${session.id} code=${code} sig=${sig}`)
    session.transcoding.delete(levelIndex)
    // M6 FIX: mark level as completed only on clean success
    // VOD (progressive=false): code 0 AND playlist has #EXT-X-ENDLIST
    // Progressive (growing-hls): code 0 is enough (input closes when preview closes, session dies anyway)
    if (code === 0) {
      const playlistPath = path.join(session.dir, `stream_${levelIndex}.m3u8`)
      let markCompleted = false
      if (session.progressive) {
        // growing-hls: input stream closes when preview closes → session cleanup follows
        // code 0 means ffmpeg finished cleanly
        markCompleted = true
      } else {
        // VOD: verify playlist exists and has ENDLIST (finalized)
        try {
          const content = fs.readFileSync(playlistPath, 'utf-8')
          if (content.includes('#EXT-X-ENDLIST')) markCompleted = true
        } catch {}
      }
      if (markCompleted) {
        session.completed.add(levelIndex)
        hlog(`level ${levelIndex} completed id=${session.id}`)
      }
    }
    // Не помечаем session.exited — другие уровни могут продолжать работать
  })
}

async function launch(session: HlsSession): Promise<void> {
  const getMeta = ctx!.getMeta
  const meta = await getMeta(session.id)
  if (!sessionAlive(session)) return abortLaunch(session)
  if (!meta || !meta.message) throw new Error('message-not-found')

  const bin = resolveFfmpegPath()
  if (!bin) throw new Error('ffmpeg-unavailable')

  // ==== T-20260925-010 S1: вход сначала по http-stream ====
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

  // M2 FIX: gramjs File getters (meta.message?.file?.height) throw
  // TypeError for document messages. Use try/catch and fallback to
  // document.attributes (DocumentAttributeVideo) like in telegram-service.ts.
  let height = probe.height
  if (!height && meta.message) {
    try {
      height = meta.message.file?.height || 0
    } catch {
      // Ignore gramjs TypeError, fall through to attributes
    }
    if (!height && meta.message.document?.attributes) {
      for (const attr of meta.message.document.attributes) {
        if ((attr.className === 'DocumentAttributeVideo' || attr._className === 'DocumentAttributeVideo') && attr.h) {
          height = attr.h
          break
        }
      }
    }
  }
  height = height || 0
  
  // M3 FIX: save real source dimensions from probe (not hardcoded 16:9)
  const srcWidth = probe.width || 0
  const srcHeight = probe.height || height
  reportProbe(session.id, srcWidth, srcHeight, probe.duration || 0)
  
  // Строим динамическую лестницу качества (S3)
  const qualityLadder = buildQualityLadder(height || undefined)
  
  // Явные битрейты для master.m3u8
  const srcKbps = probe.videoKbps > 0
    ? probe.videoKbps
    : height >= 1080 ? 4000 : height >= 720 ? 2500 : 1500

  // REWORK#1 F3: последняя проверка перед mkdir/spawn
  if (!sessionAlive(session)) return abortLaunch(session)

  // Каталог сессии
  try { fs.rmSync(session.dir, { recursive: true, force: true }) } catch {}
  fs.mkdirSync(session.dir, { recursive: true })

  // Сохраняем параметры сессии для ленивого транскодинга
  session.qualityLadder = qualityLadder
  session.input = input
  session.hasAudio = probe.hasAudio
  session.progressive = progressive
  session.srcKbps = srcKbps
  session.srcWidth = srcWidth
  session.srcHeight = srcHeight

  // Генерируем master.m3u8 СРАЗУ — меню качества доступно мгновенно
  const masterContent = generateMasterPlaylist(session)
  await fs.promises.writeFile(session.masterPath, masterContent, 'utf-8')
  session.masterGenerated = true
  session.ready = true
  
  hlog(
    `master ready id=${session.id} levels=${qualityLadder.length} ` +
    `src=${height ? height + 'p' : 'unknown'} kbps=${srcKbps} ` +
    `${progressive ? 'growing-hls' : 'vod'} input=${input.slice(0, 120)}`
  )

  // Запускаем транскодинг для ПЕРВОГО уровня (низший качества — быстрый старт)
  // hls.js с autoLevelEnabled=-1 сам выберет подходящий, но нам нужен хотя бы один готовый
  await startLevelTranscoding(session, 0)
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

type Probe = { hasVideo: boolean; hasAudio: boolean; width: number; height: number; videoKbps: number; duration: number }

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
  let duration = 0
  // «Duration: 00:12:34.56, start: 0.000000, bitrate: 1234 kb/s»
  const dur = out.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
  if (dur) duration = parseInt(dur[1], 10) * 3600 + parseInt(dur[2], 10) * 60 + Math.round(parseFloat(dur[3]))
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
  return { hasVideo, hasAudio, width, height, videoKbps, duration }
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
  // Master теперь генерируется сразу в launch() — просто ждём, пока файл появится
  const t0 = Date.now()
  for (;;) {
    if (fileUsable(session.masterPath)) {
      if (!session.ready) hlog(`master ready id=${session.id} after ${Date.now() - t0}ms`)
      session.ready = true
      return { hlsUrl: masterUrlFor(session.id) }
    }
    // Проверяем, не упали ли все процессы транскодинга
    const hasActiveTranscoding = session.transcoding.size > 0
    if (!hasActiveTranscoding && session.masterGenerated) {
      // Мастер сгенерирован, но транскодинг не запустился/упал
      hlog(`no active transcoding id=${session.id}`)
      dropSession(session)
      return { error: 'ffmpeg-failed' }
    }
    if (Date.now() - t0 >= waitMs) {
      // Мастер должен быть готов сразу, но на всякий случай оставляем таймаут
      hlog(`master timeout ${waitMs}ms id=${session.id}`)
      return { error: 'hls-not-ready' }
    }
    await sleep(200)
  }
}

function dropSession(session: HlsSession): void {
  // REWORK#1 F3: флаг останавливает launch на следующей await-точке
  session.killed = true
  if (sessions.get(session.id) === session) sessions.delete(session.id)
  // Kill all transcoding processes
  for (const proc of session.transcoding.values()) {
    try {
      proc.kill()
    } catch {}
  }
  session.transcoding.clear()
  try {
    fs.rmSync(session.dir, { recursive: true, force: true })
  } catch (e) {
    hlog(`rm ${session.dir} fail: ${(e as Error).message}`)
  }
}

// ===== Quality ladder (S3) =====

// Стандартные уровни качества (высота в пикселях)
const STANDARD_HEIGHTS: readonly number[] = [240, 480, 720, 1080, 1440, 2160]

/**
 * Строит лестницу качества на основе реальной высоты исходного видео.
 * @param sourceHeight - высота исходного видео в пикселях (0 или undefined = неизвестно)
 * @returns массив объектов { height, label }, где height = 0 означает "Оригинал"
 */
export function buildQualityLadder(sourceHeight: number | undefined): Array<{ height: number; label: string }> {
  if (!sourceHeight || sourceHeight <= 0) {
    return [{ height: 0, label: 'Оригинал' }]
  }
  
  // Уровни строго МЕНЬШЕ sourceHeight + всегда "Оригинал" (sourceHeight)
  const levels = STANDARD_HEIGHTS.filter(h => h < sourceHeight)
  
  const result: Array<{ height: number; label: string }> = levels.map(h => ({ height: h, label: h === 2160 ? '4K' : `${h}p` }))
  
  // Добавляем "Оригинал" в конце
  result.push({ height: 0, label: 'Оригинал' })
  
  return result
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
