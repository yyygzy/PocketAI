// 安全动作审计（目前只有加密模式切换）
//
// 定位：记录「凭据保护发生了什么变化」，不记录凭据本身，也不参与业务决策。
// 写入失败只记日志、不阻断动作——审计不可用不该把人卡在「想关加密关不掉」的状态里
// （与 approval-events 的 fail-open 同口径）。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { createLogger } from '../../logger'

const log = createLogger('security-event')

export type SecurityEventKind = 'encryption_disabled' | 'encryption_enabled'

export interface SecurityEventInput {
  kind: SecurityEventKind
  /** 人可读结论（不含密钥/口令） */
  message: string
  /** 结构化补充（凭据计数等），落库为 JSON 文本 */
  detail?: Record<string, unknown>
}

export interface SecurityEventRow {
  id: string
  kind: SecurityEventKind
  message: string
  detail: Record<string, unknown> | null
  createdAt: number
}

export const securityEventRepo = {
  /** 追加一条审计；失败返回 false 并记日志，不抛 */
  append(input: SecurityEventInput): boolean {
    try {
      dbService
        .getHandle()
        .prepare(
          'INSERT INTO security_events (id, kind, message, detail, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          randomUUID(),
          input.kind,
          input.message,
          input.detail ? JSON.stringify(input.detail) : null,
          Date.now()
        )
      return true
    } catch (e) {
      log.error('[security-event] 写入审计失败', e)
      return false
    }
  },

  /** 最近的审计（新→旧）；UI 与测试共用 */
  listRecent(limit = 20): SecurityEventRow[] {
    const rows = dbService
      .getHandle()
      .prepare(
        'SELECT id, kind, message, detail, created_at FROM security_events ORDER BY created_at DESC, rowid DESC LIMIT ?'
      )
      .all(limit) as Array<{
      id: string
      kind: SecurityEventKind
      message: string
      detail: string | null
      created_at: number
    }>
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      message: r.message,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
      createdAt: r.created_at
    }))
  }
}
