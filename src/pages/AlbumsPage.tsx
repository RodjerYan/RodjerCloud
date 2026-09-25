import React, { useEffect, useState, useMemo, useCallback, useRef } from "react"
import { VirtuosoGrid } from 'react-virtuoso'
import { createPortal, flushSync } from 'react-dom'
import confetti from 'canvas-confetti'
import { Image, Film, Camera, Copy, Plus, Trash2, Download, Eye, X, ArrowLeft, Loader2, Share2, MoveRight, Pencil, Play, CheckSquare, Square, ShieldCheck, Layers, ArrowDownUp, Info } from "lucide-react"
import { fmtSize } from '../lib/utils'
import { v3store } from "../lib/v3store"
import { SMART_ALBUMS, type SmartAlbum } from "../lib/albums"
import { Player } from '@lottiefiles/react-lottie-player'
import { appConfirm } from "../lib/dialogs"
import { toast } from '../lib/toast'
import { downloadFileWithFeedback } from '../lib/download'
import { safeViewTransition } from '../lib/viewTransition'
import { BulkProgressModal } from '../components/BulkProgressModal'
import '../styles/duplicate-modal.css'

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const DUP_PAGE_SIZE = 20
const SCROLL_THRESHOLD = 600

import { fileDate, groupByDay } from '../lib/utils'
import { FileThumb } from '../components/FileThumb'

