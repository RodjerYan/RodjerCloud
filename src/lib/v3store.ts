// RodjerCloud — lightweight IndexedDB-backed stores with in-memory cache for fast sync reads
import { db } from './db'

export type TrashItem = { messageId: number; fileName: string; size: number; deletedAt: number }
export type FavItem = { messageId: number; fileName: string; addedAt: number }
export type SharedLink = { id: string; fileName: string; messageId: number; createdAt: number; expiresAt?: number; password?: string; useCount: number }
export type ActivityEntry = { id: string; type: "upload"|"download"|"delete"|"rename"|"share"|"tag"|"login"|"lock"; message: string; ts: number }
export type TagEntry = { name: string; color: string; createdAt: number }
export type FileTag = { messageId: number; tags: string[] }
export type NoteEntry = { messageId: number; markdown: string; updatedAt: number }
export type AlbumEntry = { id: string; name: string; messageIds: number[]; createdAt: number }
export type FileMeta = { messageId: number; pinned?: boolean; color?: string; folder?: string; hash?: string; displayName?: string }
export type ColorLabel = "red"|"orange"|"yellow"|"green"|"blue"|"purple"

const K = {
  trash: "v3.trash", favs: "v3.favs", shared: "v3.shared", activity: "v3.activity",
  tags: "v3.tags", fileTags: "v3.fileTags", notes: "v3.notes", albums: "v3.albums",
  meta: "v3.meta", prefs: "v3.prefs", smart: "v3.smartFilters", recent: "v3.recent",
  thumbs: "v3.thumbCache", audit: "v3.audit"
}

// In-memory cache for synchronous reads
const cache: Record<string, any> = {}

// Asynchronous initialization from IndexedDB (with fallback migration from localStorage)
export async function initStore() {
  const keys = Object.values(K)
  for (const k of keys) {
    const entry = await db.kv.get(k)
    if (entry && entry.value) {
      cache[k] = entry.value
    } else {
      // Migrate from localStorage if exists
      try {
        const lsValue = localStorage.getItem(k)
        if (lsValue) {
          const parsed = JSON.parse(lsValue)
          cache[k] = parsed
          await db.kv.put({ key: k, value: parsed })
        }
      } catch (e) {
        console.error("Migration error for", k, e)
      }
    }
  }
}

function get<T>(k: string, def: T): T {
  return cache[k] !== undefined ? cache[k] : def
}

function set<T>(k: string, v: T) {
  cache[k] = v
  // Async persist to IndexedDB without blocking UI thread
  db.kv.put({ key: k, value: JSON.parse(JSON.stringify(v)) }).catch(e => console.error("DB Save Error:", e))
}

function stateJson(): string {
  return JSON.stringify({
    trash: get(K.trash, []), favs: get(K.favs, []), shared: get(K.shared, []),
    activity: get(K.activity, []), tags: get(K.tags, []), fileTags: get(K.fileTags, []),
    notes: get(K.notes, []), albums: get(K.albums, []), meta: get(K.meta, []),
    prefs: get(K.prefs, {}), smart: get(K.smart, []), recent: get(K.recent, []),
  })
}

let syncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    window.electronAPI?.state?.sync(stateJson()).catch(() => {})
  }, 2000)
}

export async function loadStateFromTelegram() {
  try {
    const r = await window.electronAPI.state.load()
    if (r.success && r.data) {
      const s = JSON.parse(r.data)
      if (s.trash) set(K.trash, s.trash)
      if (s.favs) set(K.favs, s.favs)
      if (s.shared) set(K.shared, s.shared)
      if (s.activity) set(K.activity, s.activity)
      if (s.tags) set(K.tags, s.tags)
      if (s.fileTags) set(K.fileTags, s.fileTags)
      if (s.notes) set(K.notes, s.notes)
      if (s.albums) set(K.albums, s.albums)
      if (s.meta) set(K.meta, s.meta)
      if (s.prefs) set(K.prefs, s.prefs)
      if (s.smart) set(K.smart, s.smart)
      if (s.recent) set(K.recent, s.recent)
    }
  } catch {}
}

