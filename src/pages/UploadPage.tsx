import React, { useEffect, useState, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { Upload as UploadIcon, FolderOpen, Trash2, AlertTriangle, CheckCircle2, Loader2, Archive, Lock, Unlock } from 'lucide-react'
import { Player } from '@lottiefiles/react-lottie-player'
import { fmtSize } from '../lib/utils'
import { useUploadQueue } from '../lib/UploadQueueContext'

const TG_LIMIT = 2 * 1024 * 1024 * 1024
const CHUNK_SIZE = Math.floor(1.95 * 1024 * 1024 * 1024)

const ALL_STEPS = [
  { key: 'downloading', label: 'Скачивание' },
  { key: 'compressing', label: 'Архивация' },
  { key: 'uploading', label: 'Загрузка' },
]

export default function UploadPage() {
  const location = useLocation() as any
  const { queue, archiveInfo, archivePhases, addFiles, removeItem, clearDone, pickFolder } = useUploadQueue()
  const [dragOver, setDragOver] = useState(false)
  const [encryptNext, setEncryptNext] = useState(localStorage.getItem('v3.encryptNext') === '1')
  const [showPwdPrompt, setShowPwdPrompt] = useState(false)
  const [duckAnim, setDuckAnim] = useState<any>(null)

  useEffect(() => {
    (async () => {
      const r = await window.electronAPI.tgs.read('33.tgs')
      if (r.success) setDuckAnim(r.data)
    })()
  }, [])

  useEffect(() => {
    const initial = location.state?.initialFiles
    if (initial && Array.isArray(initial)) addFiles(initial, encryptNext)
  }, [])

  const pickFiles = async () => {
    const r = await window.electronAPI.dialog.pickMultipleFiles()
    if (r.success) addFiles(r.data, encryptNext)
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const dropped: any[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.electronAPI.getPathForFile(file)
      if (p) dropped.push({ filePath: p, fileName: file.name, fileSize: file.size })
    }
    if (dropped.length) addFiles(dropped, encryptNext)
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
    const phaseStart = archiveInfo.phase === 'uploading' ? (archiveInfo as any).uploadStartTime || Date.now() : (archiveInfo as any).archiveStartTime || Date.now()
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
          <button className="v3-btn" onClick={() => pickFolder(encryptNext)}><FolderOpen size={16} /> Выбрать папку</button>
        </div>
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center' }}>
          <div 
            onClick={async (e) => {
              e.stopPropagation()
              const checked = !encryptNext
              if (checked) {
                const has = await window.electronAPI.vault.hasPassword()
                const unl = await window.electronAPI.vault.isUnlocked()
                if (!has || !unl) return setShowPwdPrompt(true)
              }
              setEncryptNext(checked)
              localStorage.setItem('v3.encryptNext', checked ? '1' : '0')
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer',
              padding: '14px 24px', borderRadius: 20,
              background: encryptNext ? 'linear-gradient(135deg, rgba(46,204,113,0.08), rgba(39,174,96,0.15))' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${encryptNext ? 'rgba(46,204,113,0.3)' : 'rgba(255,255,255,0.05)'}`,
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: encryptNext ? '0 8px 32px rgba(46,204,113,0.15), inset 0 1px 0 rgba(255,255,255,0.1)' : 'inset 0 1px 0 rgba(255,255,255,0.02)',
              backdropFilter: 'blur(10px)'
            }}
          >
            <div style={{
              width: 44, height: 24, borderRadius: 12, position: 'relative',
              background: encryptNext ? '#2ecc71' : 'rgba(255,255,255,0.1)',
              transition: 'background 0.3s',
            }}>
              <div style={{
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                position: 'absolute', top: 2, left: encryptNext ? 22 : 2,
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
              }} />
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: encryptNext ? '#2ecc71' : 'var(--text-main)', transition: 'color 0.3s' }}>
                Сквозное шифрование (Сейф)
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-mute)', marginTop: 2 }}>
                {encryptNext ? 'Файлы будут зашифрованы локально' : 'Нажмите, чтобы включить защиту'}
              </span>
            </div>

            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 36, height: 36, borderRadius: '50%',
              background: encryptNext ? 'rgba(46,204,113,0.15)' : 'rgba(255,255,255,0.05)',
              color: encryptNext ? '#2ecc71' : 'var(--text-mute)',
              transition: 'all 0.3s', marginLeft: 8
            }}>
              {encryptNext ? <Lock size={18} /> : <Unlock size={18} />}
            </div>
          </div>
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
                    {q.encrypt && <span title="Будет зашифровано">🔒 </span>}
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
                  {q.fileSize > 50 * 1024 * 1024 && q.sent !== undefined && q.total ? (
                    <>
                      <span className="up-detail">{fmtSize(q.sent)} / {fmtSize(q.total)}</span>
                      <span className="up-detail">ост. {fmtSize(Math.max(0, q.total - q.sent))}</span>
                      {(() => { const totalCh = Math.max(1, Math.ceil(q.total / CHUNK_SIZE)); const curCh = Math.min(totalCh, Math.max(1, Math.ceil((q.sent || 1) / CHUNK_SIZE))); return totalCh > 1 ? <span className="up-detail">ч. {curCh}/{totalCh}</span> : null })()}
                    </>
                  ) : null}
                  {q.status === 'waiting' && <button onClick={() => removeItem(q.id)}><Trash2 size={14} /></button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showPwdPrompt && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="v3-card" style={{ padding: 24, width: 400, maxWidth: '90%', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h3 style={{ margin: 0 }}>Настройка Сейфа</h3>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--text-mute)' }}>Придумайте мастер-пароль. Он будет надежно сохранен на вашем устройстве.</p>
            <input type="password" id="vault-pwd" placeholder="Мастер-пароль" style={{ padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', width: '100%', boxSizing: 'border-box', fontSize: 16 }} autoFocus />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="v3-btn ghost" onClick={() => setShowPwdPrompt(false)}>Отмена</button>
              <button className="v3-btn primary" onClick={async () => {
                const pwd = (document.getElementById('vault-pwd') as HTMLInputElement).value
                if (!pwd) return
                await window.electronAPI.vault.setPassword(pwd)
                setShowPwdPrompt(false)
                setEncryptNext(true)
                localStorage.setItem('v3.encryptNext', '1')
              }}>Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
