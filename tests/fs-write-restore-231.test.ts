// @vitest-environment node
// V4-Iter-231：`fs_write` 从"auto 直接覆盖"改成"审批时看得见改了什么 + 落盘前留一份可还原的快照"。
//
// 这一族的承重命题是"**看得见**与**退得回**"，所以三处都不桩：真 fs、真快照文件、真 app 根目录
// （靠 `POCKETAI_APP_ROOT` 指到临时目录，portable 在 import 时读它）。桩掉盘就等于没测——
// 与 §228 那条"先落库再改内存要用真 SQLite"是同一个理由。
//
// 反向对照放在每条旁边写：只断言"有 diff"是不够的，必须同时钉住"文件不存在时不该出现删除行"、
// "末尾换行这一位不许被行级 diff 吞掉"这两个反例。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// `POCKETAI_APP_ROOT` 必须在 portable 被 import **之前**落到 process.env（portable 在模块顶层读它算 DATA_DIR），
// 所以这一串只能待在 hoisted 里；分隔符按 cwd 现判——`resolveWorkspacePath` 用 `ws + path.sep` 做前缀比对，
// 拿正斜杠拼出来的工作目录会在 Windows 上被判成"路径超出工作目录"。
const tmp = vi.hoisted(() => {
  const sep = process.cwd().includes('\\') ? '\\' : '/'
  const appRoot = process.cwd() + sep + 'data' + sep + 'tmp-231' + sep + 'app'
  const workspace = process.cwd() + sep + 'data' + sep + 'tmp-231' + sep + 'ws'
  process.env.POCKETAI_APP_ROOT = appRoot
  return { appRoot, workspace }
})
fs.mkdirSync(tmp.appRoot, { recursive: true })
fs.mkdirSync(tmp.workspace, { recursive: true })

vi.mock('electron', () => ({
  ipcMain: { handle: () => true },
  BrowserWindow: class { static getAllWindows() { return [] } static fromWebContents() { return undefined } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => {
      throw new Error('本用例不碰库：工作目录走 appConfigRepo 的桩')
    },
    isOpen: () => true,
    open: () => {},
    close: () => {},
    runMigrations: () => {},
    getEncryptionMode: () => 'none'
  }
}))

// 工作目录是 app_config 里一个键，本批次不测它怎么存：桩 repo，保留 fs-tools 的真实解析与守卫
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

import { buildFileDiff, diffToText } from '../src/shared/fs-diff'
import {
  captureSnapshot,
  readSnapshot,
  markConsumed,
  listSnapshotIds,
  prune,
  defaultSnapshotRoot,
  MAX_SNAPSHOT_BYTES
} from '../src/main/agent/file-snapshots'
import { getFsTools, buildFsWritePreview, restoreFileWrite, setWorkspaceDir } from '../src/main/tools/fs-tools'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const DICTS: Record<string, Record<string, string>> = { zh, en, ja, ko }

const writeTool = () => {
  const t = getFsTools().find((x) => x.schema.name === 'fs_write')
  if (!t) throw new Error('fs_write 没注册（工作目录桩没生效？）')
  return t
}

beforeEach(() => {
  ws.dir = tmp.workspace
  setWorkspaceDir(tmp.workspace)
})

afterEach(() => {
  for (const f of fs.readdirSync(tmp.workspace)) fs.rmSync(path.join(tmp.workspace, f), { recursive: true, force: true })
  const root = defaultSnapshotRoot()
  if (fs.existsSync(root)) for (const f of fs.readdirSync(root)) fs.rmSync(path.join(root, f), { force: true })
})

