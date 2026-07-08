import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  telegram: {
    checkSession: () => ipcRenderer.invoke('telegram:check-session'),
    login: (phoneNumber: string) => ipcRenderer.invoke('telegram:login', phoneNumber),
    verifyCode: (code: string) => ipcRenderer.invoke('telegram:verify-code', code),
    verify2FA: (password: string) => ipcRenderer.invoke('telegram:verify-2fa', password),
    reconnect: () => ipcRenderer.invoke('telegram:reconnect'),
    uploadFile: (filePath: string, id?: string) => ipcRenderer.invoke('telegram:upload-file', filePath, id),
    onUploadProgress: (cb: (data: { id?: string; sent: number; total: number; percent: number }) => void) => {
      const listener = (_: any, data: any) => cb(data)
      ipcRenderer.on('telegram:upload-progress', listener)
      return () => ipcRenderer.removeListener('telegram:upload-progress', listener)
    },
    onBulkProgress: (cb: (data: { kind: string; index: number; total: number }) => void) => {
      const listener = (_: any, data: any) => cb(data)
      ipcRenderer.on('telegram:bulk-progress', listener)
      return () => ipcRenderer.removeListener('telegram:bulk-progress', listener)
    },
    listFiles: () => ipcRenderer.invoke('telegram:list-files'),
    downloadFile: (messageId: number, fileName: string) =>
      ipcRenderer.invoke('telegram:download-file', messageId, fileName),
    downloadThumbnail: (messageId: number) =>
      ipcRenderer.invoke('telegram:download-thumbnail', messageId),
    deleteFile: (messageId: number) => ipcRenderer.invoke('telegram:delete-file', messageId),
    cacheAudio: (messageId: number, fileName: string) => ipcRenderer.invoke('telegram:cache-audio', messageId, fileName),
    bulkDownload: (items: Array<{ messageId: number; fileName: string }>) =>
      ipcRenderer.invoke('telegram:bulk-download', items),
    bulkDelete: (ids: number[]) => ipcRenderer.invoke('telegram:bulk-delete', ids),
    logout: () => ipcRenderer.invoke('telegram:logout'),
  },
  dialog: {
    pickFile: () => ipcRenderer.invoke('dialog:pick-file'),
    pickMultipleFiles: () => ipcRenderer.invoke('dialog:pick-multiple-files'),
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
    pickFolderRecursive: () => ipcRenderer.invoke('dialog:pick-folder-recursive'),
    pickDownloadDir: () => ipcRenderer.invoke('dialog:pick-download-dir'),
  },
  autoSync: {
    getConfig: () => ipcRenderer.invoke('autosync:get-config'),
    updateConfig: (config: any) => ipcRenderer.invoke('autosync:update-config', config),
    start: () => ipcRenderer.invoke('autosync:start'),
    stop: () => ipcRenderer.invoke('autosync:stop'),
    getStatus: () => ipcRenderer.invoke('autosync:get-status'),
    onStatus: (cb: (data: any) => void) => {
      const listener = (_: any, data: any) => cb(data)
      ipcRenderer.on('autosync:status', listener)
      return () => ipcRenderer.removeListener('autosync:status', listener)
    },
    testUpload: () => ipcRenderer.invoke('autosync:test-upload'),
    scanNow: () => ipcRenderer.invoke('autosync:scan-now'),
    countFiles: () => ipcRenderer.invoke('autosync:count-files'),
    getLog: () => ipcRenderer.invoke('autosync:get-log'),
    getQueue: () => ipcRenderer.invoke('autosync:get-queue'),
    resetUploaded: () => ipcRenderer.invoke('autosync:reset-uploaded'),
  },
  app: {
    copyToClipboard: (text: string) => ipcRenderer.invoke('app:copy-to-clipboard', text),
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    log: (level: string, msg: string) => ipcRenderer.send('app:log', level, msg),
  },
  getPathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
  folders: {
    list: () => ipcRenderer.invoke('folders:list'),
    loadFromTelegram: () => ipcRenderer.invoke('folders:load-from-telegram'),
    create: (name: string) => ipcRenderer.invoke('folders:create', name),
    rename: (id: string, name: string) => ipcRenderer.invoke('folders:rename', id, name),
    delete: (id: string) => ipcRenderer.invoke('folders:delete', id),
    addFile: (folderId: string, messageId: number) => ipcRenderer.invoke('folders:add-file', folderId, messageId),
    removeFile: (messageId: number) => ipcRenderer.invoke('folders:remove-file', messageId),
    moveFile: (messageId: number, folderId: string) => ipcRenderer.invoke('folders:move-file', messageId, folderId),
    archiveAndUpload: (opts: { folderPath?: string; folderName?: string; files?: Array<{ messageId: number; fileName: string }> }) =>
      ipcRenderer.invoke('folder:archive-and-upload', opts),
    onArchiveProgress: (cb: (data: { percent: number; phase: string; fileName?: string }) => void) => {
      const listener = (_: any, data: any) => cb(data)
      ipcRenderer.on('archive-progress', listener)
      return () => ipcRenderer.removeListener('archive-progress', listener)
    },
  },
  tgs: {
    read: (name?: string) => ipcRenderer.invoke('tgs:read', name),
  },
  preview: {
    open: (files: any[], idx: number) => ipcRenderer.invoke('preview:open', files, idx),
    getSession: (sessionId: string) => ipcRenderer.invoke('preview:get-session', sessionId),
    navigate: (sessionId: string, dir: number) => ipcRenderer.invoke('preview:navigate', sessionId, dir),
    load: (sessionId: string) => ipcRenderer.invoke('preview:load', sessionId),
    close: (id: string) => ipcRenderer.send('preview:close', id),
  }
})
