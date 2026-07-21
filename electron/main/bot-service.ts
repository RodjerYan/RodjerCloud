import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
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

interface HashEntry {
  messageId: number
  fileName: string
  fileSize: number
  hash: string
  mimeType?: string
}

export interface DuplicateGroup {
  hash: string
  files: HashEntry[]
  totalSize: number
}

export interface ScanProgress {
  done: number
  total: number
  currentFile: string
}

type ProgressCb = (p: ScanProgress) => void

const DEBUG_LOG = path.join(app.isPackaged ? app.getPath('userData') : app.getAppPath(), 'share-debug.log')
function logDebug(...args: any[]) {
  const msg = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')}\n`
  try { fs.appendFileSync(DEBUG_LOG, msg) } catch {}
  console.log(msg.trimEnd())
}

export class BotService {
  private token: string = ''
  private configPath: string
  private hashDbPath: string
  private hashDb: HashEntry[] = []

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'bot-config.json')
    this.hashDbPath = path.join(app.getPath('userData'), 'bot-hash-db.json')
    this.loadHashDb()
  }

  // ── Token management ──
  setToken(token: string) {
    this.token = token
    fs.writeFileSync(this.configPath, JSON.stringify({ token }, null, 2), 'utf8')
  }

  getToken(): string {
    return this.token
  }

  clearToken() {
    this.token = ''
    try { fs.unlinkSync(this.configPath) } catch {}
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

  // ── Hash DB ──
  private loadHashDb() {
    try {
      if (fs.existsSync(this.hashDbPath))
        this.hashDb = JSON.parse(fs.readFileSync(this.hashDbPath, 'utf8'))
    } catch {}
  }

  private saveHashDb() {
    fs.writeFileSync(this.hashDbPath, JSON.stringify(this.hashDb), 'utf8')
  }

  recordHash(entry: HashEntry) {
    const idx = this.hashDb.findIndex(e => e.messageId === entry.messageId)
    if (idx >= 0) this.hashDb[idx] = entry
    else this.hashDb.push(entry)
    this.saveHashDb()
  }

  getHashDb(): HashEntry[] {
    return this.hashDb
  }

  private isMediaEntry(e: HashEntry): boolean {
    return !!(e.mimeType?.startsWith('image/') || e.mimeType?.startsWith('video/'))
  }

  getDuplicateGroups(mediaOnly = true): DuplicateGroup[] {
    const groups = new Map<string, HashEntry[]>()
    for (const e of this.hashDb) {
      if (!e.hash) continue
      if (mediaOnly && !this.isMediaEntry(e)) continue
      const arr = groups.get(e.hash) || []
      arr.push(e)
      groups.set(e.hash, arr)
    }
    const result: DuplicateGroup[] = []
    groups.forEach((files, hash) => {
      if (files.length > 1)
        result.push({ hash, files, totalSize: files.reduce((s, f) => s + f.fileSize, 0) })
    })
    result.sort((a, b) => b.totalSize - a.totalSize)
    return result
  }

  // ── Hashing ──
  private computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(filePath, { start: 0, end: 65535 })
      stream.on('data', d => hash.update(d))
      stream.on('end', () => {
        try { resolve(hash.digest('hex') + ':' + fs.statSync(filePath).size) }
        catch (e) { reject(e) }
      })
      stream.on('error', reject)
    })
  }

  private cleanupNonMediaEntries() {
    const before = this.hashDb.length
    this.hashDb = this.hashDb.filter(e => this.isMediaEntry(e))
    if (this.hashDb.length !== before) this.saveHashDb()
  }

  // ── Channel scan ──
  async scanChannel(telegramService: TelegramService, onProgress?: ProgressCb) {
    this.cleanupNonMediaEntries()
    const all = await telegramService.listFiles()
    if (!all || all.length === 0) return { found: 0, groups: 0 }

    const activeIds = new Set(all.map((f: any) => f.messageId))
    const initialLen = this.hashDb.length
    this.hashDb = this.hashDb.filter(e => activeIds.has(e.messageId))
    if (this.hashDb.length !== initialLen) {
      this.saveHashDb()
    }

    const hashedIds = new Set(this.hashDb.map(e => e.messageId))
    const toScan = all.filter((f: any) => !hashedIds.has(f.messageId) && (f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/')))
    const total = toScan.length
    let done = 0
    let found = 0

    for (const f of toScan) {
      const fileName = f.fileName || 'unknown'
      onProgress?.({ done, total, currentFile: fileName })
      try {
        const tmp = await telegramService.downloadMediaToTemp(f.messageId)
        const hash = await this.computeFileHash(tmp)
        fs.rmSync(tmp, { force: true })
        this.recordHash({
          messageId: f.messageId,
          fileName: f.fileName || 'unknown',
          fileSize: f.fileSize || 0,
          hash,
          mimeType: f.mimeType || undefined,
        })
        done++
      } catch {
        this.recordHash({
          messageId: f.messageId,
          fileName: f.fileName || 'unknown',
          fileSize: f.fileSize || 0,
          hash: '',
          mimeType: f.mimeType || undefined,
        })
        done++
      }
    }

    const groups = this.getDuplicateGroups()
    found = groups.reduce((s, g) => s + g.files.length, 0)

    // Notify user if duplicates found and token is configured
    if (groups.length > 0 && this.token) {
      try {
        const userId = await telegramService.getUserId()
        let msg = `🔁 Найдено ${groups.length} групп дубликатов (${found} файлов):\n\n`
        groups.slice(0, 10).forEach((g, i) => {
          msg += `${i + 1}. ${g.files[0].fileName} — ${g.files.length} копий, ${(g.totalSize / 1024 / 1024).toFixed(1)} MB\n`
        })
        if (groups.length > 10) msg += `\n...и ещё ${groups.length - 10} групп`
        await botApiRequest(this.token, 'sendMessage', { chat_id: Number(userId), text: msg })
      } catch {}
    }

    return { found, groups: groups.length }
  }

  // ── Share links (existing) ──
  async generateLink(telegramService: TelegramService, messageId: number, channelId: string, originalFileName?: string): Promise<{ url: string; fileName: string }> {
    if (!this.token) throw new Error('Bot token not configured')

    const userId = await telegramService.getUserId()
    const actualChannelId = telegramService.getChannelId()
    const tokenMask = this.token.slice(0, 8) + '...' + this.token.slice(-4)
    logDebug('=== generateLink ===')
    logDebug('token (masked):', tokenMask)
    logDebug('userId:', String(userId))
    logDebug('actualChannelId (BigInt):', String(actualChannelId))
    logDebug('channelId (from renderer):', channelId)
    logDebug('messageId:', messageId)

    // Generate possible from_chat_id formats to try
    const chatIds = new Set<string>()
    const raw = actualChannelId ? String(actualChannelId) : channelId
    chatIds.add(raw)                          // as-is from GramJS
    chatIds.add(`-100${raw.replace(/^-100/, '')}`)  // with single -100
    if (actualChannelId && channelId) chatIds.add(channelId)
    if (actualChannelId && channelId) chatIds.add(`-100${channelId}`)

    logDebug('fromChatId formats to try:', [...chatIds])
    let sent: any
    for (const fcid of chatIds) {
      try {
        logDebug('trying forwardMessage with from_chat_id:', fcid)
        sent = await botApiRequest(this.token, 'forwardMessage', {
          chat_id: Number(userId),
          from_chat_id: fcid,
          message_id: Number(messageId),
          disable_notification: true,
        })
        logDebug('forwardMessage OK with', fcid)
        break
      } catch (e: any) {
        logDebug('forwardMessage FAILED with', fcid, ':', e.message)
      }
    }

    if (!sent) {
      logDebug('All format attempts failed')
      // Check if the bot token is valid at all
      logDebug('Checking bot token validity via getMe...')
      try {
        const me = await botApiRequest(this.token, 'getMe')
        logDebug('bot token valid, bot username: @' + (me.username || 'unknown'))
      } catch (e: any) {
        logDebug('bot token INVALID:', e.message)
        this.clearToken()
        throw new Error('Сохранённый токен бота недействителен. Нажмите «Поделиться» снова — бот будет создан заново.')
      }

      // Token is valid - check if the bot can see the channel via getChat
      logDebug('Checking if bot can access channel via getChat...')
      for (const fcid of chatIds) {
        try {
          const chatInfo = await botApiRequest(this.token, 'getChat', { chat_id: fcid })
          logDebug('bot CAN see channel with id', fcid, ':', chatInfo.title || chatInfo.type)
        } catch (e: any) {
          logDebug('bot CANNOT see channel with id', fcid, ':', e.message)
        }
      }

      throw new Error('Бот не имеет доступа к каналу или у вас нет чата с ботом. Напишите боту в Telegram любое сообщение, затем повторите попытку.')
    }

    logDebug('forwardMessage SUCCESS, sent:', JSON.stringify(sent).slice(0, 200))

    const info = extractFileInfo(sent)
    if (!info) throw new Error('No file found in forwarded message')
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
