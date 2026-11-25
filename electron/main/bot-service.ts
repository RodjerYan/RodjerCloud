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
  running?: boolean
  cancelled?: boolean
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

  // Сканирование дубликатов — один фоновый job в main. Он живёт независимо от
  // того, какая страница открыта в рендерере, и его можно отменить.
  private scanning = false
  private scanCancelled = false
  private scanState = { running: false, done: 0, total: 0, currentFile: '', cancelled: false }

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

  /** Переносим уже посчитанные рендерером хеши — не пересчитываем их заново. */
  importHashes(entries: HashEntry[]): number {
    let added = 0
    const byId = new Map(this.hashDb.map(e => [e.messageId, e]))
    for (const raw of entries || []) {
      if (!raw?.hash?.includes(':')) continue
      const prev = byId.get(raw.messageId)
      if (prev?.hash?.includes(':')) continue
      const entry: HashEntry = {
        messageId: raw.messageId,
        fileName: raw.fileName || 'unknown',
        fileSize: raw.fileSize || 0,
        hash: raw.hash,
        mimeType: raw.mimeType,
      }
      if (prev) Object.assign(prev, entry)
      else { this.hashDb.push(entry); byId.set(entry.messageId, entry) }
      added++
    }
    if (added > 0) this.saveHashDb()
    return added
  }

  private recordHashes(entries: HashEntry[]) {
    if (entries.length === 0) return
    const byId = new Map(this.hashDb.map(e => [e.messageId, e]))
    for (const e of entries) {
      const prev = byId.get(e.messageId)
      if (prev) Object.assign(prev, e)
      else { this.hashDb.push(e); byId.set(e.messageId, e) }
    }
    this.saveHashDb()
  }

  getScanState() { return { ...this.scanState } }
  cancelScan() {
    if (this.scanning) {
      this.scanCancelled = true
      this.scanState = { ...this.scanState, cancelled: true }
    }
  }

  private isMediaEntry(e: HashEntry): boolean {
    return !!(e.mimeType?.startsWith('image/') || e.mimeType?.startsWith('video/'))
  }

  getDuplicateGroups(mediaOnly = true): DuplicateGroup[] {
    const groups = new Map<string, HashEntry[]>()
    for (const e of this.hashDb) {
      if (mediaOnly && !this.isMediaEntry(e)) continue
      if (!e.hash) continue
      const key = `${(e.fileName || '').toLowerCase()}:${e.hash}`
      const arr = groups.get(key) || []
      arr.push(e)
      groups.set(key, arr)
    }
    const result: DuplicateGroup[] = []
    groups.forEach((files, key) => {
      if (files.length > 1)
        result.push({ hash: key, files, totalSize: files.reduce((s, f) => s + f.fileSize, 0) })
    })
    result.sort((a, b) => b.totalSize - a.totalSize)
    return result
  }

  // ── Hashing ──
  private cleanupNonMediaEntries() {
    const before = this.hashDb.length
    this.hashDb = this.hashDb.filter(e => this.isMediaEntry(e))
    if (this.hashDb.length !== before) this.saveHashDb()
  }

  // ── Channel scan ──
  async scanChannel(telegramService: TelegramService, onProgress?: ProgressCb) {
    if (this.scanning) {
      return { found: 0, groups: this.getDuplicateGroups().length, alreadyRunning: true, state: this.getScanState() }
    }
    this.scanning = true
    this.scanCancelled = false
    this.scanState = { running: true, done: 0, total: 0, currentFile: '', cancelled: false }

    try {
      this.cleanupNonMediaEntries()
      // Кэш уже собран при старте — не сканируем весь канал повторно.
      const all = await telegramService.listFilesCached()
      if (!all || all.length === 0) {
        this.scanState = { ...this.scanState, running: false }
        onProgress?.({ done: 0, total: 0, currentFile: '', running: false })
        return { found: 0, groups: 0 }
      }

      const activeIds = new Set(all.map((f: any) => f.messageId))
      const initialLen = this.hashDb.length
      this.hashDb = this.hashDb.filter(e => activeIds.has(e.messageId))
      if (this.hashDb.length !== initialLen) this.saveHashDb()

      const keyCount = new Map<string, number>()
      const dupKey = (f: any) => `${(f.fileName || '').toLowerCase()}:${f.fileSize || 0}`
      for (const f of all) {
        if (f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/')) {
          const k = dupKey(f)
          keyCount.set(k, (keyCount.get(k) || 0) + 1)
        }
      }
      // Уже посчитанные хеши пропускаем — повторного сканирования нет.
      const hashedIds = new Set(this.hashDb.filter(e => e.hash?.includes(':')).map(e => e.messageId))
      const toScan = all.filter((f: any) =>
        !hashedIds.has(f.messageId) &&
        (f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/')) &&
        (keyCount.get(dupKey(f)) || 0) >= 2
      )

      const total = toScan.length
      let done = 0
      this.scanState = { ...this.scanState, total }
      onProgress?.({ done, total, currentFile: '', running: true })

      // Один запрос getMessages на пачку вместо одного запроса на файл.
      const BATCH = 40
      const WORKERS = 4
      for (let start = 0; start < toScan.length; start += BATCH) {
        if (this.scanCancelled) break
        const batch = toScan.slice(start, start + BATCH)
        let messages: any[] = []
        try {
          messages = await telegramService.getMessagesByIds(batch.map((f: any) => f.messageId))
        } catch (e) {
          logDebug('[scan] batch fetch failed:', (e as Error).message)
        }
        const byId = new Map<number, any>()
        for (const m of messages) {
          const id = Number(m?.id)
          if (Number.isFinite(id)) byId.set(id, m)
        }

        const entries: HashEntry[] = []
        let idx = 0
        const worker = async () => {
          while (idx < batch.length) {
            if (this.scanCancelled) return
            const f = batch[idx++]
            let hash = ''
            try {
              hash = await telegramService.computePartialHash(f.messageId, byId.get(f.messageId))
            } catch {}
            entries.push({
              messageId: f.messageId,
              fileName: f.fileName || 'unknown',
              fileSize: f.fileSize || 0,
              hash,
              mimeType: f.mimeType || undefined,
            })
            done++
            const fileName = f.fileName || 'unknown'
            this.scanState = { ...this.scanState, done, currentFile: fileName }
            if (done % 8 === 0 || done === total) onProgress?.({ done, total, currentFile: fileName })
          }
        }
        await Promise.all(Array.from({ length: Math.min(WORKERS, batch.length) }, () => worker()))
        this.recordHashes(entries)
        onProgress?.({ done, total, currentFile: batch[batch.length - 1]?.fileName || '' })
        // Даем event loop и рендереру обновиться между пачками.
        await new Promise(r => setTimeout(r, 120))
      }

      const groups = this.getDuplicateGroups()
      const found = groups.reduce((s, g) => s + g.files.length, 0)

      // Notify user if duplicates found and token is configured
      if (!this.scanCancelled && groups.length > 0 && this.token) {
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

      this.scanState = { ...this.scanState, running: false, cancelled: this.scanCancelled }
      onProgress?.({ done, total, currentFile: '', running: false, cancelled: this.scanCancelled })
      return { found, groups: groups.length, cancelled: this.scanCancelled }
    } finally {
      this.scanning = false
    }
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
