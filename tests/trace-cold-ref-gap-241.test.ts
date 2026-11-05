// @vitest-environment node
// v54：消掉 4,001–20,000 字符的空档（P0-5 冷 blob 第一批）
//
// 现状曾是：trace 在 4000 字符截断，卸载文件只在 >20000 才落，
// 中间这一段"trace 里没有全文、也没有文件"。这一批的验收就是：
// **任何会被 trace 截断的内容，都有一条可取的全文路径**（落文件门槛与截断上限对齐），
// 同时不把 4,001–20,000 这一段的上下文形状一起改掉（预览门槛仍 20,000）。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-v54-gap'
  const appRoot = dir + sep + 'app'
  process.env.POCKETAI_APP_ROOT = appRoot
  return { dir, appRoot, data: appRoot + sep + 'data' }
})

vi.mock('electron', () => ({
  ipcMain: { handle: () => true },
  BrowserWindow: class { static getAllWindows() { return [] } static fromWebContents() { return undefined } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} }
}))

const ws = { dir: '' }
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => (key === 'agent.workspace_dir' && ws.dir ? ws.dir : undefined),
    set: (key: string, value: string) => {
      if (key === 'agent.workspace_dir') ws.dir = value
    },
    delete: (key: string) => {
      if (key === 'agent.workspace_dir') ws.dir = ''
    }
  }
}))

import { contextToolResultWithRef, TRACE_TEXT_MAX_CHARS } from '../src/main/agent/engine'
import {
  offloadToolOutput,
  writeOffloadFile,
  defaultOffloadRoot,
  OFFLOAD_MIN_CHARS,
  OFFLOAD_PREVIEW_MIN_CHARS,
  OFFLOAD_PREFIX
} from '../src/main/agent/tool-output-offload'

let root: string

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-v54-gap-off-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

afterAll(() => fs.rmSync(P.dir, { recursive: true, force: true }))

const text = (n: number, marker = '甲'): string => `${marker}${'x'.repeat(Math.max(0, n - marker.length))}`

describe('落文件门槛与 trace 截断上限对齐', () => {
  it('常数口径：落文件门槛 = trace 截断上限（4000），预览门槛仍是 20000', () => {
    expect(OFFLOAD_MIN_CHARS).toBe(TRACE_TEXT_MAX_CHARS)
    expect(OFFLOAD_PREVIEW_MIN_CHARS).toBeGreaterThan(OFFLOAD_MIN_CHARS)
  })

  it('恰好 4000 字符 ⇒ 不落（trace 存得下全文，不必多一个文件）', () => {
    expect(offloadToolOutput(root, 'm-4000', text(4000))).toBeNull()
    expect(fs.readdirSync(root)).toHaveLength(0)
  })

  it('4,001 字符 ⇒ 落文件，返回可解析的引用（空档的第一格）', () => {
    const off = offloadToolOutput(root, 'm-4001', text(4001))
    expect(off).not.toBeNull()
    expect(off!.ref.startsWith(OFFLOAD_PREFIX)).toBe(true)
    expect(fs.readFileSync(off!.absPath, 'utf-8')).toBe(text(4001))
  })

  it('5,000 字符（原空档正中）⇒ contextToolResultWithRef 给出全文路径，上下文仍是原文而非预览', () => {
    const content = text(5000, '乙')
    const { text: ctxText, coldRef } = contextToolResultWithRef('m-5000', content)
    expect(coldRef).not.toBeNull()
    expect(coldRef!.startsWith(OFFLOAD_PREFIX)).toBe(true)
    const abs = path.join(defaultOffloadRoot(), path.basename(coldRef!))
    expect(fs.existsSync(abs)).toBe(true)
    expect(fs.readFileSync(abs, 'utf-8')).toBe(content)
    // 预览门槛未变：这一档不出现 "全文在 @outputs/..." 的替换文案
    expect(ctxText).not.toContain(OFFLOAD_PREFIX)
  })

  it('20,001 字符 ⇒ 上下文改放预览 + 引用（与旧行为一致）', () => {
    const content = text(20_001, '丙')
    const { text: ctxText, coldRef } = contextToolResultWithRef('m-20001', content)
    expect(coldRef).not.toBeNull()
    expect(ctxText).toContain(OFFLOAD_PREFIX)
  })

  it('同一 key 再落一次：长度一致就不重写（跨轮重建历史不重复写盘）', () => {
    const content = text(5000, '丁')
    const first = offloadToolOutput(root, 'm-idem', content)!
    const before = fs.statSync(first.absPath).mtimeMs
    const again = offloadToolOutput(root, 'm-idem', content)!
    expect(again.absPath).toBe(first.absPath)
    expect(fs.statSync(first.absPath).mtimeMs).toBe(before)
  })

  it('默认卸载根仍是应用数据目录（没因本批改动换位置）', () => {
    expect(defaultOffloadRoot().startsWith(P.data)).toBe(true)
  })

  it('writeOffloadFile 无条件落盘：整步聚合被截断时，给没过单调用门槛的段也补一条全文路径', () => {
    const small = text(300, '戊')
    expect(offloadToolOutput(root, 'm-small', small)).toBeNull()
    const forced = writeOffloadFile(root, 'm-small', small)
    expect(forced).not.toBeNull()
    expect(fs.readFileSync(forced!.absPath, 'utf-8')).toBe(small)
  })
})
