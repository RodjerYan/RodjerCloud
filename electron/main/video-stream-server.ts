import * as http from 'http'
import { app } from 'electron'
import { TelegramService } from './telegram-service'
import { vaultService } from './vault-service'
import bigInt from 'big-integer'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { Api } from 'telegram'

function slog(msg: string) {
  try { fs.appendFileSync('/Users/alexander/Desktop/RodjerCloud/stream.log', `[${new Date().toISOString()}] ${msg}\n`) } catch(e) {}
}

let server: http.Server | null = null

export function startVideoStreamServer(telegramService: TelegramService, port: number = 14300) {
  if (server) return

  server = http.createServer(async (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        return res.end()
      }

      slog(`Req: ${req.url} Range: ${req.headers.range}`)
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

      const messages = await client.getMessages(channelId as any, { ids: [messageId] })
      if (!messages || messages.length === 0) {
        res.writeHead(404)
        return res.end('Message not found')
      }

      const baseMessage: any = messages[0]
      if (!baseMessage.file) {
        res.writeHead(404)
        return res.end('No file attached')
      }

      const caption = baseMessage.message || ''
      const vaultMatch = caption.match(/#vault\s+([a-f0-9]+)/)
      const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)
      const isEncrypted = !!vaultMatch
      const ivHex = vaultMatch ? vaultMatch[1] : ''

      let parts: { id: number, msg: any, size: number, start: number, end: number }[] = []
      
      if (multipartMatch) {
        const partIds = multipartMatch[1].split(',').map(Number)
        // Fetch all part messages
        const partMessages = await Promise.all(partIds.map(id => client.getMessages(channelId as any, { ids: [id] })))
        
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
        let streamOffset = Math.floor(partOffset / 16) * 16 // align to AES block for decryption if needed
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
                    limit: 16
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
                 limit: 16
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

        const iter = client.iterDownload({
          file: p.msg.media,
          offset: bigInt(streamOffset),
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
      }
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[VideoStreamServer] Listening on http://127.0.0.1:${port}`)
  })
}
