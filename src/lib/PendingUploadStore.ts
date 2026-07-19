export interface PendingUpload {
  id: string;
  fileName: string;
  progress: number;
  sent?: number;
  total?: number;
  folderId?: string | null;
  objectUrl?: string;
}

export const pendingStore = {
  uploads: [] as PendingUpload[],
  listeners: new Set<Function>(),
  subscribe(fn: Function) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },
  add(items: PendingUpload[]) {
    this.uploads.push(...items)
    this.notify()
  },
  remove(id: string) {
    this.uploads = this.uploads.filter(u => u.id !== id)
    this.notify()
  },
  updateProgress(d: any) {
    const idx = this.uploads.findIndex(p => p.id === d.id)
    if (idx !== -1) {
      this.uploads[idx] = { 
        ...this.uploads[idx], 
        progress: d.percent, 
        sent: d.sent !== undefined ? d.sent : this.uploads[idx].sent, 
        total: d.total !== undefined ? d.total : this.uploads[idx].total 
      }
      this.notify()
    }
  },
  notify() {
    const copy = [...this.uploads]
    for (const l of this.listeners) l(copy)
  }
}

if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI.telegram.onUploadProgress((d: any) => {
    if (d.id) pendingStore.updateProgress(d)
  })
}
