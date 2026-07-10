import React, { useEffect, useState, useRef } from 'react'
import { Play, Square, FolderPlus, Clock, Shield, FolderOpen, Settings2, Upload, CheckCircle, AlertCircle, Loader2, RefreshCw, FileText } from 'lucide-react'
import AutoSyncSettings from '../components/AutoSyncSettings'
import { fmtSize } from '../lib/utils'

const DEFAULTS = ['Documents', 'Downloads', 'Pictures', 'Desktop']

interface QueueItem { id: string; filePath: string; fileName: string; fileSize: number; status: 'pending' | 'uploading' | 'done' | 'failed'; percent: number; error?: string }
interface SyncEvent { type: string; file?: string; current?: number; total?: number; uploaded?: number; failed?: number; error?: string; ts?: number; queue?: QueueItem[] }

const eventIcon: Record<string, string> = { detected: '👁️', uploading: '📤', uploaded: '✅', failed: '❌', skipped: '⏭️', 'scan-start': '🔍', 'scan-progress': '📡', 'scan-done': '🏁', started: '▶️', stopped: '⏹️', error: '⚠️' }
const eventColor: Record<string, string> = { uploaded: '#34d399', failed: '#f87171', uploading: '#7cc8ff', skipped: '#fbbf24', error: '#f87171', detected: '#b9d8ff', 'scan-progress': '#7cc8ff' }

