import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import chokidar from 'chokidar'
import { TelegramService } from './telegram-service'

export interface SyncConfig {
  enabled: boolean; mode: 'all' | 'custom'; customPaths: string[]
  fileFilters: { enabled: boolean; extensions: string[] }; excludePatterns: string[]
}

export interface QueueItem {
  id: string; filePath: string; fileName: string; fileSize: number
  status: 'pending' | 'uploading' | 'done' | 'failed'; percent: number; error?: string
}

export interface SyncEvent {
  type: string; file?: string; current?: number; total?: number
  uploaded?: number; failed?: number; error?: string; ts?: number
  queue?: QueueItem[]
}

export class AutoSyncService {
  private watcher: chokidar.FSWatcher | null = null
  private config: SyncConfig
  private tg: TelegramService
  private running = false
  private queue: QueueItem[] = []
  private uploadedCount = 0
  private failedCount = 0
  private log: SyncEvent[] = []
  private maxLog = 200
  private onEvent: ((e: SyncEvent) => void) | null = null
  private uploadedIndex: Set<string> = new Set()
  private trackerDirty = false

  constructor(tg: TelegramService) { this.tg = tg; this.setDefaults() }

  private trackerPath() { return path.join(app.getPath('userData'), 'rodjercloud-uploads.json') }

  loadTracker() {
    try {
      const p = this.trackerPath()
      if (fs.existsSync(p)) {
        const arr: string[] = JSON.parse(fs.readFileSync(p, 'utf8'))
        this.uploadedIndex = new Set(arr)
      }
    } catch {}
  }

  private saveTracker() {
    try {
      fs.writeFileSync(this.trackerPath(), JSON.stringify([...this.uploadedIndex]), 'utf8')
      this.trackerDirty = false
    } catch {}
  }

  private fileKey(fp: string): string {
    try {
      const s = fs.statSync(fp)
      return `${fp}|${s.size}|${Math.floor(s.mtimeMs / 1000)}`
    } catch { return `${fp}|0|0` }
  }

  private isAlreadyUploaded(fp: string): boolean {
    return this.uploadedIndex.has(this.fileKey(fp))
  }

  private markUploaded(fp: string) {
    this.uploadedIndex.add(this.fileKey(fp))
    this.trackerDirty = true
    this.saveTracker()
  }

  private setDefaults() {
    this.config = { enabled: false, mode: 'custom', customPaths: [], fileFilters: { enabled: false, extensions: [] }, excludePatterns: ['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'] }
  }

  setEventCallback(cb: (e: SyncEvent) => void) { this.onEvent = cb }
  private emit(e: SyncEvent) {
    const ev = { ...e, ts: Date.now() }
    this.log.unshift(ev)
    if (this.log.length > this.maxLog) this.log.length = this.maxLog
    this.onEvent?.(ev)
  }

  private emitQueue() { this.emit({ type: 'queue', queue: [...this.queue] }) }

  getConfig() { return { ...this.config } }

  updateConfig(c: Partial<SyncConfig>) {
    this.config = { ...this.config, ...c }
    if (this.running) { this.stop(); if (this.config.enabled) this.start() }
  }

  private getDefaultPaths(): string[] {
    const keys = ['downloads', 'documents', 'pictures', 'videos', 'desktop'] as const
    return keys.map(k => { try { return app.getPath(k) } catch { return '' } }).filter(p => p && fs.existsSync(p))
  }

  private getWatchPaths() {
    return this.config.mode === 'all' ? this.getDefaultPaths() : this.config.customPaths.filter(p => fs.existsSync(p))
  }

