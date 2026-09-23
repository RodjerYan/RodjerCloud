import React, { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, Check, AlertCircle, Loader2 } from 'lucide-react'

interface ProgressItem {
  name: string
  status: 'pending' | 'active' | 'done' | 'error'
}

interface BulkProgressModalProps {
  title: string
  items: ProgressItem[]
  current: number
  total: number
  visible: boolean
  onClose?: () => void
}

const MAX_VISIBLE_ROWS = 40

function resolveStatus(item: ProgressItem, i: number, current: number): ProgressItem['status'] {
  if (item.status === 'error') return 'error'
  if (i < current) return 'done'
  if (i === current) return 'active'
  return item.status === 'done' ? 'done' : 'pending'
}

export function BulkProgressModal({ title, items, current, total, visible, onClose }: BulkProgressModalProps) {
  useEffect(() => {
    if (!visible) return
    if (total > 0 && current >= total) {
      const t = setTimeout(() => onClose?.(), 700)
      return () => clearTimeout(t)
    }
    const safetyMs = total > 100 ? 600000 : 60000
    const safety = setTimeout(() => onClose?.(), safetyMs)
    return () => clearTimeout(safety)
  }, [visible, current, total, onClose])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, onClose])

  const windowed = useMemo(() => {
    if (items.length <= MAX_VISIBLE_ROWS) {
      return { start: 0, rows: items.map((item, i) => ({ item, i })), before: 0, after: 0 }
    }
    const windowStart = Math.max(0, Math.min(current - 8, items.length - MAX_VISIBLE_ROWS))
    const end = Math.min(items.length, windowStart + MAX_VISIBLE_ROWS)
    return {
      start: windowStart,
      rows: items.slice(windowStart, end).map((item, idx) => ({ item, i: windowStart + idx })),
      before: windowStart,
      after: items.length - end,
    }
  }, [items, current])

  if (!visible || typeof document === 'undefined') return null
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000002, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(5,7,16,0.7)', backdropFilter: 'blur(12px)' }} />
      <div style={{
        position: 'relative', width: 420, maxHeight: '70vh',
        background: 'linear-gradient(145deg, rgba(30,34,53,0.98), rgba(15,17,26,0.99))',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20,
        padding: '28px 24px', boxShadow: '0 30px 80px rgba(0,0,0,0.75)',
        display: 'flex', flexDirection: 'column', gap: 16
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>{title}</span>
          {onClose && (
            <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.08)', border: 'none', color: '#fff', cursor: 'pointer', padding: 6, borderRadius: 8, display: 'flex' }}>
              <X size={16} />
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
          {total > 0 && current < total ? (
            <><Loader2 size={14} className="spin" style={{ color: 'var(--accent)' }} /> Обработка {current} из {total}…</>
          ) : (
            <><Check size={14} style={{ color: '#4ade80' }} /> Готово {total} из {total}</>
          )}
        </div>

        <div style={{ width: '100%', height: 5, background: 'rgba(255,255,255,0.08)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: pct + '%', borderRadius: 99,
            background: current >= total && total > 0 ? 'linear-gradient(90deg, #4ade80, #34d399)' : 'linear-gradient(90deg, #7c83ff, #a78bfa)',
            transition: 'width 0.25s ease'
          }} />
        </div>

        {items.length > 0 && (
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: '40vh', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {windowed.before > 0 && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '4px 8px' }}>
                … ещё {windowed.before}
              </div>
            )}
            {windowed.rows.map(({ item, i }) => {
              const status = resolveStatus(item, i, current)
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 8,
                  background: status === 'active' ? 'rgba(124,131,255,0.1)' : 'transparent',
                  fontSize: 12, color: status === 'done' ? '#4ade80' : status === 'error' ? '#ff6b6b' : 'rgba(255,255,255,0.5)',
                }}>
                  {status === 'active' && <Loader2 size={12} className="spin" style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                  {status === 'done' && <Check size={12} style={{ color: '#4ade80', flexShrink: 0 }} />}
                  {status === 'error' && <AlertCircle size={12} style={{ color: '#ff6b6b', flexShrink: 0 }} />}
                  {status === 'pending' && <div style={{ width: 12, height: 12, borderRadius: 6, border: '1.5px solid rgba(255,255,255,0.15)', flexShrink: 0 }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{item.name}</span>
                </div>
              )
            })}
            {windowed.after > 0 && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '4px 8px' }}>
                … ещё {windowed.after}
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
