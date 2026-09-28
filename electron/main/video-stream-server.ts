import * as http from 'http'
import { app } from 'electron'
import { TelegramService } from './telegram-service'
import { vaultService } from './vault-service'
import bigInt from 'big-integer'
import * as crypto from 'crypto'
import { Api } from 'telegram'
import { handleHlsRequest, initHlsServer } from './hlsServer'
import { fetchPartSegments, SEG_FETCH_CONCURRENCY } from './segmented-download'

function slog(msg: string) {
  // rework: убран захардкоженный маковский путь — пишем в console (main log)
  console.log(`[stream] ${msg}`)
}

let server: http.Server | null = null

// ===== T-20260925-003 S3: metadata-кеш =====
// Раньше КАЖДЫЙ Range-запрос делал client.getMessages(...) — а браузер/ffmpeg
// шлюет десятки Range на один файл, и RTT на каждый из них откладывал первый
// байт (главный тормоз TTFB первого кадра). Кешируем готовый разбор (message +
// parts со смещениями + totalSize) на 60s, инвалидация — только по TTL.
// Параллельные запросы одного id дедуплицируются через metaInflight.
export type StreamPart = { id: number; msg: any; size: number; start: number; end: number }
export type StreamMeta = {
  message: any
  parts: StreamPart[]
  totalSize: number
  mimeType: string
  fileName: string
}

const META_TTL_MS = 60 * 1000
const metaCache = new Map<number, { meta: StreamMeta; ts: number }>()
const metaInflight = new Map<number, Promise<StreamMeta | null>>()

// ===== T-20260925-002 S4: Range/seek cache =====
// Кэширует байтовые диапазоны, уже отданные клиенту (после расшифровки/skipBytes).
// Перемотка назад в горячий диапазон не идёт в TG — отдаётся из памяти.
// Лимит: 256MB на сессию (messageId), вытеснение LRU по lastAccess.
const RANGE_CACHE_MAX_BYTES = 256 * 1024 * 1024 // 256MB per messageId
// Глобальный cap: 256×2 файла + 256MB запас на третий/частичные — 3 параллельных
// read-ahead окна по 32MB (96MB) в одном файле тоже укладываются с запасом.
const RANGE_CACHE_GLOBAL_MAX_BYTES = 768 * 1024 * 1024 // 768MB global cap
const RANGE_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes TTL for idle entries
const RANGE_CACHE_JUNK_INTERVAL_MS = 60 * 1000 // 1 minute junk timer

type RangeCacheEntry = {
  start: number
  end: number // inclusive
  data: Buffer
  lastAccess: number
}