describe('① 行级 diff 是纯函数（不碰 fs）', () => {
  it('改一行：+1 -1，未变行按 ctx 带着（弹窗要能看出"只动了一行"）', () => {
    const d = buildFileDiff('a\nb\nc\n', 'a\nB\nc\n')
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.rows.filter((r) => r.kind === 'ctx').map((r) => r.text)).toEqual(['a', 'c'])
    expect(d.coarse).toBe(false)
    expect(d.truncated).toBe(false)
  })

  it('新建文件（prev=null）：全是新增，一行删除都不许有', () => {
    const d = buildFileDiff(null, 'x\ny\n')
    expect(d.removed).toBe(0)
    expect(d.added).toBe(2)
    expect(d.prevExists).toBe(false)
    expect(diffToText(d.rows)).toBe('+ x\n+ y')
  })

  it('内容一字不差时才算没变：末尾少一个换行必须显式占一行（否则"改了但看起来没改"）', () => {
    const same = buildFileDiff('a\nb', 'a\nb')
    expect(same.rows.filter((r) => r.kind !== 'ctx')).toHaveLength(0)

    const lostNewline = buildFileDiff('a\nb\n', 'a\nb')
    expect(lostNewline.finalNewline).toEqual({ prev: true, next: false })
    // 计数与展示行必须同轴：这一位既进 added/removed，也必须进 rows
    const rowsWithMarker = lostNewline.rows.filter((r) => r.kind === 'del' && r.text.startsWith('\\'))
    expect(rowsWithMarker, '末尾换行的减少要作为一行出现在 diff 里').toHaveLength(1)
    expect(lostNewline.removed).toBe(1)
    expect(lostNewline.added).toBe(0)

    const gainedNewline = buildFileDiff('a\nb', 'a\nb\n')
    expect(gainedNewline.added).toBe(1)
    expect(gainedNewline.removed).toBe(0)
    expect(gainedNewline.rows.filter((r) => r.kind === 'add')).toHaveLength(1)
  })

  it('行数超过算法上限：退回朴素两栏并带 coarse=true（不假装做过行对齐）', () => {
    const prev = Array.from({ length: 500 }, (_, i) => `p${i}`).join('\n')
    const next = Array.from({ length: 400 }, (_, i) => `n${i}`).join('\n')
    const d = buildFileDiff(prev, next)
    expect(d.coarse).toBe(true)
    expect(d.added).toBe(400)
    expect(d.removed).toBe(500)
    // 朴素两栏只展示两侧各前 60 行 ⇒ 展示行数远小于真实规模，靠 coarse 说清
    expect(d.rows.filter((r) => r.kind === 'del')).toHaveLength(60)
  })

  it('展示截断时把总行数带出去（界面要说"显示了 200／517"就靠 totalRows）', () => {
    const prev = Array.from({ length: 100 }, (_, i) => `p${i}`).join('\n')
    const next = Array.from({ length: 100 }, (_, i) => `x${i}`).join('\n')
    const d = buildFileDiff(prev, next, { maxRows: 20 })
    expect(d.rows).toHaveLength(20)
    expect(d.truncated).toBe(true)
    expect(d.totalRows).toBe(200)
    expect(d.added).toBe(100)
    expect(d.removed).toBe(100)
  })
})

describe('② 快照存储：真临时目录、真文件', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-231-snap-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('留一份能读回来，且 relPath 存的是相对路径（换工作目录时绝对路径不作数）', () => {
    const snap = captureSnapshot(root, { relPath: 'notes/a.md', prevExists: true, prevContent: '旧', wroteContent: '新' })
    expect(snap).not.toBeNull()
    const back = readSnapshot(root, snap!.id)
    expect(back?.prevContent).toBe('旧')
    expect(back?.wroteContent).toBe('新')
    expect(back?.consumedAt).toBeNull()
  })

  it('旧内容超过 2 MiB 就不快照：返回 null，调用方必须把"不可还原"带出去', () => {
    const big = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1)
    expect(captureSnapshot(root, { relPath: 'a', prevExists: true, prevContent: big, wroteContent: '新' })).toBeNull()
    // 反向对照：新建（prevExists=false）时哪怕新内容很大也照样留——没有"旧内容"要存
    expect(
      captureSnapshot(root, { relPath: 'a', prevExists: false, prevContent: '', wroteContent: big })
    ).not.toBeNull()
  })

  it('用过即废：markConsumed 之后 consumedAt 落盘', () => {
    const snap = captureSnapshot(root, { relPath: 'a', prevExists: true, prevContent: '旧', wroteContent: '新' })!
    markConsumed(root, snap.id)
    expect(readSnapshot(root, snap.id)?.consumedAt).toBeTypeOf('number')
  })

  it('份数超过上限时淘汰最旧的，保留最新的 100 份', () => {
    for (let i = 0; i < 103; i++) {
      captureSnapshot(root, { relPath: `f${i}`, prevExists: true, prevContent: 'p', wroteContent: 'w' })
      // 让 mtime 有先后（同毫秒时排序不稳定，淘汰的就是"任意一份"）
      const newest = listSnapshotIds(root)[0]!
      fs.utimesSync(path.join(root, `${newest}.json`), new Date(), new Date(1_700_000_000_000 + i * 1000))
    }
    expect(listSnapshotIds(root)).toHaveLength(100)
    expect(prune(root)).toBe(0)
  })

  it('id 形状守卫：拿用户输入当 id 不能越出快照目录', () => {
    expect(() => readSnapshot(root, '../../escape')).toThrow(/SNAPSHOT_ID_INVALID/)
    expect(() => readSnapshot(root, 'x'.repeat(40))).toThrow(/SNAPSHOT_ID_INVALID/)
  })
})

