import * as http from 'http'
import { app } from 'electron'
import { TelegramService } from './telegram-service'
import { vaultService } from './vault-service'
import bigInt from 'big-integer'
import * as crypto from 'crypto'
import { Api } from 'telegram'
import { handleHlsRequest, initHlsServer } from './hlsServer'

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

      if (range) {
        const rParts = range.replace(/bytes=/, '').split('-')
        reqStart = parseInt(rParts[0], 10)
        reqEnd = rParts[1] ? parseInt(rParts[1], 10) : totalSize - 1
      }

      if (reqStart >= totalSize || reqEnd >= totalSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
        return res.end()
      }

      const chunkSize = (reqEnd - reqStart) + 1
      slog(`Sending 206 ${reqStart}-${reqEnd}/${totalSize} (chunk: ${chunkSize})`)

      res.writeHead(range ? 206 : 200, {
        'Content-Range': `bytes ${reqStart}-${reqEnd}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': baseMessage.file.mimeType || 'video/mp4'
      })
      // T-20260925-002 S3: writeHead буферизует заголовки в Node — пока нет ни
      // одного res.write(), 206-ответ клиенту не уходит и Chromium висит на
      // спиннере. flushHeaders() немедленно отправляет их (и для 200, и для 206).
      res.flushHeaders()

      if (req.method === 'HEAD') {
        return res.end()
      }

      let bytesSent = 0
      let currentReqStart = reqStart

      req.on('close', () => {
        slog(`Req closed early.`)
        bytesSent = chunkSize
      })

      const key = isEncrypted ? (vaultService as any).getKey() : null

      for (const p of parts) {
        if (bytesSent >= chunkSize) break
        if (currentReqStart > p.end) continue // Skip parts before the requested range
        if (currentReqStart < p.start) currentReqStart = p.start // If range starts before this part, start from part beginning

        // Offset relative to the current part
        let partOffset = currentReqStart - p.start
        // rework minor#3: выравниваем вниз до 4096 (кратно и AES-block 16, и
        // preDownload-выравниванию gramjs). DirectDownloadIter (offset <
        // ceil(size/512K)) отдаёт offset в upload.getFile без выравнивания по
        // 4096 → ранний не выровненный Range мог падать на GetFile, а заголовки
        // к тому моменту уже ушли через flushHeaders. Разница уходит в skipBytes.
        let streamOffset = Math.floor(partOffset / 4096) * 4096
        let skipBytes = partOffset - streamOffset

        let decipher: crypto.Decipher | null = null

        if (isEncrypted) {
          if (p.start + streamOffset === 0) {
             // Beginning of the very first part
             decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
             decipher.setAutoPadding(false)
          } else {
             // We need to fetch the previous 16 bytes across the boundary.
             // For simplicity in streaming without full random access to cross-part IVs efficiently:
             // If we must seek mid-file, we fetch the previous 16 bytes of the CURRENT part.
             // Note: if streamOffset is 0 but it's part 2, its IV is the LAST 16 bytes of part 1.
             let iv: Buffer | null = null
             if (streamOffset === 0 && p.start > 0) {
               // Get last 16 bytes of the previous part
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
               // Fallback if IV fetching fails
               decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16))
               decipher.setAutoPadding(false)
             }
          }
        }

        // T-20260925-002 S3: раньше requestSize = chunkSize (весь запрошенный
        // диапазон, часто весь файл) → GramJS GenericDownloadIter буферизовал
        // весь диапазон в RAM до первого байта. Фиксируем 512KB (= MAX_CHUNK_SIZE):
        // chunkSize становится равен requestSize после clamp → DirectDownloadIter,
        // итеративная отдача порциями по 512KB. Лимит по байтам контролирует
        // bytesSent/chunkSize в цикле ниже (multipart/vault ветка не тронута).
        const iter = client.iterDownload({
          file: p.msg.media,
          offset: bigInt(streamOffset),
          requestSize: 512 * 1024,
        })

        for await (let chunk of iter) {
          if (bytesSent >= chunkSize) break
          
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
          
          if (!res.write(toSend)) {
            await new Promise(r => res.once('drain', r))
          }
          
          bytesSent += toSend.length
          currentReqStart += toSend.length
        }
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
