import { toast } from './toast'

// T-20260925-002 S1: единый feedback для скачивания из любого места приложения.
// Эталон — MyFilesPage.handleDownload (toast.info до await, try/catch,
// cancelled → info, fail → error). IPC telegram:download-file возвращает
// { success, data?: { filePath, fileName }, error?: string } (index.ts ~1040).
export async function downloadFileWithFeedback(
  f: { messageId: number; fileName: string },
  e?: { stopPropagation?: () => void },
) {
  e?.stopPropagation?.()
  toast.info('Скачивание: ' + f.fileName + '…')
  try {
    const r = await window.electronAPI.telegram.downloadFile(f.messageId, f.fileName)
    if (r?.success) {
      toast.success('Файл сохранён' + (r.data?.filePath ? ': ' + r.data.filePath : ''))
    } else if (r?.error === 'cancelled') {
      toast.info('Скачивание отменено')
    } else {
      toast.error(r?.error || 'Ошибка скачивания')
    }
  } catch (err: any) {
    toast.error('Ошибка скачивания: ' + (err?.message || String(err || '')))
  }
}
