// 备份服务：本地 + WebDAV
//
// 备份内容：
// - app.db（SQLite3MultipleCiphers，明文或加密都支持）
// - attachments/ 目录（用户上传的文档等）
// - 备份清单 manifest.json（版本、时间、加密状态）
//
// 安全保障：
// 1. WAL checkpoint 后才复制文件（避免不一致）
// 2. 有 masterKeyManager 密钥时，备份包用 AES-256-GCM 加密
// 3. 无密钥时备份包明文但 manifest 里标记 encrypted=false
// 4. 文件名时间戳，永不覆盖旧备份

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { createWriteStream, readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as archiver from 'archiver'
import unzipper from 'unzipper'
import { dbService } from '../db/database'
import { masterKeyManager } from '../crypto/master-key'
import { DB_PATH, DATA_DIR, ATTACHMENTS_DIR } from '../portable'
import { encryptApiKeys } from '../crypto/field-encrypt'
import {
  testConnection, uploadBuffer, downloadFile, listFiles, deleteFile,
  type WebDAVCredentials, type BackupFile
} from './webdav-client'

export { type WebDAVCredentials, type BackupFile }

const ZIP_MAGIC = Buffer.from('PK\x03\x04')
const ENC_PREFIX = 'PKBK1' // PocketAI Backup v1

export interface BackupManifest {
  version: 1
  appVersion: string
  createdAt: string          // ISO 8601
  encrypted: boolean         // 备份包是否 AES-256-GCM 加密
  dbEncrypted: boolean       // 原库是否加密（便于恢复时自动判断）
  dbCipher: string           // sqlcipher
  masterKeySaltB64?: string  // 加密备份时用的 salt（解密时需要）
  attachmentsCount: number
  attachmentsBytes: number
  dbSize: number
}

export interface WebDAVConfig {
  url: string
  username: string
  passwordCipher: string     // 用固定密钥加密后存储（透明调用字段加密层）
  directory: string
}

// ─── 本地备份 ───────────────────────────────────────────────────

function checkpointDB(): void {
  // WAL checkpoint + 切 DELETE journal_mode → 确保 DB 文件自包含一致
  const db = dbService.getHandle()
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch { /* ignore */ }
  try {
    db.pragma('journal_mode = DELETE')
  } catch { /* ignore */ }
}

function restoreJournalMode(): void {
  const db = dbService.getHandle()
  try { db.pragma('journal_mode = WAL') } catch { /* ignore */ }
}

function collectAttachmentFiles(): { file: string; name: string }[] {
  const files: { file: string; name: string }[] = []
  if (!existsSync(ATTACHMENTS_DIR)) return files
  for (const name of readdirSync(ATTACHMENTS_DIR)) {
    const p = join(ATTACHMENTS_DIR, name)
    try { if (statSync(p).isFile()) files.push({ file: p, name }) } catch { /* skip */ }
  }
  return files
}

async function createZipBuffer(): Promise<{ zip: Buffer; manifest: BackupManifest }> {
  // 1. 先 checkpoint
  checkpointDB()
  try {
    const tmp = join(tmpdir(), `pocketai-backup-${Date.now()}`)
    mkdirSync(tmp, { recursive: true })

    // 2. 复制 DB 到临时目录（避免打包锁住文件）
    const dbFile = join(tmp, 'app.db')
    copyFileSync(DB_PATH, dbFile)

    // 3. 数 attachments
    const atts = collectAttachmentFiles()
    let attBytes = 0
    for (const a of atts) {
      try { attBytes += statSync(a.file).size } catch { /* ignore */ }
    }

    // 4. manifest
    const manifest: BackupManifest = {
      version: 1,
      appVersion: '0.1.0',
      createdAt: new Date().toISOString(),
      encrypted: false,
      dbEncrypted: masterKeyManager.isDbEncrypted(),
      dbCipher: 'sqlcipher',
      attachmentsCount: atts.length,
      attachmentsBytes: attBytes,
      dbSize: statSync(DB_PATH).size
    }
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    // 5. 打包 zip
    const chunks: Buffer[] = []
    const archive = (archiver as any)('zip', { zlib: { level: 6 } })
    archive.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))

    // 先加 manifest
    archive.append(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), { name: 'manifest.json' })
    // 再加 DB
    archive.append(readFileSync(dbFile), { name: 'app.db' })
    // attachments 用子目录
    if (atts.length > 0) {
      for (const a of atts) {
        archive.append(readFileSync(a.file), { name: `attachments/${a.name}` })
      }
    }

    await archive.finalize()
    const zip = Buffer.concat(chunks)

    restoreJournalMode()
    return { zip, manifest }
  } catch (e) {
    restoreJournalMode()
    throw e
  }
}

