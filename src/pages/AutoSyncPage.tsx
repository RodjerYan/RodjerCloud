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
    <div className="se-root">
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
                <div style={{ fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.fileName}{t.fileSize ? ` • ${fmtSize(t.fileSize)}` : ''}
                </div>
                {t.error && <div style={{ fontSize: 11, color: '#f87171', marginTop: 2 }}>{t.error}</div>}
              </div>
              <button onClick={() => clearToast(t.id)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 2, fontSize: 14, lineHeight: 1, opacity: 0.5 }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 24, paddingTop: 12 }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 28, letterSpacing: '-0.5px' }}>
          Авто-синхронизация
        </h1>
        <p style={{ color: 'var(--text-dim)', fontSize: 14, margin: 0 }}>Автоматическая загрузка новых файлов из отслеживаемых папок в Telegram</p>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <button onClick={() => save({ ...config, enabled: !config.enabled })} className={`v3-btn ${config.enabled ? '' : 'primary'}`}>
          {config.enabled ? <Square size={15} /> : <Play size={15} />}
          {config.enabled ? 'Остановить' : 'Запустить'}
        </button>
        <button onClick={() => setShowSettings(true)} className="v3-btn">
          <Settings2 size={15} /> Настроить
        </button>
        {config.enabled && (
          <button onClick={runScan} disabled={scanning} className="v3-btn">
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
            {queue.map(item => (
              <div key={item.id} style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 12,
                background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
                transition: 'all 0.2s'
              }}>
                <span style={{ fontSize: 20, flexShrink: 0, filter: item.status === 'uploading' ? 'drop-shadow(0 0 8px rgba(124, 200, 255, 0.5))' : 'none' }}>
                  {item.status === 'done' ? '✅' : item.status === 'failed' ? '❌' : item.status === 'uploading' ? '📤' : '⏳'}
                </span>
                <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.fileName}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>
                      {item.status === 'pending' && 'Ожидает'}
                      {item.status === 'uploading' && <span style={{ color: '#7cc8ff', fontWeight: 600 }}>{item.percent}%</span>}
                      {item.status === 'done' && <span style={{ color: '#34d399' }}>Готово</span>}
                      {item.status === 'failed' && <span style={{ color: '#f87171' }}>Ошибка</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>{fmtSize(item.fileSize)}</div>
                  {(item.status === 'uploading' || item.status === 'done') && (
                    <div style={{ width: '100%', height: 2, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{ width: `${item.percent}%`, height: '100%', borderRadius: 99, background: item.status === 'done' ? '#34d399' : 'linear-gradient(90deg, #22d3ee, #a855f7)', transition: 'width 0.3s ease-out', boxShadow: '0 0 8px rgba(168,85,247,0.5)' }} />
                    </div>
                  )}
                  {item.status === 'failed' && item.error && <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>{item.error}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Visual Dashboard */}
      <div className="settings-card" style={{ padding: '24px', marginBottom: 24, display: 'flex', gap: 40, alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
        <div style={{ position: 'relative', width: 140, height: 140, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg viewBox="0 0 100 100" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)', width: '100%', height: '100%', filter: 'drop-shadow(0 0 12px rgba(168, 85, 247, 0.5))' }}>
            <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
            <circle cx="50" cy="50" r="45" fill="none" stroke="url(#dash-gradient)" strokeWidth="6" strokeDasharray="283" strokeDashoffset={283 - (283 * (totalFileCount ? Math.min(status.uploadedCount / totalFileCount, 1) : 0))} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 1s ease-out' }} />
            <defs>
              <linearGradient id="dash-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#22d3ee" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
            </defs>
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
            <span style={{ fontSize: 32, fontWeight: 800, background: 'linear-gradient(135deg, #22d3ee, #a855f7)', WebkitBackgroundClip: 'text', color: 'transparent', lineHeight: 1 }}>
              {Math.round(totalFileCount ? Math.min(status.uploadedCount / totalFileCount, 1) * 100 : 0)}%
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 1, marginTop: 4, fontWeight: 600 }}>Загружено</span>
          </div>
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 }}>В папках</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--text)' }}>{totalFileCount}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 }}>Синхрон.</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: '#34d399' }}>{status.uploadedCount}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 }}>Ошибок</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: '#f87171' }}>{status.failedCount}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 }}>Статус</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, background: config.enabled ? '#34d399' : '#f87171', boxShadow: config.enabled ? '0 0 16px rgba(52,211,153,0.6)' : '0 0 12px rgba(248,113,113,0.3)', animation: config.enabled ? 'v3-pulse 1.4s ease-in-out infinite' : 'none' }} />
              <span style={{ fontSize: 16, fontWeight: 600, color: config.enabled ? '#34d399' : '#f87171' }}>
                {config.enabled ? 'Активна' : 'Остановлена'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-card" style={{ background: 'url(https://www.transparenttextures.com/patterns/stardust.png) rgba(15,18,30,0.4)', backgroundBlendMode: 'overlay' }}>
        <div className="settings-header">
          <Clock size={18} className="settings-header-icon" />
          <h2>Режим синхронизации</h2>
        </div>
        <div className="settings-body" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', gap: 20 }}>
            <div onClick={() => save({ ...config, mode: 'default' })} style={{ flex: 1, padding: 24, borderRadius: 20, cursor: 'pointer', background: config.mode === 'default' ? 'rgba(34, 211, 238, 0.08)' : 'rgba(255,255,255,0.02)', border: `2px solid ${config.mode === 'default' ? '#22d3ee' : 'rgba(255,255,255,0.05)'}`, boxShadow: config.mode === 'default' ? '0 0 30px rgba(34, 211, 238, 0.2), inset 0 0 20px rgba(34, 211, 238, 0.1)' : 'none', backdropFilter: 'blur(12px)', transition: 'all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)', transform: config.mode === 'default' ? 'scale(1.02)' : 'scale(1)' }}>
              <div style={{ fontSize: 32, marginBottom: 16, filter: config.mode === 'default' ? 'drop-shadow(0 0 12px rgba(34, 211, 238, 0.6))' : 'none' }}>📁</div>
              <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6, color: config.mode === 'default' ? '#fff' : 'var(--text)' }}>Стандартные</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 16, lineHeight: 1.4 }}>Автоматически собираем файлы из базовых папок системы: Documents, Downloads, Pictures, Desktop.</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {DEFAULTS.map(d => (
                  <span key={d} className="v3-chip" style={{ background: config.mode === 'default' ? 'rgba(34, 211, 238, 0.15)' : '', color: config.mode === 'default' ? '#22d3ee' : '', border: config.mode === 'default' ? '1px solid rgba(34, 211, 238, 0.3)' : '' }}>{d}</span>
                ))}
              </div>
            </div>
            <div onClick={() => save({ ...config, mode: 'custom' })} style={{ flex: 1, padding: 24, borderRadius: 20, cursor: 'pointer', background: config.mode === 'custom' ? 'rgba(168, 85, 247, 0.08)' : 'rgba(255,255,255,0.02)', border: `2px solid ${config.mode === 'custom' ? '#a855f7' : 'rgba(255,255,255,0.05)'}`, boxShadow: config.mode === 'custom' ? '0 0 30px rgba(168, 85, 247, 0.2), inset 0 0 20px rgba(168, 85, 247, 0.1)' : 'none', backdropFilter: 'blur(12px)', transition: 'all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)', transform: config.mode === 'custom' ? 'scale(1.02)' : 'scale(1)' }}>
              <div style={{ fontSize: 32, marginBottom: 16, filter: config.mode === 'custom' ? 'drop-shadow(0 0 12px rgba(168, 85, 247, 0.6))' : 'none' }}>📂</div>
              <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6, color: config.mode === 'custom' ? '#fff' : 'var(--text)' }}>Свои папки</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.4 }}>Выберите конкретные папки вручную. Мы будем следить только за ними и игнорировать остальные.</div>
              {config.mode === 'custom' && config.customPaths?.length > 0 && (
                <div style={{ marginTop: 16, fontSize: 14, color: '#a855f7', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#a855f7', boxShadow: '0 0 8px #a855f7' }} />
                  Отслеживается {config.customPaths.length} папка(и)
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {config.mode === 'custom' && (
        <div className="settings-card">
          <div className="settings-header">
            <FolderOpen size={18} className="settings-header-icon" />
            <h2>Папки</h2>
          </div>
          <div className="settings-body" style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {(config.customPaths || []).length === 0 && (
                <div style={{ color: 'var(--text-dim)', textAlign: 'center', padding: '20px 0', fontSize: 14 }}>Папки ещё не добавлены</div>
              )}
              {(config.customPaths || []).map((p: string) => (
                <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 18 }}>📁</span>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.split('\\').pop() || p}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</div>
                  </div>
                  <button onClick={() => removePath(p)} className="v3-btn" style={{ padding: '6px 10px', color: 'var(--danger)' }} title="Удалить">
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button onClick={addPath} className="v3-btn primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
              <FolderPlus size={16} /> Добавить папку
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