describe('③ 真 fs_write：写之前留快照，还原回到写入前', () => {
  it('覆盖已有文件后能还原回旧内容（同一台机器、真字节比对）', async () => {
    const file = path.join(tmp.workspace, 'a.md')
    fs.writeFileSync(file, '第一版\n', 'utf-8')
    const raw = await writeTool().execute({ path: 'a.md', content: '第二版\n' })
    expect(fs.readFileSync(file, 'utf-8')).toBe('第二版\n')
    const res = JSON.parse(String(raw)) as { snapshotId: string; created: boolean; notRestorable?: string }
    expect(res.created).toBe(false)
    expect(res.notRestorable).toBeUndefined()

    const back = restoreFileWrite(res.snapshotId)
    expect(back).toEqual({ path: 'a.md', bytes: Buffer.byteLength('第一版\n', 'utf-8'), removed: false })
    expect(fs.readFileSync(file, 'utf-8')).toBe('第一版\n')
  })

  it('还原只许一次：再点一次直接拒（否则内容会在两版之间来回跳）', async () => {
    fs.writeFileSync(path.join(tmp.workspace, 'b.md'), '旧\n', 'utf-8')
    const res = JSON.parse(String(await writeTool().execute({ path: 'b.md', content: '新\n' }))) as { snapshotId: string }
    restoreFileWrite(res.snapshotId)
    expect(() => restoreFileWrite(res.snapshotId)).toThrow(/SNAPSHOT_CONSUMED/)
  })

  it('我们写完别人又改过 ⇒ 拒还原（吞掉后来的改动比不还原更糟）', async () => {
    const file = path.join(tmp.workspace, 'c.md')
    fs.writeFileSync(file, '旧\n', 'utf-8')
    const res = JSON.parse(String(await writeTool().execute({ path: 'c.md', content: '新\n' }))) as { snapshotId: string }
    fs.writeFileSync(file, '第三方改的\n', 'utf-8')
    expect(() => restoreFileWrite(res.snapshotId)).toThrow(/SNAPSHOT_DIVERGED/)
    expect(fs.readFileSync(file, 'utf-8')).toBe('第三方改的\n')
  })

  it('新建文件那一笔的还原=删掉它（不是写一个空文件）', async () => {
    const file = path.join(tmp.workspace, 'new.md')
    const res = JSON.parse(String(await writeTool().execute({ path: 'new.md', content: '内容\n' }))) as {
      snapshotId: string
      created: boolean
    }
    expect(res.created).toBe(true)
    const back = restoreFileWrite(res.snapshotId)
    expect(back.removed).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('快照落在应用数据目录下，不在用户工作目录里（不许往用户的树里塞东西）', async () => {
    await writeTool().execute({ path: 'd.md', content: 'x\n' })
    const root = defaultSnapshotRoot()
    expect(root.startsWith(tmp.appRoot)).toBe(true)
    expect(root.startsWith(tmp.workspace)).toBe(false)
    expect(fs.existsSync(root), '没落快照就等于没有还原入口').toBe(true)
    expect(listSnapshotIds(root).length).toBeGreaterThan(0)
  })

  it('旧文件是二进制 ⇒ 不留快照，但结果里如实标 notRestorable', async () => {
    const file = path.join(tmp.workspace, 'e.bin')
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02]))
    const res = JSON.parse(String(await writeTool().execute({ path: 'e.bin', content: 'x\n' }))) as {
      snapshotId: string | null
      notRestorable?: string
    }
    expect(res.snapshotId).toBeNull()
    expect(res.notRestorable).toBe('PREV_NOT_TEXT')
    // 写入本身照常成功（这是产品口径：不因为"退不回"就不让写）
    expect(fs.readFileSync(file, 'utf-8')).toBe('x\n')
  })

  it('档位升成 confirm（这条是整批的前提：不升档就没有审批弹窗，也就没有 diff 可看）', () => {
    expect(writeTool().schema.permission).toBe('confirm')
  })
})

