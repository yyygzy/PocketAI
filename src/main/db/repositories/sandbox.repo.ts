// 沙箱产物仓储（v14 sandbox_files 表；v15 加 icon/description/is_app；文件本体存 data/sandbox/）
import { dbService } from '../database'
import type { SandboxFileMeta } from '../../../shared/types'

interface SandboxRow {
  id: string
  name: string
  file_name: string
  size: number
  created_at: number
  icon: string
  description: string
  is_app: number
}

function toMeta(r: SandboxRow): SandboxFileMeta {
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    createdAt: r.created_at,
    icon: r.icon ?? '📦',
    description: r.description ?? '',
    isApp: !!r.is_app
  }
}

const COLS = 'id, name, file_name, size, created_at, icon, description, is_app'

export const sandboxRepo = {
  list(): SandboxFileMeta[] {
    const rows = dbService
      .getHandle()
      .prepare(`SELECT ${COLS} FROM sandbox_files ORDER BY created_at DESC`)
      .all() as SandboxRow[]
    return rows.map(toMeta)
  },

  /** 单条（含文件名，service 层用于定位磁盘文件） */
  get(id: string): (SandboxFileMeta & { fileName: string }) | null {
    const r = dbService
      .getHandle()
      .prepare(`SELECT ${COLS} FROM sandbox_files WHERE id = ?`)
      .get(id) as SandboxRow | undefined
    return r ? { ...toMeta(r), fileName: r.file_name } : null
  },

  insert(meta: SandboxFileMeta, fileName: string): void {
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO sandbox_files (id, name, file_name, size, created_at, icon, description, is_app)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        meta.id,
        meta.name,
        fileName,
        meta.size,
        meta.createdAt,
        meta.icon,
        meta.description,
        meta.isApp ? 1 : 0
      )
  },

  /** 更新元数据（名称/图标/描述/是否应用）；字段白名单由 service 层保证 */
  updateMeta(
    id: string,
    patch: { name?: string; icon?: string; description?: string; isApp?: boolean }
  ): void {
    const sets: string[] = []
    const vals: unknown[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      vals.push(patch.name)
    }
    if (patch.icon !== undefined) {
      sets.push('icon = ?')
      vals.push(patch.icon)
    }
    if (patch.description !== undefined) {
      sets.push('description = ?')
      vals.push(patch.description)
    }
    if (patch.isApp !== undefined) {
      sets.push('is_app = ?')
      vals.push(patch.isApp ? 1 : 0)
    }
    if (sets.length === 0) return
    vals.push(id)
    dbService
      .getHandle()
      .prepare(`UPDATE sandbox_files SET ${sets.join(', ')} WHERE id = ?`)
      .run(...vals)
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM sandbox_files WHERE id = ?').run(id)
  }
}
