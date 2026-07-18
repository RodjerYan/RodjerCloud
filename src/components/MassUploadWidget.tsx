import React, { useState } from 'react'
import { ChevronUp, ChevronDown, CheckCircle2, AlertCircle, Loader2, X, RefreshCw } from 'lucide-react'

export interface PendingUpload {
  id: string
  fileName: string
  progress: number
  folderId?: string | null
  objectUrl?: string
  status?: 'waiting' | 'uploading' | 'done' | 'error'
  error?: string
  filePath?: string
  fileSize?: number
}

interface Props {
  uploads: PendingUpload[]
  onRetry: (id: string) => void
  onDismiss: () => void
}

export function MassUploadWidget({ uploads, onRetry, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (uploads.length === 0) return null

  const total = uploads.length
  const done = uploads.filter(u => u.status === 'done').length
  const errors = uploads.filter(u => u.status === 'error').length
  const uploading = uploads.filter(u => u.status === 'uploading').length
  const waiting = uploads.filter(u => u.status === 'waiting' || !u.status).length

  const allDone = done + errors === total

  const formatSize = (b?: number) => {
    if (!b) return '0 B'
    if (b < 1024) return b + ' B'
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB'
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  const overallProgress = total > 0 ? Math.floor(((done * 100) + uploads.filter(u => u.status === 'uploading').reduce((acc, u) => acc + u.progress, 0)) / total) : 0

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      right: 24,
      width: expanded ? 400 : 320,
      background: 'var(--panel)',
      border: '1px solid var(--border-strong)',
      borderRadius: 16,
      boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      color: 'var(--text)'
    }}>
      {/* Header */}
      <div 
        style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', cursor: 'pointer', background: 'var(--bg)', borderBottom: expanded ? '1px solid var(--border)' : 'none' }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            {allDone ? (errors > 0 ? 'Загрузка завершена с ошибками' : 'Загрузка завершена') : 'Загрузка файлов...'}
            {allDone ? (errors > 0 ? <AlertCircle size={16} color="#ef4444" /> : <CheckCircle2 size={16} color="#10b981" />) : <Loader2 size={16} color="#7c83ff" className="animate-spin" />}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            Готово: {done} из {total} {errors > 0 && <span style={{ color: '#ef4444' }}>(Ошибок: {errors})</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {expanded ? <ChevronDown size={20} color="var(--text-dim)" /> : <ChevronUp size={20} color="var(--text-dim)" />}
          {allDone && (
            <button 
              onClick={(e) => { e.stopPropagation(); onDismiss(); }}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', padding: 4, borderRadius: 4, cursor: 'pointer' }}
              className="hover-bg"
            >
              <X size={20} />
            </button>
          )}
        </div>
      </div>

      {/* Progress Bar (Visible when collapsed or expanded) */}
      {!allDone && (
        <div style={{ width: '100%', height: 4, background: 'var(--border)' }}>
          <div style={{ height: '100%', width: `${overallProgress}%`, background: '#7c83ff', transition: 'width 0.3s ease' }} />
        </div>
      )}

      {/* Expanded List */}
      {expanded && (
        <div style={{ maxHeight: 300, overflowY: 'auto', padding: 8 }}>
          {uploads.map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 8, background: u.status === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'transparent' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: u.status === 'error' ? '#ef4444' : 'var(--text)' }}>
                  {u.fileName}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                  {u.status === 'waiting' && 'В очереди...'}
                  {u.status === 'uploading' && `Загрузка: ${u.progress}%`}
                  {u.status === 'done' && 'Готово'}
                  {u.status === 'error' && (u.error || 'Ошибка')}
                  {u.fileSize ? ` • ${formatSize(u.fileSize)}` : ''}
                </div>
              </div>
              
              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                {u.status === 'waiting' && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--border-strong)' }} />}
                {u.status === 'uploading' && <Loader2 size={16} color="#7c83ff" className="animate-spin" />}
                {u.status === 'done' && <CheckCircle2 size={16} color="#10b981" />}
                {u.status === 'error' && (
                  <button 
                    onClick={() => onRetry(u.id)}
                    style={{ background: 'var(--bg)', border: '1px solid #ef4444', color: '#ef4444', padding: '4px 8px', borderRadius: 6, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <RefreshCw size={12} /> Повторить
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