export default function AlbumsPage() {
  const [allFiles, setAllFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [albums, setAlbums] = useState(v3store.getAlbums())
  const [newName, setNewName] = useState('')
  const [openAlbum, setOpenAlbum] = useState<string | null>(null)
  const [hashing, setHashing] = useState(false)
  const [hashProgress, setHashProgress] = useState({ done: 0, total: 0, sourceTotal: 0, mediaTotal: 0 })
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: any } | null>(null)
  const [renameTarget, setRenameTarget] = useState<any>(null)
  const [renameInput, setRenameInput] = useState('')
  const [showSub, setShowSub] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [duckAnim, setDuckAnim] = useState<any>(null)
  const [hashTrigger, setHashTrigger] = useState(0)
  const [selectedDupIds, setSelectedDupIds] = useState<Set<number>>(new Set())
  const [dupProgress, setDupProgress] = useState<{ title: string; items: any[]; current: number; total: number; visible: boolean; onClose: () => void } | null>(null)
  const [keepStrategy, setKeepStrategy] = useState<'oldest' | 'newest'>('oldest')
  const [visibleDupCount, setVisibleDupCount] = useState(DUP_PAGE_SIZE)
  const [visibleAlbumCount, setVisibleAlbumCount] = useState(DUP_PAGE_SIZE)

  const loaderRef = useRef<HTMLDivElement>(null)
  const albumLoaderRef = useRef<HTMLDivElement>(null)
  const dupScrollRafRef = useRef(0)
  const albumScrollRafRef = useRef(0)

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

  const computeHashes = useCallback(async (files: any[], force = false) => {
    let source = files
    if (source.length === 0) {
      const r = await window.electronAPI.telegram.listFiles()
      if (r?.success && r.data) { source = r.data; setAllFiles(r.data) }
    }
    const mediaFiles = source.filter(f => f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/'))
    const dupKey = (f: any) => `${(f.fileName || '').toLowerCase()}:${f.fileSize || 0}`
    const keyCount = new Map<string, number>()
    for (const f of mediaFiles) {
      const k = dupKey(f)
      keyCount.set(k, (keyCount.get(k) || 0) + 1)
    }
    const candidates: any[] = []
    for (const f of mediaFiles) {
      if ((keyCount.get(dupKey(f)) || 0) < 2) continue
      if (!force) {
        const existing = v3store.metaFor(f.messageId)
        if (existing?.hash?.includes(':')) continue
      }
      candidates.push(f)
    }
    const total = candidates.length
    const sourceTotal = source.length
    const mediaTotal = mediaFiles.length
    if (total === 0) {
      setHashing(false)
      setHashTrigger(prev => prev + 1)
      if (force) toast.info('Нет файлов с совпадающими именем и размером — сравнивать нечего')
      return
    }
    setHashProgress({ done: 0, total, sourceTotal, mediaTotal }); setHashing(true)
    let done = 0
    let idx = 0
    const CONCURRENCY = 4
    const worker = async () => {
      while (idx < candidates.length) {
        const i = idx++
        const f = candidates[i]
        try {
          const r = await window.electronAPI.file.computeHash(f.messageId)
          if (r.success && r.data) v3store.setMeta({ messageId: f.messageId, hash: r.data })
        } catch {}
        done++
        if (done === total || done % 8 === 0) {
          setHashProgress(prev => ({ ...prev, done }))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()))
    setHashProgress(prev => ({ ...prev, done: total }))
    setHashing(false); setAlbums(v3store.getAlbums()); setHashTrigger(prev => prev + 1)
  }, [])

  const hashGroups = useMemo(() => {
    const groups = new Map<string, any[]>()
    const metaById = new Map<number, string>()
    v3store.getMeta().forEach(m => { if (m.hash) metaById.set(m.messageId, m.hash) })
    allFiles.filter(f => f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/')).forEach(f => {
      const hash = metaById.get(f.messageId)
      if (!hash) return
      const key = `${(f.fileName || '').toLowerCase()}:${hash}`
      const g = groups.get(key) || []
      g.push(f)
      groups.set(key, g)
    })
    return groups
  }, [allFiles, hashTrigger])

  const dupGroupList = useMemo(() => {
    const list: [string, any[]][] = []
    hashGroups.forEach((group, key) => { if (group.length > 1) list.push([key, group]) })
    list.sort((a, b) => {
      const sa = (a[1][0]?.fileSize || 0) * (a[1].length - 1)
      const sb = (b[1][0]?.fileSize || 0) * (b[1].length - 1)
      if (sb !== sa) return sb - sa
      return b[1].length - a[1].length
    })
    return list
  }, [hashGroups])

  const sortGroupByStrategy = useCallback((files: any[]) => {
    const sorted = [...files].sort((a, b) => a.messageId - b.messageId)
    return keepStrategy === 'oldest' ? sorted : sorted.slice().reverse()
  }, [keepStrategy])

  const keepIdForGroup = useCallback((files: any[]) => {
    const sorted = [...files].sort((a, b) => a.messageId - b.messageId)
    return keepStrategy === 'oldest' ? sorted[0]?.messageId : sorted[sorted.length - 1]?.messageId
  }, [keepStrategy])

  const dupStats = useMemo(() => {
    let files = 0, reclaimable = 0, keepBytes = 0
    for (const [, g] of dupGroupList) {
      files += g.length
      const sorted = [...g].sort((a, b) => a.messageId - b.messageId)
      const drop = keepStrategy === 'oldest' ? sorted.slice(1) : sorted.slice(0, -1)
      const keep = keepStrategy === 'oldest' ? sorted[0] : sorted[sorted.length - 1]
      keepBytes += keep?.fileSize || 0
      for (const f of drop) reclaimable += f.fileSize || 0
    }
    return { groups: dupGroupList.length, files, reclaimable, keepBytes }
  }, [dupGroupList, keepStrategy])

  const selectedSize = useMemo(
    () => allFiles.filter(f => selectedDupIds.has(f.messageId)).reduce((s, f) => s + (f.fileSize || 0), 0),
    [allFiles, selectedDupIds]
  )

  useEffect(() => {
    setSelectedDupIds(new Set())
    setVisibleDupCount(DUP_PAGE_SIZE)
    setVisibleAlbumCount(DUP_PAGE_SIZE)
  }, [openAlbum, hashTrigger])

  const visibleDupGroups = useMemo(
    () => dupGroupList.slice(0, visibleDupCount),
    [dupGroupList, visibleDupCount]
  )

  const isDuplicatesView = !!(openAlbum && SMART_ALBUMS.find(a => a.id === openAlbum)?.isDuplicates)

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

  const sortedAlbumFiles = useMemo(
    () => [...albumFiles].sort((a, b) => (fileDate(b) - fileDate(a)) || (b.messageId - a.messageId)),
    [albumFiles]
  )
  const visibleAlbumFiles = useMemo(
    () => sortedAlbumFiles.slice(0, visibleAlbumCount),
    [sortedAlbumFiles, visibleAlbumCount]
  )
  const grouped = useMemo(() => groupByDay(visibleAlbumFiles), [visibleAlbumFiles])

  useEffect(() => {
    if (isDuplicatesView) return
    const container = document.querySelector('.v2-main')
    if (!container) return
    const handleScroll = () => {
      if (albumScrollRafRef.current) return
      const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      if (distanceToBottom >= SCROLL_THRESHOLD) return
      if (visibleAlbumCount >= sortedAlbumFiles.length) return
      albumScrollRafRef.current = requestAnimationFrame(() => {
        albumScrollRafRef.current = 0
        setVisibleAlbumCount(prev => Math.min(prev + DUP_PAGE_SIZE, sortedAlbumFiles.length))
      })
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (albumScrollRafRef.current) {
        cancelAnimationFrame(albumScrollRafRef.current)
        albumScrollRafRef.current = 0
      }
    }
  }, [isDuplicatesView, visibleAlbumCount, sortedAlbumFiles.length])

  useEffect(() => {
    if (isDuplicatesView) return
    const el = albumLoaderRef.current
    if (!el || visibleAlbumCount >= sortedAlbumFiles.length) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setVisibleAlbumCount(prev => Math.min(prev + DUP_PAGE_SIZE, sortedAlbumFiles.length))
      }
    }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [isDuplicatesView, visibleAlbumCount, sortedAlbumFiles.length])

  useEffect(() => {
    if (!isDuplicatesView) return
    const container = document.querySelector('.v2-main')
    if (!container) return
    const handleScroll = () => {
      if (dupScrollRafRef.current) return
      const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      if (distanceToBottom >= SCROLL_THRESHOLD) return
      if (visibleDupCount >= dupGroupList.length) return
      dupScrollRafRef.current = requestAnimationFrame(() => {
        dupScrollRafRef.current = 0
        setVisibleDupCount(prev => Math.min(prev + DUP_PAGE_SIZE, dupGroupList.length))
      })
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (dupScrollRafRef.current) {
        cancelAnimationFrame(dupScrollRafRef.current)
        dupScrollRafRef.current = 0
      }
    }
  }, [isDuplicatesView, visibleDupCount, dupGroupList.length])

  useEffect(() => {
    if (!isDuplicatesView) return
    const el = loaderRef.current
    if (!el || visibleDupCount >= dupGroupList.length) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setVisibleDupCount(prev => Math.min(prev + DUP_PAGE_SIZE, dupGroupList.length))
      }
    }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [isDuplicatesView, visibleDupCount, dupGroupList.length])

  const toggleDupSel = (id: number) => {
    setSelectedDupIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  const idsToDrop = useCallback((files: any[]) => {
    const sorted = sortGroupByStrategy(files)
    return sorted.slice(1).map((f: any) => f.messageId)
  }, [sortGroupByStrategy])

  const selectDuplicatesOnly = () => {
    const n = new Set<number>()
    for (const [, g] of dupGroupList) {
      for (const id of idsToDrop(g)) n.add(id)
    }
    setSelectedDupIds(n)
    toast.success(`Выбрано ${n.size} дубликатов · оригинал сохраняется (${keepStrategy === 'oldest' ? 'более старые' : 'более новые'})`)
  }

  const clearSelection = () => setSelectedDupIds(new Set())

  const bulkDeleteDups = async (ids: number[], title: string) => {
    if (ids.length === 0) return
    const selectedFiles = allFiles.filter(f => ids.includes(f.messageId))
    const space = selectedFiles.reduce((s, f) => s + (f.fileSize || 0), 0)
    const ok = await appConfirm(
      `${title}\n\n` +
      `Файлов: ${ids.length}\n` +
      `Освободится: ${fmtSize(space)}\n` +
      `Файлы уйдут в корзину Telegram и их можно восстановить.\n` +
      `В каждой группе останется хотя бы один оригинал.`
    )
    if (!ok) return

    const items = selectedFiles.map(f => ({ name: f.fileName, status: 'pending' as const }))
    setDupProgress({ title, items, current: 0, total: ids.length, visible: true, onClose: () => setDupProgress(null) })
    setSelectedDupIds(new Set())

    const onProgress = (data: { kind: string; index: number; total: number }) => {
      if (data.kind !== 'delete') return
      setDupProgress(prev => {
        if (!prev) return prev
        const newItems = prev.items.map((it, i) => {
          if (i < data.index) return { ...it, status: 'done' as const }
          if (i === data.index - 1) return { ...it, status: 'done' as const }
          if (i === data.index) return { ...it, status: 'active' as const }
          return it
        })
        return { ...prev, items: newItems, current: data.index }
      })
      if (data.index >= 1 && data.index <= ids.length) {
        const fid = ids[data.index - 1]
        setAllFiles(prev => prev.filter(x => x.messageId !== fid))
      }
    }
    const unsub = window.electronAPI.telegram.onBulkProgress(onProgress)
    try {
      const r = await window.electronAPI.telegram.bulkDelete(ids)
      unsub()
      if (r.success) {
        setDupProgress(prev => prev ? { ...prev, items: prev.items.map(it => ({ ...it, status: 'done' as const })), current: prev.total } : prev)
        toast.success(`Удалено ${ids.length} · освобождено ${fmtSize(space)}`)
      } else {
        toast.error(r.error || 'Ошибка удаления')
        setDupProgress(prev => prev ? { ...prev, current: prev.total } : prev)
      }
    } catch {
      unsub()
      toast.error('Ошибка удаления')
      setDupProgress(prev => prev ? { ...prev, current: prev.total } : prev)
    }
    setHashTrigger(prev => prev + 1)
  }

  const deleteAllDupsKeepOne = () => {
    const ids: number[] = []
    for (const [, g] of dupGroupList) ids.push(...idsToDrop(g))
    if (ids.length === 0) return
    void bulkDeleteDups(ids, 'Удалить все дубликаты')
  }

  useEffect(() => {
    if (openAlbum) {
      window.electronAPI.telegram.listFiles().then((r: any) => { if (r?.success) setAllFiles(r.data || []) })
      const isDuplicates = SMART_ALBUMS.find(a => a.id === openAlbum)?.isDuplicates
      if (isDuplicates) {
        window.electronAPI.bot.getHashDb().then((r: any) => {
          if (r?.success && r?.data) {
            for (const e of r.data) {
              if (e.hash) v3store.setMeta({ messageId: e.messageId, hash: e.hash })
            }
            setHashTrigger(prev => prev + 1)
          }
        }).catch(() => {})
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

    safeViewTransition(applyRemove)
  }

  // T-20260925-002 S1: общий feedback-скачивание (эталон MyFiles)
  const handleDownload = (f: any, e?: React.MouseEvent) => downloadFileWithFeedback(f, e)

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

    setDupProgress({ title: 'Перемещение в корзину', items: [{ name: f.fileName, status: 'active' as const }], current: 0, total: 1, visible: true, onClose: () => setDupProgress(null) })

    const applyRemove = () => {
      flushSync(() => {
        setAllFiles(prev => prev.filter(x => x.messageId !== f.messageId))
      })
    }

    safeViewTransition(applyRemove)

    const r = await window.electronAPI.telegram.deleteFile(f.messageId)
    if (r.success) {
      setDupProgress(prev => prev ? { ...prev, items: [{ name: f.fileName, status: 'done' as const }], current: 1 } : prev)
      toast.success('Перемещено в корзину')
    } else {
      toast.error('Ошибка удаления')
      const revert = () => {
        flushSync(() => {
          setAllFiles(prev => [...prev, f].sort((a, b) => (b.messageId - a.messageId)))
        })
      }
      safeViewTransition(revert)
      setDupProgress(prev => prev ? { ...prev, items: [{ name: f.fileName, status: 'error' as const }], current: 1 } : prev)
    }
  }

  const handlePreview = async (f: any) => {
    // T-20260924-019 S3: тот же preview:open IPC; защита от idx=-1 (иначе main
    // вернёт {success:false} молча) — fallback по messageId + явная ошибка.
    let idx = albumFiles.indexOf(f)
    if (idx === -1) idx = albumFiles.findIndex((x: any) => x?.messageId === f.messageId)
    if (idx === -1) {
      toast.error('Не удалось открыть предпросмотр: файл не найден в списке')
      return
    }
    try {
      const r = await window.electronAPI.preview.open(albumFiles, idx)
      if (!r?.success) toast.error(r?.error || 'Не удалось открыть предпросмотр')
    } catch (e: any) {
      toast.error('Не удалось открыть предпросмотр: ' + (e?.message || ''))
    }
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
          <button title="Скачать" onClick={(e) => handleDownload(f, e)}><Download size={13} /></button>
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
          <span className="v3-sub" style={{ marginLeft: 8 }}>
            {isDuplicates
              ? (dupGroupList.length
                  ? `${dupStats.groups} групп · ${dupStats.files} файлов · −${fmtSize(dupStats.reclaimable)}`
                  : hashing ? 'поиск…' : 'проверка…')
              : albumFiles.length}
          </span>
        </div>
        {isDuplicates && (
          <div className="dup-toolbar">
            <div className="dup-kpi">
              <div className="dup-kpi-item">
                <span className="dup-kpi-value">{dupGroupList.length}</span>
                <span className="dup-kpi-label">групп</span>
              </div>
              <div className="dup-kpi-item">
                <span className="dup-kpi-value">{dupStats.files}</span>
                <span className="dup-kpi-label">файлов</span>
              </div>
              <div className="dup-kpi-item dup-kpi-save">
                <span className="dup-kpi-value">{fmtSize(dupStats.reclaimable)}</span>
                <span className="dup-kpi-label">можно освободить</span>
              </div>
              <div className="dup-kpi-item">
                <span className="dup-kpi-value">{selectedDupIds.size}</span>
                <span className="dup-kpi-label">выбрано · {fmtSize(selectedSize)}</span>
              </div>
            </div>

            <div className="dup-controls">
              <label className="dup-strategy" title="Какой файл оставить оригиналом в каждой группе">
                <ArrowDownUp size={14} aria-hidden />
                <span>Оригинал</span>
                <select
                  value={keepStrategy}
                  onChange={e => setKeepStrategy(e.target.value as 'oldest' | 'newest')}
                  aria-label="Стратегия сохранения оригинала"
                >
                  <option value="oldest">Более старые</option>
                  <option value="newest">Более новые</option>
                </select>
              </label>

              <div className="dup-criteria" title="Условия: одинаковые имя + размер + SHA-256 содержимого">
                <Info size={13} aria-hidden />
                <span>имя + размер + хеш</span>
              </div>

              <div className="dup-actions">
                <button
                  className="v3-btn"
                  disabled={hashing || dupGroupList.length === 0}
                  onClick={selectDuplicatesOnly}
                >
                  <CheckSquare size={14} /> Выбрать дубликаты
                </button>
                <button
                  className="v3-btn"
                  disabled={selectedDupIds.size === 0}
                  onClick={clearSelection}
                >
                  <Square size={14} /> Снять
                </button>
                <button
                  className="v3-btn"
                  disabled={hashing}
                  onClick={() => { toast.info('Запуск сканирования…'); computeHashes(allFiles, true) }}
                >
                  <Layers size={14} /> {hashing ? 'Сканирование…' : 'Сканировать'}
                </button>
                <button
                  className="v3-btn danger dup-btn-bulk"
                  disabled={hashing || dupGroupList.length === 0}
                  onClick={deleteAllDupsKeepOne}
                  title="В каждой группе останется один оригинал, остальные — в корзину"
                >
                  <Trash2 size={14} /> Удалить все дубликаты
                </button>
              </div>
            </div>

            {selectedDupIds.size > 0 && (
              <div className="mf-bulkbar dup-bulkbar" role="toolbar" aria-label="Массовые действия">
                <span>
                  Выбрано <b>{selectedDupIds.size}</b> · {fmtSize(selectedSize)}
                </span>
                <button onClick={clearSelection} type="button">
                  <Square size={14} /> Снять выделение
                </button>
                <button
                  className="danger"
                  type="button"
                  onClick={() => void bulkDeleteDups(Array.from(selectedDupIds), 'Удалить выбранные')}
                >
                  <Trash2 size={14} /> Удалить выбранные
                </button>
              </div>
            )}
          </div>
        )}
        <div className="mf-gallery-body">
          {isDuplicates ? (
            <>
              {hashing ? (
                <div style={{ textAlign: 'center', padding: 60 }}>
                  <Loader2 size={32} className="spin" style={{ color: 'var(--accent)', marginBottom: 16 }} />
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Поиск дубликатов…</div>
                  <div className="v3-sub">
                    {hashProgress.done} из {hashProgress.total} кандидатов (совпадают имя и размер)
                  </div>
                  <div className="v3-sub" style={{ marginTop: 4, opacity: 0.7 }}>
                    Всего файлов: {hashProgress.sourceTotal || allFiles.length}
                    {hashProgress.mediaTotal > 0 ? ` · медиа: ${hashProgress.mediaTotal}` : ''}
                  </div>
                  <div className="v3-sub" style={{ marginTop: 4, opacity: 0.7 }}>
                    Хеш подтверждает содержимое
                  </div>
                  <div style={{ width: 200, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 99, margin: '16px auto 0', overflow: 'hidden' }}>
                    <div style={{ width: hashProgress.total > 0 ? (hashProgress.done / hashProgress.total) * 100 : 0 + '%', height: '100%', background: 'var(--accent)', borderRadius: 99, transition: 'width 0.3s' }} />
                  </div>
                </div>
              ) : dupGroupList.length === 0 ? (
                <div className="dup-empty" role="status">
                  <div className="dup-empty-icon">
                    <ShieldCheck size={28} aria-hidden />
                  </div>
                  <div className="dup-empty-title">Дубликаты не найдены</div>
                  <div className="dup-empty-sub">
                    Совпадают имя, размер и хеш содержимого.
                    <br />Запустите сканирование, если добавляли файлы.
                  </div>
                  <button className="v3-btn primary" onClick={() => { toast.info('Запуск сканирования…'); computeHashes(allFiles, true) }}>
                    Сканировать сейчас
                  </button>
                </div>
              ) : (
                <>
                  <div className="dup-section-head">
                    <span>Группы дубликатов · сортировка по экономии</span>
                    <span className="dup-section-meta">
                      Оригинал: {keepStrategy === 'oldest' ? 'более старые' : 'более новые'}
                    </span>
                  </div>
                  {visibleDupGroups.map(([key, files]) => {
                    const name = files[0]?.fileName || key
                    const keepId = keepIdForGroup(files)
                    const dropIds = new Set(idsToDrop(files))
                    const groupSel = files.filter(f => selectedDupIds.has(f.messageId)).length
                    const groupReclaim = files.filter(f => dropIds.has(f.messageId)).reduce((s, f) => s + (f.fileSize || 0), 0)
                    const ordered = [
                      ...files.filter(f => f.messageId === keepId),
                      ...files.filter(f => f.messageId !== keepId),
                    ]
                    return (
                      <section key={key} className="mf-gy dup-group" aria-label={`Группа дубликатов ${name}`}>
                        <header className="dup-group-head">
                          <div className="dup-group-title">
                            <span className="dup-group-name" title={name}>{name}</span>
                            <span className="dup-group-badge">{files.length}×</span>
                            <span className="dup-group-meta">
                              {fmtSize(files[0]?.fileSize || 0)} · к удалению −{fmtSize(groupReclaim)}
                            </span>
                          </div>
                          <div className="dup-group-actions">
                            <button
                              className="v3-btn"
                              type="button"
                              onClick={() => {
                                const n = new Set(selectedDupIds)
                                const allDropSelected = [...dropIds].every(id => n.has(id))
                                if (allDropSelected) dropIds.forEach(id => n.delete(id))
                                else dropIds.forEach(id => n.add(id))
                                setSelectedDupIds(n)
                              }}
                              title="Отметить только дубликаты (оригинал не трогается)"
                            >
                              <CheckSquare size={13} />
                              {(() => {
                                const allDrop = [...dropIds].length > 0 && [...dropIds].every(id => selectedDupIds.has(id))
                                return allDrop ? 'Снять дубликаты' : 'Выбрать дубликаты'
                              })()}
                            </button>
                            <button
                              className="v3-btn"
                              type="button"
                              onClick={() => {
                                const n = new Set(selectedDupIds)
                                if (groupSel === files.length) files.forEach(f => n.delete(f.messageId))
                                else files.forEach(f => n.add(f.messageId))
                                setSelectedDupIds(n)
                              }}
                            >
                              {groupSel === files.length ? <Square size={13} /> : <CheckSquare size={13} />}
                              {groupSel === files.length ? 'Снять все' : 'Все в группе'}
                            </button>
                            <button
                              className="v3-btn danger"
                              type="button"
                              disabled={groupSel === 0}
                              onClick={() => void bulkDeleteDups(files.filter(f => selectedDupIds.has(f.messageId)).map(f => f.messageId), 'Удалить из группы')}
                            >
                              <Trash2 size={13} /> Удалить ({groupSel})
                            </button>
                          </div>
                        </header>
                        <div className="mf-gm-items dup-items">
                          {ordered.map((f: any) => {
                            const isKeep = f.messageId === keepId
                            const isSelected = selectedDupIds.has(f.messageId)
                            const isVid = f.mimeType?.startsWith('video/')
                            return (
                              <article
                                key={f.messageId}
                                className={`mf-gm-card${isSelected ? ' selected' : ''}${isKeep ? ' dup-keep' : ''}`}
                                style={{ viewTransitionName: `card_${f.messageId}` }}
                                onClick={() => toggleDupSel(f.messageId)}
                                onDoubleClick={() => handlePreview(f)}
                                role="checkbox"
                                aria-checked={isSelected}
                                aria-label={`${f.fileName}${isKeep ? ', оригинал' : ', дубликат'}`}
                                tabIndex={0}
                                onKeyDown={e => {
                                  if (e.key === ' ' || e.key === 'Enter') {
                                    e.preventDefault()
                                    toggleDupSel(f.messageId)
                                  }
                                }}
                              >
                                <label className="mf-check dup-check" onClick={e => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleDupSel(f.messageId)}
                                    aria-label={`Выбрать ${f.fileName}`}
                                  />
                                </label>
                                <span className={`dup-keep-badge${isKeep ? ' is-keep' : ' is-dup'}`}>
                                  {isKeep ? 'Оригинал' : 'Дубликат'}
                                </span>
                                <div className="mf-gm-icon" data-type={isVid ? 'Видео' : 'Изображения'}>
                                  <FileThumb messageId={f.messageId} fileName={f.fileName} isVideo={isVid} typeLabel={isVid ? 'Видео' : 'Изображения'} />
                                </div>
                                <div className="mf-gm-name" title={f.fileName}>{f.fileName}</div>
                                <div className="mf-gm-meta">
                                  {fmtSize(f.fileSize)}
                                  <span className="dup-msg"> · #{f.messageId}</span>
                                </div>
                                <div className="mf-gm-actions" onClick={e => e.stopPropagation()}>
                                  <button title="Скачать" type="button" onClick={(e) => handleDownload(f, e)}><Download size={13} /></button>
                                  <button title="Просмотр" type="button" onClick={() => handlePreview(f)}><Eye size={13} /></button>
                                  <button title="Удалить в корзину" className="danger" type="button" onClick={(e) => handleDelete(f, e)}><Trash2 size={13} /></button>
                                </div>
                              </article>
                            )
                          })}
                        </div>
                      </section>
                    )
                  })}
                </>
              )}
              {visibleDupCount < dupGroupList.length && (
                <div className="dup-load-more" role="status">
                  <Loader2 size={16} className="spin" aria-hidden />
                  <span>Показано {visibleDupCount} из {dupGroupList.length} групп · прокрутите ниже</span>
                </div>
              )}
              <div ref={loaderRef} style={{ height: 20, flexShrink: 0 }} />
            </>
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
                        <div className="mf-gm-items">{items.map((f: any) => renderCard(f, isSmart))}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))
          )}
          {!isDuplicates && visibleAlbumCount < sortedAlbumFiles.length && (
            <div className="dup-load-more" role="status">
              <Loader2 size={16} className="spin" aria-hidden />
              <span>Показано {visibleAlbumCount} из {sortedAlbumFiles.length} файлов · прокрутите ниже</span>
            </div>
          )}
          {!isDuplicates && <div ref={albumLoaderRef} style={{ height: 20, flexShrink: 0 }} />}
          {albumFiles.length === 0 && !hashing && !isDuplicates && (
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

        {dupProgress && (
          <BulkProgressModal
            title={dupProgress.title}
            items={dupProgress.items}
            current={dupProgress.current}
            total={dupProgress.total}
            visible={dupProgress.visible}
            onClose={dupProgress.onClose}
          />
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
