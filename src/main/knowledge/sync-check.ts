// 文档增量同步检测：对比 file 文档入库时的内容 sha256 与磁盘当前内容，
// 找出「已变更 / 源文件丢失」的文档，供 KB 详情页一键重索引或移除。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import type { KbDocument } from '../../shared/types'

/** 计算文件内容 sha256（读不到文件时抛错，由调用方决定语义） */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => h.update(chunk))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', reject)
  })
}

export interface SyncIssue {
  docId: string
  title: string
  source: string
  /** changed：内容有更新；missing：源文件已丢失 */
  kind: 'changed' | 'missing'
}

export interface SyncCheckResult {
  /** 检查的 file 文档总数 */
  checked: number
  /** 无变化数量 */
  unchanged: number
  /** 已变更 + 丢失清单（列表按 changed 在前） */
  issues: SyncIssue[]
}

/** 纯函数：单个 file 文档分类（磁盘 hash vs 入库 hash）。
 *  仅处理入库时记录过 hash 的文档（手工录入/URL/旧数据 hash 为 null，不参与检测） */
export function classifyFileDoc(
  storedHash: string,
  currentHash: string | null
): 'changed' | 'missing' | 'unchanged' {
  // 源文件读不到 → 丢失
  if (currentHash === null) return 'missing'
  return storedHash === currentHash ? 'unchanged' : 'changed'
}

/**
 * 检查一个知识库内所有 file 文档的源文件变更。
 * 只检测入库时记录过 hash 的文档（contentHash 非 null）；旧数据需重索引一次后纳入检测范围。
 */
export async function checkKbFileUpdates(kbId: string): Promise<SyncCheckResult> {
  const docs = kbDocRepo.list(kbId).filter((d) => d.sourceType !== 'url' && d.contentHash !== null)
  const issues: SyncIssue[] = []
  let unchanged = 0

  for (const doc of docs) {
    let currentHash: string | null = null
    try {
      currentHash = await hashFile(doc.source)
    } catch {
      currentHash = null
    }
    const verdict = classifyFileDoc(doc.contentHash!, currentHash)
    if (verdict === 'unchanged') {
      unchanged++
    } else {
      issues.push({ docId: doc.id, title: docTitle(doc), source: doc.source, kind: verdict })
    }
  }

  return { checked: docs.length, unchanged, issues }
}

function docTitle(doc: KbDocument): string {
  return doc.title || doc.source
}
