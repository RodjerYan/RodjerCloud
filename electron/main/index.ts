import { app, BrowserWindow, ipcMain, dialog, clipboard, screen, shell, protocol, net } from 'electron'
import { execSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as https from 'https'
import * as zlib from 'zlib'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type { FileHandle } from 'fs/promises'
import { ZipArchive } from 'archiver'
import { TelegramService } from './telegram-service'
import { StorageService } from './storage-service'
import { AutoSyncService } from './auto-sync-service'
import { BotService } from './bot-service'
import { vaultService } from './vault-service'
import { startVideoStreamServer } from './video-stream-server'
import { convertVideoToMp4, ffmpegLog } from './previewConverter'

app.commandLine.appendSwitch('disable-features', 'FontationsFontBackend')

// H3: custom scheme must be privileged BEFORE app.ready — otherwise <img src="local-file://…">
// can be blocked in the renderer (observed as 100% 🖼️ placeholders on macOS).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
])

if (process.env.NODE_ENV === 'development') {
  process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'
}

// Logger
const logFile = path.join(app.getPath('userData'), 'rodjercloud.log')
function log(level: string, msg: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`
  try { fs.appendFileSync(logFile, line) } catch(e) {}
}

// S2: main-process console.log с префиксом [upload] → rodjercloud.log.
// Раньше telegram-service писал только console.log (stdout), и при packaged-exe
// stage-логи upload-пайплайна терялись — невозможно было понять, где завис 0%.
try {
  const origLog = console.log.bind(console)
  console.log = (...args: unknown[]) => {
    origLog(...args)
    try {
      const s = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
      if (s.includes('[upload]')) log('info', s)
      // T-20260925-002 S3: [stream]-логи video-stream-server (slog) тоже должны
      // попадать в rodjercloud.log — иначе диагностика стрима невозможна.
      if (s.includes('[stream]')) log('info', s)
      // rework S3.1: [ffmpeg]-логи конвертации mov/mkv/avi → mp4 (previewConverter)
      if (s.includes('[ffmpeg]')) log('info', s)
    } catch {}
  }
} catch {}

let mainWindow: BrowserWindow | null = null

process.on('unhandledRejection', (reason: any) => {
  log('error', `[unhandledRejection] ${reason?.stack || reason?.message || String(reason)}`)
})
process.on('uncaughtException', (err: any) => {
  log('error', `[uncaughtException] ${err?.stack || err?.message || String(err)}`)
})
process.on('beforeExit', (code: number) => {
  log('warn', `[beforeExit] code=${code} activeUploads=${activeUploads} uploadsInProgress=${uploadsInProgress}`)
})
process.on('exit', (code: number) => {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [FATAL] [process.exit] code=${code} activeUploads=${activeUploads} uploadsInProgress=${uploadsInProgress} queueLen=${uploadQueue.length}\n`) } catch {}
})
process.on('SIGINT', () => { log('warn', '[SIGINT] received') })
process.on('SIGTERM', () => { log('warn', '[SIGTERM] received') })

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

// T-20260925-002 S2: раньше throttle ПОЛНОСТЬЮ дропал событие при <5000ms —
// последнее files:changed могло потеряться (renderer ждал его 3s debounce).
// Теперь: первое событие уходит сразу, остальные накапливаются (pendingFilesChanged)
// и гарантированно доставляются хвостовым таймером (debounce).
let lastFilesChangedSent = 0
let pendingFilesChanged = false
let filesChangedTailTimer: ReturnType<typeof setTimeout> | null = null
const FILES_CHANGED_THROTTLE_MS = 5000
function flushFilesChanged() {
  lastFilesChangedSent = Date.now()
  pendingFilesChanged = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('files:changed') } catch {}
  }
}
function sendFilesChanged() {
  const now = Date.now()
  const since = now - lastFilesChangedSent
  if (since >= FILES_CHANGED_THROTTLE_MS) {
    if (filesChangedTailTimer) { clearTimeout(filesChangedTailTimer); filesChangedTailTimer = null }
    flushFilesChanged()
    return
  }
  // внутри throttle-окна — запоминаем и ставим хвостовой таймер на остаток окна
  pendingFilesChanged = true
  if (filesChangedTailTimer) clearTimeout(filesChangedTailTimer)
  filesChangedTailTimer = setTimeout(() => {
    filesChangedTailTimer = null
    if (pendingFilesChanged) flushFilesChanged()
  }, FILES_CHANGED_THROTTLE_MS - since)
}

autoSyncService.setEventCallback((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('autosync:status', event)
    } catch {}
    if (event.type === 'uploaded') {
      sendFilesChanged()
      appendSyncHistory({ timestamp: Date.now(), fileName: event.file || '', status: event.type, size: 0 }).catch(() => {})
    }
    if (event.type === 'failed') {
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
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    transparent: false,
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

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('error', `[render-process-gone] reason=${details.reason} exitCode=${details.exitCode} activeUploads=${activeUploads}`)
  })

  mainWindow.webContents.on('unresponsive', async () => {
    log('error', `[unresponsive] renderer became unresponsive! activeUploads=${activeUploads}`)
    const mem = process.memoryUsage()
    log('error', `[unresponsive] main process: heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB`)
  })

  mainWindow.webContents.on('responsive', () => {
    log('warn', `[responsive] renderer became responsive again`)
  })

  mainWindow.on('close', () => {
    const stack = new Error().stack || ''
    log('warn', `[window.close] fired! activeUploads=${activeUploads} uploadsInProgress=${uploadsInProgress}\nStack: ${stack}`)
  })

  mainWindow.on('closed', () => {
    log('warn', `[window.closed] mainWindow set to null`)
    mainWindow = null
  })
}

const UPDATE_SERVER_URL = process.env.VITE_UPDATE_SERVER_URL || 'https://updater-proxy-rodjer1.vercel.app'

function netFetch(url: string, headers: Record<string, string> = {}, timeoutMs = 12000): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url })
    const timer = setTimeout(() => { req.abort(); reject(new Error('Network timeout')) }, timeoutMs)
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    req.on('response', (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => { clearTimeout(timer); resolve({ statusCode: res.statusCode || 0, data }) })
      res.on('error', (err: Error) => { clearTimeout(timer); reject(err) })
    })
    req.on('error', (err) => { clearTimeout(timer); reject(err) })
    req.end()
  })
}

// Pick release with the highest semver (not GitHub "latest" by date).
function pickMaxSemverRelease(list: any[]): any {
  if (!Array.isArray(list)) return null
  const candidates = list.filter((r: any) => r && r.tag_name && !r.draft && !r.prerelease)
  if (candidates.length === 0) return null
  let best = candidates[0]
  for (const r of candidates) {
    const a = parseVersion((r.tag_name || '').replace(/^v/, ''))
    const b = parseVersion((best.tag_name || '').replace(/^v/, ''))
    const n = Math.max(a.length, b.length)
    let cmp = 0
    for (let i = 0; i < n; i++) {
      const av = a[i] || 0, bv = b[i] || 0
      if (av !== bv) { cmp = av > bv ? 1 : -1; break }
    }
    if (cmp > 0) best = r
  }
  return best
}

