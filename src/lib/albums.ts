

export interface SmartAlbum { id: string; name: string; filter?: (f: any) => boolean; isDuplicates?: boolean }

export const SMART_ALBUMS: SmartAlbum[] = [
  { id: '_photos', name: 'Мои фото', filter: (f) => f.mimeType?.startsWith('image/') },
  { id: '_videos', name: 'Видео', filter: (f) => f.mimeType?.startsWith('video/') },
  { id: '_screenshots', name: 'Скриншоты', filter: (f) => /screenshot|screen.?shot|скрин|снимок|snip|capture|print.?screen|^img_\d{4,}\.png$|^image\.png$/i.test(f.fileName) },
  { id: '_duplicates', name: 'Дубликаты', isDuplicates: true },
]
