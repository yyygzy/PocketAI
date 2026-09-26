// 双向合并服务：从云端备份合并到本地 DB（行级 LWW + 冲突人工选择）
//
// 与 restoreFromWebDAV 的区别：
// - restore：云端 DB 整体替换本地 DB（本地新增会丢失）
// - merge：逐行合并，保留两侧新增，冲突行按用户策略取舍
//
// 合并策略：
//   用户内容表（conversations/messages/notes/images/translations/
//              translation_glossary/sandbox_files）：行级合并
//   配置类表（assistants/providers/skills/mcp_servers/
//            knowledge_bases/kb_documents/kb_chunks）：云端覆盖
//   本地保留表（app_config/field_keys/license_records/schema_migrations）：不动
//
// 冲突：同 id 两边都存在且内容/时间戳不同。用户可选 local/cloud/newer。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'
import { dbService } from '../db/database'
import { masterKeyManager } from '../crypto/master-key'
import {
  type WebDAVConfig,
  type IncrementalIndex,
  isEncryptedBlob,
  ENC_PREFIX,
  ENC_PREFIX_V1,
  ENC_PREFIX_V2,
  decryptBackup,
  deriveBackupDbKey,
  BackupDecryptError,
  toCreds
} from './backup-service'
import { downloadFile, downloadRemoteFile } from './webdav-client'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import type { MergeStrategy, MergeConflictReport, MergeTableConflict as TableConflict } from '../../shared/types'

const log = createLogger('merge')

/** 单表冲突统计（复用 shared 类型别名） */
export type { TableConflict }

/** 合并解密选项：backupPassword 为制作备份时的主密码（异机合并） */
export interface MergeOpts {
  backupPassword?: string
}

/** 合并结果的密码三态（与 BackupRestoreResult.code 同语义） */
export type MergeResultCode = 'needBackupPassword' | 'badPassword' | 'legacyNoCross'

/** 合并路径统一解密：salt 内嵌偏移对 PKBK1/PKBK2 一致；错误原样冒泡由调用方映射 */
function decryptMergeBlob(blob: Buffer, opts: MergeOpts): Buffer {
  const salt = blob.subarray(ENC_PREFIX.length + 12, ENC_PREFIX.length + 12 + 16)
  return decryptBackup(blob, salt, opts.backupPassword ? { password: opts.backupPassword } : undefined)
}

/** 异机合并时从加密信封派生备份库（只读云库）的 SQLCipher key；同机回退当前会话密钥 */
function cloudKeyFor(blob: Buffer, opts: MergeOpts): Buffer | null {
  if (opts.backupPassword) return deriveBackupDbKey(blob, opts.backupPassword)
  return masterKeyManager.getDbKey()
}

/** 把备份解密错误映射为合并结果 code（非解密错误返回 undefined） */
function mapDecryptCode(e: unknown): MergeResultCode | undefined {
  if (!(e instanceof BackupDecryptError)) return undefined
  if (e.code === 'badPassword') return 'badPassword'
  if (e.code === 'legacyNoCross') return 'legacyNoCross'
  if (e.code === 'needPassword') return 'needBackupPassword'
  return undefined
}

// ─── 表分类配置 ───────────────────────────────────────────────────

/** 行级合并的用户内容表：主键 + 时间戳列（用于冲突检测与 newer 策略） */
const ROW_MERGE_TABLES: Array<{ table: string; tsCol: string | null }> = [
  { table: 'conversations', tsCol: 'updated_at' },
  { table: 'messages', tsCol: 'created_at' },
  { table: 'notes', tsCol: 'updated_at' },
  { table: 'images', tsCol: 'created_at' },
  { table: 'translations', tsCol: 'created_at' },
  { table: 'translation_glossary', tsCol: 'created_at' },
  { table: 'sandbox_files', tsCol: 'created_at' }
]

/** 云端覆盖的配置类表 */
const CLOUD_OVERWRITE_TABLES = [
  'assistants', 'providers', 'skills', 'mcp_servers',
  'knowledge_bases', 'kb_documents', 'kb_chunks'
]

