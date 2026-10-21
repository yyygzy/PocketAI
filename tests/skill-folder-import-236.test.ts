// @vitest-environment node
// §236 目录导入的真链：真 SQLite（v51 迁移）＋真 fs＋假 electron 对话框，跨过 handler 注册表。
//
// 这条链上值得钉的四件事，都不是"函数被调过"：
//  · 老库升上来 resident 默认 1 ⇒ 现有用户的技能行为一个字节不变（这是"零回退风险"的实际形态）；
//  · 正文超过常驻上限时**降成按需并说为什么**，而不是判失败（一份 12KB 的上游 SKILL.md 本来就是按需形状）；
//  · 装文件装到一半失败 ⇒ 不留半份技能（库里有行、目录里没文件，load_skill 只会一直报"没这条文件"）；
//  · 删技能连目录一起删。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'

const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/'
  return base + sep + 'pocketai-skill-folder-236'
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown,
  pickDir: { current: '' }
}))

vi.mock('../src/main/portable', async () => {
  const p = await import('node:path')
  const data = p.join(TMP, 'data')
  // 这条链会牵到附件/内置数据那几层，portable 的导出一次给全（缺一个就是整文件加载失败）
  return {
    APP_ROOT: TMP,
    DATA_DIR: data,
    DB_PATH: p.join(data, 'app.db'),
    CONFIG_PATH: p.join(data, 'config.json'),
    ATTACHMENTS_DIR: p.join(data, 'attachments'),
    EXTENSIONS_DIR: p.join(TMP, 'extensions'),
    USER_EXTENSIONS_DIR: p.join(data, 'extensions'),
    MCP_EXTENSIONS_DIR: p.join(data, 'extensions', 'mcp'),
    LOGS_DIR: p.join(data, 'logs'),
    RUNTIME_DIR: p.join(TMP, 'runtime'),
    isPortable: () => false,
    portableDataDir: () => TMP
  }
})

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => TMP, getAppPath: () => TMP, quit: () => {} },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      H.handlers.set(ch, fn)
    },
    on: () => {},
    removeListener: () => {}
  },
  ipcRenderer: {
    invoke: async (ch: string, ...args: unknown[]) => {
      const fn = H.handlers.get(ch)
      if (!fn) throw new Error(`渲染层指向了一个没人注册的通道：${ch}`)
      return fn({}, ...args)
    },
    on: () => () => {},
    removeListener: () => {},
    send: () => {}
  },
  contextBridge: { exposeInMainWorld: (_n: string, api: unknown) => { H.api = api } },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [H.pickDir.current] }),
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: () => {}
  },
  BrowserWindow: class {
    static fromWebContents() {
      return { id: 1 }
    }
    static getAllWindows() {
      return [{ id: 1 }]
    }
  },
  nativeImage: { createFromPath: () => ({}) }
}))

import path from 'node:path'
import { dbService } from '../src/main/db/database'
import { skillRepo } from '../src/main/db/repositories/skill.repo'
import { registerSkillHandlers } from '../src/main/ipc/handlers/skills'
import { skillFilesDir } from '../src/main/skills/skill-files'
import '../src/preload/index'
import { MAX_RESIDENT_CONTENT_BYTES } from '../src/main/skills/skill-parser'

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}

/** 造一份上游形状的 SKILL.md 技能目录 */
function makeSkillDir(name: string, bodyChars: number): string {
  const dir = path.join(TMP, 'src-' + name)
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
  const front = `---\nname: ${name}\ndescription: 一条用于用例的技能\nallowed-tools: Read, Bash\ncompatibility: 别的客户端\n---\n\n`
  fs.writeFileSync(path.join(dir, 'SKILL.md'), front + 'x'.repeat(bodyChars), 'utf8')
  fs.writeFileSync(path.join(dir, 'references', 'api.md'), 'API 说明', 'utf8')
  // 两份资源：半途失败那条要能在**第二次**复制上抛错，只有一份就永远撞不到那一支
  fs.writeFileSync(path.join(dir, 'references', 'notes.md'), '补充说明', 'utf8')
  return dir
}

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerSkillHandlers()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('v51 那一列：老行为不动', () => {
  it('不传 resident 建出来的技能是常驻（默认值必须等于今天的行为，不是"没读到"）', () => {
    const s = skillRepo.save({ name: '不带 resident 的技能', content: '正文' })
    expect(s.resident).toBe(true)
    const again = skillRepo.save({ id: s.id, name: s.name, content: s.content, resident: false })
    expect(again.resident).toBe(false)
    expect(skillRepo.get(s.id)!.resident).toBe(false)
  })
})

