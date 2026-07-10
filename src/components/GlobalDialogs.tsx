import React, { useEffect, useState } from 'react'
import { subscribeDialogs } from '../lib/dialogs'

export default function GlobalDialogs() {
  const [dialogs, setDialogs] = useState<any[]>([])

  useEffect(() => {
    return subscribeDialogs((ds) => {
      setDialogs(ds)
    })
  }, [])

  if (dialogs.length === 0) return null

  // Render the last dialog in the stack
  const d = dialogs[dialogs.length - 1]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999999,
      background: 'rgba(10, 10, 15, 0.75)', backdropFilter: 'blur(10px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.2s ease'
    }}>
      <div className="v3-card" style={{
        width: 380, maxWidth: '90%', padding: '24px',
        boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
        animation: 'zoomIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
      }}>
        <div style={{
          fontSize: 18, fontWeight: 600, color: '#fff',
          marginBottom: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
        }}>
          {d.type === 'confirm' ? 'Подтверждение' : 'Внимание'}
        </div>
        
        <div style={{
          fontSize: 14, color: 'var(--v3-text-dim)', marginBottom: 24,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word'
        }}>
          {d.message}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          {d.type === 'confirm' && (
            <button 
              onClick={() => d.resolve(false)}
              className="v3-btn"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--v3-text)' }}
            >
              Отмена
            </button>
          )}
          <button 
            onClick={() => d.resolve(true)}
            className="v3-btn"
          >
            ОК
          </button>
        </div>
      </div>
    </div>
  )
}
