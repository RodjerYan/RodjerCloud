import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

export interface SyncConfig {
  enabled: boolean
  mode: 'all' | 'custom'
  customPaths: string[]
  fileFilters: {
    enabled: boolean
    extensions: string[]
  }
  excludePatterns: string[]
}

export class StorageService {
  private userDataPath: string
  private sessionFilePath: string
  private syncConfigFilePath: string
  private encryptionKey: Buffer

  constructor() {
    this.userDataPath = app.getPath('userData')
    this.sessionFilePath = path.join(this.userDataPath, 'session_data.enc')
    this.syncConfigFilePath = path.join(this.userDataPath, 'sync_config.json')

    const machineId = this.getMachineId()
    this.encryptionKey = crypto.scryptSync(machineId, 'rodjercloud-salt', 32)
  }

  private getMachineId(): string {
    const os = require('os')
    return crypto
      .createHash('sha256')
      .update(os.hostname() + os.platform() + os.arch())
      .digest('hex')
  }

  private encrypt(data: string): string {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv)
    let encrypted = cipher.update(data, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return iv.toString('hex') + ':' + encrypted
  }

  private decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':')
    const iv = Buffer.from(parts[0], 'hex')
    const encrypted = parts[1]
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  async saveSession(sessionString: string): Promise<void> {
    const data = JSON.stringify({ session: sessionString, savedAt: new Date().toISOString() })
    fs.writeFileSync(this.sessionFilePath, this.encrypt(data), 'utf8')
  }

  async getSession(): Promise<{ session: string } | null> {
    if (!fs.existsSync(this.sessionFilePath)) return null
    try {
      const encrypted = fs.readFileSync(this.sessionFilePath, 'utf8')
      const decrypted = this.decrypt(encrypted)
      return JSON.parse(decrypted)
    } catch { return null }
  }

  async clearSession(): Promise<void> {
    if (fs.existsSync(this.sessionFilePath)) fs.unlinkSync(this.sessionFilePath)
  }

  async saveSyncConfig(config: SyncConfig): Promise<void> {
    fs.writeFileSync(this.syncConfigFilePath, JSON.stringify(config, null, 2), 'utf8')
  }

  async getSyncConfig(): Promise<SyncConfig | null> {
    if (!fs.existsSync(this.syncConfigFilePath)) return null
    try {
      return JSON.parse(fs.readFileSync(this.syncConfigFilePath, 'utf8')) as SyncConfig
    } catch { return null }
  }
}