export const v3store = {
  init: initStore,
  // trash
  getTrash: (): TrashItem[] => get(K.trash, []),
  addTrash: (it: TrashItem) => { const a = v3store.getTrash(); a.unshift(it); set(K.trash, a); scheduleSync() },
  removeTrash: (id: number) => { set(K.trash, v3store.getTrash().filter(x => x.messageId !== id)); scheduleSync() },
  clearOldTrash: () => { const cutoff = Date.now() - 30*864e5; set(K.trash, v3store.getTrash().filter(x => x.deletedAt > cutoff)); scheduleSync() },
  // favorites
  getFavs: (): FavItem[] => get(K.favs, []),
  isFav: (id: number) => v3store.getFavs().some(f => f.messageId === id),
  toggleFav: (it: FavItem) => { const a = v3store.getFavs(); const i = a.findIndex(f => f.messageId === it.messageId); if (i >= 0) a.splice(i, 1); else a.unshift(it); set(K.favs, a); scheduleSync(); return i < 0 },
  // shared links
  getShared: (): SharedLink[] => get(K.shared, []),
  addShared: (s: SharedLink) => { const a = v3store.getShared(); a.unshift(s); set(K.shared, a); scheduleSync() },
  removeShared: (id: string) => { set(K.shared, v3store.getShared().filter(x => x.id !== id)); scheduleSync() },
  bumpShared: (id: string) => { const a = v3store.getShared(); const t = a.find(x => x.id === id); if (t) { t.useCount++; set(K.shared, a); scheduleSync() } },
  // activity
  getActivity: (): ActivityEntry[] => get(K.activity, []),
  logActivity: (type: ActivityEntry["type"], message: string) => {
    const a = v3store.getActivity(); a.unshift({ id: Math.random().toString(36).slice(2), type, message, ts: Date.now() })
    if (a.length > 2000) a.length = 2000; set(K.activity, a); scheduleSync()
  },
  clearActivity: () => { set(K.activity, []); scheduleSync() },
  // tags
  getTags: (): TagEntry[] => get(K.tags, []),
  addTag: (t: TagEntry) => { const a = v3store.getTags(); if (!a.find(x => x.name === t.name)) { a.push(t); set(K.tags, a); scheduleSync() } },
  removeTag: (name: string) => { set(K.tags, v3store.getTags().filter(t => t.name !== name)); scheduleSync() },
  getFileTags: (): FileTag[] => get(K.fileTags, []),
  setFileTags: (messageId: number, tags: string[]) => {
    const a = v3store.getFileTags(); const i = a.findIndex(x => x.messageId === messageId)
    if (i >= 0) a[i].tags = tags; else a.push({ messageId, tags }); set(K.fileTags, a); scheduleSync()
  },
  tagsForFile: (messageId: number): string[] => v3store.getFileTags().find(x => x.messageId === messageId)?.tags || [],
  // notes
  getNotes: (): NoteEntry[] => get(K.notes, []),
  noteFor: (messageId: number): NoteEntry | undefined => v3store.getNotes().find(n => n.messageId === messageId),
  setNote: (messageId: number, markdown: string) => {
    const a = v3store.getNotes(); const i = a.findIndex(x => x.messageId === messageId)
    if (i >= 0) a[i] = { messageId, markdown, updatedAt: Date.now() }
    else a.push({ messageId, markdown, updatedAt: Date.now() }); set(K.notes, a); scheduleSync()
  },
  removeNote: (messageId: number) => { set(K.notes, v3store.getNotes().filter(n => n.messageId !== messageId)); scheduleSync() },
  // albums
  getAlbums: (): AlbumEntry[] => get(K.albums, []),
  addAlbum: (a: AlbumEntry) => { const arr = v3store.getAlbums(); arr.push(a); set(K.albums, arr); scheduleSync() },
  removeAlbum: (id: string) => { set(K.albums, v3store.getAlbums().filter(a => a.id !== id)); scheduleSync() },
  updateAlbum: (id: string, patch: Partial<AlbumEntry>) => { const arr = v3store.getAlbums(); const i = arr.findIndex(a => a.id === id); if (i >= 0) { arr[i] = { ...arr[i], ...patch }; set(K.albums, arr); scheduleSync() } },
  addToAlbum: (id: string, messageId: number) => { const arr = v3store.getAlbums(); const a = arr.find(x => x.id === id); if (a && !a.messageIds.includes(messageId)) { a.messageIds.push(messageId); set(K.albums, arr); scheduleSync() } },
  removeFromAlbum: (id: string, messageId: number) => { const arr = v3store.getAlbums(); const a = arr.find(x => x.id === id); if (a) { a.messageIds = a.messageIds.filter(m => m !== messageId); set(K.albums, arr); scheduleSync() } },
  // file meta (pin, color, folder)
  getMeta: (): FileMeta[] => get(K.meta, []),
  setMeta: (m: FileMeta) => { const a = v3store.getMeta(); const i = a.findIndex(x => x.messageId === m.messageId); if (i >= 0) a[i] = { ...a[i], ...m }; else a.push(m); set(K.meta, a); scheduleSync() },
  metaFor: (id: number): FileMeta | undefined => v3store.getMeta().find(m => m.messageId === id),
  // preferences (theme, accent, density, animations, font)
  getPrefs: () => get(K.prefs, { theme: "dark", accent: "cyan-purple", density: "comfortable", animations: "full", font: "inter", sidebarCollapsed: false }),
  setPrefs: (p: any) => { set(K.prefs, { ...v3store.getPrefs(), ...p }); scheduleSync() },
  // smart filters
  getSmart: () => get(K.smart, [] as Array<{ name: string; query: string; type?: string; minSize?: number; maxSize?: number; days?: number }>),
  addSmart: (f: any) => { const a = v3store.getSmart(); a.push(f); set(K.smart, a); scheduleSync() },
  removeSmart: (name: string) => { set(K.smart, v3store.getSmart().filter(f => f.name !== name)); scheduleSync() },
  // recent
  getRecent: (): number[] => get(K.recent, []),
  pushRecent: (id: number) => { let a = v3store.getRecent().filter(x => x !== id); a.unshift(id); if (a.length > 20) a = a.slice(0, 20); set(K.recent, a); scheduleSync() },
  // audit log
  getAudit: () => get(K.audit, [] as Array<{ event: string; ts: number }>),
  logAudit: (event: string) => { const a = v3store.getAudit(); a.unshift({ event, ts: Date.now() }); if (a.length > 1000) a.length = 1000; set(K.audit, a); scheduleSync() },
}

export { fmtSize as fmtBytes } from './utils'
export function fmtTime(ms: number): string {
  if (!ms || !isFinite(ms) || ms < 0) return "--"
  const s = Math.round(ms/1000); if (s < 60) return s+"s"
  const m = Math.floor(s/60), r = s%60; if (m < 60) return m+"m "+r+"s"
  const h = Math.floor(m/60), rm = m%60; return h+"h "+rm+"m"
}
