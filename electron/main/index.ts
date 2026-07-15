import { app, BrowserWindow, ipcMain, dialog, clipboard, screen, shell, protocol, net } from 'electron'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as https from 'https'
import * as zlib from 'zlib'
import * as crypto from 'crypto'
import * as path from 'path'
import { ZipArchive } from 'archiver'
import { TelegramService } from './telegram-service'
import { StorageService } from './storage-service'
import { AutoSyncService } from './auto-sync-service'
import { BotService } from './bot-service'
import { vaultService } from './vault-service'
import { startVideoStreamServer } from './video-stream-server'

app.commandLine.appendSwitch('disable-features', 'FontationsFontBackend')
app.commandLine.appendSwitch('enable-transparent-visuals')

if (process.env.NODE_ENV === 'development') {
  process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'
}

// Logger
const logFile = path.join(app.getPath('userData'), 'rodjercloud.log')
function log(level: string, msg: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`
  try { fs.appendFileSync(logFile, line) } catch(e) {}
}

let mainWindow: BrowserWindow | null = null

const previewSessions = new Map<string, { files: any[]; idx: number; dir: string }>()
let previewIdSeq = 0
function nextPreviewId(): number {
  if (previewIdSeq >= Number.MAX_SAFE_INTEGER - 1) previewIdSeq = 0
  return ++previewIdSeq
}
const telegramService = new TelegramService()
const storageService = new StorageService()
const autoSyncService = new AutoSyncService(telegramService)
const botService = new BotService()
botService.loadToken()
let initialFolderSyncDone = false

autoSyncService.setEventCallback((event) => {
  if (mainWindow) {
    mainWindow.webContents.send('autosync:status', event)
    if (event.type === 'uploaded' || event.type === 'failed') {
      appendSyncHistory({ timestamp: Date.now(), fileName: event.file || '', status: event.type, size: 0 }).catch(() => {})
    }
  }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#00000000', // transparent for Mica to show through
    autoHideMenuBar: true,
    transparent: true,
    backgroundMaterial: 'mica',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, '../preload/index.js')
    },
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden'
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  mainWindow.webContents.on('console-message', (_e, level, msg) => {
    const lvl = ['verbose','info','warning','error'][level] || 'info'
    log(lvl, '[renderer] ' + msg)
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

let _githubToken = process.env.GITHUB_TOKEN || ''
async function githubFetch(path: string): Promise<any> {
  if (!_githubToken) {
    const prefs = await readPrefs()
    _githubToken = prefs.githubToken || ''
  }
  return new Promise<any>((resolve, reject) => {
    const opts: any = {
      headers: { 'User-Agent': 'RodjerCloud', 'Accept': 'application/vnd.github.v3+json' },
    }
    if (_githubToken) opts.headers['Authorization'] = `token ${_githubToken}`
    https.get(`https://api.github.com${path}`, opts, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function checkUpdate() {
  try {
    const current = app.getVersion()
    const res = await githubFetch(`/repos/${GITHUB_REPO}/releases/latest`)
    const tag = (res.tag_name || '').replace(/^v/, '')
    if (tag && isNewer(tag, current)) {
      const matchFn = platformAssetPattern()
      const asset = (res.assets || []).find((a: any) => matchFn(a.name))
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) wins[0].webContents.send('app:update-available', {
        version: tag,
        assetId: asset?.id || 0,
        assetName: asset?.name || '',
        htmlUrl: res.html_url || '',
      })
    }
  } catch {}
}

app.whenReady().then(async () => {
  createWindow()

  autoSyncService.loadTracker()
  const prefs = await readPrefs()
  if (prefs.autoSync) autoSyncService.updateConfig(prefs.autoSync)
  if (prefs.autoSync?.enabled) autoSyncService.start()
  telegramService.startTrashCleanup()
  telegramService.cleanThumbnailCache()
  try {
    const previewCache = path.join(app.getPath('userData'), 'preview-cache')
    if (fs.existsSync(previewCache)) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      for (const file of fs.readdirSync(previewCache)) {
        try {
          const fp = path.join(previewCache, file)
          const stat = fs.statSync(fp)
          if (stat.mtimeMs < cutoff) fs.unlinkSync(fp)
        } catch {}
      }
    }
  } catch {}
  startVideoStreamServer(telegramService)

  // Background duplicate scan at startup
  setTimeout(() => {
    botService.scanChannel(telegramService, (p) => {
      mainWindow?.webContents.send('bot:scan-progress', p)
    }).catch(() => {})
  }, 10000)

  setTimeout(checkUpdate, 15000)
  setInterval(checkUpdate, 3600000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  autoSyncService.stop()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => { autoSyncService.stop() })

// --- Window Controls ---
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize() })
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close() })

// ===== V2 prefs file helpers =====
let prefsLock: Promise<void> = Promise.resolve()
async function withPrefsLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = prefsLock
  let resolve: () => void
  prefsLock = new Promise(r => { resolve = r })
  await prev
  try { return await fn() } finally { resolve!() }
}

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'rodjercloud-prefs.json')
}
async function readPrefs(): Promise<any> {
  try {
    const p = prefsPath()
    if (!fs.existsSync(p)) return {}
    const data = await fs.promises.readFile(p, 'utf8')
    return JSON.parse(data)
  } catch { return {} }
}
async function writePrefs(prefs: any): Promise<void> {
  await fs.promises.writeFile(prefsPath(), JSON.stringify(prefs, null, 2), 'utf8')
}
function historyPath(): string {
  return path.join(app.getPath('userData'), 'rodjercloud-sync-history.json')
}
async function appendSyncHistory(entry: any): Promise<void> {
  try {
    let arr: any[] = []
    if (fs.existsSync(historyPath())) {
      arr = JSON.parse(fs.readFileSync(historyPath(), 'utf8'))
    }
    arr.unshift(entry)
    if (arr.length > 1000) arr = arr.slice(0, 1000)
    fs.writeFileSync(historyPath(), JSON.stringify(arr), 'utf8')
  } catch (e) { console.error('sync history append failed', e) }
}

