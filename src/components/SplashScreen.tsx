import React from 'react'

export default function SplashScreen() {
  return (
    <div className="splash-root">
      <div className="splash-bg" />
      <div className="splash-inner">
        <div className="splash-logo">
          <div className="splash-logo-mark">RC</div>
        </div>
        <h1 className="splash-title">RodjerCloud</h1>
        <p className="splash-subtitle">Облачное хранилище в Telegram</p>
        <div className="splash-progress"><div className="splash-progress-fill" /></div>
        <p className="splash-loading">Загрузка RodjerCloud&hellip;</p>
        <div className="splash-version">v1.0.0</div>
      </div>
    </div>
  )
}
