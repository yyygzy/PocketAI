// @vitest-environment node
// P0-5 第二批：布局 / 淘汰 / 原子写 / 失败计数（不碰 DB）
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-v54-cold-layout'
  return { dir, data: dir + sep + 'data' }
})

vi.mock('electron', () => ({
  ipcMain: { handle: () => true },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => '/', quit: () => {} }
}))
vi.mock('../src/main/portable', () => ({ DATA_DIR: P.data }))

import {
  writeOffloadFile,
  offloadToolOutput,
  resolveOffloadPath,
  pruneOffloads,
  conversationOffloadDir,
  defaultOffloadRoot,
  getOffloadPruneFailureCount,
  setProtectedColdRefsProvider,
  resetProtectedColdRefsProvider,
  OFFLOAD_PREFIX
} from '../src/main/agent/tool-output-offload'
import { purgeConversationColdData, getColdDataFailureStats } from '../src/main/agent/cold-data'

let root: string

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-cold-'))
})

afterEach(() => {
  resetProtectedColdRefsProvider()
  fs.rmSync(root, { recursive: true, force: true })
})

afterAll(() => fs.rmSync(P.dir, { recursive: true, force: true }))

const text = (n: number): string => 'x'.repeat(n)

describe('布局：会话目录 + 旧平铺双兼容', () => {
  it('新写入落到 <root>/<conversationId>/，引用带会话段', () => {
    const off = writeOffloadFile(root, 'm-1', text(5000), 'conv-1')!
    expect(off.ref).toBe(`${OFFLOAD_PREFIX}conv-1/m-1.txt`)
    expect(off.absPath).toBe(path.join(root, 'conv-1', 'm-1.txt'))
    expect(fs.existsSync(off.absPath)).toBe(true)
    expect(resolveOffloadPath(root, off.ref)).toBe(off.absPath)
  })

  it('旧平铺引用 @outputs/<messageId>.txt 仍解析到原位置（库里已有的 cold_ref 不失联）', () => {
    const legacy = path.join(root, 'm-old.txt')
    fs.writeFileSync(legacy, 'old')
    expect(resolveOffloadPath(root, `${OFFLOAD_PREFIX}m-old.txt`)).toBe(legacy)
  })

  it('会话 id 与消息 id 都走同一白名单（出不了目录）', () => {
    const dir = conversationOffloadDir(root, '../../etc')
    expect(dir.startsWith(root + path.sep)).toBe(true)
    expect(path.basename(dir)).not.toContain('/')
    expect(path.basename(dir)).not.toContain('..')
    expect(() => resolveOffloadPath(root, `${OFFLOAD_PREFIX}../x`)).toThrow()
  })
})

describe('原子写', () => {
  it('写完不留 .part，且解析路径只认 .txt（半写临时文件不会被当成全文）', () => {
    const off = writeOffloadFile(root, 'm-atomic', text(5000), 'conv-a')!
    const dir = path.dirname(off.absPath)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.part'))).toHaveLength(0)
    // 手工制造半写文件：同目录下的 .part 不是可解析目标
    fs.writeFileSync(path.join(dir, 'm-half.txt.abc.part'), '半截')
    expect(fs.existsSync(resolveOffloadPath(root, `${OFFLOAD_PREFIX}conv-a/m-half.txt`))).toBe(false)
  })

  it('一小时前的 .part 会被 prune 清走', () => {
    const dir = path.join(root, 'conv-b')
    fs.mkdirSync(dir, { recursive: true })
    const part = path.join(dir, 'm-stale.txt.x.part')
    fs.writeFileSync(part, '半截')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(part, old, old)
    pruneOffloads(root)
    expect(fs.existsSync(part)).toBe(false)
  })
})

