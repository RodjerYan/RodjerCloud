import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as fs from 'fs'
import * as pathMod from 'path'
import path from 'path'
import { TelegramService } from './telegram-service'
import { StorageService } from './storage-service'
import { AutoSyncService } from './auto-sync-service'

let mainWindow: BrowserWindow | null = null
const telegramService = new TelegramService()
const storageService = new StorageService()
const autoSyncService = new AutoSyncService(telegramService)

// Setup auto-sync status callback
autoSyncService.setStatusCallback((status, file) => {
  if (mainWindow) {
    mainWindow.webContents.send('autosync:status', { status, file })
  }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
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

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  createWindow()

  // Load and apply saved sync config
  const savedConfig = await storageService.getSyncConfig()
  if (savedConfig) {
    autoSyncService.updateConfig(savedConfig)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  autoSyncService.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  autoSyncService.stop()
})

// IPC Handlers
ipcMain.handle('telegram:check-session', async () => {
  try {
    const session = await storageService.getSession()
    return { success: true, hasSession: !!session }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:login', async (_, data: { apiId: number; apiHash: string; phoneNumber: string }) => {
  try {
    const result = await telegramService.startAuth(data.apiId, data.apiHash, data.phoneNumber)
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:verify-code', async (_, code: string) => {
  try {
    const result = await telegramService.verifyCode(code)
    if (result.success) {
      const sessionString = telegramService.getSessionString()
      const credentials = telegramService.getCredentials()
      await storageService.saveSession(sessionString, credentials)
      return { success: true, needsKeyChoice: true }
    }
    return result
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:verify-2fa', async (_, password: string) => {
  try {
    const result = await telegramService.verify2FA(password)
    if (result.success) {
      const sessionString = telegramService.getSessionString()
      const credentials = telegramService.getCredentials()
      await storageService.saveSession(sessionString, credentials)
      return { success: true, needsKeyChoice: true }
    }
    return result
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:reconnect', async () => {
  try {
    const sessionData = await storageService.getSession()
    if (!sessionData) {
      return { success: false, error: 'No session found' }
    }
    
    const result = await telegramService.reconnect(
      sessionData.session,
      sessionData.credentials.apiId,
      sessionData.credentials.apiHash
    )
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:upload-file', async (event, filePath: string) => {
  try {
    const result = await telegramService.uploadFile(filePath, (sent, total) => {
      try {
        event.sender.send('telegram:upload-progress', {
          sent,
          total,
          percent: total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 0,
        })
      } catch (err) {
        console.error('Error sending progress:', err)
      }
    })
    // Final 100% pulse so the renderer always lands on completion
    try {
      event.sender.send('telegram:upload-progress', {
        sent: result.fileSize,
        total: result.fileSize,
        percent: 100,
      })
    } catch {}
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:list-files', async () => {
  try {
    const files = await telegramService.listFiles()
    return { success: true, data: files }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:download-file', async (_, messageId: number, fileName: string) => {
  try {
    const result = await telegramService.downloadFile(messageId, fileName)
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:delete-file', async (_, messageId: number) => {
  try {
    await telegramService.deleteFile(messageId)
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:logout', async () => {
  try {
    await telegramService.logout()
    await storageService.clearSession()
    autoSyncService.stop()
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('dialog:pick-file', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Select a file to upload',
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, error: 'No file selected' }
    }
    const filePath = result.filePaths[0]
    const stat = fs.statSync(filePath)
    return {
      success: true,
      data: {
        filePath,
        fileName: pathMod.basename(filePath),
        fileSize: stat.size,
      },
    }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('dialog:pick-multiple-files', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Select files to upload',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, error: 'No files selected' }
    }
    const files = result.filePaths.map(filePath => {
      const stat = fs.statSync(filePath)
      return {
        filePath,
        fileName: pathMod.basename(filePath),
        fileSize: stat.size,
      }
    })
    return { success: true, data: files }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('dialog:pick-folder', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Select folder to sync',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, error: 'No folder selected' }
    }
    return { success: true, data: { folderPath: result.filePaths[0] } }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:setup-new-channel', async () => {
  try {
    const channelResult = await telegramService.createNewChannel()
    return { success: true, data: channelResult }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('telegram:setup-existing-channel', async (_, key: string) => {
  try {
    const channelResult = await telegramService.findChannelByToken(key)
    return { success: true, data: channelResult }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('dialog:save-key-file', async (_, key: string, body: string) => {
  try {
    const downloadsPath = app.getPath('downloads')
    const filePath = pathMod.join(downloadsPath, 'cloudsave.txt')
    const content = `key :- ${key}\n\n${body}\n`
    fs.writeFileSync(filePath, content, 'utf8')
    return { success: true, data: { filePath } }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('storage:save-credentials', async (_, credentials: any) => {
  try {
    await storageService.saveCredentials(credentials)
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('storage:get-credentials', async () => {
  try {
    const credentials = await storageService.getCredentials()
    return { success: true, data: credentials }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

// Auto-sync IPC handlers
ipcMain.handle('autosync:get-config', async () => {
  try {
    const config = autoSyncService.getConfig()
    return { success: true, data: config }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('autosync:update-config', async (_, newConfig: any) => {
  try {
    autoSyncService.updateConfig(newConfig)
    await storageService.saveSyncConfig(autoSyncService.getConfig())
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('autosync:start', async () => {
  try {
    autoSyncService.start()
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('autosync:stop', async () => {
  try {
    autoSyncService.stop()
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('autosync:get-status', async () => {
  try {
    const status = autoSyncService.getStatus()
    return { success: true, data: status }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})
