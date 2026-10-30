// §368：`config.json.tmp-<pid>-<Date.now()>` 这个命名到底挡得住什么、挡不住什么
//
// 起点是**我自己上一条报的风险**——"同一毫秒连写两发会撞名、把第二发的钥匙弄丢"。
// 探针跑下来这条**不成立**（W1/W2 全绿）：三处写点都是同步函数、中间没有 await，第一发的临时文件在
// `renameSync` 之后已经不存在，第二发新建的是同名新文件 ⇒ 撞不到。真正会被 `wx` 挡下的是**另一个进程**
// 同时在写（W3），而那正是该挡的、且挡下时目标文件逐字不动。所以这枚不改产品码，只把这些语义钉成判据。
// 会不会在"同一毫秒连写两发"时撞名、把第二发的钥匙弄丢？
//  W1 同毫秒连写两发（把 Date.now() 钉成常量）⇒ 两把都该落文件、一句 warn 都不该有
//  W2 坏文件＋同毫秒连写 ⇒ 留档只该有一份（第二发撞到的已是可解析的新文件）
//  W3 真并发（先占住那个临时文件名＝另一进程正在写）⇒ `flag:'wx'` 就该挡住第二发，且不许碰坏目标文件
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TMP_DIR = join(process.cwd(), 'data', `tmp-wx-368-${randomBytes(4).toString('hex')}`)
const CONFIG_PATH = join(TMP_DIR, 'config.json')

const warnLines: string[] = []

function createMockDb() {
  const store = new Map<string, string>()
  return {
    getHandle: () => ({
      prepare: (sql: string) => ({
        get: (key: string) => (sql.startsWith('SELECT') && store.has(key) ? { value: store.get(key) } : undefined),
        run: (key: string, value?: string) => {
          if (sql.startsWith('INSERT')) store.set(key, value ?? '')
          else if (sql.startsWith('DELETE')) store.delete(key)
        }
      })
    }),
    store
  }
}

let mockDb: ReturnType<typeof createMockDb>

function mockDeps(fsOverrides: Record<string, unknown> = {}) {
  vi.resetModules()
  warnLines.length = 0
  mockDb = createMockDb()
  vi.doMock('../src/main/db/database', () => ({ dbService: mockDb }))
  vi.doMock('../src/main/portable', () => ({ CONFIG_PATH, DATA_DIR: TMP_DIR }))
  vi.doMock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  vi.doMock('../src/main/logger', () => ({
    createLogger: () => ({
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => warnLines.push(args.map(String).join(' ')),
      error: () => {}
    })
  }))
  if (Object.keys(fsOverrides).length) {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return { ...actual, default: { ...actual, ...fsOverrides }, ...fsOverrides }
    })
  }
}

async function loadRepo(fsOverrides: Record<string, unknown> = {}) {
  mockDeps(fsOverrides)
  const mod = await import('../src/main/db/repositories/app-config.repo')
  return mod.appConfigRepo
}

function cfg(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
}
function archives(): string[] {
  return readdirSync(TMP_DIR).filter((n) => n.startsWith('config.json.corrupt-'))
}
function leftovers(): string[] {
  return readdirSync(TMP_DIR).filter((n) => n.startsWith('config.json.tmp-'))
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('node:fs')
  rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('①同毫秒连写：撞的是文件名还是并发', () => {
  it('W1 把 Date.now() 钉成常量、连写 salt 与档位 ⇒ 两把都在、一句 warn 都不该有（我上一条报的风险若为真，这条会红）', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    const repo = await loadRepo()

    repo.setMasterPasswordSalt(Buffer.from('00112233445566778899aabbccddeeff', 'hex'))
    repo.setKdfParams({ N: 131072, r: 8, p: 1 })

    expect(Object.keys(cfg()).sort(), warnLines.join(' | ')).toEqual(['kdfParams', 'masterPasswordSalt'])
    expect(warnLines.join('\n'), '不该有任何 warn').toBe('')
    expect(leftovers()).toEqual([])
  })

  it("W1' 三把钥匙在同一毫秒里连写三发 ⇒ 三把都在、无 warn、无残骸", async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000002)
    const repo = await loadRepo()

    repo.setMasterPasswordSalt(Buffer.alloc(16, 1))
    repo.setKdfParams({ N: 131072, r: 8, p: 1 })
    repo.setRecoveryBlob('rv1:TRIPLE')

    expect(Object.keys(cfg()).sort(), warnLines.join(' | ')).toEqual(['kdfParams', 'masterPasswordSalt', 'recoveryBlob'])
    expect(warnLines.length, warnLines.join(' | ')).toBe(0)
    expect(leftovers()).toEqual([])
    expect(archives()).toEqual([])
  })

  it('W2 坏文件＋同毫秒连写两发 ⇒ 留档只一份（第二发撞到的是已可解析的新文件），两把钥匙都在', async () => {
    writeFileSync(CONFIG_PATH, '{ "recoveryBlob": "rv1:AAAA", ', 'utf8')
    vi.spyOn(Date, 'now').mockReturnValue(1700000000001)
    const repo = await loadRepo()

    repo.setMasterPasswordSalt(Buffer.alloc(16, 3))
    repo.setRecoveryBlob('rv1:NEW')

    expect(archives().length, warnLines.join(' | ')).toBe(1)
    expect(Object.keys(cfg()).sort()).toEqual(['masterPasswordSalt', 'recoveryBlob'])
    expect(leftovers()).toEqual([])
  })
})