class RangeCache {
  private entries = new Map<number, RangeCacheEntry[]>() // messageId -> sorted entries by start
  private totalSize = new Map<number, number>() // messageId -> total bytes
  private globalTotal = 0
  private junkTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.startJunkTimer()
  }

  private startJunkTimer(): void {
    if (this.junkTimer) return
    this.junkTimer = setInterval(() => this.runJunk(), RANGE_CACHE_JUNK_INTERVAL_MS)
    ;(this.junkTimer as any).unref?.()
  }

  private runJunk(): void {
    try {
      const now = Date.now()
      // TTL eviction: remove entries older than TTL
      for (const [messageId, list] of this.entries) {
        let changed = false
        for (let i = list.length - 1; i >= 0; i--) {
          if (now - list[i].lastAccess > RANGE_CACHE_TTL_MS) {
            this.globalTotal -= list[i].data.length
            list.splice(i, 1)
            changed = true
          }
        }
        if (changed) {
          this.recalcTotalSize(messageId, list)
          if (list.length === 0) {
            this.entries.delete(messageId)
            this.totalSize.delete(messageId)
          }
        }
      }
      // Global cap enforcement: evict oldest entries across all messageIds
      this.enforceGlobalCap()
    } catch (e) {
      console.error('[RangeCache] junk error:', e)
    }
  }

  private enforceGlobalCap(): void {
    if (this.globalTotal <= RANGE_CACHE_GLOBAL_MAX_BYTES) return

    // Collect all entries with their messageId and lastAccess
    const allEntries: Array<{ messageId: number; entry: RangeCacheEntry; listIndex: number }> = []
    for (const [messageId, list] of this.entries) {
      for (let i = 0; i < list.length; i++) {
        allEntries.push({ messageId, entry: list[i], listIndex: i })
      }
    }
    // Sort by lastAccess (oldest first)
    allEntries.sort((a, b) => a.entry.lastAccess - b.entry.lastAccess)

    for (const item of allEntries) {
      if (this.globalTotal <= RANGE_CACHE_GLOBAL_MAX_BYTES) break
      const list = this.entries.get(item.messageId)
      if (!list) continue
      // Find the entry in the current list (index may have shifted)
      const idx = list.findIndex(e => e === item.entry)
      if (idx === -1) continue
      this.globalTotal -= item.entry.data.length
      list.splice(idx, 1)
      this.recalcTotalSize(item.messageId, list)
      if (list.length === 0) {
        this.entries.delete(item.messageId)
        this.totalSize.delete(item.messageId)
      }
    }
  }

  // Получить данные для диапазона [start, end] (включительно).
  // Возвращает Buffer если диаазон ПОЛНОСТЬЮ покрыт кэшем, иначе null.
  get(messageId: number, start: number, end: number): Buffer | null {
    const list = this.entries.get(messageId)
    if (!list || list.length === 0) return null

    // Ищем записи, покрывающие запрошенный диапазон
    let neededStart = start
    const chunks: Buffer[] = []
    let totalLen = 0

    for (const entry of list) {
      if (entry.end < neededStart) continue
      if (entry.start > neededStart) break // дырка — не покрыто полностью

      // entry.start <= neededStart <= entry.end
      const chunkStart = neededStart - entry.start
      const chunkEnd = Math.min(end, entry.end) - entry.start
      const chunk = entry.data.subarray(chunkStart, chunkEnd + 1)
      chunks.push(chunk)
      totalLen += chunk.length
      neededStart = entry.end + 1
      entry.lastAccess = Date.now() // LRU touch

      if (neededStart > end) break
    }

    if (neededStart <= end) return null // не всё покрыто

    // Объединяем чанки в один Buffer
    const result = Buffer.concat(chunks, totalLen)
    return result
  }

  // Получить максимально длинный ПОКРЫТЫЙ ПРЕФИКС [start..coveredEnd] из существующих entries.
  // Возвращает { data: Buffer; coveredEnd: number } | null (null только если префикс пуст — нет данных от start).
  // Не требует полного покрытия [start, end], в отличие от get().
  getPrefix(messageId: number, start: number, end: number): { data: Buffer; coveredEnd: number } | null {
    const list = this.entries.get(messageId)
    if (!list || list.length === 0) return null

    let neededStart = start
    const chunks: Buffer[] = []
    let totalLen = 0
    let coveredEnd = start - 1

    for (const entry of list) {
      if (entry.end < neededStart) continue
      if (entry.start > neededStart) break // дырка — префикс прерван

      // entry.start <= neededStart <= entry.end
      const chunkStart = neededStart - entry.start
      const chunkEnd = Math.min(end, entry.end) - entry.start
      const chunk = entry.data.subarray(chunkStart, chunkEnd + 1)
      chunks.push(chunk)
      totalLen += chunk.length
      coveredEnd = entry.end
      neededStart = entry.end + 1
      entry.lastAccess = Date.now() // LRU touch

      if (neededStart > end) break
    }

    if (coveredEnd < start) return null // префикс пуст — нет данных от start

    const data = Buffer.concat(chunks, totalLen)
    return { data, coveredEnd }
  }

  // Удалить все entries с end < belowOffset - keepBytes (данные ПОЗАДИ позиции чтения).
  // Возвращает количество освобождённых байт.
  evictBehind(messageId: number, belowOffset: number, keepBytes: number = 16 * 1024 * 1024): number {
    const list = this.entries.get(messageId)
    if (!list || list.length === 0) return 0

    const threshold = belowOffset - keepBytes
    if (threshold <= 0) return 0

    let freed = 0
    let i = 0
    while (i < list.length) {
      const entry = list[i]
      if (entry.end < threshold) {
        freed += entry.data.length
        this.globalTotal -= entry.data.length
        list.splice(i, 1)
      } else {
        i++
      }
    }

    if (freed > 0) {
      this.recalcTotalSize(messageId, list)
      if (list.length === 0) {
        this.entries.delete(messageId)
        this.totalSize.delete(messageId)
      }
    }
    return freed
  }

  // Сохранить данные для диапазона [start, end] (включительно).
  // Сливает с соседними записями, вытесняет LRU при превышении лимита.
  set(messageId: number, start: number, end: number, data: Buffer): void {
    let list = this.entries.get(messageId)
    if (!list) {
      list = []
      this.entries.set(messageId, list)
    }

    const newEntry: RangeCacheEntry = { start, end, data, lastAccess: Date.now() }

    // Вставляем с сохранением порядка по start
    let inserted = false
    for (let i = 0; i < list.length; i++) {
      if (start < list[i].start) {
        list.splice(i, 0, newEntry)
        inserted = true
        break
      }
    }
    if (!inserted) list.push(newEntry)

    this.globalTotal += data.length

    // Сливаем соседние/пересекающиеся записи
    this.mergeAdjacent(list)

    // M1 FIX: Recalculate totalSize after merge (not incremental)
    this.recalcTotalSize(messageId, list)

    // Вытеснение LRU, если превышен лимит
    this.evictLRU(messageId, list)
    // Global cap enforcement
    this.enforceGlobalCap()
  }

  private mergeAdjacent(list: RangeCacheEntry[]): void {
    for (let i = 0; i < list.length - 1; ) {
      const a = list[i]
      const b = list[i + 1]
      // Пересекаются или соприкасаются (b.start <= a.end + 1)
      if (b.start <= a.end + 1) {
        // Сливаем в a: берем a.data + хвост b.data, который выходит за a.end
        const mergedStart = a.start
        const mergedEnd = Math.max(a.end, b.end)
        const overlap = a.end + 1 - b.start // >= 0 если пересекаются, 0 если соприкасаются
        const mergedData = Buffer.concat([
          a.data,
          b.data.subarray(Math.max(0, overlap))
        ], mergedEnd - mergedStart + 1)
        a.end = mergedEnd
        a.data = mergedData
        a.lastAccess = Date.now()
        // M2 FIX: subtract overlap bytes from globalTotal (they were counted twice before merge)
        this.globalTotal -= Math.min(b.data.length, Math.max(0, overlap))
        list.splice(i + 1, 1)
      } else {
        i++
      }
    }
  }

  private recalcTotalSize(messageId: number, list: RangeCacheEntry[]): void {
    let total = 0
    for (const e of list) {
      total += e.data.length
    }
    this.totalSize.set(messageId, total)
  }

  // Public getter for totalSize (used by filler for cap checks)
  getTotalSize(messageId: number): number {
    return this.totalSize.get(messageId) || 0
  }

  private evictLRU(messageId: number, list: RangeCacheEntry[]): void {
    let total = this.totalSize.get(messageId) || 0
    if (total <= RANGE_CACHE_MAX_BYTES) return

    // Сортируем по lastAccess (старые первые) для вытеснения
    // Но нужно сохранить порядок по start для get() — поэтому собираем кандидатов
    const candidates = list.map((e, idx) => ({ entry: e, idx, lastAccess: e.lastAccess }))
    candidates.sort((a, b) => a.lastAccess - b.lastAccess)

    // m3 NOTE: all-or-nothing eviction — merged entries are removed entirely
    // instead of truncating the old end (Buffer.subarray). This is a known
    // limitation; truncation would require splitting the merged buffer and
    // updating adjacent entries, which adds significant complexity. For now,
    // the recursive re-eviction ensures we stay under the cap.
    for (const c of candidates) {
      if (total <= RANGE_CACHE_MAX_BYTES) break
      // Удаляем запись
      total -= c.entry.data.length
      this.globalTotal -= c.entry.data.length
      list.splice(c.idx, 1)
      // Индексы сдвинулись — пересобираем кандидатов (просто break и перезапуск)
      // Для простоты: после удаления одной записи пересчитываем
      this.totalSize.set(messageId, total)
      if (total <= RANGE_CACHE_MAX_BYTES) break
      // Пересобираем список кандидатов для следующей итерации
      return this.evictLRU(messageId, list) // рекурсивно до предела
    }
  }

  // Очистить кэш для messageId (навигация/закрытие)
  clear(messageId: number): void {
    const list = this.entries.get(messageId)
    if (list) {
      for (const e of list) {
        this.globalTotal -= e.data.length
      }
      this.entries.delete(messageId)
      this.totalSize.delete(messageId)
    }
  }

  // M2 FIX: Public method to clear all caches (used on app shutdown if needed)
  clearAll(): void {
    this.entries.clear()
    this.totalSize.clear()
    this.globalTotal = 0
  }
}

