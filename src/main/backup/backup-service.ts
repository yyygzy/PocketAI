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
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// archiver 是 CJS 模块（module.exports = function），@types 未声明 default 导出，
// 用 require 避免 esbuild 将命名空间导入包装为不可调用对象
import type { Archiver, ArchiverOptions } from 'archiver'
const archiver = require('archiver') as (format: string, options?: ArchiverOptions) => Archiver
import unzipper from 'unzipper'
import { dbService } from '../db/database'
import { masterKeyManager } from '../crypto/master-key'
import { DB_PATH, ATTACHMENTS_DIR } from '../portable'
import { encryptApiKeys, decryptApiKeys, isCipherText } from '../crypto/field-encrypt'
import { appConfigRepo, clearAppConfigCache } from '../db/repositories/app-config.repo'
import {
  testConnection, uploadBuffer, downloadFile, listFiles, deleteFile,
  remoteExists, uploadRemoteBuffer, downloadRemoteFile,
  type WebDAVCredentials, type BackupFile
} from './webdav-client'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { webdavConfigSchema, backupFilenameSchema } from '../../shared/schemas/backup'
import { z } from 'zod'

const log = createLogger('backup')

export { type WebDAVCredentials, type BackupFile }

export const ENC_PREFIX = 'PKBK1' // PocketAI Backup v1

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
  passwordCipher: string     // 密文，经字段加密层 encryptApiKeys 加密（密钥随加密模式：db 模式=主密码派生密钥，none 模式=固定混淆密钥）
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
    const archive = archiver('zip', { zlib: { level: 6 } })
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
  // 加密备份必须使用用户主密码派生的密钥。none 模式的字段固定密钥随源码公开，
  // 用它加密等于没加密（旧版本曾回退固定密钥产出 .enc.zip，属安全假象，已禁止）。
  const baseKey = masterKeyManager.getDbKey()
  if (!baseKey) throw new Error('未启用主密码加密，无法生成加密备份')
  const salt = randomBytes(16)
  // 派生实际加密密钥（salt 混入）。baseKey 已是高熵 32 字节密钥
  // （主密码经 scrypt 慢派生的产物），此处用 sha256 混盐做密钥分离即可，
  // 不需要慢哈希；改动此派生公式会让所有已存在的加密备份无法解密，勿动
  const encKey = createHash('sha256').update(baseKey).update(salt).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encKey, iv)
  const ct = Buffer.concat([cipher.update(zip), cipher.final()])
  const tag = cipher.getAuthTag()
  // 格式: PKBK1(5) + iv(12) + salt(16) + tag(16) + ct
  const blob = Buffer.concat([Buffer.from(ENC_PREFIX), iv, salt, tag, ct])
  return { blob, salt }
}

export function decryptBackup(blob: Buffer, salt: Buffer): Buffer {
  if (!blob.slice(0, ENC_PREFIX.length).equals(Buffer.from(ENC_PREFIX))) {
    throw new Error('备份文件格式无效')
  }
  const masterKey = masterKeyManager.getDbKey()
  // 仅解密方向保留固定密钥回退：兼容 none 模式下旧版本产出的 .enc.zip
  let baseKey = masterKey
  if (!baseKey) {
    try {
      baseKey = masterKeyManager.getFieldKey()
    } catch {
      throw new Error('备份解密密钥不可用（应用已锁定）')
    }
  }
  const encKey = createHash('sha256').update(baseKey).update(salt).digest()

  let offset = ENC_PREFIX.length
  const iv = blob.subarray(offset, offset + 12); offset += 12
  // salt 段与入参 salt 相同（调用方均从 blob 内嵌偏移读出后传入），跳过
  offset += 16
  const tag = blob.subarray(offset, offset + 16); offset += 16
  const ct = blob.subarray(offset)

  const decipher = createDecipheriv('aes-256-gcm', encKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

// ─── 公开 API ───────────────────────────────────────────────────

export async function createLocalBackup(outDir: string): Promise<{ path: string; size: number; encrypted: boolean }> {
  z.string().min(1).parse(outDir)
  const { zip } = await createZipBuffer()

  const filename = `pocketai-backup-${new Date().toISOString().replace(/[:.]/g, '')}.zip`
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, filename)
  writeFileSync(outPath, zip)
  log.info(`本地备份: ${outPath} (${zip.length} bytes)`)
  return { path: outPath, size: zip.length, encrypted: false }
}

export async function createEncryptedLocalBackup(outDir: string): Promise<{ path: string; size: number; encrypted: boolean; saltB64: string }> {
  z.string().min(1).parse(outDir)
  const { zip } = await createZipBuffer()
  const { blob, salt } = encryptBackup(zip)

  const filename = `pocketai-backup-${new Date().toISOString().replace(/[:.]/g, '')}.enc.zip`
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, filename)
  // 0600：密文备份仍按最小权限落盘（同机其他用户不可读）；仅对新建文件生效
  writeFileSync(outPath, blob, { mode: 0o600 })
  log.info(`加密本地备份: ${outPath} (${blob.length} bytes, salt=${salt.toString('base64').slice(0,8)}...)`)
  return { path: outPath, size: blob.length, encrypted: true, saltB64: salt.toString('base64') }
}

