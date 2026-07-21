import { TelegramClient } from 'telegram'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

const SHARE_LOG = () => path.join(app.isPackaged ? app.getPath('userData') : app.getAppPath(), 'share-debug.log')
function shareLog(...args: any[]) {
  try { fs.appendFileSync(SHARE_LOG(), `[${new Date().toISOString()}] [findBot] ${args.join(' ')}\n`) } catch {}
}
import { getFileHash } from './storage-service'
import { vaultService } from './vault-service'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import zlib from 'zlib'
import { app, ipcMain, nativeImage } from 'electron'

const TRASH_DATA_PATH = path.join(app.getPath('userData'), 'trashed_ids.json')
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

async function extractChunkToDisk(source: string, target: string, start: number, end: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(source, { start, end: end - 1, highWaterMark: 256 * 1024 })
    const ws = fs.createWriteStream(target)
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('finish', resolve)
    rs.pipe(ws)
  })
}

export class TelegramService {
  private client: TelegramClient | null = null
  private phoneNumber: string = ''
  private channelId: bigint | null = null

  private heavyThumbQueue: { messageId: number, message: any, cachePath: string }[] = []
  private processingHeavyQueue = false

  constructor() {
    this.loadTrashState()
  }

  private async processHeavyThumbQueue() {
    if (this.processingHeavyQueue) return
    this.processingHeavyQueue = true
    while (this.heavyThumbQueue.length > 0) {
      const task = this.heavyThumbQueue.shift()!
      try {
        const tmpPath = task.cachePath + '.tmp.heic'
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
        
        await this.performDownload(task.message, tmpPath)
        
        if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
          let outputBuffer = fs.readFileSync(tmpPath)
          
          if (process.platform === 'darwin') {
            const { execFileSync } = require('child_process')
            const sipsTmp = tmpPath + '.jpg'
            try {
              execFileSync('/usr/bin/sips', ['-Z', '320', '-s', 'format', 'jpeg', tmpPath, '--out', sipsTmp], { timeout: 15000 })
              outputBuffer = fs.readFileSync(sipsTmp)
              try { fs.unlinkSync(sipsTmp) } catch {}
            } catch (e: any) {
              console.error('sips convert error:', e)
            }
          } else {
            const heicPath = require.resolve('heic-convert').replace(/\\/g, '/')
            const { Worker } = require('worker_threads')
            const outBuf = await new Promise<Buffer>((resolve, reject) => {
              const worker = new Worker(`
                const heicConvert = require('${heicPath}');
                const { parentPort, workerData } = require('worker_threads');
                async function run() {
                  try {
                    const out = await heicConvert({ buffer: Buffer.from(workerData), format: 'JPEG', quality: 0.8 });
                    parentPort.postMessage({ success: true, buffer: out });
                  } catch (e) {
                    parentPort.postMessage({ success: false, error: e.message });
                  }
                }
                run();
              `, { eval: true, workerData: outputBuffer })
              worker.on('message', msg => {
                if (msg.success) resolve(Buffer.from(msg.buffer))
                else reject(new Error(msg.error))
              })
              worker.on('error', reject)
              worker.on('exit', code => {
                if (code !== 0) reject(new Error('heic-convert worker stopped with exit code ' + code))
              })
            })
            const img = nativeImage.createFromBuffer(outBuf)
            outputBuffer = img.resize({ width: 320 }).toJPEG(80)
          }
          
          fs.writeFileSync(task.cachePath, outputBuffer)
          try { fs.unlinkSync(tmpPath) } catch {}
          
          const { BrowserWindow } = require('electron')
          BrowserWindow.getAllWindows().forEach(w => w.webContents.send('thumbnail-ready', { messageId: task.messageId, path: task.cachePath }))
        }
      } catch (e) {
        console.error('Heavy thumb queue error:', e)
      }
    }
    this.processingHeavyQueue = false
  }

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

  getClient() { return this.client }
  getChannelId() { return this.channelId }

  async getMessage(messageId: number) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized')
    const msgs = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
    return msgs && msgs.length > 0 ? msgs[0] : null
  }

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
      const dialogs = await this.client.getDialogs({ limit: 2000 })
      const matches: any[] = []
      for (const dialog of dialogs) {
        const entity = dialog.entity as any
        if (entity?.title && typeof entity.title === 'string' && entity.title === CHANNEL_NAME) {
          matches.push(entity)
        }
      }
      if (matches.length > 0) {
        let activeChannel = matches[0]
        let latestDate = 0
        for (const match of matches) {
          try {
            const msgs = await this.client.getMessages(match.id, { limit: 1 })
            const date = msgs.length > 0 ? msgs[0].date : 0
            if (date >= latestDate) {
              latestDate = date
              activeChannel = match
            }
          } catch (e) {}
        }
        this.channelId = BigInt(activeChannel.id.toString())
        return {
          channelId: this.channelId.toString(),
          channelName: activeChannel.title,
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

    const dialogs = await this.client.getDialogs({ limit: 2000 })
    const matches: any[] = []
    for (const dialog of dialogs) {
      const entity = dialog.entity as any
      if (entity?.title && typeof entity.title === 'string' && entity.title === CHANNEL_NAME) {
        matches.push(entity)
      }
    }
    if (matches.length > 0) {
      let activeChannel = matches[0]
      let latestDate = 0
      for (const match of matches) {
        try {
          const msgs = await this.client.getMessages(match.id, { limit: 1 })
          const date = msgs.length > 0 ? msgs[0].date : 0
          if (date >= latestDate) {
            latestDate = date
            activeChannel = match
          }
        } catch (e) {}
      }
      this.channelId = BigInt(activeChannel.id.toString())
      return {
        channelId: this.channelId.toString(),
        channelName: activeChannel.title,
      }
    }
    return await this.createPrivateChannel()
  }

  async uploadFile(filePath: string, onProgress?: (sent: number, total: number) => void, encrypt?: boolean, customFileName?: string, checkCancelled?: () => boolean) {
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
    const CHUNK_SIZE = Math.floor(1.95 * 1024 * 1024 * 1024) // 1.95 GB

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
      if (sizeBytes < 10 * 1024 * 1024) workersCount = 8
      else if (sizeBytes < 100 * 1024 * 1024) workersCount = 16
      else workersCount = 32
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
          if (process.platform === 'darwin') {
            const pngPath = path.join(tempDir, baseName + '.png')
            require('child_process').execFileSync('/usr/bin/qlmanage', ['-t', '-s', '320', filePath, '-o', tempDir], { timeout: 10000 })
            if (fs.existsSync(pngPath)) {
              const pngBuf = fs.readFileSync(pngPath)
              const img = nativeImage.createFromBuffer(pngBuf)
              if (!img.isEmpty()) {
                thumbBuffer = img.toJPEG(80)
                ;(thumbBuffer as any).name = 'thumb.jpg'
              }
              try { fs.unlinkSync(pngPath) } catch {}
            }
          } else {
            const jpgPath = path.join(tempDir, baseName + '_thumb.jpg')
            try {
              let ffmpegPath = require('ffmpeg-static')
              if (ffmpegPath.includes('app.asar')) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')
              require('child_process').execFileSync(ffmpegPath, [
                '-ss', '00:00:00.000',
                '-i', filePath, '-vframes', '1',
                '-vf', 'scale=320:320:force_original_aspect_ratio=decrease,format=yuv420p',
                '-q:v', '5', '-y', jpgPath
              ], { timeout: 10000, stdio: 'ignore' })
            } catch (err) { console.error('ffmpeg thumb error:', err) }
            
            if (fs.existsSync(jpgPath)) {
              thumbBuffer = fs.readFileSync(jpgPath)
              ;(thumbBuffer as any).name = 'thumb.jpg'
              try { fs.unlinkSync(jpgPath) } catch {}
            }
          }
        } catch (e) {
          console.error('qlmanage thumb failed:', e)
        }
      } else if (ext === '.heic' || ext === '.heif') {
        try {
          const inputBuffer = fs.readFileSync(filePath)
          let outputBuffer = inputBuffer
          if (process.platform === 'darwin') {
            const { execFileSync } = require('child_process')
            const tempDir = app.getPath('temp')
            const sipsTmp = path.join(tempDir, path.basename(filePath) + '.jpg')
            execFileSync('/usr/bin/sips', ['-Z', '320', '-s', 'format', 'jpeg', filePath, '--out', sipsTmp], { timeout: 15000 })
            outputBuffer = fs.readFileSync(sipsTmp)
            try { fs.unlinkSync(sipsTmp) } catch {}
          } else {
            const heicPath = require.resolve('heic-convert').replace(/\\/g, '/')
            const { Worker } = require('worker_threads')
            const outBuf = await new Promise<Buffer>((resolve, reject) => {
              const worker = new Worker(`
                const heicConvert = require('${heicPath}');
                const { parentPort, workerData } = require('worker_threads');
                async function run() {
                  try {
                    const out = await heicConvert({ buffer: Buffer.from(workerData), format: 'JPEG', quality: 0.8 });
                    parentPort.postMessage({ success: true, buffer: out });
                  } catch (e) {
                    parentPort.postMessage({ success: false, error: e.message });
                  }
                }
                run();
              `, { eval: true, workerData: inputBuffer })
              worker.on('message', msg => {
                if (msg.success) resolve(Buffer.from(msg.buffer))
                else reject(new Error(msg.error))
              })
              worker.on('error', reject)
              worker.on('exit', code => {
                if (code !== 0) reject(new Error('heic-convert worker stopped with exit code ' + code))
              })
            })
            const img = nativeImage.createFromBuffer(outBuf)
            outputBuffer = img.resize({ width: 320 }).toJPEG(80)
          }
          thumbBuffer = outputBuffer
          ;(thumbBuffer as any).name = 'thumb.jpg'
        } catch (e) {
          console.error('heic thumb failed on upload:', e)
        }
      }
    }

    const totalParts = Math.max(1, Math.ceil(sizeBytes / CHUNK_SIZE))
    const isMultipart = totalParts > 1
    
    let mainMessageId: number | null = null
    const multipartIds: number[] = []
    let totalSent = 0
    let fileHash = ''
    try { fileHash = await computeFileHash(filePath) } catch {}

    let mainCaptionStr = ''

    const tempDir = app.getPath('temp')

    for (let i = 0; i < totalParts; i++) {
      if (checkCancelled?.()) throw new Error('Upload cancelled by user')
      const partStart = i * CHUNK_SIZE
      const partEnd = Math.min((i + 1) * CHUNK_SIZE, sizeBytes)
      const partSizeBytes = partEnd - partStart
      
      let partPath = uploadPath
      if (isMultipart) {
        partPath = path.join(tempDir, `rodjer_chunk_${crypto.randomUUID()}_${i}`)
        await extractChunkToDisk(uploadPath, partPath, partStart, partEnd)
      }

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
        fileName,
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

      if (isMultipart) {
        try { fs.unlinkSync(partPath) } catch {}
      }

      const msgId = typeof (result as any).id === 'object' ? Number((result as any).id.toString()) : (result as any).id
      if (i === 0) {
        mainMessageId = msgId
      } else {
        multipartIds.push(msgId)
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
            let idsToDelete = [this.msgId(m)]
            const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)
            if (multipartMatch) {
              idsToDelete.push(...multipartMatch[1].split(',').map(Number))
            }
            await this.client.deleteMessages(this.channelId as any, idsToDelete, { revoke: true })
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
        const msgId = this.msgId(m)
        if (this.localTrashedIds.has(msgId)) return false
        if (this.localRestoredIds.has(msgId)) return true
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
        const msgId = this.msgId(m)
        if (this.localTrashedIds.has(msgId)) return true
        if (this.localRestoredIds.has(msgId)) return false
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
  private localTrashedIds = new Set<number>();
  private localRestoredIds = new Set<number>();
  
  private saveTrashState() {
    try {
      fs.writeFileSync(TRASH_DATA_PATH, JSON.stringify({
        trashed: Array.from(this.localTrashedIds),
        restored: Array.from(this.localRestoredIds)
      }))
    } catch(e) { console.error('Failed to save trash state', e) }
  }
  
  private loadTrashState() {
    try {
      if (fs.existsSync(TRASH_DATA_PATH)) {
        const data = JSON.parse(fs.readFileSync(TRASH_DATA_PATH, 'utf-8'))
        if (Array.isArray(data.trashed)) this.localTrashedIds = new Set(data.trashed)
        if (Array.isArray(data.restored)) this.localRestoredIds = new Set(data.restored)
      }
    } catch(e) { console.error('Failed to load trash state', e) }
  }

  async trashFile(messageId: number) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    this.localTrashedIds.add(messageId)
    this.localRestoredIds.delete(messageId)
    this.saveTrashState()
    try {
      const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
      if (!messages || messages.length === 0) return
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
    } catch (e) {
      console.warn('Telegram API rejected edit for trash, falling back to local memory:', e)
    }
  }

  async restoreFile(messageId: number) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    this.localTrashedIds.delete(messageId)
    this.localRestoredIds.add(messageId)
    this.saveTrashState()
    try {
      const messages = await this.client.getMessages(this.channelId as any, { ids: [messageId] })
      if (!messages || messages.length === 0) return
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
    } catch (e) {
      console.warn('Telegram API rejected edit for restore, falling back to local memory:', e)
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
    this.localTrashedIds.delete(messageId)
    this.saveTrashState()
    await this.client.deleteMessages(this.channelId as any, idsToDelete, { revoke: true })
  }

  async permanentDeleteBatch(messageIds: number[]) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const BATCH = 100
    for (let i = 0; i < messageIds.length; i += BATCH) {
      const batch = messageIds.slice(i, i + BATCH)
      const messages = await this.client.getMessages(this.channelId as any, { ids: batch })
      const extraIds: number[] = []
      for (const m of (messages || [])) {
        const caption = m.message || ''
        const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)
        if (multipartMatch) extraIds.push(...multipartMatch[1].split(',').map(Number))
      }
      const allIds = [...batch, ...extraIds]
      for (const id of batch) this.localTrashedIds.delete(id)
      await this.client.deleteMessages(this.channelId as any, allIds, { revoke: true })
    }
    this.saveTrashState()
  }

  async cleanupGhosts() {
    if (!this.client || !this.channelId) return { success: false, error: 'Not initialized' }
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

      const claimedChunkIds = new Set<number>()
      const trashIds = new Set<number>()
      const knownIds = new Set<number>()

      for (const m of messages) {
        if (!m.file || m.message === TelegramService.STATE_CAPTION) continue
        const msgId = this.msgId(m)
        const caption: string = m.message || ''
        
        if (caption.includes('#chunk_of')) continue
        
        knownIds.add(msgId)
        
        const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)
        if (multipartMatch) {
          multipartMatch[1].split(',').map(Number).forEach(id => claimedChunkIds.add(id))
        }

        const escapedMarker = this.TRASH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (caption.match(new RegExp(`${escapedMarker}(\\d+)`)) || this.localTrashedIds.has(msgId)) {
          trashIds.add(msgId)
        }
      }

      const idsToDelete = new Set<number>()

      for (const m of messages) {
        if (m.message === TelegramService.STATE_CAPTION) continue
        const msgId = this.msgId(m)
        const caption: string = m.message || ''

        if (caption.includes('#chunk_of')) {
          if (!claimedChunkIds.has(msgId)) idsToDelete.add(msgId)
        } else if (trashIds.has(msgId)) {
          idsToDelete.add(msgId)
          const multipartMatch = caption.match(/#multipart\s+([\d,]+)/)
          if (multipartMatch) {
            multipartMatch[1].split(',').map(Number).forEach(id => idsToDelete.add(id))
          }
        }
      }

      if (idsToDelete.size > 0) {
        const arr = Array.from(idsToDelete)
        for (let i = 0; i < arr.length; i += 100) {
          await this.client.deleteMessages(this.channelId as any, arr.slice(i, i + 100), { revoke: true })
        }
      }
      
      this.localTrashedIds.clear()
      this.saveTrashState()

      return { success: true, deletedCount: idsToDelete.size }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
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

    const cacheDir = path.join(app.getPath('userData'), 'thumb-cache')
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
    const cachePath = path.join(cacheDir, `${messageId}.jpg`)
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
    } else {
      const ext = fileName ? path.extname(fileName).toLowerCase() : ''
      if (ext === '.heic' || ext === '.heif') {
        if (!this.heavyThumbQueue.find(t => t.messageId === messageId)) {
          this.heavyThumbQueue.push({ messageId, message, cachePath })
          this.processHeavyThumbQueue()
        }
      }
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

  async syncFolders(data: { folders: any[]; fileFolders: Record<string, string>; botToken?: string }) {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')
    const payload = TelegramService.SYNC_PREFIX + JSON.stringify(data)

    // Split payload into chunks of 4000 chars to respect Telegram's limit
    const chunks: string[] = []
    for (let i = 0; i < payload.length; i += 4000) {
      chunks.push(payload.slice(i, i + 4000))
    }

    if (chunks.length === 1) {
      // Try cached ID first — edit it, but still search+cleanup duplicates
      let editedViaCache = false
      if (!this.folderSyncId) this.folderSyncId = this.loadFolderSyncId()
      if (this.folderSyncId) {
        try {
          await this.client.editMessage(this.channelId as any, { message: this.folderSyncId, text: chunks[0], formattingEntities: [] } as any)
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
          await this.client.editMessage(this.channelId as any, { message: this.folderSyncId, text: chunks[0], formattingEntities: [] } as any)
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
        const sent: any = await this.client.sendMessage(this.channelId as any, { message: chunks[0], formattingEntities: [] } as any)
        this.saveFolderSyncId(this.msgId(sent))
      }
    } else {
      // Payload is too large, send as multiple new messages. We do NOT use editMessage for chunks.
      // Delete old sync messages first
      if (!this.folderSyncId) this.folderSyncId = this.loadFolderSyncId()
      if (this.folderSyncId) {
        try {
          await this.client.invoke(new Api.channels.DeleteMessages({ channel: this.channelId as any, id: [this.folderSyncId] }))
        } catch {}
        this.folderSyncId = null
      }
      
      const msgs = await this.client.getMessages(this.channelId as any, { limit: 200 } as any)
      const syncMsgs: any[] = []
      for (const m of msgs) {
        if (m.message && this.parseSyncMessage(m.message)) syncMsgs.push(m)
      }
      if (syncMsgs.length > 0) {
        const dupeIds = syncMsgs.map((m: any) => this.msgId(m))
        try {
          await this.client.invoke(new Api.channels.DeleteMessages({ channel: this.channelId as any, id: dupeIds }))
        } catch {}
      }

      // Send the chunks sequentially
      let firstMsgId: number | null = null
      for (const chunk of chunks) {
        const sent: any = await this.client.sendMessage(this.channelId as any, { message: chunk, formattingEntities: [] } as any)
        if (!firstMsgId) firstMsgId = this.msgId(sent)
      }
      if (firstMsgId) {
        this.saveFolderSyncId(firstMsgId)
      }
    }
  }

  private debugLog(msg: string) {
    const logPath = path.join(app.getPath('userData'), 'folder-sync-debug.log')
    const line = `[${new Date().toISOString()}] ${msg}\n`
    try { fs.appendFileSync(logPath, line) } catch {}
  }

  async loadFoldersFromChannel(): Promise<{ folders: any[]; fileFolders: Record<string, string>; botToken?: string } | null> {
    if (!this.client || !this.channelId) throw new Error('Client not initialized or channel not found')

    this.debugLog('loadFoldersFromChannel called')

    // Search backwards until we find the latest sync message
    let offsetId = 0
    let foundSyncMsg: any = null
    const BATCH = 100
    const textMsgs: any[] = []

    while (true) {
      const batch = await this.client.getMessages(this.channelId as any, {
        limit: BATCH,
        ...(offsetId ? { offsetId } : {}),
      })
      if (batch.length === 0) break

      for (const m of batch) {
        if (m.message && !m.file) {
          textMsgs.push(m)
        }
      }

      for (let i = 0; i < textMsgs.length; i++) {
        const m = textMsgs[i]
        if (m.message && (m.message.startsWith('rf') || m.message.startsWith('RFSYNC:'))) {
          let concatenated = m.message
          let parsed = this.parseSyncMessage(concatenated)

          if (!parsed) {
            for (let j = i - 1; j >= 0; j--) {
              concatenated += textMsgs[j].message
              parsed = this.parseSyncMessage(concatenated)
              if (parsed) break
            }
          }

          if (parsed) {
            foundSyncMsg = { message: concatenated, id: m.id }
            break
          }
        }
      }
      if (foundSyncMsg) break

      offsetId = this.msgId(batch[batch.length - 1])
    }

    if (!foundSyncMsg) {
      this.debugLog('NO sync message found!')
      return null
    }

    const msgs = [foundSyncMsg] // We only need the latest one since it contains the full state
    this.debugLog('Found sync message id=' + this.msgId(foundSyncMsg))
    const allFolders: any[] = []
    const allFileFolders: Record<string, string> = {}
    const seenFolderIds = new Set<string>()
    const seenFileIds = new Set<string>()
    let botToken: string | undefined = undefined
    let newestSyncId: number | null = null

    for (const m of msgs) {
      const id = this.msgId(m)
      const parsed = this.parseSyncMessage(m.message)
      if (!parsed) continue
      this.debugLog('FOUND sync id=' + id + ' folders=' + (parsed.data?.folders?.length ?? 0))

      if (!botToken && parsed.data?.botToken) {
        botToken = parsed.data.botToken
      }

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
      
      if (newestSyncId === null) newestSyncId = id
    }

    if (newestSyncId !== null) {
      this.saveFolderSyncId(newestSyncId)
      this.debugLog('Merged result: ' + allFolders.length + ' folders, ' + Object.keys(allFileFolders).length + ' file mappings')
      return { folders: allFolders, fileFolders: allFileFolders, botToken }
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


  private async fetchExistingBotToken(botUsername: string): Promise<string | null> {
    const botFather = await this.client!.getEntity('BotFather') as any
    await this.client!.sendMessage(botFather, { message: '/mybots', silent: true } as any)
    
    let mybotsMsg: any = null;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const msgs = await this.client!.getMessages(botFather, { limit: 2 }) as any[]
      const m = msgs.find(x => x.message?.includes('Choose a bot from the list below') || x.message?.includes('You have no bots'))
      if (m) { mybotsMsg = m; break; }
    }
    if (!mybotsMsg || !mybotsMsg.replyMarkup) return null

    let botData: Buffer | null = null;
    for (const row of mybotsMsg.replyMarkup.rows) {
      for (const btn of row.buttons) {
        if (btn.text === '@' + botUsername && btn.data) { botData = Buffer.from(btn.data); break; }
      }
    }
    if (!botData) return null;

    await this.client!.invoke(new Api.messages.GetBotCallbackAnswer({ peer: botFather, msgId: mybotsMsg.id, data: botData }))

    let detailsMsg: any = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const msgs = await this.client!.getMessages(botFather, { limit: 2 }) as any[]
      const m = msgs.find(x => x.message?.includes('Choose what to do with the bot'))
      if (m) { detailsMsg = m; break; }
    }
    if (!detailsMsg || !detailsMsg.replyMarkup) return null

    let tokenData: Buffer | null = null;
    for (const row of detailsMsg.replyMarkup.rows) {
      for (const btn of row.buttons) {
        if (btn.text.includes('API Token') && btn.data) { tokenData = Buffer.from(btn.data); break; }
      }
    }
    if (!tokenData) return null;

    await this.client!.invoke(new Api.messages.GetBotCallbackAnswer({ peer: botFather, msgId: detailsMsg.id, data: tokenData }))

    let tokenMsg: any = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const msgs = await this.client!.getMessages(botFather, { limit: 2 }) as any[]
      const m = msgs.find(x => x.message?.includes('Use this token to access the HTTP API'))
      if (m) { tokenMsg = m; break; }
    }
    if (!tokenMsg) return null;

    const match = tokenMsg.message.match(/[0-9]{8,10}:[a-zA-Z0-9_-]{35,}/)
    return match ? match[0] : null
  }


  async findExistingBot(): Promise<{ token: string; username: string } | null> {
    if (!this.client || !this.channelId) return null
    try {
      const botFather = await this.client.getEntity('BotFather') as any
      if (!botFather) return null

      await this.client.sendMessage(botFather, { message: '/mybots', silent: true } as any)
      let mybotsMsg: any = null
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const msgs = await this.client!.getMessages(botFather, { limit: 2 }) as any[]
        const m = msgs.find(x => x.message?.includes('Choose a bot from the list below') || x.message?.includes('You have no bots'))
        if (m) { mybotsMsg = m; break }
      }
      if (!mybotsMsg || !mybotsMsg.replyMarkup) return null

      let orphanedBot: string | null = null
      for (const row of mybotsMsg.replyMarkup.rows) {
        for (const btn of row.buttons) {
          if (btn.text.startsWith('@rodjercloud_') && btn.text.endsWith('_bot')) {
            orphanedBot = btn.text.slice(1)
            break
          }
        }
        if (orphanedBot) break
      }
      if (!orphanedBot) return null

      const token = await this.fetchExistingBotToken(orphanedBot)
      if (!token) return null
      await this.addBotToChannel(orphanedBot)
      return { token, username: orphanedBot }
    } catch {
      return null
    }
  }

  async findBotInChannel(): Promise<string | null> {
    if (!this.client || !this.channelId) { shareLog('not initialized'); return null }
    try {
      shareLog('channelId: ' + String(this.channelId))
      // Try multiple participant filters
      const filters = [
        { name: 'admins', f: new Api.ChannelParticipantsAdmins() },
        { name: 'recent', f: new Api.ChannelParticipantsRecent() },
        { name: 'search', f: new Api.ChannelParticipantsSearch('') },
      ]
      for (const { name, f } of filters) {
        shareLog('trying filter: ' + name)
        try {
          const participants = await this.client.invoke(
            new Api.channels.GetParticipants({
              channel: this.channelId as any,
              filter: f,
              offset: 0,
              limit: 50,
              hash: 0,
            })
          ) as any
          shareLog(name + ' count: ' + (participants?.count ?? '?') + ' users: ' + (participants?.users?.length ?? 0))
          const bot = participants?.users?.find((u: any) => u.bot)
          if (bot) {
            shareLog('bot found: ' + (bot.username || bot.id?.toString()))
            return bot.username || null
          }
        } catch (e) {
          shareLog(name + ' error: ' + (e as Error).message)
        }
      }
      shareLog('no bot found with any filter')
      return null
    } catch (e) {
      shareLog('unexpected error: ' + (e as Error).message)
      return null
    }
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

    const existingBot = await this.findBotInChannel()
    if (existingBot) {
      const existingToken = await this.fetchExistingBotToken(existingBot)
      if (existingToken) {
        return { token: existingToken, username: existingBot }
      }
    }

    // Try to reuse any orphaned bot via BotFather
    const reused = await this.findExistingBot()
    if (reused) return reused

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

  async addBotToChannel(botUsername: string) {
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

  async reAddBotToChannel(botToken: string) {
    if (!this.client || !this.channelId) { console.error('[reAddBot] not initialized'); throw new Error('Not initialized') }
    const botId = botToken.split(':')[0]
    console.log('[reAddBot] botId:', botId, 'channelId:', String(this.channelId))

    let botEntity: any
    try {
      botEntity = await this.client.getEntity(Number(botId)) as any
      console.log('[reAddBot] got bot entity:', botEntity?.username || botEntity?.id?.toString())
    } catch (e) {
      console.error('[reAddBot] getEntity failed for botId', botId, ':', (e as Error).message)
      return
    }

    try {
      await this.client.invoke(
        new Api.channels.InviteToChannel({
          channel: this.channelId as any,
          users: [botEntity],
        } as any)
      )
      console.log('[reAddBot] inviteToChannel succeeded')
    } catch (e) {
      console.error('[reAddBot] inviteToChannel failed:', (e as Error).message)
    }

    try {
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
      console.log('[reAddBot] editAdmin succeeded')
    } catch (e) {
      console.error('[reAddBot] editAdmin failed:', (e as Error).message)
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
