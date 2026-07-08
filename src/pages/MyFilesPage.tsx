import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { Search, Grid, List as ListIcon, Download, Trash2, Copy, Eye, X, ChevronLeft, ChevronRight, ChevronDown, ArrowLeft, Play } from 'lucide-react'

const SIX_HOURS = 21600

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

function fmtSize(n: number) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i]
}
function typeOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'Изображения'
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return 'Видео'
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return 'Аудио'
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext)) return 'Документы'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'Архивы'
  return 'Другое'
}

const CATEGORIES = ['Изображения', 'Видео', 'Документы', 'Архивы', 'Аудио', 'Другое', 'Недавние'] as const
const CAT_ICON: Record<string, string> = {
  Недавние: '🕐', Изображения: '🖼️', Видео: '🎬', Документы: '📄', Архивы: '🗄️', Аудио: '🎵', Другое: '📁',
}
const CAT_COLOR: Record<string, string> = {
  Недавние: '#fbbf24', Изображения: '#a78bfa', Видео: '#f472b6', Документы: '#60a5fa', Архивы: '#fb923c', Аудио: '#34d399', Другое: '#94a3b8',
}

function groupByMonth(items: any[]) {
  const years: Record<number, Record<number, any[]>> = {}
  items.forEach(f => {
    const d = new Date((f.uploadedAt || 0) * 1000)
    if (!isFinite(d.getTime())) return
    const y = d.getFullYear(), m = d.getMonth()
    if (!years[y]) years[y] = {}
    if (!years[y][m]) years[y][m] = []
    years[y][m].push(f)
  })
  return years
}

