import React, { useEffect, useState } from "react"
import confetti from 'canvas-confetti'
import { flushSync } from 'react-dom'
import { Star, Download, Trash2, Eye } from "lucide-react"
import { Player } from '@lottiefiles/react-lottie-player'
import { v3store } from "../lib/v3store"
import { appConfirm, appAlert } from "../lib/dialogs"

import { fmtSize, typeOf } from '../lib/utils'

export default function FavoritesPage() {
  const [favs, setFavs] = useState(v3store.getFavs())
  const [allFiles, setAllFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [navAnim, setNavAnim] = useState<any>(null)
  const [thumbs, setThumbs] = useState<Record<number, string>>({})

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

  const favFiles = React.useMemo(() => allFiles.filter((f: any) => v3store.isFav(f.messageId)), [allFiles, favs])

  const loadThumbs = React.useCallback(async (files: any[]) => {
    const map: Record<number, string> = {}
    await Promise.all(files.map(async (f) => {
      try {
        const r = await window.electronAPI.telegram.downloadThumbnail(f.messageId, f.fileName)
        if (r.success && r.data) {
          const d = await window.electronAPI.file.getLocalUrl(r.data)
          if (d.success) map[f.messageId] = d.data
        }
      } catch {}
    }))
    setThumbs(prev => {
      Object.keys(map).forEach(key => {
        const oldUrl = prev[Number(key)]
        if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl)
      })
      return { ...prev, ...map }
    })
  }, [])

  useEffect(() => {
    if (favFiles.length > 0) loadThumbs(favFiles)
  }, [favFiles, loadThumbs])

  useEffect(() => {
    return () => {
      setThumbs(prev => {
        Object.values(prev).forEach(url => {
          if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
        })
        return prev
      })
    }
  }, [])

  const handleDownload = async (f: any) => {
    const r = await window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
    if (!r.success) await appAlert(r.error || 'Ошибка скачивания')
  }

  const handleDelete = async (f: any, e?: React.MouseEvent) => {
    if (!(await appConfirm('Удалить ' + f.fileName + '?'))) return

    let x = 0.5, y = 0.5
    if (e) {
      let rect = (e.currentTarget as HTMLElement).closest('.mf-card')?.getBoundingClientRect()
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
        setAllFiles(prev => prev.filter(x => x.messageId !== f.messageId))
        v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() })
        setFavs(v3store.getFavs())
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
          setAllFiles(prev => [...prev, f].sort((a, b) => (b.messageId - a.messageId)))
          v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() })
          setFavs(v3store.getFavs())
        })
      }
      if ('startViewTransition' in document) {
        (document as any).startViewTransition(revert)
      } else {
        revert()
      }
    }
  }

  const toggleFav = (f: any) => {
    const applyToggle = () => flushSync(() => {
      v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() })
      setFavs(v3store.getFavs())
    })
    if ('startViewTransition' in document) {
      (document as any).startViewTransition(applyToggle)
    } else {
      applyToggle()
    }
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
                  style={{ viewTransitionName: `card_${f.messageId}` }}
                  onDoubleClick={() => { if (isImg || isVid) handlePreview(f) }}>
                  <div className="mf-card-icon" data-type={f.mimeType?.startsWith('image') ? 'Изображения' : f.mimeType?.startsWith('video') ? 'Видео' : 'Другое'}>
                    {thumbs[f.messageId] ? (
                      <img src={thumbs[f.messageId]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      (f.fileName.split('.').pop() || '?').slice(0, 4).toUpperCase()
                    )}
                  </div>
                  <div className="mf-card-name" title={f.fileName}>{f.fileName}</div>
                  <div className="mf-card-meta">{fmtSize(f.fileSize)} • {new Date(((f.originalDate || f.uploadedAt) || 0) * 1000).toLocaleDateString()}</div>
                  <div className="mf-card-actions">
                    <button title="Убрать из избранного" onClick={() => toggleFav(f)}><Star size={14} fill="#fbbf24" stroke="#fbbf24" /></button>
                    <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                    {(isImg || isVid) && <button title="Просмотр" onClick={() => handlePreview(f)}><Eye size={14} /></button>}
                    <button title="Удалить" className="danger" onClick={(e) => handleDelete(f, e)}><Trash2 size={14} /></button>
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
