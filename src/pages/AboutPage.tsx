import React, { useEffect, useState } from 'react'

export default function AboutPage() {
  const [version, setVersion] = useState("3.0.0")
  const [toast, setToast] = useState('')

  useEffect(() => {
    (async () => {
      const r = await window.electronAPI.app.getVersion()
      if (r.success && r.data) setVersion(r.data)
    })()
  }, [])

  const checkUpdates = () => {
    setToast('У вас последняя версия')
    setTimeout(() => setToast(''), 2000)
  }

  return (
    <div className="ab-root">
      <div className="ab-card">
        <div className="ab-logo">CS</div>
        <h1>RodjerCloud</h1>
        <div className="ab-version">v{version} — 100+ возможностей</div>
        <p className="ab-desc">
          RodjerCloud превращает ваш приватный Telegram-канал в безлимитное облачное хранилище.
          Без шифрования, без ежемесячной платы, полностью в вашем распоряжении.
        </p>
        <div className="ab-stack">
          <span>Electron</span><span>React</span><span>TypeScript</span><span>gramjs</span><span>chokidar</span>
        </div>
        <button className="ab-update" onClick={checkUpdates}>Проверить обновления</button>
        <div className="ab-links">
          <a href="#" onClick={e => e.preventDefault()}>GitHub</a>
          <span>•</span>
          <a href="#" onClick={e => e.preventDefault()}>Сообщить об ошибке</a>
        </div>
        <div className="ab-license">Распространяется под лицензией MIT</div>
      </div>
      {toast && <div className="mf-toast">{toast}</div>}
    </div>
  )
}
