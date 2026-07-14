import React, { useState } from "react"
import { Search, Download, Film, FileText, Music, Image as ImgIcon, Globe, Check, Loader, X, Eye } from "lucide-react"

export default function ContentPage() {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [savingId, setSavingId] = useState<number | null>(null)
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set())
  const [previewItem, setPreviewItem] = useState<any | null>(null)
  const [previewData, setPreviewData] = useState<{ filePath: string; mimeType: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!query.trim()) return

    setLoading(true)
    setError("")
    setResults([])
    setPreviewItem(null)
    setPreviewData(null)
    setPreviewUrl(null)

    try {
      const res = await window.electronAPI.telegram.searchGlobal(query)
      if (res.success && res.data) {
        setResults(res.data)
      } else {
        setError(res.error || "Ошибка поиска")
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (r: any) => {
    if (savedIds.has(r.messageId)) return
    
    setSavingId(r.messageId)
    try {
      const res = await window.electronAPI.telegram.saveGlobalMedia(r.messageId, r.peerId, r.mediaDoc, r.mediaType, r.text)
      if (res.success) {
        setSavedIds(prev => new Set(prev).add(r.messageId))
      } else {
        alert("Ошибка при сохранении: " + res.error)
      }
    } catch (e: any) {
      alert("Ошибка: " + e.message)
    } finally {
      setSavingId(null)
    }
  }

  const handlePreview = async (r: any) => {
    setPreviewItem(r)
    setPreviewLoading(true)
    setPreviewUrl(null)
    setPreviewData(null)

    try {
      const res = await window.electronAPI.telegram.previewGlobalMedia(r.previewKey)
      if (res.success && res.data) {
        setPreviewData(res.data)

        if (res.data.mimeType.startsWith('image/')) {
          const urlRes = await window.electronAPI.file.readDataUrl(res.data.filePath)
          if (urlRes.success) setPreviewUrl(urlRes.data)
          else setPreviewUrl('file:///' + encodeURI(res.data.filePath.replace(/\\/g, '/').replace(/^\//, '')))
        } else {
          const urlRes = await window.electronAPI.file.getLocalUrl(res.data.filePath)
          if (urlRes.success) setPreviewUrl(urlRes.data)
        }
      } else {
        alert("Ошибка загрузки: " + (res.error || "Unknown error"))
        closePreview()
      }
    } catch (e: any) {
      alert("Ошибка: " + e.message)
      closePreview()
    } finally {
      setPreviewLoading(false)
    }
  }

  const closePreview = () => {
    setPreviewItem(null)
    setPreviewData(null)
    setPreviewUrl(null)
  }

  const formatSize = (bytes: number) => {
    if (!bytes || bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB", "TB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }

  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith("video/")) return <Film size={32} className="v2-accent" />
    if (mimeType.startsWith("image/")) return <ImgIcon size={32} className="v2-accent" />
    if (mimeType.startsWith("audio/")) return <Music size={32} className="v2-accent" />
    return <FileText size={32} className="v2-accent" />
  }

  return (
    <div className="v3-page">
      <header className="v2-page-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 16, borderBottom: 'none', paddingBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="v2-header-icon"><Globe size={24} /></div>
          <h1 className="v2-h1">Контент</h1>
        </div>
        
        <form onSubmit={handleSearch} className="content-search-bar" style={{ display: 'flex', gap: 12, position: 'relative', WebkitAppRegion: 'no-drag' as any }}>
          <Search size={20} style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)', pointerEvents: 'none' }} />
          <input 
            type="text" 
            placeholder="Искать фильмы, сериалы, музыку по всему Telegram..." 
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="v3-input"
            style={{ flex: 1, paddingLeft: 48, height: 52, fontSize: 16, borderRadius: 16, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text)' }}
          />
          <button type="submit" className="v3-btn primary" style={{ height: 52, padding: '0 24px', borderRadius: 16 }} disabled={loading}>
            {loading ? <Loader className="spin" size={20} /> : "Найти"}
          </button>
        </form>
      </header>

      <div className="v2-page-content" style={{ marginTop: 24 }}>
        {error && <div className="v2-error-banner" style={{ padding: 16, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: 12, marginBottom: 20 }}>{error}</div>}
        
        {!loading && results.length === 0 && !error && query && (
          <div className="v2-empty-state">
            <Globe size={48} style={{ opacity: 0.3 }} />
            <h3>Ничего не найдено</h3>
            <p>Попробуйте изменить запрос</p>
          </div>
        )}

        {!loading && results.length === 0 && !error && !query && (
          <div className="v2-empty-state" style={{ marginTop: 60 }}>
            <Globe size={64} style={{ opacity: 0.2, marginBottom: 16 }} />
            <h3>Глобальный поиск</h3>
            <p style={{ maxWidth: 400, margin: '0 auto', opacity: 0.6 }}>Вводите название фильма, альбома или программы, и мы найдем это в открытых каналах Telegram.</p>
          </div>
        )}

        {loading && (
          <div className="content-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {[1,2,3,4,5,6].map(i => (
              <div key={i} className="v2-skeleton" style={{ height: 160, borderRadius: 16 }} />
            ))}
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="content-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
            {results.map((r, i) => {
              const isSaved = savedIds.has(r.messageId)
              const isSaving = savingId === r.messageId
              
              return (
                <div key={r.messageId + '_' + i} className="content-card" style={{ 
                  background: 'rgba(255,255,255,0.03)', 
                  border: '1px solid rgba(255,255,255,0.05)', 
                  borderRadius: 16, 
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  transition: 'transform 0.2s, background 0.2s',
                  cursor: 'pointer',
                }}
                  onClick={() => handlePreview(r)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {getFileIcon(r.mimeType)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 15 }} title={r.fileName}>
                        {r.fileName}
                      </div>
                      <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
                        {formatSize(r.fileSize)}
                      </div>
                    </div>
                  </div>
                  
                  {r.text && (
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4 }}>
                      {r.text}
                    </div>
                  )}

                  <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span>от</span>
                      <span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 500, maxWidth: 100, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.authorName}</span>
                    </div>
                    
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button 
                        onClick={(e) => { e.stopPropagation(); handlePreview(r) }}
                        className="v3-btn"
                        style={{ padding: '6px 12px', height: 32, fontSize: 13, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <Eye size={14} />
                        Просмотр
                      </button>
                      <button 
                        onClick={(e) => { e.stopPropagation(); handleSave(r) }}
                        disabled={isSaved || isSaving}
                        className={isSaved ? "v3-btn" : "v3-btn primary"}
                        style={{ padding: '6px 12px', height: 32, fontSize: 13, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, opacity: isSaved ? 0.7 : 1 }}
                      >
                        {isSaving ? <Loader size={14} className="spin" /> : (isSaved ? <Check size={14} /> : <Download size={14} />)}
                        {isSaving ? 'Сохранение...' : (isSaved ? 'В облаке' : 'В мои файлы')}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {previewItem && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24,
        }} onClick={closePreview}>
          <div style={{
            background: 'var(--bg, #1a1a2e)', borderRadius: 20,
            maxWidth: 800, width: '100%', maxHeight: '90vh',
            overflow: 'auto', position: 'relative',
            border: '1px solid rgba(255,255,255,0.1)',
          }} onClick={(e) => e.stopPropagation()}>
            <button onClick={closePreview} style={{
              position: 'absolute', top: 12, right: 12, zIndex: 2,
              width: 36, height: 36, borderRadius: 10,
              background: 'rgba(0,0,0,0.5)', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: '#fff',
            }}>
              <X size={20} />
            </button>

            {previewLoading ? (
              <div style={{ padding: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Loader size={40} className="spin" style={{ opacity: 0.5 }} />
              </div>
            ) : previewUrl && previewItem.mimeType.startsWith('image/') ? (
              <div style={{ padding: 16, display: 'flex', justifyContent: 'center' }}>
                <img src={previewUrl} alt="Preview" style={{
                  maxWidth: '100%', maxHeight: '60vh', borderRadius: 12,
                  objectFit: 'contain', background: '#000',
                }} />
              </div>
            ) : previewUrl && previewItem.mimeType.startsWith('video/') ? (
              <div style={{ padding: 16 }}>
                <video controls autoPlay style={{ width: '100%', maxHeight: '60vh', borderRadius: 12, background: '#000' }}
                  src={previewUrl}>
                </video>
              </div>
            ) : previewUrl && previewItem.mimeType.startsWith('audio/') ? (
              <div style={{ padding: 24, textAlign: 'center' }}>
                <Music size={64} style={{ opacity: 0.4, marginBottom: 16 }} />
                <audio controls autoPlay style={{ width: '100%' }} src={previewUrl} />
              </div>
            ) : previewData ? (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <FileText size={64} style={{ opacity: 0.4, marginBottom: 16 }} />
                <p style={{ fontSize: 15, opacity: 0.7, margin: 0 }}>Предпросмотр недоступен для данного типа файла</p>
                <p style={{ fontSize: 13, opacity: 0.4, marginTop: 8 }}>{previewData.mimeType}</p>
              </div>
            ) : null}

            <div style={{ padding: '0 20px 20px' }}>
              <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>{previewItem.fileName}</h2>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                <span>{formatSize(previewItem.fileSize)}</span>
                <span>{previewItem.mimeType}</span>
                <span>от {previewItem.authorName}</span>
              </div>
              {previewItem.text && (
                <div style={{ marginTop: 12, padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 10, fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5, maxHeight: 120, overflow: 'auto' }}>
                  {previewItem.text}
                </div>
              )}
              <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                <button onClick={() => { handleSave(previewItem); closePreview() }}
                  disabled={savedIds.has(previewItem.messageId) || savingId === previewItem.messageId}
                  className={savedIds.has(previewItem.messageId) ? "v3-btn" : "v3-btn primary"}
                  style={{ padding: '10px 20px', borderRadius: 12, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'center' }}
                >
                  {savingId === previewItem.messageId ? <Loader size={16} className="spin" /> : (savedIds.has(previewItem.messageId) ? <Check size={16} /> : <Download size={16} />)}
                  {savedIds.has(previewItem.messageId) ? 'Сохранено' : 'Сохранить в мои файлы'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