describe('上限：时间 30 天 + 字节 512 MB（目录级淘汰）', () => {
  function makeDir(conv: string, bytes: number, ageMs: number): string {
    const dir = path.join(root, conv)
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `${conv}.txt`)
    fs.writeFileSync(f, 'x'.repeat(bytes))
    const t = new Date(Date.now() - ageMs)
    fs.utimesSync(f, t, t)
    return dir
  }

  it('时间到期整目录删；连跑两次幂等（第二次 0）', () => {
    const d1 = makeDir('old-1', 10, 40 * 24 * 3600 * 1000)
    const d2 = makeDir('old-2', 10, 31 * 24 * 3600 * 1000)
    const fresh = makeDir('fresh', 10, 0)
    expect(pruneOffloads(root)).toBe(2)
    expect(fs.existsSync(d1)).toBe(false)
    expect(fs.existsSync(d2)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(pruneOffloads(root)).toBe(0)
  })

  it('活跃引用保护：仍被 trace+messages 指向的目录即使过期也不删', () => {
    const d = makeDir('protected', 10, 40 * 24 * 3600 * 1000)
    const ref = `${OFFLOAD_PREFIX}protected/protected.txt`
    expect(pruneOffloads(root, { protectedRefs: [ref] })).toBe(0)
    expect(fs.existsSync(d)).toBe(true)
    // 反向对照：拿掉引用后同一目录立即按时间淘汰，证明不是恒真保护
    expect(pruneOffloads(root)).toBe(1)
    expect(fs.existsSync(d)).toBe(false)
  })

  it('活跃引用提供者会被写入后的 prune 自动调用', () => {
    const d = makeDir('provider-protected', 10, 40 * 24 * 3600 * 1000)
    setProtectedColdRefsProvider(() => [`${OFFLOAD_PREFIX}provider-protected/provider-protected.txt`])
    writeOffloadFile(root, 'trigger', text(5000), 'trigger-conv')
    expect(fs.existsSync(d)).toBe(true)
  })

  it('活跃引用保护旧平铺文件的份数淘汰；去掉引用后仍按 LRU 淘汰', () => {
    const old = path.join(root, 'l-old.txt')
    const fresh = path.join(root, 'l-fresh.txt')
    fs.writeFileSync(old, 'x'.repeat(10))
    fs.writeFileSync(fresh, 'x'.repeat(10))
    const oldTime = new Date(Date.now() - 60 * 1000)
    const freshTime = new Date(Date.now())
    fs.utimesSync(old, oldTime, oldTime)
    fs.utimesSync(fresh, freshTime, freshTime)

    expect(pruneOffloads(root, { keep: 1, protectedRefs: [`${OFFLOAD_PREFIX}l-old.txt`] })).toBe(0)
    expect(fs.existsSync(old)).toBe(true)
    expect(fs.existsSync(fresh)).toBe(true)

    expect(pruneOffloads(root, { keep: 1 })).toBe(1)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('非法 protectedRefs 不会卡住淘汰', () => {
    const d = makeDir('bad-ref', 10, 40 * 24 * 3600 * 1000)
    expect(
      pruneOffloads(root, {
        protectedRefs: [`${OFFLOAD_PREFIX}../escape.txt`, 'not-outputs.txt']
      })
    ).toBe(1)
    expect(fs.existsSync(d)).toBe(false)
  })

  it('字节淘汰同样跳过被引用目录', () => {
    const older = makeDir('older', 10, 60 * 1000)
    const newer = makeDir('newer', 8, 0)
    expect(
      pruneOffloads(root, {
        maxBytes: 15,
        protectedRefs: [`${OFFLOAD_PREFIX}older/older.txt`]
      })
    ).toBe(0)
    expect(fs.existsSync(older)).toBe(true)
    expect(fs.existsSync(newer)).toBe(true)
  })

  it('字节超限按目录 LRU 整目录淘汰，直到达标；再次调用不再删', () => {
    const older = makeDir('older', 10, 60 * 1000)
    const newer = makeDir('newer', 8, 0)
    expect(pruneOffloads(root, { maxBytes: 15 })).toBe(1)
    expect(fs.existsSync(older)).toBe(false)
    expect(fs.existsSync(newer)).toBe(true)
    expect(pruneOffloads(root, { maxBytes: 15 })).toBe(0)
  })

  it('旧平铺文件的 200 份上限保留（不改旧行为）', () => {
    for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(root, `l-${i}.txt`), 'x')
    expect(pruneOffloads(root, 200)).toBe(5)
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.txt'))).toHaveLength(200)
  })

  it('删除失败被计数、不吞：目录还在，计数增加', () => {
    const dir = makeDir('locked', 10, 40 * 24 * 3600 * 1000)
    const before = getOffloadPruneFailureCount()
    const removed = pruneOffloads(root, { removeDir: () => { throw new Error('EBUSY') } })
    expect(removed).toBe(0)
    expect(fs.existsSync(dir)).toBe(true)
    expect(getOffloadPruneFailureCount()).toBeGreaterThan(before)
  })
})

describe('删会话级联删目录', () => {
  it('purge 删掉会话目录；失败也计数（第三批数据健康可取）', () => {
    const off = writeOffloadFile(defaultOffloadRoot(), 'm-p', text(5000), 'conv-p')!
    expect(fs.existsSync(path.dirname(off.absPath))).toBe(true)
    expect(purgeConversationColdData(['conv-p'])).toBe(1)
    expect(fs.existsSync(path.dirname(off.absPath))).toBe(false)

    const before = getColdDataFailureStats().purgeFailures
    expect(purgeConversationColdData(['conv-x'], () => { throw new Error('EBUSY') })).toBe(0)
    expect(getColdDataFailureStats().purgeFailures).toBeGreaterThan(before)
  })

  it('没带会话的旧调用于是不写会话段（仅兼容测试/旧调用）', () => {
    expect(offloadToolOutput(root, 'm-legacy', text(5000))!.ref).toBe(`${OFFLOAD_PREFIX}m-legacy.txt`)
  })
})
