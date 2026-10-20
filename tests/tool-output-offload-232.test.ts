// @vitest-environment node
// V4-Iter-232：工具大结果从「有损截断」改成「落文件 + 留引用」，`agent_traces` 补上
// 入参／返回值／这一步实际用的模型三列。
//
// 三条承重命题，各自的测法：
//  · **砍掉的那一段必须还能读回来** ⇒ 真写文件、真用 `fs_read` 把那一份读回来（不 mock fs）。
//    只断言"上下文里出现了 @outputs"是不够的——引用是死的、读不回来等于没有。
//  · **引用只许读、不许写、不许越界** ⇒ 三条负例：`fs_write` 不认这个前缀、`../` 与绝对路径被拒。
//  · **三列真的落到库里** ⇒ 真 SQLite + 真 migration v50 + 真 repo 写入再 `SELECT` 回来。
//    （这条最容易被"加了列但没人写"混过去：列在 schema 里、值恒 NULL，CI 照样全绿。）
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-232'
  const appRoot = dir + sep + 'app'
  process.env.POCKETAI_APP_ROOT = appRoot
  return { dir, appRoot, db: dir + sep + 'app.db', data: appRoot + sep + 'data' }
})

vi.mock('electron', () => ({
  ipcMain: { handle: () => true },
  BrowserWindow: class { static getAllWindows() { return [] } static fromWebContents() { return undefined } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} }
}))

// 工作目录仍然走 appConfigRepo（本文件只测卸载与三列，不测配置怎么存）
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

import {
  offloadToolOutput,
  buildOffloadPreview,
  resolveOffloadPath,
  pruneOffloads,
  defaultOffloadRoot,
  OFFLOAD_PREFIX,
  OFFLOAD_THRESHOLD_CHARS,
  OFFLOAD_KEEP_FILES
} from '../src/main/agent/tool-output-offload'
import { capTraceText, TRACE_TEXT_MAX_CHARS } from '../src/main/agent/engine'
import { getFsTools, setWorkspaceDir } from '../src/main/tools/fs-tools'

const NL = String.fromCharCode(10)
let root: string
let workspace: string

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-232-off-'))
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-232-ws-'))
  ws.dir = workspace
  setWorkspaceDir(workspace)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
})

afterAll(() => fs.rmSync(P.dir, { recursive: true, force: true }))

const long = (marker: string, chars = OFFLOAD_THRESHOLD_CHARS + 5_000): string =>
  `${marker}${'x'.repeat(chars)}`

