import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import confetti from 'canvas-confetti'
import { createPortal, flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {   Search, Grid, List as ListIcon, Download, Trash2, Copy, Eye, X, ChevronLeft, ChevronRight, ChevronDown, ArrowLeft, Play, Star,
  Image, Film, Music, FileText, Archive, Folder, Clock, FolderPlus, MoveRight, Pencil, Share2, Upload, AlertCircle, Check, UploadCloud, MoreHorizontal } from 'lucide-react'
import { v3store } from '../lib/v3store'
import { SMART_ALBUMS } from '../lib/albums'
import { Player } from '@lottiefiles/react-lottie-player'
import { appConfirm, appAlert } from '../lib/dialogs'
import { toast } from '../lib/toast'
import { fmtSize, typeOf as _typeOf, fileDate, groupByDay } from '../lib/utils'
const CHUNK_SIZE = Math.floor(1.95 * 1024 * 1024 * 1024)
import { FileThumb } from '../components/FileThumb'
import { TiltCard } from '../components/TiltCard'
import { BulkProgressModal } from '../components/BulkProgressModal'
import { safeViewTransition } from '../lib/viewTransition'
import '../styles/duplicate-modal.css'

function typeOf(name: string): string {
  const t = _typeOf(name)
  if (t === 'image') return 'Изображения'
  if (t === 'video') return 'Видео'
  if (t === 'audio') return 'Аудио'
  if (t === 'document') return 'Документы'
  if (t === 'archive') return 'Архивы'
  return 'Другое'
}

const FILES_PAGE_SIZE = 30
const SCROLL_THRESHOLD = 600
const RECENT_WINDOW_SEC = 6 * 3600

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

const CATEGORIES = ['Изображения', 'Видео', 'Аудио', 'Документы', 'Архивы', 'Другое', 'Недавние'] as const
const CAT_ICON: Record<string, React.ReactNode> = {
  Недавние: <Clock size={18} className="mf-cat-anim" style={{ color: '#fbbf24' }} />,
  Изображения: <Image size={18} className="mf-cat-anim" style={{ color: '#a78bfa' }} />,
  Видео: <Film size={18} className="mf-cat-anim" style={{ color: '#f472b6' }} />,
  Документы: <FileText size={18} className="mf-cat-anim" style={{ color: '#60a5fa' }} />,
  Архивы: <Archive size={18} className="mf-cat-anim" style={{ color: '#fb923c' }} />,
  Аудио: <Music size={18} className="mf-cat-anim" style={{ color: '#34d399' }} />,
  Другое: <Folder size={18} className="mf-cat-anim" style={{ color: '#94a3b8' }} />,
}
const CAT_COLOR: Record<string, string> = {
  Недавние: '#fbbf24', Изображения: '#a78bfa', Видео: '#f472b6', Документы: '#60a5fa', Архивы: '#fb923c', Аудио: '#34d399', Другое: '#94a3b8',
}
import { pendingStore, type PendingUpload } from '../lib/PendingUploadStore'

const matchVirtualFolder = (fileName: string, folderId: string) => {
  if (folderId === '__type_Изображения') return !!fileName.match(/\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|svg|avif)$/i)
  if (folderId === '__type_Видео') return !!fileName.match(/\.(mp4|mov|avi|mkv|webm|flv)$/i)
  if (folderId === '__type_Аудио') return !!fileName.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)
  if (folderId === '__type_Документы') return !!fileName.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|rtf|csv|djvu|epub|fb2)$/i)
  if (folderId === '__type_Архивы') return !!fileName.match(/\.(zip|rar|7z|tar|gz)$/i)
  return false
}