export const rangeCache = new RangeCache()

// ===== Per-request fetch infrastructure (replaces filler) =====
// Active fetch records for non-encrypted path: messageId -> fetch records
// Max 3 concurrent fetches per messageId to prevent Telegram re-fetching same bytes.
type ActiveFetch = {
  start: number
  end: number
  promise: Promise<void>
  progress: number // bytes delivered to cache
  abortController: AbortController
}

const activeFetches = new Map<number, ActiveFetch[]>()

// No-op stub to keep cleanup hooks working (was: stop filler)
export function stopFillersForFile(_messageId: number): void {
  // Filler architecture removed in R5c; no-op for backward compatibility
}

// Find an active fetch covering the given position for a messageId
function findActiveFetch(messageId: number, pos: number): ActiveFetch | undefined {
  const fetches = activeFetches.get(messageId)
  if (!fetches) return undefined
  return fetches.find(f => f.start <= pos && f.end >= pos)
}

// Count active fetches for a messageId
function countActiveFetches(messageId: number): number {
  return activeFetches.get(messageId)?.length ?? 0
}

// Remove a fetch record when done/failed
function removeActiveFetch(messageId: number, fetch: ActiveFetch): void {
  const list = activeFetches.get(messageId)
  if (!list) return
  const idx = list.indexOf(fetch)
  if (idx >= 0) {
    list.splice(idx, 1)
    if (list.length === 0) {
      activeFetches.delete(messageId)
    }
  }
}

