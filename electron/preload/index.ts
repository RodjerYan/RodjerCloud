import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  telegram: {
    checkSession: () => ipcRenderer.invoke('telegram:check-session'),
    login: (data: { apiId: number; apiHash: string; phoneNumber: string }) =>
      ipcRenderer.invoke('telegram:login', data),
    verifyCode: (code: string) => ipcRenderer.invoke('telegram:verify-code', code),
    verify2FA: (password: string) => ipcRenderer.invoke('telegram:verify-2fa', password),
    reconnect: () => ipcRenderer.invoke('telegram:reconnect'),
    uploadFile: (filePath: string) => ipcRenderer.invoke('telegram:upload-file', filePath),
    onUploadProgress: (cb: (data: { sent: number; total: number; percent: number }) => void) => {
      const listener = (_: any, data: any) => cb(data)
      ipcRenderer.on('telegram:upload-progress', listener)
      return () => ipcRenderer.removeListener('telegram:upload-progress', listener)
    },
    listFiles: () => ipcRenderer.invoke('telegram:list-files'),
    downloadFile: (messageId: number, fileName: string) =>
      ipcRenderer.invoke('telegram:download-file', messageId, fileName),
    deleteFile: (messageId: number) => ipcRenderer.invoke('telegram:delete-file', messageId),
    logout: () => ipcRenderer.invoke('telegram:logout'),
    setupNewChannel: () => ipcRenderer.invoke('telegram:setup-new-channel'),
    setupExistingChannel: (key: string) => ipcRenderer.invoke('telegram:setup-existing-channel', key)
  },
  storage: {
    saveCredentials: (credentials: any) => ipcRenderer.invoke('storage:save-credentials', credentials),
    getCredentials: () => ipcRenderer.invoke('storage:get-credentials')
  },
  dialog: {
    pickFile: () => ipcRenderer.invoke('dialog:pick-file'),
    pickMultipleFiles: () => ipcRenderer.invoke('dialog:pick-multiple-files'),
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
    saveKeyFile: (key: string, body: string) => ipcRenderer.invoke('dialog:save-key-file', key, body)
  },
  autoSync: {
    getConfig: () => ipcRenderer.invoke('autosync:get-config'),
    updateConfig: (config: any) => ipcRenderer.invoke('autosync:update-config', config),
    start: () => ipcRenderer.invoke('autosync:start'),
    stop: () => ipcRenderer.invoke('autosync:stop'),
    getStatus: () => ipcRenderer.invoke('autosync:get-status'),
    onStatus: (cb: (data: { status: string; file?: string }) => void) => {
      const listener = (_: any, data: any) => cb(data)
      ipcRenderer.on('autosync:status', listener)
      return () => ipcRenderer.removeListener('autosync:status', listener)
    }
  },
  // Resolve absolute filesystem path of a File object (drag-drop or <input type=file>)
  // Electron 32+ removed File.path; webUtils.getPathForFile is the official replacement.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
})
