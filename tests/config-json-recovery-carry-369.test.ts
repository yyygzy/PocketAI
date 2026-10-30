// V4-Iter-369：`config.json` 整份解析不出来时，唯一没有第二份的那把钥匙（恢复包）不许被当成「没有」
//
// 起点＝§367 自己留下的那半项：那次修完「坏文件不再被当空对象重建」之后，读出来仍然有一件不诚实的事——
// `recovery-key.ts:104` 的 `hasRecovery()` 与 `:131` 的 `recoverMasterKey()` 都只看**活的** config.json，
// 于是坏文件＋一次改写＝活文件里没有 recoveryBlob ⇒ 设置页那一格画「未设置 —— 忘记主密码将无法找回数据」，
// 忘密码那一扇抛「未设置恢复密钥」＝**应用拒绝使用自己写下的、而且是唯一一份的救援字节**（字节在 config.json.corrupt-* 里，
// 而 config.json 不在备份包内＝§367 已现查）。
//
// 本批口径（用户选定「接回＋说一句」）＝
//  ① 只在"解析不出来"那一刻按字段把 `rv1:` 那一段扫出来（salt／档位各有 DB 回退副本，不靠这根松口子＝未校验的字节不当权威）；
//  ② 接回发生在两处：写路径搬走坏文件时带上（唯一出口 `loadConfigForWrite`），读路径自己撞上坏文件时当场扫（不写盘）；
//  ③ **不做留档目录扫描**——目录里那份留档可能是用户主动删包之前留下的，扫它＝替用户把他删掉的东西顶回来；
//  ④ 上屏说一句（`enc.recoveryCarried`，带的是那份文件的名字），但用户自己写新的一把时这句话必须消失。
//
// 判据的八件事：C1 正常来源不许挂那句话（正向对照）／C2 写路径带回来＋记来源／C3 用户自己写的那一把顶掉旧包也顶掉那句话／
// C4 那一段本身被截断⇒不接回／C5 读路径自己救＋salt 档位不许跟着救／C6 主动删除后留档仍在但绝不复活／
// C7 来源标记与包成对（有标记没包⇒不许单独说话）／C8 标记是空串⇒按没有处理
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TMP_DIR = join(process.cwd(), 'data', `tmp-recovery-carry-369-${randomBytes(4).toString('hex')}`)
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

async function loadRepo() {
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
  const mod = await import('../src/main/db/repositories/app-config.repo')
  return mod.appConfigRepo
}

function cfg(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
}
function saltB64(): string {
  return Buffer.from('00112233445566778899aabbccddeeff', 'hex').toString('base64')
}
/** 半截 JSON＝断电/手工编辑的形状：里面两把钥匙都在，整份 parse 抛 */
function corruptFile(): string {
  const bad = '{ "recoveryBlob": "rv1:AAAA", "masterPasswordSalt": "' + saltB64() + '", '
  writeFileSync(CONFIG_PATH, bad, 'utf8')
  return bad
}
/** 恢复包那一段自己也被截断（没有收尾引号）＝扫不出来 */
function corruptFileWithBrokenBlob(): string {
  const bad = '{ "masterPasswordSalt": "' + saltB64() + '", "recoveryBlob": "rv1:AAA'
  writeFileSync(CONFIG_PATH, bad, 'utf8')
  return bad
}
function filesWith(suffixPrefix: string): string[] {
  return readdirSync(TMP_DIR).filter((n) => n.startsWith('config.json' + suffixPrefix))
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('① 正向对照：正常来源的那把包不许挂着「取回」那句话', () => {
  it('C1 三把钥匙齐的好文件 ⇒ blob 读得到、carriedFrom 为 null、一句 warn 都不许有', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ masterPasswordSalt: saltB64(), kdfParams: { N: 131072, r: 8, p: 1 }, recoveryBlob: 'rv1:AAAA' }, null, 2), 'utf8')
    const repo = await loadRepo()

    expect(repo.recoveryState(), warnLines.join(' | ')).toEqual({ blob: 'rv1:AAAA', carriedFrom: null })
    expect(repo.getRecoveryBlob()).toBe('rv1:AAAA')
    expect(warnLines.join('\n')).toBe('')
  })

  it('C3 坏文件＋用户自己写新的一把 ⇒ 新把赢，且「取回」那句跟着消失（用户主动写＝来源清楚）', async () => {
    corruptFile()
    const repo = await loadRepo()

    repo.setRecoveryBlob('rv1:NEW')

    expect(cfg().recoveryBlob).toBe('rv1:NEW')
    expect(cfg().recoveryCarriedFrom, '留下的那句话会让用户以为这把也是扫出来的').toBeUndefined()
    expect(repo.recoveryState()).toEqual({ blob: 'rv1:NEW', carriedFrom: null })
  })
})