export default function MyFilesPage() {
  const navigate = useNavigate()
  const [favs, setFavs] = useState<any[]>([])

  const [files, setFiles] = useState<any[]>([])
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  const [visibleCount, setVisibleCount] = useState(FILES_PAGE_SIZE)
  const locallyDeletedIds = useRef<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const nextOffsetIdRef = useRef<number | null>(null)
  const totalFilesRef = useRef<number>(0)
  const filesLenRef = useRef<number>(0)
  useEffect(() => { filesLenRef.current = files.length }, [files])
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'name' | 'size' | 'date'>('date')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<{ idx: number; list: any[] } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [previewIsVideo, setPreviewIsVideo] = useState(false)
  const [drillDown, setDrillDown] = useState<string | null>(null)
  const [drillFiles, setDrillFiles] = useState<any[]>([])
  const [drillLoading, setDrillLoading] = useState(false)
  const [expandedCatFiles, setExpandedCatFiles] = useState<Record<string, any[]>>({})
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())
  const [progressModal, setProgressModal] = useState<{ title: string; items: { name: string; status: 'pending' | 'active' | 'done' | 'error' }[]; current: number; total: number; visible: boolean; onClose?: () => void } | null>(null)
  const [folders, setFolders] = useState<any[]>([])
  const [fileFolders, setFileFolders] = useState<Record<number, string>>({})
  const [folderDrill, setFolderDrill] = useState<string | null>(null)
  const [folderFiles, setFolderFiles] = useState<any[]>([])
  const folderNextOffsetIdRef = useRef<number | null>(null)
  const [folderTotal, setFolderTotal] = useState(0)
  const [folderLoading, setFolderLoading] = useState(false)
  const [folderLoadingMore, setFolderLoadingMore] = useState(false)
  const folderLoadingMoreRef = useRef(false)
  const folderRequestIdRef = useRef(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const searchRequestIdRef = useRef(0)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [moveTarget, setMoveTarget] = useState<number[] | null>(null)
  const [duckAnim, setDuckAnim] = useState<any>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file?: any; folder?: any; type?: 'global' } | null>(null)
  const closeCtx = useCallback(() => { setCtxMenu(null); setShowSub(null) }, [])
  const [botToken, setBotToken] = useState('')
  const [botConfigured, setBotConfigured] = useState(false)
  const [shareProgress, setShareProgress] = useState<'generating' | 'done' | null>(null)
  const [renameTarget, setRenameTarget] = useState<any>(null)
  const [renameInput, setRenameInput] = useState('')
  const [showSub, setShowSub] = useState<string | null>(null)

  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null)
  const isSelecting = useRef(false)
  const selectionStart = useRef<{ x: number, y: number, scrollY: number } | null>(null)
  const selectedRef = useRef(selected)
  const initialSelectedOnDrag = useRef<Set<number>>(new Set())
  const elementRectsRef = useRef<Map<Element, DOMRect>>(new Map())
  const rafRef = useRef<number>(0)
  const filesChangedDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { selectedRef.current = selected }, [selected])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isSelecting.current || !selectionStart.current) return
      
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        const container = document.querySelector('.v2-main')
        const currentScroll = container ? container.scrollTop : 0
        const scrollDiff = currentScroll - selectionStart.current!.scrollY
        const adjustedStartY = selectionStart.current!.y - scrollDiff
        
        const newBox = {
          startX: selectionStart.current!.x,
          startY: adjustedStartY,
          endX: e.clientX,
          endY: e.clientY
        }
        setSelectionBox(newBox)
        
        const left = Math.min(newBox.startX, newBox.endX)
        const right = Math.max(newBox.startX, newBox.endX)
        const top = Math.min(newBox.startY, newBox.endY)
        const bottom = Math.max(newBox.startY, newBox.endY)
        
        if (elementRectsRef.current.size === 0) {
          const elements = document.querySelectorAll('[data-mid]')
          elements.forEach(el => {
            const section = el.closest('.mf-section-body')
            if (section && !section.classList.contains('open')) return
            elementRectsRef.current.set(el, el.getBoundingClientRect())
          })
        }

        const nextSelected = new Set(initialSelectedOnDrag.current)
        const scrollDelta = scrollDiff
        elementRectsRef.current.forEach((rect, el) => {
          const adjTop = rect.top - scrollDelta
          const adjBottom = rect.bottom - scrollDelta
          if (rect.left < right && rect.right > left && adjTop < bottom && adjBottom > top) {
            const mid = parseInt(el.getAttribute('data-mid') || '0', 10)
            if (mid) nextSelected.add(mid)
          }
        })
        
        setSelected(nextSelected)
      })
    }
    const handleMouseUp = () => {
      if (isSelecting.current) {
        isSelecting.current = false
        selectionStart.current = null
        setSelectionBox(null)
        elementRectsRef.current.clear()
        cancelAnimationFrame(rafRef.current)
      }
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      cancelAnimationFrame(rafRef.current)
      elementRectsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const container = document.querySelector('.v2-main')
    if (!container) return
    const handleGlobalMouseDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.mf-card, .mf-folder-card, .mf-table, .v3-btn, button, input, .mf-gm-card')) return
      if (e.button !== 0) return
      const currentScroll = container.scrollTop
      selectionStart.current = { x: e.clientX, y: e.clientY, scrollY: currentScroll }
      isSelecting.current = true
      initialSelectedOnDrag.current = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(selectedRef.current) : new Set()
      elementRectsRef.current.clear()
      const elements = document.querySelectorAll('[data-mid]')
      elements.forEach(el => {
        const section = el.closest('.mf-section-body')
        if (section && !section.classList.contains('open')) return
        elementRectsRef.current.set(el, el.getBoundingClientRect())
      })
      setSelectionBox({ startX: e.clientX, startY: e.clientY, endX: e.clientX, endY: e.clientY })
    }
    container.addEventListener('mousedown', handleGlobalMouseDown as EventListener)
    return () => container.removeEventListener('mousedown', handleGlobalMouseDown as EventListener)
  }, [])

  useEffect(() => {
    window.electronAPI.share.getBotToken().then((r: any) => {
      if (r.success && r.data) {
        setBotConfigured(true)
        setBotToken(r.data)
      } else {
        window.electronAPI.share.ensureBot().then(() => {
          window.electronAPI.share.getBotToken().then((r3: any) => {
            if (r3.success && r3.data) {
              setBotConfigured(true)
              setBotToken(r3.data)
            }
          }).catch(() => {})
        }).catch(() => {})
      }
    }).catch(() => {})
  }, [])

  useEffect(() => { window.electronAPI.tgs.read('duck.tgs').then((r: any) => { if (r.success) setDuckAnim(r.data) }) }, [])


  useEffect(() => {
    setVisibleCount(FILES_PAGE_SIZE)
    setSearchQuery('')
    setDebouncedQuery('')
    setSearchResults([])
    setSearchTotal(0)
    setSelected(new Set())
  }, [folderDrill, sort, view])

  useEffect(() => { setSelected(new Set()) }, [searchQuery])

  const [duplicatePrompt, setDuplicatePrompt] = useState<{ file: { filePath: string; fileName: string }, existingId: number, resolve: (choice: 'replace' | 'copy' | 'skip') => void } | null>(null)

  useEffect(() => {
    if (!duplicatePrompt) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        duplicatePrompt.resolve('skip')
        setDuplicatePrompt(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [duplicatePrompt])

  useEffect(() => {
    if (!renameTarget && !showCreateFolder && !moveTarget) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (renameTarget) setRenameTarget(null)
      if (showCreateFolder) setShowCreateFolder(false)
      if (moveTarget) setMoveTarget(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [renameTarget, showCreateFolder, moveTarget])

  useEffect(() => {
    return () => {
      setProgressModal(null)
      setPreview(null)
      setPreviewUrl('')
      setRenameTarget(null)
      setMoveTarget(null)
      setShowCreateFolder(false)
      setIsDragOver(false)
      setSelectionBox(null)
      setCtxMenu(null)
      dragCounter.current = 0
      if (filesChangedDebounceRef.current) clearTimeout(filesChangedDebounceRef.current)
      if (dropDoneRef.current) clearTimeout(dropDoneRef.current)
      setDuplicatePrompt(prev => {
        prev?.resolve('skip')
        return null
      })
    }
  }, [])

  const loadFolders = useCallback(async () => {
    const r = await window.electronAPI.folders.list()
    if (r.success) { setFolders(r.data.folders || []); setFileFolders(r.data.fileFolders || {}) }
  }, [])

  const loadFoldersFromCloud = useCallback(async () => {
    try {
      const r = await window.electronAPI.folders.loadFromTelegram()
      if (r.success && r.data) {
        const cloudFolders = r.data.folders || []
        const cloudFileFolders = r.data.fileFolders || {}
        if (cloudFolders.length > 0 || Object.keys(cloudFileFolders).length > 0) {
          setFolders(cloudFolders)
          setFileFolders(cloudFileFolders as Record<number, string>)
          return
        }
      }
    } catch {}
    await loadFolders()
  }, [loadFolders])

  const createFolder = () => { setShowCreateFolder(true); setNewFolderName('') }
  const confirmCreateFolder = async () => {
    if (!newFolderName.trim()) return
    const r = await window.electronAPI.folders.create(newFolderName.trim(), folderDrill)
    setShowCreateFolder(false)
    if (r.success) { setFolders(r.data.folders || []); setFileFolders(r.data.fileFolders || {}); toast.success('Папка создана') }
  }

  const deleteFolder = async (id: string, e?: React.MouseEvent) => {
    let targetElement = e ? (e.currentTarget as HTMLElement).closest('.mf-card, .mf-list-item, tr') : null;
    let clientX = e ? e.clientX : undefined;
    let clientY = e ? e.clientY : undefined;
    
    if (!(await appConfirm('Удалить папку в корзину?'))) return

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

    const folderToRestore = folders.find(x => x.id === id)

    const applyRemove = () => {
      flushSync(() => {
        setFolders(prev => prev.filter(x => x.id !== id))
      })
    }

    applyRemove()

    const r = await window.electronAPI.folders.delete(id)
    if (r.success) { 
      setFolders(r.data.folders || [])
      setFileFolders(r.data.fileFolders || {})
      if (folderDrill === id) { setFolderDrill(null); setVisibleCount(FILES_PAGE_SIZE) }
    } else {
      toast.error('Ошибка удаления папки')
      const revert = () => {
        flushSync(() => {
          if (folderToRestore) setFolders(prev => [...prev, folderToRestore])
        })
      }
      safeViewTransition(revert)
    }
  }

  const renameFolder = async (id: string) => {
    if (!renameVal.trim()) return
    const r = await window.electronAPI.folders.rename(id, renameVal.trim())
    setRenameId(null)
    if (r.success) { setFolders(r.data.folders || []); setFileFolders(r.data.fileFolders || {}) }
  }

  const moveFileToFolder = (messageId: number) => {
    if (selected.has(messageId) && selected.size > 1) {
      setMoveTarget(Array.from(selected))
    } else {
      setMoveTarget([messageId])
    }
  }
  const bulkMoveToFolder = () => {
    if (selected.size === 0) return
    const pool = folderDrill ? folderFiles : files
    const poolIds = new Set(pool.map((f: any) => f.messageId))
    const ids = Array.from(selected).filter(id => poolIds.has(id))
    if (ids.length === 0) {
      toast.info('Нет выбранных файлов в текущем списке')
      clearSelection()
      return
    }
    setMoveTarget(ids)
  }
  const handleFileDragStart = (e: React.DragEvent, f: any) => {
    e.stopPropagation()
    let payload: any = { type: 'file', id: f.messageId }
    if (selected.has(f.messageId) && selected.size > 1) {
      payload = { type: 'files', ids: Array.from(selected) }
    }
    e.dataTransfer.setData('text/plain', JSON.stringify(payload))
  }
  const confirmMoveFile = async (target: string) => {
    if (!moveTarget || moveTarget.length === 0) return
    const idsToMove = [...moveTarget]
    
    // 1. Optimistic UI Update & close modal immediately
    let updated = { ...fileFolders }
    for (const id of idsToMove) {
      if (target.startsWith('cat:')) delete updated[id]
      else updated[id] = target
    }
    
    setMoveTarget(null)
    clearSelection()

    safeViewTransition(() => setFileFolders(updated))

    // 2. Background API call
    try {
      if (target.startsWith('cat:')) {
        await window.electronAPI.folders.moveFiles(idsToMove, null)
      } else {
        await window.electronAPI.folders.moveFiles(idsToMove, target)
      }
      toast.success('Перемещено')
    } catch (e) {
      toast.error('Ошибка при перемещении')
      console.error(e)
    }
  }

  const [loadError, setLoadError] = useState<string | null>(null)

  const loadCategoryCounts = useCallback(async () => {
    try {
      const r = await window.electronAPI.telegram.getCategoryCounts()
      if (r.success && r.data) setCategoryCounts(r.data)
    } catch {}
  }, [])

  const processRawFiles = (raw: any[]) =>
    raw
      .filter((x: any) => !locallyDeletedIds.current.has(x.messageId))
      .map((f: any) => {
        const meta = v3store.metaFor(f.messageId)
        if (meta?.displayName) return { ...f, fileName: meta.displayName }
        return f
      })

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    setLoadError(null)
    try {
      const [r] = await Promise.all([
        window.electronAPI.telegram.listFilesFromCache(FILES_PAGE_SIZE, 0),
        loadCategoryCounts(),
        loadFoldersFromCloud()
      ])
      if (r.success) {
        setFiles(processRawFiles(r.data || []))
        nextOffsetIdRef.current = r.nextOffsetId ?? null
        totalFilesRef.current = r.total ?? 0
      }
      if (!silent) setLoading(false)
      window.electronAPI.telegram.syncFilesBg()
    } catch (e: any) {
      setLoadError(e.message || 'Ошибка загрузки')
      if (!silent) setLoading(false)
    }
  }

  const loadingMoreRef = useRef(false)
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || nextOffsetIdRef.current === null) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const r = await window.electronAPI.telegram.listFilesFromCache(FILES_PAGE_SIZE, nextOffsetIdRef.current)
      if (r.success && r.data?.length) {
        const newFiles = processRawFiles(r.data)
        setFiles(prev => [...prev, ...newFiles])
        nextOffsetIdRef.current = r.nextOffsetId ?? null
        setVisibleCount(prev => prev + newFiles.length)
      } else {
        nextOffsetIdRef.current = null
      }
    } catch {}
    loadingMoreRef.current = false
    setLoadingMore(false)
  }, [])

  const loadFolderFiles = useCallback(async (folderId: string, silent = false) => {
    const requestId = ++folderRequestIdRef.current
    if (!silent) setFolderLoading(true)
    setFolderFiles([])
    folderNextOffsetIdRef.current = null
    setFolderTotal(0)
    try {
      const r = await window.electronAPI.telegram.listFolderFilesFromCache(folderId, FILES_PAGE_SIZE, 0)
      if (requestId !== folderRequestIdRef.current) return
      if (r.success) {
        setFolderFiles(processRawFiles(r.data || []))
        folderNextOffsetIdRef.current = r.nextOffsetId ?? null
        setFolderTotal(r.total ?? 0)
      }
    } catch {}
    if (requestId === folderRequestIdRef.current) setFolderLoading(false)
  }, [])

  const loadMoreFolderFiles = useCallback(async () => {
    if (folderLoadingMoreRef.current || !folderDrill || folderNextOffsetIdRef.current === null) return
    folderLoadingMoreRef.current = true
    setFolderLoadingMore(true)
    try {
      const r = await window.electronAPI.telegram.listFolderFilesFromCache(folderDrill, FILES_PAGE_SIZE, folderNextOffsetIdRef.current)
      if (r.success && r.data?.length) {
        const newFiles = processRawFiles(r.data)
        setFolderFiles(prev => {
          const seen = new Set(prev.map((f: any) => f.messageId))
          const fresh = newFiles.filter((f: any) => !seen.has(f.messageId))
          return fresh.length ? [...prev, ...fresh] : prev
        })
        folderNextOffsetIdRef.current = r.nextOffsetId ?? null
        setVisibleCount(prev => prev + newFiles.length)
      } else {
        folderNextOffsetIdRef.current = null
      }
    } catch {}
    folderLoadingMoreRef.current = false
    setFolderLoadingMore(false)
  }, [folderDrill])

  const uploadDroppedFiles = async (dropped: { filePath: string; fileName: string; objectUrl?: string }[], targetFolderId?: string | null) => {
    if (dropped.length === 0) return
    setDropProgress(prev => {
      const total = (prev?.total || 0) + dropped.length
      const completed = prev?.completed || 0
      return { current: 0, total, pct: total > 0 ? Math.floor(completed / total * 100) : 0, completed }
    })
    
    const newPending = dropped.map(d => ({
      id: Math.random().toString(36).substring(2),
      fileName: d.fileName,
      progress: 0,
      folderId: targetFolderId || null,
      objectUrl: d.objectUrl
    }))
    pendingStore.add(newPending)

    for (let i = 0; i < dropped.length; i++) {
      const file = dropped[i]
      const pendingId = newPending[i].id

      const currentFiles = targetFolderId ? files.filter((f: any) => fileFolders[f.messageId] === targetFolderId) : files.filter((f: any) => !fileFolders[f.messageId])
      const existing = currentFiles.find((f: any) => f.fileName === file.fileName)
      
      let uploadCustomName: string | undefined = undefined

      if (existing) {
        const choice = await new Promise<'replace' | 'copy' | 'skip'>(resolve => {
          setDuplicatePrompt({ file, existingId: existing.messageId, resolve })
        })
        setDuplicatePrompt(null)

        if (choice === 'skip') {
          pendingStore.remove(pendingId)
          setDropProgress(dp => dp ? { ...dp, completed: dp.completed + 1 } : null)
          continue
        }
        if (choice === 'replace') {
          await window.electronAPI.telegram.deleteFile(existing.messageId)
        }
        if (choice === 'copy') {
          const extMatch = file.fileName.lastIndexOf('.')
          const base = extMatch !== -1 ? file.fileName.slice(0, extMatch) : file.fileName
          const ext = extMatch !== -1 ? file.fileName.slice(extMatch) : ''
          let copyNum = 1
          let newName = `${base} (${copyNum})${ext}`
          while (currentFiles.find((f: any) => f.fileName === newName)) {
            copyNum++
            newName = `${base} (${copyNum})${ext}`
          }
          uploadCustomName = newName
        }
      }

      window.electronAPI.telegram.uploadFile(file.filePath, pendingId, false, uploadCustomName).then(async (res: any) => {
        pendingStore.updateProgress({ id: pendingId, percent: 100 })
        await new Promise(r => setTimeout(r, 500))

        if (res.success && res.data) {
          if (res.data.hash) v3store.setMeta({ messageId: res.data.messageId, hash: res.data.hash })

          setFiles(prev => {
            if (prev.some(f => f.messageId === res.data.messageId)) return prev
            return [res.data, ...prev]
          })

          if (targetFolderId && res.data.messageId) {
            setFileFolders(prev => ({ ...prev, [res.data.messageId]: targetFolderId }))
            await window.electronAPI.folders.addFile(targetFolderId, res.data.messageId)
          }
        } else {
          toast.error(`Ошибка загрузки: ${res.error || 'неизвестная ошибка'}`)
        }

        pendingStore.remove(pendingId)
        if (file.objectUrl) URL.revokeObjectURL(file.objectUrl)

        await loadFolders()

        setDropProgress(dp => {
          if (!dp) return null
          const completed = dp.completed + 1
          const pct = Math.floor((completed / dp.total) * 100)
          if (completed >= dp.total) {
            clearTimeout(dropDoneRef.current)
            dropDoneRef.current = setTimeout(() => setDropProgress(null), 6000)
          }
          return { ...dp, completed, pct }
        })
      }).catch((err: any) => {
        console.error('Upload failed:', err)
        pendingStore.remove(pendingId)
        loadFolders()
        setDropProgress(dp => dp ? { ...dp, completed: dp.completed + 1 } : null)
      })
    }
  }

  const uploadToFolder = async (folderId: string) => {
    const pick = await window.electronAPI.dialog.pickMultipleFiles()
    if (!pick.success || !pick.data?.length) return
    await uploadDroppedFiles(pick.data.map((f: any) => ({ filePath: f.filePath, fileName: f.fileName })), folderId)
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    if (!drillDown) { setDrillFiles([]); setDrillLoading(false); return }
    setDrillLoading(true)
    window.electronAPI.telegram.getFilesByCategory(drillDown).then((r: any) => {
      setDrillFiles(processRawFiles(r.data || []))
      setDrillLoading(false)
    }).catch(() => setDrillLoading(false))
  }, [drillDown])

  useEffect(() => {
    if (!folderDrill) { setFolderFiles([]); folderNextOffsetIdRef.current = null; setFolderTotal(0); return }
    setVisibleCount(FILES_PAGE_SIZE)
    loadFolderFiles(folderDrill)
  }, [folderDrill, loadFolderFiles])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(t)
  }, [searchQuery])

  useEffect(() => {
    if (!folderDrill) return
    const reqId = ++searchRequestIdRef.current
    if (debouncedQuery.trim()) {
      window.electronAPI.telegram.searchFolderFiles(folderDrill, debouncedQuery, 50, 0).then((r: any) => {
        if (reqId !== searchRequestIdRef.current) return
        if (r.success) {
          setSearchResults(processRawFiles(r.files || []))
          setSearchTotal(r.total ?? 0)
        }
      })
    } else {
      setSearchResults([])
      setSearchTotal(0)
    }
  }, [debouncedQuery, folderDrill])

  const loadExpandedCatFiles = useCallback(async (cat: string) => {
    const r = await window.electronAPI.telegram.getFilesByCategory(cat)
    if (r.success) setExpandedCatFiles(prev => ({ ...prev, [cat]: processRawFiles(r.data || []) }))
  }, [])

  useEffect(() => {
    const CATS_TO_LOAD = ['Документы', 'Архивы', 'Другое', 'Недавние']
    for (const cat of CATS_TO_LOAD) {
      if (expanded.has(cat) && !expandedCatFiles[cat]) loadExpandedCatFiles(cat)
    }
  }, [expanded])

  useEffect(() => {
    const unsub = window.electronAPI.telegram.onFilesChanged(() => {
      if (filesChangedDebounceRef.current) clearTimeout(filesChangedDebounceRef.current)
      filesChangedDebounceRef.current = setTimeout(() => {
        const keep = Math.max(FILES_PAGE_SIZE, filesLenRef.current)
        window.electronAPI.telegram.listFilesFromCache(keep, 0).then((r: any) => {
          if (r.success) {
            const incoming = processRawFiles(r.data || [])
            setFiles(prev => {
              if (!prev.length) return incoming
              if (!incoming.length) return prev
              const prevIds = new Set(prev.map((f: any) => f.messageId))
              const maxPrev = prev.reduce((m: number, f: any) => Math.max(m, f.messageId || 0), 0)
              const incById = new Map(incoming.map((f: any) => [f.messageId, f]))
              const refreshed = prev.map((f: any) => {
                const upd = incById.get(f.messageId)
                if (!upd) return f
                return { ...f, ...upd, fileName: f.fileName }
              })
              const newer = incoming.filter((f: any) => !prevIds.has(f.messageId) && (f.messageId || 0) > maxPrev)
              if (!newer.length) return refreshed
              return [...newer, ...refreshed]
            })
            nextOffsetIdRef.current = r.nextOffsetId ?? null
            totalFilesRef.current = r.total ?? 0
            setVisibleCount(prev => Math.max(prev, FILES_PAGE_SIZE))
          }
        })
        if (folderDrill) loadFolderFiles(folderDrill, true)
        loadCategoryCounts()
        loadFolders()
        setExpandedCatFiles({})
      }, 3000)
    })
    return unsub
  }, [loadFolders, loadCategoryCounts, folderDrill, loadFolderFiles])

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60000)
    return () => clearInterval(interval)
  }, [])

  const filtered = useMemo(() => {
    let arr = [...files]
    if (search) arr = arr.filter(f => (f.fileName || '').toLowerCase().includes(search.toLowerCase()))
    arr.sort((a, b) => {
      if (sort === 'name') return (a.fileName || '').localeCompare(b.fileName || '')
      if (sort === 'size') return (b.fileSize || 0) - (a.fileSize || 0) || (b.messageId - a.messageId)
      return (b.messageId - a.messageId)
    })
    return arr
  }, [files, search, sort])

  const currentLevelFolders = useMemo(() => folders.filter(f => (f.parentId || null) === (folderDrill || null)), [folders, folderDrill])
  const currentFiles = useMemo(() => {
    if (folderDrill) {
      if (debouncedQuery.trim()) return searchResults
      return folderFiles
    }
    if (search) return files.filter(f => (f.fileName || '').toLowerCase().includes(search.toLowerCase()))
    return files
  }, [files, folderFiles, folderDrill, search, debouncedQuery, searchResults])

  const currentFilesIndex = useMemo(() => {
    const m = new Map<number, number>()
    currentFiles.forEach((f: any, i: number) => m.set(f.messageId, i))
    return m
  }, [currentFiles])

  const activeListLength = useMemo(() => {
    if (folderDrill) return debouncedQuery.trim() ? searchTotal : folderTotal
    return filtered.length
  }, [folderDrill, folderTotal, searchTotal, debouncedQuery, filtered.length])

  const sortedFiles = useMemo(() => {
    return [...currentFiles].sort((a, b) => {
      if (sort === 'name') return (a.fileName || '').localeCompare(b.fileName || '')
      if (sort === 'size') return (b.fileSize || 0) - (a.fileSize || 0) || (b.messageId - a.messageId)
      return (b.messageId - a.messageId)
    })
  }, [currentFiles, sort])

  const scrollRafRef = useRef(0)
  useEffect(() => {
    const container = document.querySelector('.v2-main')
    if (!container) return
    const handleScroll = () => {
      if (scrollRafRef.current) return
      const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      if (distanceToBottom >= SCROLL_THRESHOLD) return
      const totalLen = folderDrill ? currentFiles.length : filtered.length
      if (visibleCount >= totalLen) {
        if (folderDrill) {
          if (folderNextOffsetIdRef.current !== null && !folderLoadingMoreRef.current && !debouncedQuery.trim()) loadMoreFolderFiles()
        } else if (nextOffsetIdRef.current !== null) {
          loadMore()
        }
        return
      }
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0
        setVisibleCount(prev => Math.min(prev + FILES_PAGE_SIZE, totalLen))
      })
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = 0 }
    }
  }, [filtered.length, currentFiles.length, visibleCount, loadMore, loadMoreFolderFiles, folderDrill, debouncedQuery])

  const listLoaderRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = listLoaderRef.current
    if (!el) return
    const totalLen = folderDrill ? currentFiles.length : filtered.length
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      if (visibleCount < totalLen) {
        setVisibleCount(prev => Math.min(prev + FILES_PAGE_SIZE, totalLen))
        return
      }
      if (folderDrill) {
        if (folderNextOffsetIdRef.current !== null && !folderLoadingMoreRef.current && !debouncedQuery.trim()) loadMoreFolderFiles()
      } else if (nextOffsetIdRef.current !== null && !loadingMoreRef.current) {
        loadMore()
      }
    }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [folderDrill, currentFiles.length, filtered.length, visibleCount, loadMore, loadMoreFolderFiles, debouncedQuery, loadingMoreRef])


  const recentFiles = useMemo(() => {
    return filtered.filter(f => {
      const fd = f.uploadedAt || fileDate(f)
      return fd > 0 && (now - fd) < RECENT_WINDOW_SEC && (now - fd) > -86400
    })
  }, [filtered, now])

  const grouped = useMemo(() => {
    const map: Record<string, any[]> = {}
    CATEGORIES.forEach(c => { map[c] = [] })
    map['Недавние'] = expandedCatFiles['Недавние']?.length ? expandedCatFiles['Недавние'] : recentFiles
    const drillable = new Set(['Изображения', 'Видео', 'Аудио'])
    filtered.forEach(f => {
      const cat = typeOf(f.fileName)
      if (drillable.has(cat)) map[cat]?.push(f)
    })
    for (const [cat, files] of Object.entries(expandedCatFiles)) {
      if (cat !== 'Недавние' && !drillable.has(cat) && files.length) map[cat] = files
    }
    return map
  }, [filtered, recentFiles, now, fileFolders, expandedCatFiles])

  const galleryFiles = useMemo(() => {
    if (!drillDown) return []
    if (drillDown === 'Недавние') {
      return drillFiles.filter(f => {
        const fd = f.uploadedAt || fileDate(f)
        return fd > 0 && (now - fd) < RECENT_WINDOW_SEC && (now - fd) > -86400
      })
    }
    return drillFiles
  }, [drillDown, drillFiles, now])

  const galleryByDay = useMemo(() => groupByDay(galleryFiles), [galleryFiles]);
  const flattenedGallery = useMemo(() => {
    const grouped = groupByDay(galleryFiles);
    const flat: any[] = [];
    Object.entries(grouped).sort(([a], [b]) => +b - +a).forEach(([year, months]) => {
      Object.entries(months as any).sort(([a], [b]) => +b - +a).forEach(([month, days]) => {
        Object.entries(days as any).sort(([a], [b]) => +b - +a).forEach(([day, files]) => {
          const d = new Date(+year, +month, +day);
          let label = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
          if (+year !== new Date().getFullYear()) label += ' ' + year;
          flat.push({ type: 'header', id: `h-${year}-${month}-${day}`, label, count: (files as any[]).length });
          (files as any[]).forEach(f => flat.push({ type: 'file', id: f.messageId, file: f }));
        });
      });
    });
    return flat;
  }, [galleryFiles]);

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s
    })
  }
  const clearSelection = () => setSelected(new Set())

  const handleDownload = async (f: any) => {
    toast.info('Скачивание ' + f.fileName)
    const r = await window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
    toast.success(r.success ? 'Сохранено: ' + (r.data?.filePath || f.fileName) : 'Ошибка скачивания')
  }
  const handleDelete = async (f: any, e?: React.MouseEvent) => {
    let targetElement = e ? (e.currentTarget as HTMLElement).closest('.mf-card, .mf-list-item, tr') : null;
    let clientX = e ? e.clientX : undefined;
    let clientY = e ? e.clientY : undefined;

    if (!(await appConfirm('Переместить ' + f.fileName + ' в корзину?'))) return
    
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

    setDeletingIds(prev => new Set(prev).add(f.messageId))
    toast.info('Перемещение в корзину…')
    setProgressModal({ title: 'Перемещение в корзину', items: [{ name: f.fileName, status: 'active' as const }], current: 0, total: 1, visible: true, onClose: () => setProgressModal(null) })

    const applyRemove = () => {
      locallyDeletedIds.current.add(f.messageId)
      flushSync(() => {
        setFiles(prev => prev.filter(x => x.messageId !== f.messageId))
        setFolderFiles(prev => prev.filter((x: any) => x.messageId !== f.messageId))
        setDeletingIds(prev => { const s = new Set(prev); s.delete(f.messageId); return s })
      })
    }

    applyRemove()

    const r = await window.electronAPI.telegram.deleteFile(f.messageId)
    if (r.success) {
      toast.success('Перемещено в корзину')
      setProgressModal(prev => prev ? { ...prev, items: [{ name: f.fileName, status: 'done' as const }], current: 1 } : prev)
    } else {
      toast.error('Ошибка удаления, отмена операции')
      const revert = () => {
        locallyDeletedIds.current.delete(f.messageId)
        flushSync(() => {
          setFiles(prev => {
            if (prev.find(x => x.messageId === f.messageId)) return prev
            return [...prev, f].sort((a, b) => (b.messageId - a.messageId))
          })
          if (folderDrill) {
            setFolderFiles(prev => {
              if (prev.find((x: any) => x.messageId === f.messageId)) return prev
              return [...prev, f]
            })
          }
          setDeletingIds(prev => { const s = new Set(prev); s.delete(f.messageId); return s })
        })
      }
      safeViewTransition(revert)
      setProgressModal(prev => prev ? { ...prev, items: [{ name: f.fileName, status: 'error' as const }], current: 1 } : prev)
    }
    setIsDragOver(false)
    dragCounter.current = 0
    setSelectionBox(null)
  }
  const handleCopyLink = async (f: any) => {
    if (botConfigured && botToken) {
      setShareProgress('generating')
      try {
        const r = await window.electronAPI.share.generateLink(f.messageId, f.chatId || '', f.fileName)
        if (r.success && r.data) {
          const data = r.data
          const downloadUrl = data.url || data
          await window.electronAPI.app.copyToClipboard(downloadUrl)
          setShareProgress('done')
          setTimeout(() => setShareProgress(null), 2500)
        } else {
          setShareProgress(null)
          toast.error('Ошибка: ' + (r.error || ''))
        }
      } catch (e: any) {
        setShareProgress(null)
        toast.error('Ошибка: ' + (e.message || ''))
      }
    } else {
      const link = `https://t.me/c/${f.chatId || ''}/${f.messageId}`
      await window.electronAPI.app.copyToClipboard(link)
      toast.info('Ссылка скопирована (требуется подписка на канал)')
    }
  }
  const handlePreview = async (f: any, idx: number, list?: any[]) => {
    const ft = typeOf(f.fileName)
    if (ft !== 'Изображения' && ft !== 'Видео') return
    const items = list || filtered
    window.electronAPI.preview.open(items, items.indexOf(f))
  }
  useEffect(() => {
    const onMousedown = (e: MouseEvent) => {
      if (e.button !== 2) return
      
      const fldEl = (e.target as HTMLElement).closest<HTMLElement>('[data-folder-id]')
      if (fldEl) {
        e.stopPropagation()
        const fid = fldEl.dataset.folderId
        const f = folders.find(x => x.id === fid)
        if (f) setCtxMenu({ x: e.clientX, y: e.clientY, folder: f })
        return
      }

      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-mid]')
      if (el) {
        e.stopPropagation()
        const mid = Number(el.dataset.mid)
        const f = files.find(x => x.messageId === mid)
        if (f) setCtxMenu({ x: e.clientX, y: e.clientY, file: f })
        return
      }

      const content = (e.target as HTMLElement).closest<HTMLElement>('.mf-sections, .mf-gallery, .mf-root')
      if (content) {
        e.stopPropagation()
        setCtxMenu({ x: e.clientX, y: e.clientY, type: 'global' })
      }
    }
    const onContext = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-mid]') || (e.target as HTMLElement).closest('[data-folder-id]') || (e.target as HTMLElement).closest('.mf-sections, .mf-gallery, .mf-root')) e.preventDefault()
    }
    document.addEventListener('mousedown', onMousedown)
    document.addEventListener('contextmenu', onContext)
    return () => {
      document.removeEventListener('mousedown', onMousedown)
      document.removeEventListener('contextmenu', onContext)
    }
  }, [files, folders])

  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: Event) => {
      if ((e.target as HTMLElement)?.closest?.('.mf-ctx')) return
      setCtxMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true) }
  }, [ctxMenu])



  const navPreview = useCallback((dir: number) => {
    if (!preview) return
    const all = preview.list.filter((f: any) => {
      const ft = typeOf(f.fileName); return ft === 'Изображения' || ft === 'Видео'
    })
    if (all.length === 0) return
    const curr = all.findIndex((x: any) => x === preview.list[preview.idx])
    const next = (curr + dir + all.length) % all.length
    setPreviewUrl(''); handlePreview(all[next], preview.list.indexOf(all[next]), preview.list)
  }, [preview])

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null)
      if (e.key === 'ArrowLeft') navPreview(-1)
      if (e.key === 'ArrowRight') navPreview(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, navPreview])
  const bulkDelete = async (e?: React.MouseEvent) => {
    if (selected.size === 0) return
    const pool = folderDrill ? folderFiles : files
    const poolIds = new Set(pool.map((f: any) => f.messageId))
    const ids = Array.from(selected).filter(id => poolIds.has(id))
    if (ids.length === 0) {
      toast.info('Нет выбранных файлов в текущем списке')
      clearSelection()
      return
    }
    if (!(await appConfirm(`Переместить ${ids.length} файлов в корзину?`))) return
    const selectedFiles = pool.filter((f: any) => ids.includes(f.messageId))
    let hadError = false
    
    let x = 0.5, y = 0.5
    if (e) {
      x = e.clientX / window.innerWidth
      y = e.clientY / window.innerHeight
    }
    confetti({
      particleCount: 150,
      spread: 120,
      origin: { x, y },
      colors: ['#7c83ff', '#ff4b4b', '#a1a1aa'],
      disableForReducedMotion: true,
      zIndex: 9999
    })

    const items = selectedFiles.map(f => ({ name: f.fileName, status: 'pending' as const }))
    setDeletingIds(prev => {
      const n = new Set(prev)
      ids.forEach(id => n.add(id))
      return n
    })
    toast.info('Перемещение в корзину…')

    setProgressModal({ title: 'Перемещение в корзину', items, current: 0, total: ids.length, visible: true, onClose: () => setProgressModal(null) })

    const removeFromLists = (fid: number) => {
      locallyDeletedIds.current.add(fid)
      setFiles(prev => prev.filter(x => x.messageId !== fid))
      setFolderFiles(prev => prev.filter((x: any) => x.messageId !== fid))
    }

    const onProgress = (data: { kind: string; index: number; total: number }) => {
      if (data.kind !== 'delete') return
      setProgressModal(prev => {
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
        removeFromLists(ids[data.index - 1])
      }
    }
    const unsub = window.electronAPI.telegram.onBulkProgress(onProgress)

    clearSelection()

    try {
      const r = await window.electronAPI.telegram.bulkDelete(ids)
      unsub()

      if (r.success) {
        setProgressModal(prev => {
          if (!prev) return prev
          return { ...prev, items: prev.items.map(it => ({ ...it, status: 'done' as const })), current: prev.total }
        })
        ids.forEach(removeFromLists)
      } else {
        hadError = true
        setProgressModal(prev => {
          if (!prev) return prev
          const newItems = prev.items.map((it, i) => {
            const result = r.data?.[i]
            return { ...it, status: result?.success ? 'done' as const : 'error' as const }
          })
          return { ...prev, items: newItems, current: prev.total }
        })
      }
    } catch (err) {
      unsub()
      hadError = true
      setProgressModal(prev => {
        if (!prev) return prev
        return { ...prev, items: prev.items.map(it => ({ ...it, status: 'error' as const })), current: prev.total }
      })
    }
    if (hadError) toast.error('Часть файлов не удалась')
    setDeletingIds(prev => {
      const n = new Set(prev)
      ids.forEach(id => n.delete(id))
      return n
    })
    setIsDragOver(false)
    dragCounter.current = 0
    setSelectionBox(null)
  }
  const bulkDownload = async () => {
    if (selected.size === 0) return
    const pool = folderDrill ? folderFiles : files
    const items = pool
      .filter((f: any) => selected.has(f.messageId))
      .map((f: any) => ({ messageId: f.messageId, fileName: f.fileName }))
    if (items.length === 0) {
      toast.info('Нет выбранных файлов в текущем списке')
      clearSelection()
      return
    }
    toast.info('Скачивание ' + items.length + ' файлов…')
    await window.electronAPI.telegram.bulkDownload(items)
    toast.success('Скачивание завершено')
  }

  const [archiveProgress, setArchiveProgress] = useState<{ percent: number; phase: string; sent?: number; total?: number } | null>(null)
  const [archiveDonePhases, setArchiveDonePhases] = useState<Set<string>>(new Set())

  const handleArchive = async (catOrFolder: string, files: any[]) => {
    if (files.length === 0) return
    setArchiveProgress({ percent: 0, phase: 'downloading' })
    setArchiveDonePhases(new Set())
    const off = window.electronAPI.folders.onArchiveProgress((d: any) => {
      setArchiveProgress({ percent: d.percent, phase: d.phase, sent: d.sent, total: d.total })
      setArchiveDonePhases(prev => new Set(prev).add(d.phase))
    })
    const res = await window.electronAPI.folders.archiveAndUpload({
      folderName: catOrFolder,
      files: files.map(f => ({ messageId: f.messageId, fileName: f.fileName })),
    })
    off()
    setArchiveProgress(null)
    toast.success(res.success ? `Архив ${catOrFolder}.zip загружен` : 'Ошибка архивации: ' + (res.error || ''))
  }

  const toggleCategory = (cat: string) => {
    if (cat === 'Изображения' || cat === 'Видео' || cat === 'Аудио' || cat === 'Недавние') {
      setDrillDown(cat); setVisibleCount(FILES_PAGE_SIZE)
      return
    }
    const s = new Set(expanded)
    s.has(cat) ? s.delete(cat) : s.add(cat)
    setExpanded(s)
  }

  const hasFiles = Object.values(grouped).some(g => g.length > 0)

  const [isDragOver, setIsDragOver] = useState(false)
  const [dropProgress, setDropProgress] = useState<{ current: number; total: number; pct: number; completed: number } | null>(null)
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>(pendingStore.uploads)
  const dropDoneRef = useRef<NodeJS.Timeout>()
  const dragCounter = useRef(0)

  useEffect(() => {
    const active = pendingStore.uploads.filter(u => u.progress < 100)
    if (active.length > 0) {
      setDropProgress({ current: 0, total: active.length, pct: 0, completed: 0 })
    }
  }, [])

  useEffect(() => {
    return pendingStore.subscribe((updates: PendingUpload[]) => {
      setPendingUploads(updates)
      setDropProgress(dp => {
        if (!dp) return null
        const activeProgresses = updates.reduce((sum, p) => sum + p.progress, 0)
        const totalProgressPct = dp.total > 0 ? Math.floor(((dp.completed * 100) + activeProgresses) / dp.total) : 0
        return { ...dp, pct: Math.min(100, totalProgressPct) }
      })
    })
  }, [])

  const extractDroppedFiles = (e: React.DragEvent) => {
    const dropped: { filePath: string; fileName: string; objectUrl?: string }[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.electronAPI.getPathForFile(file)
      let objectUrl: string | undefined
      if (file.type.startsWith('image/') || file.type.startsWith('video/') || file.name.match(/\.(heic|heif)$/i)) {
        try { objectUrl = URL.createObjectURL(file) } catch {}
      }
      if (p) dropped.push({ filePath: p, fileName: file.name, objectUrl })
    }
    return dropped
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current = 0; setIsDragOver(false)
    const dropped = extractDroppedFiles(e)
    if (dropped.length === 0) return
    await uploadDroppedFiles(dropped, folderDrill)
  }

  const countFilesRecursive = useCallback((folderId: string): number => {
    const directFiles = files.filter((f: any) => fileFolders[f.messageId] === folderId).length
    const childFolders = folders.filter(f => f.parentId === folderId)
    return directFiles + childFolders.reduce((sum, cf) => sum + countFilesRecursive(cf.id), 0)
  }, [files, fileFolders, folders])

  const folderFilesCache = useMemo(() => {
    const cache = new Map<string, any[]>()
    const build = (folderId: string): any[] => {
      if (cache.has(folderId)) return cache.get(folderId)!
      const direct = files.filter((f: any) => fileFolders[f.messageId] === folderId)
      const childFolders = folders.filter(f => f.parentId === folderId)
      const result = [...direct, ...childFolders.flatMap(cf => build(cf.id))]
      cache.set(folderId, result)
      return result
    }
    for (const f of folders) build(f.id)
    return cache
  }, [files, fileFolders, folders])

  const getFolderFilesRecursive = useCallback((folderId: string): any[] => {
    return folderFilesCache.get(folderId) || files.filter((f: any) => fileFolders[f.messageId] === folderId)
  }, [folderFilesCache, files, fileFolders])

  return (
    <div className={"mf-root mf-hide-checks" + (isDragOver ? " drag-over" : "")}
         onDragEnter={(e) => { e.preventDefault(); dragCounter.current++; setIsDragOver(true) }}
         onDragOver={(e) => { e.preventDefault() }}
         onDragLeave={() => { dragCounter.current--; if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragOver(false) } }}
         onDrop={onDrop}>
      <div style={{
        maxHeight: shareProgress ? 48 : 0,
        opacity: shareProgress ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 0.35s ease, opacity 0.3s ease',
        width: '100%',
      }}>
        <div style={{
          width: '100%',
          background: shareProgress === 'done'
            ? 'rgba(52,211,153,0.08)'
            : 'rgba(124,131,255,0.08)',
          borderBottom: '1px solid ' + (shareProgress === 'done'
            ? 'rgba(52,211,153,0.2)'
            : 'rgba(124,131,255,0.15)'),
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            padding: '8px 16px',
            fontSize: 13, color: shareProgress === 'done' ? '#6ee7b7' : '#bcc0ff',
            fontWeight: 500,
          }}>
            <div style={{
              width: 80, height: 4,
              background: 'rgba(255,255,255,0.08)',
              borderRadius: 2, overflow: 'hidden', flexShrink: 0,
            }}>
              <div style={{
                height: '100%', width: shareProgress === 'done' ? '100%' : '60%',
                background: shareProgress === 'done'
                  ? 'linear-gradient(90deg, #34d399, #6ee7b7)'
                  : 'linear-gradient(90deg, #7c83ff, #a78bfa)',
                borderRadius: 2,
                transition: 'width 0.4s ease',
                animation: shareProgress === 'generating' ? 'mf-shimmer 1.5s infinite' : 'none',
                boxShadow: shareProgress === 'done'
                  ? '0 0 6px rgba(52,211,153,0.4)'
                  : '0 0 6px rgba(124,131,255,0.4)',
              }} />
            </div>
            {shareProgress === 'generating' ? 'Генерация ссылки…' : 'Ссылка скопирована в буфер обмена'}
          </div>
        </div>
      </div>

      {/* Premium Floating Upload Center */}
      <div style={{
        position: 'fixed', bottom: 30, right: 30, zIndex: 9999,
        background: 'rgba(22, 24, 42, 0.85)',
        backdropFilter: 'blur(24px) saturate(160%)',
        WebkitBackdropFilter: 'blur(24px) saturate(160%)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 20,
        padding: 20, width: 340,
        boxShadow: '0 20px 50px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)',
        transform: dropProgress ? 'translateY(0) scale(1)' : 'translateY(120%) scale(0.9)',
        opacity: dropProgress ? 1 : 0,
        pointerEvents: dropProgress ? 'auto' : 'none',
        transition: 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {dropProgress && dropProgress.pct >= 100 ? (
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(52,211,153,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6ee7b7' }}>
                <Check size={18} />
              </div>
            ) : (
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(124,131,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bcc0ff' }}>
                <UploadCloud size={18} />
              </div>
            )}
            <div>
              <div style={{ fontWeight: 600, color: '#fff', fontSize: 14 }}>
                {dropProgress && dropProgress.pct >= 100 ? 'Загрузка завершена' : 'Загрузка файлов...'}
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
                {dropProgress ? `${dropProgress.completed} из ${dropProgress.total} файлов` : ''}
              </div>
            </div>
          </div>
          <button onClick={() => setDropProgress(null)} style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Progress Bar Track */}
        <div style={{
          width: '100%', height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden', marginBottom: 12
        }}>
          <div style={{
            height: '100%', width: (dropProgress?.pct ?? 0) + '%',
            background: dropProgress && dropProgress.pct >= 100 ? 'linear-gradient(90deg, #34d399, #6ee7b7)' : 'linear-gradient(90deg, #7c83ff, #a78bfa)',
            borderRadius: 3, transition: 'width 0.3s ease',
            boxShadow: dropProgress && dropProgress.pct >= 100 ? '0 0 10px rgba(52,211,153,0.5)' : '0 0 10px rgba(124,131,255,0.5)'
          }} />
        </div>

        {/* Active Uploads List */}
        {pendingUploads.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 90, overflowY: 'auto' }}>
            {pendingUploads.slice(0, 3).map(p => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'rgba(255,255,255,0.7)', background: 'rgba(255,255,255,0.03)', padding: '6px 10px', borderRadius: 8 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.fileName || 'Файл'}</span>
                <span style={{ color: p.progress === 100 ? '#6ee7b7' : '#bcc0ff', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {p.progress === 100 ? '100%' : p.total && p.total > 50 * 1024 * 1024 ? (
                    <>{fmtSize(p.sent || 0)} / {fmtSize(p.total)}</>
                  ) : `${p.progress}%`}
                </span>
                {p.progress < 100 && (
                  <button onClick={(e) => { e.stopPropagation(); window.electronAPI.telegram.cancelUpload(p.id); pendingStore.remove(p.id) }} style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', padding: 2, flexShrink: 0 }} title="Отменить">
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            {pendingUploads.length > 3 && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: 4 }}>
                и еще {pendingUploads.length - 3}...
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mf-toolbar">
        <div className="mf-search">
          <Search size={16} />
          <input placeholder="Поиск файлов…" value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setSearch(e.target.value) }} />
        </div>

        {activeListLength > FILES_PAGE_SIZE && (
          <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap', marginLeft: 8 }}>
            {visibleCount >= activeListLength ? activeListLength : `1–${visibleCount}`} из {activeListLength}
          </span>
        )}

        <div className="mf-view-toggle">
          <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="Сетка"><Grid size={16} /></button>
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="Список"><ListIcon size={16} /></button>
        </div>

        <button className="v3-btn ghost" onClick={createFolder} title="Создать папку" style={{ padding: '8px 10px', borderColor: 'transparent' }}><FolderPlus size={16} /></button>
      </div>

      {duplicatePrompt && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.3s ease-out forwards' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(5, 7, 16, 0.6)', backdropFilter: 'blur(24px) saturate(150%)' }} />
          
          <div style={{ 
            position: 'relative', 
            background: 'linear-gradient(145deg, rgba(30, 34, 53, 0.9), rgba(15, 17, 26, 0.95))', 
            padding: '36px', 
            borderRadius: 24, 
            width: 460, 
            boxShadow: '0 30px 60px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.1)', 
            border: '1px solid rgba(255,255,255,0.05)',
            animation: 'modalPop 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards'
          }}>

            
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, marginBottom: 28 }}>
              <div className="icon-glow-wrap">
                <div className="icon-glow-bg" />
                <div className="icon-glow-inner">
                  <AlertCircle size={24} strokeWidth={2.5} />
                </div>
              </div>
              <div style={{ paddingTop: 4 }}>
                <h3 style={{ margin: 0, fontSize: 22, fontWeight: 700, background: 'linear-gradient(180deg, #ffffff 0%, #cbd5e1 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: '-0.02em' }}>Конфликт имен</h3>
                <p style={{ margin: '8px 0 0', fontSize: 14, color: '#94a3b8', lineHeight: 1.6 }}>В этой папке уже есть файл с таким же именем. Выберите, как с ним поступить.</p>
              </div>
            </div>

            <div className="file-chip" style={{ marginBottom: 36 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(168, 85, 247, 0.1))', border: '1px solid rgba(99, 102, 241, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#818cf8', fontSize: 12, fontWeight: 700, letterSpacing: 0.5, boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.05)' }}>
                {(duplicatePrompt.file.fileName.split('.').pop() || '?').slice(0, 4).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 4 }}>
                  {duplicatePrompt.file.fileName}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#f59e0b' }} />
                  Ожидает загрузки
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button className="btn-premium ghost" onClick={() => duplicatePrompt.resolve('skip')}>Пропустить</button>
              <button className="btn-premium secondary" onClick={() => duplicatePrompt.resolve('copy')}>Сохранить оба</button>
              <button className="btn-premium danger" onClick={() => duplicatePrompt.resolve('replace')}>Заменить</button>
            </div>
          </div>
        </div>
      )}

      <div className="mf-bulkbar" style={{ position: 'sticky', top: 0, zIndex: 50, opacity: selected.size > 0 ? 1 : 0, transform: selected.size > 0 ? 'none' : 'translateY(-100%)', transition: 'opacity 0.25s, transform 0.3s', pointerEvents: selected.size > 0 ? 'auto' : 'none', visibility: selected.size > 0 ? 'visible' : 'hidden' }}>
        <span>Выбрано: {selected.size}</span>
        <button onClick={bulkDownload}><Download size={14} /> Скачать</button>
        <button onClick={bulkMoveToFolder}><MoveRight size={14} /> Переместить</button>
        <button className="danger" onClick={bulkDelete}><Trash2 size={14} /> Удалить</button>
        <button onClick={clearSelection}>Снять</button>
      </div>

      {loading ? (
        <div className="mf-skeleton-grid" style={{ marginTop: '20px' }}>
          {[...Array(12)].map((_, i) => (
            <div key={i} className="mf-skeleton-card" />
          ))}
        </div>
      ) : loadError ? (
        <div className="mf-empty" style={{ paddingTop: 60 }}>
          <AlertCircle size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
          <div>{loadError}</div>
          <button className="v3-btn ghost" style={{ marginTop: 12 }} onClick={() => load()}>Повторить</button>
        </div>
      ) : drillDown ? (
        <div className="mf-gallery">
          <div className="mf-gallery-head" onClick={() => { setDrillDown(null); setVisibleCount(FILES_PAGE_SIZE) }} style={{ '--cat-color': CAT_COLOR[drillDown] } as React.CSSProperties}>
            <ArrowLeft size={18} />
            <span className="mf-section-icon">{CAT_ICON[drillDown]}</span>
            <span className="mf-section-title">{drillDown}</span>
            <span className="mf-gallery-count">{galleryFiles.length}</span>
          </div>
          <div className="mf-gallery-body">
            {drillDown === 'Аудио' ? (<>
              <table className="mf-table">
                <thead><tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={galleryFiles.length > 0 && galleryFiles.slice(0, visibleCount).every(f => selected.has(f.messageId))}
                      onChange={e => {
                        const checked = e.target.checked
                        const list = galleryFiles.slice(0, visibleCount)
                        setSelected(prev => {
                          const s = new Set(prev)
                          list.forEach(f => { checked ? s.add(f.messageId) : s.delete(f.messageId) })
                          return s
                        })
                      }}
                    />
                  </th>
                  <th>Имя</th><th>Размер</th><th>Дата</th><th>Действия</th>
                </tr></thead>
                <tbody>
                  {galleryFiles.slice(0, visibleCount).map(f => (
                    <tr key={f.messageId} data-mid={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                        style={{ viewTransitionName: `card_${f.messageId}` }}
                      draggable={true} onDragStart={(e) => handleFileDragStart(e, f)}>
                      <td><input type="checkbox" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} /></td>
                      <td className="ellip" title={f.fileName}>{f.isEncrypted && '🔒 '}{f.fileName}</td>
                      <td>{fmtSize(f.fileSize)}</td>
                      <td>{new Date((fileDate(f) || 0) * 1000).toLocaleDateString()}</td>
                      <td>
                        <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                        <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={14} /></button>
                        <button title="Переместить" onClick={(e) => { e.stopPropagation(); moveFileToFolder(f.messageId); }}><MoveRight size={14} /></button>
                        <button title="Удалить" className="danger" onClick={(e) => handleDelete(f, e)}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {drillLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                  <div className="v3-spinner" />
                </div>
              ) : galleryFiles.length === 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 22px', gap: 8 }}>
                  {duckAnim ? (
                    <Player autoplay loop src={duckAnim} style={{ width: 80, height: 80 }} />
                  ) : (
                    <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🐤</div>
                  )}
                  <span style={{ color: 'var(--v3-text-dim)', fontSize: 12 }}>Нет файлов</span>
                </div>
              )}
            </>) : (
              <div className="mf-gallery-body">
                {galleryFiles.length > 0 ? (
                  Object.entries(groupByDay(galleryFiles.slice(0, visibleCount))).sort(([a], [b]) => +b - +a).map(([year, months]) => (
                    <div key={year} className="mf-gy">
                      <div className="mf-gy-title">{year}</div>
                      {Object.entries(months).sort(([a], [b]) => +b - +a).map(([month, days]) => (
                        <div key={year + '-' + month} className="mf-gm">
                          <div className="mf-gm-month">{MONTHS_RU[+month]}</div>
                          {Object.entries(days).sort(([a], [b]) => +b - +a).map(([day, items]: [string, any]) => (
                            <div key={year + '-' + month + '-' + day} className="mf-gd">
                              <div className="mf-gd-title">{day} {MONTHS_RU[+month]} <span className="mf-gm-count">{items.length}</span></div>
                              <div className="mf-gm-items">
                                {items.map((f: any) => (
                                  <TiltCard key={f.messageId} data-mid={f.messageId} className={'mf-gm-card' + (selected.has(f.messageId) ? ' selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                                    effect="evade" scale={1.03} tiltLimit={8} spotlight={true}
                                    onClick={(e: any) => { if ((e.target as HTMLElement).closest('button, input')) return; toggleSelect(f.messageId); }}
                                    onDoubleClick={() => { const canPreview = drillDown === 'Изображения' || drillDown === 'Видео'; if (canPreview) handlePreview(f, galleryFiles.indexOf(f), galleryFiles) }}>
                                    <input type="checkbox" className="mf-check" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} />
                                    <div className="mf-gm-icon" data-type={drillDown}>
                                      <FileThumb messageId={f.messageId} fileName={f.fileName} isVideo={drillDown === 'Видео'} typeLabel={drillDown || ''} />
                                    </div>
                                    <div className="mf-gm-name" title={f.fileName}>{f.isEncrypted && '🔒 '}{f.fileName}</div>
                                    <div className="mf-gm-meta">{fmtSize(f.fileSize)}</div>
                                    <div className="mf-gm-actions">
                                      <button title="Скачать" onClick={() => handleDownload(f)}><Download size={13} /></button>
                                      {(drillDown === 'Изображения' || drillDown === 'Видео') && <button title="Просмотр" onClick={() => handlePreview(f, galleryFiles.indexOf(f), galleryFiles)}><Eye size={13} /></button>}
                                      <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={13} /></button>
                                      <button title="Переместить" onClick={(e) => { e.stopPropagation(); moveFileToFolder(f.messageId); }}><MoveRight size={13} /></button>
                                      <button title="Удалить" className="danger" onClick={(e) => handleDelete(f, e)}><Trash2 size={13} /></button>
                                    </div>
                                  </TiltCard>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))
                ) : null}
              </div>
            )}
            {drillLoading && galleryFiles.length === 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                <div className="v3-spinner" />
              </div>
            )}
            {!drillLoading && galleryFiles.length === 0 && drillDown !== 'Аудио' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 22px', gap: 8 }}>
                {duckAnim ? (
                  <Player autoplay loop src={duckAnim} style={{ width: 80, height: 80 }} />
                ) : (
                  <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🐤</div>
                )}
                <span style={{ color: 'var(--v3-text-dim)', fontSize: 12 }}>Нет файлов</span>
              </div>
            )}
            {(loadingMore || folderLoadingMore) && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
                <div style={{ width: 24, height: 24, border: '2px solid rgba(124,131,255,0.2)', borderTopColor: '#7c83ff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              </div>
            )}
          </div>
        </div>
      ) : !hasFiles && folders.length === 0 && !search ? (
        <div className="mf-empty-state">
          <div className="mf-empty-icon">
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="10" y="20" width="60" height="45" rx="8" stroke="rgba(124,131,255,0.3)" strokeWidth="2" fill="rgba(124,131,255,0.05)"/>
              <path d="M10 28C10 23.5817 13.5817 20 18 20H30L36 14H62C66.4183 14 70 17.5817 70 22V28" stroke="rgba(124,131,255,0.3)" strokeWidth="2" fill="rgba(124,131,255,0.08)"/>
              <circle cx="40" cy="44" r="8" stroke="rgba(124,131,255,0.4)" strokeWidth="2" strokeDasharray="4 4"/>
              <path d="M40 38V50M34 44H46" stroke="rgba(124,131,255,0.4)" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <h3 className="mf-empty-title">Нет файлов</h3>
          <p className="mf-empty-desc">Загрузите первый файл в облако</p>
          <button className="mf-empty-btn" onClick={() => navigate('/upload')}>
            <Upload size={16} /> Загрузить файл
          </button>
        </div>
      ) : (
        <div className="mf-sections">
          {!folderDrill && CATEGORIES.map(cat => {
            const items = grouped[cat]
            const displayCount = categoryCounts[cat] ?? items.length
            if (search && items.length === 0) return null
            const open = expanded.has(cat)
            const isDrillable = cat === 'Изображения' || cat === 'Видео' || cat === 'Аудио' || cat === 'Недавние'
            return (
              <div key={cat} className={'mf-section' + (open ? ' open' : '')}>
                <div className="mf-section-head" onClick={() => toggleCategory(cat)} style={{ '--cat-color': CAT_COLOR[cat] } as React.CSSProperties}>
                  <ChevronDown size={14} />
                  <span className="mf-section-icon">{CAT_ICON[cat]}</span>
                  <span className="mf-section-title">{cat}</span>
                  <span className="mf-section-count">{displayCount}</span>
                  {items.length > 0 && <button className="v3-btn ghost" style={{ padding: 4, border: 'none', color: '#7c83ff', fontSize: 11, marginLeft: 4 }}
                    onClick={(e) => { e.stopPropagation(); handleArchive(cat, items) }} title="Архивировать и загрузить">
                    <Archive size={12} />
                  </button>}
                  {isDrillable && <span className="mf-section-drill">Открыть →</span>}
                </div>
                <div className={'mf-section-body' + (open ? ' open' : '')}>
                  {items.length > 0 && (
                    view === 'grid' ? (
                      <div className="mf-grid">
                        {items.slice(0, visibleCount).map((f) => (
                          <TiltCard key={f.messageId} data-mid={f.messageId} className={'mf-card' + (selected.has(f.messageId) ? ' selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                             style={{ viewTransitionName: `card_${f.messageId}` }}
                             effect="evade" scale={1.03} tiltLimit={8} spotlight={true}
                             onClick={(e: any) => { if ((e.target as HTMLElement).closest('button, input')) return; toggleSelect(f.messageId); }}
                             onDoubleClick={() => { if (cat === 'Изображения' || cat === 'Видео') handlePreview(f, filtered.indexOf(f)) }}>
                            <input type="checkbox" className="mf-check" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} />
                            <div className="mf-card-icon" data-type={cat}>{(f.fileName.split('.').pop() || '?').slice(0, 4).toUpperCase()}</div>
                            <div className="mf-card-name" title={f.fileName}>{f.isEncrypted && '🔒 '}{f.fileName}</div>
                            <div className="mf-card-meta">{fmtSize(f.fileSize)} • {new Date((fileDate(f) || 0) * 1000).toLocaleDateString()}</div>
                            <div className="mf-card-actions">
                              <button title="В избранное" onClick={(e) => { e.stopPropagation(); setSelected(new Set(selected)); v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() }); setFavs(v3store.getFavs()) }}><Star size={14} fill={v3store.isFav(f.messageId) ? '#fbbf24' : 'transparent'} stroke="currentColor" /></button>
                              <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                              {(cat === 'Изображения' || cat === 'Видео') && <button title="Просмотр" onClick={() => handlePreview(f, filtered.indexOf(f))}><Eye size={14} /></button>}
                              <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={14} /></button>
                              <button title="Переместить в папку" onClick={(e) => { e.stopPropagation(); moveFileToFolder(f.messageId); }}><MoveRight size={14} /></button>
                              <button title="Удалить" className="danger" onClick={(e) => handleDelete(f, e)}><Trash2 size={14} /></button>
                            </div>
                          </TiltCard>
                        ))}
                      </div>
                    ) : (
                      <table className="mf-table">
                        <thead><tr>
                          <th>
                            <input
                              type="checkbox"
                              checked={items.length > 0 && items.slice(0, visibleCount).every(f => selected.has(f.messageId))}
                              onChange={e => {
                                const checked = e.target.checked
                                const list = items.slice(0, visibleCount)
                                setSelected(prev => {
                                  const s = new Set(prev)
                                  list.forEach(f => { checked ? s.add(f.messageId) : s.delete(f.messageId) })
                                  return s
                                })
                              }}
                            />
                          </th>
                          <th>Имя</th><th>Размер</th><th>Дата</th><th>Действия</th>
                        </tr></thead>
                        <tbody>
                          {items.slice(0, visibleCount).map(f => (
                            <tr key={f.messageId} data-mid={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                                style={{ viewTransitionName: `card_${f.messageId}` }}
  onClick={(e) => { if ((e.target as HTMLElement).closest('button, input')) return; toggleSelect(f.messageId); }}
                              draggable={true} onDragStart={(e) => handleFileDragStart(e, f)}
                              onDoubleClick={() => { if (cat === 'Изображения' || cat === 'Видео') handlePreview(f, filtered.indexOf(f)) }}>
                              <td><input type="checkbox" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} /></td>
                                  <td className="ellip" title={f.fileName}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Star size={12} fill={v3store.isFav(f.messageId) ? '#fbbf24' : 'transparent'} stroke="currentColor" style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => { v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() }); setFavs(v3store.getFavs()) }} />{f.isEncrypted && '🔒 '}{f.fileName}</span></td>
                              <td>{fmtSize(f.fileSize)}</td>
                              <td>{new Date((fileDate(f) || 0) * 1000).toLocaleDateString()}</td>
                              <td>
                                <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                                {(cat === 'Изображения' || cat === 'Видео') && <button title="Просмотр" onClick={() => handlePreview(f, filtered.indexOf(f))}><Eye size={14} /></button>}
                                <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={14} /></button>
                                <button title="Переместить" onClick={(e) => { e.stopPropagation(); moveFileToFolder(f.messageId); }}><MoveRight size={14} /></button>
                                <button title="Удалить" className="danger" onClick={(e) => handleDelete(f, e)}><Trash2 size={14} /></button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  )}
                  {items.length === 0 && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 22px', gap: 8 }}>
                    {duckAnim ? (
                      <Player autoplay loop src={duckAnim} style={{ width: 80, height: 80 }} />
                    ) : (
                      <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🐤</div>
                    )}
                    <span style={{ color: 'var(--v3-text-dim)', fontSize: 12 }}>Здесь пока никого…</span>
                  </div>}
                </div>
              </div>
            )
          })}
          {(folders.length > 0 || folderDrill || pendingUploads.length > 0 || files.length > 0) && (() => {

            return (
              <div style={{ marginTop: folderDrill ? 4 : 24, padding: folderDrill ? '0' : '0 14px' }}>
                {folderDrill ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.05)', borderRadius: 12, marginBottom: 16, fontSize: 13, fontWeight: 500, backdropFilter: 'blur(12px)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ cursor: 'pointer', color: 'var(--text-dim)' }} onClick={() => { setFolderDrill(null); setVisibleCount(FILES_PAGE_SIZE) }}>Мои файлы</span>
                      {(() => {
                        const crumbs = [];
                        let curr = folderDrill;
                        while (curr) {
                          const f = folders.find(x => x.id === curr);
                          if (f) { crumbs.unshift(f); curr = f.parentId; } else break;
                        }
                        return crumbs.map(c => (
                          <React.Fragment key={c.id}>
                            <ChevronRight size={14} style={{ color: 'var(--text-dim)' }} />
                            <span style={{ cursor: 'pointer', color: c.id === folderDrill ? 'var(--text)' : 'var(--text-dim)' }} onClick={() => { setFolderDrill(c.id); setVisibleCount(FILES_PAGE_SIZE) }}>{c.name}</span>
                          </React.Fragment>
                        ));
                      })()}
                    </div>
                    <button className="v3-btn primary" style={{ padding: '6px 12px', height: 'auto', fontSize: '12px', gap: '6px' }} onClick={() => uploadToFolder(folderDrill)}>
                      <Upload size={14} /> Загрузить
                    </button>
                  </div>
                ) : currentLevelFolders.length > 0 ? (
                  <div style={{ padding: '6px 0', fontSize: 12, color: 'var(--text-dim)', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 12 }}>
                    Папки
                  </div>
                ) : null}

                {renameId && folders.find(x => x.id === renameId) && (
                  <div style={{ padding: '8px 0', marginBottom: 16 }}>
                    <input value={renameVal} onChange={e => setRenameVal(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && renameFolder(renameId)}
                      style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', color: 'var(--text)', fontSize: 13, width: '100%', outline: 'none' }}
                      placeholder="Новое имя папки"
                      autoFocus />
                  </div>
                )}

                {(currentLevelFolders.length > 0 || currentFiles.length > 0 || pendingUploads.filter(p => {
      if (folderDrill?.startsWith('__type_')) return matchVirtualFolder(p.fileName, folderDrill)
      return p.folderId === folderDrill
    }).length > 0) && (
                  view === 'grid' ? (
                    <>
                      {currentLevelFolders.length > 0 && <div className="mf-folders-grid" style={{ marginBottom: 14 }}>
                      {currentLevelFolders.map(sf => {
                        const allFiles = getFolderFilesRecursive(sf.id);
                        const imgFiles = allFiles.filter((f: any) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f.fileName));
                        const vidFiles = allFiles.filter((f: any) => /\.(mp4|mov|avi|mkv|webm)$/i.test(f.fileName));
                        const previewFile = imgFiles[0] || vidFiles[0];
                        const isPreviewVideo = previewFile && vidFiles.includes(previewFile);
                        const cascadeFiles = imgFiles.slice(0, 3);
                        const totalCount = countFilesRecursive(sf.id);
                        const totalSize = allFiles.reduce((s: number, f: any) => s + (f.fileSize || 0), 0);
                        return (
                        <TiltCard key={sf.id} className="mf-folder-card" style={{ cursor: 'pointer', viewTransitionName: `folder-${sf.id}` }}
                             effect="evade" scale={1.03} tiltLimit={12} spotlight={true}
                             draggable={true}
                             onDragStart={(e: any) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'folder', id: sf.id })) }}
                             onDragOver={(e: any) => { e.preventDefault(); e.currentTarget.style.outline = '2px solid #7c83ff'; e.currentTarget.style.outlineOffset = '-2px' }}
                             onDragLeave={(e: any) => { e.currentTarget.style.outline = 'none' }}
                             onDrop={async (e: any) => {
                               e.preventDefault(); e.stopPropagation(); dragCounter.current = 0; setIsDragOver(false);
                               e.currentTarget.style.outline = 'none';
                               if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                 const dropped = extractDroppedFiles(e)
                                 if (dropped.length > 0) { await uploadDroppedFiles(dropped, sf.id); return }
                               }
                               try {
                                 const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                                 if (data.type === 'files' && data.ids) {
                                   for (const did of data.ids) {
                                     await window.electronAPI.folders.moveFile(did, sf.id);
                                   }
                                   clearSelection();
                                   loadFolders();
                                 }
                                 else if (data.type === 'file' && data.id) { await window.electronAPI.folders.moveFile(data.id, sf.id); loadFolders(); }
                                 else if (data.type === 'folder' && data.id && data.id !== sf.id) { await window.electronAPI.folders.moveFolder(data.id, sf.id); loadFolders(); }
                               } catch {}
                             }}
                              onClick={() => { setFolderDrill(sf.id); setVisibleCount(FILES_PAGE_SIZE) }}
                              onContextMenu={(e: any) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, folder: sf }) }}>
                          <div className="mf-folder-preview">
                            {previewFile ? (
                              <>
                                <div className="mf-folder-cover">
                                  <FileThumb messageId={previewFile.messageId} fileName={previewFile.fileName} isVideo={!!isPreviewVideo} typeLabel={isPreviewVideo ? 'Видео' : 'Изображения'} />
                                </div>
                                <div className="mf-folder-overlay" />
                                {cascadeFiles.length > 1 && (
                                  <div className="mf-folder-cascade">
                                    {cascadeFiles.slice().reverse().map((f: any) => (
                                      <div key={f.messageId} className="mf-folder-cascade-thumb">
                                        <FileThumb messageId={f.messageId} fileName={f.fileName} isVideo={false} typeLabel="Изображения" />
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            ) : (
                              <div className="mf-folder-empty">
                                <div className="mf-folder-empty-icon"><Folder size={28} /></div>
                              </div>
                            )}
                            <button className="mf-folder-menu" onClick={(e) => { e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, folder: sf }) }}>
                              <MoreHorizontal size={13} />
                            </button>
                          </div>
                          <div className="mf-folder-name" title={sf.name}>{sf.name}</div>
                          <div className="mf-folder-meta">{totalCount} файл. · {fmtSize(totalSize)}</div>
                        </TiltCard>
                        );
                      })}
                      </div>}
                      {pendingUploads.filter(p => {
                        if (folderDrill?.startsWith('__type_')) return matchVirtualFolder(p.fileName, folderDrill)
                        return p.folderId === folderDrill
                      }).length > 0 && (
                      <div className="mf-grid">
                        {pendingUploads.filter(p => {
                          if (folderDrill?.startsWith('__type_')) return matchVirtualFolder(p.fileName, folderDrill)
                          return p.folderId === folderDrill
                        }).map((f: any) => (
                          <div key={f.id} className="mf-card magnetic pending-upload" style={{ cursor: 'wait', position: 'relative' }}>
                            {f.progress < 100 && (
                              <button onClick={(e) => { e.stopPropagation(); window.electronAPI.telegram.cancelUpload(f.id); pendingStore.remove(f.id) }} style={{ position: 'absolute', top: 6, right: 6, zIndex: 2, background: 'rgba(0,0,0,0.5)', border: 'none', color: '#fff', cursor: 'pointer', padding: 4, borderRadius: 6, lineHeight: 0 }} title="Отменить">
                                <X size={14} />
                              </button>
                            )}
                            <div className="mf-card-icon" data-type={typeOf(f.fileName)} style={{ position: 'relative', overflow: 'hidden' }}>
                              {f.objectUrl ? <img src={f.objectUrl} loading="lazy" style={{width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.6)'}} /> : (f.fileName.split('.').pop() || '?').slice(0, 4).toUpperCase()}
                              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
                                <svg width="40" height="40" viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
                                  <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="8" />
                                  <circle cx="50" cy="50" r="40" fill="none" stroke="#fff" strokeWidth="8" strokeDasharray="251.2" strokeDashoffset={251.2 - (251.2 * (f.progress || 0)) / 100} style={{ transition: 'stroke-dashoffset 0.1s linear' }} strokeLinecap="round" />
                                </svg>
                              </div>
                            </div>
                            <div className="mf-card-name" title={f.fileName}>{f.fileName}</div>
                            <div className="mf-card-meta">{f.progress < 100 ? (f.total && f.total > 50 * 1024 * 1024 ? `${fmtSize(f.sent || 0)} / ${fmtSize(f.total)}` : `Загрузка ${f.progress}%`) : 'Обработка...'}</div>
                          </div>
                        ))}
                      </div>
                      )}
                      {sortedFiles.length > 0 ? (
                      <div className="mf-grid">
                        {sortedFiles.slice(0, visibleCount).map(f => {
                          const isImg = f.fileName && f.fileName.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|avif|heic|heif)$/i)
                          const isVid = f.fileName && f.fileName.match(/\.(mp4|mov|avi|mkv|webm|flv)$/i)
                          return (
                          <TiltCard key={f.messageId} data-mid={f.messageId} className={'mf-card' + (selected.has(f.messageId) ? ' selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                               style={{ viewTransitionName: `card_${f.messageId}` }}
                               effect="evade" scale={1.03} tiltLimit={8} spotlight={true}
                               onClick={(e: any) => { if ((e.target as HTMLElement).closest('button, input')) return; toggleSelect(f.messageId); }}
                               onDoubleClick={() => { if (isImg || isVid) handlePreview(f, currentFilesIndex.get(f.messageId) ?? 0, currentFiles) }}
                               onContextMenu={(e: any) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, file: f }) }}>
                            <input type="checkbox" className="mf-check" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} />
                            <div className="mf-card-icon" data-type={typeOf(f.fileName)}>
                              {(isImg || isVid) ? <FileThumb messageId={f.messageId} fileName={f.fileName} isVideo={!!isVid} typeLabel={isVid ? 'Видео' : 'Изображения'} /> : (f.fileName.split('.').pop() || '?').slice(0, 4).toUpperCase()}
                            </div>
                            <div className="mf-card-name" title={f.fileName}>{f.fileName}</div>
                            <div className="mf-card-meta">{fmtSize(f.fileSize)} • {new Date((fileDate(f) || 0) * 1000).toLocaleDateString()}</div>
                            <div className="mf-card-actions">
                              <button title="В избранное" onClick={() => { v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() }); setFavs(v3store.getFavs()) }}><Star size={14} fill={v3store.isFav(f.messageId) ? '#fbbf24' : 'transparent'} stroke="currentColor" /></button>
                              <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                              {(isImg || isVid) && <button title="Просмотр" onClick={() => handlePreview(f, currentFilesIndex.get(f.messageId) ?? 0, currentFiles)}><Eye size={14} /></button>}
                              <button title="Переместить" onClick={() => moveFileToFolder(f.messageId)}><MoveRight size={14} /></button>
                              <button title="Удалить" className="danger" onClick={(e) => handleDelete(f, e)}><Trash2 size={14} /></button>
                            </div>
                          </TiltCard>
                          )
                        })}
                      </div>
                      ) : !folderLoading && sortedFiles.length === 0 && currentLevelFolders.length === 0 && pendingUploads.filter(p => {
                        if (folderDrill?.startsWith('__type_')) return matchVirtualFolder(p.fileName, folderDrill)
                        return p.folderId === folderDrill
                      }).length === 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 22px', gap: 8 }}>
                        {duckAnim ? (
                          <Player autoplay loop src={duckAnim} style={{ width: 80, height: 80 }} />
                        ) : (
                          <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🐤</div>
                        )}
                        <span style={{ color: 'var(--v3-text-dim)', fontSize: 12 }}>Папка пуста. Перетащите файлы сюда.</span>
                      </div>
                      ) : null}
                    </>
                  ) : (
                    <table className="mf-table">
                      <thead><tr><th>Имя</th><th>Размер</th><th>Дата</th><th>Действия</th></tr></thead>
                      <tbody>
                        {currentLevelFolders.map(sf => (
                          <tr key={sf.id} className="mf-folder-row" style={{ cursor: 'pointer', viewTransitionName: `folder-${sf.id}` }}
                              draggable={true}
                              onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'folder', id: sf.id })) }}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={async (e) => {
                                e.preventDefault(); e.stopPropagation(); dragCounter.current = 0; setIsDragOver(false);
                                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                  const dropped = extractDroppedFiles(e)
                                  if (dropped.length > 0) { await uploadDroppedFiles(dropped, sf.id); return }
                                }
                                try {
                                  const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                                  if (data.type === 'file' && data.id) { await window.electronAPI.folders.moveFile(data.id, sf.id); loadFolders(); }
                                  else if (data.type === 'folder' && data.id && data.id !== sf.id) { await window.electronAPI.folders.moveFolder(data.id, sf.id); loadFolders(); }
                                } catch {}
                              }}
                              onClick={() => { setFolderDrill(sf.id); setVisibleCount(FILES_PAGE_SIZE) }}
                              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, folder: sf }) }}>
                            <td className="ellip"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Folder size={16} style={{ color: '#7c83ff', flexShrink: 0 }} />{sf.name}</span></td>
                            <td style={{ color: 'var(--text-dim)' }}>{countFilesRecursive(sf.id)} файл.</td>
                            <td>{sf.createdAt ? new Date(sf.createdAt * 1000).toLocaleDateString() : '—'}</td>
                            <td>
                              <button title="Переименовать" onClick={(e) => { e.stopPropagation(); setRenameId(sf.id); setRenameVal(sf.name) }}><Pencil size={14} /></button>
                              <button title="Удалить" className="danger" onClick={(e) => { e.stopPropagation(); deleteFolder(sf.id, e) }}><Trash2 size={14} /></button>
                            </td>
                          </tr>
                        ))}
                        {sortedFiles.slice(0, visibleCount).map(f => {
                          const isImg = f.fileName && f.fileName.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|avif|heic|heif)$/i)
                          const isVid = f.fileName && f.fileName.match(/\.(mp4|mov|avi|mkv|webm|flv)$/i)
                          return (
                          <tr key={f.messageId} data-mid={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                              style={{ viewTransitionName: `card_${f.messageId}` }}
  onClick={(e) => { if ((e.target as HTMLElement).closest('button, input')) return; toggleSelect(f.messageId); }}
                              onDoubleClick={() => { if (isImg || isVid) handlePreview(f, currentFilesIndex.get(f.messageId) ?? 0, currentFiles) }}
                              draggable={true} onDragStart={(e) => handleFileDragStart(e, f)}
                              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, file: f }) }}>
                            <td className="ellip" title={f.fileName}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Star size={12} fill={v3store.isFav(f.messageId) ? '#fbbf24' : 'transparent'} stroke="currentColor" style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => { v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() }); setFavs(v3store.getFavs()) }} />{f.fileName}</span></td>
                            <td>{fmtSize(f.fileSize)}</td>
                            <td>{new Date((fileDate(f) || 0) * 1000).toLocaleDateString()}</td>
                            <td>
                              <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                              {(isImg || isVid) && <button title="Просмотр" onClick={() => handlePreview(f, currentFilesIndex.get(f.messageId) ?? 0, currentFiles)}><Eye size={14} /></button>}
                              <button title="Переместить" onClick={() => moveFileToFolder(f.messageId)}><MoveRight size={14} /></button>
                              <button title="Удалить" className="danger" onClick={(e) => handleDelete(f, e)}><Trash2 size={14} /></button>
                            </td>
                          </tr>
                        )})}
                        
                        {pendingUploads.filter(p => {
      if (folderDrill?.startsWith('__type_')) return matchVirtualFolder(p.fileName, folderDrill)
      return p.folderId === folderDrill
    }).map(p => (
                          <React.Fragment key={p.id}>
                            {p.total && p.total > 50 * 1024 * 1024 ? (
                              <tr className="pending-upload heavy-upload" style={{ cursor: 'wait', background: 'var(--v3-surface)' }}>
                                <td colSpan={5} style={{ padding: '16px 20px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                    <div style={{ position: 'relative', width: 40, height: 40, borderRadius: 8, overflow: 'hidden', flexShrink: 0, border: '1px solid rgba(255,255,255,0.1)' }}>
                                       {p.objectUrl ? <img src={p.objectUrl} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.6)' }} /> : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.05)' }}><FileText size={20} color="#cbd5e1" /></div>}
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
                                        <div style={{ fontSize: 14, fontWeight: 600, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.fileName}</div>
                                        <div style={{ fontSize: 13, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                                          {p.progress < 100 ? (
                                            <>
                                              <span style={{ color: '#e2e8f0' }}>{fmtSize(p.sent || 0)}</span> / {fmtSize(p.total || 0)} 
                                              <span style={{ opacity: 0.5, margin: '0 6px' }}>•</span> 
                                              Осталось: <span style={{ color: '#cbd5e1' }}>{fmtSize((p.total || 0) - (p.sent || 0))}</span>
                                              <span style={{ opacity: 0.5, margin: '0 6px' }}>•</span> 
                                              <span style={{ color: '#818cf8' }}>{p.progress}%</span>
                                              {(() => { const t = p.total || 0; const s = p.sent || 0; const totalCh = Math.max(1, Math.ceil(t / CHUNK_SIZE)); const curCh = Math.min(totalCh, Math.max(1, Math.ceil((s || 1) / CHUNK_SIZE))); return totalCh > 1 ? <><span style={{ opacity: 0.5, margin: '0 6px' }}>•</span><span style={{ color: '#a78bfa' }}>ч. {curCh}/{totalCh}</span></> : null })()}
                                            </>
                                          ) : (
                                            <span style={{ color: '#34d399' }}>Завершение...</span>
                                          )}
                                        </div>
                                        {p.progress < 100 && (
                                          <button onClick={() => { window.electronAPI.telegram.cancelUpload(p.id); pendingStore.remove(p.id) }} style={{ background: 'rgba(255,255,255,0.05)', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 6, borderRadius: 6, flexShrink: 0, lineHeight: 0 }} title="Отменить">
                                            <X size={16} />
                                          </button>
                                        )}
                                      </div>
                                      <div style={{ height: 6, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
                                        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${p.progress || 0}%`, background: 'linear-gradient(90deg, #6366f1, #a855f7)', transition: 'width 0.2s ease-out', borderRadius: 3 }}>
                                          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)', transform: 'translateX(-100%)', animation: 'shimmer 1.5s infinite' }} />
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            ) : (
                              <tr className="pending-upload" style={{ cursor: 'wait' }}>
                                <td className="ellip"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: 0.8 }}>
                                  <div style={{ position: 'relative', width: 24, height: 24, borderRadius: 4, overflow: 'hidden' }}>
                                     {p.objectUrl ? <img src={p.objectUrl} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.6)' }} /> : <FileText size={16} />}
                                     <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
                                        <svg width="16" height="16" viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
                                          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="12" />
                                          <circle cx="50" cy="50" r="40" fill="none" stroke="#fff" strokeWidth="12" strokeDasharray="251.2" strokeDashoffset={251.2 - (251.2 * (p.progress || 0)) / 100} style={{ transition: 'stroke-dashoffset 0.1s linear' }} strokeLinecap="round" />
                                        </svg>
                                     </div>
                                  </div>
                                  {p.fileName}
                                </span></td>
                                <td>{p.progress < 100 ? `Загрузка ${p.progress}%` : 'Обработка...'}</td>
                                <td>—</td>
                                <td>{p.progress < 100 ? <button onClick={() => { window.electronAPI.telegram.cancelUpload(p.id); pendingStore.remove(p.id) }} style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', padding: 4, lineHeight: 0 }} title="Отменить"><X size={14} /></button> : null}</td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                

                {folderDrill && folderLoading && currentFiles.length === 0 && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                    <div className="v3-spinner" />
                  </div>
                )}

                {folderDrill && !folderLoading && currentFiles.length === 0 && currentLevelFolders.length === 0 && pendingUploads.filter(p => {
      if (folderDrill?.startsWith('__type_')) return matchVirtualFolder(p.fileName, folderDrill)
      return p.folderId === folderDrill
    }).length === 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 22px', gap: 8 }}>
                    {duckAnim ? (
                      <Player autoplay loop src={duckAnim} style={{ width: 80, height: 80 }} />
                    ) : (
                      <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🐤</div>
                    )}
                    <span style={{ color: 'var(--v3-text-dim)', fontSize: 12 }}>Папка пуста. Перетащите файлы сюда.</span>
                  </div>
                )}

                {((folderDrill && currentFiles.length > visibleCount) || (!folderDrill && filtered.length > visibleCount)) && (
                  <div className="dup-load-more" role="status">
                    <span>Показано {Math.min(visibleCount, folderDrill ? currentFiles.length : filtered.length)} из {folderDrill ? currentFiles.length : filtered.length} файлов · прокрутите ниже</span>
                  </div>
                )}
                <div ref={listLoaderRef} style={{ height: 20, flexShrink: 0 }} />
              </div>
            );
          })()}
        </div>
      )}



      {preview && (() => {
        const all = preview.list.filter((f: any) => {
          const ft = typeOf(f.fileName); return ft === 'Изображения' || ft === 'Видео'
        })
        const currIdx = all.findIndex((x: any) => x === preview.list[preview.idx])
        const currFile = all[currIdx]
        return (
        <div className="mf-modal" style={{ cursor: 'pointer' }} onClick={() => setPreview(null)}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', background: 'linear-gradient(180deg,rgba(0,0,0,0.5),transparent)', zIndex: 10, userSelect: 'none' }}>
            <span style={{ color: '#fff', fontSize: 13, opacity: 0.9 }}>{currFile?.fileName || ''}</span>
            <span style={{ color: '#fff', fontSize: 12, opacity: 0.6 }}>{currIdx + 1} / {all.length}</span>
          </div>
          <button className="mf-modal-close" onClick={(e) => { e.stopPropagation(); setPreview(null) }}><X size={18} /></button>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '30%', zIndex: 5 }} onClick={(e) => { e.stopPropagation(); navPreview(-1) }} />
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '30%', zIndex: 5 }} onClick={(e) => { e.stopPropagation(); navPreview(1) }} />
          <button className="mf-modal-nav left" onClick={(e) => { e.stopPropagation(); navPreview(-1) }}><ChevronLeft size={22} /></button>
          {previewUrl ? (
            previewIsVideo ? (
              <video src={previewUrl} controls autoPlay style={{ maxWidth: '92vw', maxHeight: '90vh', borderRadius: 8 }} onClick={e => e.stopPropagation()} />
            ) : (
              <img src={previewUrl} onClick={e => e.stopPropagation()} style={{ maxWidth: '92vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }} />
            )
          ) : (
            <div className="mf-modal-loading">Загрузка предпросмотра…</div>
          )}
          <button className="mf-modal-nav right" onClick={(e) => { e.stopPropagation(); navPreview(1) }}><ChevronRight size={22} /></button>
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '14px 20px', background: 'linear-gradient(0deg,rgba(0,0,0,0.5),transparent)', zIndex: 10 }}>
            {previewUrl && <button onClick={(e) => { e.stopPropagation(); currFile && handleDownload(currFile) }} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, padding: '8px 16px', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}><Download size={14} /> Скачать</button>}
          </div>
        </div>
      )})()}

      {showCreateFolder && (
        <div className="mf-modal" onClick={() => setShowCreateFolder(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 24, minWidth: 300, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Новая папка</div>
            <input value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && confirmCreateFolder()}
              placeholder="Название папки"
              autoFocus
              style={{ background: 'var(--bg)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', fontSize: 14, outline: 'none' }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="v3-btn" onClick={() => setShowCreateFolder(false)} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-dim)' }}>Отмена</button>
              <button className="v3-btn" onClick={confirmCreateFolder} style={{ background: 'var(--accent)', border: 'none', color: '#fff' }}>Создать</button>
            </div>
          </div>
        </div>
      )}

      {moveTarget !== null && createPortal(
        <div className="mf-modal" onClick={() => setMoveTarget(null)} style={{ padding: '20px', alignItems: 'center', justifyContent: 'center' }}>
          <div className="mf-modal-glass" onClick={e => e.stopPropagation()} style={{ borderRadius: 20, padding: '28px 32px', width: '100%', maxWidth: 440, maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
              <div style={{ width: 48, height: 48, borderRadius: 16, background: 'color-mix(in srgb, var(--accent) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px color-mix(in srgb, var(--accent) 20%, transparent)' }}>
                <Folder size={24} style={{ color: 'var(--accent)' }} />
              </div>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, background: 'linear-gradient(90deg, #fff, #a1a1aa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  {(moveTarget?.length || 0) > 1 ? `Переместить ${moveTarget.length} файла(ов)` : 'Переместить файл'}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 2 }}>Выберите папку назначения</div>
              </div>
            </div>

            <button className="v3-btn mf-move-dropzone" onClick={() => confirmMoveFile('cat:root')}
              style={{ textAlign: 'left', justifyContent: 'center', padding: '14px 16px', borderRadius: 12, fontSize: 14, display: 'flex', alignItems: 'center', gap: 10, transition: 'background 0.2s, border-color 0.2s, transform 0.2s', marginTop: 4 }}>
              <ArrowLeft size={18} style={{ flexShrink: 0, opacity: 0.8 }} />
              Вынести из папки в корень
            </button>

            {(folders?.length || 0) > 0 && <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-dim)', letterSpacing: 1, marginTop: 12, paddingLeft: 4 }}>Папки</div>}
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
              {(() => {
                const fmap = new Map<string, any[]>();
                const fset = new Set((folders || []).map(f => f.id));
                (folders || []).forEach(f => {
                  const pid = (f.parentId && fset.has(f.parentId)) ? f.parentId : 'root';
                  if (!fmap.has(pid)) fmap.set(pid, []);
                  fmap.get(pid)!.push(f);
                });
                const flat: { f: any, depth: number }[] = [];
                const traverse = (pid: string, depth: number) => {
                  const children = fmap.get(pid) || [];
                  children.sort((a, b) => a.name.localeCompare(b.name));
                  children.forEach(c => {
                    flat.push({ f: c, depth });
                    traverse(c.id, depth + 1);
                  });
                };
                traverse('root', 0);
                return flat.map(({ f, depth }, idx) => (
                  <button key={f.id} className="v3-btn mf-move-btn" onClick={() => confirmMoveFile(f.id)}
                    style={{ 
                      textAlign: 'left', justifyContent: 'flex-start', background: 'transparent', 
                      border: '1px solid transparent', color: 'var(--text)', 
                      padding: '10px 14px', paddingLeft: 14 + depth * 24, 
                      borderRadius: 10, fontSize: 14, display: 'flex', alignItems: 'center', gap: 10,
                      animation: `dropFolderIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) ${idx * 0.03}s both`,
                      position: 'relative'
                    }}>
                    
                    {/* Tree line connector */}
                    {depth > 0 && <div style={{ position: 'absolute', left: 24 + (depth - 1) * 24, top: 0, bottom: '50%', width: 1, background: 'rgba(255,255,255,0.1)' }} />}
                    {depth > 0 && <div style={{ position: 'absolute', left: 24 + (depth - 1) * 24, top: '50%', width: 12, height: 1, background: 'rgba(255,255,255,0.1)' }} />}

                    <Folder size={18} style={{ flexShrink: 0, color: '#7c83ff', filter: `brightness(${1 - depth * 0.15})` }} />
                    {f.name}
                  </button>
                ));
              })()}
            </div>

            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <button className="v3-btn" onClick={() => setMoveTarget(null)} style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-dim)', padding: '10px 24px', borderRadius: 10 }}>Отмена</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {archiveProgress && (
        <div className="mf-toast" style={{ bottom: 60, display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px', minWidth: 260 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <Archive size={14} style={{ color: '#7c83ff' }} />
            <span style={{ fontWeight: 600, color: '#fff' }}>
              {archiveProgress.phase === 'downloading' ? 'Скачивание файлов' : archiveProgress.phase === 'compressing' ? 'Архивация' : 'Загрузка архива'}
            </span>
            <span style={{ marginLeft: 'auto', color: 'var(--v3-text-dim)', fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {archiveProgress.phase === 'uploading' && archiveProgress.total && archiveProgress.total > 50 * 1024 * 1024
                ? <>{fmtSize(archiveProgress.sent || 0)} / {fmtSize(archiveProgress.total)}</>
                : `${archiveProgress.percent}%`
              }
            </span>
          </div>
          <div className="up-bar" style={{ height: 4 }}>
            <div className="up-bar-fill" style={{ width: archiveProgress.percent + '%', background: '#7c83ff', transition: 'width 0.4s cubic-bezier(0.4,0,0.2,1)' }} />
          </div>
        </div>
      )}

      {selectionBox && createPortal(
        <div style={{
          position: 'fixed',
          zIndex: 9999,
          pointerEvents: 'none',
          background: 'rgba(124, 131, 255, 0.2)',
          border: '1px solid rgba(124, 131, 255, 0.5)',
          left: Math.min(selectionBox.startX, selectionBox.endX),
          top: Math.min(selectionBox.startY, selectionBox.endY),
          width: Math.abs(selectionBox.endX - selectionBox.startX),
          height: Math.abs(selectionBox.endY - selectionBox.startY),
        }} />
      , document.body)}

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
                setFiles(prev => prev.map(f => f.messageId === renameTarget.messageId ? { ...f, fileName: renameInput.trim() || f.fileName } : f))
              }}>Сохранить</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {ctxMenu && createPortal(
        <div className="mf-ctx" style={{
          position: 'fixed',
          left: Math.min(ctxMenu.x, window.innerWidth - 200),
          top: Math.min(ctxMenu.y, window.innerHeight - 300),
        }}>
          {ctxMenu.type === 'global' && (
            <button onClick={() => { createFolder(); closeCtx() }}>
              <FolderPlus size={14} /> Создать папку
            </button>
          )}
          {ctxMenu.folder && (
            <>
              <button onClick={() => { uploadToFolder(ctxMenu.folder.id); closeCtx() }}>
                <Upload size={14} /> Загрузить файлы
              </button>
              <button onClick={() => { setRenameId(ctxMenu.folder.id); setRenameVal(ctxMenu.folder.name); closeCtx() }}>
                <Pencil size={14} /> Переименовать
              </button>
              <div className="mf-ctx-divider" />
              <button className="danger" onClick={(e) => { deleteFolder(ctxMenu.folder.id, e); closeCtx() }}>
                <Trash2 size={14} /> Удалить
              </button>
            </>
          )}
          {ctxMenu.file && (
            <>
              <button onClick={() => { toggleSelect(ctxMenu.file.messageId); closeCtx() }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {selected.has(ctxMenu.file.messageId)
                    ? <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>
                    : <circle cx="12" cy="12" r="10"/>}
                </svg>
                Выбрать
              </button>
              <button onClick={() => { handleCopyLink(ctxMenu.file); closeCtx() }}>
                <Share2 size={14} /> Поделиться
              </button>
              <button onClick={() => { 
                if (selected.has(ctxMenu.file.messageId) && selected.size > 1) {
                  bulkDownload()
                } else {
                  handleDownload(ctxMenu.file)
                }
                closeCtx() 
              }}>
                <Download size={14} /> Скачать
              </button>
              <button onClick={() => { moveFileToFolder(ctxMenu.file.messageId); closeCtx() }}>
                <MoveRight size={14} /> Переместить
              </button>
              <button onClick={(e) => { e.stopPropagation(); setShowSub(showSub === 'albums' ? null : 'albums') } }
                style={{ position: 'relative' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M21 9H3"/></svg>
                В альбом {showSub === 'albums' && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5 }}>‹</span>}
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
                        toast.success(inAlbum ? 'Убрано из «' + a.name + '»' : 'Добавлено в «' + a.name + '»')
                        closeCtx()
                      }} style={{ paddingLeft: 36, fontSize: 12, textAlign: 'left', width: '100%' }}>
                        <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center' }}>
                          {inAlbum ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg> : null}
                        </span>
                        {a.name}
                      </button>
                    )
                  })}
                </>
              )}
              <button onClick={() => { const f = ctxMenu.file; setRenameInput(f.fileName); setRenameTarget(f); closeCtx() }}>
                <Pencil size={14} /> Переименовать
              </button>
              <div className="mf-ctx-divider" />
              <button className="danger" onClick={(e) => { 
                if (selected.has(ctxMenu.file.messageId) && selected.size > 1) {
                  bulkDelete(e)
                } else {
                  handleDelete(ctxMenu.file, e)
                }
                closeCtx() 
              }}>
                <Trash2 size={14} /> Удалить
              </button>
            </>
          )}
        </div>,
        document.body
      )}
      {progressModal && (
        <BulkProgressModal
          title={progressModal.title}
          items={progressModal.items}
          current={progressModal.current}
          total={progressModal.total}
          visible={progressModal.visible}
          onClose={progressModal.onClose}
        />
      )}
    </div>
  )
}
