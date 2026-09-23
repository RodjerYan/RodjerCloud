import React, { createContext, useContext, useRef, useState, useCallback, useEffect, ReactNode } from 'react'

interface Track { messageId: number; fileName: string; fileSize: number; uploadedAt?: number }

interface AudioPlayerCtx {
  currentTrack: Track | null
  playing: boolean
  currentTime: number
  duration: number
  queue: Track[]
  volume: number
  muted: boolean
  play: (track: Track, queue: Track[]) => void
  togglePlay: () => void
  playNext: () => void
  playPrev: () => void
  seek: (t: number) => void
  close: () => void
  setTime: (t: number) => void
  setDuration: (d: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  audioRef: React.RefObject<HTMLAudioElement | null>
}

const AudioPlayerContext = createContext<AudioPlayerCtx>(null!)

const VOLUME_KEY = 'rodjer.player.volume'
const MUTED_KEY = 'rodjer.player.muted'

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  } catch {
    return fallback
  }
}

function readStoredBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    return raw === '1' || raw === 'true'
  } catch {
    return fallback
  }
}

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [cacheUrls, setCacheUrls] = useState<Record<number, string>>({})
  const [volume, setVolumeState] = useState(() => readStoredNumber(VOLUME_KEY, 0.8, 0, 1))
  const [muted, setMuted] = useState(() => readStoredBool(MUTED_KEY, false))
  const queueRef = useRef<Track[]>([])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    el.volume = muted ? 0 : volume
    el.muted = muted
  }, [volume, muted])

  const setVolume = useCallback((v: number) => {
    const next = Math.min(1, Math.max(0, Number(v) || 0))
    setVolumeState(next)
    if (next > 0 && muted) setMuted(false)
    try {
      localStorage.setItem(VOLUME_KEY, String(next))
      if (next > 0) localStorage.setItem(MUTED_KEY, '0')
    } catch {}
  }, [muted])

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev
      try { localStorage.setItem(MUTED_KEY, next ? '1' : '0') } catch {}
      return next
    })
  }, [])

  const play = useCallback(async (track: Track, q: Track[]) => {
    queueRef.current = q
    setCurrentTrack(track)
    setCurrentTime(0); setDuration(0)
    if (cacheUrls[track.messageId]) {
      audioRef.current!.src = cacheUrls[track.messageId]
      audioRef.current!.play().catch(() => {})
      setPlaying(true)
      return
    }
    const r = await window.electronAPI.telegram.cacheAudio(track.messageId, track.fileName)
    if (r.success) {
      const url = 'data:' + r.data.mime + ';base64,' + r.data.base64
      setCacheUrls(prev => ({ ...prev, [track.messageId]: url }))
      audioRef.current!.src = url
      audioRef.current!.play().catch(() => {})
      setPlaying(true)
    }
  }, [cacheUrls])

  const togglePlay = useCallback(() => {
    if (!audioRef.current || !currentTrack) return
    if (audioRef.current.paused) { audioRef.current.play().catch(() => {}); setPlaying(true) }
    else { audioRef.current.pause(); setPlaying(false) }
  }, [currentTrack])

  const playNext = useCallback(() => {
    const q = queueRef.current
    if (!currentTrack || q.length === 0) return
    const idx = q.findIndex(t => t.messageId === currentTrack.messageId)
    if (idx >= 0 && idx < q.length - 1) play(q[idx + 1], q)
    else { setCurrentTrack(null); setPlaying(false) }
  }, [currentTrack, play])

  const playPrev = useCallback(() => {
    const q = queueRef.current
    if (!currentTrack || q.length === 0) return
    const idx = q.findIndex(t => t.messageId === currentTrack.messageId)
    if (idx > 0) play(q[idx - 1], q)
  }, [currentTrack, play])

  const seek = useCallback((t: number) => {
    if (audioRef.current) audioRef.current.currentTime = t
  }, [])

  const close = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = '' }
    setCurrentTrack(null)
    setPlaying(false)
    setCurrentTime(0); setDuration(0)
  }, [])

  return (
    <AudioPlayerContext.Provider value={{
      currentTrack, playing, currentTime, duration, queue: queueRef.current,
      volume, muted, play, togglePlay, playNext, playPrev, seek, close,
      setTime: setCurrentTime, setDuration, setVolume, toggleMute,
      audioRef,
    }}>
      {children}
      <audio ref={audioRef}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onEnded={() => { const q = queueRef.current; if (currentTrack) { const idx = q.findIndex(t => t.messageId === currentTrack.messageId); if (idx >= 0 && idx < q.length - 1) play(q[idx + 1], q); else { setCurrentTrack(null); setPlaying(false) }}}}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      />
    </AudioPlayerContext.Provider>
  )
}

export const useAudioPlayer = () => useContext(AudioPlayerContext)