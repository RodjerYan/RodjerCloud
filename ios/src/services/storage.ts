/**
 * Локальное хранилище для iOS (аналог src/lib/v3store.ts)
 *
 * На iOS использует @react-native-async-storage/async-storage
 * или UserDefaults (через expo-secure-store для чувствительных данных)
 *
 * Ключи:
 * v3.trash, v3.favs, v3.shared, v3.activity, v3.tags, v3.fileTags,
 * v3.notes, v3.albums, v3.meta, v3.prefs, v3.smartFilters,
 * v3.recent, v3.thumbCache, v3.audit
 */

export type TrashItem = { messageId: number; fileName: string; size: number; deletedAt: number }
export type FavItem = { messageId: number; fileName: string; addedAt: number }
export type SharedLink = { id: string; fileName: string; messageId: number; createdAt: number; expiresAt?: number; password?: string; useCount: number }
export type ActivityEntry = { id: string; type: 'upload'|'download'|'delete'|'rename'|'share'|'tag'|'login'|'lock'; message: string; ts: number }
export type TagEntry = { name: string; color: string; createdAt: number }
export type FileTag = { messageId: number; tags: string[] }
export type NoteEntry = { messageId: number; markdown: string; updatedAt: number }
export type AlbumEntry = { id: string; name: string; messageIds: number[]; createdAt: number }
export type FileMeta = { messageId: number; pinned?: boolean; color?: string; folder?: string }

export class StorageService {
  static async hasSession(): Promise<boolean> { return false }
  static async saveSession(session: string): Promise<void> {}
  static async getSession(): Promise<string | null> { return null }
  static async clearSession(): Promise<void> {}

  static async get<T>(key: string, def: T): Promise<T> { return def }
  static async set<T>(key: string, value: T): Promise<void> {}
}
