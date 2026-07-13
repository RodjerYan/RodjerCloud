import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {   Search, Grid, List as ListIcon, Download, Trash2, Copy, Eye, X, ChevronLeft, ChevronRight, ChevronDown, ArrowLeft, Play, Star,
  Image, Film, Music, FileText, Archive, Folder, Clock, FolderPlus, MoveRight, Pencil, Share2, Upload } from 'lucide-react'
import { v3store } from '../lib/v3store'
import { SMART_ALBUMS } from '../lib/albums'
import { Player } from '@lottiefiles/react-lottie-player'
import { appConfirm } from '../lib/dialogs'
import { fmtSize } from '../lib/utils'

const SIX_HOURS = 21600

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

function typeOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'avif'].includes(ext)) return 'Изображения'
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return 'Видео'
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return 'Аудио'
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext)) return 'Документы'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'Архивы'
  return 'Другое'
}

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

function fileDate(f: any): number {
  return f.originalDate || f.uploadedAt || 0
}

function groupByDay(items: any[]) {
  const years: Record<number, Record<number, Record<number, any[]>>> = {}
  items.forEach(f => {
    const d = new Date(fileDate(f) * 1000)
    if (!isFinite(d.getTime())) return
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate()
    if (!years[y]) years[y] = {}
    if (!years[y][m]) years[y][m] = {}
    if (!years[y][m][day]) years[y][m][day] = []
    years[y][m][day].push(f)
  })
  return years
}

