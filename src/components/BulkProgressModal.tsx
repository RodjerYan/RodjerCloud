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

export function BulkProgressModal({ title, items, current, total, visible, onClose }: BulkProgressModalProps) {
  if (!visible) return null
  const pct = total > 0 ? (current / total) * 100 : 0

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(5,7,16,0.7)', backdropFilter: 'blur(12px)' }} />
      <div style={{
        position: 'relative', width: 420, maxHeight: '70vh',
        background: 'linear-gradient(145deg, rgba(30,34,53,0.95), rgba(15,17,26,0.98))',
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20,
        padding: '28px 24px', boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', gap: 16
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>{title}</span>
          {current >= total && onClose && (
            <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.08)', border: 'none', color: '#fff', cursor: 'pointer', padding: 6, borderRadius: 8, display: 'flex' }}>
              <X size={16} />
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
          {current < total ? (
            <><Loader2 size={14} className="spin" style={{ color: 'var(--accent)' }} /> Обработка {current} из {total}…</>
          ) : (
            <><Check size={14} style={{ color: '#4ade80' }} /> Готово {total} из {total}</>
          )}
        </div>

        <div style={{ width: '100%', height: 5, background: 'rgba(255,255,255,0.08)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: pct + '%', borderRadius: 99,
            background: current >= total ? 'linear-gradient(90deg, #4ade80, #34d399)' : 'linear-gradient(90deg, #7c83ff, #a78bfa)',
            transition: 'width 0.3s ease'
          }} />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', maxHeight: '40vh', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {items.map((item, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 8,
              background: item.status === 'active' ? 'rgba(124,131,255,0.1)' : 'transparent',
              fontSize: 12, color: item.status === 'done' ? '#4ade80' : item.status === 'error' ? '#ff6b6b' : 'rgba(255,255,255,0.5)',
              transition: 'background 0.2s'
            }}>
              {item.status === 'active' && <Loader2 size={12} className="spin" style={{ color: 'var(--accent)', flexShrink: 0 }} />}
              {item.status === 'done' && <Check size={12} style={{ color: '#4ade80', flexShrink: 0 }} />}
              {item.status === 'error' && <AlertCircle size={12} style={{ color: '#ff6b6b', flexShrink: 0 }} />}
              {item.status === 'pending' && <div style={{ width: 12, height: 12, borderRadius: 6, border: '1.5px solid rgba(255,255,255,0.15)', flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{item.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