async function fetchLatestRelease(): Promise<any> {
  const errors: string[] = []

  // Prefer max semver from the releases list — /releases/latest is by published_at, not semver.
  try {
    const { statusCode, data } = await netFetch(
      'https://api.github.com/repos/RodjerYan/RodjerCloud/releases?per_page=30',
      { 'Accept': 'application/vnd.github.v3+json' }
    )
    if (statusCode >= 400) throw new Error(`GitHub API ${statusCode}`)
    const parsed = JSON.parse(data)
    const best = pickMaxSemverRelease(parsed)
    if (best && best.tag_name) return best
    throw new Error('No suitable release in GitHub list')
  } catch (e: any) { errors.push('GitHub-list: ' + e.message) }

  try {
    const { statusCode, data } = await netFetch(
      'https://api.github.com/repos/RodjerYan/RodjerCloud/releases/latest',
      { 'Accept': 'application/vnd.github.v3+json' }
    )
    if (statusCode >= 400) throw new Error(`GitHub API ${statusCode}`)
    const parsed = JSON.parse(data)
    if (parsed && parsed.tag_name) return parsed
    throw new Error('No tag_name in GitHub response')
  } catch (e: any) { errors.push('GitHub-latest: ' + e.message) }

  try {
    const { statusCode, data } = await netFetch(`${UPDATE_SERVER_URL}/api/latest`, { 'Accept': 'application/json' })
    if (statusCode >= 400) throw new Error(`Proxy ${statusCode}`)
    const parsed = JSON.parse(data)
    if (parsed && Array.isArray(parsed)) {
      const best = pickMaxSemverRelease(parsed)
      if (best && best.tag_name) return best
    }
    if (parsed && parsed.tag_name) return parsed
    throw new Error('No tag_name in proxy response')
  } catch (e: any) { errors.push('Proxy: ' + e.message) }

  throw new Error('All update sources failed: ' + errors.join('; '))
}

async function checkUpdate() {
  try {
    const current = app.getVersion()
    const res = await fetchLatestRelease()
    const tag = (res.tag_name || '').replace(/^v/, '')
    log('info', `[update] current=${current} latest=${tag}`)
    if (tag && isNewer(tag, current)) {
      const matchFn = platformAssetPattern()
      const asset = findAssetForVersion(res.assets || [], tag, matchFn)
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0 && !wins[0].isDestroyed()) {
        try {
          wins[0].webContents.send('app:update-available', {
            version: tag,
            assetId: asset?.id || 0,
            assetName: asset?.name || '',
            htmlUrl: res.html_url || '',
            releaseNotes: (res.body || '').slice(0, 2000),
          })
        } catch {}
        log('info', `[update] sent to renderer: v${tag}`)
      }
    }
  } catch (e) {
    log('error', '[update] check failed: ' + (e as Error).message)
  }
}

app.whenReady().then(async () => {
  protocol.handle('local-file', (request) => {
    // H5: pathToFileURL safely escapes spaces (#, ?, %) in macOS "Application Support" paths.
    try {
      const u = new URL(request.url)
      const pathname = decodeURIComponent(u.pathname)
      let filePath: string
      if (process.platform === 'win32') {
        // local-file://C:/Users/... → host='C', pathname='/Users/...' (colon eaten)
        if (u.host && /^[A-Za-z]$/.test(u.host)) {
          filePath = `${u.host}:${pathname}`
        } else {
          // local-file:///C:/Users/... → pathname='/C:/Users/...'
          filePath = pathname.replace(/^\//, '')
        }
        if (!/^[A-Za-z]:[\\/]/.test(filePath)) {
          log('error', `[local-file] reject relative win path raw=${request.url} → ${filePath}`)
          return new Response('Bad path', { status: 400 })
        }
      } else {
        // darwin/linux: pathname already absolute '/Users/...'
        filePath = pathname
        if (!filePath.startsWith('/')) {
          log('error', `[local-file] reject non-abs posix raw=${request.url} → ${filePath}`)
          return new Response('Bad path', { status: 400 })
        }
      }
      const fileUrl = pathToFileURL(filePath).href
      log('info', `[local-file] raw=${request.url} → ${fileUrl}`)
      return net.fetch(fileUrl)
    } catch (e) {
      log('error', `[local-file] parse fail raw=${request.url} err=${(e as Error).message}`)
      return new Response('Bad URL', { status: 400 })
    }
  })

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
          if (stat.mtimeMs < cutoff) { fs.unlinkSync(fp); continue }
          // rework: purge poisoned .jpg (raw HEIC под именем .jpg) — без JPEG magic удаляем
          if (file.toLowerCase().endsWith('.jpg') && !isJpegFile(fp)) fs.unlinkSync(fp)
        } catch {}
      }
    }
  } catch {}
  startVideoStreamServer(telegramService)

  // Background duplicate scan deferred — runs on first file list instead
  // setTimeout(() => {
  //   botService.scanChannel(telegramService, (p) => {
  //     mainWindow?.webContents.send('bot:scan-progress', p)
  //   }).catch(() => {})
  // }, 10000)

  setTimeout(checkUpdate, 10000)
  setTimeout(checkUpdate, 30000)
  setInterval(checkUpdate, 3600000)

  let syncInterval = 3000
  let lastFileCount = -1
  let idleCycles = 0

  async function adaptiveSync() {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (uploadsInProgress) {
      setTimeout(adaptiveSync, 10000)
      return
    }
    try {
      const before = telegramService.getCachedFilesInstant().length
      await telegramService.syncFilesInBackground()
      const after = telegramService.getCachedFilesInstant().length
      const isFirstRun = lastFileCount < 0
      lastFileCount = after
      if (!isFirstRun && after !== before) {
        const d = await readFolders()
        telegramService.rebuildFolderIndex(d.fileFolders || {})
        sendFilesChanged()
        idleCycles = 0
        syncInterval = 3000
      } else {
        idleCycles++
        if (idleCycles > 10) syncInterval = Math.min(syncInterval + 3000, 30000)
      }
    } catch {}
    setTimeout(adaptiveSync, syncInterval)
  }
  adaptiveSync()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  const stack = new Error().stack || ''
  log('warn', `[window-all-closed] activeUploads=${activeUploads} uploadsInProgress=${uploadsInProgress}\nStack: ${stack}`)
  autoSyncService.stop()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', (e) => {
  const stack = new Error().stack || ''
  log('warn', `[before-quit] activeUploads=${activeUploads} uploadsInProgress=${uploadsInProgress}\nStack: ${stack}`)
  autoSyncService.stop()
})
app.on('will-quit', (e) => {
  log('warn', `[will-quit] activeUploads=${activeUploads}`)
})

