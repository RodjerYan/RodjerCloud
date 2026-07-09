import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { TelegramService } from './telegram-service'

function botApiRequest(token: string, method: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : ''
    const url = new URL(`https://api.telegram.org/bot${token}/${method}`)
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw)
            if (parsed.ok) resolve(parsed.result)
            else reject(new Error(parsed.description || 'Telegram Bot API error'))
          } catch {
            reject(new Error('Failed to parse Bot API response'))
          }
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function extractFileInfo(msg: any): { fileId: string; fileName: string } | undefined {
  if (msg.document?.file_id) return { fileId: msg.document.file_id, fileName: msg.document.file_name || 'file' }
  if (msg.photo?.length > 0) return { fileId: msg.photo[msg.photo.length - 1].file_id, fileName: 'photo.jpg' }
  if (msg.video?.file_id) return { fileId: msg.video.file_id, fileName: msg.video.file_name || 'video.mp4' }
  if (msg.audio?.file_id) return { fileId: msg.audio.file_id, fileName: msg.audio.file_name || (msg.audio.performer ? msg.audio.performer + ' - ' + msg.audio.title + '.mp3' : 'audio.mp3') }
  if (msg.voice?.file_id) return { fileId: msg.voice.file_id, fileName: 'voice.ogg' }
  if (msg.video_note?.file_id) return { fileId: msg.video_note.file_id, fileName: 'video_note.mp4' }
  if (msg.sticker?.file_id) return { fileId: msg.sticker.file_id, fileName: 'sticker.webp' }
  if (msg.animation?.file_id) return { fileId: msg.animation.file_id, fileName: msg.animation.file_name || 'animation.gif' }
  return undefined
}

export class BotService {
  private token: string = ''
  private configPath: string

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'bot-config.json')
  }

  setToken(token: string) {
    this.token = token
    fs.writeFileSync(this.configPath, JSON.stringify({ token }, null, 2), 'utf8')
  }

  getToken(): string {
    return this.token
  }

  loadToken(): string {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
        this.token = data.token || ''
      }
    } catch {}
    return this.token
  }

  async generateLink(telegramService: TelegramService, messageId: number, channelId: string, originalFileName?: string): Promise<{ url: string; fileName: string }> {
    if (!this.token) throw new Error('Bot token not configured')

    const userId = await telegramService.getUserId()
    const channelPeer = channelId.startsWith('-100') ? channelId : `-100${channelId}`
    const fromChatId = channelPeer

    const sent = await botApiRequest(this.token, 'forwardMessage', {
      chat_id: Number(userId),
      from_chat_id: fromChatId,
      message_id: messageId,
      disable_notification: true,
    })

    const info = extractFileInfo(sent)
    if (!info) throw new Error('No file found in forwarded message')
    // use originalFileName from front-end (it's the real filename), fall back to API response
    const fileName = originalFileName && originalFileName !== 'Unknown' ? originalFileName : info.fileName

    const fileInfo = await botApiRequest(this.token, 'getFile', { file_id: info.fileId })
    const filePathValue = fileInfo.file_path
    if (!filePathValue) throw new Error('File path not available from Bot API')

    return {
      url: `https://api.telegram.org/file/bot${this.token}/${filePathValue}`,
      fileName,
    }
  }
}