export function toCreds(cfg: WebDAVConfig): WebDAVCredentials {
  return {
    url: cfg.url,
    username: cfg.username,
    password: cfg.passwordCipher,
    directory: cfg.directory
  }
}

export async function createWebDAVBackup(cfg: WebDAVConfig): Promise<{ filename: string; size: number; encrypted: boolean }> {
  webdavConfigSchema.parse(cfg)
  const creds = toCreds(cfg)
  const { zip } = await createZipBuffer()
  // 必须以「存在用户主密码密钥」为准；hasKey() 在 none 模式也为 true（init 即解锁），
  // 用它判断会导致公开固定密钥加密的假加密备份
  const useEncryption = masterKeyManager.getDbKey() !== null
  let blob = zip
  let encrypted = false

  if (useEncryption) {
    const { blob: b } = encryptBackup(zip)
    blob = b
    encrypted = true
  }

  const filename = `pocketai-backup-${new Date().toISOString().replace(/[:.]/g, '')}${encrypted ? '.enc.zip' : '.zip'}`
  await uploadBuffer(creds, blob, filename)
  log.info(`WebDAV 上传: ${filename} (${blob.length} bytes, encrypted=${encrypted})`)
  return { filename, size: blob.length, encrypted }
}

// ─── WebDAV 增量备份 ─────────────────────────────────────────────
//
// 思路：附件是"只增不改"的大对象，按内容 sha256 做内容寻址去重：
//   blobs/db-<sha256>[.enc]    —— DB 快照（SQLite 单文件无法做块增量，每次全量上传）
//   blobs/att-<sha256>[.enc]   —— 附件内容，相同文件永不重复上传
//   pocketai-inc-<ts>.json[.enc] —— 增量索引，记录本备份引用的 DB blob 与每个附件的映射
// 恢复时按索引拉取缺失 blob；本地已有同 sha256 附件则跳过下载。
// 加密模式下每个 blob 独立 AES-256-GCM 加密，blob 名仍取明文 sha256（去重依据）。

interface IncrementalAttachment {
  name: string
  sha256: string
  size: number
  blob: string
}

