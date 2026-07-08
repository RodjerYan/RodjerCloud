import React, { useRef } from 'react'
import { Play, Pause, SkipBack, SkipForward, X } from 'lucide-react'
import { useAudioPlayer } from '../lib/AudioPlayerContext'

function fmtTime(s: number) {
  if (!s || !isFinite(s)) return '0:00'
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return m + ':' + (sec < 10 ? '0' : '') + sec
}

export default function AudioPlayerBar() {
  const { currentTrack, playing, currentTime, duration, togglePlay, playNext, playPrev, seek, close, audioRef } = useAudioPlayer()
  const progressRef = useRef<HTMLDivElement>(null)

  if (!currentTrack) return null

  const handleSeek = (e: React.MouseEvent) => {
    if (!progressRef.current || !audioRef.current) return
    const rect = progressRef.current.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    audioRef.current.currentTime = pct * duration
  }

  const isFirst = false
  const isLast = false

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
      width: 'min(800px, calc(100% - 280px))', marginLeft: '72px',
      background: 'rgba(18,20,34,0.96)', backdropFilter: 'blur(24px)',
      border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none',
      borderRadius: '16px 16px 0 0', padding: '14px 20px 16px',
      zIndex: 200, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <button onClick={close} style={{
        position: 'absolute', top: 6, right: 8,
        background: 'transparent', border: 'none', color: 'var(--v3-text-dim)',
        cursor: 'pointer', padding: 4,
      }} title="Закрыть"><X size={14} /></button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentTrack.fileName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--v3-text-dim)' }}>
            {fmtTime(currentTime)} / {fmtTime(duration)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={playPrev} style={{ background: 'transparent', border: 'none', color: 'var(--v3-text)', cursor: 'pointer', padding: 6 }}>
            <SkipBack size={18} />
          </button>
          <button onClick={togglePlay} style={{
            width: 40, height: 40, borderRadius: '50%', border: 'none',
            background: 'linear-gradient(135deg, #34d399, #22d3ee)', color: '#000',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}>
            {playing ? <Pause size={18} /> : <Play size={18} style={{ marginLeft: 2 }} />}
          </button>
          <button onClick={playNext} style={{ background: 'transparent', border: 'none', color: 'var(--v3-text)', cursor: 'pointer', padding: 6 }}>
            <SkipForward size={18} />
          </button>
        </div>
      </div>
      <div ref={progressRef} onClick={handleSeek} style={{
        width: '100%', height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 99, cursor: 'pointer', position: 'relative',
      }}>
        <div style={{
          width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`, height: '100%',
          background: 'linear-gradient(90deg, #34d399, #22d3ee)', borderRadius: 99,
          transition: 'width 0.1s linear',
        }} />
      </div>
    </div>
  )
}