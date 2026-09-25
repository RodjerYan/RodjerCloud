import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

// T-20260925-002 rework S3.1: mov/mkv/avi → mp4 для предпросмотра.
// ffmpeg-static уже в dependencies; electron-builder раскладывает бинарь в
// app.asar.unpacked (asar не исполняем) — путь чиним так же, как это делает
// telegram-service для thumb (require('ffmpeg-static') → replace app.asar).
// Все логи с префиксом [ffmpeg] попадают в rodjercloud.log через
// console-override в electron/main/index.ts (как [stream]/[upload]).

export function ffmpegLog(msg: string) {
  console.log(`[ffmpeg] ${msg}`)
}

// Кодеки, которые Chromium декодирует в <video> как есть. Всё остальное
// (mpeg4 из avi, hevc из iPhone/mkv, wmv, …) remux'ем не починить —
// нужен транскод, иначе <video> отдаст onerror вместо картинки.
const CHROMIUM_VIDEO_CODECS = ['h264', 'vp8', 'vp9', 'av1']
const CHROMIUM_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis']

const REMUX_TIMEOUT_MS = 120 * 1000
const TRANSCODE_TIMEOUT_MS = 600 * 1000

let ffmpegPathCache: string | false | null = null

// T-20260925-003 S1: resolveFfmpegPath/runFfmpeg экспортированы — их же
// переиспользует hlsServer (путь до бинаря из app.asar.unpacked + spawn
// массивом с таймаутами), без дублирования логики.
export function resolveFfmpegPath(): string | false {
  if (ffmpegPathCache !== null) return ffmpegPathCache
  let result: string | false = false
  try {
    const raw: any = require('ffmpeg-static')
    // на случай ESM-обёртки { default: '...' }
    const p0: unknown = raw && typeof raw === 'object' && typeof raw.default === 'string' ? raw.default : raw
    if (typeof p0 !== 'string' || !p0) throw new Error('ffmpeg-static вернул пустой путь')
    // packaged: бинарь лежит в app.asar.unpacked (asar не исполняем)
    const p = p0.includes('app.asar') ? p0.replace('app.asar', 'app.asar.unpacked') : p0
    if (!fs.existsSync(p)) throw new Error(`бинарь не найден: ${p}`)
    result = p
    ffmpegLog(`binary: ${p}`)
  } catch (e) {
    ffmpegLog(`недоступен: ${(e as Error).message} → mov/mkv/avi будут отдавать старую ошибку формата`)
    result = false
  }
  ffmpegPathCache = result
  return result
}

// ==== T-20260925-010 S1/S2: единая качка исходника preview-файла ====
// hlsServer (fallback-ветка resolveInput) и preview:convert-fallback могут
// качать ОДИН И ТОТ ЖЕ файл одновременно (preview ушёл на старый путь, пока
// сессия hls ещё качала) → карта in-flight, как у convertVideoToMp4. Иначе:
// двойное скачивание + гонка «existsSync уже true, но файл недописан».
const srcDownloads = new Map<string, Promise<string | null>>()
export function downloadPreviewSourceOnce(
  telegramService: any,
  messageId: number,
  targetPath: string,
  onProgress?: (sent: number, total: number) => void
): Promise<string | null> {
  const key = targetPath.toLowerCase()
  const existing = srcDownloads.get(key)
  if (existing) return existing // второй ждёт ТОТ ЖЕ промис (onProgress возьмётся у первого)
  const p = (async (): Promise<string | null> => {
    try {
      if (!fs.existsSync(targetPath)) {
        ffmpegLog(`download src id=${messageId} → ${path.basename(targetPath)}`)
        await telegramService.downloadMediaToPath(messageId, targetPath, onProgress)
      }
    } catch (e) {
      ffmpegLog(`download fail id=${messageId}: ${(e as Error).message}`)
    }
    return fs.existsSync(targetPath) ? targetPath : null
  })().finally(() => srcDownloads.delete(key))
  srcDownloads.set(key, p)
  return p
}

type FfmpegRun = { code: number | null; timedOut: boolean; stderrHead: string; stderrTail: string }

export function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<FfmpegRun> {
  return new Promise<FfmpegRun>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let stderrHead = ''
    let stderrTail = ''
    const finish = (r: FfmpegRun) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(bin, args, { windowsHide: true })
    } catch (e) {
      resolve({ code: null, timedOut: false, stderrHead: '', stderrTail: String(e) })
      return
    }
    timer = setTimeout(() => {
      try { proc.kill() } catch {}
      ffmpegLog(`timeout ${timeoutMs}ms → kill`)
      finish({ code: null, timedOut: true, stderrHead, stderrTail })
    }, timeoutMs)
    proc.stdout?.resume() // логи ffmpeg идут в stderr — stdout просто дренируем,
    // чтобы процесс не упёрся в заполненный pipe
    proc.stderr?.on('data', (d: Buffer) => {
      // прогресс (frame=… time=…) не парсим — нужен только head (там описание
      // входных потоков → кодеки) и tail (хвост ошибки для лога)
      const s = d.toString()
      if (stderrHead.length < 8000) stderrHead += s
      stderrTail = (stderrTail + s).slice(-2000)
    })
    proc.on('error', (e) => finish({ code: null, timedOut: false, stderrHead, stderrTail: e.message }))
    proc.on('close', (code) => finish({ code, timedOut: false, stderrHead, stderrTail }))
  })
}

