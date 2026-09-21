import React, { createContext, useContext, useState, useRef, useEffect } from 'react'

const CHUNK_GB = 1.95
const CHUNK_SIZE = Math.floor(CHUNK_GB * 1024 * 1024 * 1024)

export interface QueueItem {
  id: string
  filePath: string
  fileName: string
  fileSize: number
  status: 'waiting' | 'uploading' | 'done' | 'failed'
  percent: number
  sent?: number
  total?: number
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

  useEffect(() => {
    (async () => {
      try {
        const r = await window.electronAPI.telegram.getUploadState?.()
        if (r?.success && r.data?.queue?.length > 0) {
          const restored: QueueItem[] = r.data.queue.map((j: any) => ({
            id: j.id, filePath: j.filePath, fileName: j.fileName || j.filePath?.split(/[/\\]/).pop() || '',
            fileSize: j.fileSize || 0, status: 'uploading', percent: 0, sent: 0, total: j.fileSize || 0
          }))
          setQueue(prev => {
            const existingIds = new Set(prev.map(p => p.id))
            const newItems = restored.filter((r: QueueItem) => !existingIds.has(r.id))
            return newItems.length > 0 ? [...prev, ...newItems] : prev
          })
        }
      } catch {}
    })()
  }, [])

  useEffect(() => {
    const off = window.electronAPI.telegram.onQueueState?.((data: any) => {
      if (!data?.queue) return
      setQueue(prev => {
        const mainIds = new Set(data.queue.map((j: any) => j.id))
        const mainItems: QueueItem[] = data.queue.map((j: any) => ({
          id: j.id, filePath: j.filePath, fileName: j.fileName || j.filePath?.split(/[/\\]/).pop() || '',
          fileSize: j.fileSize || 0, status: j.status || 'waiting', percent: j.percent || 0, sent: j.sent || 0, total: j.fileSize || j.total || 0
        }))
        const localOnly = prev.filter(q => !mainIds.has(q.id) && q.status !== 'done' && q.status !== 'failed')
        return [...localOnly, ...mainItems]
      })
    })
    return () => { off && off() }
  }, [])

  const addFiles = (files: Array<{ filePath: string; fileName: string; fileSize: number }>, encryptNext: boolean) => {
    const items: QueueItem[] = files.map(f => ({
      id: Math.random().toString(36).slice(2),
      filePath: f.filePath, fileName: f.fileName, fileSize: f.fileSize,
      status: 'waiting', percent: 0, sent: 0, total: f.fileSize, encrypt: encryptNext
    }))
    setQueue(prev => [...prev, ...items])
    if (!isProcessing.current) {
      isProcessing.current = true
      setTimeout(() => processQueue(), 50)
    }
  }

  const processQueue = async () => {
    let limit = 3
    try {
      const r = await window.electronAPI.storage.getUploadConcurrency()
      if (r.success && r.data) limit = Math.min(3, Math.max(1, r.data))
    } catch {}

    const processingIds = new Set<string>()
    let active = 0
    const runNext = () => {
      while (active < limit) {
        const it = queueRef.current.find(q => q.status === 'waiting' && !processingIds.has(q.id))
        if (!it) break
        if (it.fileSize > TG_LIMIT) {
          setQueue(prev => prev.map(q => q.id === it.id ? { ...q, status: 'failed', error: 'Exceeds 2GB' } : q))
          continue
        }
        let effectiveLimit = limit
        if (it.fileSize > 500 * 1024 * 1024) effectiveLimit = 1
        else if (it.fileSize > 100 * 1024 * 1024) effectiveLimit = Math.min(2, limit)
        if (active >= effectiveLimit) break
        processingIds.add(it.id)
        active++
        setQueue(prev => prev.map(q => q.id === it.id ? { ...q, status: 'uploading' } : q))
        window.electronAPI.telegram.uploadFile(it.filePath, it.id, it.encrypt).then((res: { success: boolean; error?: string }) => {
          setQueue(prev => prev.map(q => q.id === it.id
            ? { ...q, status: res.success ? 'done' : 'failed', percent: res.success ? 100 : q.percent, error: res.success ? undefined : res.error }
            : q))
        }).finally(() => { active--; processingIds.delete(it.id); runNext() })
      }
      if (active === 0) isProcessing.current = false
    }
    runNext()
  }

  useEffect(() => {
    let lastUpdate = 0;
    let pendingUpdates = new Map<string, { percent: number; sent: number; total: number }>();
    let rafId: number | null = null;

    const off = window.electronAPI.telegram.onUploadProgress?.((data: any) => {
      pendingUpdates.set(data.id, { percent: data.percent, sent: data.sent, total: data.total });
      const now = Date.now();

      if (now - lastUpdate > 500) {
        if (!rafId) {
          rafId = window.requestAnimationFrame(() => {
            const batch = new Map(pendingUpdates);
            pendingUpdates.clear();
            if (batch.size > 0) {
              setQueue(prev => {
                let changed = false;
                const next = prev.map(q => {
                  const u = batch.get(q.id);
                  if (u) { changed = true; return { ...q, percent: u.percent, sent: u.sent, total: u.total }; }
                  return q;
                });
                return changed ? next : prev;
              });
            }
            lastUpdate = Date.now();
            rafId = null;
          });
        }
      }
    });

    return () => {
      if (off) off();
      if (rafId) cancelAnimationFrame(rafId);
    }
  }, [])

  const pickFolder = async (encryptNext: boolean) => {
    const r = await window.electronAPI.dialog.pickFolder()
    if (!r.success || !r.data?.folderPath) return
    archiveStart.current = Date.now()
    uploadStart.current = 0
    setArchiveInfo({ percent: 0, phase: 'compressing' })
    setArchivePhases(new Set(['compressing']))

    const off = window.electronAPI.folders.onArchiveProgress((d: { percent: number; phase: string; sent?: number; total?: number }) => {
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
