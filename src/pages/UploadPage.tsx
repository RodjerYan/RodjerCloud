import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Upload as UploadIcon, FolderOpen, Trash2, AlertTriangle, CheckCircle2, Clock3, Loader2, Archive, Lock, Unlock, X } from 'lucide-react'
import { Player } from '@lottiefiles/react-lottie-player'
import { fmtSize } from '../lib/utils'
import { useUploadQueue, type QueueItem as UploadQueueEntry } from '../lib/UploadQueueContext'

const CHUNK_SIZE = 1 * 1024 * 1024 * 1024

const STATUS_LABELS: Record<UploadQueueEntry['status'], string> = {
  waiting: 'В очереди',
  uploading: 'Загружается',
  done: 'Завершено',
  failed: 'Ошибка',
}

const UploadQueueItem = React.memo(({ q, onCancel }: { q: UploadQueueEntry; onCancel: (id: string) => void }) => {
  const percent = Math.min(100, Math.max(0, Math.round(q.percent || 0)))
  const total = q.total || q.fileSize || 0
  const sent = Math.min(total, Math.max(0, q.sent || 0))
  const totalChunks = Math.max(1, Math.ceil(total / CHUNK_SIZE))
  const currentChunk = Math.min(totalChunks, Math.max(1, Math.ceil((sent || 1) / CHUNK_SIZE)))
  const showTransferDetails = q.status === 'uploading' && q.fileSize > 50 * 1024 * 1024 && total > 0

  return (
    <li className={'up-item up-item-' + q.status} aria-current={q.status === 'uploading' ? 'true' : undefined}>
      <div className="up-item-state" aria-hidden="true">
        {q.status === 'uploading' && <Loader2 size={17} className="spin" />}
        {q.status === 'waiting' && <Clock3 size={17} />}
        {q.status === 'done' && <CheckCircle2 size={17} />}
        {q.status === 'failed' && <AlertTriangle size={17} />}
      </div>

      <div className="up-item-info">
        <div className="up-item-name-row">
          {q.encrypt && <span className="up-encrypted" title="Файл зашифрован"><Lock size={13} /></span>}
          <span className="up-item-name" title={q.fileName}>{q.fileName}</span>
        </div>
        <div className="up-item-meta">
          <span>{fmtSize(q.fileSize)}</span>
          <span className={'up-status-label up-status-' + q.status}>{STATUS_LABELS[q.status]}</span>
          {q.fileSize > CHUNK_SIZE && (
            <span className="up-warn"><AlertTriangle size={11} /> {totalChunks} части</span>
          )}
          {q.error && <span className="up-error" title={q.error}>{q.error}</span>}
        </div>
      </div>

      <div className="up-item-progress">
        <div className="up-progress-row">
          <div
            className="up-bar"
            role="progressbar"
            aria-label={`Прогресс загрузки ${q.fileName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="up-bar-fill" style={{ width: percent + '%' }} />
          </div>
          <span className="up-pct">{percent}%</span>
        </div>
        {showTransferDetails && (
          <div className="up-progress-meta">
            <span>{fmtSize(sent)} / {fmtSize(total)}</span>
            <span>Осталось {fmtSize(Math.max(0, total - sent))}</span>
            {totalChunks > 1 && <span>Часть {currentChunk}/{totalChunks}</span>}
          </div>
        )}
      </div>

      <div className="up-item-action">
        {(q.status === 'waiting' || q.status === 'uploading') && (
          <button type="button" onClick={() => onCancel(q.id)} title="Отменить" aria-label={`Отменить загрузку ${q.fileName}`}>
            <X size={15} />
          </button>
        )}
      </div>
    </li>
  )
})

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
  const uploadingCount = queue.filter(q => q.status === 'uploading').length
  const waitingCount = queue.filter(q => q.status === 'waiting').length
  const hasPending = uploadingCount + waitingCount > 0
  const visibleQueue = useMemo(() => [
    ...queue.filter(q => q.status === 'uploading'),
    ...queue.filter(q => q.status === 'waiting'),
    ...queue.filter(q => q.status === 'failed'),
    ...queue.filter(q => q.status === 'done'),
  ], [queue])

  const handleCancel = useCallback((id: string) => {
    void window.electronAPI.telegram.cancelUpload(id)
    removeItem(id)
  }, [removeItem])

  const toggleEncryption = async () => {
    const checked = !encryptNext
    if (checked) {
      const has = await window.electronAPI.vault.hasPassword()
      const unlocked = await window.electronAPI.vault.isUnlocked()
      if (!has || !unlocked) {
        setShowPwdPrompt(true)
        return
      }
    }
    setEncryptNext(checked)
    localStorage.setItem('v3.encryptNext', checked ? '1' : '0')
  }

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

      <div className={'up-drop' + (dragOver ? ' over' : '') + (queue.length > 0 ? ' compact' : '')}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}>
        <div className="up-drop-main">
          <div className="up-drop-icon"><UploadIcon size={queue.length > 0 ? 22 : 44} /></div>
          <div className="up-drop-copy">
            <h2>Перетащите файлы сюда</h2>
            <p>или добавьте их с компьютера</p>
          </div>
          <div className="up-actions">
            <button type="button" className="v3-btn primary" onClick={pickFiles}><UploadIcon size={16} /> Выбрать файлы</button>
            <button type="button" className="v3-btn" onClick={() => pickFolder(encryptNext)}><FolderOpen size={16} /> Выбрать папку</button>
          </div>
        </div>
        <button
          type="button"
          className={'up-encryption-toggle' + (encryptNext ? ' active' : '')}
          role="switch"
          aria-checked={encryptNext}
          onClick={toggleEncryption}
        >
          <span className="up-toggle-track" aria-hidden="true"><span className="up-toggle-thumb" /></span>
          <span className="up-encryption-copy">
            <strong>Сквозное шифрование</strong>
            <small>{encryptNext ? 'Файлы будут зашифрованы локально' : 'Защита новых файлов отключена'}</small>
          </span>
          <span className="up-encryption-icon" aria-hidden="true">{encryptNext ? <Lock size={17} /> : <Unlock size={17} />}</span>
        </button>
      </div>

      {renderArchiveProgress()}

      {queue.length > 0 && archiveInfo === null && (
        <div className="up-queue">
          <div className={'up-queue-head' + (hasPending ? ' sticky' : '')}>
            <div className="up-queue-title">
              <h2>Очередь загрузки</h2>
              <div className="up-queue-summary" role="status">
                {uploadingCount > 0 && <span className="active">{uploadingCount} загружается</span>}
                {waitingCount > 0 && <span>{waitingCount} в очереди</span>}
                {failedCount > 0 && <span className="failed">{failedCount} с ошибкой</span>}
                {doneCount > 0 && <span>{doneCount} готово</span>}
              </div>
            </div>
            <button type="button" onClick={clearDone} disabled={doneCount === 0}><Trash2 size={14} /> Очистить завершённые</button>
          </div>
          <ul>
            {visibleQueue.map(q => (
              <UploadQueueItem key={q.id} q={q} onCancel={handleCancel} />
            ))}
          </ul>
        </div>
      )}

      {showPwdPrompt && (
        <div className="up-vault-overlay" onMouseDown={() => setShowPwdPrompt(false)}>
          <div className="v3-card up-vault-modal" role="dialog" aria-modal="true" aria-labelledby="up-vault-title" onMouseDown={e => e.stopPropagation()}>
            <div className="up-vault-icon" aria-hidden="true"><Lock size={21} /></div>
            <h3 id="up-vault-title">Настройка Сейфа</h3>
            <p>Придумайте мастер-пароль. Он будет надёжно сохранён на вашем устройстве.</p>
            <label className="up-field-label" htmlFor="vault-pwd">Мастер-пароль</label>
            <input
              type="password"
              id="vault-pwd"
              className="v3-input"
              placeholder="Введите мастер-пароль"
              autoComplete="new-password"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') document.getElementById('up-vault-save')?.click() }}
            />
            <div className="up-vault-actions">
              <button type="button" className="v3-btn ghost" onClick={() => setShowPwdPrompt(false)}>Отмена</button>
              <button type="button" id="up-vault-save" className="v3-btn primary" onClick={async () => {
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
