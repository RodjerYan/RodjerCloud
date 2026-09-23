import React, { useRef } from 'react'
import { Play, Pause, SkipBack, SkipForward, X, Music, Volume2, VolumeX, Volume1 } from 'lucide-react'
import { useAudioPlayer } from '../lib/AudioPlayerContext'

function fmtTime(s: number) {
  if (!s || !isFinite(s)) return '0:00'
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return m + ':' + (sec < 10 ? '0' : '') + sec
}

function parseAudioInfo(filename: string) {
  const name = filename.replace(/\.[^/.]+$/, "")
  if (name.includes(' - ')) {
    const parts = name.split(' - ')
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
  }
  return { artist: 'Неизвестный исполнитель', title: name }
}

function getGradientForName(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const c1 = `hsl(${Math.abs(hash) % 360}, 70%, 50%)`
  const c2 = `hsl(${(Math.abs(hash) + 40) % 360}, 80%, 30%)`
  return `linear-gradient(135deg, ${c1}, ${c2})`
}

export default function AudioPlayerBar() {
  const { currentTrack, playing, currentTime, duration, togglePlay, playNext, playPrev, close, audioRef, volume, muted, setVolume, toggleMute } = useAudioPlayer()
  const progressRef = useRef<HTMLDivElement>(null)
  const volRef = useRef<HTMLDivElement>(null)
  const volDraggingRef = useRef(false)

  if (!currentTrack) return null

  const handleSeek = (e: React.MouseEvent) => {
    if (!progressRef.current || !audioRef.current) return
    const rect = progressRef.current.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    audioRef.current.currentTime = pct * duration
  }

  const applyVolumeFromClientX = (clientX: number) => {
    const el = volRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    setVolume(pct)
  }

  const handleVolPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    volDraggingRef.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    applyVolumeFromClientX(e.clientX)
  }

  const handleVolPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volDraggingRef.current) return
    e.preventDefault()
    applyVolumeFromClientX(e.clientX)
  }

  const endVolDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volDraggingRef.current) return
    volDraggingRef.current = false
    try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch {}
  }

  const info = parseAudioInfo(currentTrack.fileName)
  const shownVolume = muted ? 0 : volume
  const VolIcon = shownVolume === 0 ? VolumeX : shownVolume < 0.5 ? Volume1 : Volume2

  return (
    <div className="ap-bar" style={{
      position: 'fixed', bottom: 16, left: 'calc(var(--sidebar-w, 200px) + 16px)', right: 16,
      height: 90, borderRadius: 24,
      background: 'rgba(12, 14, 26, 0.95)',
      backdropFilter: 'blur(24px)',
      border: '1px solid var(--border)',
      boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
      zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 24px',
    }}>
      <button onClick={close} style={{
        position: 'absolute', top: 8, right: 12,
        background: 'transparent', border: 'none', color: 'var(--text-dim)',
        cursor: 'pointer', padding: 4, zIndex: 2
      }} title="Закрыть"><X size={16} /></button>

      {/* Left: Track Info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '30%', minWidth: 200 }}>
        <div style={{ 
          width: 56, height: 56, borderRadius: 6, 
          background: getGradientForName(currentTrack.fileName),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)', color: '#fff', flexShrink: 0
        }}>
          <Music size={24} opacity={0.8} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {info.title}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {info.artist}
          </span>
        </div>
      </div>

      {/* Center: Controls & Progress */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flex: 1, maxWidth: 600 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <button onClick={playPrev} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', transition: 'color 0.2s', padding: 0 }}>
            <SkipBack size={20} fill="currentColor" />
          </button>
          
          <button onClick={togglePlay} style={{
            width: 40, height: 40, borderRadius: '50%', border: 'none',
            background: '#fff', color: '#000',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            transition: 'transform 0.1s'
          }}>
            {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: 3 }} />}
          </button>
          
          <button onClick={playNext} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', transition: 'color 0.2s', padding: 0 }}>
            <SkipForward size={20} fill="currentColor" />
          </button>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', fontSize: 11, color: 'var(--text-dim)' }}>
          <span style={{ width: 40, textAlign: 'right' }}>{fmtTime(currentTime)}</span>
          <div ref={progressRef} onClick={handleSeek} style={{
            flex: 1, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 99, cursor: 'pointer', position: 'relative',
          }}>
            <div style={{
              width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`, height: '100%',
              background: '#fff', borderRadius: 99,
            }} />
          </div>
          <span style={{ width: 40 }}>{fmtTime(duration)}</span>
        </div>
      </div>

      {/* Right: Volume */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, width: '30%', minWidth: 150 }}>
        <button
          type="button"
          onClick={toggleMute}
          title={muted ? 'Включить звук' : 'Выключить звук'}
          aria-label={muted ? 'Включить звук' : 'Выключить звук'}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 0, display: 'flex' }}
        >
          <VolIcon size={18} />
        </button>
        <div
          ref={volRef}
          role="slider"
          tabIndex={0}
          aria-label="Громкость"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(shownVolume * 100)}
          aria-valuetext={`${Math.round(shownVolume * 100)}%`}
          title={`Громкость ${Math.round(shownVolume * 100)}%`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setVolume(Math.min(1, volume + 0.05)) }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setVolume(Math.max(0, volume - 0.05)) }
            else if (e.key === 'Home') { e.preventDefault(); setVolume(0) }
            else if (e.key === 'End') { e.preventDefault(); setVolume(1) }
            else if (e.key === 'm' || e.key === 'M' || e.key === 'ь' || e.key === 'Ь') { e.preventDefault(); toggleMute() }
          }}
          onPointerDown={handleVolPointerDown}
          onPointerMove={handleVolPointerMove}
          onPointerUp={endVolDrag}
          onPointerCancel={endVolDrag}
          onClick={(e) => {
            // если был drag — click после pointerup не должен дёргать лишний раз;
            // pointerdown уже применил значение; оставляем click только для клика без сдвига
            if (volDraggingRef.current) return
            const rect = e.currentTarget.getBoundingClientRect()
            const pct = (e.clientX - rect.left) / rect.width
            if (pct < 0.04 && shownVolume > 0) toggleMute()
            else setVolume(pct)
          }}
          style={{
            width: 80, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 99,
            cursor: 'pointer', position: 'relative', flexShrink: 0, outline: 'none',
            touchAction: 'none', userSelect: 'none',
          }}
        >
          <div style={{ width: `${shownVolume * 100}%`, height: '100%', background: '#fff', borderRadius: 99, transition: volDraggingRef.current ? 'none' : 'width 0.05s linear' }} />
          <div
            aria-hidden
            style={{
              position: 'absolute', top: '50%', left: `${shownVolume * 100}%`,
              width: 10, height: 10, borderRadius: '50%', background: '#fff',
              transform: 'translate(-50%, -50%)', boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
              pointerEvents: 'none',
            }}
          />
        </div>
        <span style={{ width: 34, fontSize: 11, color: 'var(--text-dim)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(shownVolume * 100)}%
        </span>
      </div>
    </div>
  )
}