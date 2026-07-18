import Database from 'better-sqlite3'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

const dbPath = path.join(app.getPath('userData'), 'rodjercloud.sqlite')

export function getDbPath() {
  return dbPath
}

export const db = new Database(dbPath)

// Enable WAL mode for high concurrency and crash resilience
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parentId TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS file_folders (
    messageId INTEGER PRIMARY KEY,
    folderId TEXT NOT NULL,
    FOREIGN KEY(folderId) REFERENCES folders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS upload_jobs (
    id TEXT PRIMARY KEY,
    filePath TEXT NOT NULL,
    folderId TEXT,
    fileName TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, uploading, completed, error
    encrypt INTEGER NOT NULL DEFAULT 0,
    messageId INTEGER,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`)

// Helper functions for folders
export function insertFolder(folder: { id: string; name: string; parentId: string | null; createdAt: number }) {
  const stmt = db.prepare('INSERT OR REPLACE INTO folders (id, name, parentId, createdAt) VALUES (?, ?, ?, ?)')
  stmt.run(folder.id, folder.name, folder.parentId, folder.createdAt)
}

export function updateFolder(id: string, name: string) {
  const stmt = db.prepare('UPDATE folders SET name = ?, updatedAt = strftime("%s","now") WHERE id = ?')
  stmt.run(name, id)
}

export function deleteFolder(id: string) {
  const getChildren = db.prepare('SELECT id FROM folders WHERE parentId = ?')
  const delFolder = db.prepare('DELETE FROM folders WHERE id = ?')
  
  const deleteRecursive = (folderId: string) => {
    const children = getChildren.all(folderId) as { id: string }[]
    for (const child of children) {
      deleteRecursive(child.id)
    }
    delFolder.run(folderId)
  }
  
  db.transaction(() => {
    deleteRecursive(id)
  })()
}

export function getAllFolders() {
  const stmt = db.prepare('SELECT * FROM folders')
  return stmt.all() as any[]
}

// Helper functions for file_folders
export function addFileToFolder(messageId: number, folderId: string) {
  const stmt = db.prepare('INSERT OR REPLACE INTO file_folders (messageId, folderId) VALUES (?, ?)')
  stmt.run(messageId, folderId)
}

export function removeFileFromFolder(messageId: number) {
  const stmt = db.prepare('DELETE FROM file_folders WHERE messageId = ?')
  stmt.run(messageId)
}

export function getAllFileFolders() {
  const stmt = db.prepare('SELECT * FROM file_folders')
  const rows = stmt.all() as { messageId: number; folderId: string }[]
  const result: Record<string, string> = {}
  for (const r of rows) {
    result[r.messageId] = r.folderId
  }
  return result
}

export function getLegacyFolders() {
  return {
    folders: getAllFolders(),
    fileFolders: getAllFileFolders()
  }
}

// Helper functions for upload_jobs
export function createUploadJob(job: { id: string; filePath: string; folderId?: string | null; fileName: string; encrypt?: boolean }) {
  const stmt = db.prepare('INSERT INTO upload_jobs (id, filePath, folderId, fileName, encrypt) VALUES (?, ?, ?, ?, ?)')
  stmt.run(job.id, job.filePath, job.folderId || null, job.fileName, job.encrypt ? 1 : 0)
}

export function updateUploadJobStatus(id: string, status: string, messageId?: number, error?: string) {
  const stmt = db.prepare('UPDATE upload_jobs SET status = ?, messageId = ?, error = ? WHERE id = ?')
  stmt.run(status, messageId || null, error || null, id)
}

export function getPendingUploadJobs() {
  const stmt = db.prepare("SELECT * FROM upload_jobs WHERE status IN ('pending', 'uploading')")
  return stmt.all() as any[]
}

export function deleteUploadJob(id: string) {
  const stmt = db.prepare('DELETE FROM upload_jobs WHERE id = ?')
  stmt.run(id)
}

// Sync State
export function getSyncState(key: string): string | null {
  const stmt = db.prepare('SELECT value FROM sync_state WHERE key = ?')
  const row = stmt.get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setSyncState(key: string, value: string) {
  const stmt = db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)')
  stmt.run(key, value)
}

// Clear all data (e.g. on logout)
export function clearAllData() {
  db.transaction(() => {
    db.prepare('DELETE FROM file_folders').run()
    db.prepare('DELETE FROM folders').run()
    db.prepare('DELETE FROM upload_jobs').run()
    db.prepare('DELETE FROM sync_state').run()
  })()
}