function encryptBackup(zip: Buffer): { blob: Buffer; salt: Buffer } {
  // 如果有 masterKey（DB 加密模式），用它派生；否则用固定密钥（字段加密密钥）
  const masterKey = masterKeyManager.getDbKey()
  const baseKey = masterKey ?? masterKeyManager.getFieldKey()
  const salt = randomBytes(16)
  // 派生实际加密密钥（salt 混入）
  const encKey = createHash('sha256').update(baseKey).update(salt).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encKey, iv)
  const ct = Buffer.concat([cipher.update(zip), cipher.final()])
  const tag = cipher.getAuthTag()
  // 格式: PKBK1(5) + iv(12) + salt(16) + tag(16) + ct
  const blob = Buffer.concat([Buffer.from(ENC_PREFIX), iv, salt, tag, ct])
  return { blob, salt }
}

function decryptBackup(blob: Buffer, salt: Buffer): Buffer {
  if (!blob.slice(0, ENC_PREFIX.length).equals(Buffer.from(ENC_PREFIX))) {
    throw new Error('备份文件格式无效')
  }
  const masterKey = masterKeyManager.getDbKey()
  const baseKey = masterKey ?? masterKeyManager.getFieldKey()
  const encKey = createHash('sha256').update(baseKey).update(salt).digest()

  let offset = ENC_PREFIX.length
  const iv = blob.subarray(offset, offset + 12); offset += 12
  const saltInFile = blob.subarray(offset, offset + 16); offset += 16
  const tag = blob.subarray(offset, offset + 16); offset += 16
  const ct = blob.subarray(offset)

  const decipher = createDecipheriv('aes-256-gcm', encKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

// ─── 公开 API ───────────────────────────────────────────────────

export async function createLocalBackup(outDir: string): Promise<{ path: string; size: number; encrypted: boolean }> {
  const { zip, manifest } = await createZipBuffer()

  const filename = `pocketai-backup-${new Date().toISOString().replace(/[:.]/g, '')}.zip`
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, filename)
  writeFileSync(outPath, zip)
  console.log(`[backup] 本地备份: ${outPath} (${zip.length} bytes)`)
  return { path: outPath, size: zip.length, encrypted: false }
}

export async function createEncryptedLocalBackup(outDir: string): Promise<{ path: string; size: number; encrypted: boolean; saltB64: string }> {
  const { zip, manifest } = await createZipBuffer()
  const { blob, salt } = encryptBackup(zip)

  const filename = `pocketai-backup-${new Date().toISOString().replace(/[:.]/g, '')}.enc.zip`
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, filename)
  writeFileSync(outPath, blob)
  console.log(`[backup] 加密本地备份: ${outPath} (${blob.length} bytes, salt=${salt.toString('base64').slice(0,8)}...)`)
  return { path: outPath, size: blob.length, encrypted: true, saltB64: salt.toString('base64') }
}

type WD = typeof import('./backup-service')
function toCreds(cfg: WebDAVConfig): WebDAVCredentials {
  return {
    url: cfg.url,
    username: cfg.username,
    password: cfg.passwordCipher,
    directory: cfg.directory
  }
}

export async function createWebDAVBackup(credsOrCfg: any): Promise<{ filename: string; size: number; encrypted: boolean }> {
  const creds = toCreds(credsOrCfg)
  const { zip } = await createZipBuffer()
  const useEncryption = masterKeyManager.hasKey()
  let blob = zip
  let encrypted = false

  if (useEncryption) {
    const { blob: b } = encryptBackup(zip)
    blob = b
    encrypted = true
  }

  const filename = `pocketai-backup-${new Date().toISOString().replace(/[:.]/g, '')}${encrypted ? '.enc.zip' : '.zip'}`
  await uploadBuffer(creds, blob, filename)
  console.log(`[backup] WebDAV 上传: ${filename} (${blob.length} bytes, encrypted=${encrypted})`)
  return { filename, size: blob.length, encrypted }
}

