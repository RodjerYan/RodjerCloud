import React, { useEffect, useState } from 'react'
import confetti from 'canvas-confetti'
import { flushSync } from 'react-dom'
import { Play, Download, Trash2, Music, Clock, Calendar } from 'lucide-react'
import { useAudioPlayer } from '../lib/AudioPlayerContext'
import { appConfirm } from '../lib/dialogs'

function fmtSize(n: number) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i]
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

export default function AudioPlayerPage() {
  const [files, setFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { currentTrack, playing, play } = useAudioPlayer()

  useEffect(() => {
    window.electronAPI.telegram.listFiles().then((r: any) => {
      if (r.success) {
        const audioFiles = (r.data || []).filter((f: any) => {
          const ext = (f.fileName || '').split('.').pop()?.toLowerCase()
          return ['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)
        })
        setFiles(audioFiles)
      }
      setLoading(false)
    })
  }, [])

  const handleDelete = async (f: any, e?: React.MouseEvent) => {
    if (!(await appConfirm('Удалить ' + f.fileName + '?'))) return

    let x = 0.5, y = 0.5
    if (e) {
      let rect = (e.currentTarget as HTMLElement).closest('.ap-track-row')?.getBoundingClientRect()
      if (rect) {
        x = (rect.left + rect.width / 2) / window.innerWidth
        y = (rect.top + rect.height / 2) / window.innerHeight
      } else {
        x = e.clientX / window.innerWidth
        y = e.clientY / window.innerHeight
      }
    }
    confetti({
      particleCount: 50,
      spread: 80,
      origin: { x, y },
      colors: ['#7c83ff', '#ff4b4b', '#a1a1aa'],
      disableForReducedMotion: true,
      zIndex: 9999
    })

    const applyRemove = () => {
      flushSync(() => {
        setFiles(prev => prev.filter(x => x.messageId !== f.messageId))
      })
    }

    if ('startViewTransition' in document) {
      (document as any).startViewTransition(applyRemove)
    } else {
      applyRemove()
    }

    const r = await window.electronAPI.telegram.deleteFile(f.messageId)
    if (!r.success) {
      const revert = () => {
        flushSync(() => {
          setFiles(prev => [...prev, f].sort((a, b) => (b.messageId - a.messageId)))
        })
      }
      if ('startViewTransition' in document) {
        (document as any).startViewTransition(revert)
      } else {
        revert()
      }
    }
  }

  const handleDownload = (f: any) => {
    window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
  }

  if (loading) return <div className="ap-container"><div className="mf-empty">Загрузка…</div></div>

  const totalSize = files.reduce((acc, f) => acc + (f.fileSize || 0), 0)

  return (
    <div className="ap-container">
      <div className="ap-header">
        <div className="ap-header-cover">
          <Music size={80} opacity={0.8} />
        </div>
        <div className="ap-header-info">
          <div className="ap-type">Плейлист</div>
          <h1 className="ap-title">Моя музыка</h1>
          <div className="ap-stats">
            <span>RodjerCloud</span>
            <span>•</span>
            <span>{files.length} треков</span>
            <span>•</span>
            <span>{fmtSize(totalSize)}</span>
          </div>
        </div>
      </div>
      
      <div className="ap-actions">
        <button 
          className="ap-play-btn" 
          onClick={() => files.length > 0 && play(files[0], files)}
          title="Слушать всё"
        >
          <Play size={24} fill="currentColor" style={{ marginLeft: 4 }} />
        </button>
      </div>

      <div className="ap-tracklist">
        {files.length === 0 ? (
          <div className="mf-empty" style={{ marginTop: 40 }}>Нет аудиофайлов</div>
        ) : (
          <>
            <div className="ap-track-row header">
              <div className="ap-track-num">#</div>
              <div>Название</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Calendar size={14}/> Добавлен</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Clock size={14}/> Размер</div>
            </div>
            
            {files.map((f, i) => {
              const isActive = currentTrack?.messageId === f.messageId
              const info = parseAudioInfo(f.fileName)
              
              return (
                <div 
                  key={f.messageId} 
                  className={`ap-track-row ${isActive ? 'active' : ''}`}
                  style={{ viewTransitionName: `card_${f.messageId}` }}
                  onDoubleClick={() => play(f, files)}
                >
                  <div className="ap-track-num">
                    {isActive && playing ? (
                      <div className="ap-eq">
                        <div className="ap-eq-bar"></div>
                        <div className="ap-eq-bar"></div>
                        <div className="ap-eq-bar"></div>
                      </div>
                    ) : (
                      <>
                        <span className="ap-track-num-txt" style={{ color: isActive ? 'var(--accent)' : undefined }}>
                          {i + 1}
                        </span>
                        <div className="ap-track-play" onClick={(e) => { e.stopPropagation(); play(f, files) }}>
                          <Play size={14} fill="currentColor" />
                        </div>
                      </>
                    )}
                  </div>
                  
                  <div className="ap-track-info">
                    <div className="ap-track-cover" style={{ background: getGradientForName(f.fileName) }}>
                      <Music size={18} />
                    </div>
                    <div className="ap-track-text">
                      <span className="ap-track-title" title={info.title}>{info.title}</span>
                      <span className="ap-track-artist" title={info.artist}>{info.artist}</span>
                    </div>
                  </div>
                  
                  <div className="ap-track-date">
                    {new Date(((f.originalDate || f.uploadedAt) || 0) * 1000).toLocaleDateString()}
                  </div>
                  
                  <div className="ap-track-size" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>{fmtSize(f.fileSize)}</span>
                    <div className="ap-track-actions">
                      <button title="Скачать" onClick={(e) => { e.stopPropagation(); handleDownload(f) }}>
                        <Download size={16} />
                      </button>
                      <button title="Удалить" className="danger" onClick={(e) => { e.stopPropagation(); handleDelete(f, e) }}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}