describe('②真并发那一侧：wx 挡下第二发、且不碰目标文件', () => {
  it('W3 另一进程已占住同名临时文件（EEXIST）⇒ salt 这一发 warn 且不抛、config.json 逐字不变', async () => {
    const good = JSON.stringify({ masterPasswordSalt: 'AAA', kdfParams: { N: 131072, r: 8, p: 1 } }, null, 2)
    writeFileSync(CONFIG_PATH, good, 'utf8')
    const seen: string[] = []
    const opts: Array<Record<string, unknown>> = []
    const repo = await loadRepo({
      writeFileSync: ((p: string | URL | number, _data: unknown, o: unknown) => {
        const s = String(p)
        if (s.includes('.tmp-')) {
          seen.push(s)
          opts.push((o ?? {}) as Record<string, unknown>)
          // 另一个进程已经把这个独占临时文件建好了 ⇒ 真 fs 会在这里抛 EEXIST，这里等价地抛
          throw Object.assign(new Error('EEXIST: file already exists, open'), { code: 'EEXIST' })
        }
        throw new Error('这一发的写不该绕过临时文件：' + s)
      }) as never
    })

    expect(() => repo.setMasterPasswordSalt(Buffer.alloc(16, 9))).not.toThrow()

    expect(seen.length, '这一发确实该走独占临时文件').toBe(1)
    const first = seen[0] ?? ''
    const o = opts[0] ?? {}
    expect(first).toContain('config.json.tmp-')
    // 牙在这四颗：摘掉任何一个，"独占"就只是注释里的一句话
    expect(o.flag, '必须是 wx（存在就失败，不覆盖别人正在写的那份）').toBe('wx')
    expect(o.mode, '权限 0600（这份文件装的是解锁钥匙）').toBe(0o600)
    expect(first, '名字要带 pid＝两个进程各写各的，不互相顶掉').toContain(String(process.pid))
    expect(readFileSync(CONFIG_PATH, 'utf8'), '目标文件一个字都不许动').toBe(good)
    expect(warnLines.join('\n')).toContain('salt 写 config.json 失败')
    // 这里不断言"没留下临时文件残骸"：这一发的桩是在 create 之前就抛的，磁盘上本来就没有那个文件 ⇒ 那句恒真＝没牙。
    // 残骸的牙在 W4（那里临时文件真的建成了，靠 rename 失败才走清理分支）。
  })

  it('W4 同一发里若 rename 也失败 ⇒ 抛出来的是"写入失败"，仍不许碰目标文件（恢复包那侧契约＝throw）', async () => {
    const good = JSON.stringify({ masterPasswordSalt: 'BBB' }, null, 2)
    writeFileSync(CONFIG_PATH, good, 'utf8')
    const repo = await loadRepo({
      renameSync: () => {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
    })

    expect(() => repo.setRecoveryBlob('rv1:C')).toThrow(/恢复密钥写入 config\.json 失败/)
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(good)
    expect(archives()).toEqual([])
    expect(leftovers(), 'rename 失败后临时文件要被清掉').toEqual([])
  })
})
