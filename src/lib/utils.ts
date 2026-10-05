import { parseDateFromName } from './dateParser'

export function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export function typeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', ico: 'image', avif: 'image', heic: 'image', heif: 'image',
    mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video', flv: 'video',
    mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', wma: 'audio', m4a: 'audio',
    pdf: 'document', doc: 'document', docx: 'document', txt: 'document', rtf: 'document', odt: 'document', xls: 'document', xlsx: 'document', ppt: 'document', pptx: 'document', csv: 'document',
    zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
    exe: 'program', msi: 'program', dmg: 'program', apk: 'program', deb: 'program',
  }
  return map[ext] || 'other'
}

export function fileDate(f: any): number {
  return f.uploadedAt || f.originalDate || 0
}

export function effectiveDate(f: any): number {
  return parseDateFromName(f.fileName || '') || f.originalDate || f.uploadedAt || 0
}

export function groupByDay(items: any[]) {
  const years: Record<number, Record<number, Record<number, any[]>>> = {}
  items.forEach(f => {
    const ts = effectiveDate(f)
    if (!ts) return
    const d = new Date(ts * 1000)
    if (!isFinite(d.getTime())) return
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate()
    if (!years[y]) years[y] = {}
    if (!years[y][m]) years[y][m] = {}
    if (!years[y][m][day]) years[y][m][day] = []
    years[y][m][day].push(f)
  })
  return years
}

/**
 * Returns a resolution label for a given video height.
 * Returns null if height is undefined or below 480p.
 */
export function resolutionLabel(height?: number): string | null {
  if (!height || height < 480) return null
  if (height >= 2160) return '4K'
  if (height >= 1440) return '1440p'
  if (height >= 1080) return '1080p'
  if (height >= 720) return '720p'
  return '480p'
}

/** Counter of active programmatic scrolls (jumps). Incremented by markProgrammaticScroll, decremented by clearProgrammaticScroll. */
let _programmaticScrollCount = 0

/** Counter of active rail-initiated scrolls. Incremented by markRailScroll, decremented by clearRailScroll. */
let _railScrollCount = 0

/** Increment programmatic scroll counter. Call before each programmatic scroll (scrollIntoView, scrollTop set). */
export const markProgrammaticScroll = (): void => {
  _programmaticScrollCount++
}

/** Decrement programmatic scroll counter. Call after programmatic scroll completes (in rAF/finally). */
export const clearProgrammaticScroll = (): void => {
  _programmaticScrollCount = Math.max(0, _programmaticScrollCount - 1)
}

/** Check if any programmatic scroll is in progress. */
export const isProgrammaticScroll = (): boolean => _programmaticScrollCount > 0

/** Increment rail scroll counter (also increments programmatic counter). Call before each rail-initiated programmatic scroll. */
export const markRailScroll = (): void => {
  _railScrollCount++
  markProgrammaticScroll()
}

/** Decrement rail scroll counter (also decrements programmatic counter). Call after rail-initiated programmatic scroll completes. */
export const clearRailScroll = (): void => {
  _railScrollCount = Math.max(0, _railScrollCount - 1)
  clearProgrammaticScroll()
}

/** Check if any rail-initiated scroll is in progress. Used to gate prepend/bottom-growth during jumps. */
export const isRailScrollActive = (): boolean => _railScrollCount > 0