/** 本地保留不动的表（不参与合并） */
const LOCAL_KEEP_TABLES = [
  'app_config', 'field_keys', 'license_records', 'schema_migrations'
]
void LOCAL_KEEP_TABLES

// ─── 工具函数 ────────────────────────────────────────────────────

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 获取表的所有列名 */
function getColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/** 计算行内容哈希（排除 id 列）用于冲突检测 */
function rowHash(row: Record<string, unknown>, idCol = 'id'): string {
  const keys = Object.keys(row).filter((k) => k !== idCol).sort()
  const parts = keys.map((k) => `${k}=${row[k] === null ? '∅' : String(row[k])}`)
  return sha256Hex(Buffer.from(parts.join('|'), 'utf8'))
}

// ─── 下载并准备云端 DB ───────────────────────────────────────────

/**
 * 从云端备份中提取 app.db 到临时文件，并（全量备份时）解压附件到临时目录。
 * 支持全量 zip 包和增量索引两种格式。
 * 返回临时 DB 文件路径、附件目录路径（增量备份为 null）及清理函数。
 */
async function extractCloudDb(
  cfg: WebDAVConfig,
  filename: string,
  opts: MergeOpts = {}
): Promise<{ dbPath: string; attachmentsDir: string | null; cloudDbKey: Buffer | null; cleanup: () => void }> {
  const creds = toCreds(cfg)
  const tmp = join(tmpdir(), `pocketai-merge-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cleanup = () => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  try {
    if (filename.startsWith('pocketai-inc-')) {
      // 增量索引：下载索引 → 取 DB blob → 下载 blob → 解密 → 落盘
      const indexRaw = await downloadFile(creds, filename)
      let indexBuf = indexRaw
      if (isEncryptedBlob(indexRaw, filename)) {
        indexBuf = decryptMergeBlob(indexRaw, opts)
      }
      // 云库 key：密码路径从索引信封派生，同机路径用当前会话密钥
      const cloudDbKey = isEncryptedBlob(indexRaw, filename) ? cloudKeyFor(indexRaw, opts) : null
      const index = JSON.parse(indexBuf.toString('utf8')) as IncrementalIndex
      if (index.kind !== 'pocketai-incremental' || !index.db?.blob) {
        throw new Error('不是有效的增量备份索引')
      }

      const blobRaw = await downloadRemoteFile(creds, index.db.blob)
      let dbBuf = blobRaw
      if (index.encrypted || isEncryptedBlob(blobRaw, index.db.blob)) {
        dbBuf = decryptMergeBlob(blobRaw, opts)
      }
      // 校验 sha256
      if (sha256Hex(dbBuf) !== index.db.sha256) {
        throw new Error('DB blob 校验失败（sha256 不匹配）')
      }
      const dbPath = join(tmp, 'cloud.db')
      writeFileSync(dbPath, dbBuf)
      // 增量备份的附件按需单独下载，这里不解压
      return { dbPath, attachmentsDir: null, cloudDbKey, cleanup }
    }

    // 全量 zip 包：下载 → 解密 → 解压 → 取 app.db + attachments/
    const blob = await downloadFile(creds, filename)
    // 加密判定看扩展名 + 信封魔数（WebDA 文件被改名也不漏解密）
    const head = blob.subarray(0, 5).toString('latin1')
    const isEncrypted = filename.endsWith('.enc.zip') || head === ENC_PREFIX_V1 || head === ENC_PREFIX_V2
    let zipBuf = blob
    if (isEncrypted) {
      zipBuf = decryptMergeBlob(blob, opts)
    }
    const cloudDbKey = isEncrypted ? cloudKeyFor(blob, opts) : null

    // 解压到临时目录
    const unzipper = await import('unzipper')
    await new Promise<void>((resolve, reject) => {
      const { Readable } = require('node:stream')
      Readable.from(zipBuf)
        .pipe(unzipper.Extract({ path: tmp }))
        .on('close', resolve)
        .on('error', reject)
    })

    const dbPath = join(tmp, 'app.db')
    if (!existsSync(dbPath)) throw new Error('备份包缺少 app.db')

    // 附件目录（全量备份可能包含）
    const attDir = join(tmp, 'attachments')
    const attachmentsDir = existsSync(attDir) ? attDir : null

    return { dbPath, attachmentsDir, cloudDbKey, cleanup }
  } catch (e) {
    cleanup()
    throw e
  }
}

/**
 * 打开临时云端 DB（只读）处理 sqlcipher 加密。
 * explicitKey 为异机合并时从备份信封派生的云库 key；不传则用当前会话密钥（同机）。
 * 注意：不切换全局 masterKeyManager——本地库仍以原密钥打开，合并只写本地库。
 */
function openCloudDb(dbPath: string, explicitKey?: Buffer | null): Database.Database {
  const db = new Database(dbPath, { readonly: true })
  const dbKey = explicitKey !== undefined ? explicitKey : masterKeyManager.getDbKey()
  if (dbKey) {
    db.pragma('cipher = sqlcipher')
    db.pragma('legacy = 0')
    db.pragma(`key = "x'${dbKey.toString('hex')}'"`)
  }
  // 验证可读取
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch {
    db.close()
    throw new Error('云端备份 DB 无法打开：加密密钥不匹配或文件损坏')
  }
  return db
}

// ─── 冲突扫描 ────────────────────────────────────────────────────

/** 扫描单表的冲突情况 */
export function scanTableConflicts(localDb: Database.Database, cloudDb: Database.Database, table: string, _tsCol: string | null): TableConflict {
  const result: TableConflict = { table, cloudOnly: 0, localOnly: 0, both: 0 }

  // 检查表是否在云端存在
  const cloudTbl = cloudDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if (!cloudTbl) return result

  const localRows = localDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
  const cloudRows = cloudDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>

  const localMap = new Map<string, Record<string, unknown>>()
  for (const r of localRows) localMap.set(String(r.id), r)

  const cloudMap = new Map<string, Record<string, unknown>>()
  for (const r of cloudRows) cloudMap.set(String(r.id), r)

  for (const [id, cloudRow] of cloudMap) {
    const localRow = localMap.get(id)
    if (!localRow) {
      result.cloudOnly++
    } else {
      // 两边都有：比较内容
      const localHash = rowHash(localRow)
      const cloudHash = rowHash(cloudRow)
      if (localHash !== cloudHash) result.both++
    }
  }

  for (const id of localMap.keys()) {
    if (!cloudMap.has(id)) result.localOnly++
  }

  return result
}

/** 扫描所有表的冲突，返回报告 */
export async function scanMergeConflicts(
  cfg: WebDAVConfig,
  filename: string,
  opts: MergeOpts = {}
): Promise<MergeConflictReport> {
  let cloudDb: Database.Database | null = null
  let cleanup: (() => void) | null = null

  try {
    const extracted = await extractCloudDb(cfg, filename, opts)
    cleanup = extracted.cleanup
    cloudDb = openCloudDb(extracted.dbPath, extracted.cloudDbKey)

    const localDb = dbService.getHandle()
    const tables: TableConflict[] = []

    for (const { table, tsCol } of ROW_MERGE_TABLES) {
      tables.push(scanTableConflicts(localDb, cloudDb, table, tsCol))
    }

    // 附件统计：云端有但本地没有的附件数量
    let attachmentsToAdd = 0
    const { ATTACHMENTS_DIR } = await import('../portable')

    if (filename.startsWith('pocketai-inc-')) {
      // 增量索引：解析附件列表，统计本地不存在的
      const creds = toCreds(cfg)
      const indexRaw = await downloadFile(creds, filename)
      let indexBuf = indexRaw
      if (isEncryptedBlob(indexRaw, filename)) {
        indexBuf = decryptMergeBlob(indexRaw, opts)
      }
      const index = JSON.parse(indexBuf.toString('utf8')) as IncrementalIndex
      for (const a of index.attachments || []) {
        const local = join(ATTACHMENTS_DIR, a.name)
        if (!existsSync(local)) attachmentsToAdd++
      }
    } else if (extracted.attachmentsDir) {
      // 全量备份：遍历临时附件目录，统计本地不存在的
      const { readdirSync, statSync } = await import('node:fs')
      for (const name of readdirSync(extracted.attachmentsDir)) {
        const src = join(extracted.attachmentsDir, name)
        try {
          if (!statSync(src).isFile()) continue
          const local = join(ATTACHMENTS_DIR, name)
          if (!existsSync(local)) attachmentsToAdd++
        } catch { /* skip */ }
      }
    }

    return { ok: true, tables, attachmentsToAdd }
  } catch (e) {
    const code = mapDecryptCode(e)
    return {
      ok: false,
      code,
      error: code ? (e as Error).message : errMsg(e, '扫描冲突失败'),
      tables: [],
      attachmentsToAdd: 0
    }
  } finally {
    if (cloudDb) {
      try { cloudDb.close() } catch { /* ignore */ }
    }
    if (cleanup) cleanup()
  }
}

// ─── 执行合并 ────────────────────────────────────────────────────

/** 合并单表（行级合并） */
export function mergeTable(
  localDb: Database.Database,
  cloudDb: Database.Database,
  table: string,
  tsCol: string | null,
  strategy: MergeStrategy
): { inserted: number; updated: number; skipped: number } {
  const cloudTbl = cloudDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if (!cloudTbl) return { inserted: 0, updated: 0, skipped: 0 }

  const columns = getColumns(cloudDb, table)
  if (columns.length === 0) return { inserted: 0, updated: 0, skipped: 0 }

  const cloudRows = cloudDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
  const localRows = localDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
  const localMap = new Map<string, Record<string, unknown>>()
  for (const r of localRows) localMap.set(String(r.id), r)

  const placeholders = columns.map(() => '?').join(', ')
  const colList = columns.join(', ')
  const insertStmt = localDb.prepare(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`)
  const updateSets = columns.filter((c) => c !== 'id').map((c) => `${c}=?`).join(', ')
  const updateStmt = localDb.prepare(`UPDATE ${table} SET ${updateSets} WHERE id=?`)

  let inserted = 0
  let updated = 0
  let skipped = 0

  const tx = localDb.transaction(() => {
    for (const cloudRow of cloudRows) {
      const id = String(cloudRow.id)
      const localRow = localMap.get(id)

      if (!localRow) {
        // 仅云端有：直接插入
        const vals = columns.map((c) => cloudRow[c] ?? null)
        insertStmt.run(...vals)
        inserted++
        continue
      }

      // 两边都有：比较内容
      const localHash = rowHash(localRow)
      const cloudHash = rowHash(cloudRow)
      if (localHash === cloudHash) {
        skipped++
        continue
      }

      // 冲突：按策略处理
      let useCloud = false
      if (strategy === 'cloud') {
        useCloud = true
      } else if (strategy === 'local') {
        useCloud = false
      } else {
        // newer：有时间戳列则比较，否则默认云端
        if (tsCol) {
          const localTs = Number(localRow[tsCol] ?? 0)
          const cloudTs = Number(cloudRow[tsCol] ?? 0)
          useCloud = cloudTs > localTs
        } else {
          useCloud = true
        }
      }

      if (useCloud) {
        const vals = columns.filter((c) => c !== 'id').map((c) => cloudRow[c] ?? null)
        updateStmt.run(...vals, id)
        updated++
      } else {
        skipped++
      }
    }
  })

  tx()
  return { inserted, updated, skipped }
}

