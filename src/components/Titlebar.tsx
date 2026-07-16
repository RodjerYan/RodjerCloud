import { Minus, Square, X } from 'lucide-react'
import './Titlebar.css'

export default function Titlebar() {
  const minimize = () => window.electronAPI.window.minimize()
  const maximize = () => window.electronAPI.window.maximize()
  const close = () => window.electronAPI.window.close()

  const isMac = navigator.userAgent.toLowerCase().includes('mac os')

  return (
    <div className="custom-titlebar" style={{ background: isMac ? 'transparent' : undefined }}>
      <div className="titlebar-drag-region" />
      {!isMac && (
        <div className="titlebar-content">
          <div className="titlebar-logo">
            RodjerCloud
          </div>
          <div className="titlebar-controls">
            <button className="titlebar-btn" onClick={minimize} title="Свернуть">
              <Minus size={16} />
            </button>
            <button className="titlebar-btn" onClick={maximize} title="Развернуть">
              <Square size={14} />
            </button>
            <button className="titlebar-btn titlebar-close" onClick={close} title="Закрыть">
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
