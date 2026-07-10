import React, { useEffect, useState } from "react"
import { Star, Download, Trash2, Eye } from "lucide-react"
import { Player } from '@lottiefiles/react-lottie-player'
import { v3store } from "../lib/v3store"
import { appConfirm, appAlert } from "../lib/dialogs"

function fmtSize(n: number) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i]
}

function typeOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return 'video'
  return 'other'
}

export default function FavoritesPage() {
  const [favs, setFavs] = useState(v3store.getFavs())
  const [allFiles, setAllFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [navAnim, setNavAnim] = useState<any>(null)

  useEffect(() => {
    setFavs(v3store.getFavs())
    window.electronAPI.telegram.listFiles().then((r: any) => {
      if (r?.success) setAllFiles(r.data || [])
      setLoading(false)
    })
    window.electronAPI.tgs.read('nav.tgs').then((r: any) => {
      if (r.success) setNavAnim(r.data)
    })
  }, [])

  const favFiles = allFiles.filter((f: any) => v3store.isFav(f.messageId))

  const handleDownload = async (f: any) => {
    const r = await window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
    if (!r.success) await appAlert(r.error || 'Ошибка скачивания')
  }

  const handleDelete = async (f: any) => {
    if (!(await appConfirm('Удалить ' + f.fileName + '?'))) return
    const r = await window.electronAPI.telegram.deleteFile(f.messageId)
    if (r.success) {
      setAllFiles(prev => prev.filter(x => x.messageId !== f.messageId))
      v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() })
      setFavs(v3store.getFavs())
    }
  }

  const toggleFav = (f: any) => {
    v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() })
    setFavs(v3store.getFavs())
  }

  const handlePreview = (f: any) => {
    const idx = favFiles.indexOf(f)
    window.electronAPI.preview.open(favFiles, idx)
  }

  return (
    <div className="v3-page" data-testid="favorites-page">
      <h1 className="v3-h1">Избранное</h1>
      <div className="v3-sub">Файлы, отмеченные звёздочкой для быстрого доступа.</div>
      {loading ? <div className="v3-sub" style={{ marginTop: 18 }}>Загрузка…</div> : favFiles.length === 0 ? (
        <div className="v3-card" style={{ marginTop: 18, padding: 30, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {navAnim && <Player autoplay loop src={navAnim} style={{ width: 140, height: 140, marginBottom: 12 }} />}
          <div className="v3-sub">Пока ничего нет. Отметьте файл звёздочкой в «Мои файлы».</div>
        </div>
      ) : (
        <div className="v3-card" style={{ marginTop: 18 }}>
          <div className="mf-grid">
            {favFiles.map((f: any) => {
              const isImg = typeOf(f.fileName) === 'image'
              const isVid = typeOf(f.fileName) === 'video'
              return (
                <div key={f.messageId} className="mf-card"
                  onDoubleClick={() => { if (isImg || isVid) handlePreview(f) }}>
                  <div className="mf-card-icon" data-type={f.mimeType?.startsWith('image') ? 'Изображения' : f.mimeType?.startsWith('video') ? 'Видео' : 'Другое'}>
                    {(f.fileName.split('.').pop() || '?').slice(0, 4).toUpperCase()}
                  </div>
                  <div className="mf-card-name" title={f.fileName}>{f.fileName}</div>
                  <div className="mf-card-meta">{fmtSize(f.fileSize)} • {new Date(((f.originalDate || f.uploadedAt) || 0) * 1000).toLocaleDateString()}</div>
                  <div className="mf-card-actions">
                    <button title="Убрать из избранного" onClick={() => toggleFav(f)}><Star size={14} fill="#fbbf24" stroke="#fbbf24" /></button>
                    <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                    {(isImg || isVid) && <button title="Просмотр" onClick={() => handlePreview(f)}><Eye size={14} /></button>}
                    <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={14} /></button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
