import React, { useEffect, useMemo, useState } from 'react'
import { Search, Grid, List as ListIcon, Download, Trash2, Copy, Eye, X, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'

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

const CATEGORIES = ['Изображения', 'Видео', 'Документы', 'Архивы', 'Аудио', 'Другое'] as const
const CATEGORY_ICONS: Record<string, string> = {
  Изображения: '🖼️', Видео: '🎬', Документы: '📄', Архивы: '🗄️', Аудио: '🎵', Другое: '📁',
}

export default function MyFilesPage() {
  const [files, setFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'name' | 'size' | 'date'>('date')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set(CATEGORIES))
  const [preview, setPreview] = useState<{ idx: number } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [toast, setToast] = useState<string>('')

  const load = async () => {
    setLoading(true)
    const r = await window.electronAPI.telegram.listFiles()
    if (r.success) setFiles(r.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

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
    filtered.forEach(f => { map[typeOf(f.fileName)]?.push(f) })
    return map
  }, [filtered])

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
    const r = await window.electronAPI.telegram.deleteFile(f.messageId)
    if (r.success) { showToast('Удалено'); load() } else showToast('Ошибка удаления')
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
    showToast('Удаление…')
    await window.electronAPI.telegram.bulkDelete(Array.from(selected))
    clearSelection(); load()
  }
  const bulkDownload = async () => {
    if (selected.size === 0) return
    const items = files.filter(f => selected.has(f.messageId)).map(f => ({ messageId: f.messageId, fileName: f.fileName }))
    showToast('Скачивание ' + items.length + ' файлов…')
    await window.electronAPI.telegram.bulkDownload(items)
    showToast('Скачивание завершено')
  }

  const toggleCategory = (cat: string) => {
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

      {selected.size > 0 && (
        <div className="mf-bulkbar">
          <span>Выбрано: {selected.size}</span>
          <button onClick={bulkDownload}><Download size={14} /> Скачать</button>
          <button className="danger" onClick={bulkDelete}><Trash2 size={14} /> Удалить</button>
          <button onClick={clearSelection}>Снять</button>
        </div>
      )}

      {loading ? <div className="mf-empty">Загрузка…</div> : !hasFiles && !search ? <div className="mf-empty">Нет файлов</div> : (
        <div className="mf-sections">
          {CATEGORIES.map(cat => {
            const items = grouped[cat]
            if (search && items.length === 0) return null
            const open = expanded.has(cat)
            return (
              <div key={cat} className="mf-section">
                <div className="mf-section-head" onClick={() => toggleCategory(cat)}>
                  <ChevronDown size={16} style={{ transform: `rotate(${open ? 0 : -90}deg)`, transition: 'transform 0.2s' }} />
                  <span className="mf-section-icon">{CATEGORY_ICONS[cat]}</span>
                  <span className="mf-section-title">{cat}</span>
                  <span className="mf-section-count">{items.length}</span>
                </div>
                {open && items.length > 0 && (
                  view === 'grid' ? (
                    <div className="mf-grid">
                      {items.map((f, i) => (
                        <div key={f.messageId} className={'mf-card' + (selected.has(f.messageId) ? ' selected' : '')}>
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
                          <tr key={f.messageId} className={selected.has(f.messageId) ? 'selected' : ''}>
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
                {open && items.length === 0 && !search && (
                  <div className="mf-empty" style={{ padding: 24 }}>Нет файлов</div>
                )}
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