/** 云端覆盖配置类表 */
export function overwriteTable(localDb: Database.Database, cloudDb: Database.Database, table: string): number {
  const cloudTbl = cloudDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if (!cloudTbl) return 0

  const columns = getColumns(cloudDb, table)
  if (columns.length === 0) return 0

  const cloudRows = cloudDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
  const placeholders = columns.map(() => '?').join(', ')
  const colList = columns.join(', ')

  let count = 0
  const tx = localDb.transaction(() => {
    localDb.prepare(`DELETE FROM ${table}`).run()
    if (cloudRows.length > 0) {
      const insertStmt = localDb.prepare(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`)
      for (const row of cloudRows) {
        const vals = columns.map((c) => row[c] ?? null)
        insertStmt.run(...vals)
        count++
      }
    }
  })
  tx()
  return count
}

/** 执行合并恢复 */
export async function executeMerge(
  cfg: WebDAVConfig,
  filename: string,
  strategy: MergeStrategy,
  opts: MergeOpts = {}
): Promise<{ ok: boolean; error?: string; summary?: string; code?: MergeResultCode }> {
  let cloudDb: Database.Database | null = null
  let cleanup: (() => void) | null = null

  try {
    const extracted = await extractCloudDb(cfg, filename, opts)
    cleanup = extracted.cleanup
    cloudDb = openCloudDb(extracted.dbPath, extracted.cloudDbKey)

    const localDb = dbService.getHandle()
    const summaryParts: string[] = []

    // 1. 行级合并用户内容表
    for (const { table, tsCol } of ROW_MERGE_TABLES) {
      const r = mergeTable(localDb, cloudDb, table, tsCol, strategy)
      if (r.inserted || r.updated) {
        summaryParts.push(`${table}: +${r.inserted} ~${r.updated}`)
      }
    }

    // 2. 云端覆盖配置类表
    for (const table of CLOUD_OVERWRITE_TABLES) {
      const n = overwriteTable(localDb, cloudDb, table)
      if (n > 0) summaryParts.push(`${table}: ${n} 行(云端)`)
    }

    // 3. 附件合并
    const { ATTACHMENTS_DIR } = await import('../portable')
    mkdirSync(ATTACHMENTS_DIR, { recursive: true })
    let attAdded = 0

    if (filename.startsWith('pocketai-inc-')) {
      // 增量备份：按 sha256 去重下载缺失附件
      const creds = toCreds(cfg)
      const indexRaw = await downloadFile(creds, filename)
      let indexBuf = indexRaw
      if (isEncryptedBlob(indexRaw, filename)) {
        indexBuf = decryptMergeBlob(indexRaw, opts)
      }
      const index = JSON.parse(indexBuf.toString('utf8')) as IncrementalIndex

      for (const a of index.attachments || []) {
        if (a.name.includes('/') || a.name.includes('\\') || a.name.includes('..')) continue
        const local = join(ATTACHMENTS_DIR, a.name)
        if (existsSync(local)) {
          try {
            if (sha256Hex(readFileSync(local)) === a.sha256) continue
          } catch { /* 下载 */ }
        }
        const blobRaw = await downloadRemoteFile(creds, a.blob)
        let data = blobRaw
        if (index.encrypted || isEncryptedBlob(blobRaw, a.blob)) {
          data = decryptMergeBlob(blobRaw, opts)
        }
        if (sha256Hex(data) !== a.sha256) continue
        writeFileSync(local, data)
        attAdded++
      }
    } else if (extracted.attachmentsDir) {
      // 全量备份：从临时附件目录复制缺失附件到本地（按文件名去重）
      const { readdirSync, statSync, copyFileSync } = await import('node:fs')
      for (const name of readdirSync(extracted.attachmentsDir)) {
        if (name.includes('/') || name.includes('\\') || name.includes('..')) continue
        const src = join(extracted.attachmentsDir, name)
        try {
          if (!statSync(src).isFile()) continue
          const local = join(ATTACHMENTS_DIR, name)
          // 本地已有同名文件则跳过（不覆盖，避免覆盖本地更新的附件）
          if (existsSync(local)) continue
          copyFileSync(src, local)
          attAdded++
        } catch { /* skip */ }
      }
    }

    if (attAdded > 0) summaryParts.push(`附件: +${attAdded}`)

    log.info(`合并完成: ${filename} (${summaryParts.join(', ') || '无变化'})`)
    return { ok: true, summary: summaryParts.join('; ') || '无变化' }
  } catch (e) {
    const code = mapDecryptCode(e)
    return {
      ok: false,
      code,
      error: code ? (e as Error).message : errMsg(e, '合并失败')
    }
  } finally {
    if (cloudDb) {
      try { cloudDb.close() } catch { /* ignore */ }
    }
    if (cleanup) cleanup()
  }
}