// Launch a fetch window [winStart, winEnd] for non-encrypted content
// Writes chunks to rangeCache via onChunk; progress tracked in record.
async function launchFetchWindow(
  messageId: number,
  winStart: number,
  winEnd: number,
  client: any,
  parts: StreamPart[],
  totalSize: number
): Promise<void> {
  const abortController = new AbortController()
  const record: ActiveFetch = {
    start: winStart,
    end: winEnd,
    promise: Promise.resolve(), // placeholder
    progress: 0,
    abortController,
  }

  // Add to active fetches before starting
  let list = activeFetches.get(messageId)
  if (!list) {
    list = []
    activeFetches.set(messageId, list)
  }
  list.push(record)

  slog(`fetch start id=${messageId} pos=${winStart} winEnd=${winEnd}`)

  record.promise = (async () => {
    const MAX_RETRIES = 3
    const RETRY_DELAYS = [1000, 2000, 4000] // ms
    const CHUNK_WRITE_SIZE = 4 * 1024 * 1024 // 4MB chunks for set()

    let pos = winStart
    let attempt = 0
    let written = 0 // bytes actually written to cache for this fetch window

    while (pos <= winEnd && !abortController.signal.aborted) {
      // Cap check: evict behind before writing new data
      const currentTotal = rangeCache.getTotalSize(messageId)
      if (currentTotal >= RANGE_CACHE_MAX_BYTES) {
        const evicted = rangeCache.evictBehind(messageId, pos, 16 * 1024 * 1024)
        if (evicted === 0) {
          // Could not evict — wait briefly and retry once
          await new Promise(r => setTimeout(r, 1000))
          if (abortController.signal.aborted) break
          const retryEvicted = rangeCache.evictBehind(messageId, pos, 16 * 1024 * 1024)
          if (retryEvicted === 0) {
            // Still no space — skip caching this chunk but continue fetching
            slog(`fetch cap full id=${messageId} pos=${pos} — skipping cache write`)
          }
        }
      }

      // Find part covering pos
      const part = parts.find(p => p.start <= pos && p.end >= pos)
      if (!part) {
        // Gap between parts — skip
        pos = winEnd + 1
        continue
      }

      const partRangeStart = pos
      const partRangeEnd = Math.min(winEnd, part.end)
      const prevPart = part.start > 0 ? parts.find(p => p.end === part.start - 1) : null

      // Retry loop for this segment
      let success = false
      attempt = 0
      while (attempt <= MAX_RETRIES && !abortController.signal.aborted && !success) {
        try {
          await fetchPartSegments({
            client,
            file: part.msg.media,
            partStart: part.start,
            partEnd: part.end,
            reqStart: partRangeStart,
            reqEnd: partRangeEnd,
            isEncrypted: false,
            previousPart: prevPart ? { msg: prevPart.msg, size: prevPart.size } : null,
            signal: abortController.signal,
            onChunk: async (_segmentIndex: number, _chunkIndex: number, data: Buffer, _isLastChunk: boolean, _isLastSegment: boolean) => {
              if (abortController.signal.aborted) return

              // Write to cache in CHUNK_WRITE_SIZE chunks
              let offset = 0
              while (offset < data.length && !abortController.signal.aborted) {
                const chunkEnd = Math.min(offset + CHUNK_WRITE_SIZE, data.length)
                const chunk = data.subarray(offset, chunkEnd)
                const chunkStart = winStart + written + offset
                const chunkEndAbs = winStart + written + chunkEnd - 1
                rangeCache.set(messageId, chunkStart, chunkEndAbs, chunk)
                written += chunk.length
                record.progress = written
                offset = chunkEnd
              }
            },
          })
          success = true
        } catch (err: any) {
          if (abortController.signal.aborted) break
          attempt++
          if (attempt <= MAX_RETRIES) {
            const delay = RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]
            slog(`fetch retry id=${messageId} attempt=${attempt}/${MAX_RETRIES} delay=${delay}ms error=${err.message}`)
            await new Promise(r => setTimeout(r, delay))
          } else {
            slog(`fetch fail id=${messageId} err=${err.message}`)
            throw err
          }
        }
      }

      if (abortController.signal.aborted) break

      const delivered = partRangeEnd - pos + 1
      pos = partRangeEnd + 1
    }

    if (!abortController.signal.aborted) {
      slog(`fetch done id=${messageId} bytes=${pos - winStart}`)
      // Self-check: verify cache coverage matches what we wrote
      const expectedEnd = winStart + written - 1
      if (written > 0) {
        const prefix = rangeCache.getPrefix(messageId, winStart, expectedEnd)
        if (!prefix || prefix.coveredEnd < expectedEnd) {
          const got = prefix ? `${winStart}-${prefix.coveredEnd}` : 'none'
          slog(`cache coverage mismatch id=${messageId} expected=${winStart}-${expectedEnd} got=${got}`)
        }
      }
    }
  })()

  // Cleanup on completion/failure
  record.promise.finally(() => {
    removeActiveFetch(messageId, record)
  })
}

