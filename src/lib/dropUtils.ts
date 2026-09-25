// Общие утилиты drag&drop для MyFilesPage + UploadPage (чтобы копии логики не расходились).

/** Лимит temp-fallback: содержимое пишется чанками через IPC — больше лимита не берём (защита disk/RAM). */
export const MAX_DROP_TEMP_BYTES = 2 * 1024 * 1024 * 1024 // 2GB
/** Целевой размер чанка temp-записи: агрегируем куски File.stream() (обычно ~64KB) до 4MB. */
const DROP_TEMP_CHUNK_BYTES = 4 * 1024 * 1024

export interface DroppedFile {
  filePath: string
  fileName: string
  fileSize: number
  objectUrl?: string
}

export interface ExtractDroppedResult {
  dropped: DroppedFile[]
  count: number
  skippedNoPath: number
  skippedDirs: number
  skippedTooLarge: number
}

/**
 * Имена каталогов среди dropped items.
 * ВАЖНО: вызывать СИНХРОННО внутри drop-event, пока DataTransferItem ещё валиденны
 * (webkitGetAsEntry существует только на DataTransferItem, не на File).
 * Regex «нет расширения → папка» НЕ используем: даёт ложные срабатывания
 * на README, LICENSE, «Отчёт» и т.п. Если entry недоступны — возвращаем пустой set
 * (directory-skip пропускается; main сам вернёт внятную ошибку на каталог).
 */
export function collectDirectoryNames(e: { dataTransfer: DataTransfer | null }): Set<string> {
  const dirNames = new Set<string>()
  try {
    const items = e.dataTransfer ? Array.from(e.dataTransfer.items) : []
    for (const item of items) {
      if (item.kind !== 'file') continue
      const entry: any = (item as any).webkitGetAsEntry?.()
      if (entry?.isDirectory && entry.name) dirNames.add(entry.name)
    }
  } catch {}
  return dirNames
}

/**
 * Копирует File во временный файл чанками (REWORK#2): dropTempOpen → file.stream() →
 * dropTempWrite → dropTempClose в finally (close даже при ошибке write).
 * НЕ используем file.arrayBuffer(): пик RAM ограничен размером чанка (4MB + служебные
 * копии), а не 2× размера файла; main пишет через async FileHandle и не фризится.
 * Возвращает temp-path или '' при ошибке (частичный файл остаётся в temp — чистит ОС).
 */
async function saveFileToTempChunked(file: File): Promise<string> {
  const open = await window.electronAPI.dropTempOpen(file.name, file.size)
  if (!open.success || !open.data?.tempId) {
    console.warn('[drop] temp open failed', file.name, open.error)
    return ''
  }
  const { tempId, filePath } = open.data
  let ok = true
  let chunks = 0
  let bytes = 0
  const reader = file.stream().getReader()
  let parts: Uint8Array[] = []
  let pendingBytes = 0

  const flush = async () => {
    if (!ok || pendingBytes === 0) return
    let chunk: Uint8Array
    if (parts.length === 1) {
      chunk = parts[0]
    } else {
      chunk = new Uint8Array(pendingBytes)
      let off = 0
      for (const p of parts) { chunk.set(p, off); off += p.byteLength }
    }
    parts = []
    pendingBytes = 0
    const w = await window.electronAPI.dropTempWrite(tempId, chunk)
    if (w.success) {
      chunks++
      bytes += chunk.byteLength
    } else {
      ok = false
      console.warn('[drop] temp write failed', file.name, w.error)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      parts.push(value)
      pendingBytes += value.byteLength
      if (pendingBytes >= DROP_TEMP_CHUNK_BYTES) await flush()
      if (!ok) break
    }
    if (ok) await flush()
  } catch (err) {
    ok = false
    console.warn('[drop] temp stream threw', file.name, err)
  } finally {
    try { await reader.cancel() } catch {}
    const closed = await window.electronAPI.dropTempClose(tempId)
    if (!closed.success) {
      ok = false
      console.warn('[drop] temp close failed', file.name, closed.error)
    }
  }

  if (!ok) return ''
  console.log(`[drop] via temp chunks=${chunks} bytes=${bytes}`, file.name)
  return filePath
}

/**
 * Собирает файлы из drop-event с unified-логированием `[drop] …` / `via=webUtils|temp|none`.
 *
 * Каналы получения filePath:
 *  1. webUtils.getPathForFile (preload) — основной;
 *  2. (file as any).path — Electron <32 only (удалено в Electron 32), мёртвый в 33, не полагаемся;
 *  3. temp-fallback: пустой path (известный баг macOS Sequoia, electron/electron#44600) —
 *     копируем содержимое File чанками во временный файл через main
 *     (`file:drop-temp-open/write/close`) и грузим по temp-path.
 */
export async function extractDroppedFiles(
  e: { dataTransfer: DataTransfer | null },
  handler: string,
  opts?: { objectUrls?: boolean },
): Promise<ExtractDroppedResult> {
  // Синхронно, до любых await — entry переживают только сам event
  const dirNames = collectDirectoryNames(e)
  const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : []
  console.log('[drop] drop fired', { handler, count: files.length, dirs: dirNames.size })

  const dropped: DroppedFile[] = []
  let skippedNoPath = 0
  let skippedDirs = 0
  let skippedTooLarge = 0

  for (const file of files) {
    if (dirNames.has(file.name)) {
      console.warn('[drop] directory entry', file.name)
      skippedDirs++
      continue
    }

    let filePath = ''
    let via = 'none'
    try { filePath = window.electronAPI.getPathForFile(file) || '' } catch {}
    if (filePath) {
      via = 'webUtils'
    } else {
      // Electron <32 only: File.path удалён в Electron 32 (в 33 не существует) —
      // оставлено как случайный выигрыш на старых версиях, НЕ основной канал.
      const legacyPath = (file as any).path || ''
      if (legacyPath) {
        filePath = legacyPath
        via = 'file.path(<32)'
      }
    }

    if (!filePath) {
      if (file.size > MAX_DROP_TEMP_BYTES) {
        console.warn('[drop] too large for temp fallback', file.name, file.size)
        console.log('[drop] via=none(too-large)', file.name, file.size)
        skippedTooLarge++
        continue
      }
      try {
        const tempPath = await saveFileToTempChunked(file)
        if (tempPath) {
          filePath = tempPath
          via = 'temp'
        } else {
          console.warn('[drop] temp save failed', file.name)
        }
      } catch (err) {
        console.warn('[drop] temp save threw', file.name, err)
      }
    }

    console.log('[drop] file', {
      name: file.name,
      size: file.size,
      path: filePath ? `len:${filePath.length}` : 'EMPTY',
      via,
    })
    console.log('[drop] via=' + via, file.name)

    if (!filePath) {
      skippedNoPath++
      continue
    }

    let objectUrl: string | undefined
    if (opts?.objectUrls && (file.type.startsWith('image/') || file.type.startsWith('video/') || file.name.match(/\.(heic|heif)$/i))) {
      try { objectUrl = URL.createObjectURL(file) } catch {}
    }
    dropped.push({ filePath, fileName: file.name, fileSize: file.size, objectUrl })
  }

  return { dropped, count: files.length, skippedNoPath, skippedDirs, skippedTooLarge }
}
