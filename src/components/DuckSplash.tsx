import React, { useEffect, useState } from 'react'
import { Player } from '@lottiefiles/react-lottie-player'

export default function DuckSplash({ onDone }: { onDone: () => void }) {
  const [anim, setAnim] = useState<any>(null)
  const [ver, setVer] = useState('')

  useEffect(() => {
    window.electronAPI.tgs.read('splash.tgs').then((r: any) => {
      if (r.success) setAnim(r.data)
    })
    window.electronAPI?.app?.getVersion?.().then((r: any) => {
      if (r?.success && r?.data) setVer(r.data)
    })
    const t = setTimeout(onDone, 3000)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <div className="splash-root">
      <div className="splash-bg" />
      <div className="splash-inner">
        {anim ? (
          <Player autoplay loop src={anim} style={{ width: 160, height: 160 }} />
        ) : (
          <div style={{ width: 160, height: 160, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48 }}>🐤</div>
        )}
        <p className="splash-loading" style={{ marginTop: 16 }}>Загрузка RodjerCloud&hellip;</p>
        {ver && <div className="splash-version">v{ver}</div>}
      </div>
    </div>
  )
}