// Helper: write buffer with backpressure handling (drain/close/error race)
  // M4 FIX: check destroyed/writableEnded before write and after race; clean up listeners in finally
  async function writeWithDrain(res: http.ServerResponse, data: Buffer): Promise<void> {
    const CHUNK_SIZE = 512 * 1024 // 512KB chunks for backpressure
    let offset = 0
    while (offset < data.length) {
      // M4 FIX: abort if response already closed/destroyed
      if (res.destroyed || res.writableEnded) break
      const chunk = data.subarray(offset, offset + CHUNK_SIZE)
      if (!res.write(chunk)) {
        let resolveFn: () => void
        let resolved = false
        const onDrain = () => { if (!resolved) { resolved = true; resolveFn() } }
        const onClose = () => { if (!resolved) { resolved = true; resolveFn() } }
        const onError = () => { if (!resolved) { resolved = true; resolveFn() } }
        try {
          res.once('drain', onDrain)
          res.once('close', onClose)
          res.once('error', onError)
          await new Promise<void>((resolve) => { resolveFn = resolve })
        } finally {
          // M4 FIX: always remove listeners to avoid leak and double-fire
          res.off('drain', onDrain)
          res.off('close', onClose)
          res.off('error', onError)
        }
        // M4 FIX: after race, check if response is still writable
        if (res.destroyed || res.writableEnded) break
      }
      offset += chunk.length
    }
  }

async function fetchStreamMeta(telegramService: TelegramService, messageId: number): Promise<StreamMeta | null> {
  const client = telegramService.getClient()
  const channelId = telegramService.getChannelId()
  if (!client || !channelId) return null

  const messages = await client.getMessages(channelId as any, { ids: [messageId] })
  // rework minor#5: несуществующий id → gramjs вернёт [undefined], а не пустой
  // массив → раньше здесь падал baseMessage.file и клиент получал 500 вместо 404
  if (!messages || messages.length === 0 || !messages[0]) return null

  const baseMessage: any = messages[0]
  if (!baseMessage.file) return null

  const caption = baseMessage.message || ''
  const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)

  const parts: StreamPart[] = []
  if (multipartMatch) {
    const partIds = multipartMatch[1].split(',').map(Number)
    // Fetch all part messages одним Promise.all — результат живёт в кеше 60s
    const partMessages = await Promise.all(partIds.map((id: number) => client.getMessages(channelId as any, { ids: [id] })))

    // Base message is part 1
    parts.push({ id: baseMessage.id, msg: baseMessage, size: Number(baseMessage.file.size), start: 0, end: 0 })

    for (const partArr of partMessages) {
      if (partArr && partArr.length > 0 && partArr[0].file) {
        const m: any = partArr[0]
        parts.push({ id: m.id, msg: m, size: Number(m.file.size), start: 0, end: 0 })
      }
    }
  } else {
    parts.push({ id: baseMessage.id, msg: baseMessage, size: Number(baseMessage.file.size), start: 0, end: 0 })
  }

  // Calculate total size and offsets
  let totalSize = 0
  for (const p of parts) {
    p.start = totalSize
    p.end = totalSize + p.size - 1
    totalSize += p.size
  }

  return {
    message: baseMessage,
    parts,
    totalSize,
    mimeType: baseMessage.file.mimeType || 'video/mp4',
    fileName: baseMessage.file.name || '',
  }
}

export function getStreamMeta(telegramService: TelegramService, messageId: number): Promise<StreamMeta | null> {
  const hit = metaCache.get(messageId)
  if (hit && Date.now() - hit.ts < META_TTL_MS) return Promise.resolve(hit.meta)

  const inflight = metaInflight.get(messageId)
  if (inflight) return inflight

  const p = fetchStreamMeta(telegramService, messageId)
    .then((meta) => {
      metaInflight.delete(messageId)
      if (meta) metaCache.set(messageId, { meta, ts: Date.now() })
      else metaCache.delete(messageId) // неудача не кешируется (client мог быть не ready)
      return meta
    })
    .catch((err) => {
      metaInflight.delete(messageId)
      throw err
    })
  metaInflight.set(messageId, p)
  return p
}

