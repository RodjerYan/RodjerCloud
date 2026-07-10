import React, { useEffect, useState, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { Upload as UploadIcon, FolderOpen, Trash2, AlertTriangle, CheckCircle2, Loader2, Archive } from 'lucide-react'
import { Player } from '@lottiefiles/react-lottie-player'
import { fmtSize } from '../lib/utils'

interface QueueItem {
  id: string
  filePath: string
  fileName: string
  fileSize: number
  status: 'waiting' | 'uploading' | 'done' | 'failed'
  percent: number
  error?: string
}

const TG_LIMIT = 2 * 1024 * 1024 * 1024

const ALL_STEPS = [
  { key: 'downloading', label: 'Скачивание' },
  { key: 'compressing', label: 'Архивация' },
  { key: 'uploading', label: 'Загрузка' },
]

export default function UploadPage() {
  const location = useLocation() as any
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [duckAnim, setDuckAnim] = useState<any>(null)
  const queueRef = useRef<QueueItem[]>([])
  queueRef.current = queue

  useEffect(() => {
    (async () => {
      const r = await window.electronAPI.tgs.read('33.tgs')
      if (r.success) setDuckAnim(r.data)
    })()
  }, [])

  useEffect(() => {
    const off = window.electronAPI.telegram.onUploadProgress((d: any) => {
      if (!d.id) return
      setQueue(prev => prev.map(q => q.id === d.id ? { ...q, percent: d.percent, status: 'uploading' } : q))
    })
    return off
  }, [])

  useEffect(() => {
    const initial = location.state?.initialFiles
    if (initial && Array.isArray(initial)) addFiles(initial)
  }, [])

  const addFiles = (files: Array<{ filePath: string; fileName: string; fileSize: number }>) => {
    const items: QueueItem[] = files.map(f => ({
      id: Math.random().toString(36).slice(2),
      filePath: f.filePath, fileName: f.fileName, fileSize: f.fileSize,
      status: 'waiting', percent: 0
    }))
    setQueue(prev => [...prev, ...items])
    setTimeout(() => processQueue(), 50)
  }

  const processQueue = async () => {
    const items = queueRef.current.filter(q => q.status === 'waiting')
    for (const it of items) {
      if (it.fileSize > TG_LIMIT) {
        setQueue(prev => prev.map(q => q.id === it.id ? { ...q, status: 'failed', error: 'Exceeds 2GB' } : q))
        continue
      }
      setQueue(prev => prev.map(q => q.id === it.id ? { ...q, status: 'uploading' } : q))
      const res = await window.electronAPI.telegram.uploadFile(it.filePath, it.id)
      setQueue(prev => prev.map(q => q.id === it.id
        ? { ...q, status: res.success ? 'done' : 'failed', percent: res.success ? 100 : q.percent, error: res.success ? undefined : res.error }
        : q))
    }
  }

  const pickFiles = async () => {
    const r = await window.electronAPI.dialog.pickMultipleFiles()
    if (r.success) addFiles(r.data)
  }

  const [archiveInfo, setArchiveInfo] = useState<{ percent: number; phase: string; sent?: number; total?: number } | null>(null)
  const [archivePhases, setArchivePhases] = useState<Set<string>>(new Set())
  const archiveStart = useRef(0)
  const uploadStart = useRef(0)

  const pickFolder = async () => {
    const r = await window.electronAPI.dialog.pickFolder()
    if (!r.success || !r.data?.folderPath) return
    archiveStart.current = Date.now()
    uploadStart.current = 0
    setArchiveInfo({ percent: 0, phase: 'compressing' })
    setArchivePhases(new Set(['compressing']))
    await new Promise(r => setTimeout(r, 0))

    const off = window.electronAPI.folders.onArchiveProgress((d) => {
      setArchiveInfo(prev => {
        const next = { percent: d.percent, phase: d.phase }
        if (d.sent !== undefined) { (next as any).sent = d.sent; (next as any).total = d.total }
        if (d.phase === 'uploading' && prev?.phase !== 'uploading') uploadStart.current = Date.now()
        return next
      })
      setArchivePhases(prev => new Set(prev).add(d.phase))
    })
    let res: any
    try { res = await window.electronAPI.folders.archiveAndUpload({ folderPath: r.data.folderPath }) }
    catch (e) { res = { success: false, error: String(e) } }
    off()
    setArchiveInfo(null)
    if (res?.success && res.data) {
      const archiveName = res.data.archiveName || (r.data.folderPath.split('/').pop() || 'folder') + '.zip'
      setQueue(prev => [...prev, {
        id: Math.random().toString(36).slice(2),
        filePath: '',
        fileName: archiveName,
        fileSize: res.data.fileSize || 0,
        status: 'done' as const,
        percent: 100,
      }])
    }
  }

  const removeItem = (id: string) => setQueue(prev => prev.filter(q => q.id !== id))
  const clearDone = () => setQueue(prev => prev.filter(q => q.status !== 'done'))

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const dropped: any[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.electronAPI.getPathForFile(file)
      if (p) dropped.push({ filePath: p, fileName: file.name, fileSize: file.size })
    }
    if (dropped.length) addFiles(dropped)
  }

  const doneCount = queue.filter(q => q.status === 'done').length
  const failedCount = queue.filter(q => q.status === 'failed').length

  const fmtTime = (sec: number) =>
    sec < 60 ? `${sec}с` : `${Math.floor(sec / 60)}м ${sec % 60}с`
  const fmtBytes = (b: number) =>
    b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`

  const renderArchiveProgress = () => {
    if (!archiveInfo) return null
    const currentIdx = ALL_STEPS.findIndex(s => s.key === archiveInfo.phase)
    const visibleSteps = ALL_STEPS.slice(Math.min(currentIdx, 1))
    const now = Date.now()
    const phaseStart = archiveInfo.phase === 'uploading' && uploadStart.current ? uploadStart.current : archiveStart.current
    const elapsedSec = Math.floor((now - phaseStart) / 1000)
    const etaSec = (archiveInfo.sent !== undefined && archiveInfo.total && elapsedSec > 0)
      ? Math.round((archiveInfo.total - archiveInfo.sent) / (archiveInfo.sent / elapsedSec))
      : 0
    return (
      <div className="up-archive">
        <div className="up-archive-steps">
          {visibleSteps.map((s, i) => (
            <React.Fragment key={s.key}>
              {i > 0 && <div className={'up-archive-step-line' + (archivePhases.has(s.key) || archiveInfo.phase === s.key ? ' done' : '')} />}
              <div className={'up-archive-step' + (archiveInfo.phase === s.key ? ' active' : archivePhases.has(s.key) ? ' done' : '')}>
                <span className="up-archive-step-dot" /> {s.label}
              </div>
            </React.Fragment>
          ))}
        </div>
        <Archive size={28} style={{ color: 'var(--accent)' }} />
        <div className="up-archive-bar">
          <div className="up-bar">
            <div className="up-bar-fill up-archive-bar-fill" style={{ width: archiveInfo.percent + '%' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-mute)', marginTop: 4 }}>
            <span>{archiveInfo.percent}%</span>
            <span>
              {archiveInfo.sent !== undefined && archiveInfo.total
                ? `${fmtBytes(archiveInfo.sent)} / ${fmtBytes(archiveInfo.total)}`
                : fmtBytes(0)}
            </span>
            <span className="up-archive-time">
              {etaSec > 0 ? `~${fmtTime(etaSec)}` : fmtTime(elapsedSec)}
            </span>
          </div>
        </div>
        {duckAnim ? (
          <Player autoplay loop src={duckAnim} style={{ width: 90, height: 90 }} />
        ) : (
          <div style={{ width: 90, height: 90, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>🐤</div>
        )}
      </div>
    )
  }

  return (
    <div className="up-root">
      <div className="up-head">
        <h1>Загрузка файлов</h1>
        <div className="up-stats">
          <span>{doneCount} готово</span>
          {failedCount > 0 && <span className="warn">{failedCount} ошибок</span>}
          <span>{queue.length} всего</span>
        </div>
      </div>

      <div className={'up-drop' + (dragOver ? ' over' : '')}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}>
        <UploadIcon size={48} />
        <h2>Перетащите файлы сюда</h2>
        <p>или используйте кнопки ниже</p>
        <div className="up-actions">
          <button className="v3-btn primary" onClick={pickFiles}><UploadIcon size={16} /> Выбрать файлы</button>
          <button className="v3-btn" onClick={pickFolder}><FolderOpen size={16} /> Выбрать папку</button>
        </div>
      </div>

      {renderArchiveProgress()}

      {queue.length > 0 && archiveInfo === null && (
        <div className="up-queue">
          <div className="up-queue-head">
            <h2>Очередь загрузки</h2>
            <button onClick={clearDone}>Очистить завершённые</button>
          </div>
          <ul>
            {queue.map(q => (
              <li key={q.id} className={'up-item up-item-' + q.status}>
                <div className="up-item-info">
                  <div className="up-item-name">
                    {q.fileName}
                    {q.fileSize > TG_LIMIT && (
                      <span className="up-warn"><AlertTriangle size={12} /> Exceeds Telegram 2GB limit</span>
                    )}
                  </div>
                  <div className="up-item-meta">{fmtSize(q.fileSize)} • {q.status}{q.error ? ' - ' + q.error : ''}</div>
                </div>
                <div className="up-item-progress">
                  {q.status === 'uploading' && <Loader2 size={16} className="spin" />}
                  {q.status === 'done' && <CheckCircle2 size={16} className="ok" />}
                  {q.status === 'failed' && <AlertTriangle size={16} className="err" />}
                  <div className="up-bar"><div className="up-bar-fill" style={{ width: q.percent + '%' }} /></div>
                  <span className="up-pct">{q.percent}%</span>
                  {q.status === 'waiting' && <button onClick={() => removeItem(q.id)}><Trash2 size={14} /></button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