describe('目录导入跨过 handler 那一趟', () => {
  it('小正文：常驻导入、references 装进技能目录、未知 frontmatter 报出来但不拦', async () => {
    H.pickDir.current = makeSkillDir('小包', 200)
    const r = await call('importSkillFolder')
    expect(r.ok).toBe(true)
    expect(r.skill.resident).toBe(true)
    expect(r.forcedOnDemand).toBe(false)
    // 上游技能包常见的 allowed-tools/compatibility：不执行，但要说出来
    expect(r.ignoredKeys).toEqual(['allowed-tools', 'compatibility'])
    expect(r.copied).toEqual(['references/api.md', 'references/notes.md'])
    expect(fs.existsSync(path.join(skillFilesDir(r.skill.id), 'references', 'api.md'))).toBe(true)
    const listed = await call('listSkillFiles', r.skill.id)
    expect(listed.ok).toBe(true)
    expect(listed.files.map((f: { path: string }) => f.path)).toEqual(['references/api.md', 'references/notes.md'])
  })

  it('正文超过常驻上限 ⇒ 自动按需并明说（不判失败），开关是关的', async () => {
    H.pickDir.current = makeSkillDir('大包', MAX_RESIDENT_CONTENT_BYTES + 500)
    const r = await call('importSkillFolder')
    expect(r.ok).toBe(true)
    expect(r.forcedOnDemand).toBe(true)
    expect(r.skill.resident).toBe(false)
  })

  it('反向对照：没有 SKILL.md 的目录报 NO_SKILL_MD，不会留下一条空技能', async () => {
    const dir = path.join(TMP, 'src-no-entry')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), '这不是入口', 'utf8')
    H.pickDir.current = dir
    const before = skillRepo.list().length
    const r = await call('importSkillFolder')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('NO_SKILL_MD')
    expect(skillRepo.list().length).toBe(before)
  })

  it('装文件装到一半失败 ⇒ 不留半份（库里的行被撤、目录被清）', async () => {
    H.pickDir.current = makeSkillDir('半途失败', 100)
    const copy = fs.copyFileSync
    let nth = 0
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(((src: string, dest: string) => {
      nth += 1
      if (nth === 2) throw new Error('模拟：磁盘在这一刻不配合')
      return copy(src, dest)
    }) as typeof fs.copyFileSync)
    const before = skillRepo.list().length
    const r = await call('importSkillFolder')
    spy.mockRestore()
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('模拟')
    expect(skillRepo.list().length).toBe(before)
  })

  it('删技能连它自带的文件一起删（handler 回 filesRemoved=true）', async () => {
    H.pickDir.current = makeSkillDir('要删掉', 100)
    const r = await call('importSkillFolder')
    const id = r.skill.id
    expect(fs.existsSync(skillFilesDir(id))).toBe(true)
    const del = await call('deleteSkill', id)
    expect(del).toEqual({ ok: true, filesRemoved: true })
    expect(fs.existsSync(skillFilesDir(id))).toBe(false)
    // 反向对照：再删一次（本来就没有目录）报 filesRemoved=false，不是失败
    skillRepo.save({ id: 's-again', name: '没有目录的技能', content: '正文' })
    expect(await call('deleteSkill', 's-again')).toEqual({ ok: true, filesRemoved: false })
  })

  it('listSkillFiles 问一条不存在的技能 ⇒ {ok:false}（那句"读不到"有真 producer，不演成"没有文件"）', async () => {
    const r = await call('listSkillFiles', 'no-such-skill')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('SKILL_NOT_FOUND')
  })
})
