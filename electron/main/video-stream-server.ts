import * as http from 'http'
import { app } from 'electron'
import { TelegramService } from './telegram-service'
import bigInt from 'big-integer'
import * as fs from 'fs'

function slog(msg: string) {
  try { fs.appendFileSync('/Users/alexander/Desktop/RodjerCloud/stream.log', `[${new Date().toISOString()}] ${msg}\n`) } catch(e) {}
}

let server: http.Server | null = null

export function startVideoStreamServer(telegramService: TelegramService, port: number = 14300) {
  if (server) return

  server = http.createServer(async (req, res) => {
    try {
      slog(`Req: ${req.url} Range: ${req.headers.range}`)
      // URL format: /stream/:messageId
      const urlMatch = req.url?.match(/^\/stream\/(\d+)$/)
      if (!urlMatch) {
        res.writeHead(404)
        return res.end('Not found')
      }

      const messageId = parseInt(urlMatch[1], 10)
      const client = (telegramService as any).client
      const channelId = (telegramService as any).channelId

      if (!client || !channelId) {
        res.writeHead(500)
        return res.end('Telegram client not ready')
      }

      const messages = await client.getMessages(channelId as any, { ids: [messageId] })
      if (!messages || messages.length === 0) {
        res.writeHead(404)
        return res.end('Message not found')
      }

      const message: any = messages[0]
      if (!message.file) {
        slog('No file attached')
        res.writeHead(404)
        return res.end('No file attached')
      }

      const fileSize = Number(message.file.size)
      if (!fileSize || isNaN(fileSize)) {
        slog('Unknown file size')
        res.writeHead(400)
        return res.end('Unknown file size')
      }

      const range = req.headers.range
      let start = 0
      let end = fileSize - 1

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-')
        start = parseInt(parts[0], 10)
        end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      }

      if (start >= fileSize || end >= fileSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` })
        return res.end()
      }

      const chunkSize = (end - start) + 1
      slog(`Sending 206 ${start}-${end}/${fileSize} (chunk: ${chunkSize})`)

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': message.file.mimeType || 'video/mp4',
        'Access-Control-Allow-Origin': '*'
      })

      const iter = client.iterDownload({
        file: message.media,
        offset: bigInt(start),
      })

      let bytesSent = 0
      
      req.on('close', () => {
        slog(`Req closed early. Sent: ${bytesSent}`)
        bytesSent = chunkSize // This will cause the loop to exit
      })

      for await (const chunk of iter) {
        if (bytesSent >= chunkSize) break
        
        const remaining = chunkSize - bytesSent
        const toSend = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
        
        res.write(toSend)
        bytesSent += toSend.length
        slog(`Sent chunk ${toSend.length}, total ${bytesSent}/${chunkSize}`)
      }

      slog(`Done sending.`)
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
