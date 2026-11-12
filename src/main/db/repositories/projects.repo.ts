// 多文件项目（v70）元数据与文件清单仓库。
// 幂等键与 artifacts 同一口径：同一次运行的同一工具步重复执行时复用已有项目。
import path from 'node:path'
import { dbService } from '../database'
import { GENERATED_DIR } from '../../../shared/artifacts'
import type { ProjectFileEntry, ProjectMeta } from '../../../shared/types'

interface ProjectRow {
  id: string
  name: string
  dir_name: string
  file_count: number
  total_bytes: number
  conversation_id: string | null
  request_id: string | null
  step_index: number | null
  created_at: number
}

interface ProjectFileRow {
  path: string
  sha256: string
  size: number
}

const COLS = 'id, name, dir_name, file_count, total_bytes, conversation_id, request_id, step_index, created_at'

function toMeta(r: ProjectRow): ProjectMeta {
  return {
    id: r.id,
    name: r.name,
    dirName: r.dir_name,
    fileCount: r.file_count,
    totalBytes: r.total_bytes,
    createdAt: r.created_at,
    relPath: path.posix.join(GENERATED_DIR, 'projects', r.dir_name)
  }
}

export const projectsRepo = {
  create(
    input: {
      id: string
      name: string
      dirName: string
      conversationId: string | null
      requestId: string | null
      stepIndex: number | null
      createdAt: number
    },
    files: ProjectFileEntry[]
  ): ProjectMeta {
    const db = dbService.getHandle()
    const totalBytes = files.reduce((n, f) => n + f.size, 0)
    const insertProject = db.prepare(
      `INSERT INTO projects (id, name, dir_name, file_count, total_bytes, conversation_id, request_id, step_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertFile = db.prepare(
      'INSERT INTO project_files (project_id, path, sha256, size) VALUES (?, ?, ?, ?)'
    )
    const tx = db.transaction(() => {
      insertProject.run(
        input.id,
        input.name,
        input.dirName,
        files.length,
        totalBytes,
        input.conversationId,
        input.requestId,
        input.stepIndex,
        input.createdAt
      )
      for (const f of files) insertFile.run(input.id, f.path, f.sha256, f.size)
    })
    tx()
    return {
      id: input.id,
      name: input.name,
      dirName: input.dirName,
      fileCount: files.length,
      totalBytes,
      createdAt: input.createdAt,
      relPath: path.posix.join(GENERATED_DIR, 'projects', input.dirName)
    }
  },

  get(id: string): ProjectMeta | null {
    const row = dbService
      .getHandle()
      .prepare(`SELECT ${COLS} FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined
    return row ? toMeta(row) : null
  },

  listFiles(id: string): ProjectFileEntry[] {
    return dbService
      .getHandle()
      .prepare('SELECT path, sha256, size FROM project_files WHERE project_id = ? ORDER BY path')
      .all(id) as ProjectFileRow[]
  },

  /** 幂等：同一次运行的同一工具步 + 同一项目名 → 复用已有项目 */
  findByRunStep(requestId: string, stepIndex: number, name: string): ProjectMeta | null {
    const row = dbService
      .getHandle()
      .prepare(
        `SELECT ${COLS} FROM projects
         WHERE request_id = ? AND step_index = ? AND name = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(requestId, stepIndex, name) as ProjectRow | undefined
    return row ? toMeta(row) : null
  },

  delete(id: string): void {
    const db = dbService.getHandle()
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM project_files WHERE project_id = ?').run(id)
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    })
    tx()
  }
}