export async function listWebDAVBackups(credsOrCfg: any): Promise<BackupFile[]> {
  return listFiles(toCreds(credsOrCfg))
}

export async function testWebDAV(credsOrCfg: any): Promise<{ ok: boolean; message?: string }> {
  return testConnection(toCreds(credsOrCfg))
}

export async function deleteWebDAVBackup(credsOrCfg: any, filename: string): Promise<void> {
  await deleteFile(toCreds(credsOrCfg), filename)
}

export async function restoreFromWebDAV(
  credsOrCfg: any,
  filename: string
): Promise<{ ok: boolean; error?: string }> {
  const creds = toCreds(credsOrCfg)
  // 1. 下载
  const blob = await downloadFile(creds, filename)
  // 2. 判断加密
  const isEncrypted = filename.endsWith('.enc.zip')
  let zip: Buffer
  if (isEncrypted) {
    try {
      zip = decryptBackup(blob, blob.subarray(ENC_PREFIX.length + 12, ENC_PREFIX.length + 12 + 16))
    } catch (e: any) {
      const msg = e?.message ?? ''
      if (msg.includes('decrypt') || msg.includes('auth')) {
        return { ok: false, error: '备份加密密钥与当前主密码不匹配，请在设置页输入恢复密码（暂不支持，当前会话密码必须一致）' }
      }
      return { ok: false, error: '解密失败：备份包可能已损坏' }
    }
  } else {
    zip = blob
  }

  // 3. 解压到临时目录
  const tmp = join(tmpdir(), `pocketai-restore-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const { Readable } = require('node:stream')
    Readable.from(zip)
      .pipe(unzipper.Extract({ path: tmp }))
      .on('close', resolve)
      .on('error', reject)
  })

  // 4. 验证 manifest
  const manifestPath = join(tmp, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, error: '备份包损坏：缺少 manifest.json' }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest

  // 5. 关闭当前 DB
  dbService.close()

  // 6. 替换 DB 文件
  const dbInBackup = join(tmp, 'app.db')
  if (existsSync(dbInBackup)) {
    copyFileSync(dbInBackup, DB_PATH)
  }

  // 7. 替换 attachments（如果备份里有）
  const attDir = join(tmp, 'attachments')
  if (existsSync(attDir)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true })
    for (const f of readdirSync(attDir)) {
      const src = join(attDir, f)
      if (statSync(src).isFile()) copyFileSync(src, join(ATTACHMENTS_DIR, f))
    }
  }

  // 8. 重新打开 DB（如果原库是加密的，用当前 masterKey 打开）
  if (manifest.dbEncrypted && masterKeyManager.getDbKey()) {
    dbService.open(masterKeyManager.getDbKey()!)
  } else {
    dbService.open()
  }
  dbService.runMigrations()

  console.log(`[backup] 恢复完成: ${filename} (DB加密=${manifest.dbEncrypted})`)
  return { ok: true }
}

// ─── WebDAV 配置存取 ─────────────────────────────────────────────

const CFG_KEY = 'webdav_config'

export function saveWebDAVConfig(raw: WebDAVConfig): void {
  // password 加密后存
  const credsForEncrypt: any = { apiKeys: [raw.passwordCipher] } // 复用字段加密层
  const encrypted = encryptApiKeys(credsForEncrypt.apiKeys)
  const config: any = { ...raw, passwordCipher: encrypted }
  const { appConfigRepo } = require('../db/repositories/app-config.repo')
  appConfigRepo.set(CFG_KEY, JSON.stringify(config))
}

export function loadWebDAVConfig(): WebDAVConfig | null {
  const { appConfigRepo } = require('../db/repositories/app-config.repo')
  const raw = appConfigRepo.get(CFG_KEY)
  if (!raw) return null
  try {
    const cfg: WebDAVConfig = JSON.parse(raw)
    // 解密 password
    const { decryptApiKeys } = require('../crypto/field-encrypt')
    const pwdArr = decryptApiKeys(cfg.passwordCipher)
    if (pwdArr.length > 0) cfg.passwordCipher = pwdArr[0]
    return cfg
  } catch {
    return null
  }
}

export function clearWebDAVConfig(): void {
  const { appConfigRepo } = require('../db/repositories/app-config.repo')
  appConfigRepo.delete(CFG_KEY)
}
