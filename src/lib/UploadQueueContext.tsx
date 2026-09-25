import React, { createContext, useCallback, useContext, useState, useRef, useEffect } from 'react'

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
  // id, которые main уже объявлял в очереди (getUploadState / telegram:queue-state).
  // Нужно, чтобы не пометить done item, который ещё не успел попасть в main-очередь.
  const seenInMainRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    (async () => {
      try {
        const r = await window.electronAPI.telegram.getUploadState?.()
        if (r?.success && r.data?.queue?.length > 0) {
          const restored: QueueItem[] = r.data.queue.map((j: any) => ({
            id: j.id, filePath: j.filePath, fileName: j.fileName || j.filePath?.split(/[/\\]/).pop() || '',
            fileSize: j.fileSize || 0, status: j.status || 'waiting', percent: j.percent || 0,
            sent: j.sent || 0, total: j.total || j.fileSize || 0
          }))
          restored.forEach((r: QueueItem) => seenInMainRef.current.add(r.id))
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
    let lastTime = performance.now()
    let maxLag = 0
    let samples = 0
    let totalLag = 0
    const interval = setInterval(() => {
      const now = performance.now()
      const lag = now - lastTime - 1000
      lastTime = now
      if (lag > 50) {
        samples++
        totalLag += lag
        if (lag > maxLag) maxLag = lag
      }
      if (samples >= 5) {
        const avg = (totalLag / samples).toFixed(0)
        try { window.electronAPI?.window?.reportLag?.({ maxLag: maxLag.toFixed(0), avgLag: avg, samples }) } catch {}
        maxLag = 0
        samples = 0
        totalLag = 0
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const off = window.electronAPI.telegram.onQueueState?.((data: any) => {
      if (!data?.queue) return
      setQueue(prev => {
        const previousById = new Map(prev.map(item => [item.id, item]))
        const mainItems: QueueItem[] = data.queue.map((j: any) => ({
          ...(previousById.get(j.id) || {}),
          id: j.id, filePath: j.filePath, fileName: j.fileName || j.filePath?.split(/[/\\]/).pop() || '',
          fileSize: j.fileSize || 0, status: j.status || 'waiting',
          percent: previousById.get(j.id)?.percent ?? j.percent ?? 0,
          sent: previousById.get(j.id)?.sent ?? j.sent ?? 0,
          total: previousById.get(j.id)?.total || j.total || j.fileSize || 0
        }))
        data.queue.forEach((j: any) => seenInMainRef.current.add(j.id))
        const mainById = new Map(mainItems.map(item => [item.id, item]))
        // Main присылает только waiting/uploading и убирает job когда он завершён/отменён.
        // Если раньше виденный в main item вдруг исчез из снимка — закрываем его как done,
        // иначе он навсегда остаётся 'uploading' (zombie) и вечно держит баннер AggregateProgress.
        const preservedOrder = prev.map(item => {
          const merged = mainById.get(item.id)
          if (merged) return merged
          if (item.status === 'failed') return item
          if (seenInMainRef.current.has(item.id) && (item.status === 'uploading' || item.status === 'waiting')) {
            return { ...item, status: 'done' as const, percent: 100 }
          }
          return item
        })
        const restoredOnly = mainItems.filter(item => !previousById.has(item.id))
        return [...preservedOrder, ...restoredOnly]
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
    const processingIds = new Set<string>()
    let active = 0
    const runNext = () => {
      while (active < 1) {
        const it = queueRef.current.find(q => q.status === 'waiting' && !processingIds.has(q.id))
        if (!it) break
        processingIds.add(it.id)
        active++
        setQueue(prev => prev.map(q => q.id === it.id ? { ...q, status: 'uploading' } : q))
        window.electronAPI.telegram.uploadFile(it.filePath, it.id, it.encrypt).then((res: { success: boolean; error?: string }) => {
          setQueue(prev => {
            // Отмена — не ошибка: убираем элемент из очереди (как при ручном remove)
            if (!res.success && res.error === 'cancelled') return prev.filter(q => q.id !== it.id)
            return prev.map(q => q.id === it.id
              ? { ...q, status: res.success ? 'done' : 'failed', percent: res.success ? 100 : q.percent, error: res.success ? undefined : res.error }
              : q)
          })
        }).finally(() => {
          active--
          processingIds.delete(it.id)
          runNext()
        })
      }
      if (active === 0) isProcessing.current = false
    }
    runNext()
  }

  useEffect(() => {
    let lastUpdate = 0;
    const pendingUpdates = new Map<string, { percent: number; sent: number; total: number }>();
    let rafId: number | null = null;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (rafId) return;
      if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
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
        // lastUpdate — ПОСЛЕ отправки batch, чтобы не терять события, пришедшие во время rAF
        lastUpdate = Date.now();
      });
    };

    const off = window.electronAPI.telegram.onUploadProgress?.((data: any) => {
      pendingUpdates.set(data.id, { percent: data.percent, sent: data.sent, total: data.total });
      const now = Date.now();
      if (now - lastUpdate >= 150) {
        flush();
      } else if (!trailingTimer) {
        // Trailing flush: гарантируем, что последнее событие после паузы будет доставлено
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          flush();
        }, 150 - (now - lastUpdate));
      }
    });

    return () => {
      if (off) off();
      if (rafId) cancelAnimationFrame(rafId);
      if (trailingTimer) clearTimeout(trailingTimer);
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

  const removeItem = useCallback((id: string) => setQueue(prev => prev.filter(q => q.id !== id)), [])
  const clearDone = useCallback(() => setQueue(prev => prev.filter(q => q.status !== 'done')), [])

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