describe('④ 审批预览的四档判定与字典对账', () => {
  it('新建 / 覆盖 / 路径在外 / 原文件不可读，各自给出可判的 reason 与字段', () => {
    const created = buildFsWritePreview('n.md', '新内容\n')
    expect(created.reason).toBe('FS_WRITE_NEW')
    expect(created.fields.map((f) => f.key)).toEqual(['fs_write_path', 'fs_write_abs', 'fs_write_stats', 'fs_write_diff'])

    fs.writeFileSync(path.join(tmp.workspace, 'o.md'), '旧一版\n旧二版\n', 'utf-8')
    const over = buildFsWritePreview('o.md', '旧一版\n新二版\n')
    expect(over.reason).toBe('FS_WRITE_OVERWRITE')
    const diffField = over.fields.find((f) => f.key === 'fs_write_diff')!
    expect(diffField.value).toContain('- 旧二版')
    expect(diffField.value).toContain('+ 新二版')
    expect(over.fields.find((f) => f.key === 'fs_write_stats')!.value).toBe('+1 -1')

    const outside = buildFsWritePreview('../escape.txt', 'x')
    expect(outside.reason).toBe('FS_WRITE_PATH_OUTSIDE')
    expect(outside.abs).toBeNull()
    expect(outside.fields.map((f) => f.key)).toEqual(['fs_write_path'])

    // 二进制：没有逐行 diff 可给，就不给 diff 字段（宁可少一格，不假装比过）
    fs.writeFileSync(path.join(tmp.workspace, 'u.bin'), Buffer.from([0x00, 0x02]))
    const unreadable = buildFsWritePreview('u.bin', 'x\ny\n')
    expect(unreadable.reason).toBe('FS_WRITE_OVERWRITE_UNREADABLE')
    expect(unreadable.fields.map((f) => f.key)).toEqual(['fs_write_path', 'fs_write_abs', 'fs_write_stats'])
  })

  it('每一档 reason 与每一个字段键在四语字典里都有原文（回码写了、句子没写就是白屏上的裸码）', () => {
    const reasons = ['FS_WRITE_NEW', 'FS_WRITE_OVERWRITE', 'FS_WRITE_OVERWRITE_UNREADABLE', 'FS_WRITE_PATH_OUTSIDE']
    const fields = ['fs_write_path', 'fs_write_abs', 'fs_write_stats', 'fs_write_diff']
    const ui = ['agent.fsWrite.restore', 'agent.fsWrite.restored', 'agent.fsWrite.removed', 'agent.fsWrite.notRestorable']
    for (const [lang, dict] of Object.entries(DICTS)) {
      for (const r of reasons) expect(dict[`agent.approval.reason.${r}`], `${lang} 缺 reason ${r}`).toBeTruthy()
      for (const f of fields) expect(dict[`agent.approval.field.${f}`], `${lang} 缺字段 ${f}`).toBeTruthy()
      for (const k of ui) expect(dict[k], `${lang} 缺 ${k}`).toBeTruthy()
    }
  })

  it('两种"看不全"各有各的符号：~ =未逐行对齐，⋯ =展示被截断（值里不许有中文串）', () => {
    // 朴素两栏那一档：行数超过算法上限 ⇒ 只标 ~，展示行数（120）没超 maxRows，所以不该出现 ⋯
    const huge = Array.from({ length: 500 }, (_, i) => `p${i}`).join('\n')
    fs.writeFileSync(path.join(tmp.workspace, 'big.md'), huge, 'utf-8')
    const coarse = buildFsWritePreview('big.md', Array.from({ length: 500 }, (_, i) => `n${i}`).join('\n'))
    const coarseStats = coarse.fields.find((f) => f.key === 'fs_write_stats')!.value
    expect(coarseStats).toContain('~')
    expect(coarseStats).not.toContain('⋯')

    // 精确对齐但显示截断：100 行改 100 行，展示上限 200 行不够 ⇒ 标 ⋯，不标 ~
    const many = Array.from({ length: 150 }, (_, i) => `p${i}`).join('\n')
    fs.writeFileSync(path.join(tmp.workspace, 'mid.md'), many, 'utf-8')
    const next150 = Array.from({ length: 150 }, (_, i) => `x${i}`).join('\n')
    const d = buildFileDiff(many, next150, { maxRows: 40 })
    expect(d.coarse).toBe(false)
    expect(d.truncated).toBe(true)
    expect(d.totalRows).toBe(300)

    // 值进的是四语同一屏，所以只准有符号与数字
    expect(/[一-鿿]/.test(coarseStats), `stats 里混进了中文：${coarseStats}`).toBe(false)
  })
})