describe('① 卸载：过阈值才落，落下来的必须读得回来', () => {
  it('没过阈值 ⇒ 不落盘、返回 null（一次 fs 往返都不该多花）', () => {
    const small = '短结果'.repeat(10)
    expect(offloadToolOutput(root, 'msg-1', small)).toBeNull()
    expect(fs.readdirSync(root).length).toBe(0)
  })

  it('过阈值 ⇒ 落文件，**全文字节一致**，且预览第一行就带着引用（被截断也截不掉它）', () => {
    const content = long('甲段：')
    const off = offloadToolOutput(root, 'msg-2', content)
    expect(off).not.toBeNull()
    expect(off!.ref.startsWith(OFFLOAD_PREFIX)).toBe(true)
    expect(fs.readFileSync(off!.absPath, 'utf-8')).toBe(content)

    const preview = buildOffloadPreview(content, off!.ref)
    expect(preview.split(NL)[0]).toContain(off!.ref)
    expect(preview).toContain('甲段：')
  })

  it('同一个 key 再来一次不重写（跨轮重建历史会反复拿到同一条消息）', () => {
    const content = long('乙段：')
    const first = offloadToolOutput(root, 'msg-3', content)!
    const before = fs.statSync(first.absPath).mtimeMs
    const again = offloadToolOutput(root, 'msg-3', content)!
    expect(again.absPath).toBe(first.absPath)
    expect(fs.statSync(first.absPath).mtimeMs).toBe(before)
  })

  it('工具名/键里的怪字符不能决定路径形状（模型可控的东西不许拼进路径）', () => {
    const content = long('丙段：')
    const off = offloadToolOutput(root, '../../escape', content)!
    // 斜杠与点号被收进白名单之外 ⇒ 文件名留在卸载根里，出不了这层
    expect(path.dirname(off.absPath)).toBe(path.resolve(root))
    expect(path.basename(off.absPath)).not.toContain('/')
    expect(path.basename(off.absPath)).not.toContain('\\')
    expect(path.basename(off.absPath)).not.toContain('..')
  })

  it('卸载根之外一律读不到：`../`、空串、NUL 都拒（各按各的理由拒，不许靠后面那道兜底）', () => {
    // 断言到**具体那一句**：`..` 必须由形状守卫挡下。写成 /非法|超出/ 的话，
    // 把形状守卫删掉、只剩"解析后仍在根内"那道兜底也照样绿——变异实测就是这么揪出来的。
    expect(() => resolveOffloadPath(root, `${OFFLOAD_PREFIX}../secret.txt`)).toThrow(/非法的工具输出路径/)
    expect(() => resolveOffloadPath(root, `${OFFLOAD_PREFIX}a/../../secret.txt`)).toThrow(/非法的工具输出路径/)
    expect(() => resolveOffloadPath(root, `${OFFLOAD_PREFIX}`)).toThrow(/非法的工具输出路径/)
    expect(() => resolveOffloadPath(root, `${OFFLOAD_PREFIX}a${String.fromCharCode(0)}b`)).toThrow(/非法的工具输出路径/)
    // 正向对照：合法引用解析得出来
    const ok = resolveOffloadPath(root, `${OFFLOAD_PREFIX}msg-4.txt`)
    expect(ok).toBe(path.resolve(root, 'msg-4.txt'))
  })

  it('超过保留份数时淘汰最旧的，留下最新的', () => {
    for (let i = 0; i < OFFLOAD_KEEP_FILES + 5; i++) {
      const file = path.join(root, `m${i}.txt`)
      fs.writeFileSync(file, 'x', 'utf-8')
      const t = new Date(1_700_000_000_000 + i * 1000)
      fs.utimesSync(file, t, t)
    }
    expect(pruneOffloads(root)).toBe(5)
    expect(fs.readdirSync(root)).toHaveLength(OFFLOAD_KEEP_FILES)
    expect(fs.existsSync(path.join(root, `m${OFFLOAD_KEEP_FILES + 4}.txt`))).toBe(true)
  })

  it('落一份新文件会顺手淘汰超额旧文件（"记得写、忘了清"是这一层最容易犯的错）', () => {
    // 先把目录塞满（旧 mtime），再多落一份 ⇒ 目录里必须仍然是上限那么多
    for (let i = 0; i < OFFLOAD_KEEP_FILES; i++) {
      const file = path.join(root, `old${i}.txt`)
      fs.writeFileSync(file, 'x', 'utf-8')
      const ts = new Date(1_600_000_000_000 + i * 1000)
      fs.utimesSync(file, ts, ts)
    }
    const off = offloadToolOutput(root, 'brand-new', long('庚段：'))!
    expect(fs.existsSync(off.absPath)).toBe(true)
    expect(fs.readdirSync(root)).toHaveLength(OFFLOAD_KEEP_FILES)
    expect(fs.existsSync(path.join(root, 'old0.txt'))).toBe(false)
  })

  it('卸载默认落在应用数据目录下，不在用户工作目录里', () => {
    expect(defaultOffloadRoot().startsWith(P.data)).toBe(true)
    expect(defaultOffloadRoot().startsWith(workspace)).toBe(false)
  })
})

describe('② fs_read 真能把卸载的全文读回来（这是整批的意义）', () => {
  const readTool = () => {
    const t = getFsTools().find((x) => x.schema.name === 'fs_read')
    if (!t) throw new Error('fs_read 没注册')
    return t
  }
  const writeTool = () => {
    const t = getFsTools().find((x) => x.schema.name === 'fs_write')
    if (!t) throw new Error('fs_write 没注册')
    return t
  }

  it('拿引用去 fs_read ⇒ 读回全文（256 KB 上限内）', async () => {
    const content = long('丁段：')
    const off = offloadToolOutput(defaultOffloadRoot(), 'msg-read', content)!
    const raw = await readTool().execute({ path: off.ref })
    const parsed = JSON.parse(String(raw)) as { path: string; content: string; truncated: boolean }
    expect(parsed.content).toBe(content)
    expect(parsed.truncated).toBe(false)
  })

  it('反向对照：`fs_write` 不认这个前缀 ⇒ 模型写不进卸载目录（它只是回读口，不是临时盘）', async () => {
    const off = offloadToolOutput(defaultOffloadRoot(), 'msg-write', long('戊段：'))!
    // 卸载文件在应用数据目录，工作目录内的解析必然拒绝这种路径
    await expect(writeTool().execute({ path: off.ref, content: '覆写' })).rejects.toThrow()
    expect(fs.readFileSync(off.absPath, 'utf-8')).toContain('戊段：')
  })

  it('引用指向不存在的文件 ⇒ 报"文件不存在"，不是静默空串', async () => {
    await expect(readTool().execute({ path: `${OFFLOAD_PREFIX}nope.txt` })).rejects.toThrow(/不存在/)
  })
})