export function startVideoStreamServer(telegramService: TelegramService, port: number = 14300) {
  if (server) return

  // T-20260925-003 S1: HLS-сессии живут на этом же порту/сервере — hlsServer
  // получает контекст (telegram для скачивания mov/mkv/avi + общий getStreamMeta).
  initHlsServer({
    telegramService,
    port,
    getMeta: (messageId: number) => getStreamMeta(telegramService, messageId),
  })

  server = http.createServer(async (req, res) => {
    try {
      slog(`Req: ${req.url} Range: ${req.headers.range}`)

      // T-20260925-003 S1: /hls/<token>/<id>/master.m3u8, .../stream_N.m3u8,
      // .../seg_N_00000.ts — ответ отдаёт hlsServer (сам шлёт заголовки).
      // REWORK#1 F7: роутинг /hls/ — ДО CORS: глобальный ACAO:* на /hls/ не
      // ставится (см. hlsServer.hlsTokenOk — CORS добавляется только на
      // ответах с валидным токеном, иначе любая локальная страница читала бы
      // HLS и драйвила транскод)
      if (req.url && req.url.startsWith('/hls/')) {
        await handleHlsRequest(req, res)
        return
      }

      // CORS — только для /stream/ (медиа-элементы его и не требуют, но
      // dev-страницы/тесты могут)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        return res.end()
      }

      const urlMatch = req.url?.match(/^\/stream\/(\d+)$/)
      if (!urlMatch) {
        res.writeHead(404)
        return res.end('Not found')
      }

      const messageId = parseInt(urlMatch[1], 10)
      const client = telegramService.getClient()
      const channelId = telegramService.getChannelId()

      if (!client || !channelId) {
        res.writeHead(500)
        return res.end('Telegram client not ready')
      }

      // T-20260925-003 S3: getMessages+парсинг multipart живут в кеше 60s —
      // серия Range-запросов от одного плеера идёт без сетевых RTT.
      const meta = await getStreamMeta(telegramService, messageId)
      if (!meta) {
        // несуществующий id / нет файла / клиент отвалился между проверками
        res.writeHead(404)
        return res.end('Message not found')
      }

      const baseMessage: any = meta.message
      const parts = meta.parts
      const caption = baseMessage.message || ''
      const vaultMatch = caption.match(/#vault\s+([a-f0-9]+)/)
      const isEncrypted = !!vaultMatch
      const ivHex = vaultMatch ? vaultMatch[1] : ''
      const totalSize = meta.totalSize

      if (totalSize === 0) {
        res.writeHead(400)
        return res.end('Empty file')
      }

      const range = req.headers.range
      let reqStart = 0
      let reqEnd = totalSize - 1
      let hasRange = false
      let isMultipartRange = false

      if (range) {
        // m5 FIX: multipart ranges (bytes=0-9,20-29) — ignore cache, serve normally
        // (or 416). Per RFC 7233, multipart/byteranges is valid but rarely used
        // by browsers for video. We don't support caching multipart ranges.
        if (range.includes(',')) {
          hasRange = true
          isMultipartRange = true
          // Fall through to normal streaming without cache lookup/set
        } else {
          hasRange = true
          const rangeVal = range.replace(/bytes=/, '').trim()
          const rParts = rangeVal.split('-')
          
          // M3 FIX: Sanitized Range parsing per RFC 7233
          // Handle suffix-byte-range: bytes=-N (last N bytes)
          if (rParts[0] === '' && rParts[1] !== '') {
            const suffixLength = parseInt(rParts[1], 10)
            if (isNaN(suffixLength) || suffixLength <= 0) {
              res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
              return res.end()
            }
            reqStart = Math.max(0, totalSize - suffixLength)
            reqEnd = totalSize - 1
          } else {
            // Normal range: bytes=start-end or bytes=start-
            const start = parseInt(rParts[0], 10)
            if (isNaN(start)) {
              res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
              return res.end()
            }
            reqStart = start
            
            if (rParts[1] !== '') {
              const end = parseInt(rParts[1], 10)
              if (isNaN(end)) {
                res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
                return res.end()
              }
              reqEnd = end
            } else {
              // Open-ended range: bytes=start-
              reqEnd = totalSize - 1
            }
          }

          // M3 FIX: Validate start <= end
          if (reqStart > reqEnd) {
            res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
            return res.end()
          }

          // M3 FIX: Clamp end to size-1 (RFC 7233 §4.4) instead of 416
          if (reqEnd >= totalSize) {
            reqEnd = totalSize - 1
          }

          // M3 FIX: 416 only if start >= size (after clamping)
          if (reqStart >= totalSize) {
            res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
            return res.end()
          }
        }
      }

      const chunkSize = (reqEnd - reqStart) + 1
      slog(`Sending ${hasRange ? '206' : '200'} ${reqStart}-${reqEnd}/${totalSize} (chunk: ${chunkSize})`)

      // S4: Range cache — проверяем, есть ли запрошенный диапазон полностью в кэше
      // m5 FIX: skip cache for multipart ranges
      if (!isMultipartRange) {
        const cached = rangeCache.get(messageId, reqStart, reqEnd)
        if (cached) {
          slog(`Range cache HIT ${reqStart}-${reqEnd}`)
          const statusCode = hasRange ? 206 : 200
          const headers: http.OutgoingHttpHeaders = {
            'Accept-Ranges': 'bytes',
            'Content-Length': cached.length,
            'Content-Type': baseMessage.file.mimeType || 'video/mp4'
          }
          if (statusCode === 206) {
            headers['Content-Range'] = `bytes ${reqStart}-${reqEnd}/${totalSize}`
          }
          res.writeHead(statusCode, headers)
          res.flushHeaders()
          if (req.method !== 'HEAD') {
            // Write with backpressure for large cached responses
            await writeWithDrain(res, cached)
          }
          return res.end()
        }
      }

      // S4 FIX: Prefix/partial caching — always accumulate sent bytes (up to limit),
      // cache whatever was actually sent even on client abort or open-ended ranges.
      // B1 FIX: Stop accumulating if we exceed the cache limit.
      let shouldCache = true
      let sentTotal = 0
      const sentChunks: Buffer[] = []

      const statusCode = hasRange ? 206 : 200
      const headers: http.OutgoingHttpHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': baseMessage.file.mimeType || 'video/mp4'
      }
      if (statusCode === 206) {
        headers['Content-Range'] = `bytes ${reqStart}-${reqEnd}/${totalSize}`
      }
      res.writeHead(statusCode, headers)
      res.flushHeaders()

      if (req.method === 'HEAD') {
        return res.end()
      }

      let bytesSent = 0
      let currentReqStart = reqStart
      let clientAborted = false

      req.on('close', () => {
        slog(`Req closed early.`)
        clientAborted = true
      })

      const key = isEncrypted ? (vaultService as any).getKey() : null

      // AbortController for cancelling workers on client disconnect (encrypted path only)
      const abortController = new AbortController()
      if (isEncrypted) {
        req.on('close', () => {
          abortController.abort()
        })
      }

      if (isEncrypted) {
        // ===== ENCRYPTED PATH: sequential (CBC chain requires ordered IV) =====
        for (const p of parts) {
          if (bytesSent >= chunkSize) break
          if (currentReqStart > p.end) continue
          if (currentReqStart < p.start) currentReqStart = p.start

          let partOffset = currentReqStart - p.start
          let streamOffset = Math.floor(partOffset / 4096) * 4096
          let skipBytes = partOffset - streamOffset

          let decipher: crypto.Decipher | null = null

          if (p.start + streamOffset === 0) {
            decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
            decipher.setAutoPadding(false)
          } else {
            let iv: Buffer | null = null
            if (streamOffset === 0 && p.start > 0) {
              const prevPart = parts.find(x => x.end === p.start - 1)
              if (prevPart) {
                let prevIvIter = client.iterDownload({
                  file: prevPart.msg.media,
                  offset: bigInt(prevPart.size - 16),
                  limit: 16,
                  requestSize: 16,
                })
                for await (const chunk of prevIvIter) {
                  iv = Buffer.from(chunk)
                  break
                }
              }
            } else if (streamOffset >= 16) {
              let prevIvIter = client.iterDownload({
                file: p.msg.media,
                offset: bigInt(streamOffset - 16),
                limit: 16,
                requestSize: 16,
              })
              for await (const chunk of prevIvIter) {
                iv = Buffer.from(chunk).subarray(0, 16)
                break
              }
            }
            
            if (iv && iv.length === 16) {
              decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
              decipher.setAutoPadding(false)
            } else {
              decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16))
              decipher.setAutoPadding(false)
            }
          }

          const iter = client.iterDownload({
            file: p.msg.media,
            offset: bigInt(streamOffset),
            requestSize: 512 * 1024,
          })

          for await (let chunk of iter) {
            if (bytesSent >= chunkSize) break
            if (clientAborted) break
            
            if (decipher) {
              chunk = decipher.update(chunk)
            }

            if (skipBytes > 0) {
              if (skipBytes >= chunk.length) {
                skipBytes -= chunk.length
                continue
              } else {
                chunk = chunk.subarray(skipBytes)
                skipBytes = 0
              }
            }

            const remaining = chunkSize - bytesSent
            const toSend = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
            
            if (shouldCache) {
              sentChunks.push(toSend)
              sentTotal += toSend.length
              if (sentTotal > RANGE_CACHE_MAX_BYTES) {
                shouldCache = false
                sentChunks.length = 0
                sentTotal = 0
              }
            }

            if (res.destroyed || res.writableEnded) break
            if (!res.write(toSend)) {
              let resolveFn: () => void
              let resolved = false
              const onDrain = () => { if (!resolved) { resolved = true; resolveFn() } }
              const onClose = () => { if (!resolved) { resolved = true; resolveFn() } }
              const onError = () => { if (!resolved) { resolved = true; resolveFn() } }
              try {
                res.once('drain', onDrain)
                res.once('close', onClose)
                res.once('error', onError)
                await new Promise<void>((resolve) => { resolveFn = resolve })
              } finally {
                res.off('drain', onDrain)
                res.off('close', onClose)
                res.off('error', onError)
              }
              if (res.destroyed || res.writableEnded) break
            }
            
            bytesSent += toSend.length
            currentReqStart += toSend.length
          }
        }
} else {
          // ===== NON-ENCRYPTED PATH: prefix-serve + 16MB window + single-flight =====
          // Serve from cache prefix; launch bounded fetch windows on cache miss.
          // Max 3 concurrent fetches per messageId to avoid Telegram re-fetching same bytes.
          // T-20260928-004 S3: read-ahead formula (below) kept, but FW stays 16MB —
          // FW=32MB covered the whole file for files <32MB, which blocked the separate
          // moov-tail window (play waited for the full fetch: TTFF 1.1s → 4.2s, log evidence).

          let pos = reqStart
          const FETCH_WINDOW = 16 * 1024 * 1024 // 16MB
          const MAX_WAIT_MS = 30000 // 30s total wait for data at position
          const POLL_INTERVAL = 100 // ms
          let waitStart = Date.now()

          while (bytesSent < chunkSize && !clientAborted) {
            if (res.destroyed || res.writableEnded) break

            // Try to serve from cache prefix
            const prefix = rangeCache.getPrefix(messageId, pos, reqEnd)
            if (prefix && prefix.data.length > 0) {
              // Got data from cache — send it
              const remaining = chunkSize - bytesSent
              const toSend = prefix.data.length > remaining ? prefix.data.subarray(0, remaining) : prefix.data
              if (toSend.length > 0) {
                if (!res.write(toSend)) {
                  let resolveFn: () => void
                  let resolved = false
                  const onDrain = () => { if (!resolved) { resolved = true; resolveFn() } }
                  const onClose = () => { if (!resolved) { resolved = true; resolveFn() } }
                  const onError = () => { if (!resolved) { resolved = true; resolveFn() } }
                  try {
                    res.once('drain', onDrain)
                    res.once('close', onClose)
                    res.once('error', onError)
                    await new Promise<void>((resolve) => { resolveFn = resolve })
                  } finally {
                    res.off('drain', onDrain)
                    res.off('close', onClose)
                    res.off('error', onError)
                  }
                  if (res.destroyed || res.writableEnded) break
                }
                bytesSent += toSend.length
                pos = prefix.coveredEnd + 1
                waitStart = Date.now() // reset wait timer on progress
                continue
              }
            }

            // Cache miss at current position — check for active fetch covering pos
            const active = findActiveFetch(messageId, pos)
            if (active) {
              // Wait for active fetch to make progress
              const waitLimit = Date.now() + 10000 // 10s max wait per poll cycle
              while (Date.now() < waitLimit && !clientAborted && !res.destroyed && !res.writableEnded) {
                const freshPrefix = rangeCache.getPrefix(messageId, pos, reqEnd)
                if (freshPrefix && freshPrefix.data.length > 0) {
                  // Data arrived — will be sent in next loop iteration
                  break
                }
                // Check if fetch failed/aborted without covering our pos
                if (active.abortController.signal.aborted) {
                  // Fetch died — will launch new one in next iteration
                  break
                }
                await new Promise(r => setTimeout(r, POLL_INTERVAL))
              }
              continue
            }

            // No active fetch covering pos — launch new fetch window if under limit
            if (countActiveFetches(messageId) >= 3) {
              // Wait for a slot to free up
              await new Promise(r => setTimeout(r, POLL_INTERVAL))
              continue
            }

            const winStart = pos
            // S3: read-ahead — окно тянется от позиции чтения на весь FETCH_WINDOW,
            // даже если клиент запросил меньший reqEnd (bytes=X-Y с маленьким Y).
            // Если клиент запросил хвост (reqEnd ≥ pos+FETCH_WINDOW-1) — окно прежнее
            // (как раньше min(pos+FW-1, reqEnd)); не дальше EOF.
            const winEnd = Math.min(pos + FETCH_WINDOW - 1, totalSize - 1)
            await launchFetchWindow(messageId, winStart, winEnd, client, parts, totalSize)

            // Wait for data to appear at pos (up to MAX_WAIT_MS total)
            const waitLimit = Date.now() + MAX_WAIT_MS
            let dataArrived = false
            while (Date.now() < waitLimit && !clientAborted && !res.destroyed && !res.writableEnded) {
              const freshPrefix = rangeCache.getPrefix(messageId, pos, reqEnd)
              if (freshPrefix && freshPrefix.data.length > 0) {
                dataArrived = true
                break
              }
              await new Promise(r => setTimeout(r, POLL_INTERVAL))
            }

            if (!dataArrived) {
              slog(`fetch wait timeout id=${messageId} pos=${pos} — no data after ${MAX_WAIT_MS}ms`)
              break
            }
            waitStart = Date.now()
          }
        }

      // S4 FIX: Prefix/partial caching — cache whatever was actually sent (if > 0),
      // even on client abort or for open-ended ranges. The cached range is the
      // actual bytes sent: [reqStart, reqStart + sentTotal - 1].
      // m5 FIX: skip cache for multipart ranges
      // NOTE: Encrypted path caches sent bytes here; non-encrypted path writes to cache via fetch windows.
      if (isEncrypted && !isMultipartRange && shouldCache && sentTotal > 0) {
        const fullData = Buffer.concat(sentChunks, sentTotal)
        const actualEnd = reqStart + sentTotal - 1
        rangeCache.set(messageId, reqStart, actualEnd, fullData)
        slog(`Range cache SET ${reqStart}-${actualEnd} (${fullData.length} bytes)${clientAborted ? ' [client aborted]' : ''}`)
      }

      res.end()

    } catch (err: any) {
      slog(`Error: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(err.message || 'Internal Server Error')
      } else {
        // rework minor#4: заголовки (206 + flushHeaders) уже ушли — клиент ждёт
        // Content-Length байт, которых не будет. Обрыв соединения вместо
        // таймаута.
        try { res.destroy() } catch {}
      }
    }
  })

  server.on('error', (err: any) => {
    const msg = err?.message || String(err)
    console.error(`[VideoStreamServer] listen error on port ${port}: ${msg}`)
    slog(`Listen error: ${msg}`)
    server = null
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[VideoStreamServer] Listening on http://127.0.0.1:${port}`)
  })
}