export default function AutoSyncPage() {
  const [showSettings, setShowSettings] = useState(false)
  const [config, setConfig] = useState<any>({ enabled: false, mode: 'default', customPaths: [], fileFilter: { enabled: false, extensions: [] }, excludePatterns: [] })
  const [status, setStatus] = useState<any>({ isRunning: false, watchPaths: [], uploadedCount: 0, failedCount: 0 })
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [log, setLog] = useState<SyncEvent[]>([])
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [totalFileCount, setTotalFileCount] = useState(0)
  const logEndRef = useRef<HTMLDivElement>(null)
  const unsub = useRef<(() => void) | null>(null)

  const load = async () => {
    const [c, s, q, l, f] = await Promise.all([
      window.electronAPI.autoSync.getConfig(),
      window.electronAPI.autoSync.getStatus(),
      window.electronAPI.autoSync.getQueue(),
      window.electronAPI.autoSync.getLog(),
      window.electronAPI.autoSync.countFiles(),
    ])
    if (c.success) setConfig(c.data)
    if (s.success) setStatus(s.data)
    if (q.success) setQueue(q.data)
    if (l.success) setLog(l.data)
    if (f.success) setTotalFileCount(f.data.count)
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    unsub.current = window.electronAPI.autoSync.onStatus((e: SyncEvent) => {
      if (e.type === 'scan-start') { setScanProgress({ current: 0, total: e.total || 0 }); setScanning(true) }
      else if (e.type === 'scan-progress') setScanProgress({ current: e.current || 0, total: e.total || 0 })
      else if (e.type === 'scan-done') { setScanProgress(null); setScanning(false) }
      if (e.queue) setQueue(e.queue)
      setLog(prev => [{ ...e, ts: e.ts || Date.now() }, ...prev].slice(0, 100))
      if (e.type === 'uploaded' || e.type === 'failed') {
        addToast({ fileName: e.file || '?', status: e.type, error: e.error })
      }
    })
    return () => { clearInterval(t); unsub.current?.() }
  }, [])

  // auto-scroll removed — it was pulling the whole page down

  const save = async (c: any) => {
    setConfig(c)
    await window.electronAPI.autoSync.updateConfig(c)
    if (c.enabled) { await window.electronAPI.autoSync.start() }
    else await window.electronAPI.autoSync.stop()
  }

  const runTestUpload = async () => {
    setTesting(true); setTestResult(null)
    const r = await window.electronAPI.autoSync.testUpload()
    if (r.success) setTestResult({ success: true, message: `"${r.data.fileName}" загружен в канал` })
    else setTestResult({ success: false, message: r.error || 'Ошибка' })
    setTesting(false)
  }

  const addPath = async () => {
    const r = await window.electronAPI.dialog.pickFolder()
    if (r.success) await save({ ...config, customPaths: [...(config.customPaths || []), r.data.folderPath] })
  }
  const removePath = (p: string) => save({ ...config, customPaths: config.customPaths.filter((x: string) => x !== p) })

  const runScan = async () => {
    setScanning(true); setTestResult(null)
    const r = await window.electronAPI.autoSync.scanNow()
    if (!r.success) setTestResult({ success: false, message: r.error || 'Ошибка' })
  }

  const doneCount = queue.filter(q => q.status === 'done').length
  const failCount = queue.filter(q => q.status === 'failed').length
  const progressCount = queue.filter(q => q.status === 'uploading' || q.status === 'pending').length

  // ===== Toast notifications =====
  interface Toast { id: string; fileName: string; status: 'uploaded' | 'failed'; fileSize?: number; error?: string; ts: number }
  const [toasts, setToasts] = useState<Toast[]>([])
  const addToast = (t: Omit<Toast, 'id' | 'ts'>) => {
    const id = Math.random().toString(36).slice(2, 8)
    const toast: Toast = { ...t, id, ts: Date.now() }
    setToasts(prev => [toast, ...prev].slice(0, 10))
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 5000)
  }
  const clearToast = (id: string) => setToasts(prev => prev.filter(x => x.id !== id))

  return (
    <div style={{ padding: '28px 36px', minHeight: '100vh', position: 'relative', zIndex: 1 }}>
      {showSettings && <AutoSyncSettings onClose={() => setShowSettings(false)} />}

      {/* ===== Toast container ===== */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 400 }}>
          {toasts.map(t => (
            <div key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
              borderRadius: 12, background: 'rgba(15,18,30,0.95)', border: `1px solid ${t.status === 'uploaded' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}`,
              backdropFilter: 'blur(20px)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              animation: 'fadeInUp 0.25s ease',
            }}>
              <span style={{ fontSize: 18 }}>{t.status === 'uploaded' ? '✅' : '❌'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: t.status === 'uploaded' ? '#34d399' : '#f87171' }}>
                  {t.status === 'uploaded' ? 'Загружен' : 'Ошибка загрузки'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--v3-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.fileName}{t.fileSize ? ` • ${fmtSize(t.fileSize)}` : ''}
                </div>
                {t.error && <div style={{ fontSize: 11, color: '#f87171', marginTop: 2 }}>{t.error}</div>}
              </div>
              <button onClick={() => clearToast(t.id)} style={{ background: 'none', border: 'none', color: 'var(--v3-text-dim)', cursor: 'pointer', padding: 2, fontSize: 14, lineHeight: 1, opacity: 0.5 }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', background: 'linear-gradient(135deg, #22d3ee 0%, #a855f7 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
          Авто-синхронизация
        </h1>
        <p style={{ color: 'var(--v3-text-dim)', fontSize: 14, margin: '4px 0 0' }}>Автоматическая загрузка новых файлов из отслеживаемых папок в Telegram</p>
      </div>

      <div style={{ display: 'flex', gap: 14, marginBottom: 24 }}>
        <button onClick={() => save({ ...config, enabled: !config.enabled })} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 12,
          border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit',
          background: config.enabled ? 'linear-gradient(135deg, #f87171, #ef4444)' : 'linear-gradient(135deg, #22d3ee 0%, #a855f7 100%)',
          color: '#fff', boxShadow: config.enabled ? '0 4px 20px rgba(248,113,113,0.3)' : '0 4px 20px rgba(34,211,238,0.25)',
        }}>
          {config.enabled ? <Square size={15} /> : <Play size={15} />}
          {config.enabled ? 'Остановить' : 'Запустить'}
        </button>
        <button onClick={() => setShowSettings(true)} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 12,
          border: '1px solid var(--v3-border-strong)', cursor: 'pointer', fontWeight: 500, fontSize: 14, fontFamily: 'inherit',
          background: 'rgba(255,255,255,0.03)', color: 'var(--v3-text)',
        }}>
          <Settings2 size={15} /> Настроить
        </button>
        {config.enabled && (
          <button onClick={runScan} disabled={scanning} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 12,
            border: '1px dashed var(--v3-border-strong)', cursor: scanning ? 'wait' : 'pointer',
            fontWeight: 500, fontSize: 14, fontFamily: 'inherit',
            background: 'rgba(255,255,255,0.03)', color: 'var(--v3-text)',
          }}>
            {scanning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            {scanning ? 'Сканирование...' : 'Сканировать'}
          </button>
        )}
      </div>

      {scanProgress && (
        <div style={{ marginBottom: 16, padding: '14px 18px', borderRadius: 14, background: 'rgba(124,200,255,0.06)', border: '1px solid rgba(124,200,255,0.2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#b9d8ff' }}>
              <Loader2 size={13} style={{ marginRight: 6, animation: 'spin 1s linear infinite' }} />
              Сканирование...
            </span>
            <span style={{ fontSize: 12, color: 'var(--v3-text-dim)' }}>{scanProgress.current} / {scanProgress.total}</span>
          </div>
          <div style={{ width: '100%', height: 6, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ width: `${scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0}%`, height: '100%', borderRadius: 99, background: 'linear-gradient(90deg, #22d3ee, #a855f7)', transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      {/* ===== Upload queue ===== */}
      {queue.length > 0 && (
        <div className="v3-card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <Upload size={16} style={{ color: 'var(--v3-text-dim)' }} />
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--v3-text-dim)' }}>Очередь загрузки</h2>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--v3-text-dim)', display: 'flex', gap: 12 }}>
              <span style={{ color: '#7cc8ff' }}>{progressCount} в очереди</span>
              <span style={{ color: '#34d399' }}>{doneCount} готово</span>
              {failCount > 0 && <span style={{ color: '#f87171' }}>{failCount} ошибок</span>}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflow: 'auto' }}>
            {queue.map(item => (
              <div key={item.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 12,
                background: 'rgba(255,255,255,0.02)', border: '1px solid var(--v3-border-soft)',
              }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>
                  {item.status === 'done' ? '✅' : item.status === 'failed' ? '❌' : item.status === 'uploading' ? '📤' : '⏳'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.fileName}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--v3-text-dim)', marginTop: 2 }}>{fmtSize(item.fileSize)}</div>
                  {(item.status === 'uploading' || item.status === 'done') && (
                    <div style={{ marginTop: 4, width: '100%', height: 4, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{ width: `${item.percent}%`, height: '100%', borderRadius: 99, background: item.status === 'done' ? '#34d399' : 'linear-gradient(90deg, #22d3ee, #a855f7)', transition: 'width 0.3s' }} />
                    </div>
                  )}
                  {item.status === 'uploading' && <div style={{ fontSize: 10, color: '#7cc8ff', marginTop: 2 }}>{item.percent}%</div>}
                  {item.status === 'failed' && item.error && <div style={{ fontSize: 10, color: '#f87171', marginTop: 2 }}>{item.error}</div>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--v3-text-dim)', flexShrink: 0 }}>
                  {item.status === 'pending' && 'Ожидает'}
                  {item.status === 'uploading' && `${item.percent}%`}
                  {item.status === 'done' && 'Готово'}
                  {item.status === 'failed' && 'Ошибка'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 16 }}>
        <div className="v3-card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ color: 'var(--v3-text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Файлов в папках</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#e0e0e0' }}>{totalFileCount}</div>
        </div>
        <div className="v3-card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ color: 'var(--v3-text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Загружено</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#34d399' }}>{status.uploadedCount}</div>
        </div>
        <div className="v3-card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ color: 'var(--v3-text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Ошибок</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#f87171' }}>{status.failedCount}</div>
        </div>
        <div className="v3-card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ color: 'var(--v3-text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Статус</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: config.enabled ? '#34d399' : '#f87171', boxShadow: config.enabled ? '0 0 12px #34d399' : '0 0 12px #f87171', animation: config.enabled ? 'v3-pulse 1.4s ease-in-out infinite' : 'none' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: config.enabled ? '#34d399' : '#f87171' }}>
              {config.enabled ? 'Активна' : 'Остановлена'}
            </span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }}>
        <div className="v3-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <Clock size={16} style={{ color: 'var(--v3-text-dim)' }} />
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--v3-text-dim)' }}>Режим</h2>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div onClick={() => save({ ...config, mode: 'default' })} style={{ flex: 1, padding: 16, borderRadius: 14, cursor: 'pointer', background: config.mode === 'default' ? 'rgba(124,200,255,0.08)' : 'rgba(255,255,255,0.02)', border: `1.5px solid ${config.mode === 'default' ? 'rgba(124,200,255,0.35)' : 'var(--v3-border-soft)'}` }}>
              <div style={{ fontSize: 22, marginBottom: 6 }}>📁</div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>Стандартные</div>
              <div style={{ color: 'var(--v3-text-dim)', fontSize: 12, marginBottom: 8 }}>Documents, Downloads, Pictures, Desktop</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {DEFAULTS.map(d => (
                  <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 99, fontSize: 10, background: 'rgba(124,200,255,0.1)', color: '#b9d8ff', border: '1px solid rgba(124,200,255,0.2)' }}>{d}</span>
                ))}
              </div>
            </div>
            <div onClick={() => save({ ...config, mode: 'custom' })} style={{ flex: 1, padding: 16, borderRadius: 14, cursor: 'pointer', background: config.mode === 'custom' ? 'rgba(124,200,255,0.08)' : 'rgba(255,255,255,0.02)', border: `1.5px solid ${config.mode === 'custom' ? 'rgba(124,200,255,0.35)' : 'var(--v3-border-soft)'}` }}>
              <div style={{ fontSize: 22, marginBottom: 6 }}>📂</div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>Свои папки</div>
              <div style={{ color: 'var(--v3-text-dim)', fontSize: 12 }}>Выберите конкретные папки вручную</div>
              {config.mode === 'custom' && config.customPaths?.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--v3-text-dim)' }}>{config.customPaths.length} папка(и)</div>
              )}
            </div>
          </div>
        </div>


      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {config.mode === 'custom' && (
            <div className="v3-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <FolderOpen size={16} style={{ color: 'var(--v3-text-dim)' }} />
                <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--v3-text-dim)' }}>Папки</h2>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {(config.customPaths || []).length === 0 && (
                  <div style={{ color: 'var(--v3-text-dim)', textAlign: 'center', padding: '20px 0', fontSize: 13 }}>Папки ещё не добавлены</div>
                )}
                {(config.customPaths || []).map((p: string) => (
                  <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--v3-border-soft)' }}>
                    <span style={{ fontSize: 14 }}>📁</span>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.split('\\').pop() || p}</div>
                      <div style={{ fontSize: 11, color: 'var(--v3-text-dim)', marginTop: 1 }}>{p}</div>
                    </div>
                    <button onClick={() => removePath(p)} style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', display: 'flex', fontSize: 12 }}>✕</button>
                  </div>
                ))}
              </div>
              <button onClick={addPath} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '10px 16px', borderRadius: 12, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg, #22d3ee 0%, #a855f7 100%)', color: '#0a0a14', fontWeight: 700, fontSize: 14, fontFamily: 'inherit', boxShadow: '0 4px 16px rgba(124,200,255,0.15)' }}>
                <FolderPlus size={15} /> Добавить папку
              </button>
            </div>
          )}


        </div>


      </div>
    </div>
  )
}
