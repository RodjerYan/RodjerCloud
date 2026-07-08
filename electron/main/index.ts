import { app, BrowserWindow, ipcMain, dialog, clipboard, screen } from 'electron'
import * as fs from 'fs'
import * as zlib from 'zlib'
import * as pathMod from 'path'
import path from 'path'
import { TelegramService } from './telegram-service'
import { StorageService } from './storage-service'
import { AutoSyncService } from './auto-sync-service'

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

app.whenReady().then(async () => {
  createWindow()

  autoSyncService.loadTracker()
  const prefs = await readPrefs()
  if (prefs.autoSync) autoSyncService.updateConfig(prefs.autoSync)
  if (prefs.autoSync?.enabled) autoSyncService.start()
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
    return { success: true, data: result }
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
    job.event.sender.send('telegram:upload-progress', {
      id: job.id, sent: 0, total: 0, percent: 0
    })
    const result = await telegramService.uploadFile(job.filePath, (sent, total) => {
      try {
        job.event.sender.send('telegram:upload-progress', {
          id: job.id, sent, total,
          percent: total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 0,
        })
      } catch {}
    })
    try {
      job.event.sender.send('telegram:upload-progress', {
        id: job.id, sent: result.fileSize, total: result.fileSize, percent: 100,
      })
    } catch {}
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
  } else {
    document.getElementById('bar').style.display = 'none'; video = null
  }
          }
        }
      }})
      processQueue()
    })
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:list-files', async () => {
  try {
    const files = await telegramService.listFiles()
    return { success: true, data: files }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('telegram:download-file', async (_, messageId: number, fileName: string) => {
  try {
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
    await telegramService.deleteFile(messageId)
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
    try { await telegramService.deleteFile(messageIds[i]); results.push({ success: true }) }
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

ipcMain.handle('app:get-version', async () => {
  try { return { success: true, data: app.getVersion() } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.on('app:log', (_, level: string, msg: string) => {
  log(level, '[renderer] ' + msg)
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

ipcMain.handle('folders:list', async () => {
  try { const d = readFolders(); return { success: true, data: d } }
  catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:create', async (_, name: string) => {
  try {
    const d = readFolders()
    const id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
    d.folders.push({ id, name, createdAt: Math.floor(Date.now() / 1000) })
    writeFolders(d)
    return { success: true, data: { id, name } }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:rename', async (_, id: string, name: string) => {
  try {
    const d = readFolders(); const f = d.folders.find((x: any) => x.id === id)
    if (!f) throw new Error('Folder not found'); f.name = name; writeFolders(d)
    return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:delete', async (_, id: string) => {
  try {
    const d = readFolders(); d.folders = d.folders.filter((x: any) => x.id !== id)
    Object.keys(d.fileFolders).forEach(k => { if (d.fileFolders[k] === id) delete d.fileFolders[k] })
    writeFolders(d); return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:add-file', async (_, folderId: string, messageId: number) => {
  try {
    const d = readFolders(); d.fileFolders[messageId] = folderId; writeFolders(d); return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:remove-file', async (_, messageId: number) => {
  try {
    const d = readFolders(); delete d.fileFolders[messageId]; writeFolders(d); return { success: true }
  } catch (error) { return { success: false, error: (error as Error).message } }
})

ipcMain.handle('folders:move-file', async (_, messageId: number, folderId: string) => {
  try {
    const d = readFolders(); d.fileFolders[messageId] = folderId; writeFolders(d); return { success: true }
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
    ? '<video id="pv" src="' + src + '" autoplay muted style="max-width:100%;max-height:100%;border-radius:4px"></video>'
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
