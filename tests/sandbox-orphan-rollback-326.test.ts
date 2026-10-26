// @vitest-environment node
// V4-Iter-326① 沙箱产物那两条「磁盘 ↔ 库」的不对称，加上「名称可留空」那道双门。
//
// 为什么这一份走服务层：D／E 的缺陷本体是"另一侧的写没兜住"，只有把 insert／rmSync 换成会抛的桩
// 才演得出来（渲染层的桩造不出 SQLITE_BUSY）。判据一律落在**看得见的副作用**上：
// 写过的那份文件在不在（rmSync 的调用序列）、留没留痕、错误原文有没有被顶掉。
//
// 真的：sandbox-service 本体（含路径守卫、清洗、上限）。假的：fs、DB 仓储、logger、portable。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  insertThrows: false,
  rmThrows: false,
  written: [] as string[],
  removed: [] as string[],
  warns: [] as string[],
  deletes: 0,
  rowPresent: true,
  reset(): void {
    this.insertThrows = false
    this.rmThrows = false
    this.written = []
    this.removed = []
    this.warns = []
    this.deletes = 0
    this.rowPresent = true
  }
}))

const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/'
  return base + sep + 'pocketai-326-mock'
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: TMP }))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => H.warns.push(a.map(String).join(' ')),
    error: () => {}
  })
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const over = {
    mkdirSync: (): void => {},
    writeFileSync: (p: unknown): void => {
      H.written.push(String(p))
    },
    rmSync: (p: unknown): void => {
      if (H.rmThrows) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      H.removed.push(String(p))
    },
    existsSync: (): boolean => true,
    readFileSync: (): string => '<html>ok</html>'
  }
  return { ...actual, ...over, default: { ...actual, ...over } }
})

vi.mock('../src/main/db/repositories/sandbox.repo', () => ({
  sandboxRepo: {
    list: () => [],
    get: (id: string) =>
      H.rowPresent
        ? {
            id,
            name: '旧名',
            size: 8,
            createdAt: 1,
            icon: '📦',
            description: '',
            isApp: false,
            // 这是 repo 层**输出**的形状（`fileName` 已由仓储从 file_name 映射过来）
            fileName: `${id}.html`
          }
        : null,
    insert: (): void => {
      if (H.insertThrows) throw new Error('SQLITE_BUSY: database is locked')
    },
    updateMeta: (): void => {},
    delete: (): void => {
      H.deletes++
    }
  }
}))

import { createSandboxFile, deleteSandboxFile } from '../src/main/sandbox/sandbox-service'

beforeEach(() => {
  H.reset()
})

describe('§326② 「名称（可留空）」那句：改前两道 min(1) 都挡死', () => {
  it('留空创建 ⇒ 不抛，落库名是 cleanName 的默认名「未命名」', () => {
    const meta = createSandboxFile('', '<!doctype html><p>hi</p>')
    expect(meta.name).toBe('未命名')
    expect(H.written).toHaveLength(1)
  })

  it('反向对照：给名字 ⇒ 原样用（放宽下限不该把正常名字也吞了）', () => {
    expect(createSandboxFile('我的页', '<p>x</p>').name).toBe('我的页')
  })
})

describe('§326③ 先落盘、后入库那一发（改前入库一抛就留孤儿）', () => {
  it('入库失败 ⇒ 刚落盘的那份被删掉，且原始错误照旧抛出（不顶成"清理失败"）', () => {
    H.insertThrows = true
    expect(() => createSandboxFile('页', '<p>x</p>')).toThrow('SQLITE_BUSY')
    expect(H.written).toHaveLength(1)
    expect(H.removed, '删的必须就是刚写过的那一份').toEqual(H.written)
  })

  it('反向对照：入库成功 ⇒ 一份都不许多删', () => {
    createSandboxFile('页', '<p>x</p>')
    expect(H.written).toHaveLength(1)
    expect(H.removed).toEqual([])
  })

  it('入库失败、回滚也没做成 ⇒ 错误原文不许被顶掉，但必须留痕（那份文件从此没人能删它）', () => {
    H.insertThrows = true
    H.rmThrows = true
    expect(() => createSandboxFile('页', '<p>x</p>')).toThrow('SQLITE_BUSY')
    expect(H.warns, '留痕那一句要点明留下了没人认领的产物').toHaveLength(1)
    expect(H.warns[0]!).toContain('没人认领')
  })
})

describe('§326④ 库删先、盘删后那一发（改前 catch 无声）', () => {
  it('磁盘那份删不掉 ⇒ 这次删除仍算成功（不抛回调用方），但要点名留下的是哪一份', () => {
    H.rmThrows = true
    expect(() => deleteSandboxFile('r1')).not.toThrow()
    expect(H.deletes).toBe(1)
    expect(H.warns).toHaveLength(1)
    expect(H.warns[0]!).toContain('没人认领的产物')
  })

  it('反向对照：删得掉 ⇒ 删的就是那条记录指的那一份，且不许凭空留一条痕', () => {
    deleteSandboxFile('r1')
    expect(H.removed).toHaveLength(1)
    expect(H.removed[0]!.replace(/\\/g, '/')).toBe(`${TMP.replace(/\\/g, '/')}/sandbox/r1.html`)
    expect(H.warns).toEqual([])
  })
})