  walkFiles(dir: string): string[] {
    const out: string[] = []
    try {
      for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name)
        try {
          const s = fs.statSync(fp)
          if (s.isDirectory()) out.push(...this.walkFiles(fp))
          else if (s.isFile() && this.passesFilters(fp)) out.push(fp)
        } catch {}
      }
    } catch {}
    return out
  }

  private passesFilters(fp: string): boolean {
    if (this.config.fileFilters.enabled && this.config.fileFilters.extensions.length > 0) {
      const ext = path.extname(fp).toLowerCase()
      if (!this.config.fileFilters.extensions.includes(ext)) return false
    }
    for (const p of this.config.excludePatterns) { if (fp.includes(p)) return false }
    try {
      const s = fs.statSync(fp)
      if (s.size === 0 || s.size > 2 * 1024 * 1024 * 1024) return false
    } catch { return false }
    return true
  }

  private shouldUploadFile(fp: string, silent = false): boolean {
    if (this.isAlreadyUploaded(fp)) {
      if (!silent) this.emit({ type: 'skipped', file: path.basename(fp), error: 'Уже загружен ранее' })
      return false
    }
    if (this.config.fileFilters.enabled && this.config.fileFilters.extensions.length > 0) {
      const ext = path.extname(fp).toLowerCase()
      if (!this.config.fileFilters.extensions.includes(ext)) {
        if (!silent) this.emit({ type: 'skipped', file: path.basename(fp), error: `Расширение .${ext} не в списке` })
        return false
      }
    }
    for (const p of this.config.excludePatterns) {
      if (fp.includes(p)) {
        if (!silent) this.emit({ type: 'skipped', file: path.basename(fp), error: `Исключено: ${p}` })
        return false
      }
    }
    try {
      const s = fs.statSync(fp)
      if (s.size === 0) { if (!silent) this.emit({ type: 'skipped', file: path.basename(fp), error: 'Пустой файл' }); return false }
      if (s.size > 2 * 1024 * 1024 * 1024) { if (!silent) this.emit({ type: 'skipped', file: path.basename(fp), error: 'Файл >2GB' }); return false }
    } catch (e) { if (!silent) this.emit({ type: 'skipped', file: path.basename(fp), error: `Ошибка чтения: ${e}` }); return false }
    return true
  }

  private async uploadOne(fp: string) {
    const existing = this.queue.find(q => q.filePath === fp && q.status !== 'done')
    if (existing) return
    if (this.isAlreadyUploaded(fp)) return

    try {
      const stat = fs.statSync(fp)
      const id = Math.random().toString(36).slice(2, 10)
      const item: QueueItem = { id, filePath: fp, fileName: path.basename(fp), fileSize: stat.size, status: 'pending', percent: 0 }
      this.queue.push(item)
      this.emitQueue()
      this.emit({ type: 'uploading', file: path.basename(fp) })

      item.status = 'uploading'
      this.emitQueue()

      await new Promise(r => setTimeout(r, 300))
      if (!fs.existsSync(fp)) { this.queue = this.queue.filter(q => q.id !== id); this.emitQueue(); return }

      await this.tg.uploadFile(fp, (sent, total) => {
        item.percent = Math.round((sent / total) * 100)
        this.emitQueue()
      })

      item.status = 'done'; item.percent = 100
      this.uploadedCount++
      this.markUploaded(fp)
      this.emitQueue()
      this.emit({ type: 'uploaded', file: path.basename(fp) })
    } catch (err: any) {
      console.error(`AutoSync upload error for ${fp}:`, err.message, err.stack)
      this.markUploaded(fp)
      const item = this.queue.find(q => q.filePath === fp && q.status !== 'done')
      if (item) { item.status = 'failed'; item.error = err.message; this.emitQueue() }
      this.failedCount++
      this.emit({ type: 'failed', file: path.basename(fp), error: err.message })
    }
  }

  async start() {
    if (this.running || !this.config.enabled) return
    const paths = this.getWatchPaths()
    if (!paths.length) { console.warn('AutoSync: no paths'); return }

    this.emit({ type: 'started' })
    this.queue = []; this.uploadedCount = 0; this.failedCount = 0
    this.emitQueue()

    const allFiles = paths.flatMap(d => this.walkFiles(d)).filter(f => !this.isAlreadyUploaded(f))
    this.emit({ type: 'scan-start', total: allFiles.length })

    for (let i = 0; i < allFiles.length; i++) {
      this.emit({ type: 'scan-progress', current: i + 1, total: allFiles.length, file: path.basename(allFiles[i]) })
      await this.uploadOne(allFiles[i])
    }
    this.emit({ type: 'scan-done', uploaded: this.uploadedCount, failed: this.failedCount, total: allFiles.length })

    this.watcher = chokidar.watch(paths, {
      ignored: /(^|[\/\\])\../, persistent: true, ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 100 },
    })
    this.watcher.on('add', (fp: string) => {
      this.emit({ type: 'detected', file: fp })
      if (this.shouldUploadFile(fp)) this.uploadOne(fp)
    })
    this.watcher.on('error', (err: Error) => this.emit({ type: 'error', error: err.message }))

    this.running = true
    console.log('AutoSync: started watching', paths)
  }

  stop() {
    this.watcher?.close(); this.watcher = null
    this.running = false; this.queue = []; this.emitQueue()
    this.emit({ type: 'stopped' })
    if (this.trackerDirty) this.saveTracker()
  }

  countFiles(): number {
    return this.getWatchPaths().reduce((sum, dir) => sum + this.walkFiles(dir).length, 0)
  }

  async scanNow(): Promise<{ total: number; uploaded: number; failed: number }> {
    const paths = this.getWatchPaths()
    const allFiles = paths.flatMap(d => this.walkFiles(d)).filter(f => !this.isAlreadyUploaded(f))
    this.queue = []; this.uploadedCount = 0; this.failedCount = 0
    this.emit({ type: 'scan-start', total: allFiles.length })

    for (let i = 0; i < allFiles.length; i++) {
      this.emit({ type: 'scan-progress', current: i + 1, total: allFiles.length, file: path.basename(allFiles[i]) })
      await this.uploadOne(allFiles[i])
    }
    this.emit({ type: 'scan-done', uploaded: this.uploadedCount, failed: this.failedCount, total: allFiles.length })
    return { total: allFiles.length, uploaded: this.uploadedCount, failed: this.failedCount }
  }

  isActive() { return this.running }

  getStatus() {
    return { isRunning: this.running, watchPaths: this.getWatchPaths(), uploadedCount: this.uploadedCount, failedCount: this.failedCount }
  }

  getLog(limit = 50): SyncEvent[] { return this.log.slice(0, limit) }
  getQueue(): QueueItem[] { return [...this.queue] }

  resetTracker() {
    this.uploadedIndex.clear()
    this.trackerDirty = true
    this.saveTracker()
  }
}
