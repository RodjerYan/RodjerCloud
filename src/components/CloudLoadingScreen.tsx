import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Player } from '@lottiefiles/react-lottie-player'
import { Check, Cloud, Sparkles } from 'lucide-react'
import iconUrl from '../assets/icon.png'
import '../styles/cloud-loading.css'

type CloudProgress = {
  phase: string
  label: string
  scanned?: number
  total?: number
  files?: number
  batch?: number
  percent?: number
}

const STAGES = [
  { key: 'connect', label: 'Подключение к Telegram' },
  { key: 'channel', label: 'Канал «My area»' },
  { key: 'folders', label: 'Структура папок' },
  { key: 'files', label: 'Файлы и миниатюры' },
  { key: 'verify', label: 'Сверка с облаком' },
]

const fmt = (n?: number) => (n || 0).toLocaleString('ru-RU')

export default function CloudLoadingScreen({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState<CloudProgress>({ phase: 'connect', label: 'Подключение к Telegram' })
  const [anim, setAnim] = useState<any>(null)
  const [ver, setVer] = useState('')
  const [leaving, setLeaving] = useState(false)
  const doneRef = useRef(false)

  const finish = React.useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    setLeaving(true)
    setTimeout(onDone, 380)
  }, [onDone])

  useEffect(() => {
    const unsubs: Array<(() => void) | undefined> = []
    try { unsubs.push(window.electronAPI?.telegram?.onCloudProgress?.((p: CloudProgress) => setProgress(p))) } catch {}
    try { unsubs.push(window.electronAPI?.telegram?.onCloudLoaded?.(() => finish())) } catch {}
    try {
      window.electronAPI?.telegram?.getCloudLoadState?.().then((s: any) => {
        if (s?.progress) setProgress(s.progress)
        if (s?.complete) setTimeout(finish, 450)
      })
    } catch {}
    try {
      window.electronAPI?.tgs?.read?.('splash.tgs').then((r: any) => { if (r?.success) setAnim(r.data) })
    } catch {}
    try {
      window.electronAPI?.app?.getVersion?.().then((r: any) => { if (r?.success && r?.data) setVer(r.data) })
    } catch {}
    // Safety: если main не прислал complete, всё равно пускаем в UI.
    const safety = setTimeout(finish, 12000)
    return () => { unsubs.forEach(u => u?.()); clearTimeout(safety) }
  }, [finish])

  const activeIndex = useMemo(() => {
    if (progress.phase === 'done') return STAGES.length
    const i = STAGES.findIndex(s => s.key === progress.phase)
    return i < 0 ? 0 : i
  }, [progress.phase])

  const percent = progress.percent != null && progress.percent > 0
    ? Math.min(100, Math.round(progress.percent))
    : null

  return (
    <div className={`cloud-load-root ${leaving ? 'leaving' : ''}`}>
      <div className="splash-bg" />
      <div className="cloud-load-glow" />
      <div className="cloud-load-card">
        <div className="cloud-load-visual">
          {anim ? <Player autoplay loop src={anim} style={{ width: 132, height: 132 }} /> : (
            <div className="cloud-load-duck">🐤</div>
          )}
          <div className="cloud-load-badge"><Cloud size={14} /></div>
        </div>

        <h1 className="cloud-load-title">RodjerCloud</h1>
        <p className="cloud-load-subtitle">Открываем ваше облако</p>

        <div className="cloud-load-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
             aria-valuenow={percent ?? undefined}>
          <div className={`cloud-load-bar ${percent == null ? 'indeterminate' : ''}`}
               style={percent != null ? { width: percent + '%' } : undefined} />
        </div>

        <div className="cloud-load-status">
          <span className="cloud-load-stage-icon">
            {progress.phase === 'done' ? <Check size={14} /> : <Sparkles size={14} />}
          </span>
          <span>{progress.label}</span>
          {percent != null && <span className="cloud-load-percent">{percent}%</span>}
        </div>

        <div className="cloud-load-meta">
          {progress.scanned != null && progress.scanned > 0 && <span>{fmt(progress.scanned)} сообщений</span>}
          {progress.files != null && <span>{fmt(progress.files)} файлов</span>}
          {progress.batch != null && progress.batch > 0 && <span>пакет {progress.batch}</span>}
        </div>

        <div className="cloud-load-stages">
          {STAGES.map((s, i) => (
            <div key={s.key} className={`cloud-load-stage ${i < activeIndex ? 'ok' : ''} ${i === activeIndex ? 'active' : ''}`}>
              <span className="cloud-load-dot">{i < activeIndex ? <Check size={10} /> : null}</span>
              <span>{s.label}</span>
            </div>
          ))}
        </div>

        <button className="cloud-load-skip" onClick={finish}>Открыть файлы</button>
        {ver && <div className="splash-version">v{ver}</div>}
      </div>
    </div>
  )
}