// ffmpeg печатает и вход, и выход в одном stderr → берём ПЕРВОЕ совпадение
// (= входной поток исходника, что и нужно для решения remux-vs-transcode).
// Паттерн привязан к строкам "Stream #0:0(...): Video: h264 …" — иначе
// ловится сводка "video:0kB audio:0kB" в конце вывода (ложный кодек '0kb').
function extractCodecs(stderrHead: string): { video: string | null; audio: string | null } {
  let video: string | null = null
  let audio: string | null = null
  const re = /Stream #\d+:\d+[^\n]*?:\s*(Video|Audio):\s*([a-z0-9_]+)[^\n]*/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(stderrHead))) {
    const kind = m[1].toLowerCase()
    const codec = m[2].toLowerCase()
    if (kind === 'video') {
      // обложка аудио ("Attached pic") — не видеопоток, смотрим следующий
      if (!video && !/attached pic/i.test(m[0])) video = codec
    } else if (!audio) {
      audio = codec
    }
    if (video && audio) break
  }
  return { video, audio }
}

function dstUsable(p: string): boolean {
  try { return fs.statSync(p).size > 0 } catch { return false }
}

// Конвертация в mp4. Пишем во временный .part и переименовываем только при
// успехе — обрыв/timedOut не оставляет «битый dst с mtime новее src», который
// следующий вызов принял бы за валидный кеш.
// Возвращает dstPath либо null (нет ffmpeg / обе попытки упали).
// inFlight — одна конвертация на dst (preview:load + preview:navigate могут
// запросить один файл одновременно).
const inFlight = new Map<string, Promise<string | null>>()

export function convertVideoToMp4(srcPath: string, dstPath: string): Promise<string | null> {
  const key = dstPath.toLowerCase()
  const existing = inFlight.get(key)
  if (existing) return existing
  const p = doConvert(srcPath, dstPath).finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

async function doConvert(srcPath: string, dstPath: string): Promise<string | null> {
  try {
    if (!fs.existsSync(srcPath)) {
      ffmpegLog(`нет исходника: ${srcPath}`)
      return null
    }
    // кеш: dst новее src → уже сконвертирован (src перекачивался бы позже dst)
    try {
      const s = fs.statSync(srcPath)
      const d = fs.statSync(dstPath)
      if (d.size > 0 && d.mtimeMs > s.mtimeMs) {
        ffmpegLog(`cache hit: ${path.basename(dstPath)}`)
        return dstPath
      }
    } catch {}

    const bin = resolveFfmpegPath()
    if (!bin) return null

    const tmpPath = dstPath + '.part'
    try { fs.rmSync(tmpPath, { force: true }) } catch {}

    // 1) быстрый remux (без перекодирования) — покрывает типовой iPhone .mov
    //    (h264+aac): секунды вместо минут.
    let r = await runFfmpeg(
      bin,
      ['-y', '-i', srcPath, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmpPath],
      REMUX_TIMEOUT_MS
    )
    if (r.code === 0 && !r.timedOut && dstUsable(tmpPath)) {
      const codecs = extractCodecs(r.stderrHead)
      const videoOk = !codecs.video || CHROMIUM_VIDEO_CODECS.includes(codecs.video)
      const audioOk = !codecs.audio || CHROMIUM_AUDIO_CODECS.includes(codecs.audio)
      if (videoOk && audioOk) {
        try { fs.renameSync(tmpPath, dstPath) } catch (e) {
          ffmpegLog(`rename fail: ${(e as Error).message}`)
          try { fs.rmSync(tmpPath, { force: true }) } catch {}
          return null
        }
        ffmpegLog(`remux ok ${path.basename(dstPath)} (${codecs.video || 'no-video'}/${codecs.audio || 'no-audio'})`)
        return dstPath
      }
      ffmpegLog(`remux собрал mp4, но Chromium не декодирует v=${codecs.video} a=${codecs.audio} → транскод`)
    } else {
      ffmpegLog(`remux fail (exit=${r.code} timedOut=${r.timedOut}) → транскод`)
    }
    try { fs.rmSync(tmpPath, { force: true }) } catch {}

    // 2) транскод (libx264+aac, yuv420p — High4:4:4 Chromium не играет).
    //    Для больших файлов это долго — preview держит лоадер до готовности.
    r = await runFfmpeg(
      bin,
      [
        '-y', '-i', srcPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-movflags', '+faststart', '-f', 'mp4', tmpPath,
      ],
      TRANSCODE_TIMEOUT_MS
    )
    if (r.code === 0 && !r.timedOut && dstUsable(tmpPath)) {
      try { fs.renameSync(tmpPath, dstPath) } catch (e) {
        ffmpegLog(`rename fail: ${(e as Error).message}`)
        try { fs.rmSync(tmpPath, { force: true }) } catch {}
        return null
      }
      ffmpegLog(`transcode ok ${path.basename(dstPath)}`)
      return dstPath
    }
    ffmpegLog(`transcode fail (exit=${r.code} timedOut=${r.timedOut}) tail=${r.stderrTail.replace(/\s+/g, ' ').slice(-300)}`)
    try { fs.rmSync(tmpPath, { force: true }) } catch {}
    return null
  } catch (e) {
    ffmpegLog(`convert error: ${(e as Error).message}`)
    return null
  }
}