export default function MyFilesPage() {
  const navigate = useNavigate()
  const [files, setFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'name' | 'size' | 'date'>('date')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<{ idx: number; list: any[] } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [previewIsVideo, setPreviewIsVideo] = useState(false)
  const [toast, setToast] = useState<string>('')
  const [drillDown, setDrillDown] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())
  const [folders, setFolders] = useState<any[]>([])
  const [fileFolders, setFileFolders] = useState<Record<number, string>>({})
  const [folderDrill, setFolderDrill] = useState<string | null>(null)
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
  const [favs, setFavs] = useState(v3store.getFavs())
  const [renameTarget, setRenameTarget] = useState<any>(null)
  const [renameInput, setRenameInput] = useState('')
  const [showSub, setShowSub] = useState<string | null>(null)

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
          })
        })
      }
    })
  }, [])

  useEffect(() => { window.electronAPI.tgs.read('duck.tgs').then((r: any) => { if (r.success) setDuckAnim(r.data) }) }, [])

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null)
      if (e.key === 'ArrowLeft') navPreview(-1)
      if (e.key === 'ArrowRight') navPreview(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const loadFolders = async () => {
    const r = await window.electronAPI.folders.loadFromTelegram()
    if (r.success) { setFolders(r.data.folders || []); setFileFolders(r.data.fileFolders || {}) }
  }

  const createFolder = () => { setShowCreateFolder(true); setNewFolderName('') }
  const confirmCreateFolder = async () => {
    if (!newFolderName.trim()) return
    const r = await window.electronAPI.folders.create(newFolderName.trim(), folderDrill)
    setShowCreateFolder(false)
    if (r.success) { setFolders(r.data.folders || []); setFileFolders(r.data.fileFolders || {}); showToast('Папка создана') }
  }

  const deleteFolder = async (id: string) => {
    if (!(await appConfirm('Удалить папку? Файлы останутся в общем списке.'))) return
    const r = await window.electronAPI.folders.delete(id)
    if (r.success) { setFolders(r.data.folders || []); setFileFolders(r.data.fileFolders || {}) }
    if (folderDrill === id) setFolderDrill(null)
  }

  const renameFolder = async (id: string) => {
    if (!renameVal.trim()) return
    const r = await window.electronAPI.folders.rename(id, renameVal.trim())
    setRenameId(null)
    if (r.success) { setFolders(r.data.folders || []); setFileFolders(r.data.fileFolders || {}) }
  }

  const moveFileToFolder = (messageId: number) => { setMoveTarget([messageId]) }
  const bulkMoveToFolder = () => { if (selected.size > 0) setMoveTarget(Array.from(selected)) }
  const confirmMoveFile = async (target: string) => {
    if (!moveTarget || moveTarget.length === 0) return
    for (const id of moveTarget) {
      if (target.startsWith('cat:')) {
        await window.electronAPI.folders.removeFile(id)
      } else {
        await window.electronAPI.folders.moveFile(id, target)
      }
    }
    setMoveTarget(null)
    clearSelection()
    loadFolders()
  }

  const loadThumbs = useCallback(async (files: any[]) => {
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
    setThumbs(prev => ({ ...prev, ...map }))
  }, [])

  const load = async () => {
    setLoading(true)
    const r = await window.electronAPI.telegram.listFiles()
    if (r.success) setFiles(r.data || [])
    setLoading(false)
  }

  // Shared helper: upload files from OS drop or dialog and assign to a folder
  const uploadDroppedFiles = async (dropped: { filePath: string; fileName: string }[], targetFolderId?: string | null) => {
    if (dropped.length === 0) return
    setDropProgress({ current: 0, total: dropped.length, pct: 0 })
    for (let i = 0; i < dropped.length; i++) {
      setDropProgress(prev => prev ? { ...prev, current: i, pct: 0 } : null)
      await window.electronAPI.telegram.uploadFile(dropped[i].filePath).then(async (res: any) => {
        if (res.success && res.data?.hash) v3store.setMeta({ messageId: res.data.messageId, hash: res.data.hash })
        if (res.success && res.data?.messageId && targetFolderId) {
          await window.electronAPI.folders.addFile(targetFolderId, res.data.messageId)
        }
      })
    }
    setDropProgress({ current: dropped.length, total: dropped.length, pct: 100 })
    loadFolders()
    load()
    dropDoneRef.current = setTimeout(() => setDropProgress(null), 1200)
  }

  const uploadToFolder = async (folderId: string) => {
    const pick = await window.electronAPI.dialog.pickMultipleFiles()
    if (!pick.success || !pick.data?.length) return
    await uploadDroppedFiles(pick.data.map((f: any) => ({ filePath: f.filePath, fileName: f.fileName })), folderId)
  }

  useEffect(() => { load(); loadFolders() }, [])

  useEffect(() => {
    const interval = setInterval(() => loadFolders(), 3000)
    return () => clearInterval(interval)
  }, [])

  const now = Math.floor(Date.now() / 1000)
  const SIX_HOURS = 21600

  const filtered = useMemo(() => {
    let arr = [...files]
    if (search) arr = arr.filter(f => (f.fileName || '').toLowerCase().includes(search.toLowerCase()))
    arr.sort((a, b) => {
      if (sort === 'name') return (a.fileName || '').localeCompare(b.fileName || '')
      if (sort === 'size') return (b.fileSize || 0) - (a.fileSize || 0)
      return (fileDate(b) || 0) - (fileDate(a) || 0)
    })
    return arr
  }, [files, search, sort])

  const grouped = useMemo(() => {
    const ffset = new Set(Object.keys(fileFolders).map(Number))
    const map: Record<string, any[]> = {}
    CATEGORIES.forEach(c => { map[c] = [] })
    filtered.forEach(f => {
      if (ffset.has(f.messageId)) return
      const fd = fileDate(f)
      if (fd > 0 && (now - fd) < SIX_HOURS) map['Недавние']?.push(f)
      map[typeOf(f.fileName)]?.push(f)
    })
    return map
  }, [filtered, now, fileFolders])

  const galleryFiles = useMemo(() => {
    if (!drillDown) return []
    const ffset = new Set(Object.keys(fileFolders).map(Number))
    return filtered.filter(f => typeOf(f.fileName) === drillDown && !ffset.has(f.messageId))
  }, [drillDown, filtered, fileFolders])

  const galleryByDay = useMemo(() => groupByDay(galleryFiles), [galleryFiles])

  useEffect(() => {
    if (drillDown) {
      const ffset = new Set(Object.keys(fileFolders).map(Number))
      const ddFiles = filtered.filter(f => typeOf(f.fileName) === drillDown && !ffset.has(f.messageId))
      loadThumbs(ddFiles)
    } else {
      setThumbs({})
    }
  }, [drillDown, filtered, loadThumbs, fileFolders])

  const showToast = (s: string) => { setToast(s); setTimeout(() => setToast(''), 3000) }

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s
    })
  }
  const clearSelection = () => setSelected(new Set())

  const handleDownload = async (f: any) => {
    showToast('Скачивание ' + f.fileName)
    const r = await window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
    showToast(r.success ? 'Сохранено: ' + (r.data?.filePath || f.fileName) : 'Ошибка скачивания')
  }
  const handleDelete = async (f: any) => {
    if (!(await appConfirm('Переместить ' + f.fileName + ' в корзину?'))) return
    setDeletingIds(prev => new Set(prev).add(f.messageId))
    showToast('Перемещение в корзину…')
    const r = await window.electronAPI.telegram.deleteFile(f.messageId)
    if (r.success) {
      showToast('Перемещено в корзину')
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
          showToast('Ошибка: ' + (r.error || ''))
        }
      } catch (e: any) {
        setShareProgress(null)
        showToast('Ошибка: ' + (e.message || ''))
      }
    } else {
      const link = `https://t.me/c/${f.chatId || ''}/${f.messageId}`
      await window.electronAPI.app.copyToClipboard(link)
      showToast('Ссылка скопирована (требуется подписка на канал)')
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

  const navPreview = (dir: number) => {
    if (!preview) return
    const all = preview.list.filter((f: any) => {
      const ft = typeOf(f.fileName); return ft === 'Изображения' || ft === 'Видео'
    })
    if (all.length === 0) return
    const curr = all.findIndex((x: any) => x === preview.list[preview.idx])
    const next = (curr + dir + all.length) % all.length
    setPreviewUrl(''); handlePreview(all[next], preview.list.indexOf(all[next]), preview.list)
  }

  const bulkDelete = async () => {
    if (selected.size === 0) return
    if (!(await appConfirm(`Переместить ${selected.size} файлов в корзину?`))) return
    const ids = Array.from(selected)
    setDeletingIds(prev => { const s = new Set(prev); ids.forEach(id => s.add(id)); return s })
    showToast('Перемещение в корзину…')
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

  const [archiveProgress, setArchiveProgress] = useState<{ percent: number; phase: string } | null>(null)
  const [archiveDonePhases, setArchiveDonePhases] = useState<Set<string>>(new Set())

  const handleArchive = async (catOrFolder: string, files: any[]) => {
    if (files.length === 0) return
    setArchiveProgress({ percent: 0, phase: 'downloading' })
    setArchiveDonePhases(new Set())
    const off = window.electronAPI.folders.onArchiveProgress((d) => {
      setArchiveProgress({ percent: d.percent, phase: d.phase })
      setArchiveDonePhases(prev => new Set(prev).add(d.phase))
    })
    const res = await window.electronAPI.folders.archiveAndUpload({
      folderName: catOrFolder,
      files: files.map(f => ({ messageId: f.messageId, fileName: f.fileName })),
    })
    off()
    setArchiveProgress(null)
    showToast(res.success ? `Архив ${catOrFolder}.zip загружен` : 'Ошибка архивации: ' + (res.error || ''))
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

  const [isDragOver, setIsDragOver] = useState(false)
  const [dropProgress, setDropProgress] = useState<{ current: number; total: number; pct: number } | null>(null)
  const dropDoneRef = useRef<NodeJS.Timeout>()
  const dragCounter = useRef(0)

  useEffect(() => {
    const off = window.electronAPI.telegram.onUploadProgress((d: any) => {
      if (!d.id) return
      setDropProgress(prev => prev ? { ...prev, pct: d.percent } : null)
    })
    return () => { off(); clearTimeout(dropDoneRef.current) }
  }, [])

  const onQuickUpload = async () => {
    const r = await window.electronAPI.dialog.pickMultipleFiles()
    if (r.success) navigate('/upload', { state: { initialFiles: r.data } })
  }

  const extractDroppedFiles = (e: React.DragEvent) => {
    const dropped: { filePath: string; fileName: string }[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.electronAPI.getPathForFile(file)
      if (p) dropped.push({ filePath: p, fileName: file.name })
    }
    return dropped
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current = 0; setIsDragOver(false)
    const dropped = extractDroppedFiles(e)
    if (dropped.length === 0) return
    await uploadDroppedFiles(dropped, folderDrill)
  }

  // Recursive file count for a folder (includes files in subfolders)
  const countFilesRecursive = useCallback((folderId: string): number => {
    const directFiles = files.filter((f: any) => fileFolders[f.messageId] === folderId).length
    const childFolders = folders.filter(f => f.parentId === folderId)
    return directFiles + childFolders.reduce((sum, cf) => sum + countFilesRecursive(cf.id), 0)
  }, [files, fileFolders, folders])

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

      <div style={{
        maxHeight: dropProgress ? 48 : 0,
        opacity: dropProgress ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 0.35s ease, opacity 0.3s ease',
        width: '100%',
      }}>
        <div style={{
          width: '100%',
          background: dropProgress && dropProgress.pct >= 100
            ? 'rgba(52,211,153,0.08)'
            : 'rgba(124,131,255,0.08)',
          borderBottom: '1px solid ' + (dropProgress && dropProgress.pct >= 100
            ? 'rgba(52,211,153,0.2)'
            : 'rgba(124,131,255,0.15)'),
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            padding: '8px 16px',
            fontSize: 13, color: dropProgress && dropProgress.pct >= 100 ? '#6ee7b7' : '#bcc0ff',
            fontWeight: 500,
          }}>
            <div style={{
              width: 80, height: 4,
              background: 'rgba(255,255,255,0.08)',
              borderRadius: 2, overflow: 'hidden', flexShrink: 0,
            }}>
              <div style={{
                height: '100%', width: (dropProgress?.pct ?? 0) + '%',
                background: dropProgress && dropProgress.pct >= 100
                  ? 'linear-gradient(90deg, #34d399, #6ee7b7)'
                  : 'linear-gradient(90deg, #7c83ff, #a78bfa)',
                borderRadius: 2,
                transition: 'width 0.25s ease',
                boxShadow: dropProgress && dropProgress.pct >= 100
                  ? '0 0 6px rgba(52,211,153,0.4)'
                  : '0 0 6px rgba(124,131,255,0.4)',
              }} />
            </div>
            {dropProgress && dropProgress.pct >= 100
              ? 'Загрузка завершена'
              : `Загрузка... ${dropProgress?.pct ?? 0}%`}
          </div>
        </div>
      </div>

      <div className="mf-toolbar">
        <div className="mf-search">
          <Search size={16} />
          <input placeholder="Поиск файлов…" value={search} onChange={e => { setSearch(e.target.value) }} />
        </div>

        <button className="v3-btn ghost" onClick={createFolder} title="Создать папку" style={{ padding: '8px 10px', borderColor: 'transparent' }}><FolderPlus size={16} /></button>
      </div>

      <div className="mf-bulkbar" style={{ position: 'sticky', top: 0, zIndex: 50, opacity: selected.size > 0 ? 1 : 0, transform: selected.size > 0 ? 'none' : 'translateY(-100%)', transition: 'opacity 0.25s, transform 0.3s', pointerEvents: selected.size > 0 ? 'auto' : 'none', visibility: selected.size > 0 ? 'visible' : 'hidden' }}>
        <span>Выбрано: {selected.size}</span>
        <button onClick={bulkDownload}><Download size={14} /> Скачать</button>
        <button onClick={bulkMoveToFolder}><MoveRight size={14} /> Переместить</button>
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
                    <tr key={f.messageId} data-mid={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                      draggable={true} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'file', id: f.messageId })) }}>
                      <td><input type="checkbox" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} /></td>
                      <td className="ellip" title={f.fileName}>{f.isEncrypted && '🔒 '}{f.fileName}</td>
                      <td>{fmtSize(f.fileSize)}</td>
                      <td>{new Date((fileDate(f) || 0) * 1000).toLocaleDateString()}</td>
                      <td>
                        <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                        <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={14} /></button>
                        <button title="Переместить" onClick={() => moveFileToFolder(f.messageId)}><MoveRight size={14} /></button>
                        <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              Object.entries(galleryByDay).sort(([a], [b]) => +b - +a).map(([year, months]) => (
                <div key={year} className="mf-gy">
                  <div className="mf-gy-title">{year}</div>
                  {Object.entries(months).sort(([a], [b]) => +b - +a).map(([month, days]) => (
                    <div key={year + '-' + month} className="mf-gm">
                      <div className="mf-gm-month">{MONTHS_RU[+month]}</div>
                      {Object.entries(days).sort(([a], [b]) => +b - +a).map(([day, items]: [string, any]) => (
                        <div key={`${year}-${month}-${day}`} className="mf-gd">
                          <div className="mf-gd-title">{day} {MONTHS_RU[+month]} <span className="mf-gm-count">{items.length}</span></div>
                          <div className="mf-gm-items">
                            {items.map((f: any) => {
                              const thumbUrl = thumbs[f.messageId]
                              const isVideo = drillDown === 'Видео'
                              return (
                                <div key={f.messageId} data-mid={f.messageId} className={'mf-gm-card' + (selected.has(f.messageId) ? ' selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                                  draggable={true} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'file', id: f.messageId })) }}
                                  onDoubleClick={() => { const canPreview = drillDown === 'Изображения' || drillDown === 'Видео'; if (canPreview) handlePreview(f, galleryFiles.indexOf(f), galleryFiles) }}>
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
                                <div className="mf-gm-name" title={f.fileName}>{f.isEncrypted && '🔒 '}{f.fileName}</div>
                                <div className="mf-gm-meta">{fmtSize(f.fileSize)}</div>
                                <div className="mf-gm-actions">
                                  <button title="Скачать" onClick={() => handleDownload(f)}><Download size={13} /></button>
                                  {(drillDown === 'Изображения' || drillDown === 'Видео') && <button title="Просмотр" onClick={() => handlePreview(f, galleryFiles.indexOf(f), galleryFiles)}><Eye size={13} /></button>}
                                  <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={13} /></button>
                                  <button title="Переместить" onClick={() => moveFileToFolder(f.messageId)}><MoveRight size={13} /></button>
                                  <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={13} /></button>
                                </div>
                              </div>
                            )})}
                          </div>
                        </div>
                      ))}
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
                        {items.map((f, i) => (
                          <div key={f.messageId} data-mid={f.messageId} className={'mf-card' + (selected.has(f.messageId) ? ' selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                              draggable={true} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'file', id: f.messageId })) }}
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
                              <button title="Переместить в папку" onClick={() => moveFileToFolder(f.messageId)}><MoveRight size={14} /></button>
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
                            <tr key={f.messageId} data-mid={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                              draggable={true} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'file', id: f.messageId })) }}
                              onDoubleClick={() => { if (cat === 'Изображения' || cat === 'Видео') handlePreview(f, filtered.indexOf(f)) }}>
                              <td><input type="checkbox" checked={selected.has(f.messageId)} onChange={() => toggleSelect(f.messageId)} /></td>
                                  <td className="ellip" title={f.fileName}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Star size={12} fill={v3store.isFav(f.messageId) ? '#fbbf24' : 'transparent'} stroke="currentColor" style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => { v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() }); setFavs(v3store.getFavs()) }} />{f.isEncrypted && '🔒 '}{f.fileName}</span></td>
                              <td>{fmtSize(f.fileSize)}</td>
                              <td>{new Date((fileDate(f) || 0) * 1000).toLocaleDateString()}</td>
                              <td>
                                <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                                {(cat === 'Изображения' || cat === 'Видео') && <button title="Просмотр" onClick={() => handlePreview(f, filtered.indexOf(f))}><Eye size={14} /></button>}
                                <button title="Копировать ссылку" onClick={() => handleCopyLink(f)}><Copy size={14} /></button>
                                <button title="Переместить" onClick={() => moveFileToFolder(f.messageId)}><MoveRight size={14} /></button>
                                <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={14} /></button>
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

          {(folders.length > 0 || folderDrill) && (() => {
            const currentLevelFolders = folders.filter(f => (f.parentId || null) === (folderDrill || null));
            const currentFiles = folderDrill ? files.filter((f: any) => fileFolders[f.messageId] === folderDrill) : [];

            return (
              <div className="mf-section" style={{ marginTop: 4 }}>
                {folderDrill ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--panel)', borderRadius: 8, marginBottom: 8, fontSize: 13, fontWeight: 500 }}>
                    <span style={{ cursor: 'pointer', color: 'var(--text-dim)' }} onClick={() => setFolderDrill(null)}>Мои файлы</span>
                    {(() => {
                      const crumbs = [];
                      let curr = folderDrill;
                      while (curr) {
                        const f = folders.find(x => x.id === curr);
                        if (f) {
                          crumbs.unshift(f);
                          curr = f.parentId;
                        } else break;
                      }
                      return crumbs.map(c => (
                        <React.Fragment key={c.id}>
                          <ChevronRight size={14} style={{ color: 'var(--text-dim)' }} />
                          <span style={{ cursor: 'pointer', color: c.id === folderDrill ? 'var(--text)' : 'var(--text-dim)' }} onClick={() => setFolderDrill(c.id)}>{c.name}</span>
                        </React.Fragment>
                      ));
                    })()}
                  </div>
                ) : (
                  <div className="mf-section-head" style={{ cursor: 'default', opacity: 0.7 }}>
                    <Folder size={14} />
                    <span className="mf-section-title">Папки</span>
                    <span className="mf-section-count">{folders.length}</span>
                  </div>
                )}
                {currentLevelFolders.map(fld => {
                  const ffiles = files.filter((f: any) => fileFolders[f.messageId] === fld.id)
                  return (
                    <div key={fld.id} className={'mf-section'} style={{ paddingLeft: 14 }}
                         data-folder-id={fld.id}
                         draggable={true}
                         onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'folder', id: fld.id })) }}
                         onDragOver={(e) => e.preventDefault()}
                         onDrop={async (e) => {
                           e.preventDefault(); e.stopPropagation(); dragCounter.current = 0; setIsDragOver(false);
                           
                           // Handle OS file dropping
                           if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                             const dropped = extractDroppedFiles(e)
                             if (dropped.length > 0) {
                               await uploadDroppedFiles(dropped, fld.id)
                               return
                             }
                           }

                           // Handle internal drag and drop
                           try {
                             const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                             if (data.type === 'file' && data.id) {
                               await window.electronAPI.folders.moveFile(data.id, fld.id);
                               loadFolders();
                             } else if (data.type === 'folder' && data.id && data.id !== fld.id) {
                               await window.electronAPI.folders.moveFolder(data.id, fld.id);
                               loadFolders();
                             }
                           } catch (err) {}
                         }}>
                      <div className="mf-section-head" onClick={() => setFolderDrill(fld.id)}
                        style={{ '--cat-color': '#7c83ff' } as React.CSSProperties}>
                        <ChevronRight size={14} />
                        <Folder size={16} style={{ color: '#7c83ff' }} />
                        <span className="mf-section-title">{fld.name}</span>
                        <span className="mf-section-count">{countFilesRecursive(fld.id)}</span>
                        {ffiles.length > 0 && <button className="v3-btn ghost" style={{ padding: 4, border: 'none', color: '#7c83ff', fontSize: 11, marginRight: 4 }}
                          onClick={(e) => { e.stopPropagation(); handleArchive(fld.name, ffiles) }} title="Архивировать и загрузить">
                          <Archive size={12} />
                        </button>}
                        <button className="v3-btn ghost" style={{ padding: 4, border: 'none', color: 'var(--v3-text-dim)', fontSize: 11, marginRight: 4 }}
                          onClick={(e) => { e.stopPropagation(); setRenameId(fld.id); setRenameVal(fld.name) }} title="Переименовать">
                          <Pencil size={12} />
                        </button>
                        <button className="v3-btn ghost" style={{ padding: 4, border: 'none', color: '#34d399', fontSize: 11 }}
                          onClick={(e) => { e.stopPropagation(); uploadToFolder(fld.id) }} title="Загрузить в папку">
                          <FolderPlus size={12} />
                        </button>
                        <button className="v3-btn ghost" style={{ padding: 4, border: 'none', color: 'var(--v3-err)', fontSize: 11 }}
                          onClick={(e) => { e.stopPropagation(); deleteFolder(fld.id) }} title="Удалить папку">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  )
                })}
                {folderDrill && (
                  <div style={{ marginTop: 8 }}>
                    {renameId === folderDrill && (() => {
                      const fld = folders.find(x => x.id === folderDrill);
                      return fld ? (
                      <div style={{ padding: '8px 0' }}>
                        <input value={renameVal} onChange={e => setRenameVal(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && renameFolder(fld.id)}
                          style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', color: 'var(--text)', fontSize: 13, width: '100%' }}
                          autoFocus />
                      </div>
                      ) : null;
                    })()}
                    <table className="mf-table">
                      <thead><tr><th>Имя</th><th>Размер</th><th>Дата</th><th>Действия</th></tr></thead>
                      <tbody>
                        {currentLevelFolders.map(sf => (
                          <tr key={sf.id} className="mf-folder-row" style={{ cursor: 'pointer' }}
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
                              onClick={() => setFolderDrill(sf.id)}
                              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, folder: sf }) }}>
                            <td className="ellip"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Folder size={16} style={{ color: '#7c83ff', flexShrink: 0 }} />{sf.name}</span></td>
                            <td style={{ color: 'var(--text-dim)' }}>{countFilesRecursive(sf.id)} файл.</td>
                            <td>{sf.createdAt ? new Date(sf.createdAt * 1000).toLocaleDateString() : '—'}</td>
                            <td>
                              <button title="Переименовать" onClick={(e) => { e.stopPropagation(); setRenameId(sf.id); setRenameVal(sf.name) }}><Pencil size={14} /></button>
                              <button title="Удалить" className="danger" onClick={(e) => { e.stopPropagation(); deleteFolder(sf.id) }}><Trash2 size={14} /></button>
                            </td>
                          </tr>
                        ))}
                        {currentFiles.map(f => (
                          <tr key={f.messageId} data-mid={f.messageId} className={(selected.has(f.messageId) ? 'selected' : '') + (deletingIds.has(f.messageId) ? ' deleting' : '')}
                              draggable={true} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'file', id: f.messageId })) }}
                              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, file: f }) }}>
                            <td className="ellip" title={f.fileName}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Star size={12} fill={v3store.isFav(f.messageId) ? '#fbbf24' : 'transparent'} stroke="currentColor" style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => { v3store.toggleFav({ messageId: f.messageId, fileName: f.fileName, addedAt: Date.now() }); setFavs(v3store.getFavs()) }} />{f.fileName}</span></td>
                            <td>{fmtSize(f.fileSize)}</td>
                            <td>{new Date((fileDate(f) || 0) * 1000).toLocaleDateString()}</td>
                            <td>
                              <button title="Скачать" onClick={() => handleDownload(f)}><Download size={14} /></button>
                              <button title="Переместить" onClick={() => moveFileToFolder(f.messageId)}><MoveRight size={14} /></button>
                              <button title="Удалить" className="danger" onClick={() => handleDelete(f)}><Trash2 size={14} /></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {currentFiles.length === 0 && currentLevelFolders.length === 0 && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 22px', gap: 8 }}>
                      {duckAnim ? (
                        <Player autoplay loop src={duckAnim} style={{ width: 80, height: 80 }} />
                      ) : (
                        <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,200,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🐤</div>
                      )}
                      <span style={{ color: 'var(--v3-text-dim)', fontSize: 12 }}>Папка пуста. Перетащите файлы сюда.</span>
                    </div>}
                  </div>
                )}
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

      {moveTarget !== null && (
        <div className="mf-modal" onClick={() => setMoveTarget(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 24, minWidth: 320, maxHeight: '80vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{moveTarget.length > 1 ? `Переместить ${moveTarget.length} файла(ов)` : 'Переместить файл'}</div>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-dim)', letterSpacing: 0.5, margin: '4px 0', padding: '0 4px' }}>Категории</div>
            {CATEGORIES.map(c => (
              <button key={'cat-'+c} className="v3-btn" onClick={() => confirmMoveFile('cat:'+c)}
                style={{ textAlign: 'left', justifyContent: 'flex-start', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', padding: '9px 12px', borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                {CAT_ICON[c]}
                {c === 'Недавние' ? 'Недавние' : c}
              </button>
            ))}
            {folders.length > 0 && <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-dim)', letterSpacing: 0.5, margin: '8px 0 4px', padding: '0 4px' }}>Папки</div>}
            {folders.map(f => (
              <button key={f.id} className="v3-btn" onClick={() => confirmMoveFile(f.id)}
                style={{ textAlign: 'left', justifyContent: 'flex-start', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', padding: '9px 12px', borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Folder size={16} style={{ flexShrink: 0, color: '#7c83ff' }} />
                {f.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {toast && <div className="mf-toast">{toast}</div>}
      {archiveProgress && (
        <div className="mf-toast" style={{ bottom: 60, display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px', minWidth: 260 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <Archive size={14} style={{ color: '#7c83ff' }} />
            <span style={{ fontWeight: 600, color: '#fff' }}>
              {archiveProgress.phase === 'downloading' ? 'Скачивание файлов' : archiveProgress.phase === 'compressing' ? 'Архивация' : 'Загрузка архива'}
            </span>
            <span style={{ marginLeft: 'auto', color: 'var(--v3-text-dim)', fontSize: 11 }}>{archiveProgress.percent}%</span>
          </div>
          <div className="up-bar" style={{ height: 4 }}>
            <div className="up-bar-fill" style={{ width: archiveProgress.percent + '%', background: '#7c83ff', transition: 'width 0.4s cubic-bezier(0.4,0,0.2,1)' }} />
          </div>
        </div>
      )}

      {renameTarget && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }} onClick={() => setRenameTarget(null)}>
          <div className="v3-card" style={{ padding: 16, minWidth: 300 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Переименовать</div>
            <input className="v3-input" value={renameInput} onChange={e => setRenameInput(e.target.value)} style={{ marginBottom: 10 }} autoFocus />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="v3-btn" onClick={() => setRenameTarget(null)}>Отмена</button>
              <button className="v3-btn primary" onClick={() => {
                v3store.setMeta({ messageId: renameTarget.messageId, displayName: renameInput.trim() || undefined })
                setRenameTarget(null); showToast('Переименовано')
                setFiles(prev => prev.map(f => f.messageId === renameTarget.messageId ? { ...f, fileName: renameInput.trim() || f.fileName } : f))
              }}>Сохранить</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {ctxMenu && createPortal(
        <div className="mf-ctx" style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }}>
          {ctxMenu.type === 'global' && (
            <button onClick={() => { createFolder(); closeCtx() }}>
              <FolderPlus size={14} /> Создать папку
            </button>
          )}
          {ctxMenu.folder && (
            <>
              <button onClick={() => { setRenameId(ctxMenu.folder.id); setRenameVal(ctxMenu.folder.name); closeCtx() }}>
                <Pencil size={14} /> Переименовать
              </button>
              <div className="mf-ctx-divider" />
              <button className="danger" onClick={() => { deleteFolder(ctxMenu.folder.id); closeCtx() }}>
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
              <button onClick={() => { handleDownload(ctxMenu.file); closeCtx() }}>
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
                        showToast(inAlbum ? 'Убрано из «' + a.name + '»' : 'Добавлено в «' + a.name + '»')
                        closeCtx()
                      }} style={{ paddingLeft: 36, fontSize: 12 }}>
                        <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center' }}>
                          {inAlbum ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg> : null}
                        </span>
                      </button>
                    )
                  })}
                </>
              )}
              <button onClick={() => { const f = ctxMenu.file; setRenameInput(f.fileName); setRenameTarget(f); closeCtx() }}>
                <Pencil size={14} /> Переименовать
              </button>
              <div className="mf-ctx-divider" />
              <button className="danger" onClick={() => { handleDelete(ctxMenu.file); closeCtx() }}>
                <Trash2 size={14} /> Удалить
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
