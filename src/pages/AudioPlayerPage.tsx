import React, { useEffect, useState } from 'react'
import { Play, Download, Trash2, Music } from 'lucide-react'
import { useAudioPlayer } from '../lib/AudioPlayerContext'
import { appConfirm } from '../lib/dialogs'

function fmtSize(n: number) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i]
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

  const handleDelete = async (f: any) => {
    if (!(await appConfirm('Удалить ' + f.fileName + '?'))) return
    const r = await window.electronAPI.telegram.deleteFile(f.messageId)
    if (r.success) {
      setFiles(prev => prev.filter(x => x.messageId !== f.messageId))
    }
  }

  const handleDownload = (f: any) => {
    window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
  }

  if (loading) return <div className="v3-page"><div className="mf-empty">Загрузка…</div></div>

  return (
    <div className="v3-page" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)', paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <Music size={22} />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Аудиоплеер</h2>
        <span style={{ fontSize: 13, color: 'var(--v3-text-dim)' }}>{files.length} треков</span>
      </div>

      {files.length === 0 ? (
        <div className="mf-empty">Нет аудиофайлов</div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <table className="mf-table" style={{ borderRadius: 12, overflow: 'hidden' }}>
            <thead><tr>
              <th style={{ width: 40 }}>#</th>
              <th>Название</th>
              <th style={{ width: 100 }}>Размер</th>
              <th style={{ width: 100 }}>Дата</th>
              <th style={{ width: 140 }}>Действия</th>
            </tr></thead>
            <tbody>
              {files.map((f, i) => (
                <tr key={f.messageId} style={{ cursor: 'pointer', background: currentTrack?.messageId === f.messageId ? 'rgba(52,211,153,0.08)' : undefined }}
                    onDoubleClick={() => play(f, files)}>
                  <td style={{ textAlign: 'center', color: currentTrack?.messageId === f.messageId ? '#34d399' : undefined }}>
                    {currentTrack?.messageId === f.messageId && playing ? <Music size={14} /> : i + 1}
                  </td>
                  <td className="ellip" title={f.fileName}>{f.fileName}</td>
                  <td>{fmtSize(f.fileSize)}</td>
                  <td>{new Date(((f.originalDate || f.uploadedAt) || 0) * 1000).toLocaleDateString()}</td>
                  <td>
                    <button title="Воспроизвести" onClick={() => play(f, files)}><Play size={14} /></button>
                    <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                    <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}