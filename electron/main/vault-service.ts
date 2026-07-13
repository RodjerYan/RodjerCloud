import { safeStorage } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import Store from 'electron-store'

const store = new Store({ name: 'vault-config' })

export class VaultService {
  private derivedKey: Buffer | null = null

  // Check if a password is set in secure storage
  hasPassword(): boolean {
    const encryptedPwd = store.get('vault_password') as string | undefined
    return !!encryptedPwd
  }

  checkPassword(pwd: string): boolean {
    const encryptedPwdB64 = store.get('vault_password') as string | undefined
    if (!encryptedPwdB64) return false
    try {
      const encryptedBuffer = Buffer.from(encryptedPwdB64, 'base64')
      const password = safeStorage.decryptString(encryptedBuffer)
      return password === pwd
    } catch {
      return false
    }
  }

  // Set the password, derive the key, and save it encrypted
  setPassword(password: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is not available (Keychain/Credential Manager)')
    }
    const encrypted = safeStorage.encryptString(password)
    store.set('vault_password', encrypted.toString('base64'))
    this.deriveKey(password)
  }

  // Load and derive the key from the saved password
  loadPassword(): boolean {
    if (this.derivedKey) return true

    const encryptedPwdB64 = store.get('vault_password') as string | undefined
    if (!encryptedPwdB64) return false

    if (!safeStorage.isEncryptionAvailable()) return false

    try {
      const encryptedBuffer = Buffer.from(encryptedPwdB64, 'base64')
      const password = safeStorage.decryptString(encryptedBuffer)
      this.deriveKey(password)
      return true
    } catch (error) {
      console.error('Failed to decrypt vault password from safeStorage', error)
      return false
    }
  }

  // Derive a 32-byte key from the password using scrypt
  private deriveKey(password: string) {
    this.derivedKey = crypto.scryptSync(password, 'rodjercloud-salt-9876', 32)
  }

  private getKey(): Buffer {
    if (!this.derivedKey) {
      if (!this.loadPassword()) {
        throw new Error('Vault is locked or password not set')
      }
    }
    return this.derivedKey!
  }

  // Encrypts a file into a temporary file and returns the temp file path + IV
  async encryptFile(sourcePath: string): Promise<{ tempPath: string; ivHex: string }> {
    return new Promise((resolve, reject) => {
      try {
        const key = this.getKey()
        const iv = crypto.randomBytes(16)
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)

        const tempDir = app.getPath('temp')
        const tempPath = path.join(tempDir, `rodjer_enc_${crypto.randomUUID()}`)

        const input = fs.createReadStream(sourcePath)
        const output = fs.createWriteStream(tempPath)

        input.pipe(cipher).pipe(output)

        output.on('finish', () => resolve({ tempPath, ivHex: iv.toString('hex') }))
        output.on('error', (err) => reject(err))
        cipher.on('error', (err) => reject(err))
        input.on('error', (err) => reject(err))
      } catch (err) {
        reject(err)
      }
    })
  }

  // Decrypts a file into a target path
  async decryptFile(sourcePath: string, targetPath: string, ivHex: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const key = this.getKey()
        const iv = Buffer.from(ivHex, 'hex')
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)

        const input = fs.createReadStream(sourcePath)
        const output = fs.createWriteStream(targetPath)

        input.pipe(decipher).pipe(output)

        output.on('finish', () => resolve())
        output.on('error', (err) => reject(err))
        decipher.on('error', (err) => reject(err))
        input.on('error', (err) => reject(err))
      } catch (err) {
        reject(err)
      }
    })
  }
}

export const vaultService = new VaultService()
