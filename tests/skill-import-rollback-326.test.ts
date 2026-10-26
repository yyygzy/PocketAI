// @vitest-environment node
// V4-Iter-326⑤ 目录导入的回滚：`rollbackSkillFiles` 有 catch，而 `skillRepo.delete` 原本裸着。
//
// 裸着的那一句抛出去会被外层 catch 咽成 `{ok:false,error:<原文>}`，而渲染层认不出这句原文
// （`SkillMarket.tsx` 的 keyMap 只认三个码，其余一律折叠成「导入失败」）⇒
// 用户看到"失败了"，列表里却多了一条**有记录、没文件**的技能——正是这一层注释明令不许的形状。
// 所以这一张脸要自己的回码。判据：三种回滚结果各回什么、留没留痕、旧那两张脸不许被新分支吃掉。
//
// 真的：skill-io 的目录导入编排（含回滚分支）。假的：对话框、fs、skill-files、解析器、技能仓储、logger。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  pick: '/fake/skill-dir',
  installThrows: true,
  rollbackNote: '',
  deleteThrows: false,
  deleted: [] as string[],
  warns: [] as string[],
  reset(): void {
    this.installThrows = true
    this.rollbackNote = ''
    this.deleteThrows = false
    this.deleted = []
    this.warns = []
  }
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/fake', getVersion: () => '1.2.8' },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [H.pick] }),
    showSaveDialog: async () => ({ canceled: true, filePaths: [] })
  },
  BrowserWindow: class {
    static fromWebContents(): undefined {
      return undefined
    }
    static getAllWindows(): never[] {
      return []
    }
  }
}))

vi.mock('../src/main/portable', () => ({ DATA_DIR: '/fake/data' }))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => H.warns.push(a.map(String).join(' ')),
    error: () => {}
  })
}))

vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: {
    // 目录导入先落这一行（id 由仓储生成），再往 skill-files 那层装资源
    save: () => ({
      id: 'sk-1',
      name: '示例技能',
      description: '',
      icon: '⚡',
      content: 'body',
      enabled: true,
      resident: true,
      isBuiltin: false,
      createdAt: 1
    }),
    list: () => [],
    get: () => null,
    delete: (id: string) => {
      if (H.deleteThrows) throw new Error('SQLITE_BUSY: database is locked')
      H.deleted.push(id)
    }
  }
}))

vi.mock('../src/main/skills/skill-parser', () => ({
  parseSkillText: () => ({
    shape: { name: '示例技能', description: '', icon: '⚡', content: 'body' },
    ignoredKeys: [],
    error: undefined
  })
}))

vi.mock('../src/main/skills/skill-files', () => ({
  readSkillFolder: () => ({
    entryText: 'name: 示例技能\ncontent: body',
    files: [],
    skipped: [],
    error: undefined
  }),
  installSkillFiles: () => {
    if (H.installThrows) throw new Error('磁盘满了')
    return { copied: ['scripts/a.py'], skipped: [] }
  },
  rollbackSkillFiles: () => H.rollbackNote,
  listSkillFiles: () => []
}))

// 这一层在模块加载时读上限（8KB），给一份合法形状就够
import { importSkillFolder } from '../src/main/skills/skill-io'

beforeEach(() => {
  H.reset()
})

describe('§326⑤ 目录导入的回滚三分支', () => {
  it('装资源失败、记录删得掉 ⇒ 错误原文照旧带回，且不许多挂一个新码', async () => {
    const r = await importSkillFolder({} as never)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('磁盘满了')
    expect(H.deleted).toEqual(['sk-1'])
    expect(H.warns).toEqual([])
  })

  it('装资源失败、记录删不掉 ⇒ 回的是那个可辨认的码（界面据此才说得出"列表里会留下一条打不开的"）', async () => {
    H.deleteThrows = true
    const r = await importSkillFolder({} as never)
    expect(r.ok).toBe(false)
    expect(r.error, '光秃秃的原文会被渲染层折叠成「导入失败」，这张脸必须单独成码').toBe(
      'SKILL_ROW_RESIDUE'
    )
    expect(H.deleted).toEqual([])
    expect(H.warns).toHaveLength(1)
    expect(H.warns[0]!).toContain('列表里会留下打不开的这条 sk-1')
  })

  it('反向对照：装成功 ⇒ 那条记录不许被回滚删掉，返回 ok:true', async () => {
    H.installThrows = false
    const r = await importSkillFolder({} as never)
    expect(r.ok).toBe(true)
    expect(r.skill?.id).toBe('sk-1')
    expect(H.deleted).toEqual([])
  })

  it('旧那一张脸不许被新分支吃掉：文件回滚也失败时仍是那句「残留清理也失败」', async () => {
    H.rollbackNote = '目录被占用'
    const r = await importSkillFolder({} as never)
    expect(r.error).toBe('磁盘满了；残留清理也失败：目录被占用')
    expect(H.deleted).toEqual(['sk-1'])
  })
})