describe('② 写路径：搬走坏文件那一发要把唯一一份的钥匙带上', () => {
  it('C2 坏文件＋写 salt ⇒ 活文件带回 rv1:AAAA、来源记的是那份留档的名字、留档字节逐字未动', async () => {
    const bad = corruptFile()
    const repo = await loadRepo()

    repo.setMasterPasswordSalt(Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'))

    expect(cfg().recoveryBlob, warnLines.join(' | ')).toBe('rv1:AAAA')
    const archives = filesWith('.corrupt-')
    expect(archives.length).toBe(1)
    const name = archives[0] ?? ''
    expect(cfg().recoveryCarriedFrom, '记的是文件名，不是整条绝对路径').toBe(name)
    expect(readFileSync(join(TMP_DIR, name), 'utf8')).toBe(bad)
    expect(warnLines.join('\n')).toContain('按字段扫出来带上了')
    // 带回来之后，这一发该读成"有包、且来源是那份留档"
    expect(repo.recoveryState()).toEqual({ blob: 'rv1:AAAA', carriedFrom: name })
  })

  it('C4 坏文件里那一段本身被截断 ⇒ 不许接回（扫出来的是断掉的字节，不是包）', async () => {
    const bad = corruptFileWithBrokenBlob()
    const repo = await loadRepo()

    repo.setKdfParams({ N: 131072, r: 8, p: 1 })

    expect(cfg().recoveryBlob).toBeUndefined()
    expect(cfg().recoveryCarriedFrom).toBeUndefined()
    expect(filesWith('.corrupt-').length).toBe(1)
    const all = warnLines.join('\n')
    expect(all).toContain('原文已留档')
    expect(all).toContain('恢复包没扫出来')
    expect(readFileSync(join(TMP_DIR, filesWith('.corrupt-')[0] ?? ''), 'utf8')).toBe(bad)
    expect(repo.getRecoveryBlob()).toBeNull()
  })
})

describe('③ 读路径：自己撞上坏文件时也当场救，但只有这一把钥匙许救', () => {
  it('C5 坏文件＋一次写都没发生 ⇒ blob 当场扫出来、carriedFrom 说的是 config.json，而 salt／档位仍各自按缺失处理', async () => {
    corruptFile()
    const repo = await loadRepo()

    expect(repo.getRecoveryBlob()).toBe('rv1:AAAA')
    expect(repo.recoveryState().carriedFrom).toBe('config.json')

    // 反向对照：另两把各有 DB 回退副本，不许被同一根松口子读成"有值"
    expect(repo.getMasterPasswordSalt()).toBeNull()
    expect(repo.getKdfParams().N).toBe(32768)

    // 三把钥匙各自的 label 要逐条点得到（这句要在三发读都发生之后才取得到）
    const all = warnLines.join('\n')
    expect(all).toContain('恢复密钥包：config.json 解析失败')
    expect(all).toContain('这一项是按字段扫出来的')
    expect(all).toContain('主密码 salt：config.json 解析失败')
    expect(all).toContain('主密码 KDF 档位：config.json 解析失败')
    expect(all, 'salt／档位不许也跟着扫').not.toContain('主密码 salt：config.json 整份解析失败，这一项是按字段扫出来的')
  })

  it('C6 主动删掉恢复包之后，目录里那份留档还在，但也绝不复活（这就是"不做目录扫描"的牙）', async () => {
    corruptFile()
    const repo = await loadRepo()
    repo.setMasterPasswordSalt(Buffer.from('00112233445566778899aabbccddeeff', 'hex')) // 这一步把包接回来了
    expect(repo.getRecoveryBlob()).toBe('rv1:AAAA')

    repo.clearRecoveryBlob()

    expect(repo.getRecoveryBlob()).toBeNull()
    expect(repo.recoveryState().carriedFrom).toBeNull()
    const archives = filesWith('.corrupt-')
    expect(archives.length, '留档不许被顺手删掉＝那是唯一的证据').toBe(1)
    expect(readFileSync(join(TMP_DIR, archives[0] ?? ''), 'utf8')).toContain('rv1:AAAA')
  })
})

describe('④ 来源标记与那把包成对：单独挂着标记不许说话', () => {
  it('C7 文件里有 recoveryCarriedFrom 而没有 recoveryBlob ⇒ carriedFrom 读成 null（不许画一句没有主语的话）', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ masterPasswordSalt: saltB64(), recoveryCarriedFrom: 'config.json.corrupt-1700000000000' }, null, 2), 'utf8')
    const repo = await loadRepo()

    expect(repo.getRecoveryBlob()).toBeNull()
    expect(repo.recoveryState(), warnLines.join(' | ')).toEqual({ blob: null, carriedFrom: null })
  })

  it('C8 标记是空串 ⇒ 与没有标记同读（空串不该被当成"说过这句话的来源"）', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ recoveryBlob: 'rv1:AAAA', recoveryCarriedFrom: '' }, null, 2), 'utf8')
    const repo = await loadRepo()

    expect(repo.recoveryState()).toEqual({ blob: 'rv1:AAAA', carriedFrom: null })
  })
})
