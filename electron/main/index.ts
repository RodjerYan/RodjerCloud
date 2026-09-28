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
import { startVideoStreamServer, rangeCache, getStreamMeta } from './video-stream-server'
import { convertVideoToMp4, downloadPreviewSourceOnce, ffmpegLog } from './previewConverter'
import { ensureHlsSession, cleanupHlsForIds, IPC_START_TIMEOUT_MS, setHlsProgressHandler, setHlsProbeHandler } from './hlsServer'

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
      // T-20260925-003 S1: [hls]-логи HLS-сессий (hlsServer)
      if (s.includes('[hls]')) log('info', s)
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
        const fileUrl = pathToFileURL(filePath).href
        log('info', `[local-file] raw=${request.url} → ${fileUrl}`)
        return net.fetch(fileUrl)
      } else {
        // darwin/linux: standard-scheme parsing (local-file:///Users/... → host='users', pathname='/alexander/...')
        // Include host in the reconstructed path since WHATWG "special authority ignore slashes" drops leading slashes
        const rawPath = u.host ? `/${u.host}${pathname}` : pathname
        filePath = rawPath
        if (!filePath.startsWith('/')) {
          log('error', `[local-file] reject non-abs posix raw=${request.url} → ${filePath}`)
          return new Response('Bad path', { status: 400 })
        }
        // Case-fallback for macOS (APFS case-insensitive) and Linux devs: host was lowercased by URL parser
        // If file doesn't exist and path starts with /users/, try /Users/ (capital U)
        let resolvedPath = filePath
        if (!fs.existsSync(resolvedPath) && resolvedPath.startsWith('/users/')) {
          const fallbackPath = '/Users' + resolvedPath.slice(5)
          if (fs.existsSync(fallbackPath)) {
            resolvedPath = fallbackPath
            log('info', `[local-file] case-fallback raw=${request.url} → ${pathToFileURL(resolvedPath).href}`)
          }
        }
        const fileUrl = pathToFileURL(resolvedPath).href
        log('info', `[local-file] raw=${request.url} → ${fileUrl}`)
        return net.fetch(fileUrl)
      }
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
  } catch (error) {
    log('error', '[get-user-info] failed: ' + (error as Error).message)
    return { success: false, error: (error as Error).message }
  }
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

// D4 FIX: Global search across all cached files
ipcMain.handle('telegram:search-global', async (_, query: string, limit?: number) => {
  try {
    return { success: true, ...telegramService.searchGlobal(query, limit || 100) }
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
      // P4: после healVideoDimensions рендерер должен перечитать кэш
      try { sendFilesChanged() } catch {}
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

// T-20260928-010: folder card stats from full cache
ipcMain.handle('folders:stats', async () => {
  try {
    const allFiles = telegramService.getCachedFilesInstant()
    const d = await readFolders()
    const folderList: any[] = d.folders || []
    const fileFoldersMap: Record<string, string> = d.fileFolders || {}

    // group all cached files by their direct folderId (keys are stringified messageIds)
    const filesByFolder: Record<string, any[]> = {}
    for (const f of allFiles as any[]) {
      const fid = fileFoldersMap[String(f.messageId)]
      if (!fid) continue
      if (!filesByFolder[fid]) filesByFolder[fid] = []
      filesByFolder[fid].push(f)
    }

    // ids of all descendants (recursive, same collect as in folders:delete)
    const descendantIds = (id: string): Set<string> => {
      const out = new Set<string>()
      const collect = (parentId: string) => {
        folderList.filter((x: any) => x.parentId === parentId && !out.has(x.id)).forEach((x: any) => { out.add(x.id); collect(x.id) })
      }
      collect(id)
      return out
    }

    const data: Record<string, any> = {}
    for (const folder of folderList) {
      const ids = descendantIds(folder.id)
      ids.add(folder.id)
      let count = 0
      let size = 0
      for (const fid of ids) {
        const list = filesByFolder[fid]
        if (!list) continue
        count += list.length
        for (const f of list) size += f.fileSize || 0
      }

      // preview: direct files of THIS folder only (без потомков), messageId desc →
      // первый попавшийся image или video (регексы те же, что в карточке папки)
      const direct = (filesByFolder[folder.id] || []).slice().sort((a: any, b: any) => (b.messageId || 0) - (a.messageId || 0))
      const IMG_RE = /\.(jpg|jpeg|png|gif|webp)$/i
      const VID_RE = /\.(mp4|mov|avi|mkv|webm)$/i
      const pf = direct.find((f: any) => IMG_RE.test(f.fileName || '') || VID_RE.test(f.fileName || ''))
      const preview = pf
        ? { messageId: pf.messageId, fileName: pf.fileName || '', isVideo: VID_RE.test(pf.fileName || ''), width: pf.width, height: pf.height }
        : null

      data[folder.id] = { count, size, preview }
    }
    return { success: true, data }
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

// ==== T-20260925-010 S2: результат resolvePreviewSrc ====
// hlsPending=true → main НЕ качивал и НЕ конвертировал (HLS-first): preview
// сразу уходит в preview:hls-start. Пустой src + hlsPending отличим от ошибки
// (там просто src=''), preview-скрипт по флагу не показывает «Формат не поддерживается».
type PreviewSrc = { src: string; hlsPending?: boolean }

// T-20260925-005 S2: отправка фаз download/convert в ИЗВЕСТНОЕ окно сессии
// (без рассылок). Общая для resolvePreviewSrc, resolvePreviewSlowSrc и
// preview:convert-fallback.
function makePreviewProgressSender(sessionId?: string) {
  return (ev: { phase: 'download' | 'convert'; sent?: number; total?: number }) => {
    if (!sessionId) return
    const pw = previewWindows.get(Number(sessionId))
    if (!pw || pw.isDestroyed() || pw.webContents.isDestroyed()) return
    try { pw.webContents.send('preview:progress', ev) } catch {}
  }
}

// Единый путь получения src для preview:load И preview:navigate (раньше были асимметричны):
// video → http-stream; изображение → raw-скачивание в cache (без подмены ext) →
// ensurePreviewCache(raw) → display path (jpg после конверсии) либо raw для jpg/png/…
async function resolvePreviewSrc(dir: string, f: any, sessionId?: string): Promise<PreviewSrc> {
  const sendProgress = makePreviewProgressSender(sessionId)
  const ext = (f.fileName || '').split('.').pop()?.toLowerCase() || ''
  // T-20260925-002 S3: stream-аем только то, что Chromium реально декодирует
  // (mp4=h264/aac, webm=vp8/9/av1, mov=hevc/h264 — нативно в Chromium).
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) {
    // mp4/webm/mov — direct /stream (mov: HEVC/H.264 декодируется нативно, см. 13741).
    // mkv/avi — Chromium НЕ декодирует контейнер → hlsPending (как раньше).
    if (['mp4', 'webm', 'mov'].includes(ext)) return { src: `http://127.0.0.1:14300/stream/${f.messageId}` }
    // ==== T-20260925-010 S2: mkv/avi — НЕ блокируем download+convert ====
    //   * mp4 уже лежит в preview-cache → мгновенный file:// (как раньше);
    //   * иначе hlsPending: preview сразу запускает HLS-сессию — hlsServer
    //     транскодит из http-stream ПОКА файл качается (S1), спиннер + #dl
    //     показывают «Подготовка потока…»/прогресс; если HLS не стартовал
    //     (ошибка либо бюджет 20s) → preview:convert-fallback → старый путь.
    const mp4Path = path.join(dir, `${f.messageId}_preview.mp4`)
    if (fs.existsSync(mp4Path)) {
      try { if (fs.statSync(mp4Path).size > 0) return { src: pathToFileURL(mp4Path).href } } catch {}
    }
    return { src: '', hlsPending: true }
  }
  const rawPath = path.join(dir, `${f.messageId}_${f.fileName}`)
  const downloaded = await downloadPreviewSourceOnce(telegramService, f.messageId, rawPath, (sent, total) => {
    sendProgress({ phase: 'download', sent, total })
  }, f.fileSize)
  if (!downloaded) return { src: '' }
  const displayPath = await ensurePreviewCache(rawPath)
  if (!fs.existsSync(displayPath)) return { src: '' }
  // rework: pathToFileURL корректно экранирует пробелы/#/% иWindows-пути
  return { src: pathToFileURL(displayPath).href }
}

// ==== T-20260925-010 S2: СТАРЫЙ путь mov/mkv/avi ====
// Полное скачивание + convertVideoToMp4 → file://. Используется IPC
// preview:convert-fallback, когда HLS-first не стартовал (hlsStart {error}
// либо бюджет 20s в preview-скрипте). Скачка дедуплицируется
// downloadPreviewSourceOnce — общая с fallback-веткой hlsServer, поэтому
// двойного скачивания не бывает, а convertVideoToMp4 дедуплицирует конвертацию.
async function resolvePreviewSlowSrc(dir: string, f: any, sessionId?: string): Promise<string> {
  const sendProgress = makePreviewProgressSender(sessionId)
  const srcPath = path.join(dir, `${f.messageId}_${f.fileName}`)
  const mp4Path = path.join(dir, `${f.messageId}_preview.mp4`)
  // уже готовый mp4 → не перекачиваем и не переконвертируем исходник
  // (part+rename гарантирует, что существующий dst цел; старше 7 дней он не
  // бывает — preview-cache чистится при старте)
  if (fs.existsSync(mp4Path)) {
    try { if (fs.statSync(mp4Path).size > 0) return pathToFileURL(mp4Path).href } catch {}
  }
  const downloaded = await downloadPreviewSourceOnce(telegramService, f.messageId, srcPath, (sent, total) => {
    sendProgress({ phase: 'download', sent, total })
  }, f.fileSize)
  if (!downloaded) return ''
  // фаза convert: событие перед вызовом + «пинг» раз в 1s (percent не нужен —
  // только текст «Конвертация видео…»); по окончании тикер снимаем.
  sendProgress({ phase: 'convert' })
  const convertTick = setInterval(() => sendProgress({ phase: 'convert' }), 1000)
  let converted: string | null = null
  try {
    converted = await convertVideoToMp4(srcPath, mp4Path)
  } finally {
    clearInterval(convertTick)
  }
  if (!converted) return ''
  // rework: pathToFileURL корректно экранирует пробелы/#/% и Windows-пути
  return pathToFileURL(converted).href
}

// T-20260925-003 S2: содержимое hls.js для инлайна в preview-шаблон.
// preview-окно грузится из tmp-файла (pw.loadFile → file://), поэтому внешние
//   <script src="http://127.0.0.1:14300/hls.js"> — не работают (file:// + CORS),
// а <script src="node_modules/..."> — тоже (нет HTTP-обслуживания файла).
// Поэтому читаем dist/hls.min.js (~600KB) и встраиваем в HTML один раз:
//   * require.resolve резолвится и из app.asar (prod-deps в asar, как у heic-convert);
//   * если резолв не удался (packaged-сборка без hls.js) → '' → preview-скрипт
//     увидит typeof Hls === 'undefined' и сразу пойдёт на прямой src (fallback).
// require.resolve — как в heic-convert выше: путь внутри asar читается Electron'ом.
let hlsJsInline: string | undefined
function loadHlsJsInline(): string {
  if (hlsJsInline !== undefined) return hlsJsInline
  const candidates: string[] = []
  try { candidates.push(require.resolve('hls.js/dist/hls.min.js')) } catch {}
  try { candidates.push(path.join(app.getAppPath(), 'node_modules', 'hls.js', 'dist', 'hls.min.js')) } catch {}
  let code: string | null = null
  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue
      code = fs.readFileSync(p, 'utf-8')
      break
    } catch (e) { console.log(`[hls] read inline failed ${p}: ${(e as Error).message}`) }
  }
  // защита от разрыва HTML: строка "</script" внутри minified-кода закрыла бы
  // наш <script> тег (в hls.min.js её нет — проверено, но оставляем на будущее)
  hlsJsInline = code ? code.replace(/<\/script/gi, '<\\/script') : ''
  if (!hlsJsInline) console.log('[hls] hls.js inline unavailable → preview uses direct src only')
  return hlsJsInline
}

// T-20260926-001 S1: Plyr inline (MIT) — аналогично hls.js, для file:// preview без CORS
let plyrJsInline: string | undefined
function loadPlyrJsInline(): string {
  if (plyrJsInline !== undefined) return plyrJsInline
  const candidates: string[] = []
  try { candidates.push(require.resolve('plyr/dist/plyr.min.js')) } catch {}
  try { candidates.push(path.join(app.getAppPath(), 'node_modules', 'plyr', 'dist', 'plyr.min.js')) } catch {}
  let code: string | null = null
  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue
      code = fs.readFileSync(p, 'utf-8')
      break
    } catch (e) { console.log(`[plyr] read inline failed ${p}: ${(e as Error).message}`) }
  }
  plyrJsInline = code ? code.replace(/<\/script/gi, '<\\/script') : ''
  if (!plyrJsInline) console.log('[plyr] inline unavailable → native controls')
  return plyrJsInline
}

let plyrCssInline: string | undefined
function loadPlyrCssInline(): string {
  if (plyrCssInline !== undefined) return plyrCssInline
  const candidates: string[] = []
  try { candidates.push(require.resolve('plyr/dist/plyr.css')) } catch {}
  try { candidates.push(path.join(app.getAppPath(), 'node_modules', 'plyr', 'dist', 'plyr.css')) } catch {}
  let code: string | null = null
  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue
      code = fs.readFileSync(p, 'utf-8')
      break
    } catch (e) { console.log(`[plyr] read css inline failed ${p}: ${(e as Error).message}`) }
  }
  plyrCssInline = code || ''
  return plyrCssInline
}

