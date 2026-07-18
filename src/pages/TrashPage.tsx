import React, { useEffect, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import confetti from 'canvas-confetti'
import { flushSync } from 'react-dom'
import { Trash2, RotateCcw, X, Download, Search, Grid, List as ListIcon, Share2, Trash2 as DeleteIcon, Circle } from "lucide-react"
import { Player } from '@lottiefiles/react-lottie-player'
import { appConfirm } from '../lib/dialogs'
import { toast } from '../lib/toast'

const fmtSize = (n: number) => {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i]
}

const DAY_MS = 86400000

export default function TrashPage() {
  const [fairAnim, setFairAnim] = useState<any>(null)
  const [files, setFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: any } | null>(null)
  const closeCtx = useCallback(() => setCtxMenu(null), [])

  useEffect(() => {
    window.electronAPI.tgs.read('fair.tgs').then((r: any) => {
      if (r.success) setFairAnim(r.data)
    })
  }, [])


  const load = useCallback(async () => {
    setLoading(true)
    const r = await window.electronAPI.telegram.listTrash()
    if (r.success) setFiles(r.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onMousedown = (e: MouseEvent) => {
      if (e.button !== 2) return
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-mid]')
      if (!el) return
      const mid = Number(el.dataset.mid)
      const f = files.find(x => x.messageId === mid)
      if (f) setCtxMenu({ x: e.clientX, y: e.clientY, file: f })
    }
    const onContext = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-mid]')) e.preventDefault()
    }
    document.addEventListener('mousedown', onMousedown)
    document.addEventListener('contextmenu', onContext)
    return () => {
      document.removeEventListener('mousedown', onMousedown)
      document.removeEventListener('contextmenu', onContext)
    }
  }, [files])

  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.('.mf-ctx')) return
      setCtxMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true) }
  }, [ctxMenu])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-mid]')
      if (!el) return
      if ((e.target as HTMLElement).closest('button')) return
      if ((e.target as HTMLElement).closest('.mf-ctx')) return
      const mid = Number(el.dataset.mid)
      toggleSelect(mid)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [files])

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s
    })
  }
  const clearSelection = () => setSelected(new Set())

  const handleRestore = async (id: number, e?: React.MouseEvent) => {
    let targetElement = e ? (e.currentTarget as HTMLElement).closest('.mf-card, .mf-list-item, tr') : null;
    let clientX = e ? e.clientX : undefined;
    let clientY = e ? e.clientY : undefined;
    
    // Note: appConfirm requires no e.currentTarget reference here as it's an async operation that clears the event context
    const confirmed = await appConfirm('Восстановить файл?')
    if (!confirmed) return

    let x = 0.5, y = 0.5
    if (targetElement) {
      let rect = targetElement.getBoundingClientRect()
      x = (rect.left + rect.width / 2) / window.innerWidth
      y = (rect.top + rect.height / 2) / window.innerHeight
    } else if (clientX !== undefined && clientY !== undefined) {
      x = clientX / window.innerWidth
      y = clientY / window.innerHeight
    }
    confetti({ particleCount: 50, spread: 80, origin: { x, y }, colors: ['#4ade80', '#10b981', '#a1a1aa'], disableForReducedMotion: true, zIndex: 9999 })

    const f = files.find(x => x.messageId === id)
    const applyRemove = () => {
      flushSync(() => {
        setFiles(prev => prev.filter(f => f.messageId !== id))
        setSelected(prev => { const s = new Set(prev); s.delete(id); return s })
      })
    }
    if ('startViewTransition' in document) { (document as any).startViewTransition(applyRemove) } else { applyRemove() }

    const r = await window.electronAPI.telegram.restoreFile(id)
    if (r.success) {
      toast.success('Файл восстановлен')
    } else {
      toast.error('Ошибка восстановления')
      const revert = () => flushSync(() => { if (f) setFiles(prev => [...prev, f].sort((a, b) => (b.messageId - a.messageId))) })
      if ('startViewTransition' in document) { (document as any).startViewTransition(revert) } else { revert() }
    }
  }

  const handlePurge = async (id: number, e?: React.MouseEvent) => {
    let targetElement = e ? (e.currentTarget as HTMLElement).closest('.mf-card, .mf-list-item, tr') : null;
    let clientX = e ? e.clientX : undefined;
    let clientY = e ? e.clientY : undefined;

    if (!(await appConfirm('Удалить файл навсегда?'))) return

    let x = 0.5, y = 0.5
    if (targetElement) {
      let rect = targetElement.getBoundingClientRect()
      x = (rect.left + rect.width / 2) / window.innerWidth
      y = (rect.top + rect.height / 2) / window.innerHeight
    } else if (clientX !== undefined && clientY !== undefined) {
      x = clientX / window.innerWidth
      y = clientY / window.innerHeight
    }
    confetti({ particleCount: 50, spread: 80, origin: { x, y }, colors: ['#ef4444', '#dc2626', '#a1a1aa'], disableForReducedMotion: true, zIndex: 9999 })

    const f = files.find(x => x.messageId === id)
    const applyRemove = () => {
      flushSync(() => {
        setFiles(prev => prev.filter(f => f.messageId !== id))
        setSelected(prev => { const s = new Set(prev); s.delete(id); return s })
      })
    }
    if ('startViewTransition' in document) { (document as any).startViewTransition(applyRemove) } else { applyRemove() }

    const r = await window.electronAPI.telegram.permDeleteFile(id)
    if (r.success) {
      toast.success('Файл удалён навсегда')
    } else {
      toast.error('Ошибка удаления')
      const revert = () => flushSync(() => { if (f) setFiles(prev => [...prev, f].sort((a, b) => (b.messageId - a.messageId))) })
      if ('startViewTransition' in document) { (document as any).startViewTransition(revert) } else { revert() }
    }
  }

  const handleBulkRestore = async (e?: React.MouseEvent) => {
    if (selected.size === 0) return
    let x = 0.5, y = 0.5
    if (e) { x = e.clientX / window.innerWidth; y = e.clientY / window.innerHeight }
    confetti({ particleCount: 150, spread: 120, origin: { x, y }, colors: ['#4ade80', '#10b981', '#a1a1aa'], disableForReducedMotion: true, zIndex: 9999 })

    const ids = Array.from(selected)
    const filesToRestore = files.filter(f => ids.includes(f.messageId))
    const applyRemove = () => {
      flushSync(() => {
        setFiles(prev => prev.filter(f => !ids.includes(f.messageId)))
        clearSelection()
      })
    }
    if ('startViewTransition' in document) { (document as any).startViewTransition(applyRemove) } else { applyRemove() }

    let allSuccess = true
    for (const id of ids) {
      const r = await window.electronAPI.telegram.restoreFile(id)
      if (!r.success) allSuccess = false
    }
    if (allSuccess) {
      toast.success(`Восстановлено ${ids.length} файлов`)
    } else {
      toast.error('Ошибка восстановления некоторых файлов')
      const revert = () => {
        flushSync(() => {
          setFiles(prev => {
            const currentIds = new Set(prev.map(p => p.messageId))
            const missing = filesToRestore.filter(ftr => !currentIds.has(ftr.messageId))
            return [...prev, ...missing].sort((a, b) => (b.messageId - a.messageId))
          })
        })
      }
      if ('startViewTransition' in document) { (document as any).startViewTransition(revert) } else { revert() }
    }
  }

  const handleBulkPurge = async (e?: React.MouseEvent) => {
    if (selected.size === 0) return
    if (!(await appConfirm(`Удалить навсегда ${selected.size} файлов?`))) return
    let x = 0.5, y = 0.5
    if (e) { x = e.clientX / window.innerWidth; y = e.clientY / window.innerHeight }
    confetti({ particleCount: 150, spread: 120, origin: { x, y }, colors: ['#ef4444', '#dc2626', '#a1a1aa'], disableForReducedMotion: true, zIndex: 9999 })

    const ids = Array.from(selected)
    const filesToRestore = files.filter(f => ids.includes(f.messageId))
    const applyRemove = () => {
      flushSync(() => {
        setFiles(prev => prev.filter(f => !ids.includes(f.messageId)))
        clearSelection()
      })
    }
    if ('startViewTransition' in document) { (document as any).startViewTransition(applyRemove) } else { applyRemove() }

    let allSuccess = true
    for (const id of ids) {
      const r = await window.electronAPI.telegram.permDeleteFile(id)
      if (!r.success) allSuccess = false
    }
    if (allSuccess) {
      toast.success(`Удалено навсегда ${ids.length} файлов`)
    } else {
      toast.error('Ошибка удаления некоторых файлов')
      const revert = () => {
        flushSync(() => {
          setFiles(prev => {
            const currentIds = new Set(prev.map(p => p.messageId))
            const missing = filesToRestore.filter(ftr => !currentIds.has(ftr.messageId))
            return [...prev, ...missing].sort((a, b) => (b.messageId - a.messageId))
          })
        })
      }
      if ('startViewTransition' in document) { (document as any).startViewTransition(revert) } else { revert() }
    }
  }

  const handleBulkDownload = async () => {
    if (selected.size === 0) return
    const items = files.filter(f => selected.has(f.messageId)).map(f => ({ messageId: f.messageId, fileName: f.fileName }))
    toast.loading('Скачивание ' + items.length + ' файлов…')
    await window.electronAPI.telegram.bulkDownload(items)
    toast.success('Скачивание завершено')
  }

  const filtered = files.filter(f => {
    if (search) return (f.fileName || '').toLowerCase().includes(search.toLowerCase())
    return true
  })

  return (
    <div className="mf-root mf-hide-checks">
      <div className="mf-toolbar">
        <div className="mf-search">
          <Search size={16} />
          <input placeholder="Поиск в корзине…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="mf-view-toggle">
          <button type="button" className={view === 'grid' ? 'active' : ''} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setView('grid'); }}><Grid size={16} /></button>
          <button type="button" className={view === 'list' ? 'active' : ''} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setView('list'); }}><ListIcon size={16} /></button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0 8px', color: 'var(--text-dim)', fontSize: 13 }}>
        <Trash2 size={16} style={{ color: '#f87171' }} />
        <span>Корзина · {files.length} файлов</span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>— удаляются через 3 дня автоматически</span>
      </div>

      <div className="mf-bulkbar" style={{ position: 'sticky', top: 0, zIndex: 50, opacity: selected.size > 0 ? 1 : 0, transform: selected.size > 0 ? 'none' : 'translateY(-100%)', transition: 'opacity 0.25s, transform 0.3s', pointerEvents: selected.size > 0 ? 'auto' : 'none', visibility: selected.size > 0 ? 'visible' : 'hidden' }}>
        <span>Выбрано: {selected.size}</span>
        <button onClick={(e) => handleBulkRestore(e)}><RotateCcw size={14} /> Восстановить</button>
        <button onClick={handleBulkDownload}><Download size={14} /> Скачать</button>
        <button className="danger" onClick={(e) => handleBulkPurge(e)}><X size={14} /> Удалить навсегда</button>
        <button onClick={clearSelection}>Снять</button>
      </div>

      {loading ? <div className="mf-empty">Загрузка…</div> : filtered.length === 0 ? (
        <div className="mf-empty" style={{ paddingTop: 60 }}>
          {fairAnim ? (
            <Player autoplay loop src={fairAnim} style={{ width: 140, height: 140, marginBottom: 12 }} />
          ) : (
            <Trash2 size={48} style={{ opacity: 0.2, marginBottom: 12 }} />
          )}
          <div>Корзина пуста</div>
        </div>
      ) : view === 'grid' ? (
        <div className="mf-grid" style={{ marginTop: 12 }}>
          {filtered.map(f => {
            const daysLeft = Math.max(0, 3 - Math.floor((Date.now() - (f.trashedAt || 0)) / DAY_MS))
            return (
              <div key={f.messageId} data-mid={f.messageId} className={'mf-card' + (selected.has(f.messageId) ? ' selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')} style={{ viewTransitionName: `card_${f.messageId}` }}>
                <input type="checkbox" className="mf-check" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} />
                <div className="mf-card-icon" data-type="trash">{(f.fileName.split('.').pop() || '?').slice(0, 4).toUpperCase()}</div>
                <div className="mf-card-name" title={f.fileName}>{f.fileName}</div>
                <div className="mf-card-meta">{fmtSize(f.fileSize)} · {daysLeft > 0 ? `удал. через ${daysLeft} дн.` : 'сегодня'}</div>
                <div className="mf-card-actions">
                  <button title="Восстановить" onClick={(e) => handleRestore(f.messageId, e)}><RotateCcw size={14} /></button>
                  <button title="Скачать" onClick={() => window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)}><Download size={14} /></button>
                  <button title="Удалить навсегда" className="danger" onClick={(e) => handlePurge(f.messageId, e)}><X size={14} /></button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <table className="mf-table" style={{ marginTop: 12 }}>
          <thead><tr>
            <th><input type="checkbox" onChange={() => filtered.forEach(f => toggleSelect(f.messageId))} /></th>
            <th>Имя</th><th>Размер</th><th>Удалён</th><th>Действия</th>
          </tr></thead>
          <tbody>
            {filtered.map(f => {
              const daysLeft = Math.max(0, 3 - Math.floor((Date.now() - (f.trashedAt || 0)) / DAY_MS))
              return (
                <tr key={f.messageId} data-mid={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')} style={{ viewTransitionName: `card_${f.messageId}` }}>
                  <td><input type="checkbox" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} /></td>
                  <td className="ellip" title={f.fileName}>{f.fileName}</td>
                  <td>{fmtSize(f.fileSize)}</td>
                  <td>{daysLeft > 0 ? `через ${daysLeft} дн.` : 'сегодня'}</td>
                  <td>
                    <button title="Восстановить" onClick={(e) => handleRestore(f.messageId, e)}><RotateCcw size={14} /></button>
                    <button title="Скачать" onClick={() => window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)}><Download size={14} /></button>
                    <button title="Удалить навсегда" className="danger" onClick={(e) => handlePurge(f.messageId, e)}><X size={14} /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {ctxMenu && createPortal(
        <div className="mf-ctx" style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }}>
          <button onClick={() => { toggleSelect(ctxMenu.file.messageId); closeCtx() }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {selected.has(ctxMenu.file.messageId)
                ? <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>
                : <circle cx="12" cy="12" r="10"/>}
            </svg>
            Выбрать
          </button>
          <button onClick={(e) => { handleRestore(ctxMenu.file.messageId, e); closeCtx() }}>
            <RotateCcw size={14} /> Восстановить
          </button>
          <div className="mf-ctx-divider" />
          <button className="danger" onClick={(e) => { handlePurge(ctxMenu.file.messageId, e); closeCtx() }}>
            <X size={14} /> Удалить навсегда
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}