export default function MyFilesPage() {
  const [files, setFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'name' | 'size' | 'date'>('date')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<{ idx: number } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [toast, setToast] = useState<string>('')
  const [drillDown, setDrillDown] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())

  const loadThumbs = useCallback(async (files: any[]) => {
    const map: Record<number, string> = {}
    await Promise.all(files.map(async (f) => {
      try {
        const r = await window.electronAPI.telegram.downloadThumbnail(f.messageId)
        if (r.success && r.data) map[f.messageId] = 'file://' + r.data
      } catch {}
    }))
    setThumbs(prev => ({ ...prev, ...map }))
  }, [])

  const load = async () => {
    setLoading(true)
    const r = await window.electronAPI.telegram.listFiles()
    if (r.success) setFiles(r.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const now = Math.floor(Date.now() / 1000)
  const SIX_HOURS = 21600

  const filtered = useMemo(() => {
    let arr = [...files]
    if (search) arr = arr.filter(f => (f.fileName || '').toLowerCase().includes(search.toLowerCase()))
    arr.sort((a, b) => {
      if (sort === 'name') return (a.fileName || '').localeCompare(b.fileName || '')
      if (sort === 'size') return (b.fileSize || 0) - (a.fileSize || 0)
      return (b.uploadedAt || 0) - (a.uploadedAt || 0)
    })
    return arr
  }, [files, search, sort])

  const grouped = useMemo(() => {
    const map: Record<string, any[]> = {}
    CATEGORIES.forEach(c => { map[c] = [] })
    filtered.forEach(f => {
      if ((f.uploadedAt || 0) > 0 && (now - f.uploadedAt) < SIX_HOURS) map['Недавние']?.push(f)
      map[typeOf(f.fileName)]?.push(f)
    })
    return map
  }, [filtered, now])

  const galleryFiles = useMemo(() => {
    if (!drillDown) return []
    return filtered.filter(f => typeOf(f.fileName) === drillDown)
  }, [drillDown, filtered])

  const galleryByYear = useMemo(() => groupByMonth(galleryFiles), [galleryFiles])

  useEffect(() => {
    if (drillDown) {
      const ddFiles = filtered.filter(f => typeOf(f.fileName) === drillDown)
      loadThumbs(ddFiles)
    } else {
      setThumbs({})
    }
  }, [drillDown, filtered, loadThumbs])

  const showToast = (s: string) => { setToast(s); setTimeout(() => setToast(''), 1800) }

  const toggleSelect = (id: number) => {
    const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s)
  }
  const clearSelection = () => setSelected(new Set())

  const handleDownload = async (f: any) => {
    showToast('Скачивание ' + f.fileName)
    const r = await window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
    showToast(r.success ? 'Сохранено: ' + (r.data?.filePath || f.fileName) : 'Ошибка скачивания')
  }
  const handleDelete = async (f: any) => {
    if (!confirm('Удалить ' + f.fileName + '?')) return
    setDeletingIds(prev => new Set(prev).add(f.messageId))
    showToast('Удаление…')
    const r = await window.electronAPI.telegram.deleteFile(f.messageId)
    if (r.success) {
      showToast('Удалено')
      setTimeout(() => {
        setFiles(prev => prev.filter(x => x.messageId !== f.messageId))
        setDeletingIds(prev => { const s = new Set(prev); s.delete(f.messageId); return s })
      }, 500)
    } else {
      setDeletingIds(prev => { const s = new Set(prev); s.delete(f.messageId); return s })
      showToast('Ошибка удаления')
    }
  }
  const handleCopyLink = async (f: any) => {
    const link = `https://t.me/c/${f.chatId || ''}/${f.messageId}`
    await window.electronAPI.app.copyToClipboard(link)
    showToast('Ссылка скопирована')
  }
  const handlePreview = async (f: any, idx: number) => {
    if (typeOf(f.fileName) !== 'Изображения') return
    setPreview({ idx })
    const r = await window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
    if (r.success && r.data?.filePath) setPreviewUrl('file://' + r.data.filePath)
  }
  const navPreview = (dir: number) => {
    if (!preview) return
    const all = filtered.flatMap(f => typeOf(f.fileName) === 'Изображения' ? [f] : [])
    if (all.length === 0) return
    const curr = all.findIndex(x => x === filtered[preview.idx])
    const next = (curr + dir + all.length) % all.length
    setPreviewUrl(''); handlePreview(all[next], filtered.indexOf(all[next]))
  }

  const bulkDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`Удалить ${selected.size} файлов?`)) return
    const ids = Array.from(selected)
    setDeletingIds(prev => { const s = new Set(prev); ids.forEach(id => s.add(id)); return s })
    showToast('Удаление…')
    const r = await window.electronAPI.telegram.bulkDelete(ids)
    if (r.success) {
      setTimeout(() => {
        setFiles(prev => prev.filter(x => !ids.includes(x.messageId)))
        setDeletingIds(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s })
        clearSelection()
      }, 300)
    } else {
      setDeletingIds(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s })
      showToast('Ошибка удаления')
    }
  }
  const bulkDownload = async () => {
    if (selected.size === 0) return
    const items = files.filter(f => selected.has(f.messageId)).map(f => ({ messageId: f.messageId, fileName: f.fileName }))
    showToast('Скачивание ' + items.length + ' файлов…')
    await window.electronAPI.telegram.bulkDownload(items)
    showToast('Скачивание завершено')
  }

  const toggleCategory = (cat: string) => {
    if (cat === 'Изображения' || cat === 'Видео' || cat === 'Аудио') {
      setDrillDown(cat)
      return
    }
    const s = new Set(expanded)
    s.has(cat) ? s.delete(cat) : s.add(cat)
    setExpanded(s)
  }

  const hasFiles = Object.values(grouped).some(g => g.length > 0)

  return (
    <div className="mf-root">
      <div className="mf-toolbar">
        <div className="mf-search">
          <Search size={16} />
          <input placeholder="Поиск файлов…" value={search} onChange={e => { setSearch(e.target.value) }} />
        </div>
        <select value={sort} onChange={e => setSort(e.target.value as any)}>
          <option value="date">Новые</option>
          <option value="name">Имя</option>
          <option value="size">Крупные</option>
        </select>
        <div className="mf-view-toggle">
          <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}><Grid size={16} /></button>
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><ListIcon size={16} /></button>
        </div>
      </div>

      <div className="mf-bulkbar" style={{ position: 'sticky', top: 0, zIndex: 50, opacity: selected.size > 0 ? 1 : 0, transform: selected.size > 0 ? 'none' : 'translateY(-100%)', transition: 'opacity 0.25s, transform 0.3s', pointerEvents: selected.size > 0 ? 'auto' : 'none', visibility: selected.size > 0 ? 'visible' : 'hidden' }}>
        <span>Выбрано: {selected.size}</span>
        <button onClick={bulkDownload}><Download size={14} /> Скачать</button>
        <button className="danger" onClick={bulkDelete}><Trash2 size={14} /> Удалить</button>
        <button onClick={clearSelection}>Снять</button>
      </div>

      {loading ? <div className="mf-empty">Загрузка…</div> : drillDown ? (
        <div className="mf-gallery">
          <div className="mf-gallery-head" onClick={() => setDrillDown(null)} style={{ '--cat-color': CAT_COLOR[drillDown] } as React.CSSProperties}>
            <ArrowLeft size={18} />
            <span className="mf-section-icon">{CAT_ICON[drillDown]}</span>
            <span className="mf-section-title">{drillDown}</span>
            <span className="mf-gallery-count">{galleryFiles.length}</span>
          </div>
          <div className="mf-gallery-body">
            {drillDown === 'Аудио' ? (
              <table className="mf-table">
                <thead><tr>
                  <th><input type="checkbox" onChange={() => galleryFiles.forEach(f => toggleSelect(f.messageId))} /></th>
                  <th>Имя</th><th>Размер</th><th>Дата</th><th>Действия</th>
                </tr></thead>
                <tbody>
                  {galleryFiles.map(f => (
                    <tr key={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}>
                      <td><input type="checkbox" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} /></td>
                      <td className="ellip" title={f.fileName}>{f.fileName}</td>
                      <td>{fmtSize(f.fileSize)}</td>
                      <td>{new Date((f.uploadedAt || 0) * 1000).toLocaleDateString()}</td>
                      <td>
                        <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                        <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={14} /></button>
                        <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              Object.entries(galleryByYear).sort(([a], [b]) => +b - +a).map(([year, months]) => (
                <div key={year} className="mf-gy">
                  <div className="mf-gy-title">{year}</div>
                  {Object.entries(months).sort(([a], [b]) => +b - +a).map(([month, items]) => (
                    <div key={year + '-' + month} className="mf-gm">
                      <div className="mf-gm-title">{MONTHS_RU[+month]} <span className="mf-gm-count">{items.length}</span></div>
                      <div className="mf-gm-items">
                        {items.map((f: any) => {
                          const thumbUrl = thumbs[f.messageId]
                          const isVideo = drillDown === 'Видео'
                          return (
                            <div key={f.messageId} className={'mf-gm-card' + (selected.has(f.messageId) ? ' selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}>
                            <input type="checkbox" className="mf-check" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} />
                            <div className="mf-gm-icon" data-type={drillDown}>
                              {thumbUrl ? (
                                <>
                                  <img src={thumbUrl} className="mf-gm-img" />
                                  {isVideo && <div className="mf-gm-play"><Play size={22} /></div>}
                                </>
                              ) : (
                                isVideo ? '🎬' : '🖼️'
                              )}
                            </div>
                            <div className="mf-gm-name" title={f.fileName}>{f.fileName}</div>
                            <div className="mf-gm-meta">{fmtSize(f.fileSize)}</div>
                            <div className="mf-gm-actions">
                              <button title="Скачать" onClick={() => handleDownload(f)}><Download size={13} /></button>
                              {drillDown === 'Изображения' && <button title="Просмотр" onClick={() => handlePreview(f, filtered.indexOf(f))}><Eye size={13} /></button>}
                              <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={13} /></button>
                              <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={13} /></button>
                            </div>
                          </div>
                        )})}
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
            {galleryFiles.length === 0 && drillDown !== 'Аудио' && <div className="mf-empty">Нет файлов</div>}
          </div>
        </div>
      ) : !hasFiles && !search ? <div className="mf-empty">Нет файлов</div> : (
        <div className="mf-sections">
          {CATEGORIES.map(cat => {
            const items = grouped[cat]
            if (search && items.length === 0) return null
            const open = expanded.has(cat)
            const isDrillable = cat === 'Изображения' || cat === 'Видео' || cat === 'Аудио'
            return (
              <div key={cat} className={'mf-section' + (open ? ' open' : '')}>
                <div className="mf-section-head" onClick={() => toggleCategory(cat)} style={{ '--cat-color': CAT_COLOR[cat] } as React.CSSProperties}>
                  <ChevronDown size={14} />
                  <span className="mf-section-icon">{CAT_ICON[cat]}</span>
                  <span className="mf-section-title">{cat}</span>
                  <span className="mf-section-count">{items.length}</span>
                  {isDrillable && <span className="mf-section-drill">Открыть →</span>}
                </div>
                <div className={'mf-section-body' + (open ? ' open' : '')}>
                  {items.length > 0 && (
                    view === 'grid' ? (
                      <div className="mf-grid">
                        {items.map((f, i) => (
                          <div key={f.messageId} className={'mf-card' + (selected.has(f.messageId) ? ' selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}>
                            <input type="checkbox" className="mf-check" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} />
                            <div className="mf-card-icon" data-type={cat}>{(f.fileName.split('.').pop() || '?').slice(0, 4).toUpperCase()}</div>
                            <div className="mf-card-name" title={f.fileName}>{f.fileName}</div>
                            <div className="mf-card-meta">{fmtSize(f.fileSize)} • {new Date((f.uploadedAt || 0) * 1000).toLocaleDateString()}</div>
                            <div className="mf-card-actions">
                              <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                              {cat === 'Изображения' && <button title="Просмотр" onClick={() => handlePreview(f, filtered.indexOf(f))}><Eye size={14} /></button>}
                              <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={14} /></button>
                              <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={14} /></button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <table className="mf-table">
                        <thead><tr>
                          <th><input type="checkbox" onChange={() => items.forEach(f => toggleSelect(f.messageId))} /></th>
                          <th>Имя</th><th>Размер</th><th>Дата</th><th>Действия</th>
                        </tr></thead>
                        <tbody>
                          {items.map((f, i) => (
                            <tr key={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}>
                              <td><input type="checkbox" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} /></td>
                              <td className="ellip" title={f.fileName}>{f.fileName}</td>
                              <td>{fmtSize(f.fileSize)}</td>
                              <td>{new Date((f.uploadedAt || 0) * 1000).toLocaleDateString()}</td>
                              <td>
                                <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                                {cat === 'Изображения' && <button title="Просмотр" onClick={() => handlePreview(f, filtered.indexOf(f))}><Eye size={14} /></button>}
                                <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={14} /></button>
                                <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={14} /></button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {preview && (
        <div className="mf-modal" onClick={() => setPreview(null)}>
          <button className="mf-modal-close" onClick={() => setPreview(null)}><X size={18} /></button>
          <button className="mf-modal-nav left" onClick={(e) => { e.stopPropagation(); navPreview(-1) }}><ChevronLeft size={22} /></button>
          {previewUrl ? <img src={previewUrl} onClick={e => e.stopPropagation()} /> : <div className="mf-modal-loading">Загрузка предпросмотра…</div>}
          <button className="mf-modal-nav right" onClick={(e) => { e.stopPropagation(); navPreview(1) }}><ChevronRight size={22} /></button>
        </div>
      )}

      {toast && <div className="mf-toast">{toast}</div>}
    </div>
  )
}
