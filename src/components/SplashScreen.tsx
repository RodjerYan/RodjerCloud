import React, { useEffect, useState } from 'react'
import iconUrl from '../assets/icon.png'

export default function SplashScreen() {
  const [ver, setVer] = useState('')
  useEffect(() => {
    try {
      window.electronAPI?.app?.getVersion?.().then(r => {
        if (r?.success && r?.data) setVer(r.data)
      })
    } catch(e) {
      try { window.electronAPI?.app?.log?.('error', 'SplashScreen version: ' + String(e)) } catch(e2) {}
    }
  }, [])
  return (
    <div className="splash-root">
      <div className="splash-bg" />
      <div className="splash-inner">
        <div className="splash-logo">
          <img src={iconUrl} alt="RodjerCloud" className="splash-logo-mark" />
        </div>
        <h1 className="splash-title">RodjerCloud</h1>
        <p className="splash-subtitle">Облачное хранилище в Telegram</p>
        <div className="splash-progress"><div className="splash-progress-fill" /></div>
        <p className="splash-loading">Загрузка RodjerCloud&hellip;</p>
        {ver && <div className="splash-version">v{ver}</div>}
      </div>
    </div>
  )
}
