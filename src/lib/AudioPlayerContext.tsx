import React, { createContext, useContext, useRef, useState, useCallback, ReactNode } from 'react'

interface Track { messageId: number; fileName: string; fileSize: number; uploadedAt?: number }

interface AudioPlayerCtx {
  currentTrack: Track | null
  playing: boolean
  currentTime: number
  duration: number
  queue: Track[]
  play: (track: Track, queue: Track[]) => void
  togglePlay: () => void
  playNext: () => void
  playPrev: () => void
  seek: (t: number) => void
  close: () => void
  setTime: (t: number) => void
  setDuration: (d: number) => void
  audioRef: React.RefObject<HTMLAudioElement | null>
}

const AudioPlayerContext = createContext<AudioPlayerCtx>(null!)

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [cacheUrls, setCacheUrls] = useState<Record<number, string>>({})
  const queueRef = useRef<Track[]>([])

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
      play, togglePlay, playNext, playPrev, seek, close,
      setTime: setCurrentTime, setDuration,
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