// --- Window Controls ---
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize() })
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('window:close', () => {
  const stack = new Error().stack || ''
  log('warn', `[window:close IPC] activeUploads=${activeUploads} uploadsInProgress=${uploadsInProgress}\nStack: ${stack}`)
  if (mainWindow) mainWindow.close()
})
ipcMain.handle('window:force-quit', () => {
  log('warn', `[window:force-quit] user force-quit while activeUploads=${activeUploads}`)
  if (mainWindow) mainWindow.destroy()
  app.quit()
})

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
      const savedToken = botService.getToken()
      if (savedToken) {
        try {
          const resp = await fetch(`https://api.telegram.org/bot${savedToken}/getMe`)
          const json = await resp.json()
          if (json.ok) {
            log('info', 'Reusing existing valid bot token')
            return { success: true, data: channelResult }
          }
        } catch {}
        log('warn', 'Saved bot token invalid, creating new bot')
      }
      try {
        const botResult = await telegramService.createBotAndAddToChannel()
        botService.setToken(botResult.token)
      } catch (e) {
        log('warn', 'Bot creation failed (non-fatal): ' + (e as Error).message)
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
      const savedToken = botService.getToken()
      if (savedToken) {
        try {
          const resp = await fetch(`https://api.telegram.org/bot${savedToken}/getMe`)
          const json = await resp.json()
          if (json.ok) {
            log('info', 'Reusing existing valid bot token (2FA)')
            return { success: true, data: channelResult }
          }
        } catch {}
        log('warn', 'Saved bot token invalid (2FA), creating new bot')
      }
      try {
        const botResult = await telegramService.createBotAndAddToChannel()
        botService.setToken(botResult.token)
      } catch (e) {
        log('warn', 'Bot creation failed (non-fatal): ' + (e as Error).message)
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
    const savedToken = botService.getToken()
    if (!savedToken) {
      try {
        const botResult = await telegramService.createBotAndAddToChannel()
        botService.setToken(botResult.token)
        log('info', 'Bot created automatically after reconnect')
      } catch (e) {
        log('warn', 'Bot creation after reconnect failed (non-fatal): ' + (e as Error).message)
      }
    } else {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${savedToken}/getMe`)
        const json = await resp.json()
        if (json.ok && json.result?.username) {
          await telegramService.addBotToChannel(json.result.username)
          log('info', 'Ensured bot @' + json.result.username + ' is admin in channel')
          await telegramService.cleanupBots(savedToken)
        } else {
          log('warn', 'Saved bot token invalid, creating new bot')
          botService.clearToken()
          try {
            const botResult = await telegramService.createBotAndAddToChannel()
            botService.setToken(botResult.token)
          } catch (e) {
            log('warn', 'Bot creation after invalid token failed: ' + (e as Error).message)
          }
        }
      } catch (e) {
        log('warn', 'Failed to verify bot token: ' + (e as Error).message)
      }
    }
    await telegramService.createCloudFolder()
    restorePersistedQueue()
    try {
      const local = await readFolders()
      const hasLocal = local.folders.length > 0 || Object.keys(local.fileFolders || {}).length > 0
      if (!initialFolderSyncDone && !hasLocal) {
        const cloud = await telegramService.loadFoldersFromChannel()
        if (cloud && (cloud.folders.length > 0 || Object.keys(cloud.fileFolders || {}).length > 0)) {
          if (cloud.botToken && !botService.getToken()) botService.setToken(cloud.botToken)
          await writeFolders({ folders: cloud.folders, fileFolders: cloud.fileFolders, trashedFolders: local.trashedFolders || [] })
          log('info', `Folders loaded from channel on reconnect: ${cloud.folders.length}`)
        } else if (hasLocal) {
          syncFoldersToTelegram().catch(() => {})
        }
        initialFolderSyncDone = true
      }
    } catch (e) {
      log('warn', 'Folder cloud sync on reconnect failed: ' + (e as Error).message)
    }
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
type UploadJob = { id: string; filePath: string; fileName: string; fileSize: number; encrypt?: boolean; customFileName?: string; resolve: (v: any) => void }
const uploadQueue: UploadJob[] = []
const activeUploadJobs = new Map<string, UploadJob>()
let activeUploads = 0
let uploadsInProgress = false
const uploadCancelled = new Set<string>()
let queuePumpRunning = false
let reconnectAfterUploads = false

function uploadStateSnapshot() {
  const active = Array.from(activeUploadJobs.values()).map(j => ({
    id: j.id, filePath: j.filePath, fileName: j.fileName, fileSize: j.fileSize,
    status: 'uploading' as const, percent: 0,
  }))
  const waiting = uploadQueue.map(j => ({
    id: j.id, filePath: j.filePath, fileName: j.fileName, fileSize: j.fileSize,
    status: 'waiting' as const, percent: 0,
  }))
  return [...active, ...waiting]
}
function broadcastUploadState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try { mainWindow.webContents.send('telegram:queue-state', { queue: uploadStateSnapshot(), activeUploads }) } catch {}
}
function persistUploadQueue() {
  try {
    const state = [...activeUploadJobs.values(), ...uploadQueue].map(j => ({ id: j.id, filePath: j.filePath, fileName: j.fileName, fileSize: j.fileSize, encrypt: j.encrypt, customFileName: j.customFileName }))
    fs.writeFileSync(path.join(app.getPath('userData'), 'upload-queue.json'), JSON.stringify(state))
  } catch {}
}
function clearPersistedQueue() {
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'upload-queue.json')) } catch {}
}
function loadPersistedQueue(): Array<{ id: string; filePath: string; fileName: string; fileSize: number; encrypt?: boolean; customFileName?: string }> {
  try {
    const p = path.join(app.getPath('userData'), 'upload-queue.json')
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      return Array.isArray(data) ? data : []
    }
  } catch {}
  return []
}

let persistedQueueRestored = false
function restorePersistedQueue() {
  if (persistedQueueRestored) return
  persistedQueueRestored = true

  const restored = loadPersistedQueue()
  for (const item of restored) {
    try {
      const stat = fs.statSync(item.filePath)
      if (!stat.isFile()) continue
      if (uploadQueue.some(job => job.id === item.id) || activeUploadJobs.has(item.id)) continue
      uploadQueue.push({
        ...item,
        fileName: item.fileName || path.basename(item.filePath),
        fileSize: stat.size,
        resolve: () => {},
      })
    } catch {}
  }

  if (uploadQueue.length > 0) {
    uploadsInProgress = true
    persistUploadQueue()
    broadcastUploadState()
    void processQueue()
  } else {
    clearPersistedQueue()
  }
}

let tgReconnectPromise: Promise<void> | null = null
async function autoReconnectTelegram() {
  if (tgReconnectPromise) return tgReconnectPromise
  tgReconnectPromise = (async () => {
    try {
      const sessionData = await storageService.getSession()
      if (!sessionData) { log('error', '[reconnect] no session found'); return }
      log('warn', '[reconnect] reconnecting Telegram client...')
      await telegramService.reconnect(sessionData.session)
      log('info', '[reconnect] Telegram reconnected successfully')
    } catch (e) {
      log('error', '[reconnect] failed: ' + (e as Error).message)
    } finally {
      tgReconnectPromise = null
    }
  })()
  return tgReconnectPromise
}
async function processQueue() {
  if (queuePumpRunning) return
  queuePumpRunning = true
  try {
    while (uploadQueue.length > 0 && activeUploads === 0) {
      const job = uploadQueue[0]
      uploadQueue.shift()
      activeUploadJobs.set(job.id, job)
      activeUploads = activeUploadJobs.size
      uploadsInProgress = true
      persistUploadQueue()
      broadcastUploadState()
      void runUpload(job).finally(async () => {
        activeUploadJobs.delete(job.id)
        activeUploads = activeUploadJobs.size
        if (activeUploads === 0 && reconnectAfterUploads) {
          reconnectAfterUploads = false
          await autoReconnectTelegram()
        }
        if (activeUploads === 0 && uploadQueue.length === 0) {
          uploadsInProgress = false
          clearPersistedQueue()
        } else {
          uploadsInProgress = true
          persistUploadQueue()
        }
        broadcastUploadState()
        void processQueue()
      })
    }
  } finally {
    queuePumpRunning = false
  }
}
async function runUpload(job: UploadJob): Promise<void> {
  const startTime = Date.now()
  const watchdog = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000)
    const mem = process.memoryUsage()
    log('warn', `[upload] still uploading after ${elapsed}s: ${job.filePath} heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB activeUploads=${activeUploads}`)
  }, 30000)
  try {
    log('info', `[upload] start: ${job.filePath} (id=${job.id})`)
    let lastSend = 0
    const THROTTLE_MS = 250
    const isCancelled = () => uploadCancelled.has(job.id)
    const sendProgress = (sent: number, total: number, force = false) => {
      if (isCancelled()) return
      const now = Date.now()
      if (!force && now - lastSend < THROTTLE_MS && sent < total) return
      lastSend = now
      const pct = total > 0 ? Math.floor((sent / total) * 100) : 0
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('telegram:upload-progress', { id: job.id, sent, total, percent: pct }) } catch {}
      }
    }
    // S3: initial stage-ping with real file size (не throttle-ится force)
    sendProgress(0, job.fileSize > 0 ? job.fileSize : 1, true)
    const result = await telegramService.uploadFile(job.filePath, (sent, total) => {
      // stage-ping (sent===0) форсируем, чтобы UI не висел на sendProgress(0,1) без total
      sendProgress(sent, total, sent === 0)
    }, job.encrypt, job.customFileName, isCancelled)
    if (isCancelled()) {
      log('info', `[upload] cancelled: ${job.filePath}`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('telegram:upload-complete', { id: job.id, success: false, error: 'cancelled' }) } catch {}
      }
      job.resolve({ success: false, error: 'cancelled' })
      uploadCancelled.delete(job.id)
      return
    }
    sendProgress(result.fileSize, result.fileSize)
    log('info', `[upload] done: ${job.filePath} (${result.fileSize} bytes, ${Math.floor((Date.now() - startTime) / 1000)}s)`)
    try { telegramService.addUploadedFileToCache(result) } catch {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('telegram:upload-complete', { id: job.id, success: true, data: result }) } catch {}
    }
    sendFilesChanged()
    job.resolve({ success: true, data: result })
  } catch (error) {
    const errMsg = (error as Error)?.message || String(error)
    log('error', `[upload] FAILED: ${job.filePath} — ${errMsg}`)
    if (!uploadCancelled.has(job.id)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('telegram:upload-complete', { id: job.id, success: false, error: errMsg }) } catch {}
      }
      job.resolve({ success: false, error: errMsg })
      if (errMsg.includes('disconnected') || errMsg.includes('disconnect')) {
        log('warn', `[upload] Telegram disconnected; reconnect deferred until active uploads settle`)
        reconnectAfterUploads = true
      }
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('telegram:upload-complete', { id: job.id, success: false, error: 'cancelled' }) } catch {}
      }
      job.resolve({ success: false, error: 'cancelled' })
    }
    uploadCancelled.delete(job.id)
  } finally {
    clearInterval(watchdog)
  }
}

ipcMain.handle('telegram:upload-file', async (event, filePath: string, id?: string, encrypt?: boolean, customFileName?: string) => {
  try {
    const jobId = id || Math.random().toString(36).slice(2)
    let fileName = path.basename(filePath)
    const st = fs.statSync(filePath)
    if (!st.isFile()) return { success: false, error: 'Selected path is not a file' }
    const fileSize = st.size
    return await new Promise((resolve) => {
      uploadQueue.push({ id: jobId, filePath, fileName, fileSize, encrypt, customFileName, resolve })
      uploadsInProgress = true
      persistUploadQueue()
      broadcastUploadState()
      void processQueue()
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:cancel-upload', async (event, id: string) => {
  const queuedIndex = uploadQueue.findIndex(job => job.id === id)
  if (queuedIndex !== -1) {
    const [job] = uploadQueue.splice(queuedIndex, 1)
    job.resolve({ success: false, error: 'cancelled' })
    if (activeUploads === 0 && uploadQueue.length === 0) {
      uploadsInProgress = false
      clearPersistedQueue()
    } else {
      persistUploadQueue()
    }
    broadcastUploadState()
    return { success: true }
  }
  if (activeUploadJobs.has(id)) uploadCancelled.add(id)
  return { success: true }
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
          await fs.promises.copyFile(r.filePath, dest)
        }
        const p = Math.min(100, Math.floor(((i + 1) / options.files.length) * 100))
        try { event.sender.send('archive-progress', { percent: p, phase: 'downloading' }) } catch {}
      }
    }

    if (options.folderPath) {
      async function walkArchiveDir(dir: string): Promise<string[]> {
        const out: string[] = []
        const items = await fs.promises.readdir(dir, { withFileTypes: true })
        for (const item of items) {
          const full = path.join(dir, item.name)
          if (item.isDirectory()) out.push(...await walkArchiveDir(full))
          else if (item.isFile()) out.push(full)
        }
        return out
      }
      const allFiles = await walkArchiveDir(options.folderPath)
      totalFiles = allFiles.length
    }

    // Create archive
    try { event.sender.send('archive-progress', { percent: 0, phase: 'compressing' }) } catch {}
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(archivePath)
      const archive = new ZipArchive({ zlib: { level: 6 } })
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

ipcMain.handle('telegram:list-files-cached', async () => {
  try {
    const cached = telegramService.getCachedFilesInstant()
    return { success: true, data: cached }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:list-files-from-cache', async (_, limit: number, offsetId: number) => {
  try {
    const result = await telegramService.listFilesFromCache(limit || 30, offsetId || 0)
    return { success: true, data: result.files, nextOffsetId: result.nextOffsetId, total: result.total }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:list-folder-files-from-cache', async (_, folderId: string, limit: number, offsetId: number) => {
  try {
    const allFiles = telegramService.getCachedFilesInstant()
    const folderData = await readFolders()
    const fileFoldersMap: Record<string, string> = folderData.fileFolders || {}
    const folderFiles = allFiles
      .filter((f: any) => fileFoldersMap[String(f.messageId)] === folderId)
      .sort((a: any, b: any) => (b.messageId || 0) - (a.messageId || 0))
    const filtered = offsetId > 0
      ? folderFiles.filter((f: any) => f.messageId < offsetId)
      : folderFiles
    const page = filtered.slice(0, limit || 30)
    const nextOffsetId = page.length >= (limit || 30) ? page[page.length - 1].messageId : null
    return { success: true, data: page, nextOffsetId, total: folderFiles.length }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:search-folder-files', async (_, folderId: string, query: string, limit: number, offsetId: number) => {
  try {
    return { success: true, ...telegramService.searchInFolder(folderId, query, limit || 30, offsetId || 0) }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:get-category-counts', async () => {
  try {
    return { success: true, data: telegramService.getFileCategoryCounts() }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:get-total-size', async () => {
  try {
    const cached = telegramService.getCachedFilesInstant()
    let totalSize = 0
    const oneWeekAgo = Date.now() / 1000 - 7 * 24 * 3600
    let weekFiles = 0
    for (const f of cached) {
      totalSize += (f as any).fileSize || 0
      if (((f as any).originalDate || (f as any).uploadedAt || 0) >= oneWeekAgo) weekFiles++
    }
    return { success: true, data: { total: cached.length, totalSize, weekFiles } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:get-files-by-category', async (_, category: string) => {
  try {
    return { success: true, data: telegramService.getFilesByCategory(category) }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:list-files', async () => {
  try {
    const files = await telegramService.listFilesCached()
    return { success: true, data: files }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:sync-files-bg', async (event) => {
  try {
    telegramService.syncFilesInBackground((fileCount, scannedMessages) => {
      try {
        event.sender.send('files:sync-progress', { fileCount, scannedMessages })
      } catch {}
    }).then(async () => {
      try {
        const d = await readFolders()
        telegramService.rebuildFolderIndex(d.fileFolders || {})
      } catch {}
    })
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:list-files-paginated', async (_, limit: number, offsetId: number) => {
  try {
    const result = await telegramService.listFilesPaginated(limit || 200, offsetId || 0)
    return { success: true, data: result.files, nextOffsetId: result.nextOffsetId }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:download-file', async (_, messageId: number, fileName: string) => {
  try {
    const prefs = await readPrefs()
    if (prefs.askDownloadPath) {
      // T-20260924-019 S2: привязываем диалог к активному окну, чтобы он не «терялся»
      // за главным окном; cancel → нормальный ответ {success:false, error:'cancelled'}.
      const opts: Electron.SaveDialogOptions = {
        title: 'Сохранить файл',
        defaultPath: path.join(app.getPath('downloads'), fileName),
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      }
      const parentWin = BrowserWindow.getFocusedWindow()
      const result = parentWin ? await dialog.showSaveDialog(parentWin, opts) : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) return { success: false, error: 'cancelled' }
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
    log('info', `[thumb] ipc download-thumbnail id=${messageId} → ${filePath}`)
    return { success: true, data: filePath }
  } catch (error) {
    log('error', `[thumb] ipc download-thumbnail id=${messageId} err=${(error as Error).message}`)
    return { success: false, error: (error as Error).message }
  }
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
    sendFilesChanged()
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
    sendFilesChanged()
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:perm-delete-file', async (_, messageId: number) => {
  try {
    await telegramService.permanentDelete(messageId)
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

// purge корзины + orphan #chunk_of одним вызовом; kind прогресса: 'purge-all' | 'orphans'
const clearTrashHandler = async (event: Electron.IpcMainInvokeEvent, messageIds: number[]) => {
  try {
    log('info', `[clearTrash] IPC start ids=${messageIds?.length || 0}`)
    const stats = await telegramService.clearTrash(
      messageIds || [],
      (done, total) => {
        try { event.sender.send('telegram:bulk-progress', { kind: 'purge-all', index: done, total }) } catch {}
      },
      (done, total) => {
        try { event.sender.send('telegram:bulk-progress', { kind: 'orphans', index: done, total }) } catch {}
      }
    )
    sendFilesChanged()
    log('info', `[clearTrash] IPC done deleted=${stats.deleted} ghosts=${stats.ghostsDeleted} failed=${stats.failed} total=${stats.total}`)
    return { success: true, data: stats }
  } catch (error) {
    log('error', `[clearTrash] IPC error: ${(error as Error).message}`)
    return { success: false, error: (error as Error).message }
  }
}

ipcMain.handle('telegram:clear-trash', clearTrashHandler)
// alias для совместимости: теперь это тот же bulk (purge + orphans); UI его больше не зовёт
ipcMain.handle('telegram:cleanup-ghosts', clearTrashHandler)

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
async function walkDir(dir: string, exclude: string[] = []): Promise<string[]> {
  const out: string[] = []
  const items = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const item of items) {
    const full = path.join(dir, item.name)
    if (exclude.some(p => full.includes(p))) continue
    if (item.isDirectory()) out.push(...await walkDir(full, exclude))
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
    const all = await walkDir(folder, exclude)
    const files = await Promise.all(all.map(async fp => {
      const stat = await fs.promises.stat(fp)
      return { filePath: fp, fileName: path.basename(fp), fileSize: stat.size }
    }))
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
    if (i < messageIds.length - 1) await new Promise(r => setTimeout(r, 400))
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
  return { success: true, data: 1 }
})

ipcMain.handle('storage:set-upload-concurrency', async (_, n: number) => {
  return { success: true, data: 1 }
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

ipcMain.on('renderer:mem-report', (_, data: { usedHeap: number; totalHeap: number; limit: number; domNodes: number; eventListeners: number }) => {
  log('warn', `[renderer-self] usedHeap=${(data.usedHeap / 1024 / 1024).toFixed(0)}MB totalHeap=${(data.totalHeap / 1024 / 1024).toFixed(0)}MB limit=${(data.limit / 1024 / 1024).toFixed(0)}MB domNodes=${data.domNodes} listeners=${data.eventListeners} activeUploads=${activeUploads}`)
})

ipcMain.on('renderer:lag-report', (_, data: { maxLag: string; avgLag: string; samples: number }) => {
  log('warn', `[renderer-lag] max=${data.maxLag}ms avg=${data.avgLag}ms samples=${data.samples} activeUploads=${activeUploads}`)
})

ipcMain.handle('telegram:get-upload-state', () => {
  return { success: true, data: { queue: uploadStateSnapshot(), activeUploads, uploadsInProgress } }
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
    if (arch === 'arm64') return (n: string) => n.endsWith('-arm64.dmg')
    return (n: string) => n.endsWith('.dmg') && !n.includes('-arm64')
  }
  if (plat === 'win32') return (n: string) => n.endsWith('.exe') || n.endsWith('-win.zip')
  return () => false
}

function findAssetForVersion(assets: any[], latestVersion: string, matchFn: (name: string) => boolean): any | undefined {
  // Prefer asset matching the exact version
  const exactMatch = (assets || []).find((a: any) => matchFn(a.name) && a.name.includes(latestVersion))
  if (exactMatch) return exactMatch
  // Fallback to any matching asset (for older releases)
  return (assets || []).find((a: any) => matchFn(a.name))
}

ipcMain.handle('app:check-update', async () => {
  try {
    const currentVersion = app.getVersion()
    const res = await fetchLatestRelease()
    const tag = (res.tag_name || '').replace(/^v/, '')
    if (!tag) return { success: true, data: { hasUpdate: false } }
    const hasUpdate = isNewer(tag, currentVersion)
      const matchFn = platformAssetPattern()
      const asset = findAssetForVersion(res.assets || [], tag, matchFn)
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

ipcMain.handle('app:download-update', async (event, assetId: number, assetName?: string, latestVersion?: string) => {
  try {
    const tempDir = app.getPath('temp')
    const ext = process.platform === 'darwin' ? '.dmg' : '.exe'
    const fileName = 'update' + ext
    const destPath = path.join(tempDir, fileName)

    let downloadUrl: string
    if (assetName && latestVersion) {
      downloadUrl = `https://github.com/RodjerYan/RodjerCloud/releases/download/v${latestVersion}/${assetName}`
    } else {
      downloadUrl = `${UPDATE_SERVER_URL}/api/download?id=${assetId}`
    }

    await downloadWithNet(event, downloadUrl, destPath)
    return { success: true, data: { filePath: destPath, fileName } }
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

    if (process.platform === 'darwin') {
      const script = `
        for i in {1..120}; do
          xattr -cr "/Applications/RodjerCloud.app" 2>/dev/null
          xattr -cr "$HOME/Applications/RodjerCloud.app" 2>/dev/null
          sleep 1
        done
      `
      const child = spawn('bash', ['-c', script], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
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
let foldersCache: any = null
let foldersCacheDirty = true

function invalidateFoldersCache() { foldersCacheDirty = true }

async function readFolders(): Promise<any> {
  if (!foldersCacheDirty && foldersCache) return foldersCache
  try {
    if (!fs.existsSync(foldersPath())) { foldersCache = { folders: [], fileFolders: {}, trashedFolders: [] }; foldersCacheDirty = false; return foldersCache }
    const data = await fs.promises.readFile(foldersPath(), 'utf8')
    const parsed = JSON.parse(data)
    if (!parsed.trashedFolders) parsed.trashedFolders = []
    foldersCache = parsed
    foldersCacheDirty = false
    telegramService.rebuildFolderIndex(parsed.fileFolders || {})
    return foldersCache
  } catch { foldersCache = { folders: [], fileFolders: {}, trashedFolders: [] }; foldersCacheDirty = false; return foldersCache }
}
async function writeFolders(d: any) {
  await fs.promises.writeFile(foldersPath(), JSON.stringify(d, null, 2))
  foldersCache = d
  foldersCacheDirty = false
  telegramService.rebuildFolderIndex(d.fileFolders || {})
}

let syncPending = false

async function syncFoldersToTelegram() {
  try {
    syncPending = true
    const d: any = await readFolders()
    const botToken = botService.getToken()
    if (botToken) d.botToken = botToken
    await telegramService.syncFolders(d)
    syncPending = false
  } catch (e) { 
    log('error', 'syncFolders: ' + (e as Error).message) 
    // syncPending remains true so we retry next time instead of overwriting
  }
}

ipcMain.handle('folders:list', async () => {
  try {
    const d = await readFolders()
    const isEmpty = !d || (d.folders || []).length === 0
    if (isEmpty && !initialFolderSyncDone) {
      try {
        const cloud = await telegramService.loadFoldersFromChannel()
        if (cloud && (cloud.folders.length > 0 || Object.keys(cloud.fileFolders || {}).length > 0)) {
          if (cloud.botToken && !botService.getToken()) botService.setToken(cloud.botToken)
          await writeFolders({ folders: cloud.folders, fileFolders: cloud.fileFolders, trashedFolders: d.trashedFolders || [] })
          initialFolderSyncDone = true
          return { success: true, data: await readFolders() }
        }
        initialFolderSyncDone = true
      } catch {}
    }
    return { success: true, data: d }
  }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:load-from-telegram', async () => {
  try {
    return await withFoldersLock(async () => {
      // Fast path: already synced this session and local store has data — skip channel scan
      if (initialFolderSyncDone) {
        const localFast: any = await readFolders()
        if (localFast && ((localFast.folders || []).length > 0 || Object.keys(localFast.fileFolders || {}).length > 0)) {
          return { success: true, data: localFast }
        }
      }

      const data = await telegramService.loadFoldersFromChannel()
      if (data) {
        if (data.botToken && !botService.getToken()) {
          botService.setToken(data.botToken)
          log('info', 'Bot token synced from channel data')
        }
        
        // Data loss prevention: If we have pending local changes that failed to upload, 
        // DO NOT overwrite them with older cloud data! Instead, try uploading again.
        if (syncPending) {
          log('warn', 'Pending local folder changes exist. Retrying upload instead of overwriting from cloud.')
          syncFoldersToTelegram().catch(() => {})
          const local = await readFolders()
          return { success: true, data: local }
        }

        if (data.folders && data.fileFolders) await writeFolders(data)
        initialFolderSyncDone = true
        return { success: true, data }
      }
      const local: any = await readFolders()
      if (!initialFolderSyncDone && (local.folders.length > 0 || Object.keys(local.fileFolders).length > 0)) {
        try { 
          const botToken = botService.getToken()
          if (botToken) local.botToken = botToken
          syncPending = true
          await telegramService.syncFolders(local)
          syncPending = false 
        } catch {
          // syncPending remains true
        }
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

      const trashedFolders = d.trashedFolders || []
      d.folders.filter((x: any) => idsToDelete.has(x.id)).forEach((f: any) => {
        trashedFolders.push({ ...f, trashedAt: Date.now() })
      })

      d.folders = d.folders.filter((x: any) => !idsToDelete.has(x.id))
      d.trashedFolders = trashedFolders
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true, data: d }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:list-trash', async () => {
  try {
    const d = await readFolders()
    const trashedFolders = d.trashedFolders || []
    const now = Date.now()
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000
    const expired = trashedFolders.filter((f: any) => now - f.trashedAt > THREE_DAYS)
    const active = trashedFolders.filter((f: any) => now - f.trashedAt <= THREE_DAYS)
    if (expired.length > 0) {
      d.trashedFolders = active
      const expiredIds = new Set(expired.map((f: any) => f.id))
      const expiredFileIds = Object.keys(d.fileFolders)
        .filter(k => expiredIds.has(d.fileFolders[k]))
        .map(Number)
      if (expiredFileIds.length > 0) {
        try { await telegramService.permanentDeleteBatch(expiredFileIds) } catch {}
      }
      expiredIds.forEach(id => {
        d.folders = d.folders.filter((x: any) => x.id !== id)
      })
      Object.keys(d.fileFolders).forEach(k => { if (expiredIds.has(d.fileFolders[k])) delete d.fileFolders[k] })
      await writeFolders(d)
      syncFoldersToTelegram().catch(() => {})
    }
    return { success: true, data: active }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:restore', async (_, id: string) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      const idx = (d.trashedFolders || []).findIndex((f: any) => f.id === id)
      if (idx === -1) return { success: false, error: 'Folder not found in trash' }
      const folder = d.trashedFolders[idx]
      d.trashedFolders.splice(idx, 1)
      const { trashedAt, ...rest } = folder
      d.folders.push(rest)
      await writeFolders(d)
      await syncFoldersToTelegram()
      return { success: true, data: d }
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:perm-delete', async (_, id: string) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      const idsToDelete = new Set<string>()
      const collect = (parentId: string) => {
        idsToDelete.add(parentId)
        ;(d.trashedFolders || []).filter((x: any) => x.parentId === parentId).forEach((x: any) => collect(x.id))
      }
      collect(id)

      const fileIdsToDelete = Object.keys(d.fileFolders)
        .filter(k => idsToDelete.has(d.fileFolders[k]))
        .map(Number)
      if (fileIdsToDelete.length > 0) {
        try { await telegramService.permanentDeleteBatch(fileIdsToDelete) } catch {}
      }

      d.trashedFolders = (d.trashedFolders || []).filter((x: any) => !idsToDelete.has(x.id))
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

ipcMain.handle('folders:move-files', async (_, messageIds: number[], folderId: string | null) => {
  try {
    return await withFoldersLock(async () => {
      const d = await readFolders()
      for (const id of messageIds) {
        if (folderId) d.fileFolders[id] = folderId
        else delete d.fileFolders[id]
      }
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

// T-20260924-019 S3: HEIC/HEIF → JPEG кроссплатформенно.
// Раньше был sips-only (/usr/bin/sips) — на win32 конверсия падала, <img> не декодировал HEIC.
// Теперь: на macOS — sips, иначе/как фоллбэк — heic-convert в worker_threads
// (тот же паттерн, что в thumb path: telegram-service / file:get-local-url).
function heicConvertWorker(inputBuffer: Buffer): Promise<Buffer> {
  const heicPath = require.resolve('heic-convert').replace(/\\/g, '/')
  const { Worker } = require('worker_threads')
  return new Promise<Buffer>((resolve, reject) => {
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
    worker.on('message', (msg: { success: boolean; buffer?: ArrayBuffer; error?: string }) => {
      if (msg.success) resolve(Buffer.from(msg.buffer!))
      else reject(new Error(msg.error))
    })
    worker.on('error', reject)
    worker.on('exit', (code: number | null) => {
      if (code !== 0) reject(new Error('heic-convert worker stopped with exit code ' + code))
    })
  })
}

// Проверка, что файл — настоящий JPEG (magic FF D8 FF), а не raw HEIC под именем .jpg
function isJpegFile(p: string): boolean {
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(3)
      const n = fs.readSync(fd, buf, 0, 3, 0)
      return n === 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
    } finally { fs.closeSync(fd) }
  } catch { return false }
}

async function ensurePreviewCache(cachedPath: string): Promise<string> {
  const ext = path.extname(cachedPath).toLowerCase()
  if (ext !== '.heic' && ext !== '.heif') return cachedPath
  const jpgPath = cachedPath + '.jpg'
  // size+magic check — старые poisoned-файлы (raw HEIC под именем .jpg, size>=10000)
  // должны быть удалены и переконвертированы, иначе <img> их не декодирует
  let ok = fs.existsSync(jpgPath) && fs.statSync(jpgPath).size >= 10000 && isJpegFile(jpgPath)
  if (fs.existsSync(jpgPath) && !isJpegFile(jpgPath)) {
    // poisoned cache: exists, но не JPEG → unlink, переконвертируем заново
    try { fs.rmSync(jpgPath, { force: true }) } catch {}
    ok = false
  }
  if (!ok) {
    try {
      if (fs.existsSync(jpgPath)) fs.rmSync(jpgPath, { force: true })
      const inputBuffer = await fs.promises.readFile(cachedPath)
      if (inputBuffer.length > 2 && inputBuffer[0] === 0xFF && inputBuffer[1] === 0xD8 && inputBuffer[2] === 0xFF) {
        // уже JPEG несмотря на расширение — копируем как есть
        await fs.promises.writeFile(jpgPath, inputBuffer)
      } else {
        let converted = false
        if (process.platform === 'darwin') {
          try {
            require('child_process').execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', cachedPath, '--out', jpgPath], { timeout: 15000 })
            converted = fs.existsSync(jpgPath)
          } catch (e: any) {
            console.error('sips FAIL:', cachedPath, e.message)
          }
        }
        if (!converted) {
          await fs.promises.writeFile(jpgPath, await heicConvertWorker(inputBuffer))
        }
      }
      ok = fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 0
    } catch (e: any) {
      console.error('heic preview convert FAIL:', cachedPath, e?.message)
    }
  }
  return ok ? jpgPath : cachedPath
}

// Единый путь получения src для preview:load И preview:navigate (раньше были асимметричны):
// video → http-stream; изображение → raw-скачивание в cache (без подмены ext) →
// ensurePreviewCache(raw) → display path (jpg после конверсии) либо raw для jpg/png/…
async function resolvePreviewSrc(dir: string, f: any): Promise<string> {
  const ext = (f.fileName || '').split('.').pop()?.toLowerCase() || ''
  // T-20260925-002 S3: stream-аем только то, что Chromium реально декодирует
  // (mp4=h264/aac, webm=vp8/9/av1).
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) {
    // mp4/webm — как раньше, напрямую в http-stream (S3 stream fix, не трогаем)
    if (['mp4', 'webm'].includes(ext)) return `http://127.0.0.1:14300/stream/${f.messageId}`
    // rework S3.1: mov/mkv/avi — качаем исходник в preview-cache (тот же
    // downloadMediaToPath, что у images), remux/transcode ffmpeg-static →
    // preview-cache\<id>_preview.mp4 → file:// (Chromium его играет).
    // Лоадер preview-окна крутится, пока идёт скачивание+конвертация.
    // Нет ffmpeg / конвертация упала → '' → renderMedia покажет старую
    // понятную ошибку «Формат не поддерживается (нужен mp4/webm)».
    const srcPath = path.join(dir, `${f.messageId}_${f.fileName}`)
    const mp4Path = path.join(dir, `${f.messageId}_preview.mp4`)
    // уже готовый mp4 → не перекачиваем и не переконвертируем исходник
    // (part+rename гарантирует, что существующий dst цел; старше 7 дней он не
    // бывает — preview-cache чистится при старте)
    if (fs.existsSync(mp4Path)) {
      try { if (fs.statSync(mp4Path).size > 0) return pathToFileURL(mp4Path).href } catch {}
    }
    if (!fs.existsSync(srcPath)) {
      try {
        ffmpegLog(`download src ${f.fileName} (id=${f.messageId})`)
        await (telegramService as any).downloadMediaToPath(f.messageId, srcPath)
      } catch (e) { ffmpegLog(`download fail: ${(e as Error).message}`) }
    }
    if (!fs.existsSync(srcPath)) return ''
    const converted = await convertVideoToMp4(srcPath, mp4Path)
    if (!converted) return ''
    // rework: pathToFileURL корректно экранирует пробелы/#/% и Windows-пути
    return pathToFileURL(converted).href
  }
  const rawPath = path.join(dir, `${f.messageId}_${f.fileName}`)
  if (!fs.existsSync(rawPath)) {
    try {
      await (telegramService as any).downloadMediaToPath(f.messageId, rawPath)
    } catch (e) { console.error('preview download failed', e) }
  }
  if (!fs.existsSync(rawPath)) return ''
  const displayPath = await ensurePreviewCache(rawPath)
  if (!fs.existsSync(displayPath)) return ''
  // rework: pathToFileURL корректно экранирует пробелы/#/% иWindows-пути
  return pathToFileURL(displayPath).href
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

    const tmpDir = app.getPath('temp')
    const tmpFile = path.join(tmpDir, `preview-${winId}.html`)

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
    pw.on('closed', () => {
      previewWindows.delete(winId)
      previewSessions.delete(winId.toString())
      try { fs.unlinkSync(tmpFile) } catch {}
    })

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
#bar button{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:5px;padding:4px 10px;font:12px/1.2 Inter, system-ui, sans-serif;cursor:pointer;white-space:nowrap;transition:background .15s}
#bar button:hover{background:rgba(255,255,255,0.18)}
#progress{flex:1;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;cursor:pointer;position:relative;margin:0 8px}
#progressFill{height:100%;background:#7c83ff;border-radius:3px;width:0%;pointer-events:none}
#time{font:11px/1 Inter, system-ui, sans-serif;color:rgba(255,255,255,0.45);min-width:70px;text-align:center}
</style></head>
<body>
<div id="top"><span id="fname" style="color:#fff;font:13px/1 Inter, system-ui, sans-serif;opacity:0.9">Загрузка...</span><span id="fpos" style="color:rgba(255,255,255,0.5);font:12px/1 Inter, system-ui, sans-serif"></span></div>
<button id="close" onclick="window.electronAPI.preview.close(sid)">✕</button>
<div id="loader"></div>
<div id="media"></div>
<div id="error" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#f87171;font:14px/1.4 Inter, system-ui, sans-serif;text-align:center;max-width:80%"></div>
<div id="bar"><button id="playBtn" onclick="togglePlay()">▶</button><div id="progress" onclick="seek(event)"><div id="progressFill"></div></div><span id="time">0:00 / 0:00</span><button id="speedBtn" onclick="cycleSpeed()">1x</button><button onclick="toggleFs()">⛶</button></div>
<script>
let sid = '${winId}'
let total = ${files.length}
let speed = 1
let video = null
function renderMedia(files, idx, src) {
  if (!files || !files[idx]) return
  const f = files[idx]
  const vExt = (f.fileName||'').split('.').pop().toLowerCase()
  const isVideo = ['mp4','mov','mkv','avi','webm'].includes(vExt)
  // T-20260925-002 S3: нет src (конвертация mov/mkv/avi не удалась / ffmpeg
  // недоступен / сломанный файл) → прячем и loader, иначе спиннер висит вместе
  // с ошибкой (вечный лоадер). Пока src не пришёл (preview:load ждёт скачивание
  // и конвертацию ffmpeg) лоадер крутится по умолчанию — это и есть индикатор
  // долгой конвертации.
  var ld = document.getElementById('loader'); if (ld && (!isVideo || !src)) ld.style.display = 'none'
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
      vid.onerror = function() {
        var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'
        var bar = document.getElementById('bar'); if (bar) bar.style.display = 'none'
        var er = document.getElementById('error')
        if (er) { er.textContent = 'Не удалось загрузить файл'; er.style.display = 'block' }
      }
      el.appendChild(vid)
    } else {
      var img = document.createElement('img')
      img.src = src
      img.draggable = false
      img.style.cssText = 'max-width:100%;max-height:100%;border-radius:4px'
      img.onerror = function() {
        var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'
        var er = document.getElementById('error')
        if (er) { er.textContent = 'Не удалось загрузить файл'; er.style.display = 'block' }
      }
      el.appendChild(img)
    }
    if (err) err.style.display = 'none'
  } else {
    if (err) {
      err.textContent = (isVideo ? 'Формат не поддерживается в предпросмотре (нужен mp4/webm):\\n' : 'Не удалось загрузить файл\\n') + f.fileName
      err.style.display = 'block'
    }
    document.getElementById('bar').style.display = 'none'; video = null
  }
  document.getElementById('fname').textContent = f.fileName
  document.getElementById('fpos').textContent = (idx + 1) + ' / ' + total
  if (isVideo) {
    video = document.getElementById('pv')
    // T-20260925-002 S3: без <video> (нет src — конвертация упала) — панель не показываем
    if (video) document.getElementById('bar').style.display = 'flex'
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

    fs.writeFileSync(tmpFile, html, 'utf-8')
    pw.loadFile(tmpFile)
    pw.show()

    const ext = (f.fileName || '').split('.').pop()?.toLowerCase() || ''
    const isVideo = ['mp4','mov','mkv','avi','webm'].includes(ext)

    if (isVideo) {
      // streaming
    } else {
      // preview:load will handle the download synchronously (await)
      if (fs.existsSync(cachedPath)) {
        await ensurePreviewCache(cachedPath)
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
    // T-20260924-019 S3: raw-путь без подмены ext (.jpg больше не дописывается до
    // скачивания), конверсия heic внутри ensurePreviewCache → отдаём display path.
    const src = await resolvePreviewSrc(s.dir, f)
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
    // T-20260924-019 S3: синхронизировано с preview:load — общий resolvePreviewSrc
    // (video → stream, image → raw cache + ensurePreviewCache), без отдельного
    // heicSuffix-пути, из-за которого src оказывался пустым.
    const src = await resolvePreviewSrc(s.dir, nextFile)
    return { success: true, data: { files: s.files, idx: s.idx, src } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

// drag&drop temp-fallback (macOS Sequoia, electron/electron#44600): webUtils.getPathForFile
// вернул '' — копируем содержимое File из renderer во временный файл, грузим по temp-path.
// REWORK#2: чанкованная запись open/write/close через async FileHandle — вместо one-shot
// arrayBuffer→writeFileSync (2–3× RAM + фриз main). Пик памяти ограничен размером чанка.
let dropTempDir: string | null = null
const MAX_DROP_TEMP_BYTES = 2 * 1024 * 1024 * 1024 // 2GB — sanity-limit, как в renderer
const dropTempHandles = new Map<string, { handle: FileHandle; path: string; written: number }>()
let dropTempSeq = 0

ipcMain.handle('file:drop-temp-open', async (_, fileName: string, size: number) => {
  try {
    if (typeof size === 'number' && size > MAX_DROP_TEMP_BYTES) {
      return { success: false, error: 'File too large for drag&drop temp fallback' }
    }
    // sanitize: только basename, без ../ и управляющих символов
    const safeName = path.basename(String(fileName || '').replace(/\\/g, '/'))
      .replace(/[\x00-\x1f\x7f]/g, '').trim()
    const finalName = (!safeName || safeName === '.' || safeName === '..') ? 'dropped-file' : safeName
    if (!dropTempDir || !fs.existsSync(dropTempDir)) {
      dropTempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'rodjer-drop-'))
    }
    let filePath = path.join(dropTempDir, finalName)
    if (fs.existsSync(filePath)) filePath = path.join(dropTempDir, `${Date.now()}_${finalName}`)
    const handle = await fs.promises.open(filePath, 'w')
    const tempId = `drop-${Date.now()}-${++dropTempSeq}`
    dropTempHandles.set(tempId, { handle, path: filePath, written: 0 })
    return { success: true, data: { tempId, filePath } }
  } catch (error) {
    console.warn('[drop] temp open failed', fileName, error)
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('file:drop-temp-write', async (_, tempId: string, chunk: ArrayBuffer | Uint8Array) => {
  try {
    const entry = dropTempHandles.get(tempId)
    if (!entry) return { success: false, error: 'Unknown drop tempId' }
    const buf = Buffer.isBuffer(chunk) ? chunk
      : chunk instanceof ArrayBuffer ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (entry.written + buf.length > MAX_DROP_TEMP_BYTES) {
      return { success: false, error: 'File too large for drag&drop temp fallback' }
    }
    const { bytesWritten } = await entry.handle.write(buf)
    entry.written += bytesWritten
    return { success: true, data: { written: entry.written } }
  } catch (error) {
    console.warn('[drop] temp write failed', tempId, error)
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('file:drop-temp-close', async (_, tempId: string) => {
  const entry = dropTempHandles.get(tempId)
  if (!entry) return { success: false, error: 'Unknown drop tempId' }
  dropTempHandles.delete(tempId)
  try {
    await entry.handle.close()
    console.log('[drop] temp saved', path.basename(entry.path), entry.written)
    return { success: true, data: { filePath: entry.path } }
  } catch (error) {
    console.warn('[drop] temp close failed', tempId, error)
    return { success: false, error: (error as Error).message }
  }
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
      log('warn', `[thumb] getLocalUrl denied ${resolvedPath}`)
      return { success: false, error: 'Access denied: path outside allowed directories' }
    }
    if (!fs.existsSync(resolvedPath)) {
      log('warn', `[thumb] getLocalUrl missing ${resolvedPath}`)
      return { success: false, error: 'File not found' }
    }
    let finalPath = resolvedPath
    const ext = path.extname(resolvedPath).toLowerCase()

    // H6: bulletproof path for small thumb-cache images — no custom protocol involved.
    const isThumbCache = resolvedPath.replace(/\\/g, '/').includes('/thumb-cache/')
    if (isThumbCache && (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp' || ext === '.gif' || ext === '.bmp')) {
      const st = fs.statSync(resolvedPath)
      if (st.size <= 512 * 1024) {
        const mime: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }
        const b64 = fs.readFileSync(resolvedPath).toString('base64')
        log('info', `[thumb] getLocalUrl data-url id=${path.basename(resolvedPath)} bytes=${st.size}`)
        return { success: true, data: `data:${mime[ext] || 'image/jpeg'};base64,${b64}` }
      }
      log('info', `[thumb] getLocalUrl cache too big (${st.size}), fallback local-file`)
    }

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
              const heicPath = require.resolve('heic-convert').replace(/\\/g, '/')
              const { Worker } = require('worker_threads')
              const outputBuffer = await new Promise<Buffer>((resolve, reject) => {
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
                worker.on('message', (msg: { success: boolean; buffer?: ArrayBuffer; error?: string }) => {
                  if (msg.success) resolve(Buffer.from(msg.buffer!))
                  else reject(new Error(msg.error))
                })
                worker.on('error', reject)
                worker.on('exit', (code: number | null) => {
                  if (code !== 0) reject(new Error('heic-convert worker stopped with exit code ' + code))
                })
              })
              fs.writeFileSync(jpgPath, outputBuffer)
            }
          }
        } catch (e: any) {
          console.error('HEIC convert FAIL for thumbnail:', filePath, e.message)
        }
      }
      finalPath = jpgPath
    }
    // Same semantics as src/lib/localFileUrl.ts (main can't import from src):
    // abs FS path → local-file:/// URL with drive letter in pathname (3 slashes).
    let p = finalPath.replace(/\\/g, '/')
    if (/^[A-Za-z]:/.test(p)) p = '/' + p
    if (!p.startsWith('/')) p = '/' + p
    const url = 'local-file://' + encodeURI(p)
    log('info', `[thumb] getLocalUrl local-file → ${url}`)
    return { success: true, data: url }
  } catch (error) {
    log('error', `[thumb] getLocalUrl err=${(error as Error).message}`)
    return { success: false, error: (error as Error).message }
  }
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
    // Verify token via Bot API and get bot username
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const json = await resp.json()
    if (!json.ok) throw new Error('Токен недействителен: ' + (json.description || ''))
    const botUsername = json.result?.username
    if (!botUsername) throw new Error('Не удалось получить username бота')

    // Add bot to channel as admin
    log('info', 'Adding bot @' + botUsername + ' to channel with token')
    await telegramService.addBotToChannel(botUsername)

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
    const savedToken = botService.getToken()
    if (savedToken) {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${savedToken}/getMe`)
        const json = await resp.json()
        if (json.ok) return { success: true, data: { created: false } }
      } catch {}
      log('warn', 'Saved bot token invalid in ensure-bot, creating new')
      botService.clearToken()
    }
    const botResult = await telegramService.createBotAndAddToChannel()
    botService.setToken(botResult.token)
    return { success: true, data: { created: true, username: botResult.username } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('share:reuse-bot', async () => {
  try {
    const savedToken = botService.getToken()
    if (savedToken) {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${savedToken}/getMe`)
        const json = await resp.json()
        if (json.ok && json.result?.username) {
          await telegramService.addBotToChannel(json.result.username)
          return { success: true, data: { username: json.result.username } }
        }
      } catch {}
    }
    const botResult = await telegramService.createBotAndAddToChannel()
    botService.setToken(botResult.token)
    return { success: true, data: { username: botResult.username } }
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
    const hash = await telegramService.computePartialHash(messageId)
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
