import { app, BrowserWindow, ipcMain, dialog, clipboard, screen, shell } from 'electron'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as https from 'https'
import * as http from 'http'
import * as zlib from 'zlib'
import * as crypto from 'crypto'
import * as pathMod from 'path'
import path from 'path'
import { ZipArchive } from 'archiver'
import { TelegramService } from './telegram-service'
import { StorageService } from './storage-service'
import { AutoSyncService } from './auto-sync-service'
import { BotService } from './bot-service'


// Logger
const logFile = pathMod.join(app.getPath('userData'), 'rodjercloud.log')
function log(level: string, msg: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`
  try { fs.appendFileSync(logFile, line) } catch(e) {}
}

let mainWindow: BrowserWindow | null = null

const previewSessions = new Map<string, { files: any[]; idx: number; dir: string }>()
let previewIdSeq = 0
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
    backgroundColor: '#0a0a14',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js')
    },
    frame: true,
    titleBarStyle: 'default'
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
    try {
      const gc = fs.readFileSync(pathMod.join(os.homedir(), '.git-credentials'), 'utf8')
      const m = gc.match(/https:\/\/[^:]+:([^@]+)@github\.com/)
      if (m) _githubToken = m[1]
    } catch {}
    if (!_githubToken) {
      const prefs = await readPrefs()
      _githubToken = prefs.githubToken || ''
    }
    if (!_githubToken) {
      try {
        _githubToken = execSync('gh auth token', { encoding: 'utf8', timeout: 5000 }).trim()
      } catch {}
    }
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

// ===== V2 prefs file helpers =====
function prefsPath(): string {
  return pathMod.join(app.getPath('userData'), 'rodjercloud-prefs.json')
}
async function readPrefs(): Promise<any> {
  try {
    const p = prefsPath()
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { return {} }
}
async function writePrefs(prefs: any): Promise<void> {
  fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2), 'utf8')
}
function historyPath(): string {
  return pathMod.join(app.getPath('userData'), 'rodjercloud-sync-history.json')
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
interface UploadJob { id: string; filePath: string; event: any }
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
    })
    sendProgress(result.fileSize, result.fileSize)
    job.event.sender.send('telegram:upload-complete', { id: job.id, success: true, data: result })
  } catch (error) {
    job.event.sender.send('telegram:upload-complete', { id: job.id, success: false, error: (error as Error).message })
  }
}

ipcMain.handle('telegram:upload-file', async (event, filePath: string, id?: string) => {
  try {
    const jobId = id || Math.random().toString(36).slice(2)
    return await new Promise((resolve) => {
      uploadQueue.push({ id: jobId, filePath, event: {
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
  const tmpDir = fs.mkdtempSync(pathMod.join(app.getPath('temp'), 'rodjercloud-archive-'))
  try {
    const name = options.folderName || (options.folderPath ? pathMod.basename(options.folderPath) : 'archive')
    const archivePath = pathMod.join(tmpDir, `${name}.zip`)
    const downloadDir = pathMod.join(tmpDir, 'files')
    fs.mkdirSync(downloadDir, { recursive: true })

    let totalFiles = 0

    if (options.files && options.files.length > 0) {
      totalFiles = options.files.length
      try { event.sender.send('archive-progress', { percent: 0, phase: 'downloading' }) } catch {}
      for (let i = 0; i < options.files.length; i++) {
        const f = options.files[i]
        const r = await telegramService.downloadFile(f.messageId, f.fileName)
        if (r?.filePath) {
          const dest = pathMod.join(downloadDir, f.fileName)
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
          const full = pathMod.join(dir, item.name)
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
          const fp = pathMod.join(downloadDir, f.fileName)
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
        defaultPath: pathMod.join(app.getPath('downloads'), fileName),
        file: fileName,
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

ipcMain.handle('telegram:download-thumbnail', async (_, messageId: number) => {
  try {
    const filePath = await telegramService.downloadThumbnail(messageId)
    return { success: true, data: filePath }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:cache-audio', async (_, messageId: number, fileName: string) => {
  try {
    const audioCacheDir = pathMod.join(app.getPath('userData'), 'audio-cache')
    if (!fs.existsSync(audioCacheDir)) fs.mkdirSync(audioCacheDir, { recursive: true })
    const cachePath = await telegramService.cacheAudio(messageId, fileName, audioCacheDir)
    const data = fs.readFileSync(cachePath)
    const ext = pathMod.extname(fileName).toLowerCase()
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
    return { success: true, data: { filePath, fileName: pathMod.basename(filePath), fileSize: stat.size } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('dialog:pick-multiple-files', async () => {
  try {
    const result = await dialog.showOpenDialog({ title: 'Select files to upload', properties: ['openFile', 'multiSelections'] })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { success: false, error: 'No files selected' }
    const files = result.filePaths.map((filePath: string) => {
      const stat = fs.statSync(filePath)
      return { filePath, fileName: pathMod.basename(filePath), fileSize: stat.size }
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
    const full = pathMod.join(dir, item.name)
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
      return { filePath: fp, fileName: pathMod.basename(fp), fileSize: stat.size }
    })
    return { success: true, data: { folderPath: folder, files } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:bulk-download', async (event, items: Array<{ messageId: number; fileName: string }>) => {
  const results: any[] = []
  for (let i = 0; i < items.length; i++) {
    try {
      const r = await telegramService.downloadFile(items[i].messageId, items[i].fileName)
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
  try { const prefs = await readPrefs(); prefs.downloadPath = p; await writePrefs(prefs); return { success: true } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:get-upload-concurrency', async () => {
  try { const prefs = await readPrefs(); return { success: true, data: prefs.uploadConcurrency || 2 } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:set-upload-concurrency', async (_, n: number) => {
  try { const prefs = await readPrefs(); prefs.uploadConcurrency = Math.min(5, Math.max(1, n)); await writePrefs(prefs); return { success: true } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:get-ask-download-path', async () => {
  try { const prefs = await readPrefs(); return { success: true, data: prefs.askDownloadPath || false } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:set-ask-download-path', async (_, val: boolean) => {
  try { const prefs = await readPrefs(); prefs.askDownloadPath = val; await writePrefs(prefs); return { success: true } }
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

function downloadFile(event: any, url: string, destPath: string, redirects = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'))
    const mod = url.startsWith('https') ? https : http
    const dlHeaders: any = { 'User-Agent': 'RodjerCloud', 'Accept': 'application/octet-stream' }
    if (_githubToken) dlHeaders['Authorization'] = `token ${_githubToken}`
    const req = mod.get(url, { headers: dlHeaders }, (res: any) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return downloadFile(event, res.headers.location, destPath, redirects + 1).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0
      const fileStream = fs.createWriteStream(destPath)
      res.pipe(fileStream)
      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        event.sender.send('app:download-progress', { downloaded, total, percent: total ? Math.round(downloaded / total * 100) : 0 })
      })
      res.on('end', () => { fileStream.end(() => resolve(total)) })
    })
    req.on('error', (err: Error) => { fs.unlink(destPath, () => {}); reject(err) })
  })
}

ipcMain.handle('app:download-update', async (event, assetId: number) => {
  try {
    const tempDir = app.getPath('temp')
    const destPath = pathMod.join(tempDir, 'update.exe')
    const downloadUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${assetId}`
    await downloadFile(event, downloadUrl, destPath)
    return { success: true, data: { filePath: destPath, fileName: 'update.exe' } }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('app:install-update', async (_, filePath: string) => {
  try {
    try {
      fs.writeFileSync(filePath + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=0\r\n', 'utf8')
    } catch {}
    const result = await shell.openPath(filePath)
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
    return { success: true, data: JSON.parse(fs.readFileSync(historyPath(), 'utf8')) }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:append-sync-history', async (_, entry: any) => {
  try { await appendSyncHistory(entry); return { success: true } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('storage:clear-sync-history', async () => {
  try { if (fs.existsSync(historyPath())) fs.unlinkSync(historyPath()); return { success: true } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

function foldersPath(): string {
  return pathMod.join(app.getPath('userData'), 'rodjercloud-folders.json')
}
function readFolders(): any { try { if (!fs.existsSync(foldersPath())) return { folders: [], fileFolders: {} }; return JSON.parse(fs.readFileSync(foldersPath(), 'utf8')) } catch { return { folders: [], fileFolders: {} } } }
function writeFolders(d: any) { fs.writeFileSync(foldersPath(), JSON.stringify(d, null, 2)) }

async function syncFoldersToTelegram() {
  try {
    const d = readFolders()
    await telegramService.syncFolders(d)
  } catch (e) { log('error', 'syncFolders: ' + (e as Error).message) }
}

ipcMain.handle('folders:list', async () => {
  try { const d = readFolders(); return { success: true, data: d } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:load-from-telegram', async () => {
  try {
    const data = await telegramService.loadFoldersFromChannel()
    if (data) {
      if (data.folders && data.fileFolders) writeFolders(data)
      initialFolderSyncDone = true
      return { success: true, data }
    }
    const local = readFolders()
    if (!initialFolderSyncDone && (local.folders.length > 0 || Object.keys(local.fileFolders).length > 0)) {
      try { await telegramService.syncFolders(local) } catch {}
      initialFolderSyncDone = true
    }
    return { success: true, data: local }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:create', async (_, name: string) => {
  try {
    const d = readFolders()
    const id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
    d.folders.push({ id, name, createdAt: Math.floor(Date.now() / 1000) })
    writeFolders(d)
    await syncFoldersToTelegram()
    return { success: true, data: d }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:rename', async (_, id: string, name: string) => {
  try {
    const d = readFolders(); const f = d.folders.find((x: any) => x.id === id)
    if (!f) throw new Error('Folder not found'); f.name = name; writeFolders(d)
    await syncFoldersToTelegram()
    return { success: true, data: d }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:delete', async (_, id: string) => {
  try {
    const d = readFolders(); d.folders = d.folders.filter((x: any) => x.id !== id)
    Object.keys(d.fileFolders).forEach(k => { if (d.fileFolders[k] === id) delete d.fileFolders[k] })
    writeFolders(d)
    await syncFoldersToTelegram()
    return { success: true, data: d }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:add-file', async (_, folderId: string, messageId: number) => {
  try {
    const d = readFolders(); d.fileFolders[messageId] = folderId; writeFolders(d)
    await syncFoldersToTelegram()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:remove-file', async (_, messageId: number) => {
  try {
    const d = readFolders(); delete d.fileFolders[messageId]; writeFolders(d)
    await syncFoldersToTelegram()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:move-file', async (_, messageId: number, folderId: string) => {
  try {
    const d = readFolders(); d.fileFolders[messageId] = folderId; writeFolders(d)
    await syncFoldersToTelegram()
    return { success: true }
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

function toFileUrl(p: string): string {
  return 'file:///' + p.replace(/\\/g, '/')
}

const previewWindows = new Map<number, BrowserWindow>()

ipcMain.handle('preview:open', async (_, files: any[], idx: number) => {
  try {
    const f = files[idx]
    if (!f) return { success: false, error: 'File not found' }
    const winId = ++previewIdSeq
    const downloadDir = pathMod.join(app.getPath('userData'), 'preview-cache')
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true })
    const cachedPath = pathMod.join(downloadDir, `${f.messageId}_${f.fileName}`)

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
#bar{position:fixed;bottom:0;left:0;right:0;z-index:20;background:rgba(10,10,20,0.92);display:flex;align-items:center;gap:8px;padding:6px 12px;height:48px;border-top:1px solid rgba(255,255,255,0.06)}
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
<div id="bar"><button id="playBtn" onclick="togglePlay()">▶</button><div id="progress" onclick="seek(event)"><div id="progressFill"></div></div><span id="time">0:00 / 0:00</span><button id="speedBtn" onclick="cycleSpeed()">1x</button><button onclick="toggleFs()">⛶</button></div>
<script>
let sid = '${winId}'
let total = ${files.length}
let baseUrl = '${toFileUrl(downloadDir)}/'
let speed = 1
let video = null
function renderMedia(files, idx) {
  if (!files || !files[idx]) return
  const f = files[idx]
  const isVideo = ['mp4','mov','mkv','avi','webm'].includes((f.fileName||'').split('.').pop().toLowerCase())
  const src = baseUrl + f.messageId + '_' + f.fileName
  var el = document.getElementById('media')
  var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'
  el.innerHTML = isVideo
    ? '<video id="pv" src="' + src + '" autoplay style="max-width:100%;max-height:100%;border-radius:4px"></video>'
    : '<img src="' + src + '" draggable="false" style="max-width:100%;max-height:100%;border-radius:4px">'
  document.getElementById('fname').textContent = f.fileName
  document.getElementById('fpos').textContent = (idx + 1) + ' / ' + total
  if (isVideo) {
    video = document.getElementById('pv')
    document.getElementById('bar').style.display = 'flex'
    video.playbackRate = speed
    video.ontimeupdate = update
    video.onloadedmetadata = function() { document.getElementById('time').textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration) }
    video.onplay = function() { document.getElementById('playBtn').textContent = '⏸' }
    video.onpause = function() { document.getElementById('playBtn').textContent = '▶' }
    video.onclick = function(e) { e.stopPropagation(); togglePlay() }
  } else {
    document.getElementById('bar').style.display = 'none'; video = null
  }
}
function togglePlay() { if (!video) return; if (video.paused) video.play(); else video.pause() }
function update() { if (!video||!video.duration) return; document.getElementById('progressFill').style.width = (video.currentTime/video.duration*100)+'%'; document.getElementById('time').textContent = fmt(video.currentTime)+' / '+fmt(video.duration) }
function seek(e) { if (!video||!video.duration) return; var r=e.currentTarget.getBoundingClientRect(); video.currentTime = ((e.clientX-r.left)/r.width)*video.duration }
function fmt(t) { if (!t||isNaN(t)) return '0:00'; var m=Math.floor(t/60),s=Math.floor(t%60); return m+':'+(s<10?'0':'')+s }
function cycleSpeed() { var a=[0.5,0.75,1,1.25,1.5,2]; var i=a.indexOf(speed); speed=a[(i+1)%a.length]; document.getElementById('speedBtn').textContent=speed+'x'; if(video) video.playbackRate=speed }
function toggleFs() { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen() }
function nav(dir) {
  document.getElementById('media').innerHTML = ''; video = null
  try { window.electronAPI.preview.navigate(sid, dir).then(r => { if (r.success && r.data) renderMedia(r.data.files, r.data.idx) }) } catch(e) {}
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
      if (r2.success) renderMedia(r2.data.files, r2.data.idx)
    })
  }
})
// show close on mouse move, hide after idle
var closeTimer = null
document.addEventListener('mousemove', function() {
  document.getElementById('close').style.opacity = '1'
  clearTimeout(closeTimer)
  closeTimer = setTimeout(function() { document.getElementById('close').style.opacity = '0' }, 2000)
})
</script></body></html>`

    const tmpDir = app.getPath('temp')
    const tmpFile = pathMod.join(tmpDir, `preview-${winId}.html`)
    fs.writeFileSync(tmpFile, html, 'utf-8')
    pw.loadFile(tmpFile)
    pw.show()

    // start download in background - window.load IPC will wait for it
    if (!fs.existsSync(cachedPath)) {
      telegramService.downloadFile(f.messageId, f.fileName).then(r => {
        if (r?.filePath) {
          // move to cache dir
          try {
            const destPath = pathMod.join(downloadDir, `${f.messageId}_${f.fileName}`)
            fs.copyFileSync(r.filePath, destPath)
          } catch(e) { console.error('move failed', e) }
        }
      }).catch(e => console.error('bg download failed', e))
    }

    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('preview:load', async (_, sessionId: string) => {
  try {
    const s = previewSessions.get(sessionId)
    if (!s) return { success: false, error: 'Session not found' }
    const f = s.files[s.idx]
    const cachedPath = pathMod.join(s.dir, `${f.messageId}_${f.fileName}`)
    // wait for the file to exist (poll up to 30s)
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(cachedPath)) break
      await new Promise(r => setTimeout(r, 500))
    }
    return { success: true, data: { files: s.files, idx: s.idx } }
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
      return ['jpg','jpeg','png','gif','webp','bmp','svg','mp4','mov','mkv','avi','webm'].includes(ext)
    })
    if (all.length === 0) return { success: false, error: 'No previewable files' }
    const currInAll = all.findIndex((x: any) => x === s.files[s.idx])
    const next = (currInAll + dir + all.length) % all.length
    const nextFile = all[next]
    const nextIdx = s.files.indexOf(nextFile)
    s.idx = nextIdx
    const cachedPath = pathMod.join(s.dir, `${nextFile.messageId}_${nextFile.fileName}`)
    if (!fs.existsSync(cachedPath)) {
      const messages = await (telegramService as any).client.getMessages((telegramService as any).channelId, { ids: [nextFile.messageId] })
      if (messages && messages[0]?.file) {
        await (telegramService as any).client.downloadMedia(messages[0], { outputFile: cachedPath })
      }
    }
    return { success: true, data: { files: s.files, idx: s.idx } }
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
    const stat = fs.statSync(filePath)
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
    let filePath = pathMod.join(downloadsPath, fileName)
    let suffix = 1
    const ext = pathMod.extname(fileName)
    const base = pathMod.basename(fileName, ext)
    while (fs.existsSync(filePath)) {
      const name = `${base} (${suffix})${ext}`
      filePath = pathMod.join(downloadsPath, name)
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
    const buf = fs.readFileSync(tmpFile)
    const hash = crypto.createHash('sha256').update(buf).digest('hex')
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
