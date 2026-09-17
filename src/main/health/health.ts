// 平台管家核心（M4.3）
// 安全检测 + 垃圾清理 + 修复

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { HealthReport, CleanupResult } from '../../shared/types'
import { dbService } from '../db/database'
import { DB_PATH, DATA_DIR } from '../portable'

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

    try { db.exec('VACUUM') } catch { /* ignore */ }

    let afterBytes = 0
    if (existsSync(DB_PATH)) afterBytes = statSync(DB_PATH).size

    return {
      removedOrphanMessages: rmMsg,
      removedOrphanChunks: rmChunk,
      vacuumedBytes: Math.max(0, beforeBytes - afterBytes)
    }
  }

  vacuum(): number {
    const db = dbService.getHandle()
    let beforeBytes = 0
    if (existsSync(DB_PATH)) beforeBytes = statSync(DB_PATH).size
    try { db.exec('VACUUM') } catch { /* ignore */ }
    let afterBytes = 0
    if (existsSync(DB_PATH)) afterBytes = statSync(DB_PATH).size
    return Math.max(0, beforeBytes - afterBytes)
  }
}

export const healthService = new HealthService()
