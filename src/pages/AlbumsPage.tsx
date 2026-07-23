import React, { useEffect, useState, useMemo, useCallback, useRef } from "react"
import { VirtuosoGrid } from 'react-virtuoso'
import { createPortal, flushSync } from 'react-dom'
import confetti from 'canvas-confetti'
import { Image, Film, Camera, Copy, Plus, Trash2, Download, Eye, X, ArrowLeft, Loader2, Share2, MoveRight, Pencil, Play } from "lucide-react"
import { fmtSize } from '../lib/utils'
import { v3store } from "../lib/v3store"
import { SMART_ALBUMS } from "../lib/albums"
import { Player } from '@lottiefiles/react-lottie-player'
import { appConfirm, appAlert } from "../lib/dialogs"
import { toast } from '../lib/toast'

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

import { fileDate, groupByDay } from '../lib/utils'
import { FileThumb } from '../components/FileThumb'

export default function AlbumsPage() {
  const [allFiles, setAllFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [albums, setAlbums] = useState(v3store.getAlbums())
  const [newName, setNewName] = useState('')
  const [openAlbum, setOpenAlbum] = useState<string | null>(null)
  const [hashing, setHashing] = useState(false)
  const [hashProgress, setHashProgress] = useState({ done: 0, total: 0 })
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: any } | null>(null)
  const [renameTarget, setRenameTarget] = useState<any>(null)
  const [renameInput, setRenameInput] = useState('')
  const [showSub, setShowSub] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [duckAnim, setDuckAnim] = useState<any>(null)
  const [hashTrigger, setHashTrigger] = useState(0)
  
  const loaderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        
      }
    }, { rootMargin: '200px' })
    if (loaderRef.current) observer.observe(loaderRef.current)
    return () => observer.disconnect()
  }, [])

  // Reset display count when album changes
  useEffect(() => {
    
  }, [openAlbum])

  useEffect(() => { window.electronAPI.tgs.read('duck.tgs').then((r: any) => { if (r.success) setDuckAnim(r.data) }) }, [])

  const closeCtx = useCallback(() => { setCtxMenu(null); setShowSub(null) }, [])

  useEffect(() => {
    window.electronAPI.telegram.listFiles().then((r: any) => {
      if (r?.success) setAllFiles(r.data || [])
      setLoading(false)
    })
    setAlbums(v3store.getAlbums())
  }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.('.mf-ctx')) return
      setCtxMenu(null)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [ctxMenu])

  const onContextMenu = useCallback((e: React.MouseEvent, f: any) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, file: f })
  }, [])

  const currentAlbum: SmartAlbum | { id: string; name: string; messageIds: number[] } | null = openAlbum
    ? SMART_ALBUMS.find(a => a.id === openAlbum) || albums.find(a => a.id === openAlbum) || null
    : null

  const computeHashes = useCallback(async (files: any[]) => {
    let done = 0; const total = files.length
    setHashProgress({ done, total }); setHashing(true)
    for (const f of files) {
      const existing = v3store.metaFor(f.messageId)
      if (existing?.hash) { done++; setHashProgress({ done, total }); continue }
      try {
        const r = await window.electronAPI.file.computeHash(f.messageId)
        if (r.success && r.data) v3store.setMeta({ messageId: f.messageId, hash: r.data })
      } catch {}
      done++; setHashProgress({ done, total })
    }
    setHashing(false); setAlbums(v3store.getAlbums())
  }, [])

  const hashGroups = useMemo(() => {
    const metaMap = new Map<number, any>()
    v3store.getMeta().forEach(m => { if (m.hash) metaMap.set(m.messageId, m) })
    const groups = new Map<string, any[]>()
    allFiles.filter(f => f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/')).forEach(f => {
      const m = metaMap.get(f.messageId)
      if (m?.hash) { const g = groups.get(m.hash) || []; g.push(f); groups.set(m.hash, g) }
    })
    return groups
  }, [allFiles, hashTrigger])

  const albumFiles = useMemo(() => {
    if (!currentAlbum) return []
    const isDuplicates = SMART_ALBUMS.find(a => a.id === currentAlbum.id)?.isDuplicates
    if (isDuplicates) {
      const dups: any[] = []
      hashGroups.forEach(group => { if (group.length > 1) dups.push(...group) })
      return dups
    }
    const smart = SMART_ALBUMS.find(a => a.id === currentAlbum.id)
    if (smart?.filter) return allFiles.filter(smart.filter)
    const ua = albums.find(a => a.id === currentAlbum.id)
    if (!ua) return []; return allFiles.filter(f => ua.messageIds.includes(f.messageId))
  }, [currentAlbum, allFiles, albums, hashGroups])

  const grouped = useMemo(() => groupByDay(albumFiles.slice()), [albumFiles])

  useEffect(() => {
    if (openAlbum) {
      window.electronAPI.telegram.listFiles().then((r: any) => { if (r?.success) setAllFiles(r.data || []) })
      const isDuplicates = SMART_ALBUMS.find(a => a.id === openAlbum)?.isDuplicates
      if (isDuplicates) {
        setHashing(true)
        window.electronAPI.bot.getHashDb().then((r: any) => {
          if (r.success && r.data) {
            for (const e of r.data) {
              if (e.hash) v3store.setMeta({ messageId: e.messageId, hash: e.hash })
            }
            setHashTrigger(prev => prev + 1)
          }
          setHashing(false)
        })
      }
    }
  }, [openAlbum])


  const createAlbum = () => {
    if (!newName.trim()) return
    v3store.addAlbum({ id: crypto.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)), name: newName.trim(), messageIds: [], createdAt: Date.now() })
    setAlbums(v3store.getAlbums()); setNewName(''); setShowCreateModal(false)
  }

  const removeAlbum = async (id: string) => {
    if (!(await appConfirm('Удалить альбом?'))) return; v3store.removeAlbum(id); setAlbums(v3store.getAlbums())
    if (openAlbum === id) setOpenAlbum(null)
  }

  const removeFile = (messageId: number, e?: React.MouseEvent) => {
    if (!currentAlbum || SMART_ALBUMS.find(a => a.id === currentAlbum.id)) return

    let x = 0.5, y = 0.5
    if (e) {
      let rect = (e.currentTarget as HTMLElement).closest('.mf-gm-card')?.getBoundingClientRect()
      if (rect) {
        x = (rect.left + rect.width / 2) / window.innerWidth
        y = (rect.top + rect.height / 2) / window.innerHeight
      } else {
        x = e.clientX / window.innerWidth
        y = e.clientY / window.innerHeight
      }
    }
    confetti({
      particleCount: 40,
      spread: 70,
      origin: { x, y },
      colors: ['#a1a1aa', '#ff4b4b'],
      disableForReducedMotion: true,
      zIndex: 9999
    })

    const applyRemove = () => {
      flushSync(() => {
        v3store.removeFromAlbum(currentAlbum.id, messageId)
        setAlbums(v3store.getAlbums())
      })
    }
    
    if ('startViewTransition' in document) {
      (document as any).startViewTransition(applyRemove)
    } else {
      applyRemove()
    }
  }

  const handleDownload = async (f: any) => {
    const r = await window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
    if (!r.success) await appAlert(r.error || 'Ошибка')
  }

  const handleDelete = async (f: any, e?: React.MouseEvent) => {
    let targetElement = e ? (e.currentTarget as HTMLElement).closest('.mf-gm-card') : null;
    let clientX = e ? e.clientX : undefined;
    let clientY = e ? e.clientY : undefined;
    
    if (!(await appConfirm('Удалить ' + f.fileName + '?'))) return

    let x = 0.5, y = 0.5
    if (targetElement) {
      let rect = targetElement.getBoundingClientRect()
      x = (rect.left + rect.width / 2) / window.innerWidth
      y = (rect.top + rect.height / 2) / window.innerHeight
    } else if (clientX !== undefined && clientY !== undefined) {
      x = clientX / window.innerWidth
      y = clientY / window.innerHeight
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
        })
      }
      if ('startViewTransition' in document) {
        (document as any).startViewTransition(revert)
      } else {
        revert()
      }
    }
  }

  const handlePreview = (f: any) => {
    const idx = albumFiles.indexOf(f)
    window.electronAPI.preview.open(albumFiles, idx)
  }

  const handleCopyLink = async (f: any) => {
    try {
      const r = await window.electronAPI.share.generateLink(f.messageId, f.chatId || '', f.fileName)
      if (r.success) { const url = r.data.url || r.data; window.electronAPI.app.copyToClipboard(url); toast.success('Ссылка скопирована') }
      else toast.error(r.error || 'Ошибка')
    } catch { toast.error('Ошибка') }
  }

  const renderCard = (f: any, isSmart: boolean, isDup?: boolean) => {
    const isVid = f.mimeType?.startsWith('video/')
    return (
      <div key={f.messageId} className="mf-gm-card magnetic" style={{ viewTransitionName: `card_${f.messageId}` }} onDoubleClick={() => handlePreview(f)} onContextMenu={(e) => onContextMenu(e, f)}>
        <div className="mf-gm-icon" data-type={isVid ? 'Видео' : 'Изображения'}>
          <FileThumb messageId={f.messageId} fileName={f.fileName} isVideo={isVid} typeLabel={isVid ? 'Видео' : 'Изображения'} />
        </div>
        <div className="mf-gm-name" title={f.fileName}>{f.fileName}</div>
        <div className="mf-gm-meta">{fmtSize(f.fileSize)}</div>
        <div className="mf-gm-actions">
          <button title="Скачать" onClick={() => handleDownload(f)}><Download size={13} /></button>
          <button title="Просмотр" onClick={() => handlePreview(f)}><Eye size={13} /></button>
          {isSmart ? <button title="Удалить из Telegram" className="danger" onClick={(e) => handleDelete(f, e)}><Trash2 size={13} /></button> : <button title="Удалить из альбома" className="danger" onClick={(e) => removeFile(f.messageId, e)}><X size={13} /></button>}
        </div>
      </div>
    )
  }

  if (openAlbum && currentAlbum) {
    const isSmart = !!SMART_ALBUMS.find(a => a.id === currentAlbum.id)
    const isDuplicates = SMART_ALBUMS.find(a => a.id === currentAlbum.id)?.isDuplicates
    return (
      <div className="v3-page">
        <div className="v3-row" style={{ marginBottom: 14 }}>
          <button className="v3-btn ghost" onClick={() => setOpenAlbum(null)}><ArrowLeft size={18} /></button>
          <h1 className="v3-h1" style={{ margin: 0 }}>{currentAlbum.name}</h1>
          <span className="v3-sub" style={{ marginLeft: 8 }}>{isDuplicates ? `${albumFiles.length} дубликатов` : albumFiles.length}</span>
        </div>
        <div className="mf-gallery-body">
          {isDuplicates ? (
            <div className="mf-gallery-body">
              {hashing ? (
                <div style={{ textAlign: 'center', padding: 60 }}>
                  <Loader2 size={32} className="spin" style={{ color: 'var(--accent)', marginBottom: 16 }} />
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Поиск дубликатов…</div>
                  <div className="v3-sub">{hashProgress.done} из {hashProgress.total} файлов</div>
                  <div style={{ width: 200, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 99, margin: '16px auto 0', overflow: 'hidden' }}>
                    <div style={{ width: hashProgress.total > 0 ? (hashProgress.done / hashProgress.total) * 100 : 0 + '%', height: '100%', background: 'var(--accent)', borderRadius: 99, transition: 'width 0.3s' }} />
                  </div>
                </div>
              ) : (() => {
                const groups: [string, any[]][] = []
                hashGroups.forEach((group, hash) => { if (group.length > 1) groups.push([hash, group]) })
                if (groups.length === 0) {
                  return (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <div className="v3-sub" style={{ marginBottom: 12 }}>Дубликаты ещё не найдены</div>
                      <button className="v3-btn primary" onClick={async () => {
                        setHashing(true)
                        setHashProgress({ done: 0, total: 0 })
                        const res = await window.electronAPI.bot.scanDuplicates()
                        if (res.success) {
                          const r = await window.electronAPI.bot.getHashDb()
                          if (r.success && r.data) {
                            for (const e of r.data) {
                              if (e.hash) v3store.setMeta({ messageId: e.messageId, hash: e.hash })
                            }
                            setHashTrigger(prev => prev + 1)
                          }
                        }
                        setHashing(false)
                      }}>Сканировать сейчас</button>
                    </div>
                  )
                }
                return groups.map(([hash, files]) => (
                  <div key={hash} className="mf-gy">
                    <div className="mf-gy-title">{files.length} дубликата</div>
                    <div className="mf-gm-items">{files.map((f: any) => renderCard(f, true, true))}</div>
                  </div>
                ))
              })()}
              <div ref={loaderRef} style={{ height: 20, flexShrink: 0 }} />
            </div>
          ) : (
            Object.entries(grouped).sort(([a], [b]) => +b - +a).map(([year, months]) => (
              <div key={year} className="mf-gy">
                <div className="mf-gy-title">{year}</div>
                {Object.entries(months).sort(([a], [b]) => +b - +a).map(([month, days]) => (
                  <div key={year + '-' + month} className="mf-gm">
                    <div className="mf-gm-month">{MONTHS_RU[+month]}</div>
                    {Object.entries(days).sort(([a], [b]) => +b - +a).map(([day, items]: [string, any]) => (
                      <div key={`${year}-${month}-${day}`} className="mf-gd">
                        <div className="mf-gd-title">{day} {MONTHS_RU[+month]} <span className="mf-gm-count">{items.length}</span></div>
                        <div className="mf-gm-items">{items.map(f => renderCard(f, isSmart))}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))
          )}
          <div ref={loaderRef} style={{ height: 20, flexShrink: 0 }} />
          {albumFiles.length === 0 && !hashing && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 22px', gap: 12 }}>
              {duckAnim ? (
                <Player autoplay loop src={duckAnim} style={{ width: 100, height: 100 }} />
              ) : (
                <div style={{ width: 100, height: 100, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36 }}>🐤</div>
              )}
              <span style={{ color: 'var(--text-dim)', fontSize: 14, fontWeight: 500 }}>Здесь пока никого…</span>
            </div>
          )}
        </div>

        {renameTarget && createPortal(
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }} onClick={() => setRenameTarget(null)}>
            <div className="v3-card" style={{ padding: 16, minWidth: 300 }} onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Переименовать</div>
              <input className="v3-input" value={renameInput} onChange={e => setRenameInput(e.target.value)} style={{ marginBottom: 10 }} autoFocus />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="v3-btn" onClick={() => setRenameTarget(null)}>Отмена</button>
                <button className="v3-btn primary" onClick={() => {
                  v3store.setMeta({ messageId: renameTarget.messageId, displayName: renameInput.trim() || undefined })
                  setRenameTarget(null); toast.success('Переименовано')
                  setAllFiles(prev => prev.map(f => f.messageId === renameTarget.messageId ? { ...f, fileName: renameInput.trim() || f.fileName } : f))
                }}>Сохранить</button>
              </div>
            </div>
          </div>, document.body
        )}

        {ctxMenu && createPortal(
          <div className="mf-ctx" style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }}>
            <button onClick={() => { handleCopyLink(ctxMenu.file); closeCtx() }}><Share2 size={14} /> Поделиться</button>
            <button onClick={() => { handleDownload(ctxMenu.file); closeCtx() }}><Download size={14} /> Скачать</button>
            <button onClick={(e) => { e.stopPropagation(); setShowSub(showSub === 'albums' ? null : 'albums') }}
              style={{ position: 'relative' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M21 9H3"/></svg> В альбом {showSub === 'albums' && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5 }}>‹</span>}
            </button>
            {showSub === 'albums' && (
              <>
                {v3store.getAlbums().length === 0 && (
                  <div style={{ paddingLeft: 36, fontSize: 11, color: 'var(--text-dim)' }}>Нет пользовательских альбомов</div>
                )}
                {v3store.getAlbums().map(a => {
                  const inAlbum = a.messageIds.includes(ctxMenu.file.messageId)
                  return (
                    <button key={a.id} onClick={() => {
                      if (inAlbum) v3store.removeFromAlbum(a.id, ctxMenu.file.messageId)
                      else v3store.addToAlbum(a.id, ctxMenu.file.messageId)
                      setAlbums(v3store.getAlbums())
                      toast.success(inAlbum ? 'Убрано из «' + a.name + '»' : 'Добавлено в «' + a.name + '»')
                      closeCtx()
                    }} style={{ paddingLeft: 36, fontSize: 12 }}>
                      <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center' }}>
                        {inAlbum ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg> : null}
                      </span>
                      {a.name}
                    </button>
                  )
                })}
              </>
            )}
            <button onClick={() => { const f = ctxMenu.file; setRenameInput(f.fileName); setRenameTarget(f); closeCtx() }}><Pencil size={14} /> Переименовать</button>
            <div className="mf-ctx-divider" />
            <button className="danger" onClick={(e) => { handleDelete(ctxMenu.file, e); closeCtx() }}><Trash2 size={14} /> Удалить</button>
          </div>, document.body
        )}
      </div>
    )
  }

  return (
    <div className="v3-page" data-testid="albums-page">
      <div className="v3-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="v3-h1" style={{ margin: 0 }}>Альбомы</h1>
          <div className="v3-sub">Автоматические и пользовательские альбомы.</div>
        </div>
        <button className="v3-btn primary" style={{ padding: 10, borderRadius: '50%' }} onClick={() => setShowCreateModal(true)}><Plus size={20} /></button>
      </div>
      <div className="v3-card" style={{ marginTop: 18 }}>
        <div className="v3-sub" style={{ marginBottom: 12 }}>Системные альбомы</div>
        <div className="v3-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
          {SMART_ALBUMS.map(sa => {
            let count = 0
            if (sa.isDuplicates) {
              hashGroups.forEach(group => { if (group.length > 1) count += group.length })
            } else if (sa.filter) count = allFiles.filter(sa.filter).length
            return (
              <div key={sa.id} className="v3-card" style={{ padding: 14, cursor: 'pointer' }} onClick={() => setOpenAlbum(sa.id)}>
                <div className="v3-row">{sa.id === '_photos' ? <Image size={18} /> : sa.id === '_videos' ? <Film size={18} /> : sa.id === '_screenshots' ? <Camera size={18} /> : <Copy size={18} />}<div style={{ flex: 1, fontWeight: 600, marginLeft: 8 }}>{sa.name}</div></div>
                <div className="v3-sub v3-num" style={{ marginLeft: 38 }}>{count > 0 ? `${count} файлов` : '—'}</div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="v3-card" style={{ marginTop: 18 }}>
        <div className="v3-sub" style={{ marginBottom: 12 }}>Мои альбомы</div>
        {albums.length === 0 ? (
          <div className="v3-sub" style={{ padding: 20, textAlign: 'center' }}>Нет альбомов. Создайте первый!</div>
        ) : (
          <div className="v3-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            {albums.map(a => (
              <div key={a.id} className="v3-card" style={{ padding: 14, cursor: 'pointer' }} onClick={() => setOpenAlbum(a.id)}>
                <div className="v3-row"><Image size={18} /><div style={{ flex: 1, fontWeight: 600, marginLeft: 8 }}>{a.name}</div>
                  <button className="v3-btn ghost" style={{ padding: 4 }} onClick={(e) => { e.stopPropagation(); removeAlbum(a.id) }}><Trash2 size={14} /></button>
                </div>
                <div className="v3-sub v3-num" style={{ marginLeft: 38 }}>{a.messageIds.length} файлов · {new Date(a.createdAt).toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreateModal && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }} onClick={() => setShowCreateModal(false)}>
          <div className="v3-card" style={{ padding: 16, minWidth: 260 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Название альбома</div>
            <input className="v3-input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Введите название" style={{ marginBottom: 10 }} autoFocus onKeyDown={e => e.key === 'Enter' && createAlbum()} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="v3-btn" onClick={() => setShowCreateModal(false)}>Отмена</button>
              <button className="v3-btn primary" onClick={createAlbum}>Ок</button>
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  )
}
