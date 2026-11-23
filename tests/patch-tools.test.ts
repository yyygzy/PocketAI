// fs.apply_patch 结构化补丁回归：
//  ① 精确替换（old 恰好一次）、多 edit 顺序应用、多文件原子写盘
//  ② 找不到 / 出现多次 / 无变化 → 拒绝且不写盘
//  ③ 工作目录边界（复用 resolveWorkspacePath）
//  ④ 快照留痕（复用 file-snapshots）
//  ⑤ 审批预览字段固定 key（不露动态裸码）
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  const files = new Map<string, string>()
  const snapshots: Array<{ relPath: string; prevContent: string; wroteContent: string }> = []
  return {
    store, files, snapshots,
    appConfigRepo: {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => { store.set(k, v) },
      delete: (k: string) => { store.delete(k) }
    },
    fs: {
      existsSync: (p: string) => files.has(p) || p === 'C:\\agent-workspace',
      realpathSync: (p: string) => p,
      mkdirSync: () => {},
      writeFileSync: (p: string, data: string) => { files.set(p, data) },
      readFileSync: (p: string, _enc: string) => {
        if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return files.get(p)!
      },
      statSync: (p: string) => {
        const data = files.get(p)
        if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { isFile: () => true, size: Buffer.byteLength(data, 'utf-8') }
      }
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: mocks.appConfigRepo }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('node:fs', () => ({ ...mocks.fs, default: mocks.fs }))
vi.mock('../src/main/agent/file-snapshots', () => ({
  MAX_SNAPSHOT_BYTES: 1024 * 1024,
  defaultSnapshotRoot: () => 'C:\\snapshots',
  captureSnapshot: (_root: string, p: { relPath: string; prevContent: string; wroteContent: string }) => {
    mocks.snapshots.push(p)
    return { id: 'snap-' + mocks.snapshots.length }
  }
}))

import { setWorkspaceDir } from '../src/main/tools/fs-tools'
import { getPatchTools, buildApplyPatchPreview } from '../src/main/tools/patch-tools'

const WS = 'C:\\agent-workspace'
const tool = () => getPatchTools()[0]!

beforeEach(() => {
  mocks.store.clear()
  mocks.files.clear()
  mocks.snapshots.length = 0
  setWorkspaceDir(WS)
})

function put(rel: string, content: string) {
  mocks.files.set(path.join(WS, rel), content)
}
function get(rel: string): string | undefined {
  return mocks.files.get(path.join(WS, rel))
}

describe('fs.apply_patch 精确替换', () => {
  it('old 恰好出现一次 → 替换；留快照；返回统计', async () => {
    put('a.ts', 'const a = 1\nconst b = 2\n')
    const out = await tool().execute({ patches: [{ path: 'a.ts', edits: [{ old: 'const a = 1', new: 'const a = 3' }] }] })
    expect(get('a.ts')).toBe('const a = 3\nconst b = 2\n')
    expect(JSON.parse(out)).toMatchObject({ count: 1, files: [{ path: 'a.ts', created: false }] })
    expect(mocks.snapshots).toHaveLength(1)
    expect(mocks.snapshots[0]!.prevContent).toContain('const a = 1')
  })

  it('同一文件多个 edit 顺序应用（后一个基于前一个的结果）', async () => {
    put('a.ts', 'let x = 1\nlet y = 2\n')
    await tool().execute({ patches: [{ path: 'a.ts', edits: [
      { old: 'let x = 1', new: 'const x = 10' },
      { old: 'const x = 10', new: 'const x = 100' }
    ] }] })
    expect(get('a.ts')).toBe('const x = 100\nlet y = 2\n')
  })

  it('多文件补丁全部写盘', async () => {
    put('a.ts', 'A')
    put('b.ts', 'B')
    const out = await tool().execute({ patches: [
      { path: 'a.ts', edits: [{ old: 'A', new: 'A2' }] },
      { path: 'b.ts', edits: [{ old: 'B', new: 'B2' }] }
    ] })
    expect(get('a.ts')).toBe('A2')
    expect(get('b.ts')).toBe('B2')
    expect(JSON.parse(out).count).toBe(2)
  })

  it('新建文件（old 为整段空语义不行，但可 patch 一个占位）', async () => {
    // 新文件无原文可匹配，apply_patch 不适用——应由 fs_write 建；这里验证它明确拒绝
    await expect(tool().execute({ patches: [{ path: 'new.ts', edits: [{ old: 'x', new: 'y' }] }] })).rejects.toThrow('找不到')
    expect(get('new.ts')).toBeUndefined()
  })
})

describe('fs.apply_patch 拒绝与原子性', () => {
  it('old 找不到 → 拒绝', async () => {
    put('a.ts', 'hello')
    await expect(tool().execute({ patches: [{ path: 'a.ts', edits: [{ old: 'world', new: 'x' }] }] })).rejects.toThrow('找不到')
    expect(get('a.ts')).toBe('hello')
  })

  it('old 出现多次 → 拒绝（改哪处有歧义）', async () => {
    put('a.ts', 'dup\ndup\n')
    await expect(tool().execute({ patches: [{ path: 'a.ts', edits: [{ old: 'dup', new: 'x' }] }] })).rejects.toThrow('出现多次')
    expect(get('a.ts')).toBe('dup\ndup\n')
  })

  it('多文件里第二个无效 → 第一个也不写（原子性）', async () => {
    put('a.ts', 'A')
    put('b.ts', 'B')
    await expect(tool().execute({ patches: [
      { path: 'a.ts', edits: [{ old: 'A', new: 'A2' }] },
      { path: 'b.ts', edits: [{ old: 'NOPE', new: 'x' }] }
    ] })).rejects.toThrow('找不到')
    expect(get('a.ts')).toBe('A')
    expect(get('b.ts')).toBe('B')
    expect(mocks.snapshots).toHaveLength(0)
  })

  it('路径越界 → 拒绝（工作目录守卫）', async () => {
    await expect(tool().execute({ patches: [
      { path: '..\\outside.ts', edits: [{ old: 'x', new: 'y' }] }
    ] })).rejects.toThrow()
  })

  it('工具权限为 confirm、原因码复用 WRITES_WORKSPACE_FILE', () => {
    expect(tool().schema.permission).toBe('confirm')
    expect(tool().policyReason).toBe('WRITES_WORKSPACE_FILE')
  })
})

describe('apply_patch 审批预览', () => {
  it('字段 key 固定，reason 明确，不露文件路径当 key', () => {
    put('a.ts', 'old line\nkeep\n')
    const pv = buildApplyPatchPreview({ patches: [{ path: 'a.ts', edits: [{ old: 'old line', new: 'new line' }] }] })
    expect(pv.reason).toBe('APPLY_PATCH_CHANGES')
    expect(pv.fields.map((f) => f.key)).toEqual(['apply_patch_count', 'apply_patch_stats', 'apply_patch_diff'])
    expect(pv.fields[1]!.value).toContain('a.ts')
    expect(pv.fields[2]!.value).toContain('old line')
  })

  it('参数坏 → APPLY_PATCH_BAD_ARGS；校验失败 → APPLY_PATCH_INVALID 且列错误', () => {
    expect(buildApplyPatchPreview({}).reason).toBe('APPLY_PATCH_BAD_ARGS')
    put('a.ts', 'hello')
    const pv = buildApplyPatchPreview({ patches: [{ path: 'a.ts', edits: [{ old: 'nope', new: 'x' }] }] })
    expect(pv.reason).toBe('APPLY_PATCH_INVALID')
    expect(pv.fields.some((f) => f.key === 'apply_patch_error')).toBe(true)
  })
})
