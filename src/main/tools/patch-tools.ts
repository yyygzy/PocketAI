// Agent 结构化补丁编辑（fs.apply_patch）：按「旧串→新串」精确替换，不整文件覆盖。
//
// 为什么需要：本地/线上模型做编程项目时，`fs_write` 要求把整份文件重新生成一遍——
// 长文件既费 token 又容易把无关行改坏。apply_patch 只传改动片段，且每处 old 必须
// **在原文件里恰好出现一次**，把"改错地方"从静默风险变成明确报错。
//
// 安全边界与 fs_write 完全相同：路径必须落在工作目录内（复用 resolveWorkspacePath），
// permission=confirm、写前留快照（复用 file-snapshots）。多文件先全部校验、再统一写盘，
// 避免"改了第一个文件、第二个才发现匹配失败"留下半截改动。
import path from 'node:path'
import fs from 'node:fs'
import type { BuiltinTool } from './builtin'
import type { ApprovalPreviewField } from '../../shared/types'
import {
  resolveWorkspacePath, readPrevText, TOO_LARGE_OR_BINARY, relativeWorkspacePathFor
} from './fs-tools'
import {
  captureSnapshot, defaultSnapshotRoot, MAX_SNAPSHOT_BYTES
} from '../agent/file-snapshots'
import { buildFileDiff, diffToText } from '../../shared/fs-diff'

/** 单次补丁的规模上限：防模型把整本字典当 patch 发过来 */
const MAX_PATCHES = 20
const MAX_EDITS_PER_FILE = 100
const MAX_OLD_CHARS = 8_000
const MAX_NEW_CHARS = 8_000
const MAX_FILE_BYTES = MAX_SNAPSHOT_BYTES
const MAX_TOTAL_NEW_BYTES = 4 * 1024 * 1024

interface PatchEdit {
  old: string
  new: string
}
interface FilePatch {
  path: string
  edits: PatchEdit[]
}
interface AppliedFile {
  rel: string
  abs: string
  before: string
  after: string
  created: boolean
}

function parsePatches(args: Record<string, unknown>): FilePatch[] {
  const raw = args?.patches
  if (!Array.isArray(raw)) throw new Error('patches 必须是数组')
  if (raw.length === 0) throw new Error('patches 不能为空')
  if (raw.length > MAX_PATCHES) throw new Error(`一次最多 ${MAX_PATCHES} 个文件`)
  return raw.map((p) => {
    if (!p || typeof p !== 'object') throw new Error('patch 格式不正确')
    const rel = String((p as FilePatch).path ?? '')
    if (!rel) throw new Error('patch.path 不能为空')
    const edits = (p as FilePatch).edits
    if (!Array.isArray(edits) || edits.length === 0) throw new Error(`patch ${rel} 的 edits 不能为空`)
    if (edits.length > MAX_EDITS_PER_FILE) throw new Error(`patch ${rel} 的 edits 过多`)
    return {
      path: rel,
      edits: edits.map((e) => {
        if (!e || typeof e !== 'object') throw new Error(`patch ${rel} 的 edit 格式不正确`)
        const oldText = String((e as PatchEdit).old ?? '')
        const newText = typeof (e as PatchEdit).new === 'string' ? (e as PatchEdit).new : ''
        if (!oldText) throw new Error(`patch ${rel} 的 old 不能为空`)
        if (oldText.length > MAX_OLD_CHARS || newText.length > MAX_NEW_CHARS) {
          throw new Error(`patch ${rel} 的片段过长`)
        }
        return { old: oldText, new: newText }
      })
    }
  })
}

/** 出现次数（不重叠）；用 indexOf 逐次推进，避免正则元字符转义问题 */
function occurrenceCount(haystack: string, needle: string): number {
  let n = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++
    i += needle.length
    if (n > 1) break // 只需判"恰好一次"，>1 可提前退出
  }
  return n
}

/**
 * 校验 + 计算所有文件的改动，不写盘。
 * 顺序应用同一文件的多个 edit：后一个基于前一个的结果匹配（允许连续替换）。
 */
function planPatches(patches: FilePatch[]): AppliedFile[] {
  const planned: AppliedFile[] = []
  let totalNewBytes = 0
  for (const p of patches) {
    const abs = resolveWorkspacePath(p.path) // 工作目录守卫（含符号链接逃逸防护）
    const prev = readPrevText(abs)
    if (prev === TOO_LARGE_OR_BINARY) {
      throw new Error(`patch ${p.path} 的现有文件不是可读文本（过大或二进制），不能用补丁改`)
    }
    const before = prev ?? ''
    let after = before
    for (const edit of p.edits) {
      const count = occurrenceCount(after, edit.old)
      if (count === 0) throw new Error(`patch ${p.path}：old 片段在文件中找不到（可能已被改过）`)
      if (count > 1) throw new Error(`patch ${p.path}：old 片段在文件中出现多次，改哪处有歧义`)
      after = after.replace(edit.old, edit.new)
    }
    if (after === before) throw new Error(`patch ${p.path}：补丁没有产生任何变化`)
    totalNewBytes += Buffer.byteLength(after, 'utf-8')
    if (totalNewBytes > MAX_TOTAL_NEW_BYTES) throw new Error('补丁写出的总内容过大')
    // 写后文件也必须在快照上限内，否则不留快照（与原 fs_write 同口径）
    if (Buffer.byteLength(after, 'utf-8') > MAX_FILE_BYTES) {
      throw new Error(`patch ${p.path} 写出的文件超过 ${MAX_FILE_BYTES} 字节，请用 fs_write 分批处理`)
    }
    planned.push({ rel: p.path, abs, before, after, created: prev === null })
  }
  return planned
}