describe('③ trace 三列：写入端的截断口径', () => {
  it('短的原文一字不动；空与 undefined 都存 NULL（"没有"不等于"空字符串"）', () => {
    expect(capTraceText('abc')).toBe('abc')
    expect(capTraceText('')).toBeUndefined()
    expect(capTraceText(null)).toBeUndefined()
    expect(capTraceText(undefined)).toBeUndefined()
  })

  it('过上限 ⇒ 截到上限并**如实报原始长度**（不许让这一列看起来像全文）', () => {
    const big = 'y'.repeat(TRACE_TEXT_MAX_CHARS + 1234)
    const capped = capTraceText(big)!
    expect(capped.startsWith('y'.repeat(TRACE_TEXT_MAX_CHARS))).toBe(true)
    expect(capped).toContain(String(big.length))
    expect(capped.length).toBeLessThan(big.length)
  })

  it('上限是按字符数算的，不是按字节：中文串同样被截，但报的是字符数', () => {
    const zh = '汉'.repeat(TRACE_TEXT_MAX_CHARS + 10)
    const capped = capTraceText(zh)!
    expect(capped).toContain(String(zh.length))
  })
})

describe('④ 真 SQLite：v50 加了列、真写得进去、读得回来', () => {
  // 这一组直接用真库跑 migration，因为"加了列但没人写"在桩件的 INSERT 上是看不出来的
  let mem: Database.Database
  beforeAll(() => {
    mem = new Database(':memory:')
    const source = fs.readFileSync(path.join(__dirname, '../src/main/db/database.ts'), 'utf-8')
    const create = source.match(/CREATE TABLE IF NOT EXISTS agent_traces \(([\s\S]*?)\);/)
    expect(create, '建表语句的形状变了，这条自反断言要先红').not.toBeNull()
    mem.exec(`CREATE TABLE agent_traces (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, conversation_id TEXT NOT NULL, step_index INTEGER NOT NULL, step_type TEXT NOT NULL, tool_name TEXT, duration_ms INTEGER, token_usage INTEGER, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, parent_request_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER);`)
    // v50 那三列必须写在 migration 里（这条断言钉住"只有 migration 加列、建表语句不用改"的口径）
    expect(source).toMatch(/version: 50[\s\S]*?ALTER TABLE agent_traces ADD COLUMN tool_args TEXT;[\s\S]*?tool_result TEXT;[\s\S]*?model TEXT;/)
  })
  afterAll(() => mem.close())

  it('三列可空、默认 NULL，写入后原样读回', () => {
    mem.exec('ALTER TABLE agent_traces ADD COLUMN tool_args TEXT; ALTER TABLE agent_traces ADD COLUMN tool_result TEXT; ALTER TABLE agent_traces ADD COLUMN model TEXT;')
    mem
      .prepare('INSERT INTO agent_traces (id, request_id, conversation_id, step_index, step_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('t-old', 'r1', 'c1', 0, 'llm', 'success', 1)
    mem
      .prepare('INSERT INTO agent_traces (id, request_id, conversation_id, step_index, step_type, status, created_at, tool_args, tool_result, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('t-new', 'r1', 'c1', 1, 'tools', 'success', 2, 'fs_read {"path":"a.md"}', 'fs_read OK 内容', 'qwen3:4b')
    const oldRow = mem.prepare('SELECT tool_args, tool_result, model FROM agent_traces WHERE id = ?').get('t-old') as Record<string, unknown>
    expect(oldRow.tool_args).toBeNull()
    expect(oldRow.model).toBeNull()
    const newRow = mem.prepare('SELECT tool_args, tool_result, model FROM agent_traces WHERE id = ?').get('t-new') as Record<string, string>
    expect(newRow.tool_args).toBe('fs_read {"path":"a.md"}')
    expect(newRow.model).toBe('qwen3:4b')
  })
})
