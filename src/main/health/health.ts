// 平台管家核心（M4.3）
// 安全检测 + 垃圾清理 + 修复

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { HealthReport, CleanupResult, VacuumOutcome } from '../../shared/types'
import { dbService } from '../db/database'
import { kbVecRepo } from '../db/repositories/kb-vec.repo'
import { DB_PATH, DATA_DIR } from '../portable'

/** kb_vec_map 是否存在：从未写过向量的全新库没有这张表，清理不能因此报 no such table */
function vecMapExists(): boolean {
  return !!dbService
    .getHandle()
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_vec_map'")
    .get()
}

export class HealthService {
  report(): HealthReport {
    const db = dbService.getHandle()

    const integrityRow = db.prepare('PRAGMA integrity_check').get() as { 'integrity_check': string }
    const dbIntegrity = {
      ok: integrityRow['integrity_check'] === 'ok',
      details: integrityRow['integrity_check']
    }

    const orphanMessages = (db.prepare(`
      SELECT COUNT(*) as c FROM messages m
      LEFT JOIN conversations c ON m.conversation_id = c.id
      WHERE c.id IS NULL
    `).get() as { c: number }).c

    const orphanChunks = (db.prepare(`
      SELECT COUNT(*) as c FROM kb_chunks kc
      LEFT JOIN kb_documents d ON kc.doc_id = d.id
      WHERE d.id IS NULL
    `).get() as { c: number }).c

    const kbCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge_bases').get() as { c: number }).c
    const totalMessages = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c
    const totalConversations = (db.prepare('SELECT COUNT(*) as c FROM conversations').get() as { c: number }).c

    let totalAttachmentsBytes = 0
    const attDir = path.join(DATA_DIR, 'attachments')
    if (existsSync(attDir)) {
      try {
        for (const f of readdirSync(attDir)) {
          try {
            totalAttachmentsBytes += statSync(path.join(attDir, f)).size
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    return {
      dbIntegrity,
      orphanMessages,
      orphanChunks,
      kbCount,
      totalMessages,
      totalConversations,
      totalAttachmentsBytes
    }
  }

  cleanup(): CleanupResult {
    const db = dbService.getHandle()

    const rmMsg = db.prepare(`
      DELETE FROM messages
      WHERE conversation_id IN (
        SELECT m.conversation_id FROM messages m
        LEFT JOIN conversations c ON m.conversation_id = c.id
        WHERE c.id IS NULL
      )
    `).run().changes

    // 先清向量再删 chunk：deleteByDoc 靠 JOIN kb_chunks 找映射，
    // 顺序反了会留下「chunk 已不存在」的孤儿向量行（设置页那颗按钮才能再清掉）。
    this.cleanOrphanVectors()

    const rmChunk = db.prepare(`
      DELETE FROM kb_chunks
      WHERE doc_id IN (
        SELECT kc.doc_id FROM kb_chunks kc
        LEFT JOIN kb_documents d ON kc.doc_id = d.id
        WHERE d.id IS NULL
      )
    `).run().changes

    let beforeBytes = 0
    if (existsSync(DB_PATH)) beforeBytes = statSync(DB_PATH).size

    // §377：VACUUM 失败（SQLite busy／Windows 文件锁）以前被 ignore 掉，
    // 于是前后字节相同 ⇒「回收 0」被画成绿色成功句＝把"没跑成"演成"跑过了、没东西可回收"。
    let vacuumFailed = false
    try {
      db.exec('VACUUM')
    } catch {
      vacuumFailed = true
    }

    let afterBytes = 0
    if (existsSync(DB_PATH)) afterBytes = statSync(DB_PATH).size

    return {
      removedOrphanMessages: rmMsg,
      removedOrphanChunks: rmChunk,
      vacuumedBytes: Math.max(0, beforeBytes - afterBytes),
      vacuumFailed
    }
  }

  /**
   * 清孤儿向量（映射 + vec0 行），必须在删 kb_chunks 之前调用。
   * 覆盖两类：chunk 已不存在的孤儿映射；孤儿 chunk 所属文档的全部向量。
   * 失败不吞：异常直接冒到 IPC 层成为可见错误——此时 chunk 还没删，不会制造新的孤儿向量。
   */
  private cleanOrphanVectors(): void {
    if (!vecMapExists()) return
    const db = dbService.getHandle()

    // 1) 孤儿映射：chunk 已被删过，映射还留着（历史泄漏）
    const orphanMappings = db
      .prepare(
        `SELECT m.chunk_id FROM kb_vec_map m
         LEFT JOIN kb_chunks c ON c.id = m.chunk_id WHERE c.id IS NULL`
      )
      .all() as Array<{ chunk_id: string }>
    for (const { chunk_id } of orphanMappings) kbVecRepo.deleteByChunk(chunk_id)

    // 2) 孤儿 chunk 所属文档的向量：此时 chunk 行还在，deleteByDoc 的 JOIN 才命中
    const orphanDocIds = db
      .prepare(
        `SELECT DISTINCT c.doc_id FROM kb_chunks c
         LEFT JOIN kb_documents d ON d.id = c.doc_id WHERE d.id IS NULL`
      )
      .all() as Array<{ doc_id: string }>
    for (const { doc_id } of orphanDocIds) kbVecRepo.deleteByDoc(doc_id)
  }

  vacuum(): VacuumOutcome {
    const db = dbService.getHandle()
    let beforeBytes = 0
    if (existsSync(DB_PATH)) beforeBytes = statSync(DB_PATH).size
    // §377：跑没跑成与回收了几字节是两件事，不许都折进那一个数字
    let vacuumFailed = false
    try {
      db.exec('VACUUM')
    } catch {
      vacuumFailed = true
    }
    let afterBytes = 0
    if (existsSync(DB_PATH)) afterBytes = statSync(DB_PATH).size
    return { vacuumedBytes: Math.max(0, beforeBytes - afterBytes), vacuumFailed }
  }
}

export const healthService = new HealthService()
