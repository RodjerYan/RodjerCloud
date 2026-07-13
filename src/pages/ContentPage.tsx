import React, { useState } from "react"
import { Search, Download, Film, FileText, Music, Image as ImgIcon, Globe, Check, Loader } from "lucide-react"

export default function ContentPage() {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [savingId, setSavingId] = useState<number | null>(null)
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set())

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!query.trim()) return

    setLoading(true)
    setError("")
    setResults([])

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

  const handleSave = async (messageId: number, peerId: string) => {
    if (savedIds.has(messageId)) return
    
    setSavingId(messageId)
    try {
      const res = await window.electronAPI.telegram.saveGlobalMedia(messageId, peerId)
      if (res.success) {
        setSavedIds(prev => new Set(prev).add(messageId))
        // Show success somehow, maybe a toast. But icon change is enough
      } else {
        alert("Ошибка при сохранении: " + res.error)
      }
    } catch (e: any) {
      alert("Ошибка: " + e.message)
    } finally {
      setSavingId(null)
    }
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
    <div className="v2-page">
      <header className="v2-page-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 16, borderBottom: 'none', paddingBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="v2-header-icon"><Globe size={24} /></div>
          <h1 className="v2-h1">Контент</h1>
        </div>
        
        <form onSubmit={handleSearch} className="content-search-bar" style={{ display: 'flex', gap: 12, position: 'relative' }}>
          <Search size={20} style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)' }} />
          <input 
            type="text" 
            placeholder="Искать фильмы, сериалы, музыку по всему Telegram..." 
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="v2-input"
            style={{ flex: 1, paddingLeft: 48, height: 52, fontSize: 16, borderRadius: 16, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)' }}
          />
          <button type="submit" className="v2-btn-primary" style={{ height: 52, padding: '0 24px', borderRadius: 16 }} disabled={loading}>
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
                  transition: 'transform 0.2s, background 0.2s'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
                    
                    <button 
                      onClick={() => handleSave(r.messageId, r.peerId)}
                      disabled={isSaved || isSaving}
                      className={isSaved ? "v2-btn-secondary" : "v2-btn-primary"}
                      style={{ padding: '6px 12px', height: 32, fontSize: 13, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, opacity: isSaved ? 0.7 : 1 }}
                    >
                      {isSaving ? <Loader size={14} className="spin" /> : (isSaved ? <Check size={14} /> : <Download size={14} />)}
                      {isSaving ? 'Сохранение...' : (isSaved ? 'В облаке' : 'В мои файлы')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