// ===== Auth IPC =====
ipcMain.handle('telegram:check-session', async () => {
  try {
    const session = await storageService.getSession()
    return { success: true, hasSession: !!session }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('vault:has-password', async () => {
  return vaultService.hasPassword()
})

ipcMain.handle('vault:is-unlocked', async () => {
  return vaultService.loadPassword()
})

ipcMain.handle('vault:set-password', async (_, password: string) => {
  vaultService.setPassword(password)
  return true
})

ipcMain.handle('vault:check-password', async (_, password: string) => {
  return vaultService.checkPassword(password)
})

ipcMain.handle('telegram:login', async (_, phoneNumber: string) => {
  try {
    const result = await telegramService.startAuth(phoneNumber)
    return { success: true, data: result }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:verify-code', async (_, code: string) => {
  try {
    const result = await telegramService.verifyCode(code)
    if (result.success) {
      const sessionString = telegramService.getSessionString()
      const channelResult = await telegramService.createPrivateChannel()
      await storageService.saveSession(sessionString)
      if (!botService.getToken()) {
        try {
          const botResult = await telegramService.createBotAndAddToChannel()
          botService.setToken(botResult.token)
        } catch (e) {
          log('warn', 'Bot creation failed (non-fatal): ' + (e as Error).message)
        }
      }
      return { success: true, data: channelResult }
    }
    return result
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:verify-2fa', async (_, password: string) => {
  try {
    const result = await telegramService.verify2FA(password)
    if (result.success) {
      const sessionString = telegramService.getSessionString()
      const channelResult = await telegramService.createPrivateChannel()
      await storageService.saveSession(sessionString)
      if (!botService.getToken()) {
        try {
          const botResult = await telegramService.createBotAndAddToChannel()
          botService.setToken(botResult.token)
        } catch (e) {
          log('warn', 'Bot creation failed (non-fatal): ' + (e as Error).message)
        }
      }
      return { success: true, data: channelResult }
    }
    return result
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:reconnect', async () => {
  try {
    const sessionData = await storageService.getSession()
    if (!sessionData) return { success: false, error: 'No session found' }
    const result = await telegramService.reconnect(sessionData.session)
    if (!botService.getToken()) {
      try {
        const botResult = await telegramService.createBotAndAddToChannel()
        botService.setToken(botResult.token)
        log('info', 'Bot created automatically after reconnect')
      } catch (e) {
        log('warn', 'Bot creation after reconnect failed (non-fatal): ' + (e as Error).message)
      }
    }
    await telegramService.createCloudFolder()
    return { success: true, data: result }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:get-user-info', async () => {
  try {
    const info = await telegramService.getUserInfo()
    return { success: true, data: info }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

// ===== Upload queue =====
type UploadJob = { id: string; filePath: string; encrypt?: boolean; customFileName?: string; event: { sender: { send: (c: string, d: any) => void } } }
const uploadQueue: UploadJob[] = []
let activeUploads = 0
async function getConcurrency(): Promise<number> {
  const p = await readPrefs()
  const c = parseInt(String(p.uploadConcurrency || 2), 10)
  return Math.min(5, Math.max(1, isNaN(c) ? 2 : c))
}
async function processQueue() {
  const limit = await getConcurrency()
  while (activeUploads < limit && uploadQueue.length > 0) {
    const job = uploadQueue.shift()!
    activeUploads++
    runUpload(job).finally(() => { activeUploads--; processQueue() })
  }
}
async function runUpload(job: UploadJob): Promise<void> {
  try {
    let lastPct = -1
    const sendProgress = (sent: number, total: number) => {
      const pct = total > 0 ? Math.floor((sent / total) * 100) : 0
      if (pct <= lastPct) return
      lastPct = pct
      try {
        job.event.sender.send('telegram:upload-progress', { id: job.id, sent, total, percent: pct })
      } catch {}
    }
    sendProgress(0, 1)
    const result = await telegramService.uploadFile(job.filePath, (sent, total) => {
      sendProgress(sent, total)
    }, job.encrypt, job.customFileName)
    sendProgress(result.fileSize, result.fileSize)
    job.event.sender.send('telegram:upload-complete', { id: job.id, success: true, data: result })
  } catch (error) {
    job.event.sender.send('telegram:upload-complete', { id: job.id, success: false, error: (error as Error).message })
  }
}

ipcMain.handle('telegram:upload-file', async (event, filePath: string, id?: string, encrypt?: boolean, customFileName?: string) => {
  try {
    const jobId = id || Math.random().toString(36).slice(2)
    return await new Promise((resolve) => {
      uploadQueue.push({ id: jobId, filePath, encrypt, customFileName, event: {
        sender: {
          send: (channel: string, data: any) => {
            event.sender.send(channel, data)
            if (channel === 'telegram:upload-complete' && data.id === jobId) {
              resolve(data.success ? { success: true, data: data.data } : { success: false, error: data.error })
            }
          }
        }
      }})
      processQueue()
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folder:archive-and-upload', async (event, options: {
  folderPath?: string
  folderName?: string
  files?: Array<{ messageId: number; fileName: string }>
}) => {
  const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'rodjercloud-archive-'))
  try {
    const name = options.folderName || (options.folderPath ? path.basename(options.folderPath) : 'archive')
    const archivePath = path.join(tmpDir, `${name}.zip`)
    const downloadDir = path.join(tmpDir, 'files')
    fs.mkdirSync(downloadDir, { recursive: true })

    let totalFiles = 0

    if (options.files && options.files.length > 0) {
      totalFiles = options.files.length
      try { event.sender.send('archive-progress', { percent: 0, phase: 'downloading' }) } catch {}
      for (let i = 0; i < options.files.length; i++) {
        const f = options.files[i]
        const r = await telegramService.downloadFile(f.messageId, f.fileName)
        if (r?.filePath) {
          const dest = path.join(downloadDir, f.fileName)
          fs.copyFileSync(r.filePath, dest)
        }
        const p = Math.min(100, Math.floor(((i + 1) / options.files.length) * 100))
        try { event.sender.send('archive-progress', { percent: p, phase: 'downloading' }) } catch {}
      }
    }

    if (options.folderPath) {
      function walkDir(dir: string): string[] {
        const out: string[] = []
        const items = fs.readdirSync(dir, { withFileTypes: true })
        for (const item of items) {
          const full = path.join(dir, item.name)
          if (item.isDirectory()) out.push(...walkDir(full))
          else if (item.isFile()) out.push(full)
        }
        return out
      }
      const allFiles = walkDir(options.folderPath)
      totalFiles = allFiles.length
    }

    // Create archive
    try { event.sender.send('archive-progress', { percent: 0, phase: 'compressing' }) } catch {}
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(archivePath)
      const archive = new ZipArchive({ zlib: { level: 9 } })
      let archiveCount = 0

      output.on('close', () => resolve())
      archive.on('error', (err) => reject(err))

      archive.on('entry', () => {
        archiveCount++
        if (totalFiles > 0) {
          const p = Math.min(99, Math.floor((archiveCount / totalFiles) * 100))
          try { event.sender.send('archive-progress', { percent: p, phase: 'compressing' }) } catch {}
        }
      })

      archive.pipe(output)

      if (options.folderPath) {
        archive.directory(options.folderPath, name)
      } else if (options.files) {
        for (const f of options.files) {
          const fp = path.join(downloadDir, f.fileName)
          if (fs.existsSync(fp)) archive.file(fp, { name: f.fileName })
        }
      }

      archive.finalize()
    })

    try { event.sender.send('archive-progress', { percent: 0, phase: 'uploading' }) } catch {}

    // Upload archive with progress
    const result = await telegramService.uploadFile(archivePath, (sent, total) => {
      const p = total > 0 ? Math.floor((sent / total) * 100) : 0
      if (p >= 0 && p <= 100) {
        try { event.sender.send('archive-progress', { percent: p, phase: 'uploading', sent, total }) } catch {}
      }
    })

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }) } catch {}

    return { success: true, data: { ...result, archiveName: `${name}.zip` } }
  } catch (error) {
    try { fs.rmSync(tmpDir, { recursive: true }) } catch {}
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:list-files', async () => {
  try {
    const files = await telegramService.listFiles()
    return { success: true, data: files }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:download-file', async (_, messageId: number, fileName: string) => {
  try {
    const prefs = await readPrefs()
    if (prefs.askDownloadPath) {
      const result = await dialog.showSaveDialog({
        title: 'Сохранить файл',
        defaultPath: path.join(app.getPath('downloads'), fileName),
      })
      if (result.canceled) return { success: false, error: 'cancelled' }
      const filePath = result.filePath
      await telegramService.downloadMediaToPath(messageId, filePath)
      return { success: true, data: { filePath, fileName } }
    }
    const result = await telegramService.downloadFile(messageId, fileName)
    return { success: true, data: result }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:download-thumbnail', async (_, messageId: number, fileName?: string) => {
  try {
    const filePath = await telegramService.downloadThumbnail(messageId, fileName)
    return { success: true, data: filePath }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:cache-audio', async (_, messageId: number, fileName: string) => {
  try {
    const audioCacheDir = path.join(app.getPath('userData'), 'audio-cache')
    if (!fs.existsSync(audioCacheDir)) fs.mkdirSync(audioCacheDir, { recursive: true })
    const cachePath = await telegramService.cacheAudio(messageId, fileName, audioCacheDir)
    const data = fs.readFileSync(cachePath)
    const ext = path.extname(fileName).toLowerCase()
    const mime: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac', '.ogg': 'audio/ogg' }
    return { success: true, data: { base64: data.toString('base64'), mime: mime[ext] || 'audio/mpeg', fileName } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:delete-file', async (_, messageId: number) => {
  try {
    await telegramService.trashFile(messageId)
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:list-trash', async () => {
  try {
    const data = await telegramService.listTrash()
    return { success: true, data }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:restore-file', async (_, messageId: number) => {
  try {
    await telegramService.restoreFile(messageId)
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:perm-delete-file', async (_, messageId: number) => {
  try {
    await telegramService.permanentDelete(messageId)
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:logout', async () => {
  try {
    await telegramService.logout()
    await storageService.clearSession()
    autoSyncService.stop()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

// ===== Dialog handlers =====
ipcMain.handle('dialog:pick-file', async () => {
  try {
    const result = await dialog.showOpenDialog({ title: 'Select a file to upload', properties: ['openFile'] })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { success: false, error: 'No file selected' }
    const filePath = result.filePaths[0]
    const stat = fs.statSync(filePath)
    return { success: true, data: { filePath, fileName: path.basename(filePath), fileSize: stat.size } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('dialog:pick-multiple-files', async () => {
  try {
    const result = await dialog.showOpenDialog({ title: 'Select files to upload', properties: ['openFile', 'multiSelections'] })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { success: false, error: 'No files selected' }
    const files = result.filePaths.map((filePath: string) => {
      const stat = fs.statSync(filePath)
      return { filePath, fileName: path.basename(filePath), fileSize: stat.size }
    })
    return { success: true, data: files }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('dialog:pick-folder', async () => {
  try {
    const result = await dialog.showOpenDialog({ title: 'Select folder to sync', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { success: false, error: 'No folder selected' }
    return { success: true, data: { folderPath: result.filePaths[0] } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

// ===== V2 handlers =====
function walkDir(dir: string, exclude: string[] = []): string[] {
  const out: string[] = []
  const items = fs.readdirSync(dir, { withFileTypes: true })
  for (const item of items) {
    const full = path.join(dir, item.name)
    if (exclude.some(p => full.includes(p))) continue
    if (item.isDirectory()) out.push(...walkDir(full, exclude))
    else if (item.isFile()) out.push(full)
  }
  return out
}

ipcMain.handle('dialog:pick-folder-recursive', async () => {
  try {
    const result = await dialog.showOpenDialog({ title: 'Select folder to upload', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { success: false, error: 'No folder selected' }
    const folder = result.filePaths[0]
    const exclude = ['node_modules', '.git', '.DS_Store']
    const all = walkDir(folder, exclude)
    const files = all.map(fp => {
      const stat = fs.statSync(fp)
      return { filePath: fp, fileName: path.basename(fp), fileSize: stat.size }
    })
    return { success: true, data: { folderPath: folder, files } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:bulk-download', async (event, items: Array<{ messageId: number; fileName: string }>) => {
  const prefs = await readPrefs()
  let destDir: string | null = null
  if (prefs.askDownloadPath) {
    const result = await dialog.showOpenDialog({
      title: 'Выберите папку для загрузки',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return { success: false, error: 'cancelled' }
    destDir = result.filePaths[0]
  }
  const results: any[] = []
  for (let i = 0; i < items.length; i++) {
    try {
      let r
      if (destDir) {
        const filePath = path.join(destDir, items[i].fileName)
        await telegramService.downloadMediaToPath(items[i].messageId, filePath)
        r = { filePath, fileName: items[i].fileName }
      } else {
        r = await telegramService.downloadFile(items[i].messageId, items[i].fileName)
      }
      results.push({ success: true, data: r })
    } catch (e) { results.push({ success: false, error: (e as Error).message }) }
    event.sender.send('telegram:bulk-progress', { kind: 'download', index: i + 1, total: items.length })
  }
  return { success: true, data: results }
})

ipcMain.handle('telegram:bulk-delete', async (event, messageIds: number[]) => {
  const results: any[] = []
  for (let i = 0; i < messageIds.length; i++) {
    try { await telegramService.trashFile(messageIds[i]); results.push({ success: true }) }
    catch (e) { results.push({ success: false, error: (e as Error).message }) }
    event.sender.send('telegram:bulk-progress', { kind: 'delete', index: i + 1, total: messageIds.length })
  }
  return { success: true, data: results }
})

ipcMain.handle('app:copy-to-clipboard', async (_, text: string) => {
  try { clipboard.writeText(text); return { success: true } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:get-download-path', async () => {
  try {
    const prefs = await readPrefs()
    return { success: true, data: prefs.downloadPath || app.getPath('downloads') }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:set-download-path', async (_, p: string) => {
  try {
    return await withPrefsLock(async () => {
      const prefs = await readPrefs(); prefs.downloadPath = p; await writePrefs(prefs)
      return { success: true }
    })
  }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:get-upload-concurrency', async () => {
  try { const prefs = await readPrefs(); return { success: true, data: prefs.uploadConcurrency || 2 } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:set-upload-concurrency', async (_, n: number) => {
  try {
    return await withPrefsLock(async () => {
      const prefs = await readPrefs(); prefs.uploadConcurrency = Math.min(5, Math.max(1, n)); await writePrefs(prefs)
      return { success: true }
    })
  }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:get-turbo-mode', async () => {
  try { const prefs = await readPrefs(); return { success: true, data: prefs.turboMode || false } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:set-turbo-mode', async (_, val: boolean) => {
  try {
    return await withPrefsLock(async () => {
      const prefs = await readPrefs(); prefs.turboMode = val; await writePrefs(prefs)
      return { success: true }
    })
  }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:get-ask-download-path', async () => {
  try { const prefs = await readPrefs(); return { success: true, data: prefs.askDownloadPath || false } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:set-ask-download-path', async (_, val: boolean) => {
  try {
    return await withPrefsLock(async () => {
      const prefs = await readPrefs(); prefs.askDownloadPath = val; await writePrefs(prefs)
      return { success: true }
    })
  }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('app:get-version', async () => {
  try { return { success: true, data: app.getVersion() } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.on('app:log', (_, level: string, msg: string) => {
  log(level, '[renderer] ' + msg)
})

const GITHUB_REPO = 'RodjerYan/RodjerCloud'

function parseVersion(v: string): number[] {
  return (v || '').replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0)
}

function isNewer(latest: string, current: string): boolean {
  const lv = parseVersion(latest), cv = parseVersion(current)
  for (let i = 0; i < Math.max(lv.length, cv.length); i++) {
    if ((lv[i] || 0) > (cv[i] || 0)) return true
    if ((lv[i] || 0) < (cv[i] || 0)) return false
  }
  return false
}

function platformAssetPattern(): (name: string) => boolean {
  const plat = process.platform
  const arch = process.arch
  if (plat === 'darwin') {
    if (arch === 'arm64') return (n: string) => n.endsWith('-arm64.dmg') || n.endsWith('-arm64-mac.zip')
    return (n: string) => n.endsWith('.dmg') && !n.includes('-arm64') || n.endsWith('-mac.zip') && !n.includes('-arm64')
  }
  if (plat === 'win32') return (n: string) => n.endsWith('.exe') || n.endsWith('-win.zip')
  return () => false
}

ipcMain.handle('app:check-update', async () => {
  try {
    const currentVersion = app.getVersion()
    const res = await githubFetch(`/repos/${GITHUB_REPO}/releases/latest`)
    const tag = (res.tag_name || '').replace(/^v/, '')
    if (!tag) return { success: true, data: { hasUpdate: false } }
    const hasUpdate = isNewer(tag, currentVersion)
    const matchFn = platformAssetPattern()
    const asset = (res.assets || []).find((a: any) => matchFn(a.name))
    return {
      success: true,
      data: {
        hasUpdate,
        currentVersion,
        latestVersion: tag,
        releaseNotes: (res.body || '').slice(0, 2000),
        assetId: asset?.id || 0,
        assetName: asset?.name || '',
        htmlUrl: res.html_url || '',
      },
    }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

function downloadWithNet(event: any, url: string, destPath: string, accept?: string, _redirectCount = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath)
    fileStream.on('error', (err) => { reject(err) })

    const request = net.request({
      method: 'GET',
      url,
      headers: {
        'User-Agent': 'RodjerCloud',
        'Accept': accept || 'application/octet-stream',
        ...(_githubToken ? { 'Authorization': `token ${_githubToken}` } : {}),
      },
    })

    let total = 0
    let downloaded = 0
    let redirected = false

    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = String(response.headers['location'] || '')
        if (location) {
          redirected = true
          if (_redirectCount >= 5) {
            fileStream.destroy()
            fs.unlink(destPath, () => {})
            return reject(new Error('Too many redirects'))
          }
          fileStream.close()
          fs.unlink(destPath, () => {})
          return downloadWithNet(event, location, destPath, accept, _redirectCount + 1).then(resolve).catch(reject)
        }
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fileStream.destroy()
        fs.unlink(destPath, () => {})
        return reject(new Error(`HTTP ${response.statusCode}`))
      }

      total = parseInt(String(response.headers['content-length'] || '0'), 10)

      response.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        fileStream.write(chunk)
        event.sender.send('app:download-progress', {
          downloaded, total,
          percent: total ? Math.round(downloaded / total * 100) : 0,
        })
      })

      response.on('end', () => {
        if (!redirected) fileStream.end(() => resolve(total))
      })

      response.on('error', (err) => {
        if (!redirected) { fileStream.destroy(); fs.unlink(destPath, () => {}) }
        reject(err)
      })
    })

    request.on('error', (err) => {
      fileStream.destroy()
      fs.unlink(destPath, () => {})
      reject(err)
    })

    request.end()
  })
}

ipcMain.handle('app:download-update', async (event, assetId: number, _assetName?: string, _latestVersion?: string) => {
  try {
    const tempDir = app.getPath('temp')
    const destPath = path.join(tempDir, 'update.exe')
    // Use API URL to download — CDN URL may return 404
    const downloadUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${assetId}`
    await downloadWithNet(event, downloadUrl, destPath, 'application/octet-stream')
    return { success: true, data: { filePath: destPath, fileName: 'update.exe' } }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('app:install-update', async (_, filePath: string) => {
  try {
    const resolvedPath = path.resolve(filePath)
    const tempDir = app.getPath('temp')
    if (!resolvedPath.startsWith(tempDir)) {
      return { success: false, error: 'Invalid update path: must be in temp directory' }
    }
    if (!resolvedPath.endsWith('.exe') && !resolvedPath.endsWith('.dmg')) {
      return { success: false, error: 'Invalid update file type' }
    }
    const result = await shell.openPath(resolvedPath)
    if (result) {
      return { success: false, error: result }
    }
    app.quit()
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('storage:get-sync-history', async () => {
  try {
    if (!fs.existsSync(historyPath())) return { success: true, data: [] }
    const data = await fs.promises.readFile(historyPath(), 'utf8')
    return { success: true, data: JSON.parse(data) }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:append-sync-history', async (_, entry: any) => {
  try { await appendSyncHistory(entry); return { success: true } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:clear-sync-history', async () => {
  try { if (fs.existsSync(historyPath())) await fs.promises.unlink(historyPath()); return { success: true } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

let foldersLock: Promise<void> = Promise.resolve()
async function withFoldersLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = foldersLock
  let resolve: () => void
  foldersLock = new Promise(r => { resolve = r })
  await prev
  try { return await fn() } finally { resolve!() }
}

function foldersPath(): string {
  return path.join(app.getPath('userData'), 'rodjercloud-folders.json')
}
async function readFolders(): Promise<any> {
  try {
    if (!fs.existsSync(foldersPath())) return { folders: [], fileFolders: {} }
    const data = await fs.promises.readFile(foldersPath(), 'utf8')
    return JSON.parse(data)
  } catch { return { folders: [], fileFolders: {} } }
}
async function writeFolders(d: any) {
  await fs.promises.writeFile(foldersPath(), JSON.stringify(d, null, 2))
}

async function syncFoldersToTelegram() {
  try {
    const d = await readFolders()
    await telegramService.syncFolders(d)
  } catch (e) { log('error', 'syncFolders: ' + (e as Error).message) }
}

ipcMain.handle('folders:list', async () => {
  try { const d = await readFolders(); return { success: true, data: d } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:load-from-telegram', async () => {
  try {
    return await withFoldersLock(async () => {
      const data = await telegramService.loadFoldersFromChannel()
      if (data) {
        if (data.folders && data.fileFolders) await writeFolders(data)
        initialFolderSyncDone = true
        return { success: true, data }
      }
      const local = await readFolders()
      if (!initialFolderSyncDone && (local.folders.length > 0 || Object.keys(local.fileFolders).length > 0)) {
        try { await telegramService.syncFolders(local) } catch {}
        initialFolderSyncDone = true
      }
      return { success: true, data: local }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:create', async (_, name: string, parentId?: string) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      const id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
      d.folders.push({ id, name, parentId: parentId || null, createdAt: Math.floor(Date.now() / 1000) })
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true, data: d }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:rename', async (_, id: string, name: string) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      const f = d.folders.find((x: any) => x.id === id)
      if (!f) throw new Error('Folder not found')
      f.name = name
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true, data: d }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:delete', async (_, id: string) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      const idsToDelete = new Set<string>()
      const collect = (parentId: string) => {
        idsToDelete.add(parentId)
        d.folders.filter((x: any) => x.parentId === parentId).forEach((x: any) => collect(x.id))
      }
      collect(id)
      d.folders = d.folders.filter((x: any) => !idsToDelete.has(x.id))
      Object.keys(d.fileFolders).forEach(k => { if (idsToDelete.has(d.fileFolders[k])) delete d.fileFolders[k] })
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true, data: d }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:add-file', async (_, folderId: string, messageId: number) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      d.fileFolders[messageId] = folderId
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:remove-file', async (_, messageId: number) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      delete d.fileFolders[messageId]
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:move-file', async (_, messageId: number, folderId: string | null) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      if (folderId) d.fileFolders[messageId] = folderId
      else delete d.fileFolders[messageId]
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:move-folder', async (_, folderId: string, parentId: string | null) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      const f = d.folders.find((x: any) => x.id === folderId)
      if (!f) throw new Error('Folder not found')
      if (folderId === parentId) throw new Error('Cannot move folder into itself')
      if (parentId) {
        let curr: string | null = parentId
        const visited = new Set<string>()
        while (curr) {
          if (curr === folderId) throw new Error('Cannot move folder into its own descendant')
          if (visited.has(curr)) break
          visited.add(curr)
          const p = d.folders.find((x: any) => x.id === curr)
          curr = p?.parentId || null
        }
      }
      f.parentId = parentId || null
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true, data: d }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('tgs:read', async (_, name?: string) => {
  try {
    const tgsPath = path.join(app.getAppPath(), 'resources', name || 'duck.tgs')
    if (!fs.existsSync(tgsPath)) return { success: false, error: 'File not found' }
    const compressed = fs.readFileSync(tgsPath)
    const decompressed = zlib.gunzipSync(compressed)
    return { success: true, data: JSON.parse(decompressed.toString('utf-8')) }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

function ensurePreviewCache(cachedPath: string): string {
  const ext = path.extname(cachedPath).toLowerCase()
  if (ext === '.heic' || ext === '.heif') {
    const jpgPath = cachedPath + '.jpg'
    if (!fs.existsSync(jpgPath)) {
      try {
        require('child_process').execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', cachedPath, '--out', jpgPath], { timeout: 15000 })
      } catch (e: any) {
        console.error('sips FAIL:', cachedPath, e.message)
      }
    }
    return jpgPath
  }
  return cachedPath
}

const previewWindows = new Map<number, BrowserWindow>()

ipcMain.handle('preview:open', async (_, files: any[], idx: number) => {
  try {
    const f = files[idx]
    if (!f) return { success: false, error: 'File not found' }
    
    
    const winId = nextPreviewId()
    const downloadDir = path.join(app.getPath('userData'), 'preview-cache')
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true })
    const cachedPath = path.join(downloadDir, `${f.messageId}_${f.fileName}`)
    

    previewSessions.set(winId.toString(), { files, idx, dir: downloadDir })

    const pw = new BrowserWindow({
      width: Math.min(1200, screen.getPrimaryDisplay().workAreaSize.width - 100),
      height: Math.min(800, screen.getPrimaryDisplay().workAreaSize.height - 100),
      minWidth: 400, minHeight: 300,
      backgroundColor: '#0a0a14',
      autoHideMenuBar: true,
      frame: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/index.js')
      }
    })
    previewWindows.set(winId, pw)
    pw.on('closed', () => { previewWindows.delete(winId); previewSessions.delete(winId.toString()) })

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Preview</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a14;height:100vh;overflow:hidden;user-select:none}
#loader{width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:#7c83ff;border-radius:50%;animation:spin .8s linear infinite;position:fixed;top:50%;left:50%;margin:-20px 0 0 -20px}
@keyframes spin{to{transform:rotate(360deg)}}
#top{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(180deg,rgba(0,0,0,0.6),transparent);z-index:10;-webkit-app-region:drag}
#top:hover{opacity:1}
#close{position:fixed;top:12px;right:16px;z-index:20;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.1);border:none;color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s;line-height:1;-webkit-app-region:no-drag}
#media{position:fixed;top:0;left:0;right:0;bottom:48px;display:flex;align-items:center;justify-content:center}
#media video,#media img{max-width:100%;max-height:100%;border-radius:4px}
#bar{position:fixed;bottom:0;left:0;right:0;z-index:20;background:rgba(10,10,20,0.92);display:none;align-items:center;gap:8px;padding:6px 12px;height:48px;border-top:1px solid rgba(255,255,255,0.06)}
#bar button{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:5px;padding:4px 10px;font:12px/1.2 sans-serif;cursor:pointer;white-space:nowrap;transition:background .15s}
#bar button:hover{background:rgba(255,255,255,0.18)}
#progress{flex:1;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;cursor:pointer;position:relative;margin:0 8px}
#progressFill{height:100%;background:#7c83ff;border-radius:3px;width:0%;pointer-events:none}
#time{font:11px/1 monospace;color:rgba(255,255,255,0.45);min-width:70px;text-align:center}
</style></head>
<body>
<div id="top"><span id="fname" style="color:#fff;font:13px/1 sans-serif;opacity:0.9">Загрузка...</span><span id="fpos" style="color:rgba(255,255,255,0.5);font:12px/1 sans-serif"></span></div>
<button id="close" onclick="window.electronAPI.preview.close(sid)">✕</button>
<div id="loader"></div>
<div id="media"></div>
<div id="error" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#f87171;font:14px/1.4 sans-serif;text-align:center;max-width:80%"></div>
<div id="bar"><button id="playBtn" onclick="togglePlay()">▶</button><div id="progress" onclick="seek(event)"><div id="progressFill"></div></div><span id="time">0:00 / 0:00</span><button id="speedBtn" onclick="cycleSpeed()">1x</button><button onclick="toggleFs()">⛶</button></div>
<script>
let sid = '${winId}'
let total = ${files.length}
let speed = 1
let video = null
function renderMedia(files, idx, src) {
  if (!files || !files[idx]) return
  const f = files[idx]
  const isVideo = ['mp4','mov','mkv','avi','webm'].includes((f.fileName||'').split('.').pop().toLowerCase())
  var ld = document.getElementById('loader'); if (ld && !isVideo) ld.style.display = 'none'
  var err = document.getElementById('error')
  var el = document.getElementById('media')
  if (src) {
    el.innerHTML = ''
    if (isVideo) {
      var vid = document.createElement('video')
      vid.id = 'pv'
      vid.src = src
      vid.autoplay = true
      vid.style.cssText = 'max-width:100%;max-height:100%;border-radius:4px'
      el.appendChild(vid)
    } else {
      var img = document.createElement('img')
      img.src = src
      img.draggable = false
      img.style.cssText = 'max-width:100%;max-height:100%;border-radius:4px'
      el.appendChild(img)
    }
    if (err) err.style.display = 'none'
  } else {
    if (err) { err.textContent = 'Не удалось загрузить файл\\n' + f.fileName; err.style.display = 'block' }
  }
  document.getElementById('fname').textContent = f.fileName
  document.getElementById('fpos').textContent = (idx + 1) + ' / ' + total
  if (isVideo) {
    video = document.getElementById('pv')
    document.getElementById('bar').style.display = 'flex'
    if (video) {
      video.playbackRate = speed
      video.ontimeupdate = update
      video.onloadedmetadata = function() { document.getElementById('time').textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration) }
      video.onplay = function() { document.getElementById('playBtn').textContent = '⏸' }
      video.onpause = function() { document.getElementById('playBtn').textContent = '▶' }
      video.onclick = function(e) { e.stopPropagation(); togglePlay() }
      video.onwaiting = function() { var ld = document.getElementById('loader'); if (ld) ld.style.display = 'block' }
      video.onplaying = function() { var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none' }
      video.oncanplay = function() { var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none' }
    }
  } else {
    document.getElementById('bar').style.display = 'none'; video = null
  }
}
function showError(msg) {
  var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'
  var err = document.getElementById('error'); if (err) { err.textContent = 'Ошибка: ' + msg; err.style.display = 'block' }
}
function togglePlay() { if (!video) return; if (video.paused) video.play(); else video.pause() }
function update() { if (!video||!video.duration) return; document.getElementById('progressFill').style.width = (video.currentTime/video.duration*100)+'%'; document.getElementById('time').textContent = fmt(video.currentTime)+' / '+fmt(video.duration) }
function seek(e) { if (!video||!video.duration) return; var r=e.currentTarget.getBoundingClientRect(); video.currentTime = ((e.clientX-r.left)/r.width)*video.duration }
function fmt(t) { if (!t||isNaN(t)) return '0:00'; var m=Math.floor(t/60),s=Math.floor(t%60); return m+':'+(s<10?'0':'')+s }
function cycleSpeed() { var a=[0.5,0.75,1,1.25,1.5,2]; var i=a.indexOf(speed); speed=a[(i+1)%a.length]; document.getElementById('speedBtn').textContent=speed+'x'; if(video) video.playbackRate=speed }
function toggleFs() { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen() }
function nav(dir) {
  document.getElementById('media').innerHTML = ''; video = null
  var ld = document.getElementById('loader'); if (ld) ld.style.display = 'block'
  try { window.electronAPI.preview.navigate(sid, dir).then(r => { if (r.success && r.data) renderMedia(r.data.files, r.data.idx, r.data.src) }) } catch(e) {}
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.electronAPI.preview.close(sid)
  if (e.key === 'ArrowLeft') nav(-1)
  if (e.key === 'ArrowRight') nav(1)
  if (e.key === ' ' && video) { e.preventDefault(); togglePlay() }
})
document.getElementById('media').onclick = function(e) {
  if (e.target.tagName === 'VIDEO' || e.target.tagName === 'IMG') return
  var w = window.innerWidth
  if (e.clientX < w * 0.3) nav(-1)
  else if (e.clientX > w * 0.7) nav(1)
}
// load first file
window.electronAPI.preview.getSession(sid).then(r => {
  if (r.success) {
    window.electronAPI.preview.load(sid).then(r2 => {
      if (r2.success) renderMedia(r2.data.files, r2.data.idx, r2.data.src)
      else showError(r2.error || 'load failed')
    }).catch(function(e) { showError('load error: ' + e.message) })
  } else {
    showError(r.error || 'session error')
  }
}).catch(function(e) { showError('init error: ' + e.message) })
// show close on mouse move, hide after idle
var closeTimer = null
document.addEventListener('mousemove', function() {
  document.getElementById('close').style.opacity = '1'
  clearTimeout(closeTimer)
  closeTimer = setTimeout(function() { document.getElementById('close').style.opacity = '0' }, 2000)
})
</script></body></html>`

    const tmpDir = app.getPath('temp')
    const tmpFile = path.join(tmpDir, `preview-${winId}.html`)
    fs.writeFileSync(tmpFile, html, 'utf-8')
    pw.loadFile(tmpFile)
    pw.show()

    const ext = (f.fileName || '').split('.').pop()?.toLowerCase() || ''
    const isVideo = ['mp4','mov','mkv','avi','webm'].includes(ext)

    if (isVideo && !f.isEncrypted) {
      // Skip download for unencrypted video, we will stream it
    } else {
      // start download in background - window.load IPC will wait for it
      if (!fs.existsSync(cachedPath)) {
        telegramService.downloadMediaToPath(f.messageId, cachedPath).then(() => {
          ensurePreviewCache(cachedPath)
        }).catch(e => console.error('download failed', e))
      } else {
        ensurePreviewCache(cachedPath)
      }
    }

    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('preview:load', async (_, sessionId: string) => {
  try {
    const s = previewSessions.get(sessionId)
    if (!s) return { success: false, error: 'Session not found' }
    const f = s.files[s.idx]
    const ext = (f.fileName || '').split('.').pop()?.toLowerCase() || ''
    const isVideo = ['mp4','mov','mkv','avi','webm'].includes(ext)
    const heicSuffix = !isVideo && ['heic','heif'].includes(ext) ? '.jpg' : ''
    const cachedPath = path.join(s.dir, `${f.messageId}_${f.fileName}`) + heicSuffix
    
    
    let src = ''
    if (isVideo && !f.isEncrypted) {
      src = `http://127.0.0.1:14300/stream/${f.messageId}`
    } else {
      // wait for the file to exist (poll up to 30s)
      for (let i = 0; i < 60; i++) {
        if (fs.existsSync(cachedPath)) break
        await new Promise(r => setTimeout(r, 500))
      }
      const exists = fs.existsSync(cachedPath)
      
      if (exists) {
        const ext2 = path.extname(cachedPath).toLowerCase()
        const isVid = ['mp4','mov','mkv','avi','webm'].includes(ext2)
        if (isVid) {
          src = 'file:///' + encodeURI(cachedPath.replace(/\\/g, '/').replace(/^\//, ''))
        } else {
          const buf = fs.readFileSync(cachedPath)
          src = `data:image/jpeg;base64,${buf.toString('base64')}`
        }
      }
    }
    return { success: true, data: { files: s.files, idx: s.idx, src } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('preview:get-session', async (_, sessionId: string) => {
  try {
    const s = previewSessions.get(sessionId)
    if (!s) return { success: false, error: 'Session not found' }
    return { success: true, data: { files: s.files, idx: s.idx } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('preview:navigate', async (_, sessionId: string, dir: number) => {
  try {
    const s = previewSessions.get(sessionId)
    if (!s) return { success: false, error: 'Session not found' }
    const all = s.files.filter((f: any) => {
      const ext = (f.fileName || '').split('.').pop()?.toLowerCase() || ''
      return ['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','mp4','mov','mkv','avi','webm'].includes(ext)
    })
    if (all.length === 0) return { success: false, error: 'No previewable files' }
    const currInAll = all.findIndex((x: any) => x === s.files[s.idx])
    const next = (currInAll + dir + all.length) % all.length
    const nextFile = all[next]
    const nextIdx = s.files.indexOf(nextFile)
    s.idx = nextIdx
    const cachedPath = path.join(s.dir, `${nextFile.messageId}_${nextFile.fileName}`)
    if (!fs.existsSync(cachedPath)) {
      try {
        await (telegramService as any).downloadMediaToPath(nextFile.messageId, cachedPath)
      } catch(e) { console.error('nav download failed', e) }
    }
    ensurePreviewCache(cachedPath)
    const ext = (nextFile.fileName || '').split('.').pop()?.toLowerCase() || ''
    const isVideo = ['mp4','mov','mkv','avi','webm'].includes(ext)
    const heicSuffix = !isVideo && ['heic','heif'].includes(ext) ? '.jpg' : ''
    const displayPath = cachedPath + heicSuffix
    let src = ''
    if (fs.existsSync(displayPath)) {
      src = 'file:///' + encodeURI(displayPath.replace(/\\/g, '/').replace(/^\//, ''))
    }
    return { success: true, data: { files: s.files, idx: s.idx, src } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('file:read-data-url', async (_, filePath: string) => {
  try {
    const resolvedPath = path.resolve(filePath)
    const allowedDirs = [app.getPath('userData'), app.getPath('temp'), app.getPath('downloads')]
    if (!allowedDirs.some(dir => resolvedPath.startsWith(dir))) {
      return { success: false, error: 'Access denied: path outside allowed directories' }
    }
    if (!fs.existsSync(resolvedPath)) return { success: false, error: 'File not found' }
    const data = fs.readFileSync(resolvedPath)
    const ext = path.extname(filePath).toLowerCase()
    const mime: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
    }
    return { success: true, data: `data:${mime[ext] || 'image/jpeg'};base64,${data.toString('base64')}` }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('file:get-local-url', async (_, filePath: string) => {
  try {
    const resolvedPath = path.resolve(filePath)
    const allowedDirs = [app.getPath('userData'), app.getPath('temp'), app.getPath('downloads')]
    if (!allowedDirs.some(dir => resolvedPath.startsWith(dir))) {
      return { success: false, error: 'Access denied: path outside allowed directories' }
    }
    if (!fs.existsSync(resolvedPath)) return { success: false, error: 'File not found' }
    let finalPath = resolvedPath
    const ext = path.extname(resolvedPath).toLowerCase()
    if (ext === '.heic' || ext === '.heif') {
      const jpgPath = filePath + '.jpg'
      let needsConversion = !fs.existsSync(jpgPath)
      if (!needsConversion) {
        const stat = fs.statSync(jpgPath)
        if (stat.size < 10000) needsConversion = true // Fix for old corrupted 3.5KB sips outputs
      }
      
      if (needsConversion) {
        try {
          if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath)
          const inputBuffer = fs.readFileSync(filePath)
          
          if (inputBuffer.length > 2 && inputBuffer[0] === 0xFF && inputBuffer[1] === 0xD8 && inputBuffer[2] === 0xFF) {
            fs.writeFileSync(jpgPath, inputBuffer)
          } else {
            if (process.platform === 'darwin') {
              require('child_process').execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', filePath, '--out', jpgPath], { timeout: 15000 })
            } else {
              const heicConvert = require('heic-convert')
              const outputBuffer = await heicConvert({
                buffer: inputBuffer,
                format: 'JPEG',
                quality: 0.8
              })
              fs.writeFileSync(jpgPath, Buffer.from(outputBuffer))
            }
          }
        } catch (e: any) {
          console.error('HEIC convert FAIL for thumbnail:', filePath, e.message)
        }
      }
      finalPath = jpgPath
    }
    return { success: true, data: 'file:///' + encodeURI(finalPath.replace(/\\/g, '/').replace(/^\//, '')) }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.on('preview:close', (_, sessionId: string) => {
  const id = parseInt(sessionId, 10)
  if (!id) return
  const win = previewWindows.get(id)
  if (win && !win.isDestroyed()) win.close()
})

ipcMain.handle('dialog:pick-download-dir', async () => {
  try {
    const result = await dialog.showOpenDialog({ title: 'Select default download folder', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { success: false, error: 'No folder selected' }
    return { success: true, data: { folderPath: result.filePaths[0] } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:test-upload', async () => {
  try {
    const result = await dialog.showOpenDialog({ title: 'Выберите файл для тестовой загрузки', properties: ['openFile'] })
    if (result.canceled || !result.filePaths?.length) return { success: false, error: 'Отменено' }
    const filePath = result.filePaths[0]
    const fileResult = await telegramService.uploadFile(filePath)
    return { success: true, data: { ...fileResult, localPath: filePath } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:factory-reset', async () => {
  try {
    await storageService.clearSession()
    if (fs.existsSync(prefsPath())) fs.unlinkSync(prefsPath())
    if (fs.existsSync(historyPath())) fs.unlinkSync(historyPath())
    autoSyncService.stop()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

// ===== Auto-sync IPC =====
async function saveAutoSyncConfig() {
  const prefs = await readPrefs()
  prefs.autoSync = autoSyncService.getConfig()
  await writePrefs(prefs)
}

ipcMain.handle('autosync:get-config', async () => {
  try {
    return { success: true, data: autoSyncService.getConfig() }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:update-config', async (_, config: any) => {
  try {
    autoSyncService.updateConfig(config)
    await saveAutoSyncConfig()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:start', async () => {
  try {
    await autoSyncService.start()
    await saveAutoSyncConfig()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:stop', async () => {
  try {
    autoSyncService.stop()
    await saveAutoSyncConfig()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:get-status', async () => {
  try {
    return { success: true, data: autoSyncService.getStatus() }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:scan-now', async () => {
  try {
    const result = await autoSyncService.scanNow()
    return { success: true, data: result }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:count-files', async () => {
  try {
    const count = autoSyncService.countFiles()
    return { success: true, data: { count } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:get-log', async () => {
  try {
    return { success: true, data: autoSyncService.getLog(100) }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:get-queue', async () => {
  try {
    return { success: true, data: autoSyncService.getQueue() }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('autosync:reset-uploaded', async () => {
  try {
    autoSyncService.resetTracker()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

// ===== Share / Bot link IPC =====
ipcMain.handle('share:set-bot-token', async (_, token: string) => {
  try {
    botService.setToken(token)
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('share:get-bot-token', async () => {
  try {
    return { success: true, data: botService.getToken() }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('share:generate-link', async (_, messageId: number, channelId: string, originalFileName?: string) => {
  try {
    const result = await botService.generateLink(telegramService, messageId, channelId, originalFileName)
    return { success: true, data: result }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('share:ensure-bot', async () => {
  try {
    if (botService.getToken()) return { success: true, data: { created: false } }
    const existingBot = await telegramService.findBotInChannel()
    if (existingBot) {
      return { success: false, error: `Bot @${existingBot} уже есть в канале. Получи токен: @BotFather → /mybots → ${existingBot} → API Token` }
    }
    const botResult = await telegramService.createBotAndAddToChannel()
    botService.setToken(botResult.token)
    return { success: true, data: { created: true, username: botResult.username } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('bot:get-hash-db', async () => {
  try {
    return { success: true, data: botService.getHashDb() }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('bot:get-duplicate-groups', async () => {
  try {
    return { success: true, data: botService.getDuplicateGroups() }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('bot:scan-duplicates', async (event) => {
  try {
    const onProgress = (p: any) => event.sender.send('bot:scan-progress', p)
    const result = await botService.scanChannel(telegramService, onProgress)
    return { success: true, data: result }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('share:download-file', async (_, url: string, fileName: string) => {
  try {
    const downloadsPath = app.getPath('downloads')
    let filePath = path.join(downloadsPath, fileName)
    let suffix = 1
    const ext = path.extname(fileName)
    const base = path.basename(fileName, ext)
    while (fs.existsSync(filePath)) {
      const name = `${base} (${suffix})${ext}`
      filePath = path.join(downloadsPath, name)
      suffix++
    }
    const result = await downloadAndSave(url, filePath)
    shell.showItemInFolder(filePath)
    return { success: true, data: { filePath } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('state:sync', async (_, jsonStr: string) => {
  try {
    await telegramService.syncState(jsonStr)
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('state:load', async () => {
  try {
    const data = await telegramService.loadStateFromChannel()
    return { success: true, data }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('file:compute-hash', async (_, messageId: number) => {
  try {
    const tmpFile = await telegramService.downloadMediaToTemp(messageId)
    const hash = await new Promise<string>((resolve, reject) => {
      const h = crypto.createHash('sha256')
      const stream = fs.createReadStream(tmpFile)
      stream.on('data', chunk => h.update(chunk))
      stream.on('end', () => resolve(h.digest('hex')))
      stream.on('error', reject)
    })
    fs.rmSync(tmpFile, { force: true })
    return { success: true, data: hash }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

function downloadAndSave(url: string, destPath: string): Promise<{ success: true; data: { filePath: string } }> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed with status ${res.statusCode}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => {
        file.close()
        resolve({ success: true, data: { filePath: destPath } })
      })
    }).on('error', (err) => {
      fs.unlink(destPath, () => {})
      reject(err)
    })
  })
}
