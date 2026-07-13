import React, { createContext, useContext, useState, useRef, useEffect } from 'react'

export interface QueueItem {
  id: string
  filePath: string
  fileName: string
  fileSize: number
  status: 'waiting' | 'uploading' | 'done' | 'failed'
  percent: number
  error?: string
  encrypt?: boolean
}

interface UploadQueueContextType {
  queue: QueueItem[]
  archiveInfo: { percent: number; phase: string; sent?: number; total?: number } | null
  archivePhases: Set<string>
  addFiles: (files: Array<{ filePath: string; fileName: string; fileSize: number }>, encryptNext: boolean) => void
  removeItem: (id: string) => void
  clearDone: () => void
  pickFolder: (encryptNext: boolean) => Promise<void>
}

const UploadQueueContext = createContext<UploadQueueContextType | null>(null)

export function UploadQueueProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const queueRef = useRef<QueueItem[]>([])
  queueRef.current = queue

  const [archiveInfo, setArchiveInfo] = useState<{ percent: number; phase: string; sent?: number; total?: number } | null>(null)
  const [archivePhases, setArchivePhases] = useState<Set<string>>(new Set())
  const archiveStart = useRef(0)
  const uploadStart = useRef(0)
  const isProcessing = useRef(false)

  const TG_LIMIT = 2 * 1024 * 1024 * 1024

  const addFiles = (files: Array<{ filePath: string; fileName: string; fileSize: number }>, encryptNext: boolean) => {
    const items: QueueItem[] = files.map(f => ({
      id: Math.random().toString(36).slice(2),
      filePath: f.filePath, fileName: f.fileName, fileSize: f.fileSize,
      status: 'waiting', percent: 0, encrypt: encryptNext
    }))
    setQueue(prev => [...prev, ...items])
    if (!isProcessing.current) {
      isProcessing.current = true
      setTimeout(() => processQueue(), 50)
    }
  }

  const processQueue = async () => {
    while (true) {
      const it = queueRef.current.find(q => q.status === 'waiting')
      if (!it) break
      
      if (it.fileSize > TG_LIMIT) {
        setQueue(prev => prev.map(q => q.id === it.id ? { ...q, status: 'failed', error: 'Exceeds 2GB' } : q))
        continue
      }
      
      setQueue(prev => prev.map(q => q.id === it.id ? { ...q, status: 'uploading' } : q))
      
      const res = await window.electronAPI.telegram.uploadFile(it.filePath, it.id, it.encrypt)
      
      setQueue(prev => prev.map(q => q.id === it.id
        ? { ...q, status: res.success ? 'done' : 'failed', percent: res.success ? 100 : q.percent, error: res.success ? undefined : res.error }
        : q))
    }
    isProcessing.current = false
  }

  useEffect(() => {
    const off = window.electronAPI.telegram.onUploadProgress?.((data: any) => {
      setQueue(prev => prev.map(q => q.id === data.id ? { ...q, percent: data.percent } : q))
    })
    return () => { off && off() }
  }, [])

  const pickFolder = async (encryptNext: boolean) => {
    const r = await window.electronAPI.dialog.pickFolder()
    if (!r.success || !r.data?.folderPath) return
    archiveStart.current = Date.now()
    uploadStart.current = 0
    setArchiveInfo({ percent: 0, phase: 'compressing' })
    setArchivePhases(new Set(['compressing']))

    const off = window.electronAPI.folders.onArchiveProgress((d) => {
      setArchiveInfo(prev => ({ ...prev, percent: d.percent, phase: d.phase, sent: d.sent, total: d.total }))
      setArchivePhases(prev => { const n = new Set(prev); n.add(d.phase); return n })
      if (d.phase === 'uploading' && uploadStart.current === 0) uploadStart.current = Date.now()
    })

    const res = await window.electronAPI.folders.archiveAndUpload({
      folderPath: r.data.folderPath,
      folderName: r.data.folderName,
      encrypt: encryptNext
    })

    off()
    if (!res.success) {
      setArchiveInfo({ percent: 0, phase: 'failed' })
      setTimeout(() => setArchiveInfo(null), 3000)
      return
    }

    setArchiveInfo({ percent: 100, phase: 'done', sent: res.data?.fileSize, total: res.data?.fileSize })
    setArchivePhases(new Set(['compressing', 'uploading', 'done']))
    setTimeout(() => {
      setArchiveInfo(null)
      setArchivePhases(new Set())
      addFiles([{ filePath: r.data.folderPath, fileName: r.data.folderName + '.zip', fileSize: res.data?.fileSize || 0 }], encryptNext)
      setQueue(prev => prev.map(q => q.filePath === r.data.folderPath ? { ...q, status: 'done', percent: 100 } : q))
    }, 2000)
  }

  const removeItem = (id: string) => setQueue(prev => prev.filter(q => q.id !== id))
  const clearDone = () => setQueue(prev => prev.filter(q => q.status !== 'done'))

  return (
    <UploadQueueContext.Provider value={{ queue, archiveInfo, archivePhases, addFiles, removeItem, clearDone, pickFolder }}>
      {children}
    </UploadQueueContext.Provider>
  )
}

export function useUploadQueue() {
  const ctx = useContext(UploadQueueContext)
  if (!ctx) throw new Error('useUploadQueue must be used within UploadQueueProvider')
  return ctx
}