export interface IncrementalIndex {
  kind: 'pocketai-incremental'
  version: 1
  createdAt: string
  encrypted: boolean     // blob 与索引是否加密
  dbEncrypted: boolean   // 原库是否加密
  db: {
    blob: string
    sha256: string
    size: number
  }
  attachments: IncrementalAttachment[]
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 加密时的 blob 后缀规则，集中管理避免不一致 */
export function blobRelName(prefix: 'db' | 'att', sha: string, encrypted: boolean): string {
  return `blobs/${prefix}-${sha}${encrypted ? '.enc' : '.bin'}`
}

export function isEncryptedBlob(buf: Buffer, name: string): boolean {
  return buf.subarray(0, ENC_PREFIX.length).equals(Buffer.from(ENC_PREFIX)) || name.endsWith('.enc')
}

export async function createWebDAVIncrementalBackup(
  cfg: WebDAVConfig
): Promise<import('../../shared/types').IncrementalBackupResult> {
  webdavConfigSchema.parse(cfg)
  const creds = toCreds(cfg)
  // 同全量备份：以主密码密钥是否存在决定真加密（hasKey() 在 none 模式误报 true）
  const encrypted = masterKeyManager.getDbKey() !== null

  // 1. checkpoint + 复制 DB（与全量备份一致的一致性保障）
  checkpointDB()
  let dbBuf: Buffer
  try {
    dbBuf = readFileSync(DB_PATH)
  } finally {
    restoreJournalMode()
  }
  const dbSha = sha256Hex(dbBuf)

  // 2. 读取全部附件并计算 sha256
  const atts = collectAttachmentFiles().map((a) => {
    const data = readFileSync(a.file)
    return { name: a.name, data, sha256: sha256Hex(data), size: data.length }
  })

  let bytesUploaded = 0
  let blobsUploaded = 0
  let blobsSkipped = 0

  // 上传单个 blob（远端已存在则跳过）
  const uploadBlob = async (sha: string, prefix: 'db' | 'att', data: Buffer): Promise<string> => {
    const rel = blobRelName(prefix, sha, encrypted)
    if (await remoteExists(creds, rel)) {
      blobsSkipped += 1
      return rel
    }
    const payload = encrypted ? encryptBackup(data).blob : data
    await uploadRemoteBuffer(creds, payload, rel)
    bytesUploaded += payload.length
    blobsUploaded += 1
    return rel
  }

  // 3. DB blob（内容几乎每次都变，一般会新传）
  const dbBlob = await uploadBlob(dbSha, 'db', dbBuf)

  // 4. 附件 blob（相同 sha256 直接命中远端，去重）
  const indexAtts: IncrementalAttachment[] = []
  for (const a of atts) {
    const blob = await uploadBlob(a.sha256, 'att', a.data)
    indexAtts.push({ name: a.name, sha256: a.sha256, size: a.size, blob })
  }

  // 5. 组装并上传增量索引
  const index: IncrementalIndex = {
    kind: 'pocketai-incremental',
    version: 1,
    createdAt: new Date().toISOString(),
    encrypted,
    dbEncrypted: masterKeyManager.isDbEncrypted(),
    db: { blob: dbBlob, sha256: dbSha, size: dbBuf.length },
    attachments: indexAtts
  }
  const indexJson = Buffer.from(JSON.stringify(index), 'utf8')
  const ts = new Date().toISOString().replace(/[:.]/g, '')
  const indexName = `pocketai-inc-${ts}.json${encrypted ? '.enc' : ''}`
  const indexPayload = encrypted ? encryptBackup(indexJson).blob : indexJson
  await uploadBuffer(creds, indexPayload, indexName)
  bytesUploaded += indexPayload.length

  log.info(
    `WebDAV 增量备份: ${indexName}（附件 ${atts.length}，新传 ${blobsUploaded} blob，跳过 ${blobsSkipped}，共 ${bytesUploaded} bytes）`
  )
  return {
    filename: indexName,
    bytesUploaded,
    blobsUploaded,
    blobsSkipped,
    attachmentsTotal: atts.length,
    encrypted
  }
}

/** 从 WebDAV 增量索引恢复（DB 全量替换；附件按 sha256 缺失才下载） */
export async function restoreIncrementalFromWebDAV(
  cfg: WebDAVConfig,
  indexFilename: string
): Promise<{ ok: boolean; error?: string }> {
  webdavConfigSchema.parse(cfg)
  backupFilenameSchema.parse(indexFilename)
  const creds = toCreds(cfg)

  // 1. 下载并解密索引
  const indexRaw = await downloadFile(creds, indexFilename)
  let indexBuf = indexRaw
  if (isEncryptedBlob(indexRaw, indexFilename)) {
    try {
      indexBuf = decryptBackup(
        indexRaw,
        indexRaw.subarray(ENC_PREFIX.length + 12, ENC_PREFIX.length + 12 + 16)
      )
    } catch {
      return { ok: false, error: '增量索引解密失败：加密密钥与当前主密码不匹配' }
    }
  }
  let index: IncrementalIndex
  try {
    index = JSON.parse(indexBuf.toString('utf8'))
  } catch {
    return { ok: false, error: '增量索引解析失败：文件可能已损坏' }
  }
  if (index.kind !== 'pocketai-incremental' || !index.db?.blob) {
    return { ok: false, error: '不是有效的增量备份索引' }
  }

  /** 下载 blob → 必要时解密 → 校验 sha256 */
  const fetchBlobVerified = async (
    blobRel: string,
    expectedSha: string
  ): Promise<{ ok: boolean; data?: Buffer; error?: string }> => {
    const blobRaw = await downloadRemoteFile(creds, blobRel)
    let data = blobRaw
    if (index.encrypted || isEncryptedBlob(blobRaw, blobRel)) {
      try {
        data = decryptBackup(
          blobRaw,
          blobRaw.subarray(ENC_PREFIX.length + 12, ENC_PREFIX.length + 12 + 16)
        )
      } catch {
        return { ok: false, error: `blob 解密失败：${blobRel}` }
      }
    }
    if (sha256Hex(data) !== expectedSha) {
      return { ok: false, error: `blob 校验失败（sha256 不匹配）：${blobRel}` }
    }
    return { ok: true, data }
  }

  // 2. DB blob（必须下载）
  const dbRes = await fetchBlobVerified(index.db.blob, index.db.sha256)
  if (!dbRes.ok || !dbRes.data) return { ok: false, error: dbRes.error }

  // 3. 附件：本地已有同 sha256 文件则跳过，否则下载
  mkdirSync(ATTACHMENTS_DIR, { recursive: true })
  for (const a of index.attachments) {
    // 防路径穿越：索引中的附件名只能是裸文件名
    if (a.name.includes('/') || a.name.includes('\\') || a.name.includes('..')) {
      return { ok: false, error: `非法的附件名：${a.name}` }
    }
    const local = join(ATTACHMENTS_DIR, a.name)
    if (existsSync(local)) {
      try {
        if (sha256Hex(readFileSync(local)) === a.sha256) continue
      } catch {
        /* 读取失败则继续走下载 */
      }
    }
    const res = await fetchBlobVerified(a.blob, a.sha256)
    if (!res.ok || !res.data) return { ok: false, error: res.error }
    writeFileSync(local, res.data)
  }

  // 4. 关闭 DB → 替换 → 以正确密钥重开 + 迁移（与全量恢复一致）
  // 破坏前预检：备份库加密但当前无主密码密钥时直接拒绝，避免替换后打不开
  if (index.dbEncrypted && !masterKeyManager.getDbKey()) {
    return { ok: false, error: '该增量备份来自加密库，但当前会话未解锁主密码，请先解锁后再恢复' }
  }
  dbService.close()
  removeStaleSidecars(DB_PATH)
  writeFileSync(DB_PATH, dbRes.data)
  const dbKey = masterKeyManager.getDbKey()
  if (index.dbEncrypted && dbKey) {
    dbService.open(dbKey)
  } else {
    dbService.open()
  }
  dbService.runMigrations()

  log.info(`增量恢复完成: ${indexFilename}`)
  return { ok: true }
}

export async function listWebDAVBackups(cfg: WebDAVConfig): Promise<BackupFile[]> {
  return listFiles(toCreds(cfg))
}

export async function testWebDAV(cfg: WebDAVConfig): Promise<{ ok: boolean; message?: string }> {
  webdavConfigSchema.parse(cfg)
  return testConnection(toCreds(cfg))
}

export async function deleteWebDAVBackup(cfg: WebDAVConfig, filename: string): Promise<void> {
  webdavConfigSchema.parse(cfg)
  backupFilenameSchema.parse(filename)
  await deleteFile(toCreds(cfg), filename)
}

// ─── 恢复安全校验（防 Zip Slip / symlink 攻击） ───────────────────

/**
 * 校验 zip 条目名是否安全：只允许不含 ".." 分段的相对路径。
 * WebDAV 上的备份包可被服务器/中间人篡改，恶意条目 "../app.db" 之类
 * 会在解压时写到临时目录之外（覆盖任意文件），必须先校验再解压。
 */
export function isSafeZipEntryName(rawName: string): boolean {
  const name = String(rawName ?? '').replace(/\\/g, '/') // zip 规范用 /，容忍 Windows 制包的 \
  if (!name) return false
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false // 绝对路径 / 盘符
  return !name.split('/').includes('..')
}

/** 递归检查目录中是否存在符号链接（真实链接会使后续复制跟着链接读出任意文件） */
function containsSymlink(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true
    if (entry.isDirectory() && containsSymlink(join(dir, entry.name))) return true
  }
  return false
}

