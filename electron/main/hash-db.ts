import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app } from 'electron'

const DB_PATH = path.join(app.getPath('userData'), 'hash-db.json')

interface HashEntry {
  messageId: number
  hash: string
  fileName: string
  fileSize: number
}

let db: HashEntry[] = []

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
    }
  } catch { db = [] }
}

function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2))
  } catch {}
}

export function getDb() { return db }

export function addEntry(entry: HashEntry) {
  const i = db.findIndex(e => e.messageId === entry.messageId)
  if (i >= 0) db[i] = entry
  else db.push(entry)
  save()
}

export function removeEntry(messageId: number) {
  db = db.filter(e => e.messageId !== messageId)
  save()
}

export function getDuplicates(): { hash: string; files: HashEntry[] }[] {
  const groups: Record<string, HashEntry[]> = {}
  for (const e of db) {
    if (!groups[e.hash]) groups[e.hash] = []
    groups[e.hash].push(e)
  }
  return Object.entries(groups)
    .filter(([, files]) => files.length > 1)
    .map(([hash, files]) => ({ hash, files }))
}

export async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath, { start: 0, end: 65535 })
    stream.on('data', d => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export function init() {
  load()
}

export { HashEntry }