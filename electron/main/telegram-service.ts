import { TelegramClient } from 'telegram'
import { getFileHash } from './storage-service'
import { vaultService } from './vault-service'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import zlib from 'zlib'
import { app, ipcMain, nativeImage } from 'electron'
function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath, { start: 0, end: 65535 })
    stream.on('data', d => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex') + ':' + fs.statSync(filePath).size))
    stream.on('error', reject)
  })
}

const API_ID = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : 35766547
const API_HASH = process.env.TELEGRAM_API_HASH || '5e37a0cba3964d7ca0814147562452ce'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: any) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const CHANNEL_NAME = 'My area'

async function splitFileLocal(filePath: string, chunkSize: number): Promise<string[]> {
  const fileStats = fs.statSync(filePath)
  if (fileStats.size <= chunkSize) return [filePath]

  const tempDir = app.getPath('temp')
  const baseName = path.basename(filePath)
  const parts: string[] = []
  
  const readStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })
  let currentPartIndex = 0
  let currentPartPath = path.join(tempDir, `rodjer_chunk_${crypto.randomUUID()}_${currentPartIndex}`)
  let writeStream = fs.createWriteStream(currentPartPath)
  parts.push(currentPartPath)
  let bytesWritten = 0

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const p of parts) {
        try { fs.unlinkSync(p) } catch {}
      }
    }
    readStream.on('data', (chunk: Buffer) => {
      if (bytesWritten + chunk.length > chunkSize) {
        const spaceLeft = chunkSize - bytesWritten
        writeStream.write(chunk.slice(0, spaceLeft))
        writeStream.end()
        
        currentPartIndex++
        currentPartPath = path.join(tempDir, `rodjer_chunk_${crypto.randomUUID()}_${currentPartIndex}`)
        parts.push(currentPartPath)
        writeStream = fs.createWriteStream(currentPartPath)
        writeStream.on('error', (err) => { cleanup(); reject(err) })
        writeStream.write(chunk.slice(spaceLeft))
        bytesWritten = chunk.length - spaceLeft
      } else {
        writeStream.write(chunk)
        bytesWritten += chunk.length
      }
    })
    readStream.on('end', () => {
      writeStream.end()
      resolve(parts)
    })
    readStream.on('error', (err) => { cleanup(); reject(err) })
    writeStream.on('error', (err) => { cleanup(); reject(err) })
  })
}

export class TelegramService {
  private client: TelegramClient | null = null
  private phoneNumber: string = ''
  private channelId: bigint | null = null


  private startPromise: Promise<void> | null = null
  private phoneCodeDef: Deferred<string> | null = null
  private passwordDef: Deferred<string> | null = null
  private codeAttempts: number = 0
  private authResolved: boolean = false
  private authError: Error | null = null
  private needs2FA: boolean = false
  private codeRequested: Deferred<void> | null = null
  private passwordRequested: Deferred<void> | null = null

  getApiId(): number { return API_ID }
  getApiHash(): string { return API_HASH }

