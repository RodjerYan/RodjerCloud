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
  return f.originalDate || f.uploadedAt || 0
}

export function groupByDay(items: any[]) {
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