const previewWindows = new Map<number, BrowserWindow>()

// ==== T-20260925-010 S2: фазы fallback-ветки HLS-сессии → preview-окна ====
// mov/mkv/avi идут HLS-first (resolvePreviewSrc не блокирует качкой), но сама
// HLS-сессия может уйти во внутренний fallback hlsServer (probe по stream не
// удался → скачивание + конвертация). Без этого хука эти фазы были бы для
// preview-окна невидимы — теперь T-005 progress приходит и из них.
setHlsProgressHandler((messageId, ev) => {
  for (const [sid, pw] of previewWindows) {
    if (pw.isDestroyed() || pw.webContents.isDestroyed()) continue
    const s = previewSessions.get(String(sid))
    if (!s || !s.files.some((f: any) => Number(f?.messageId) === Number(messageId))) continue
    try { pw.webContents.send('preview:progress', ev) } catch {}
  }
})

// P4: пробе HLS записала реальные размеры → file-cache → бейдж разрешения
setHlsProbeHandler((messageId, width, height, duration) => {
  try {
    if (telegramService.cacheVideoDimensions(messageId, width, height, duration)) sendFilesChanged()
  } catch {}
})

ipcMain.handle('preview:open', async (_, files: any[], idx: number) => {
  try {
    const f = files[idx]
    if (!f) return { success: false, error: 'File not found' }

    // T-20260928-004 S6: fire-and-forget прогрев getStreamMeta — метаданные потока
    // начнут считываться к моменту открытия превью. Не await'им наружу (не блокирует
    // ответ ipcMain.handle), ошибка прогрева не ломает открытие preview (вложенный try/catch).
    void (async () => {
      try { await getStreamMeta(telegramService, Number(f.messageId)) } catch (e) { console.warn('[preview] warmup getStreamMeta failed:', f.messageId, e) }
    })()

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
    // T-20260925-003 S2: [hls]-логи preview-скрипта (причина fallback, таймауты)
    // → rodjercloud.log; иначе диагностика «почему не HLS» невозможна (renderer
    // console в main не попадает, console-override выше работает только для main)
    pw.webContents.on('console-message', (_e, _lvl, message) => {
      if (typeof message === 'string' && message.includes('[hls]')) log('info', `[hls] preview: ${message}`)
    })
    pw.on('closed', () => {
      // REWORK#1 F2/F3: Alt+F4/закрытие окна напрямую (без IPC preview:close)
      // — иначе HLS-сессии файлов окна продолжают транскод до TTL 10min.
      // cleanupHlsForIds идемпотентен (preview:close уже мог почистить).
      const closedSession = previewSessions.get(winId.toString())
      if (closedSession) {
        const closedIds = closedSession.files
          .map((f: any) => Number(f?.messageId))
          .filter((n: number) => Number.isInteger(n) && n > 0)
        if (closedIds.length) {
          try { cleanupHlsForIds(closedIds) } catch (e) { log('warn', `[hls] cleanup on preview closed err=${(e as Error).message}`) }
          // m2 FIX: Clear range cache for all messageIds in this preview session
          for (const messageId of closedIds) {
            rangeCache.clear(messageId)
          }
        }
      }
      previewWindows.delete(winId)
      previewSessions.delete(winId.toString())
      try { fs.unlinkSync(tmpFile) } catch {}
    })

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Preview</title>
<style>
${loadPlyrCssInline()}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a14;height:100vh;overflow:hidden;user-select:none}
#loader{width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:#7c83ff;border-radius:50%;animation:spin .8s linear infinite;position:fixed;top:50%;left:50%;margin:-20px 0 0 -20px}
@keyframes spin{to{transform:rotate(360deg)}}
#top{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(180deg,rgba(0,0,0,0.6),transparent);z-index:10;-webkit-app-region:drag}
#top:hover{opacity:1}
#close{position:fixed;top:12px;right:16px;z-index:20;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.1);border:none;color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s;line-height:1;-webkit-app-region:no-drag}
#media{position:fixed;top:0;left:0;right:0;bottom:48px;display:flex;align-items:center;justify-content:center}
#media video,#media img{width:100%;height:100%;object-fit:contain;border-radius:4px}
#bar{position:fixed;bottom:0;left:0;right:0;z-index:20;background:rgba(10,10,20,0.92);display:none;align-items:center;gap:8px;padding:6px 12px;height:48px;border-top:1px solid rgba(255,255,255,0.06)}
#bar button{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:5px;padding:4px 10px;font:12px/1.2 Inter, system-ui, sans-serif;cursor:pointer;white-space:nowrap;transition:background .15s}
#bar button:hover{background:rgba(255,255,255,0.18)}
#progress{flex:1;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;cursor:pointer;position:relative;margin:0 8px}
#progressFill{height:100%;background:#7c83ff;border-radius:3px;width:0%;pointer-events:none}
#time{font:11px/1 Inter, system-ui, sans-serif;color:rgba(255,255,255,0.45);min-width:70px;text-align:center}
.mwrap{position:relative;display:flex;align-items:center}
.menu{display:none;position:absolute;bottom:calc(100% + 8px);right:0;min-width:96px;max-height:236px;overflow-y:auto;background:rgba(18,18,32,0.98);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:4px;z-index:40;box-shadow:0 8px 24px rgba(0,0,0,0.5)}
.menu.open{display:block}
.menu div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 10px;border-radius:5px;font:12px/1.2 Inter, system-ui, sans-serif;color:rgba(255,255,255,0.85);cursor:pointer;white-space:nowrap}
.menu div:hover{background:rgba(255,255,255,0.12)}
.menu .chk{color:#7c83ff;min-width:11px;text-align:right}
#muteBtn{min-width:34px;padding:4px 7px}
#vol{-webkit-appearance:none;appearance:none;width:76px;height:16px;background:transparent;outline:none;cursor:pointer;--vp:100%}
#vol::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(90deg,#7c83ff var(--vp),rgba(255,255,255,0.18) var(--vp))}
#vol::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;margin-top:-4px;border-radius:50%;background:#7c83ff;border:none;cursor:pointer}
#vol::-moz-range-track{height:4px;border-radius:2px;background:rgba(255,255,255,0.18)}
#vol::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:#7c83ff;cursor:pointer}
@media (max-width:640px){#vol{display:none}}

/* T-20260926-001 S1: Plyr theme overrides for dark preview */
.plyr--video .plyr__controls{background:linear-gradient(#0000,rgba(10,10,20,0.92))}
.plyr--video .plyr__control:focus-visible,.plyr--video .plyr__control:hover,.plyr--video .plyr__control[aria-expanded=true]{background:#7c83ff;color:#fff}
.plyr--full-ui.plyr--video input[type=range]::-webkit-slider-runnable-track{background-color:rgba(255,255,255,0.1)}
.plyr--full-ui.plyr--video input[type=range]::-moz-range-track{background-color:rgba(255,255,255,0.1)}
.plyr--full-ui.plyr--video input[type=range]::-ms-track{background-color:rgba(255,255,255,0.1)}
/* Two-tone progress: played (#7c83ff) + buffered (lighter/transparent, like YouTube) */
.plyr--video .plyr__progress__played{background:#7c83ff}
.plyr--video .plyr__progress__buffer{background:rgba(124,131,255,0.35)}
.plyr--full-ui.plyr--video input[type=range]:active::-webkit-slider-thumb{box-shadow:0 1px 1px rgba(35,40,47,0.15),0 0 0 1px rgba(35,40,47,0.2),0 0 0 3px rgba(255,255,255,0.5)}
.plyr--full-ui.plyr--video input[type=range]:active::-moz-range-thumb{box-shadow:0 1px 1px rgba(35,40,47,0.15),0 0 0 1px rgba(35,40,47,0.2),0 0 0 3px rgba(255,255,255,0.5)}
.plyr__menu__container{background:rgba(18,18,32,0.98);color:rgba(255,255,255,0.85)}
.plyr__menu__container .plyr__control{color:rgba(255,255,255,0.85)}
.plyr__menu__container .plyr__control[role=menuitemradio][aria-checked=true]:before{background:#7c83ff}
.plyr__menu__container .plyr__control--forward:after{border-left-color:#7c83ff}
.plyr__menu__container .plyr__control--back:after{border-right-color:#7c83ff}
.plyr__tooltip{background:#fff;color:#1a1a2e}
.plyr__tooltip:before{border-top-color:#fff}
.plyr__control--overlaid{background:#7c83ff;color:#fff}
.plyr:fullscreen{background:#0a0a14}

/* T-20260927-001: Plyr/video fill — видео/Plyr занимают ВЕСЬ контейнер #media */
#media .plyr{width:100%;height:100%}
#media .plyr__video-wrapper{width:100%;height:100%}
#media .plyr__video-wrapper video{width:100%;height:100%;object-fit:contain}
</style></head>
<body>
<div id="top"><span id="fname" style="color:#fff;font:13px/1 Inter, system-ui, sans-serif;opacity:0.9">Загрузка...</span><span id="fpos" style="color:rgba(255,255,255,0.5);font:12px/1 Inter, system-ui, sans-serif"></span><div class="mwrap" id="qualityWrapTop" style="display:none"><button id="qualityBtnTop" onclick="toggleQualityMenu()">Авто</button><div class="menu" id="qualityMenuTop"></div></div></div>
<button id="close" onclick="window.electronAPI.preview.close(sid)">✕</button>
<div id="loader"></div>
<div id="dl" style="display:none;position:fixed;top:calc(50% + 34px);left:50%;transform:translateX(-50%);z-index:11;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#fff;opacity:0.75;text-shadow:0 1px 3px rgba(0,0,0,0.9);white-space:nowrap;max-width:88%;overflow:hidden;text-overflow:ellipsis;pointer-events:none"></div>
<div id="media"></div>
<div id="error" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#f87171;font:14px/1.4 Inter, system-ui, sans-serif;text-align:center;max-width:80%"></div>
<div id="bar"><button id="playBtn" onclick="togglePlay()">▶</button><div id="progress" onclick="seek(event)"><div id="progressFill"></div></div><span id="time">0:00 / 0:00</span><div class="mwrap" id="qualityWrap" style="display:none"><button id="qualityBtn" onclick="toggleQualityMenu()">Авто</button><div class="menu" id="qualityMenu"></div></div><div class="mwrap"><button id="speedBtn" onclick="toggleSpeedMenu()">1x</button><div class="menu" id="speedMenu"></div></div><button id="muteBtn" onclick="toggleMute()" title="Звук (M)">🔊</button><input type="range" id="vol" min="0" max="100" step="1" value="100" aria-label="Громкость" title="Громкость"><button onclick="toggleFs()" title="Во весь экран">⛶</button></div>
<script>${loadHlsJsInline()}</script>
<script>${loadPlyrJsInline()}</script>
<script>
// T-20260926-001 S1: Plyr availability flag (computed in main process, injected here)
const PLYR_OK = ${loadPlyrJsInline() ? 'true' : 'false'}
let sid = '${winId}'
let total = ${files.length}
let speed = 1
let video = null
// ==== T-20260925-003 S2: HLS + громкость + скорость + качество ====
let hls = null          // текущий экземпляр Hls (null → HLS не активен)
let hlsCappingTimer = null  // таймер для anti-thrash autoLevelCapping release
let loadSeq = 0         // токен навигации: устаревшие async-старты игнорируются
// REWORK#1 F1/F2: messageId текущего видео — нужен для фонового hlsStart и
// для hlsDrop (снятие HLS-сессии при уходе на direct)
let currentMsgId = 0
// ==== T-20260925-010 S2: HLS-first для mov/mkv/avi (hlsPending) ====
// pendingSlow: текущий файл стартует через hlsStart, прямого src у него НЕТ →
// любой «уйди на direct» (нет src) означает fallback на старый путь
// (preview:convert-fallback), а не ошибку «Формат не поддерживается».
let pendingSlow = false
// бюджет готовности HLS для hlsPending-файла: main отвечает ранним master'ом
// (~2-5s, S1), 20s — запас; по истечении или по {error} → convert-fallback
const HLS_PENDING_BUDGET_MS = 45000
let volume = 1
let muted = false
let levelPref = 'auto'  // 'auto' | высота уровня (px) — восстановление после переключения файла
const VOL_KEY = 'rodjer.preview.volume'
const MUTED_KEY = 'rodjer.preview.muted'
const SPEED_KEY = 'rodjer.preview.speed'
const LEVEL_KEY = 'rodjer.preview.level'
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
try { var _pv = parseFloat(localStorage.getItem(VOL_KEY)); if (isFinite(_pv) && _pv >= 0 && _pv <= 1) volume = _pv } catch (e) {}
try { muted = localStorage.getItem(MUTED_KEY) === '1' } catch (e) {}
try { var _ps = parseFloat(localStorage.getItem(SPEED_KEY)); if (SPEEDS.indexOf(_ps) >= 0) speed = _ps } catch (e) {}
try { var _pl = localStorage.getItem(LEVEL_KEY); if (_pl === 'auto') levelPref = 'auto'; else if (_pl === 'original') levelPref = 'original'; else if (parseFloat(_pl) > 0 && isFinite(parseFloat(_pl))) levelPref = parseFloat(_pl) } catch (e) {}

// ==== S3: динамическая лестница качества ====
// Стандартные уровни (высота в пикселях)
const STANDARD_HEIGHTS = [240, 480, 720, 1080, 1440, 2160]
// Текущая лестница качества для текущего файла (заполняется в renderMedia)
let currentQualityLadder = []
// Режим: 'direct' | 'hls'
let qualityMode = 'direct'
// T-20260926-001 S1: Plyr instance (destroy on new file / window close)
let plyrInst = null

/**
 * Строит лестницу качества на основе реальной высоты исходного видео.
 * @param sourceHeight - высота исходного видео в пикселях (0 или undefined = неизвестно)
 * @returns массив объектов { height, label }, где height = 0 означает "Оригинал"
 */
function buildQualityLadder(sourceHeight) {
  if (!sourceHeight || sourceHeight <= 0) {
    return [{ height: 0, label: 'Оригинал' }]
  }
  // Уровни строго МЕНЬШЕ sourceHeight + всегда "Оригинал" (sourceHeight)
  const levels = STANDARD_HEIGHTS.filter(h => h < sourceHeight)
  const result = levels.map(h => ({ height: h, label: h === 2160 ? '4K' : h + 'p' }))
  // Добавляем "Оригинал" в конце
  result.push({ height: 0, label: 'Оригинал' })
  return result
}

function renderMedia(files, idx, src, hlsPending) {
  if (!files || !files[idx]) return
  const f = files[idx]
  const vExt = (f.fileName||'').split('.').pop().toLowerCase()
  const isVideo = ['mp4','mov','mkv','avi','webm'].includes(vExt)
  // T-20260925-003 S2: токен навигации — ответ hlsStart/pro-старты прошлого файла
  // должны быть проигнорированы (пользователь уже ушёл на другой файл)
  loadSeq++
  const token = loadSeq
  destroyHls()
  // T-20260926-001 S1: destroy previous Plyr instance
  if (plyrInst) { try { plyrInst.destroy() } catch (e) {} plyrInst = null }
  // T-20260925-005 S2: новый файл → сбрасываем #dl (download/convert уже кончились)
  dlHideNow()
  // T-20260925-010 S3: сбрасываем #error при смене файла, иначе dlShow-гард
  // заблокирует показ прогресса на следующем файле после ошибки
  var err = document.getElementById('error')
  if (err) { err.textContent = ''; err.style.display = 'none' }
  // T-20260925-010 S2: hlsPending (mov/mkv/avi без готового mp4) → прямого src
  // нет, первый кадр придёт из HLS; до тех пор крутится лоадер + #dl
  pendingSlow = false
  var slow = !!hlsPending && isVideo
  var isStreamSrc = slow || (!!src && src.indexOf('http://127.0.0.1') === 0)
  // mp4/webm stream: progress-событий нет — пока крутится спиннер, показываем
  // «Буферизация…» (скроется в onplaying/oncanplay); hlsPending → своя фраза
  if (isVideo && isStreamSrc) dlShow(slow ? 'Подготовка потока…' : 'Буферизация…')
  var ld = document.getElementById('loader')
  var err = document.getElementById('error')
  var el = document.getElementById('media')
  var bar = document.getElementById('bar')
  // T-20260925-002 S3: нет src (конвертация mov/mkv/avi не удалась / ffmpeg
  // недоступен / сломанный файл) → прячем и loader, иначе спиннер висит вместе
  // с ошибкой (вечный лоадер). Пока src не пришёл (preview:load ждёт скачивание
  // и конвертацию ffmpeg) лоадер крутится по умолчанию — это и есть индикатор
  // долгой конвертации. REWORK#1 F1: для видео с src спиннер снимается по
  // onplaying/oncanplay ПРЯМОГО src (~1-2s) — HLS больше не блокирует первый
  // кадр (hlsStart идёт в фоне, upgrade в startPlayback ниже).
  // T-20260925-010 S2: slow → src у видео появится позже (startHls после
  // {hlsUrl} либо file:// после convert-fallback) — спиннер НЕ снимаем.
  currentMsgId = (isVideo && (src || slow)) ? f.messageId : 0
  if (ld && !isVideo) ld.style.display = 'none'
  if (src || slow) {
    el.innerHTML = ''
    if (isVideo) {
      var vid = document.createElement('video')
      vid.id = 'pv'
      vid.autoplay = true
      // T-20260925-003 S3 / S4: preload=metadata — загружаем только метаданные (длительность, размеры),
      // не качаем весь файл вперёд. Для тяжёлых видео это убирает долгую предзагрузку.
      // T-20260928-004 S2: значение заменено на 'auto' (прогрев буфера для превью).
      vid.preload = 'auto'
      // D6 FIX: width/height 100% + object-fit:contain — растягивает маленькие видео на весь контейнер
      vid.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:4px'
      try { vid.volume = volume; vid.muted = muted } catch (e) {}
      var directTried = false
      vid.onerror = function() {
        // m2 FIX: suppress onerror during upgrade window (vid.src='' → attachMedia)
        if (upgradeInProgress) return
        // media-ошибка при HLS → один раз пробуем прямой src (fallback),
        // дальше — прежняя ошибка «Не удалось загрузить файл»
        if (hls && !directTried) { directTried = true; useDirect(vid, src, token); return }
        // direct-ошибка (HEVC/AV1/неподдерживаемый кодек) → один раз пробуем HLS
        if (!hls && !vid.__hlsErrTried && token === loadSeq && video === vid) {
          vid.__hlsErrTried = true
          //захватываем позицию ДО асинхронного hlsStart — к моменту upgradeToHls
          //vid.currentTime может сброситься (ошибка декода/сети)
          var savedPos = vid.currentTime
          var api = window.electronAPI && window.electronAPI.preview
          if (api && typeof api.hlsStart === 'function' && typeof Hls !== 'undefined' && Hls.isSupported()) {
            api.hlsStart(currentMsgId).then(function (r) {
              if (token !== loadSeq || video !== vid) return
              if (r && r.hlsUrl) { upgradeToHls(vid, r.hlsUrl, src, token, savedPos); return }
              console.log('[hls] error-fallback:', (r && r.error) || 'empty', '→ show error')
              showVideoError('Не удалось загрузить файл')
            }).catch(function (e) {
              if (token !== loadSeq || video !== vid) return
              console.log('[hls] error-fallback rejected:', e && e.message)
              showVideoError('Не удалось загрузить файл')
            })
            return // ждём ответа hlsStart
          }
        }
        if (ld) ld.style.display = 'none'
        dlHideNow()
        if (bar) bar.style.display = 'none'
        if (err) { err.textContent = 'Не удалось загрузить файл'; err.style.display = 'block' }
      }
      el.appendChild(vid)
      video = vid
      // T-20260926-001 S1: Instantiate Plyr if available
      if (PLYR_OK && typeof Plyr !== 'undefined') {
        try {
          // Fixed duration from file object (f.duration in seconds)
          var realDur = (typeof f.duration === 'number' && isFinite(f.duration) && f.duration > 0) ? f.duration : 0
          if (realDur > 0) {
            Object.defineProperty(vid, 'duration', {
              get: function() { return realDur },
              configurable: true
            })
          }
          plyrInst = new Plyr(vid, {
            controls: ['play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'speed', 'settings', 'fullscreen'],
            i18n: {
              restart: 'Перезапуск',
              rewind: 'Назад {seektime}с',
              play: 'Воспроизвести',
              pause: 'Пауза',
              fastForward: 'Вперёд {seektime}с',
              seek: 'Перемотка',
              seekLabel: '{currentTime} из {duration}',
              played: 'Просмотрено',
              buffered: 'Загружено',
              currentTime: 'Текущее время',
              duration: 'Длительность',
              volume: 'Громкость',
              mute: 'Звук выкл',
              unmute: 'Звук вкл',
              enableCaptions: 'Включить субтитры',
              disableCaptions: 'Выключить субтитры',
              download: 'Скачать',
              enterFullscreen: 'Во весь экран',
              exitFullscreen: 'Выйти из полноэкранного',
              frameTitle: 'Плеер для {title}',
              captions: 'Субтитры',
              settings: 'Настройки',
              pip: 'PiP',
              menuBack: 'Назад в меню',
              speed: 'Скорость',
              normal: 'Нормальная',
              quality: 'Качество',
              loop: 'Зациклить',
              start: 'Начало',
              end: 'Конец',
              all: 'Все',
              reset: 'Сброс',
              disabled: 'Отключено',
              enabled: 'Включено',
              advertisement: 'Реклама',
              qualityBadge: {
                2160: '4K',
                1440: '2K',
                1080: '1080p',
                720: '720p',
                576: '576p',
                480: '480p'
              }
            },
            autoplay: vid.autoplay,
            blankVideo: '',
            hideYouTube: true,
            settings: ['quality', 'speed', 'loop']
          })
          // Apply saved volume/muted/speed to Plyr instance
          try { plyrInst.volume = volume } catch (e) {}
          try { plyrInst.muted = muted } catch (e) {}
          try { plyrInst.speed = speed } catch (e) {}
          // Hide native #bar when Plyr is active
          if (bar) bar.style.display = 'none'
        } catch (e) {
          console.log('[plyr] init failed:', e && e.message, '→ fallback to native controls')
          plyrInst = null
          if (bar) bar.style.display = 'flex'
        }
      } else {
        if (!PLYR_OK) console.log('[plyr] inline unavailable → native controls')
        if (bar) bar.style.display = 'flex'
      }
    } else {
      var img = document.createElement('img')
      img.src = src
      img.draggable = false
      // D6 FIX: width/height 100% + object-fit:contain — consistent with video
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:4px'
      img.onerror = function() {
        if (ld) ld.style.display = 'none'
        dlHideNow()
        if (err) { err.textContent = 'Не удалось загрузить файл'; err.style.display = 'block' }
      }
      el.appendChild(img)
      video = null
    }
    if (err) err.style.display = 'none'
  } else {
    if (err) {
      err.textContent = (isVideo ? 'Формат не поддерживается в предпросмотре (нужен mp4/webm):\\n' : 'Не удалось загрузить файл\\n') + f.fileName
      err.style.display = 'block'
    }
    if (ld) ld.style.display = 'none'
    if (bar) bar.style.display = 'none'
    video = null
  }
  document.getElementById('fname').textContent = f.fileName
  document.getElementById('fpos').textContent = (idx + 1) + ' / ' + total
  
  // ==== S3: строим лестницу качества и показываем меню СРАЗУ ====
  if (isVideo) {
    // Получаем высоту из метаданных файла (S2 пробросил width/height)
    // Minor FIX: removed dead/NaN expression (sourceHeight used f.height * f.width / f.height → NaN when height=0)
    const effectiveHeight = f.height || 0
    currentQualityLadder = buildQualityLadder(effectiveHeight)
    qualityMode = slow ? 'hls' : (isStreamSrc ? 'direct' : 'direct')
    // Показываем меню качества всегда для видео (даже в direct-режиме)
    buildQualityMenuFromLadder(currentQualityLadder)
    var qw = document.getElementById('qualityWrap')
    var qwTop = document.getElementById('qualityWrapTop')
    var plyrActive = plyrInst !== null
    if (qw) qw.style.display = plyrActive ? 'none' : 'flex'
    if (qwTop) qwTop.style.display = (plyrActive && qualityMode === 'hls') ? 'flex' : 'none'
  } else {
    var qw = document.getElementById('qualityWrap')
    var qwTop = document.getElementById('qualityWrapTop')
    if (qw) qw.style.display = 'none'
    if (qwTop) qwTop.style.display = 'none'
  }
  
  if (isVideo && video) {
    // bar visibility is handled by Plyr init (hidden when Plyr active, flex when fallback)
    if (!plyrInst) bar.style.display = 'flex'
    video.playbackRate = speed
    // S3: сохраняем messageId на видео для switchToHls
    video.__messageId = f.messageId
    video.ontimeupdate = update
    video.onloadedmetadata = function() { document.getElementById('time').textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration) }
    video.onplay = function() { document.getElementById('playBtn').textContent = '⏸' }
    video.onpause = function() { document.getElementById('playBtn').textContent = '▶' }
    video.onclick = function(e) { e.stopPropagation(); togglePlay() }
    video.onwaiting = function() { var ld = document.getElementById('loader'); if (ld) ld.style.display = 'block'; if (isStreamSrc) dlShow('Буферизация…') }
    video.onplaying = function() { var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'; if (isStreamSrc) dlHideNow() }
    video.oncanplay = function() { var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'; if (isStreamSrc) dlHideNow() }
    // REWORK#1 F1: прямой src ставится сразу (первый кадр), HLS upgrade-ится в фоне
    // T-20260925-010 S2: hlsPending → src нет: сразу в HLS-first (startSlowPlayback)
    if (slow) startSlowPlayback(video, f.messageId, token)
    else startPlayback(video, src, f.messageId, token)
  } else if (!isVideo && bar) {
    bar.style.display = 'none'
  }
}
function showError(msg) {
  var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'
  dlHideNow()
  var err = document.getElementById('error'); if (err) { err.textContent = 'Ошибка: ' + msg; err.style.display = 'block' }
}
function showVideoError(msg) {
  var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'
  dlHideNow()
  var bar = document.getElementById('bar'); if (bar) bar.style.display = 'none'
  var err = document.getElementById('error'); if (err) { err.textContent = msg || 'Не удалось загрузить файл'; err.style.display = 'block' }
}
// T-20260925-010 S2: у hlsPending-файла src появляется позже (HLS/file://) —
// play() без src дал бы rejected promise без слушателя
function togglePlay() { if (!video) return; if (!video.getAttribute('src')) return; if (video.paused) video.play(); else video.pause() }
// duration=Infinity у live-плейлиста (ffmpeg ещё дописывает ENDLIST) — иначе «Infinity:NaN»
function update() { if (!video||!video.duration||!isFinite(video.duration)) return; document.getElementById('progressFill').style.width = (video.currentTime/video.duration*100)+'%'; document.getElementById('time').textContent = fmt(video.currentTime)+' / '+fmt(video.duration) }
function seek(e) { if (!video||!video.duration||!isFinite(video.duration)) return; var r=e.currentTarget.getBoundingClientRect(); video.currentTime = ((e.clientX-r.left)/r.width)*video.duration }
function fmt(t) { if (!t||!isFinite(t)) return '0:00'; var m=Math.floor(t/60),s=Math.floor(t%60); return m+':'+(s<10?'0':'')+s }

// ==== T-20260925-005 S2: #dl — строка прогресса под спиннером ====
// фазы: download (процент+ETA / байты), convert (текст), stream (буферизация)
var dlSamples = []
var dlHideTimer = null
function fmtSizeT(b) {
  if (!b || !isFinite(b) || b <= 0) return '0 B'
  var u = ['B', 'KB', 'MB', 'GB', 'TB']
  var i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1)
  return parseFloat((b / Math.pow(1024, i)).toFixed(1)) + ' ' + u[i]
}
function dlShow(text) {
  var err = document.getElementById('error')
  if (err && err.style.display === 'block' && err.textContent && err.textContent.trim() !== '') return
  if (dlHideTimer) { clearTimeout(dlHideTimer); dlHideTimer = null }
  var el = document.getElementById('dl'); if (!el) return
  if (el.textContent !== text) el.textContent = text
  el.style.display = 'block'
}
function dlHideNow() {
  if (dlHideTimer) { clearTimeout(dlHideTimer); dlHideTimer = null }
  dlSamples = []
  var el = document.getElementById('dl'); if (el) el.style.display = 'none'
}
// скачивание завершено (sent >= total) → прячем через 500ms;
// следующая фаза (convert) или новый файл отменяет таймер (dlShow/dlHideNow)
function dlHideSoon() {
  if (dlHideTimer) return
  dlHideTimer = setTimeout(function () {
    dlHideTimer = null
    var el = document.getElementById('dl'); if (el) el.style.display = 'none'
  }, 500)
}
function onPreviewProgress(d) {
  if (!d) return
  if (d.phase === 'convert') { dlSamples = []; dlShow('Конвертация видео…'); return }
  var sent = Number(d.sent) || 0
  var total = Number(d.total) || 0
  var now = Date.now()
  // события предыдущего файла (навигация) — начинаем накопление заново
  if (dlSamples.length && sent + 4096 < dlSamples[dlSamples.length - 1].sent) dlSamples = []
  dlSamples.push({ ts: now, sent: sent })
  while (dlSamples.length > 1 && now - dlSamples[0].ts > 6000) dlSamples.shift()
  if (total > 0 && sent >= total) { dlShow('Загрузка 100%'); dlHideSoon(); return }
  // ETA по скользящему окну ~6s (сэмплы {ts,sent}); speed=0 → только процент/байты
  var speed = 0
  if (dlSamples.length > 1) {
    var dt = (now - dlSamples[0].ts) / 1000
    if (dt >= 1) speed = Math.max(0, (sent - dlSamples[0].sent) / dt)
  }
  if (total > 0) {
    var pct = Math.min(100, Math.floor(sent / total * 100))
    var eta = speed > 0 ? (total - sent) / speed : 0
    if (eta >= 1) dlShow('Загрузка ' + pct + '% · осталось ' + fmt(eta))
    else if (pct > 0) dlShow('Загрузка ' + pct + '%')
    else dlShow('Загрузка ' + fmtSizeT(sent) + ' из ' + fmtSizeT(total))
  } else {
    dlShow('Загрузка ' + fmtSizeT(sent))
  }
}

// ==== T-20260925-003 S2 + REWORK#1 F1: HLS (hls.js) поверх прямого src ====
function destroyHls() {
  if (hls) { try { hls.destroy() } catch (e) {} hls = null }
  if (hlsCappingTimer) { clearInterval(hlsCappingTimer); hlsCappingTimer = null }
  // S3: НЕ прячем меню качества — оно теперь всегда видно для видео
  // (прячем только при навигации на не-видео, см. renderMedia)
}
// REWORK#1 F2: снять HLS-сессию этого файла в main (kill ffmpeg + rm каталога)
// ВАЖНО (F6 принят как minor): refcount-а нет — если тот же файл открыт во
// втором окне, его сегменты начнут отдавать 404 (его hls.js сам уйдёт в
// fallback на direct — graceful, без белого экрана)
function dropHlsSession() {
  var api = window.electronAPI && window.electronAPI.preview
  if (!api || typeof api.hlsDrop !== 'function' || !currentMsgId) return
  try { var dp = api.hlsDrop(currentMsgId); if (dp && dp.catch) dp.catch(function () {}) } catch (e) {}
}
// прямой src — ровно как до S2 (http-stream / file://), меню качества скрыто.
  // Общая для стартa (F1: мгновенный первый кадр) и fallback-а после HLS.
  // S4: preload=metadata — не качаем весь файл вперёд для тяжёлых видео.
  // T-20260928-004 S2: значение заменено на 'auto' (прогрев буфера для превью).
  function applyDirectSrc(vid, src) {
    if (!src) { showVideoError('Формат не поддерживается в предпросмотре (нужен mp4/webm)'); return }
    try { vid.pause() } catch (e) {}
    vid.src = src
    vid.autoplay = true
    vid.preload = 'auto'
    vid.playbackRate = speed
    applyVol()
    var p = vid.play()
    if (p && p.catch) {
      p.catch(function (err) {
        // D2 FIX: Handle autoplay policy rejection for direct playback too
        if (err && err.name === 'NotAllowedError') {
          console.log('[direct] autoplay blocked, waiting for user interaction or canplay')
          var onCanPlay = function () {
            vid.removeEventListener('canplay', onCanPlay)
            document.removeEventListener('click', onUserInteraction)
            document.removeEventListener('keydown', onUserInteraction)
            vid.play().catch(function () {})
          }
          var onUserInteraction = function () {
            vid.removeEventListener('canplay', onCanPlay)
            document.removeEventListener('click', onUserInteraction)
            document.removeEventListener('keydown', onUserInteraction)
            vid.play().catch(function () {})
          }
          vid.addEventListener('canplay', onCanPlay, { once: true })
          document.addEventListener('click', onUserInteraction, { once: true, passive: true })
          document.addEventListener('keydown', onUserInteraction, { once: true, passive: true })
        }
        var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'; dlHideNow()
      })
    }
  }
// старт воспроизведения: прямой src ставится МГНОВЕННО — первый кадр не ждёт
// транскод/HLS. HLS запускается ТОЛЬКО по требованию (меню качества) или как
// fallback при ошибке direct (HEVC/AV1/неподдерживаемые кодеки).
function startPlayback(vid, src, messageId, token) {
  currentMsgId = messageId
  applyDirectSrc(vid, src)
  // token сохраняется для возможного fallback-а в onerror (vid.__hlsErrTried guard)
}

// ==== T-20260925-010 S2: HLS-first старт для mov/mkv/avi (hlsPending) ====
// Прямого src у таких файлов НЕТ (Chromium не декодирует контейнер, а качать
// и конвертировать в лоб больше не хотим) → сразу в main за HLS-сессией:
// спиннер крутится, #dl показывает «Подготовка потока…» (фазы download/convert
// приходят как preview:progress из resolveInput-fallback и convert-fallback).
// Бюджет HLS_PENDING_BUDGET_MS (20s): ни {hlsUrl}, ни {error} → старый путь
// через preview:convert-fallback. main при этом отвечает ранним master'ом (~2-5s).
function startSlowPlayback(vid, messageId, token) {
  currentMsgId = messageId
  pendingSlow = true
  dlShow('Подготовка потока…')
  var api = window.electronAPI && window.electronAPI.preview
  if (!api || typeof api.hlsStart !== 'function' || typeof Hls === 'undefined' || !Hls.isSupported()) {
    // hls.js недоступен → сразу старый путь (файл обязан воспроизвестись)
    runConvertFallback(vid, token, 'no-hlsjs')
    return
  }
  var settled = false
  var budget = setTimeout(function () {
    if (settled || token !== loadSeq || video !== vid) return
    settled = true
    runConvertFallback(vid, token, 'budget-20s')
  }, HLS_PENDING_BUDGET_MS)
  var done = function () { settled = true; clearTimeout(budget) }
  try {
    api.hlsStart(messageId).then(function (r) {
      if (token !== loadSeq || video !== vid) return // пользователь ушёл на другой файл
      if (settled) return
      done()
      if (r && r.hlsUrl) {
        console.log('[hls] slow-start ready → ' + r.hlsUrl)
        pendingSlow = false
        // Minor FIX: startHls signature is (vid, url, src, token, up, targetHeight) — 6 args
        startHls(vid, r.hlsUrl, '', token, null, null)
        return
      }
      console.log('[hls] slow-start:', (r && r.error) || 'empty', '→ convert-fallback')
      runConvertFallback(vid, token, (r && r.error) || 'hls-error')
    }).catch(function (e) {
      if (settled || token !== loadSeq || video !== vid) return
      done()
      console.log('[hls] slow-start rejected:', e && e.message)
      runConvertFallback(vid, token, 'reject')
    })
  } catch (e) {
    clearTimeout(budget)
    runConvertFallback(vid, token, 'throw')
  }
}
// Старый путь mov/mkv/avi: preview:convert-fallback → file:// src → играем.
// Вызывается при {error}/reject от hlsStart, по бюджету 20s и при попытке
// «уйти на direct» без src (useDirect ниже). Сессию HLS снимаем — слот из 2
// и CPU освобождаются, дубль качки исключён (downloadPreviewSourceOnce в main).
function runConvertFallback(vid, token, why) {
  if (token !== loadSeq || video !== vid) return
  if (vid.__convFallback) return // fallback ровно один раз на файл
  vid.__convFallback = true
  console.log('[hls] convert-fallback via ' + why)
  dropHlsSession()
  var api = window.electronAPI && window.electronAPI.preview
  if (!api || typeof api.convertFallback !== 'function') { showVideoError('Не удалось загрузить файл'); return }
  api.convertFallback(sid, currentMsgId).then(function (r) {
    if (token !== loadSeq || video !== vid) return
    if (r && r.src) {
      pendingSlow = false
      console.log('[hls] convert-fallback ready → file://')
      applyDirectSrc(vid, r.src)
      return
    }
    console.log('[hls] convert-fallback:', (r && r.error) || 'empty')
    showVideoError('Не удалось загрузить файл')
  }).catch(function (e) {
    if (token !== loadSeq || video !== vid) return
    console.log('[hls] convert-fallback rejected:', e && e.message)
    showVideoError('Не удалось загрузить файл')
  })
}
// REWORK#1 F1: фоновый upgrade direct→HLS — видео уже играет по прямому src
function upgradeToHls(vid, url, src, token, savedPos) {
  if (token !== loadSeq || video !== vid) return
  if (hls) return // upgrade ровно один раз
  // позиция/playing снимаются в момент ответа main; volume/playbackRate живут
  // на элементе и переприменяются в MANIFEST_PARSED (applyVol / playbackRate)
  // savedPos захвачен ВЫЗЫВАЮЩИМ кодом ДО асинхронного hlsStart — защита от сброса
  // currentTime при ошибке декода/сети. fallback на vid.currentTime если не передано.
  var pos = (typeof savedPos === 'number' && !isNaN(savedPos) && savedPos > 0) ? savedPos : vid.currentTime
  var up = { saved: pos, wasPlaying: !vid.paused, userSeek: null, seekListener: null, restoring: false }
  console.log('[hls] upgrade t=' + up.saved.toFixed(2) + ' playing=' + up.wasPlaying)
  startHls(vid, url, src, token, up, null)
}

// upgradeToHls с предварительно выбранным уровнем (для switchToHls)
function upgradeToHlsWithLevel(vid, url, src, targetHeight, token, savedPos) {
  if (hls) return
  var pos = (typeof savedPos === 'number' && !isNaN(savedPos) && savedPos > 0) ? savedPos : vid.currentTime
  var up = { saved: pos, wasPlaying: !vid.paused, userSeek: null, seekListener: null, restoring: false }
  console.log('[hls] upgrade with level ' + targetHeight + ' t=' + up.saved.toFixed(2))
  startHls(vid, url, src, token, up, targetHeight)
}

// applyUpgradeSeek: рекурсивные попытки seek после загрузки метаданных (duration известен),
// чтобы Chrome не clamp-ил позицию к seekable end. Макс 80 × 250ms ≈ 20s.
function applyUpgradeSeek(vid, up, target) {
  if (!isFinite(vid.duration) || vid.duration <= 0) {
    // metadata ещё не загружен — ждём
    setTimeout(function () {
      if (video !== vid) return // устаревший элемент
      applyUpgradeSeek(vid, up, target)
    }, 250)
    return
  }
  // metadata загружен — можно безопасно ставить currentTime
  up.restoring = true
  try { vid.currentTime = target } catch (e) {}
  // страховка: если Chrome всё равно clamp-ил — повтор через 400ms (макс 80 попыток суммарно)
  setTimeout(function () {
    up.restoring = false
    if (video !== vid) return
    if (Math.abs(vid.currentTime - target) > 1.5) {
      applyUpgradeSeek(vid, up, target)
    }
  }, 600)
}

// m2 FIX: upgradeInProgress flag to suppress onerror during direct→HLS upgrade window
  // (between vid.src='' + load() and hls.attachMedia(vid))
  var upgradeInProgress = false

  // запуск hls.js; up (upgrade-режим) — { saved, wasPlaying, userSeek, seekListener },
  // для первоначального старта не передаётся
  // targetHeight: если задан (не null), применяется после MANIFEST_PARSED
  // S4: при upgrade (up задан) прерываем прямой стрим (vid.src → '' + load()),
  // чтобы браузер отменил HTTP-запрос к /stream/<id> и не качал байты впустую
  // параллельно с ffmpeg, читающим тот же источник.
  function startHls(vid, url, src, token, up, targetHeight) {
    if (up) {
      // Upgrade из direct: прерываем текущий прямой стрим до attachMedia,
      // иначе браузер продолжает качать /stream/<id> параллельно с ffmpeg.
      try { vid.pause() } catch (e) {}
      upgradeInProgress = true
      vid.src = ''
      vid.load()
    }
    destroyHls()
    // F1 FIX: startLevel=0 forces hls.js to start with lowest quality (240p, ready in ~1ms)
    // abrEwmaDefaultEstimate prevents ABR from jumping to highest level immediately
    // F6 FIX: maxBufferLength/maxMaxBufferLength allow large forward buffer to prevent stutter
    // fragLoadingTimeOut/MaxRetry increase resilience to slow segment fetches (Telegram flood-wait)
    var inst = new Hls({
      enableWorker: true,
      backBufferLength: 60,
      startLevel: 0,
      abrEwmaDefaultEstimate: 500000,
      maxBufferLength: 60,
      maxMaxBufferLength: 180,
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 30000,
          timeoutRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: 'exponential' }
        }
      }
    })
    hls = inst
    // R5b: anti-thrash — hold at level0 until buffer cushion + time gate
    inst.autoLevelCapping = 0
    var hlsStartTime = Date.now()
    var cappingReleased = false
    if (hlsCappingTimer) { clearInterval(hlsCappingTimer) }
    hlsCappingTimer = setInterval(function () {
      if (cappingReleased || token !== loadSeq || hls !== inst || !vid || vid.buffered.length === 0) return
      var bufferedEnd = vid.buffered.end(vid.buffered.length - 1)
      var cushion = bufferedEnd - vid.currentTime
      var elapsed = Date.now() - hlsStartTime
      if (cushion >= 15 && elapsed >= 5000) {
        cappingReleased = true
        clearInterval(hlsCappingTimer)
        hlsCappingTimer = null
        try { inst.autoLevelCapping = -1 } catch (e) {}
      }
    }, 500)
    var retries = 0
    var cleanupSeek = function () {
      if (up && up.seekListener) { try { vid.removeEventListener('seeking', up.seekListener) } catch (e) {} up.seekListener = null }
    }
    // m1 FIX: wrap in try/finally to ensure upgradeInProgress is always reset,
    // even if Hls constructor or loadSource/attachMedia throws (async media error
    // arrives after flag would be cleared in happy path)
    try {
      // страховка: манифест не пришёл → снимаем спиннер и играем напрямую
      var manifestTimer = setTimeout(function () {
        if (token !== loadSeq || hls !== inst) return
        console.log('[hls] manifest timeout → direct src')
        cleanupSeek()
        upgradeInProgress = false
        useDirect(vid, src, token)
      }, 30000)
      inst.on(Hls.Events.MANIFEST_PARSED, function () {
        clearTimeout(manifestTimer)
        if (token !== loadSeq || video !== vid) return
        cleanupSeek()
        var levels = inst.levels || []
        qualityMode = 'hls'
        updateQualityMenuVisibility()
        // S3 REWORK: f.height на первом открытии может быть ещё 0 (пробе HLS
        // как раз его и записывает) — меню выходило только с «Оригинал».
        // Пересобираем лестницу из РЕАЛЬНЫХ уровней master-плейлиста:
        // транскоды несут height+NAME, «Оригинал» идёт без RESOLUTION (height=0).
        var seenH = {}
        var rebuilt = []
        for (var j = 0; j < levels.length; j++) {
          var lh = levels[j].height || 0
          var lkey = lh === 0 ? 'orig' : String(lh)
          if (seenH[lkey]) continue
          seenH[lkey] = true
          rebuilt.push({ height: lh, label: lh === 0 ? 'Оригинал' : (levels[j].name || lh + 'p') })
        }
        rebuilt.sort(function (a, b) { return (a.height === 0 ? 1e9 : a.height) - (b.height === 0 ? 1e9 : b.height) })
        if (rebuilt.length) currentQualityLadder = rebuilt
        buildQualityMenuFromLadder(currentQualityLadder)
        // Применяем сохранённый преф или targetHeight
        if (targetHeight !== null) {
          // Ищем уровень с нужной высотой (upgrade из direct / switchToHls)
          for (var i = 0; i < levels.length; i++) {
            if (levels[i].height === targetHeight) {
              try { hls.currentLevel = i } catch (e) {}
              // Use 'original' sentinel for height=0 (original stream), numeric height otherwise
              levelPref = targetHeight === 0 ? 'original' : targetHeight
              try { localStorage.setItem(LEVEL_KEY, levelPref === 'original' ? 'original' : String(targetHeight)) } catch (e) {}
              break
            }
          }
        } else {
          // F1 FIX: Defer saved levelPref until first frame (canplay/FRAG_BUFFERED).
          // Start with startLevel=0 (240p, ready in ~1ms) for fastest first frame.
          // After first frame, seamlessly upswitch to saved quality (buffer already growing).
          var levelPrefApplied = false
          var applySavedLevelPref = function () {
            if (levelPrefApplied || !hls || hls !== inst) return
            levelPrefApplied = true
            applyLevelPref()
            console.log('[hls] saved levelPref applied on first frame:', levelPref)
          }
          // Apply on first canplay (first frame ready) or first FRAG_BUFFERED with data
          vid.addEventListener('canplay', applySavedLevelPref, { once: true })
          inst.on(Hls.Events.FRAG_BUFFERED, function onFirstFrag() {
            if (token !== loadSeq || video !== vid) return
            // Only apply if we have actual buffered data (rs > 0 check via buffered.length)
            if (vid.buffered && vid.buffered.length > 0) {
              inst.off(Hls.Events.FRAG_BUFFERED, onFirstFrag)
              applySavedLevelPref()
            }
          })
        }
        applyVol()
        vid.playbackRate = speed
        
        // F4 FIX: Autoplay handling - retry on ANY play() error (not just NotAllowedError)
        // Track user-initiated pause to avoid auto-playing after manual pause
        var userPaused = false
        vid.addEventListener('pause', function onUserPause() {
          if (!up.restoring) userPaused = true
        })
        
        var tryPlay = function () {
          var p = vid.play()
          if (p && p.catch) {
            p.catch(function (err) {
              // F4 FIX: Handle ANY autoplay rejection - retry on canplay/loadeddata/user interaction
              console.log('[hls] autoplay failed:', err && err.name, '→ will retry on canplay/loadeddata/interaction')
              var retried = false
              var retryPlay = function () {
                if (retried || userPaused) return
                retried = true
                vid.play().catch(function () {})
              }
              // Retry once on canplay or loadeddata (data available)
              vid.addEventListener('canplay', retryPlay, { once: true })
              vid.addEventListener('loadeddata', retryPlay, { once: true })
              // Also retry on user interaction
              var onUserInteraction = function () {
                if (retried) return
                retryPlay()
              }
              document.addEventListener('click', onUserInteraction, { once: true, passive: true })
              document.addEventListener('keydown', onUserInteraction, { once: true, passive: true })
              var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none'
            })
          }
        }
        
        // F4 FIX: Also retry play on hls.js FRAG_BUFFERED if video is paused and not user-paused
        inst.on(Hls.Events.FRAG_BUFFERED, function () {
          if (token !== loadSeq || video !== vid) return
          if (vid.paused && !userPaused) {
            console.log('[hls] FRAG_BUFFERED but paused → retry play')
            vid.play().catch(function () {})
          }
        })
        
        if (up) {
          // REWORK#1 F1: возвращаем позицию через applyUpgradeSeek — ждём metadata
          // (duration > 0), чтобы Chrome не clamp-ил seek к seekable end.
          // userSeek приоритетен, если пользователь перемотал (>0.5s), иначе saved.
          var target = (up.userSeek != null && up.userSeek > 0.5) ? up.userSeek : up.saved
          if (target > 0) applyUpgradeSeek(vid, up, target)
          if (up.wasPlaying) {
            tryPlay()
          } else {
            var pb = document.getElementById('playBtn'); if (pb) pb.textContent = '▶'
          }
          update()
        } else {
          // D2 FIX: Initial HLS start (HLS-first path) - always attempt autoplay
          tryPlay()
        }
      })
      inst.on(Hls.Events.LEVEL_SWITCHED, function () { if (token === loadSeq && hls === inst) markQualityFromLadder() })
      
      inst.on(Hls.Events.ERROR, function (evt, data) {
        if (!data || !data.fatal) return
        console.log('[hls] fatal:', data.type, data.details)
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retries < 2) { retries++; try { inst.startLoad() } catch (e) {} return }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retries < 2) { retries++; try { inst.recoverMediaError() } catch (e) {} return }
        clearTimeout(manifestTimer)
        cleanupSeek()
        upgradeInProgress = false
        useDirect(vid, src, token)
      })
      inst.loadSource(url)
      inst.attachMedia(vid)
    } finally {
      // m1 FIX: always reset upgradeInProgress, even on exception
      upgradeInProgress = false
    }
    if (up) {
      // слушатель вешаем ПОСЛЕ attach: события самого attach не считаем, а вот
      // перемотку пользователя до MANIFEST_PARSED — ловим (его позиция важнее saved)
      // Игнорируем seeking во время нашего восстановления позиции (up.restoring)
      // и слишком маленькие currentTime (<0.5s) — это шум от attach/load.
      up.seekListener = function () {
        if (up.restoring) return
        var t = vid.currentTime
        if (t > 0.5) up.userSeek = t
      }
      try { vid.addEventListener('seeking', up.seekListener) } catch (e) {}
    }
  }
// direct после отмены upgrade: hls.js мог заменить src на blob → возвращаем
// прямой src и позицию (REWORK#1 F1: single-variant путь)
function restoreDirect(vid, src, up) {
  applyDirectSrc(vid, src)
  if (!up) return
  var target = up.userSeek != null ? up.userSeek : up.saved
  if (!(target > 0)) return
  var seekNow = function () { try { vid.currentTime = target } catch (e) {} vid.removeEventListener('loadedmetadata', seekNow) }
  if (vid.readyState > 0) seekNow()
  else vid.addEventListener('loadedmetadata', seekNow)
}
// прямой src как fallback после активного HLS (REWORK#1 F2: сессию снимаем)
function useDirect(vid, src, token) {
  if (token !== loadSeq || video !== vid) return
  var hadHls = !!hls
  destroyHls()
  qualityMode = 'direct' // S3: сброс режима качества
  buildQualityMenuFromLadder(currentQualityLadder)
  updateQualityMenuVisibility()
  if (!src) {
    // T-20260925-010 S2: src у hlsPending-файла так и не появился — HLS не
    // состоялся (манифест/медиа-ошибка) → старый путь, а не «формат не поддерживается»
    if (pendingSlow) { runConvertFallback(vid, token, 'direct-without-src'); return }
    showVideoError('Формат не поддерживается в предпросмотре (нужен mp4/webm)'); return
  }
  applyDirectSrc(vid, src)
  // REWORK#1 F2: HLS-сессия была активна, а мы ушли на direct (fatal/timeout/
  // ошибка манифеста) → она больше не используется → kill ffmpeg + rm каталога,
  // иначе транскод доедает файл впустую и занимает 1 из 2 слотов
  if (hadHls) dropHlsSession()
}

// ==== меню: скорость ====
function closeMenus() {
  var ms = document.querySelectorAll('.menu')
  for (var i = 0; i < ms.length; i++) ms[i].classList.remove('open')
}
function toggleMenu(menuId) {
  var m = document.getElementById(menuId)
  var wasOpen = m.classList.contains('open')
  closeMenus()
  if (!wasOpen) m.classList.add('open')
}
function buildSpeedMenu() {
  var m = document.getElementById('speedMenu')
  m.innerHTML = ''
  for (var i = 0; i < SPEEDS.length; i++) {
    (function (s) {
      var d = document.createElement('div')
      d.innerHTML = '<span>' + s + 'x</span><span class="chk">' + (s === speed ? '✓' : '') + '</span>'
      d.onclick = function () { setSpeed(s); closeMenus() }
      m.appendChild(d)
    })(SPEEDS[i])
  }
}
function toggleSpeedMenu() { buildSpeedMenu(); toggleMenu('speedMenu') }
function setSpeed(s) {
  speed = s
  try { localStorage.setItem(SPEED_KEY, String(s)) } catch (e) {}
  document.getElementById('speedBtn').textContent = s + 'x'
  if (video) video.playbackRate = s
}

// ==== меню: качество (S3: всегда видно для видео, ленивый переход direct→HLS) ====
function toggleQualityMenu() { 
  // Use top menu when Plyr is active, fallback menu otherwise
  var plyrActive = plyrInst !== null
  toggleMenu(plyrActive ? 'qualityMenuTop' : 'qualityMenu') 
}

// Строит меню из заранее известной лестницы качества (currentQualityLadder)
function buildQualityMenuFromLadder(ladder) {
  // Build for fallback menu (#bar)
  var m = document.getElementById('qualityMenu')
  if (m) {
    m.innerHTML = ''
    // Пункт "Авто" — только в HLS-режиме (ABR работает только с hls.js)
    if (qualityMode === 'hls') {
      var auto = document.createElement('div')
      auto.setAttribute('data-h', 'auto')
      auto.innerHTML = '<span>Авто</span><span class="chk"></span>'
      auto.onclick = function () { pickAutoLevel(); closeMenus() }
      m.appendChild(auto)
    }
    // Уровни из лестницы (уже отсортированы: низкие → высокие, "Оригинал" в конце)
    // В меню показываем в обратном порядке (высокие сверху), как в Telegram
    for (var i = ladder.length - 1; i >= 0; i--) {
      (function (level) {
        var d = document.createElement('div')
        var isOriginal = level.height === 0
        d.setAttribute('data-h', isOriginal ? 'original' : String(level.height))
        d.innerHTML = '<span>' + level.label + '</span><span class="chk"></span>'
        d.onclick = function () { pickLevelFromLadder(level, isOriginal); closeMenus() }
        m.appendChild(d)
      })(ladder[i])
    }
  }
  // Build for top menu (Plyr active)
  var mTop = document.getElementById('qualityMenuTop')
  if (mTop) {
    mTop.innerHTML = ''
    if (qualityMode === 'hls') {
      var auto = document.createElement('div')
      auto.setAttribute('data-h', 'auto')
      auto.innerHTML = '<span>Авто</span><span class="chk"></span>'
      auto.onclick = function () { pickAutoLevel(); closeMenus() }
      mTop.appendChild(auto)
    }
    for (var i = ladder.length - 1; i >= 0; i--) {
      (function (level) {
        var d = document.createElement('div')
        var isOriginal = level.height === 0
        d.setAttribute('data-h', isOriginal ? 'original' : String(level.height))
        d.innerHTML = '<span>' + level.label + '</span><span class="chk"></span>'
        d.onclick = function () { pickLevelFromLadder(level, isOriginal); closeMenus() }
        mTop.appendChild(d)
      })(ladder[i])
    }
  }
  markQualityFromLadder()
}

// M1 FIX: pickAutoLevel replaces deleted pickLevel(-1, null) for "Авто" button
function pickAutoLevel() {
  levelPref = 'auto'
  try { localStorage.setItem(LEVEL_KEY, 'auto') } catch (e) {}
  
  if (qualityMode === 'hls' && hls) {
    try { hls.currentLevel = -1 } catch (e) {} // enable ABR
  }
  markQualityFromLadder()
}

// Выбор уровня из лестницы (работает и в direct, и в hls режиме)
function pickLevelFromLadder(level, isOriginal) {
  var targetHeight = isOriginal ? 0 : level.height
  levelPref = isOriginal ? 'original' : targetHeight
  try { localStorage.setItem(LEVEL_KEY, levelPref) } catch (e) {}
  
  if (qualityMode === 'direct' && !isOriginal) {
    // В direct-режиме выбор качества ≠ "Оригинал" → переключаемся на HLS
    switchToHls(targetHeight)
    return
  }
  
  if (qualityMode === 'hls' && hls) {
    // В HLS-режиме ищем соответствующий уровень в hls.levels
    var hlsLevels = hls.levels || []
    for (var i = 0; i < hlsLevels.length; i++) {
      if (hlsLevels[i].height === targetHeight) {
        try { hls.currentLevel = i } catch (e) {}
        break
      }
    }
    // M5 FIX: "Оригинал" (height=0) should select the "Оригинал" level in hls.levels,
    // not enable ABR (currentLevel=-1). Find level with height===0 (original stream).
    if (isOriginal) {
      for (var i = 0; i < hlsLevels.length; i++) {
        if (hlsLevels[i].height === 0) {
          try { hls.currentLevel = i } catch (e) {}
          break
        }
      }
    }
  }
  markQualityFromLadder()
}

// B2 FIX: Restore applyLevelPref() from HEAD - applies saved levelPref after MANIFEST_PARSED
function applyLevelPref() {
  if (!hls || !hls.levels) return
  if (levelPref === 'auto') { if (!hls.autoLevelEnabled) hls.currentLevel = -1; return }
  if (levelPref === 'original') {
    // Find level with height===0 (original stream)
    for (var i = 0; i < hls.levels.length; i++) {
      if (hls.levels[i].height === 0) { hls.currentLevel = i; return }
    }
    return
  }
  for (var i = 0; i < hls.levels.length; i++) {
    if (hls.levels[i].height === levelPref) { hls.currentLevel = i; return }
  }
}

// Обновляет подпись кнопки и чекмарки в меню на основе currentQualityLadder + levelPref
function markQualityFromLadder() {
  // Update fallback menu (#bar)
  var btn = document.getElementById('qualityBtn')
  var m = document.getElementById('qualityMenu')
  if (btn && m) {
    updateQualityMenu(btn, m)
  }
  // Update top menu (Plyr active)
  var btnTop = document.getElementById('qualityBtnTop')
  var mTop = document.getElementById('qualityMenuTop')
  if (btnTop && mTop) {
    updateQualityMenu(btnTop, mTop)
  }
}

function updateQualityMenu(btn, m) {
  var label = 'Авто'
  if (qualityMode === 'hls' && hls && !hls.autoLevelEnabled && hls.currentLevel >= 0 && hls.levels && hls.levels[hls.currentLevel]) {
    var activeLevel = hls.levels[hls.currentLevel]
    if (activeLevel.height === 0) {
      label = 'Оригинал'
    } else if (activeLevel.height) {
      label = activeLevel.height + 'p'
    }
  } else if (qualityMode === 'direct') {
    // В direct-режиме показываем сохранённый преф или "Авто"
    if (levelPref === 'original') {
      label = 'Оригинал'
    } else if (levelPref !== 'auto') {
      label = levelPref + 'p'
    }
  }
  btn.textContent = label
  
  var items = m.children
  for (var i = 0; i < items.length; i++) {
    var it = items[i]
    var hAttr = it.getAttribute('data-h')
    var on = false
    if (hAttr === 'original') {
      on = (levelPref === 'original')
    } else if (hAttr === 'auto') {
      on = (levelPref === 'auto')
    } else if (hAttr !== null) {
      var h = parseInt(hAttr, 10)
      on = (levelPref !== 'auto' && levelPref !== 'original' && levelPref === h)
    }
    var chk = it.querySelector('.chk')
    if (chk) chk.textContent = on ? '✓' : ''
  }
}

// Helper to update quality menu visibility based on Plyr state and qualityMode
function updateQualityMenuVisibility() {
  var qw = document.getElementById('qualityWrap')
  var qwTop = document.getElementById('qualityWrapTop')
  var plyrActive = plyrInst !== null
  if (qw) qw.style.display = plyrActive ? 'none' : 'flex'
  if (qwTop) qwTop.style.display = (plyrActive && qualityMode === 'hls') ? 'flex' : 'none'
}

// Переключение из direct в HLS с выбранным качеством
function switchToHls(targetHeight) {
  if (!video || !video.src) return
  var src = video.src
  var api = window.electronAPI && window.electronAPI.preview
  if (!api || typeof api.hlsStart !== 'function' || typeof Hls === 'undefined' || !Hls.isSupported()) return
  
  qualityMode = 'hls'
  updateQualityMenuVisibility()
  currentMsgId = video.__messageId || 0
  if (!currentMsgId) return
  
  // M8 FIX: capture token/vid for race check (like upgradeToHls at line 2600)
  // Захватываем позицию ДО асинхронного hlsStart — защита от сброса currentTime
  var token = loadSeq
  var vid = video
  var savedPos = vid.currentTime
  
// Запускаем HLS-сессию
  api.hlsStart(currentMsgId).then(function (r) {
    // M8 FIX: check if user navigated away during hlsStart
    if (token !== loadSeq || video !== vid) return
    if (r && r.hlsUrl) {
      upgradeToHlsWithLevel(video, r.hlsUrl, src, targetHeight, token, savedPos)
    } else {
      console.log('[hls] switchToHls failed:', r && r.error)
      qualityMode = 'direct'
      buildQualityMenuFromLadder(currentQualityLadder)
    }
  }).catch(function (e) {
    if (token !== loadSeq || video !== vid) return
    console.log('[hls] switchToHls error:', e && e.message)
    qualityMode = 'direct'
    buildQualityMenuFromLadder(currentQualityLadder)
  })
}

// B3 FIX: Removed duplicate upgradeToHlsWithLevel (kept the one at ~line 2610).
// Fixed call to use startHls (not non-existent startHlsWithLevel).
// Signature: startHls(vid, url, src, token, up, targetHeight)

// ==== громкость / mute (персист rodjer.preview.volume|muted) ====
function applyVol() {
  if (video) { try { video.volume = volume; video.muted = muted } catch (e) {} }
  var mb = document.getElementById('muteBtn')
  if (mb) mb.textContent = (muted || volume === 0) ? '🔇' : (volume < 0.5 ? '🔉' : '🔊')
  var vs = document.getElementById('vol')
  if (vs) {
    var pct = Math.round((muted ? 0 : volume) * 100)
    // value всегда равен volume*100 (setVolume берёт его же) → присвоение
    // не дёргает input-событие и не мешает pointer-drag
    vs.value = String(pct)
    vs.style.setProperty('--vp', pct + '%')
  }
}
function setVolume(v) {
  volume = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100
  if (volume > 0) muted = false
  try { localStorage.setItem(VOL_KEY, String(volume)); localStorage.setItem(MUTED_KEY, muted ? '1' : '0') } catch (e) {}
  applyVol()
}
function toggleMute() {
  if (muted) { muted = false; if (volume === 0) volume = 1 }
  else muted = true
  try { localStorage.setItem(MUTED_KEY, muted ? '1' : '0'); localStorage.setItem(VOL_KEY, String(volume)) } catch (e) {}
  applyVol()
}

function toggleFs() { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen() }
function nav(dir) {
  closeMenus() // REWORK#1 F5: открытое меню качества/скорости не переживает смену файла
  loadSeq++ // отменяем недостартовавший HLS/pro-старт предыдущего файла
  destroyHls()
  // T-20260926-001 S1: destroy Plyr instance on navigation
  if (plyrInst) { try { plyrInst.destroy() } catch (e) {} plyrInst = null }
  document.getElementById('media').innerHTML = ''; video = null
  var ld = document.getElementById('loader'); if (ld) ld.style.display = 'block'
  dlHideNow() // T-20260925-005 S2: устаревший #dl предыдущего файла не переживает навигацию
  try { window.electronAPI.preview.navigate(sid, dir).then(r => { if (r.success && r.data) renderMedia(r.data.files, r.data.idx, r.data.src, r.data.hlsPending) }) } catch(e) {}
}
document.addEventListener('keydown', e => {
  var tag = e.target && e.target.tagName
  var inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  if (e.key === 'Escape') {
    // REWORK#1 F9: фокус в слайдере громкости — сначала blur (иначе Esc сразу
    // закрывал окно, хотя пользователь работал со слайдером), следующий Esc —
    // меню/закрытие окно как обычно
    if (inField) { try { e.target.blur() } catch (err) {} return }
    // сначала закрываем открытое меню, потом окно
    if (document.querySelector('.menu.open')) { closeMenus(); return }
    window.electronAPI.preview.close(sid)
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // фокус в слайдере громкости: стрелки не должны навигировать по файлам
    if (inField) {
      e.preventDefault()
      setVolume(volume + (e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 0.05 : -0.05))
      return
    }
    if (e.key === 'ArrowLeft') { nav(-1); return }
    if (e.key === 'ArrowRight') { nav(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(volume + 0.05); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(volume - 0.05); return }
  }
  if (e.key === 'm' || e.key === 'M' || e.key === 'ь' || e.key === 'Ь') { toggleMute(); return }
  if (e.key === ' ' && video) {
    // нативный click по сфокусированной кнопке сам переключит состояние;
    // REWORK#1 F9: INPUT (#vol) — как у BODY: без скролла/дублирования (preventDefault)
    if (tag === 'BUTTON' || tag === 'A') return
    e.preventDefault(); togglePlay()
  }
})
// клик мимо меню — закрываем выпадашки
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest || !e.target.closest('.mwrap')) closeMenus()
})
document.getElementById('media').onclick = function(e) {
  if (e.target.tagName === 'VIDEO' || e.target.tagName === 'IMG') return
  var w = window.innerWidth
  if (e.clientX < w * 0.3) nav(-1)
  else if (e.clientX > w * 0.7) nav(1)
}
// init S2: персист громкости/скорости из localStorage → UI (видео подхватит при маунте)
applyVol()
document.getElementById('speedBtn').textContent = speed + 'x'
document.getElementById('vol').addEventListener('input', function () { setVolume(parseFloat(this.value) / 100) })
// T-20260925-005 S2: подписка на прогресс ДО первого preview.load — события
// фаз download/convert приходят только из load/navigate, т.е. уже после этой строки
if (window.electronAPI && window.electronAPI.preview && typeof window.electronAPI.preview.onProgress === 'function') {
  try { window.electronAPI.preview.onProgress(onPreviewProgress) } catch (e) {}
}
// load first file
window.electronAPI.preview.getSession(sid).then(r => {
  if (r.success) {
    window.electronAPI.preview.load(sid).then(r2 => {
      if (r2.success) renderMedia(r2.data.files, r2.data.idx, r2.data.src, r2.data.hlsPending)
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
    // T-20260925-005 S2: sessionId — чтобы слать preview:progress в это окно.
    // T-20260925-010 S2: mov/mkv/avi → hlsPending (src пустой, НЕ ошибка).
    const r = await resolvePreviewSrc(s.dir, f, sessionId)
    return { success: true, data: { files: s.files, idx: s.idx, src: r.src, hlsPending: !!r.hlsPending } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('preview:get-session', async (_, sessionId: string) => {
  try {
    const s = previewSessions.get(sessionId)
    if (!s) return { success: false, error: 'Session not found' }
    return { success: true, data: { files: s.files, idx: s.idx } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

// T-20260925-003 S1: preview запрашивает HLS-сессию для messageId.
// Возвращает { hlsUrl: 'http://127.0.0.1:14300/hls/<token>/<id>/master.m3u8' }
// либо { error } (лимит сессий / ffmpeg не стартанул / транскод не успел).
// REWORK#1 F1: вызов идёт из preview в ФОНЕ (первый кадр уже играет по
// прямому src) → ждём master до 60s (IPC_START_TIMEOUT_MS); {error} для
// preview — non-event, никакого fallback-переключения не нужно.
ipcMain.handle('preview:hls-start', async (_, messageId: number): Promise<{ hlsUrl: string } | { error: string }> => {
  try {
    const id = Number(messageId)
    if (!Number.isInteger(id) || id <= 0) return { error: 'bad-message-id' }
    return await ensureHlsSession(id, IPC_START_TIMEOUT_MS)
  } catch (error) {
    return { error: (error as Error).message || 'hls-start-failed' }
  }
})

// REWORK#1 F2: preview ушёл с активного HLS на direct (fatal-рекавери
// исчерпан / master без уровней) → сессия никем не используется → kill ffmpeg
// + удалить каталог, иначе транскод доедает файл впустую и жрёт слот из 2.
// ВАЖНО (F6 принят как minor): refcount-а нет — если этот же файл открыт во
// втором окне, его сегменты начнут отдавать 404 (его hls.js сам уйдёт в
// fallback на direct — graceful, без белого экрана).
ipcMain.handle('preview:hls-drop', async (_, messageId: number) => {
  try {
    const id = Number(messageId)
    if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'bad-message-id' }
    cleanupHlsForIds([id])
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

// ==== T-20260925-010 S2: fallback-IPC после неудачного HLS-first ====
// mov/mkv/avi стартовали через hlsPending (preview:hls-start); если тот
// вернул {error} либо молчал дольше бюджета 20s (см. startSlowPlayback в
// preview-скрипте) — зовём этот IPC: старый путь (полное скачивание +
// convertVideoToMp4 через resolvePreviewSlowSrc) → готовый file:// src.
// Сессия HLS к этому моменту снята preview-скриптом (hlsDrop), дублей качки
// нет — downloadPreviewSourceOnce объединяет её с веткой hlsServer.
ipcMain.handle('preview:convert-fallback', async (_, sessionId: string, messageId: number): Promise<{ src?: string; error?: string }> => {
  try {
    const s = previewSessions.get(sessionId)
    if (!s) return { error: 'session-not-found' }
    const id = Number(messageId)
    const f = (Number.isInteger(id) && s.files.find((x: any) => Number(x?.messageId) === id)) || s.files[s.idx]
    if (!f) return { error: 'file-not-found' }
    const src = await resolvePreviewSlowSrc(s.dir, f, sessionId)
    if (!src) return { error: 'convert-failed' }
    return { src }
  } catch (error) {
    return { error: (error as Error).message || 'convert-failed' }
  }
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
    // T-20260925-010 S2: mov/mkv/avi → hlsPending (src пустой, НЕ ошибка).
    const r = await resolvePreviewSrc(s.dir, nextFile, sessionId)
    return { success: true, data: { files: s.files, idx: s.idx, src: r.src, hlsPending: !!r.hlsPending } }
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
        // MINOR 7a FIX: poisoned .heic.jpg unlink + needsConversion (like ensurePreviewCache)
        if (stat.size < 10000 || !isJpegFile(jpgPath)) {
          try { fs.unlinkSync(jpgPath) } catch {}
          needsConversion = true
        }
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
      // Verify the converted file exists and is valid JPEG before using it
      if (fs.existsSync(jpgPath) && isJpegFile(jpgPath)) {
        finalPath = jpgPath
      } else {
        log('warn', `[thumb] getLocalUrl HEIC conversion failed or invalid JPEG: ${jpgPath}`)
        return { success: false, error: 'HEIC conversion failed' }
      }
    }
    // Same semantics as src/lib/localFileUrl.ts (main can't import from src):
    // abs FS path → local-file:/// URL with drive letter in pathname (3 slashes).
    // Use pathToFileURL for correct percent-encoding, then replace file:// → local-file://
    const fileUrl = pathToFileURL(finalPath).href
    const url = fileUrl.replace(/^file:\/\//, 'local-file://')
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
  // T-20260925-003 S1: закрыли preview → kill ffmpeg-сессий HLS и удалить их
  // каталоги в hls-cache (сессии файлов этого окна; до win.close(), пока
  // previewSessions ещё жив)
  const s = previewSessions.get(sessionId)
  if (s) {
    const ids = s.files
      .map((f: any) => Number(f?.messageId))
      .filter((n: number) => Number.isInteger(n) && n > 0)
    if (ids.length) {
      try { cleanupHlsForIds(ids) } catch (e) { log('warn', `[hls] cleanup on preview:close err=${(e as Error).message}`) }
      // M2 FIX: Clear range cache for all messageIds in this preview session
      for (const messageId of ids) {
        rangeCache.clear(messageId)
      }
    }
  }
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