  async startAuth(phoneNumber: string) {
    this.phoneNumber = phoneNumber.trim()
    this.codeAttempts = 0
    this.authResolved = false
    this.authError = null
    this.needs2FA = false
    this.phoneCodeDef = deferred<string>()
    this.passwordDef = deferred<string>()
    this.codeRequested = deferred<void>()
    this.passwordRequested = deferred<void>()

    const session = new StringSession('')
    this.client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: false,
    })

    try { (this.client as any).setLogLevel?.('error') } catch {}

    this.startPromise = this.client.start({
      phoneNumber: async () => this.phoneNumber,
      phoneCode: async () => {
        if (this.codeRequested && !(this.codeRequested as any)._done) {
          (this.codeRequested as any)._done = true
          this.codeRequested.resolve()
        }
        if (!this.phoneCodeDef || (this.phoneCodeDef as any)._used) {
          this.phoneCodeDef = deferred<string>()
        }
        ;(this.phoneCodeDef as any)._used = true
        const code = await this.phoneCodeDef.promise
        return code
      },
      password: async () => {
        this.needs2FA = true
        if (this.passwordRequested && !(this.passwordRequested as any)._done) {
          (this.passwordRequested as any)._done = true
          this.passwordRequested.resolve()
        }
        if (!this.passwordDef || (this.passwordDef as any)._used) {
          this.passwordDef = deferred<string>()
        }
        ;(this.passwordDef as any)._used = true
        const pwd = await this.passwordDef.promise
        return pwd
      },
      onError: (err: any) => {
        console.error('[telegram.start onError]', err?.errorMessage || err?.message || err)
        const isPhoneLoop = !(this.codeRequested as any)?._done
        if (isPhoneLoop) {
          this.authError = new Error(err?.errorMessage || err?.message || String(err))
          this.authResolved = true
        }
        return isPhoneLoop
      },
    })
      .then(() => {
        this.authResolved = true
      })
      .catch((err: any) => {
        if (!this.authError) {
          this.authError = err instanceof Error ? err : new Error(String(err?.errorMessage || String(err)))
        }
        this.authResolved = true
      })

    const TIMEOUT_MS = 45000
    let timeoutHandle: any
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('Время ожидания истекло. Проверьте подключение к интернету.'))
      }, TIMEOUT_MS)
    })

    try {
      await Promise.race([
        this.codeRequested.promise,
        this.startPromise.then(() => {
          if (this.authError) throw this.authError
        }),
        timeoutPromise,
      ])
    } finally {
      clearTimeout(timeoutHandle)
    }

    return { success: true, codeSent: true }
  }

  async verifyCode(code: string) {
    if (!this.client || !this.phoneCodeDef) {
      throw new Error('Auth flow not started')
    }
    const cleaned = String(code).replace(/\s+/g, '').trim()
    if (!/^\d{4,8}$/.test(cleaned)) {
      return { success: false, needs2FA: false, error: 'Code must be 4-8 digits' }
    }

    this.codeAttempts += 1
    const currentDef = this.phoneCodeDef
    currentDef.resolve(cleaned)

    const oldPasswordReqDone = (this.passwordRequested as any)?._done
    const winner = await Promise.race([
      this.startPromise!.then(() => 'done'),
      (async () => {
        while (!this.authResolved && !((this.passwordRequested as any)?._done) && (this.phoneCodeDef === currentDef)) {
          await new Promise((r) => setTimeout(r, 50))
        }
        if ((this.passwordRequested as any)?._done && !oldPasswordReqDone) return '2fa'
        if (this.phoneCodeDef !== currentDef) return 'reprompt'
        return 'done'
      })(),
    ])

    if (winner === 'done' || this.authResolved) {
      if (this.authError) {
        const msg = (this.authError as any).errorMessage || this.authError.message || 'Authentication failed'
        if (msg.includes('PHONE_CODE_INVALID') || msg.includes('PHONE_CODE_EXPIRED')) {
          return { success: false, needs2FA: false, error: 'Invalid or expired verification code', attemptsLeft: Math.max(0, 3 - this.codeAttempts) }
        }
        return { success: false, needs2FA: false, error: msg }
      }
      return { success: true, needs2FA: false }
    }

    if (winner === '2fa') {
      return { success: false, needs2FA: true }
    }

    return {
      success: false,
      needs2FA: false,
      error: 'Invalid or expired verification code',
      attemptsLeft: Math.max(0, 3 - this.codeAttempts),
    }
  }

  async verify2FA(password: string) {
    if (!this.client || !this.passwordDef) {
      throw new Error('Auth flow not started')
    }
    this.passwordDef.resolve(password)
    await this.startPromise

    if (this.authError) {
      const msg = (this.authError as any).errorMessage || this.authError.message || ''
      if (msg.includes('PASSWORD_HASH_INVALID')) {
        return { success: false, error: 'Incorrect 2FA password' }
      }
      return { success: false, error: msg || '2FA verification failed' }
    }
    return { success: true }
  }

  private async setChannelPhoto() {
    if (!this.client || !this.channelId) return
    try {
      const iconPath = path.join(app.getAppPath(), 'resources', 'icon-256.png')
      if (!fs.existsSync(iconPath)) return
      const uploaded = await this.client.uploadFile({
        file: iconPath,
        workers: 1,
      })
      await this.client.invoke(
        new Api.channels.EditPhoto({
          channel: this.channelId as any,
          photo: new Api.InputChatUploadedPhoto({ file: uploaded }),
        })
      )
    } catch {
      // non-critical
    }
  }

  async createPrivateChannel() {
    if (!this.client) throw new Error('Client not initialized')

    try {
      const dialogs = await this.client.getDialogs()
      const matches: any[] = []
      for (const dialog of dialogs) {
        const entity = dialog.entity as any
        if (entity?.title && typeof entity.title === 'string' && entity.title === CHANNEL_NAME) {
          matches.push(entity)
        }
      }
      if (matches.length > 0) {
        matches.sort((a, b) => Number(a.id) - Number(b.id)) // Smallest ID is the oldest channel
        const oldest = matches[0]
        this.channelId = BigInt(oldest.id.toString())
        return {
          channelId: this.channelId.toString(),
          channelName: oldest.title,
        }
      }
    } catch (e) {
      console.warn('Dialog scan failed, creating new channel:', (e as Error).message)
    }

    const result: any = await this.client.invoke(
      new Api.channels.CreateChannel({
        title: CHANNEL_NAME,
        about: 'RodjerCloud Storage Channel',
        megagroup: false,
      })
    )

    if (result.chats && result.chats.length > 0) {
      const channel = result.chats[0] as any
      this.channelId = BigInt(channel.id.toString())
      this.setChannelPhoto()
      return {
        channelId: this.channelId.toString(),
        channelName: CHANNEL_NAME,
      }
    }
    throw new Error('Failed to create channel')
  }

  async reconnect(sessionString: string) {
    const session = new StringSession(sessionString)
    this.client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 })
    await this.client.connect()

    const dialogs = await this.client.getDialogs()
    const matches: any[] = []
    for (const dialog of dialogs) {
      const entity = dialog.entity as any
      if (entity?.title && typeof entity.title === 'string' && entity.title === CHANNEL_NAME) {
        matches.push(entity)
      }
    }
    if (matches.length > 0) {
      matches.sort((a, b) => Number(a.id) - Number(b.id))
      const oldest = matches[0]
      this.channelId = BigInt(oldest.id.toString())
      return {
        channelId: this.channelId.toString(),
        channelName: oldest.title,
      }
    }
    return await this.createPrivateChannel()
  }

  async uploadFile(filePath: string, onProgress?: (sent: number, total: number) => void, encrypt?: boolean, customFileName?: string) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')

    let uploadPath = filePath
    let ivHex = ''
    let isTemp = false

    if (customFileName) {
      const tempDir = app.getPath('temp')
      const newPath = path.join(tempDir, customFileName)
      fs.copyFileSync(filePath, newPath)
      uploadPath = newPath
      isTemp = true
    }

    if (encrypt) {
      const encrypted = await vaultService.encryptFile(uploadPath)
      if (isTemp) { try { fs.unlinkSync(uploadPath) } catch {} }
      uploadPath = encrypted.tempPath
      ivHex = encrypted.ivHex
      isTemp = true
    }

    const fileStats = fs.statSync(uploadPath)
    const originalStats = fs.statSync(filePath)
    const fileName = customFileName || path.basename(filePath)
    const sizeBytes = fileStats.size
    const originalSizeBytes = originalStats.size
    const CHUNK_SIZE = 1.95 * 1024 * 1024 * 1024 // 1.95 GB

    let turboMode = false
    try {
      const p = path.join(app.getPath('userData'), 'rodjer-preferences.json')
      if (fs.existsSync(p)) {
        const prefs = JSON.parse(fs.readFileSync(p, 'utf8'))
        turboMode = !!prefs.turboMode
      }
    } catch {}

    let workersCount = 4
    if (turboMode) {
      if (sizeBytes < 10 * 1024 * 1024) workersCount = 4
      else if (sizeBytes < 100 * 1024 * 1024) workersCount = 8
      else workersCount = 16
    } else {
      if (sizeBytes > 100 * 1024 * 1024) workersCount = 4
      else workersCount = 2
    }

    let thumbBuffer: Buffer | undefined = undefined
    if (!isTemp) {
      const ext = path.extname(filePath).toLowerCase()
      if (['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(ext)) {
        try {
          const tempDir = app.getPath('temp')
          const baseName = path.basename(filePath)
          const pngPath = path.join(tempDir, baseName + '.png')
          if (process.platform === 'darwin') {
            require('child_process').execFileSync('/usr/bin/qlmanage', ['-t', '-s', '320', filePath, '-o', tempDir], { timeout: 10000 })
          } else {
            try {
              require('child_process').execFileSync('ffmpeg', [
                '-i', filePath, '-ss', '00:00:01', '-vframes', '1',
                '-vf', 'scale=320:-1', pngPath
              ], { timeout: 10000 })
            } catch { /* ffmpeg не установлен — пропускаем */ }
          }
          if (fs.existsSync(pngPath)) {
            const pngBuf = fs.readFileSync(pngPath)
            const img = nativeImage.createFromBuffer(pngBuf)
            if (!img.isEmpty()) {
              thumbBuffer = img.toJPEG(80)
              ;(thumbBuffer as any).name = 'thumb.jpg'
            }
            fs.unlinkSync(pngPath)
          }
        } catch (e) {
          console.error('qlmanage thumb failed:', e)
        }
      }
    }

    const parts = await splitFileLocal(uploadPath, CHUNK_SIZE)
    const isMultipart = parts.length > 1
    
    let mainMessageId: number | null = null
    const multipartIds: number[] = []
    let totalSent = 0
    let fileHash = ''
    try { fileHash = await computeFileHash(filePath) } catch {}

    let mainCaptionStr = ''

    for (let i = 0; i < parts.length; i++) {
      const partPath = parts[i]
      const partSizeBytes = fs.statSync(partPath).size
      let partSent = 0

      let captionStr = ''
      if (i === 0) {
        // @ts-ignore
        captionStr = `${fileName}\nSize: ${this.formatFileSize(originalSizeBytes)}\nUploaded: ${new Date().toISOString()}\nCreated: ${new Date(originalStats.birthtimeMs || originalStats.mtimeMs).toISOString()}`
        if (encrypt) {
          captionStr += `\n#vault ${ivHex}`
        }
        mainCaptionStr = captionStr
      } else {
        captionStr = `#chunk_of ${mainMessageId}`
      }

      const result = await this.client.sendFile(this.channelId as any, {
        file: partPath,
        caption: captionStr,
        forceDocument: true,
        workers: workersCount,
        thumb: i === 0 ? thumbBuffer : undefined,
        progressCallback: (progress: any) => {
          try {
            const val = typeof progress === 'number' ? progress : Number(progress?.toString?.() ?? 0)
            const sent = val <= 1 ? Math.round(val * partSizeBytes) : Math.min(val, partSizeBytes)
            if (sent > partSent) {
              const diff = sent - partSent
              totalSent += diff
              partSent = sent
              onProgress?.(totalSent, sizeBytes)
            }
          } catch (err) {
            console.error('Progress callback error:', err)
          }
        },
      } as any)

      const msgId = typeof (result as any).id === 'object' ? Number((result as any).id.toString()) : (result as any).id
      if (i === 0) {
        mainMessageId = msgId
      } else {
        multipartIds.push(msgId)
      }

      if (isMultipart) {
        fs.unlink(partPath, () => {})
      }
    }

    if (isMultipart && multipartIds.length > 0 && mainMessageId !== null) {
      mainCaptionStr += `\n#multipart ${multipartIds.join(',')}`
      await this.client.editMessage(this.channelId as any, { message: mainMessageId, text: mainCaptionStr })
    }
    
    if (isTemp) {
        fs.unlink(uploadPath, () => {})
    }

    const fileTime = originalStats.birthtimeMs && originalStats.birthtimeMs > 0
      ? Math.floor(originalStats.birthtimeMs / 1000)
      : Math.floor(originalStats.mtimeMs / 1000)

    return {
      messageId: mainMessageId as number,
      fileName,
      fileSize: originalSizeBytes,
      uploadedAt: fileTime,
      hash: fileHash,
      isEncrypted: !!encrypt,
    }
  }

  private TRASH_MARKER = 'Trashed: '
  private TRASH_DAYS = 3
  private trashCleanupInterval: ReturnType<typeof setInterval> | null = null

  startTrashCleanup() {
    this.trashCleanupInterval = setInterval(() => this.autoCleanTrash(), 60 * 60 * 1000)
  }

  stopTrashCleanup() {
    if (this.trashCleanupInterval) { clearInterval(this.trashCleanupInterval); this.trashCleanupInterval = null }
  }

  private async autoCleanTrash() {
    if (!this.client || !this.channelId) return
    try {
      const messages: any[] = []
      let offsetId = 0
      const BATCH = 200
      while (true) {
        const batch = await this.client.getMessages(this.channelId as any, {
          limit: BATCH,
          ...(offsetId ? { offsetId } : {}),
        })
        if (batch.length === 0) break
        messages.push(...batch)
        if (batch.length < BATCH) break
        offsetId = this.msgId(batch[batch.length - 1])
      }
      const now = Date.now()
      for (const m of messages) {
        const caption: string = m.message || ''
        const escapedMarker = this.TRASH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const match = caption.match(new RegExp(`${escapedMarker}(\\d+)`))
        if (!match) continue
        const trashedAt = parseInt(match[1], 10)
        if (now - trashedAt > this.TRASH_DAYS * 24 * 3600 * 1000) {
          try {
            await this.client.invoke(
              new Api.channels.DeleteMessages({ channel: this.channelId as any, id: [this.msgId(m)] })
            )
          } catch {}
        }
      }
    } catch {}
  }

  private toNum(v: any): number {
    if (v == null) return 0
    if (typeof v === 'number') return v
    if (typeof v === 'bigint') return Number(v)
    if (typeof v === 'string') return Number(v)
    if (typeof v === 'object' && typeof v.toString === 'function') {
      const n = Number(v.toString())
      return isFinite(n) ? n : 0
    }
    return 0
  }

  async listFiles() {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages: any[] = []
    let offsetId = 0
    const BATCH = 200
    while (true) {
      const batch = await this.client.getMessages(this.channelId as any, {
        limit: BATCH,
        ...(offsetId ? { offsetId } : {}),
      })
      if (batch.length === 0) break
      messages.push(...batch)
      if (batch.length < BATCH) break
      offsetId = this.msgId(batch[batch.length - 1])
    }
    return messages
      .filter((m: any) => {
        if (!m.file || m.message === TelegramService.STATE_CAPTION) return false
        const caption: string = m.message || ''
        return !caption.includes(this.TRASH_MARKER) && !caption.includes('#chunk_of')
      })
      .map((m: any) => {
        const caption = m.message || ''
        const createdMatch = caption.match(/Created:\s*(.+)/)
        const vaultMatch = caption.match(/#vault\s+([a-f0-9]+)/)
        const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)
        const originalDate = createdMatch ? new Date(createdMatch[1]).getTime() / 1000 : 0
        return {
          messageId: this.msgId(m),
          fileName: m.file?.name || 'Unknown',
          fileSize: this.toNum(m.file?.size),
          mimeType: m.file?.mimeType || 'application/octet-stream',
          uploadedAt: typeof m.date === 'number' ? m.date : this.toNum(m.date),
          originalDate: originalDate || undefined,
          caption,
          chatId: this.channelId ? String(this.channelId).replace(/^-100/, '') : '',
          isEncrypted: !!vaultMatch,
          isMultipart: !!multipartMatch,
          multipartIds: multipartMatch ? multipartMatch[1].split(',').map(Number) : [],
        }
      })
  }

  async listTrash() {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages: any[] = []
    let offsetId = 0
    const BATCH = 200
    while (true) {
      const batch = await this.client.getMessages(this.channelId as any, {
        limit: BATCH,
        ...(offsetId ? { offsetId } : {}),
      })
      if (batch.length === 0) break
      messages.push(...batch)
      if (batch.length < BATCH) break
      offsetId = this.msgId(batch[batch.length - 1])
    }
    return messages
      .filter((m: any) => {
        if (!m.file || m.message === TelegramService.STATE_CAPTION) return false
        const caption: string = m.message || ''
        return caption.includes(this.TRASH_MARKER) && !caption.includes('#chunk_of')
      })
      .map((m: any) => {
        const caption = m.message || ''
        const createdMatch = caption.match(/Created:\s*(.+)/)
        const originalDate = createdMatch ? new Date(createdMatch[1]).getTime() / 1000 : 0
        const trashedMatch = caption.match(new RegExp(this.TRASH_MARKER + '(\\d+)'))
        return {
          messageId: this.msgId(m),
          fileName: m.file?.name || 'Unknown',
          fileSize: this.toNum(m.file?.size),
          mimeType: m.file?.mimeType || 'application/octet-stream',
          uploadedAt: typeof m.date === 'number' ? m.date : this.toNum(m.date),
          originalDate: originalDate || undefined,
          trashedAt: trashedMatch ? parseInt(trashedMatch[1], 10) : 0,
          caption,
          chatId: this.channelId ? String(this.channelId).replace(/^-100/, '') : '',
        }
      })
  }

  async trashFile(messageId: number) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    if (!messages || messages.length === 0) throw new Error('Message not found')
    const m = messages[0]
    const oldCaption = m.message || ''
    const newCaption = oldCaption.includes(this.TRASH_MARKER)
      ? oldCaption
      : oldCaption + `\n${this.TRASH_MARKER}${Date.now()}`
    await this.client.editMessage(this.channelId as any, { message: messageId, text: newCaption })
    
    const multipartMatch = oldCaption.match(/#multipart\s+([\d,]+)/)
    if (multipartMatch) {
      const partIds = multipartMatch[1].split(',').map(Number)
      for (const id of partIds) {
        const pMsgs = await this.client.getMessages(this.channelId as any, { ids: [id] })
        if (pMsgs && pMsgs.length > 0) {
           const pOld = pMsgs[0].message || ''
           const pNew = pOld.includes(this.TRASH_MARKER) ? pOld : pOld + `\n${this.TRASH_MARKER}${Date.now()}`
           await this.client.editMessage(this.channelId as any, { message: id, text: pNew })
        }
      }
    }
  }

  async restoreFile(messageId: number) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    if (!messages || messages.length === 0) throw new Error('Message not found')
    const m = messages[0]
    const oldCaption = m.message || ''
    const newCaption = oldCaption.replace(new RegExp(`\n?${this.TRASH_MARKER}\\d+`), '')
    if (newCaption !== oldCaption) {
      await this.client.editMessage(this.channelId as any, { message: messageId, text: newCaption })
    }
    
    const multipartMatch = oldCaption.match(/#multipart\s+([\d,]+)/)
    if (multipartMatch) {
      const partIds = multipartMatch[1].split(',').map(Number)
      for (const id of partIds) {
        const pMsgs = await this.client.getMessages(this.channelId as any, { ids: [id] })
        if (pMsgs && pMsgs.length > 0) {
           const pOld = pMsgs[0].message || ''
           const pNew = pOld.replace(new RegExp(`\n?${this.TRASH_MARKER}\\d+`), '')
           if (pNew !== pOld) {
              await this.client.editMessage(this.channelId as any, { message: id, text: pNew })
           }
        }
      }
    }
  }

  async permanentDelete(messageId: number) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    let idsToDelete = [messageId]
    if (messages && messages.length > 0) {
       const caption = messages[0].message || ''
       const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)
       if (multipartMatch) {
          idsToDelete.push(...multipartMatch[1].split(',').map(Number))
       }
    }
    await this.client.invoke(
      new Api.channels.DeleteMessages({ channel: this.channelId as any, id: idsToDelete })
    )
  }

  private async performDownload(message: any, targetPath: string) {
    const caption = message.message || ''
    const vaultMatch = caption.match(/#vault\s+([a-f0-9]+)/)
    const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)
    const isEncrypted = !!vaultMatch

    let finalTargetPath = targetPath
    if (isEncrypted) finalTargetPath = targetPath + '.enc'

    if (multipartMatch) {
      const partIds = multipartMatch[1].split(',').map(Number)
      
      await this.client!.downloadMedia(message, { outputFile: finalTargetPath } as any)
      
      for (const id of partIds) {
        const partMessages = await this.client!.getMessages(this.channelId as any, { ids: [id] })
        if (partMessages && partMessages.length > 0) {
          const partPath = finalTargetPath + `.part_${id}`
          await this.client!.downloadMedia(partMessages[0], { outputFile: partPath } as any)
          
          const readStream = fs.createReadStream(partPath)
          const writeStream = fs.createWriteStream(finalTargetPath, { flags: 'a' })
          await new Promise((resolve, reject) => {
            readStream.pipe(writeStream)
            readStream.on('end', resolve)
            readStream.on('error', reject)
            writeStream.on('error', reject)
          })
          fs.unlinkSync(partPath)
        }
      }
    } else {
      await this.client!.downloadMedia(message, { outputFile: finalTargetPath } as any)
    }

    if (isEncrypted) {
      await vaultService.decryptFile(finalTargetPath, targetPath, vaultMatch[1])
      try { fs.unlinkSync(finalTargetPath) } catch {}
    }
  }



  async downloadFile(messageId: number, fileName: string) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    if (!messages || messages.length === 0) throw new Error('Message not found')
    const message: any = messages[0]
    if (!message.file) throw new Error('No file attached to message')
    const downloadsPath = app.getPath('downloads')
    let downloadPath = path.join(downloadsPath, fileName)
    let suffix = 1
    const ext = path.extname(fileName)
    const base = path.basename(fileName, ext)
    while (fs.existsSync(downloadPath)) {
      downloadPath = path.join(downloadsPath, `${base} (${suffix})${ext}`)
      suffix++
    }
    await this.performDownload(message, downloadPath)
    return { filePath: downloadPath, fileName }
  }

  async downloadMediaToPath(messageId: number, filePath: string) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    if (!messages || messages.length === 0) throw new Error('Message not found')
    const message: any = messages[0]
    if (!message.file) throw new Error('No file attached to message')
    await this.performDownload(message, filePath)
  }

  async downloadMediaToTemp(messageId: number): Promise<string> {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    if (!messages || messages.length === 0) throw new Error('Message not found')
    const message: any = messages[0]
    if (!message.file) throw new Error('No file attached to message')
    const tmpDir = app.getPath('temp')
    const tmpFile = path.join(tmpDir, `_hash_${messageId}`)
    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true })
    await this.performDownload(message, tmpFile)
    return tmpFile
  }

  async downloadThumbnail(messageId: number, fileName?: string): Promise<string | null> {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    if (!messages || messages.length === 0) return null
    const message: any = messages[0]
    if (!message.file) return null

    const ext = fileName ? path.extname(fileName).toLowerCase() : '.jpg'
    const cacheDir = path.join(app.getPath('userData'), 'thumb-cache')
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
    const cachePath = path.join(cacheDir, `${messageId}${ext}`)
    if (fs.existsSync(cachePath)) return cachePath

    const media = message.document || message.photo
    const hasThumbs = media && media.thumbs && media.thumbs.length > 0

    if (hasThumbs) {
      // Try to get a medium/large thumbnail to avoid blurriness
      const sizesToTry = ['m', 'x', media.thumbs.length - 1, 1, 0]
      for (const t of sizesToTry) {
        try {
          await this.client.downloadMedia(message, { outputFile: cachePath, thumb: t } as any)
          if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) return cachePath
        } catch {}
      }
    } else if (ext === '.heic' || ext === '.heif') {
      // No thumbnails available. For HEIC, we must download the full file to generate a thumbnail.
      try {
        await this.client.downloadMedia(message, { outputFile: cachePath } as any)
        if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) return cachePath
      } catch {}
    }

    return null
  }



  async logout() {
    if (this.client) {
      try { await this.client.invoke(new Api.auth.LogOut()) } catch {}
      try { await this.client.disconnect() } catch {}
      this.client = null
    }
  }

  getSessionString(): string {
    if (!this.client) throw new Error('Client not initialized')
    return this.client.session.save() as any
  }

  async cacheAudio(messageId: number, fileName: string, cacheDir: string): Promise<string> {
    if (!this.client || !this.channelId) throw new Error('Client not initialized')
    const cachePath = path.join(cacheDir, `${messageId}_${fileName}`)
    if (fs.existsSync(cachePath)) return cachePath
    const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    if (!messages || messages.length === 0) throw new Error('Message not found')
    const message: any = messages[0]
    if (!message.file) throw new Error('No file attached')
    await this.client.downloadMedia(message, { outputFile: cachePath } as any)
    return cachePath
  }

  private folderSyncId: number | null = null
  private static SYNC_PREFIX = 'RFSYNC:'
  private static OLD_PREFIXES = ['RFSYNC:', 'rf', '__rf__']

  private get folderSyncIdPath(): string {
    return path.join(app.getPath('userData'), 'folder-sync-id.json')
  }

  private saveFolderSyncId(id: number) {
    this.folderSyncId = id
    try { fs.writeFileSync(this.folderSyncIdPath, JSON.stringify({ id })) } catch {}
  }

  private loadFolderSyncId(): number | null {
    try {
      if (fs.existsSync(this.folderSyncIdPath)) {
        const data = JSON.parse(fs.readFileSync(this.folderSyncIdPath, 'utf8'))
        return data.id || null
      }
    } catch {}
    return null
  }

  private parseSyncMessage(text: string): { data: any; prefixLen: number } | null {
    for (const p of TelegramService.OLD_PREFIXES) {
      if (text.startsWith(p)) {
        try { return { data: JSON.parse(text.slice(p.length)), prefixLen: p.length } } catch {}
      }
    }
    return null
  }

  private msgId(m: any): number {
    return typeof m.id === 'object' ? Number(m.id.toString()) : m.id
  }

  async syncFolders(data: { folders: any[]; fileFolders: Record<string, string> }) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const payload = TelegramService.SYNC_PREFIX + JSON.stringify(data)

    // Try cached ID first — edit it, but still search+cleanup duplicates
    let editedViaCache = false
    if (!this.folderSyncId) this.folderSyncId = this.loadFolderSyncId()
    if (this.folderSyncId) {
      try {
        await this.client.editMessage(this.channelId as any, { message: this.folderSyncId, text: payload, formattingEntities: [] } as any)
        editedViaCache = true
      } catch {
        this.folderSyncId = null
      }
    }

    // Search for existing sync messages
    const msgs = await this.client.getMessages(this.channelId as any, { limit: 200 } as any)
    const syncMsgs: any[] = []
    for (const m of msgs) {
      if (m.message && this.parseSyncMessage(m.message)) syncMsgs.push(m)
    }

    if (syncMsgs.length > 0) {
      // Use the first (newest) sync message as primary
      const primary = syncMsgs[0]
      this.saveFolderSyncId(this.msgId(primary))
      if (!editedViaCache || this.folderSyncId !== this.msgId(primary)) {
        // Если кеш не совпадает с новейшим — редактируем новейший
        await this.client.editMessage(this.channelId as any, { message: this.folderSyncId, text: payload, formattingEntities: [] } as any)
      }

      // Clean up duplicate sync messages
      if (syncMsgs.length > 1) {
        const dupeIds = syncMsgs.slice(1).map((m: any) => this.msgId(m))
        try {
          await this.client.invoke(
            new Api.channels.DeleteMessages({ channel: this.channelId as any, id: dupeIds })
          )
        } catch {}
      }
      return
    }

    // No sync message exists — create one
    if (!editedViaCache) {
      const sent: any = await this.client.sendMessage(this.channelId as any, { message: payload, formattingEntities: [] } as any)
      this.saveFolderSyncId(this.msgId(sent))
    }
  }

  private debugLog(msg: string) {
    const logPath = path.join(app.getPath('userData'), 'folder-sync-debug.log')
    const line = `[${new Date().toISOString()}] ${msg}\n`
    try { fs.appendFileSync(logPath, line) } catch {}
  }

  async loadFoldersFromChannel(): Promise<{ folders: any[]; fileFolders: Record<string, string> } | null> {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')

    this.debugLog('loadFoldersFromChannel called')

    // Full search by prefix — collect ALL sync messages and merge
    const msgs = await this.client.getMessages(this.channelId as any, { limit: 200 } as any)
    this.debugLog('Full search, total messages: ' + msgs.length)

    const allFolders: any[] = []
    const allFileFolders: Record<string, string> = {}
    const seenFolderIds = new Set<string>()
    const seenFileIds = new Set<string>()
    let newestSyncId: number | null = null

    for (const m of msgs) {
      if (!m.message) continue
      if (!m.message.startsWith('rf') && !m.message.startsWith('RFSYNC:')) continue
      const id = this.msgId(m)
      this.debugLog(`msg id=${id} hasFile=${!!m.file} text[0..80]="${m.message.substring(0, 80)}"`)

      const parsed = this.parseSyncMessage(m.message)
      if (!parsed) continue
      this.debugLog('FOUND sync id=' + id + ' folders=' + (parsed.data?.folders?.length ?? 0))

      if (newestSyncId === null) newestSyncId = id
      if (parsed.data?.folders) {
        for (const f of parsed.data.folders) {
          if (f.id && !seenFolderIds.has(f.id)) {
            seenFolderIds.add(f.id)
            allFolders.push(f)
          }
        }
      }
      if (parsed.data?.fileFolders) {
        for (const [key, val] of Object.entries(parsed.data.fileFolders)) {
          if (!seenFileIds.has(key)) {
            seenFileIds.add(key)
            allFileFolders[key] = val as string
          }
        }
      }
    }

    if (newestSyncId !== null) {
      this.saveFolderSyncId(newestSyncId)
      this.debugLog('Merged result: ' + allFolders.length + ' folders, ' + Object.keys(allFileFolders).length + ' file mappings')
      return { folders: allFolders, fileFolders: allFileFolders }
    }

    this.debugLog('NO sync message found!')
    return null
  }

  async forwardMessages(toPeer: bigint, messageIds: number[], fromPeer: bigint) {
    if (!this.client) throw new Error('Client not initialized')
    const ids = [...messageIds]
    await this.client.forwardMessages(fromPeer, { messages: ids, toPeer })
  }

  async getUserId(): Promise<bigint> {
    if (!this.client) throw new Error('Client not initialized')
    const me = await this.client.getMe() as any
    return BigInt(me.id.toString())
  }

  async cleanupBots(activeBotToken?: string | null): Promise<void> {
    if (!this.client || !this.channelId) return
    try {
      let activeBotId: string | null = null
      if (activeBotToken) {
        const parts = activeBotToken.split(':')
        if (parts.length > 1) activeBotId = parts[0]
      }
      
      const participants = await this.client.invoke(
        new Api.channels.GetParticipants({
          channel: this.channelId as any,
          filter: new Api.ChannelParticipantsBots(),
          offset: 0,
          limit: 200,
          hash: 0,
        })
      ) as any
      const bots = participants?.users?.filter((u: any) => u.bot) || []
      
      for (const bot of bots) {
        if (activeBotId && bot.id.toString() === activeBotId) continue
        
        try {
          await this.client.invoke(
            new Api.channels.EditAdmin({
              channel: this.channelId as any,
              userId: bot.id,
              adminRights: new Api.ChatAdminRights({
                changeInfo: false, postMessages: false, editMessages: false,
                deleteMessages: false, banUsers: false, inviteUsers: false,
                pinMessages: false, addAdmins: false, anonymous: false,
                manageCall: false, other: false, manageTopics: false
              }),
              rank: ''
            })
          )
        } catch {}
        
        try {
          await this.client.invoke(
            new Api.channels.EditBanned({
              channel: this.channelId as any,
              participant: bot.id,
              bannedRights: new Api.ChatBannedRights({
                viewMessages: true,
                untilDate: 0
              })
            })
          )
          console.log(`Kicked useless bot ${bot.username} from channel`)
        } catch (e) {
          console.warn(`Failed to kick bot ${bot.username}`, (e as Error).message)
        }
      }
    } catch (e) {
      console.warn('Failed to cleanup bots', (e as Error).message)
    }
  }

  async createBotAndAddToChannel(): Promise<{ token: string; username: string }> {
    if (!this.client || !this.channelId) throw new Error('Not initialized')

    await this.cleanupBots(null)

    const botFather = await this.client.getEntity('BotFather') as any
    if (!botFather) throw new Error('Cannot find BotFather')

    const sendAndWait = async (msg: string): Promise<string> => {
      const before = (await this.client!.getMessages(botFather, { limit: 1 })) as any[] | undefined
      const lastId = before && before.length > 0 ? before[0]!.id : 0
      await this.client!.sendMessage(botFather, { message: msg, silent: true } as any)
      const start = Date.now()
      while (Date.now() - start < 15000) {
        const msgs = (await this.client!.getMessages(botFather, { limit: 5 })) as any[] | undefined
        if (msgs) {
          for (const m of msgs) {
            if (!m.out && m.id > lastId) {
              return m.message || ''
            }
          }
        }
        await new Promise((r) => setTimeout(r, 400))
      }
      throw new Error('Timeout waiting for BotFather reply')
    }

    await sendAndWait('/newbot')
    const nameResp = await sendAndWait('RodjerCloud Bot')
    if (nameResp.toLowerCase().includes('sorry') || nameResp.toLowerCase().includes('too many')) {
      throw new Error('BotFather: ' + nameResp)
    }

    let token = ''
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = Math.random().toString(36).slice(2, 8)
      const botUsername = `rodjercloud_${suffix}_bot`
      const resp = await sendAndWait(botUsername)

      const m = resp.match(/Use this token to access the HTTP API:\s*(\S+)/)
      if (m) {
        token = m[1]
        await this.addBotToChannel(botUsername)
        await this.createCloudFolder(botUsername)
        return { token, username: botUsername }
      }

      if (!resp.toLowerCase().includes('already')) {
        throw new Error('Bot creation failed: ' + resp)
      }
    }

    throw new Error('Failed to create bot: unable to find unique username')
  }

  private async addBotToChannel(botUsername: string) {
    if (!this.client || !this.channelId) throw new Error('Not initialized')
    const botEntity = await this.client.getEntity(botUsername) as any
    if (!botEntity) throw new Error('Cannot find bot: ' + botUsername)

    try {
      await this.client.invoke(
        new Api.channels.InviteToChannel({
          channel: this.channelId as any,
          users: [botEntity],
        } as any)
      )
    } catch {
      // bot may already be in channel
    }

    await this.client.invoke(
      new Api.channels.EditAdmin({
        channel: this.channelId as any,
        userId: botEntity,
        adminRights: new Api.ChatAdminRights({
          changeInfo: true,
          postMessages: true,
          editMessages: true,
          deleteMessages: true,
          inviteUsers: true,
          pinMessages: true,
          addAdmins: false,
          manageCall: true,
          other: true,
        }),
        rank: 'Bot',
      })
    )

    try {
      await this.client.sendMessage(botEntity, { message: '/start', silent: true } as any)
    } catch {
      // non-critical
    }
  }

  async createCloudFolder(botUsername?: string) {
    if (!this.client || !this.channelId) return

    try {
      const filters = await this.client.invoke(
        new Api.messages.GetDialogFilters()
      ) as any
      const existing = (filters?.filters || []).find((f: any) =>
        f.title?.text === 'Облако'
      )
      if (existing) return

      const channelEntity = await this.client.getEntity(this.channelId) as any
      const channelPeer = new Api.InputPeerChannel({
        channelId: this.channelId,
        accessHash: channelEntity.accessHash,
      })

      let botPeer: any = null
      if (botUsername) {
        try {
          const botEntity = await this.client.getEntity(botUsername) as any
          botPeer = new Api.InputPeerUser({
            userId: botEntity.id,
            accessHash: botEntity.accessHash,
          })
        } catch {}
      }
      if (!botPeer) {
        try {
          const participants = await this.client.invoke(
            new Api.channels.GetParticipants({
              channel: this.channelId as any,
              filter: new Api.ChannelParticipantsBots(),
              offset: 0,
              limit: 200,
              hash: 0,
            })
          ) as any
          const bot = participants?.users?.find((u: any) => u.bot)
          if (bot) {
            botPeer = new Api.InputPeerUser({
              userId: BigInt(bot.id.toString()),
              accessHash: bot.accessHash || 0,
            })
          }
        } catch {}
      }

      const usedIds = new Set((filters?.filters || []).map((f: any) => f.id))
      let folderId = 2
      while (usedIds.has(folderId)) folderId++

      await this.client.invoke(
        new Api.messages.UpdateDialogFilter({
          id: folderId,
          filter: new Api.DialogFilter({
            id: folderId,
            title: new Api.TextWithEntities({ text: 'Облако', entities: [] }),
            pinnedPeers: [],
            includePeers: botPeer ? [channelPeer, botPeer] : [channelPeer],
            excludePeers: [],
          }),
        })
      )
    } catch (e) {
      console.warn('Failed to create cloud folder:', (e as Error).message)
    }
  }

  async getUserInfo(): Promise<{ firstName: string; lastName?: string; username?: string; photoPath?: string; isVideo?: boolean }> {
    if (!this.client) throw new Error('Client not initialized')
    const me = await this.client.getMe() as any
    const info: any = { firstName: me.firstName || '', lastName: me.lastName, username: me.username }

    if (me.photo) {
      const cacheDir = path.join(app.getPath('userData'), 'profile-cache')
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
      try {
        const buffer = await this.client.downloadProfilePhoto(me, { isBig: true }) as Buffer
        if (buffer && buffer.length > 8) {
          const isMp4 = buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70
          const ext = isMp4 ? '.mp4' : '.jpg'
          const cachePath = path.join(cacheDir, `avatar${ext}`)
          fs.writeFileSync(cachePath, buffer)
          info.photoPath = cachePath
          info.isVideo = isMp4
        }
      } catch (e) {
        console.warn('Failed to download profile photo:', e)
      }
    }

    return info
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  private static STATE_FILENAME = '_rc_state.json'
  private static STATE_CAPTION = '_rc_state_v1'
  private stateMsgId: number | null = null

  private get stateIdPath(): string {
    return path.join(app.getPath('userData'), 'state-msg-id.json')
  }

  private saveStateMsgId(id: number) {
    this.stateMsgId = id
    try { fs.writeFileSync(this.stateIdPath, JSON.stringify({ id })) } catch {}
  }

  private loadStateMsgId(): number | null {
    try {
      if (fs.existsSync(this.stateIdPath)) {
        const data = JSON.parse(fs.readFileSync(this.stateIdPath, 'utf8'))
        return data.id || null
      }
    } catch {}
    return null
  }

  async syncState(jsonStr: string) {
    if (!this.client || !this.channelId) throw new Error('Not initialized')

    const tmpDir = app.getPath('temp')
    const tmpFile = path.join(tmpDir, TelegramService.STATE_FILENAME + '.gz') // use .gz
    
    // GZIP compression to save space and network bandwidth
    const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'))
    fs.writeFileSync(tmpFile, compressed)

    // Delete old sync file if known
    if (this.stateMsgId === null) this.stateMsgId = this.loadStateMsgId()
    if (this.stateMsgId) {
      try {
        await this.client.invoke(
          new Api.channels.DeleteMessages({ channel: this.channelId as any, id: [this.stateMsgId] })
        )
      } catch {}
    }

    // Upload new state file
    const result = await this.client.sendFile(this.channelId as any, {
      file: tmpFile,
      caption: TelegramService.STATE_CAPTION,
      forceDocument: true,
      workers: 4,
    } as any)

    fs.rmSync(tmpFile, { force: true })

    const msgId = typeof (result as any).id === 'object' ? Number((result as any).id.toString()) : (result as any).id
    this.saveStateMsgId(msgId)
  }

  async loadStateFromChannel(): Promise<string | null> {
    if (!this.client || !this.channelId) throw new Error('Not initialized')

    // Try cached message ID first
    if (this.stateMsgId === null) this.stateMsgId = this.loadStateMsgId()
    if (this.stateMsgId) {
      try {
        const msgs = await this.client.getMessages(this.channelId as any, { ids: [this.stateMsgId] })
        if (msgs && msgs.length > 0 && (msgs[0] as any).file) {
          const tmpDir = app.getPath('temp')
          const tmpFile = path.join(tmpDir, TelegramService.STATE_FILENAME)
          await this.client.downloadMedia(msgs[0] as any, { outputFile: tmpFile } as any)
          if (fs.existsSync(tmpFile)) {
            const buffer = fs.readFileSync(tmpFile)
            let content = ''
            
            // Check for Gzip magic bytes (1F 8B)
            if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
              content = zlib.gunzipSync(buffer).toString('utf8')
            } else {
              content = buffer.toString('utf8') // Fallback to raw text for old versions
            }
            
            fs.rmSync(tmpFile, { force: true })
            return content
          }
        }
      } catch {}
    }

    // Fallback: search by caption
    const allMsgs = await this.client.getMessages(this.channelId as any, { limit: 200 } as any)
    for (const m of allMsgs) {
      const msg = m as any
      if (msg.file && msg.message === TelegramService.STATE_CAPTION) {
        this.saveStateMsgId(this.msgId(msg))
        const tmpDir = app.getPath('temp')
        const tmpFile = path.join(tmpDir, TelegramService.STATE_FILENAME)
        await this.client.downloadMedia(msg, { outputFile: tmpFile } as any)
        if (fs.existsSync(tmpFile)) {
          const content = fs.readFileSync(tmpFile, 'utf8')
          fs.rmSync(tmpFile, { force: true })
          return content
        }
      }
    }

    return null
  }

  async cleanThumbnailCache(maxAgeDays = 30) {
    const cacheDir = path.join(app.getPath('userData'), 'thumb-cache')
    if (!fs.existsSync(cacheDir)) return
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    for (const file of fs.readdirSync(cacheDir)) {
      try {
        const fp = path.join(cacheDir, file)
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp)
      } catch {}
    }
  }
}
