export {}

declare global {
  interface Window {
    electronAPI: {
      telegram: {
        checkSession: () => Promise<{ success: boolean; hasSession?: boolean; error?: string }>
        login: (data: {
          apiId: number
          apiHash: string
          phoneNumber: string
        }) => Promise<{ success: boolean; data?: any; error?: string }>
        verifyCode: (code: string) => Promise<{
          success: boolean
          data?: { needs2FA?: boolean }
          error?: string
        }>
        verify2FA: (password: string) => Promise<{
          success: boolean
          data?: any
          error?: string
        }>
        reconnect: () => Promise<{ success: boolean; data?: any; error?: string }>
        uploadFile: (filePath: string) => Promise<{
          success: boolean
          data?: any
          error?: string
        }>
        onUploadProgress: (callback: (data: { sent: number; total: number; percent: number }) => void) => () => void
        listFiles: () => Promise<{ success: boolean; data?: any[]; error?: string }>
        downloadFile: (
          messageId: number,
          fileName: string
        ) => Promise<{ success: boolean; data?: any; error?: string }>
        deleteFile: (messageId: number) => Promise<{ success: boolean; error?: string }>
        logout: () => Promise<{ success: boolean; error?: string }>
        setupNewChannel: () => Promise<{ success: boolean; data?: any; error?: string }>
        setupExistingChannel: (key: string) => Promise<{ success: boolean; data?: any; error?: string }>
      }
      storage: {
        saveCredentials: (credentials: any) => Promise<{ success: boolean; error?: string }>
        getCredentials: () => Promise<{ success: boolean; data?: any; error?: string }>
      }
      dialog: {
        pickFile: () => Promise<{ success: boolean; data?: { filePath: string; fileName: string; fileSize: number }; error?: string }>
        pickMultipleFiles: () => Promise<{ success: boolean; data?: Array<{ filePath: string; fileName: string; fileSize: number }>; error?: string }>
        pickFolder: () => Promise<{ success: boolean; data?: { folderPath: string }; error?: string }>
        saveKeyFile: (key: string, body: string) => Promise<{ success: boolean; data?: { filePath: string }; error?: string }>
      }
      autoSync: {
        getConfig: () => Promise<{ success: boolean; data?: any; error?: string }>
        updateConfig: (config: any) => Promise<{ success: boolean; error?: string }>
        start: () => Promise<{ success: boolean; error?: string }>
        stop: () => Promise<{ success: boolean; error?: string }>
        getStatus: () => Promise<{ success: boolean; data?: any; error?: string }>
        onStatus: (callback: (data: { status: string; file?: string }) => void) => () => void
      }
      getPathForFile: (file: File) => string
    }
  }
}
