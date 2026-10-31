// @vitest-environment node
// V4-Iter-374：§372 撞出的那条负载 flake 的根因收口——config.json 的 renameSync 在 Windows
// 满负载下会撞瞬时 EPERM（目标被杀软/索引器持句柄），而 config.json 是恢复包的唯一副本（§367），
// 一次瞬时锁不该让整发写失败。修法＝两处 rename 走有界退避重试（renameWithRetry）。
//
// 复现手段＝注入 renameSync「先抛 k 次 EPERM、之后放行真 rename」——不是重造负载（§362 口径）。
// 反向对照钉住：非瞬时错误（ENOENT）不重试、耗尽重试仍抛且清 tmp、正常写一次过且不说重试那句。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TMP_DIR = join(process.cwd(), 'data', `tmp-rename-retry-374-${randomBytes(4).toString('hex')}`)
const CONFIG_PATH = join(TMP_DIR, 'config.json')

const warnLines: string[] = []
let renameCalls = 0

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

/**
 * 注入一颗 renameSync：前 failTimes 次抛 code（模拟瞬时锁），之后交给真 rename。
 * 计数落在 renameCalls。
 */
async function loadRepo(opts: { failTimes?: number; code?: string } = {}) {
  vi.resetModules()
  warnLines.length = 0
  renameCalls = 0
  const { failTimes = 0, code = 'EPERM' } = opts
  vi.doMock('../src/main/db/database', () => ({ dbService: createMockDb() }))
  vi.doMock('../src/main/portable', () => ({ CONFIG_PATH, DATA_DIR: TMP_DIR }))
  vi.doMock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  vi.doMock('../src/main/logger', () => ({
    createLogger: () => ({
      debug: () => {},
      info: () => {},
      warn: (...a: unknown[]) => warnLines.push(a.map(String).join(' ')),
      error: () => {}
    })
  }))
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const flakyRename = ((from: string, to: string) => {
      renameCalls++
      if (renameCalls <= failTimes) {
        throw Object.assign(new Error(`${code}: transient lock`), { code })
      }
      return actual.renameSync(from, to)
    }) as typeof import('node:fs').renameSync
    return {
      ...actual,
      default: actual,
      readFileSync: actual.readFileSync,
      writeFileSync: actual.writeFileSync,
      renameSync: flakyRename,
      unlinkSync: actual.unlinkSync,
      existsSync: actual.existsSync
    }
  })
  const mod = await import('../src/main/db/repositories/app-config.repo')
  return mod.appConfigRepo
}

const cfg = (): Record<string, unknown> => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
const tmpResidue = (): string[] => readdirSync(TMP_DIR).filter((n) => n.startsWith('config.json.tmp-'))
const archives = (): string[] => readdirSync(TMP_DIR).filter((n) => n.startsWith('config.json.corrupt-'))

beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }))
afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true })
  vi.doUnmock('node:fs')
  vi.doUnmock('../src/main/logger')
})

describe('§374 saveConfigFile 的 rename 撞瞬时锁 ⇒ 有界退避重试', () => {
  it('R1 前 2 次 EPERM、第 3 次成 ⇒ 写落地、无 tmp 残骸、rename 被叫 3 次、留了重试那句', async () => {
    const repo = await loadRepo({ failTimes: 2 })
    repo.setRecoveryBlob('rv1:AAAA')
    expect(cfg().recoveryBlob).toBe('rv1:AAAA')
    expect(tmpResidue()).toEqual([])
    expect(renameCalls).toBe(3)
    expect(warnLines.some((l) => /退避重试/.test(l))).toBe(true)
  })

  it('R2 前 5 次都 EPERM、第 6 次（最后一次尝试）成 ⇒ 仍写成功（重试预算＝6 次尝试）', async () => {
    const repo = await loadRepo({ failTimes: 5 })
    repo.setRecoveryBlob('rv1:BBBB')
    expect(cfg().recoveryBlob).toBe('rv1:BBBB')
    expect(renameCalls).toBe(6)
    expect(tmpResidue()).toEqual([])
  })

  it('R3 一直 EPERM（超过预算）⇒ 抛「写入失败」、rename 只叫 6 次、清掉 tmp、config.json 没被半截顶掉', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ masterPasswordSalt: 'keepme' }), 'utf8')
    const repo = await loadRepo({ failTimes: 99 })
    expect(() => repo.setRecoveryBlob('rv1:CCCC')).toThrow(/config\.json 写入失败/)
    expect(renameCalls).toBe(6)
    expect(tmpResidue()).toEqual([])
    // 失败那发不该把原文件弄没／弄坏：仍是原来那份、且没混进新写的恢复包
    expect(cfg()).toEqual({ masterPasswordSalt: 'keepme' })
  })

  it('R4 反向对照：非瞬时错误（ENOENT）不重试 ⇒ 一次就抛', async () => {
    const repo = await loadRepo({ failTimes: 99, code: 'ENOENT' })
    expect(() => repo.setRecoveryBlob('rv1:DDDD')).toThrow(/config\.json 写入失败/)
    expect(renameCalls).toBe(1)
    expect(warnLines.some((l) => /退避重试/.test(l))).toBe(false)
  })

  it('R5 正向对照：正常一次过 ⇒ rename 只叫 1 次、不说重试那句', async () => {
    const repo = await loadRepo({ failTimes: 0 })
    repo.setRecoveryBlob('rv1:EEEE')
    expect(cfg().recoveryBlob).toBe('rv1:EEEE')
    expect(renameCalls).toBe(1)
    expect(warnLines.some((l) => /退避重试/.test(l))).toBe(false)
  })

  it('R6 留档那颗 rename 也吃重试：坏文件＋前 1 次 EPERM ⇒ 仍留档、改写继续', async () => {
    writeFileSync(CONFIG_PATH, '{ "recoveryBlob": "rv1:AAAA", "masterPasswordSalt": "x', 'utf8') // 半截 JSON
    const repo = await loadRepo({ failTimes: 1 })
    repo.setKdfParams({ N: 131072, r: 8, p: 1 })
    expect(archives().length).toBe(1) // 坏原文被留档
    expect(cfg().kdfParams).toBeTruthy() // 改写继续
    expect(repo.getRecoveryBlob()).toBe('rv1:AAAA') // 恢复包按字段接回（§369）
    expect(renameCalls).toBe(3) // 留档那次撞 1 次 EPERM 重试成功（2 发）+ 原子写那次（1 发）
  })

  // 三把瞬时锁逐一演：摘掉任一把 ⇒ 那颗红（EPERM 由 R1/R2/R3/R6 演；这里补 EACCES／EBUSY 那一档）
  it.each(['EPERM', 'EACCES', 'EBUSY'])('R7 瞬时码 %s：撞 1 次 ⇒ 退避一次重试成功（rename 叫 2 次、写落地）', async (code) => {
    const repo = await loadRepo({ failTimes: 1, code })
    repo.setRecoveryBlob('rv1:' + code)
    expect(cfg().recoveryBlob).toBe('rv1:' + code)
    expect(renameCalls).toBe(2)
    expect(warnLines.some((l) => /退避重试/.test(l))).toBe(true)
  })
})