/** 删除旧 DB 的 WAL/SHM 副作用文件：替换主库文件后，陈旧 -wal 可能被 SQLite
 *  按 salt 校验失败而忽略，但跨平台/异常关闭场景下应主动清除，避免脏页重放 */
function removeStaleSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try { if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix) } catch { /* ignore */ }
  }
}

export async function restoreFromWebDAV(
  cfg: WebDAVConfig,
  filename: string
): Promise<{ ok: boolean; error?: string }> {
  webdavConfigSchema.parse(cfg)
  backupFilenameSchema.parse(filename)
  const creds = toCreds(cfg)
  // 1. 下载
  const blob = await downloadFile(creds, filename)
  // 2. 判断加密
  const isEncrypted = filename.endsWith('.enc.zip')
  let zip: Buffer
  if (isEncrypted) {
    try {
      zip = decryptBackup(blob, blob.subarray(ENC_PREFIX.length + 12, ENC_PREFIX.length + 12 + 16))
    } catch (e) {
      const msg = errMsg(e, '')
      if (msg.includes('decrypt') || msg.includes('auth')) {
        return { ok: false, error: '备份加密密钥与当前主密码不匹配，请在设置页输入恢复密码（暂不支持，当前会话密码必须一致）' }
      }
      return { ok: false, error: '解密失败：备份包可能已损坏' }
    }
  } else {
    zip = blob
  }

  // 3. 解压前先读中央目录校验所有条目路径（防 Zip Slip）：
  //    unzipper.Extract 直接落盘，含 "../" 的恶意条目会写到 tmp 之外，
  //    事后无法挽回，必须先校验再解压
  const archive = await unzipper.Open.buffer(zip).catch(() => null)
  if (!archive) {
    return { ok: false, error: '备份包损坏：无法读取 ZIP 目录' }
  }
  for (const f of archive.files) {
    if (!isSafeZipEntryName(f.path)) {
      return { ok: false, error: `备份包含非法条目路径，已中止恢复：${f.path}` }
    }
  }

  // 4. 解压到临时目录；解压及之后的全部处理包在 try/finally 中：
  //    tmp 目录里是备份包解出的明文 app.db（加密备份也已在第 2 步解密），
  //    任何路径退出（含解压失败、符号链接拒绝、manifest 损坏、恢复异常）都必须清除
  const tmp = join(tmpdir(), `pocketai-restore-${Date.now()}`)
  let result: { ok: boolean; error?: string } = { ok: true }
  try {
    mkdirSync(tmp, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const { Readable } = require('node:stream')
      Readable.from(zip)
        .pipe(unzipper.Extract({ path: tmp }))
        .on('close', resolve)
        .on('error', reject)
    })

    // 符号链接检查：真实链接会让后续复制（跟随链接）读出宿主任意文件
    if (containsSymlink(tmp)) {
      result = { ok: false, error: '备份包含符号链接条目，已中止恢复' }
      return result
    }

    // 6. 验证 manifest
    const manifestPath = join(tmp, 'manifest.json')
    if (!existsSync(manifestPath)) {
      result = { ok: false, error: '备份包损坏：缺少 manifest.json' }
      return result
    }
    let manifest: BackupManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
    } catch {
      result = { ok: false, error: '备份包损坏：manifest.json 解析失败' }
      return result
    }

    // 6.5 破坏前预检：备份内 DB 加密但当前会话没有主密码密钥时无法重开，
    //     必须在关库/替换文件之前拒绝，否则会把应用留在「库已换但打不开」的砖状态
    if (manifest.dbEncrypted && !masterKeyManager.getDbKey()) {
      result = { ok: false, error: '该备份来自加密库，但当前会话未解锁主密码，请先解锁后再恢复' }
      return result
    }

    // 7. 关闭当前 DB
    dbService.close()

    // 8. 删陈旧 WAL/SHM → 替换 DB 文件
    removeStaleSidecars(DB_PATH)
    const dbInBackup = join(tmp, 'app.db')
    if (existsSync(dbInBackup)) {
      copyFileSync(dbInBackup, DB_PATH)
      // DB 文件已被备份内容整体替换（含 app_config 表）：内存读缓存失效，
      // 后续 appConfigRepo.get 重新查库，避免读到替换前的 stale 配置
      clearAppConfigCache()
    }

    // 9. 替换 attachments（如果备份里有）
    const attDir = join(tmp, 'attachments')
    if (existsSync(attDir)) {
      mkdirSync(ATTACHMENTS_DIR, { recursive: true })
      for (const f of readdirSync(attDir)) {
        const src = join(attDir, f)
        if (statSync(src).isFile()) copyFileSync(src, join(ATTACHMENTS_DIR, f))
      }
    }

    // 10. 重新打开 DB（预检保证此处的密钥状态与备份库一致）
    const dbKey2 = masterKeyManager.getDbKey()
    if (manifest.dbEncrypted && dbKey2) {
      dbService.open(dbKey2)
    } else {
      dbService.open()
    }
    dbService.runMigrations()

    log.info(`恢复完成: ${filename} (DB加密=${manifest.dbEncrypted})`)
    return result
  } catch (e) {
    // 恢复中途失败：尽量以无密钥/当前密钥重开，避免应用处于无 DB 状态
    try {
      const dbKey3 = masterKeyManager.getDbKey()
      if (!dbKey3) dbService.open()
      else dbService.open(dbKey3)
    } catch { /* 原库本身也无法打开，交给用户重启 */ }
    result = { ok: false, error: `恢复失败：${errMsg(e)}` }
    return result
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ─── WebDAV 配置存取 ─────────────────────────────────────────────

const CFG_KEY = 'webdav_config'

export function saveWebDAVConfig(raw: WebDAVConfig): void {
  webdavConfigSchema.parse(raw)
  // 幂等防护：已经是 v1: 密文的输入原样保留，绝不二次加密
  //（二次加密后 load 只解一层会得到密文字符串，WebDAV 鉴权永久失败）
  const passwordCipher = isCipherText(raw.passwordCipher)
    ? raw.passwordCipher
    : encryptApiKeys([raw.passwordCipher])
  const config: WebDAVConfig = { ...raw, passwordCipher }
  appConfigRepo.set(CFG_KEY, JSON.stringify(config))
}

export function loadWebDAVConfig(): WebDAVConfig | null {
  const raw = appConfigRepo.get(CFG_KEY)
  if (!raw) return null
  try {
    const cfg: WebDAVConfig = JSON.parse(raw)
    // 解密 password
    const pwdArr = decryptApiKeys(cfg.passwordCipher)
    if (pwdArr.length > 0) cfg.passwordCipher = pwdArr[0]!
    return cfg
  } catch {
    return null
  }
}

export function clearWebDAVConfig(): void {
  appConfigRepo.delete(CFG_KEY)
}
