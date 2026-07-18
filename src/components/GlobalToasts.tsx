import React, { useEffect, useState } from 'react';
import { subscribeToasts, ToastMessage, toast } from '../lib/toast';
import { CheckCircle2, XCircle, AlertCircle, Loader2, X } from 'lucide-react';

export default function GlobalToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    return subscribeToasts((ts) => {
      setToasts(ts);
    });
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      right: 24,
      zIndex: 999999,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 12,
      pointerEvents: 'none'
    }}>
      {toasts.map((t) => {
        let icon = null;
        let borderColor = 'rgba(255,255,255,0.1)';
        let bgColor = 'rgba(22, 24, 42, 0.85)';
        let shadowColor = 'rgba(0,0,0,0.5)';

        if (t.type === 'success') {
          icon = <CheckCircle2 size={18} color="#34d399" />;
          borderColor = 'rgba(52,211,153,0.3)';
          bgColor = 'rgba(22, 34, 30, 0.9)';
          shadowColor = 'rgba(52,211,153,0.1)';
        } else if (t.type === 'error') {
          icon = <XCircle size={18} color="#ef4444" />;
          borderColor = 'rgba(239,68,68,0.3)';
          bgColor = 'rgba(34, 22, 24, 0.9)';
          shadowColor = 'rgba(239,68,68,0.1)';
        } else if (t.type === 'info') {
          icon = <AlertCircle size={18} color="#7c83ff" />;
          borderColor = 'rgba(124,131,255,0.3)';
          bgColor = 'rgba(22, 24, 42, 0.9)';
        } else if (t.type === 'loading') {
          icon = <Loader2 size={18} color="#a78bfa" className="spin" />;
          borderColor = 'rgba(167,139,250,0.3)';
        }

        return (
          <div key={t.id} style={{
            pointerEvents: 'auto',
            background: bgColor,
            backdropFilter: 'blur(16px)',
            border: `1px solid ${borderColor}`,
            boxShadow: `0 8px 32px ${shadowColor}`,
            padding: '12px 16px',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: 280,
            maxWidth: 400,
            animation: 'toastSpringIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards'
          }}>
            <div style={{ flexShrink: 0, display: 'flex' }}>
              {icon}
            </div>
            <div style={{ flexGrow: 1, fontSize: 14, color: '#fff', fontWeight: 500, lineHeight: 1.4 }}>
              {t.message}
            </div>
            <button
              onClick={() => toast.remove(t.id)}
              style={{
                background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)',
                cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', flexShrink: 0
              }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
