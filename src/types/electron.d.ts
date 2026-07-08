export {}

declare global {
  interface Window {
    electronAPI: {
      telegram: {
        checkSession: () => Promise<{ success: boolean; hasSession?: boolean; error?: string }>
        login: (phoneNumber: string) => Promise<{ success: boolean; data?: any; error?: string }>
        verifyCode: (code: string) => Promise<{ success: boolean; data?: any; error?: string; needs2FA?: boolean }>
        verify2FA: (password: string) => Promise<{ success: boolean; data?: any; error?: string }>
        reconnect: () => Promise<{ success: boolean; data?: any; error?: string }>
        uploadFile: (filePath: string, id?: string) => Promise<{ success: boolean; data?: any; error?: string }>
        onUploadProgress: (cb: (data: { id?: string; sent: number; total: number; percent: number }) => void) => () => void
        onBulkProgress: (cb: (data: { kind: string; index: number; total: number }) => void) => () => void
        listFiles: () => Promise<{ success: boolean; data?: any[]; error?: string }>
        downloadFile: (messageId: number, fileName: string) => Promise<{ success: boolean; data?: any; error?: string }>
        downloadThumbnail: (messageId: number) => Promise<{ success: boolean; data?: string | null; error?: string }>
        deleteFile: (messageId: number) => Promise<{ success: boolean; error?: string }>
        bulkDownload: (items: Array<{ messageId: number; fileName: string }>) => Promise<{ success: boolean; data?: any; error?: string }>
        bulkDelete: (ids: number[]) => Promise<{ success: boolean; data?: any; error?: string }>
        logout: () => Promise<{ success: boolean; error?: string }>
      }
      dialog: {
        pickFile: () => Promise<{ success: boolean; data?: { filePath: string; fileName: string; fileSize: number }; error?: string }>
        pickMultipleFiles: () => Promise<{ success: boolean; data?: Array<{ filePath: string; fileName: string; fileSize: number }>; error?: string }>
        pickFolder: () => Promise<{ success: boolean; data?: { folderPath: string }; error?: string }>
        pickFolderRecursive: () => Promise<{ success: boolean; data?: { folderPath: string; files: Array<{ filePath: string; fileName: string; fileSize: number }> }; error?: string }>
        pickDownloadDir: () => Promise<{ success: boolean; data?: { folderPath: string }; error?: string }>
      }
      autoSync: {
        getConfig: () => Promise<{ success: boolean; data?: any; error?: string }>
        updateConfig: (config: any) => Promise<{ success: boolean; error?: string }>
        start: () => Promise<{ success: boolean; error?: string }>
        stop: () => Promise<{ success: boolean; error?: string }>
        getStatus: () => Promise<{ success: boolean; data?: any; error?: string }>
        onStatus: (callback: (data: { status: string; file?: string }) => void) => () => void
      }
      app: {
        copyToClipboard: (text: string) => Promise<{ success: boolean; error?: string }>
        getVersion: () => Promise<{ success: boolean; data?: string; error?: string }>
        log: (level: string, msg: string) => void
      }
      getPathForFile: (file: File) => string
      folders: {
        list: () => Promise<{ success: boolean; data?: { folders: any[]; fileFolders: Record<number, string> }; error?: string }>
        loadFromTelegram: () => Promise<{ success: boolean; data?: { folders: any[]; fileFolders: Record<number, string> }; error?: string }>
        create: (name: string) => Promise<{ success: boolean; error?: string }>
        rename: (id: string, name: string) => Promise<{ success: boolean; error?: string }>
        delete: (id: string) => Promise<{ success: boolean; error?: string }>
        addFile: (folderId: string, messageId: number) => Promise<{ success: boolean; error?: string }>
        removeFile: (messageId: number) => Promise<{ success: boolean; error?: string }>
        moveFile: (messageId: number, folderId: string) => Promise<{ success: boolean; error?: string }>
        archiveAndUpload: (opts: { folderPath?: string; folderName?: string; files?: Array<{ messageId: number; fileName: string }> }) =>
          Promise<{ success: boolean; data?: any; error?: string }>
        onArchiveProgress: (cb: (data: { percent: number; phase: string; fileName?: string }) => void) => () => void
      }
      tgs: {
        read: (name?: string) => Promise<{ success: boolean; data?: any; error?: string }>
      }
      preview: {
        open: (files: any[], idx: number) => Promise<{ success: boolean; error?: string }>
        getSession: (sessionId: string) => Promise<{ success: boolean; data?: { files: any[]; idx: number }; error?: string }>
        navigate: (sessionId: string, dir: number) => Promise<{ success: boolean; data?: { files: any[]; idx: number }; error?: string }>
        load: (sessionId: string) => Promise<{ success: boolean; data?: { files: any[]; idx: number }; error?: string }>
        close: (sessionId: string) => void
      }
    }
  }
}