function commitPatches(planned: AppliedFile[]): string {
  const out: Array<Record<string, unknown>> = []
  for (const f of planned) {
    const snap =
      f.before === '' && f.created
        ? captureSnapshot(defaultSnapshotRoot(), {
            relPath: relativeWorkspacePathFor(f.abs),
            prevExists: false,
            prevContent: '',
            wroteContent: f.after
          })
        : captureSnapshot(defaultSnapshotRoot(), {
            relPath: relativeWorkspacePathFor(f.abs),
            prevExists: !f.created,
            prevContent: f.before,
            wroteContent: f.after
          })
    fs.mkdirSync(path.dirname(f.abs), { recursive: true })
    fs.writeFileSync(f.abs, f.after, 'utf-8')
    out.push({
      path: f.rel,
      bytes: Buffer.byteLength(f.after, 'utf-8'),
      created: f.created,
      edits: f.after.split('\n').length,
      snapshotId: snap?.id ?? null
    })
  }
  return JSON.stringify({ files: out, count: out.length })
}

export interface ApplyPatchPreview {
  reason: string
  fields: ApprovalPreviewField[]
}

/** 审批弹窗预览：每个文件给出统计与行级 diff（复用 fs_write 的 diff 工具） */
export function buildApplyPatchPreview(args: Record<string, unknown>): ApplyPatchPreview {
  let patches: FilePatch[]
  try {
    patches = parsePatches(args)
  } catch {
    return { reason: 'APPLY_PATCH_BAD_ARGS', fields: [] }
  }
  try {
    const planned = planPatches(patches)
    // key 必须固定（动态 key 在四语字典里不存在，界面会露出裸码）：
    // 统计与 diff 各一个字段，多文件在一个字段里分段列出。
    const stats: string[] = []
    const diffs: string[] = []
    for (const f of planned) {
      const diff = buildFileDiff(f.before, f.after)
      const flags = `${diff.coarse ? ' ~' : ''}${diff.truncated ? ' ⋯' : ''}`
      stats.push(`${f.rel}: +${diff.added} -${diff.removed}${flags}`)
      diffs.push(`── ${f.rel}\n${diffToText(diff.rows)}`)
    }
    const fields: ApprovalPreviewField[] = [
      { key: 'apply_patch_count', value: String(planned.length) },
      { key: 'apply_patch_stats', value: stats.join('\n') },
      { key: 'apply_patch_diff', value: diffs.join('\n'), mono: true }
    ]
    return { reason: 'APPLY_PATCH_CHANGES', fields }
  } catch (e) {
    return { reason: 'APPLY_PATCH_INVALID', fields: [{ key: 'apply_patch_error', value: e instanceof Error ? e.message : String(e) }] }
  }
}

const applyPatchTool: BuiltinTool = {
  schema: {
    id: 'fs.apply_patch',
    name: 'fs_apply_patch',
    description:
      '在 Agent 工作目录内按「旧片段→新片段」精确修改文本（可多文件、每文件多处）。每处 old 必须在文件中恰好出现一次，全部校验通过后才会写盘。会先请你确认。参数：patches (数组，每项 {path: string, edits: [{old: string, new: string}]})。',
    parameters: {
      type: 'object',
      properties: {
        patches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对工作目录的文件路径' },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    old: { type: 'string', description: '要替换的原文片段（必须恰好出现一次）' },
                    new: { type: 'string', description: '替换后的新片段' }
                  },
                  required: ['old', 'new'],
                  additionalProperties: false
                }
              }
            },
            required: ['path', 'edits'],
            additionalProperties: false
          }
        }
      },
      required: ['patches'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'confirm'
  },
  policyReason: 'WRITES_WORKSPACE_FILE',
  async execute(args) {
    const patches = parsePatches(args)
    const planned = planPatches(patches)
    return commitPatches(planned)
  }
}

/** 未设置工作目录时不注册（与 fs_write 同口径） */
export function getPatchTools(): BuiltinTool[] {
  // 复用 fs-tools 的守卫：无工作目录时 apply_patch 也必须不存在
  // （间接调用 resolveWorkspacePath 会在 execute 时抛，但工具不该出现在模型可见面）
  // 这里用一次轻量探测：尝试解析 '.'，失败即无工作目录
  try {
    resolveWorkspacePath('.')
  } catch {
    return []
  }
  return [applyPatchTool]
}
