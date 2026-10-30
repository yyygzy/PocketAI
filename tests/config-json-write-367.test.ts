// V4-Iter-367：config.json 是「三把解锁钥匙共用的一份明文文件」——写它时读不出来的那一条路
//
// 缺陷本体（§367 现查）：masterPasswordSalt / kdfParams / recoveryBlob 三把钥匙同住
// data/config.json，前两把在 app_config 里各有回退副本，**recoveryBlob 只有这一份**
// （恢复包按设计不能进加密库；备份包只装 manifest.json＋app.db＋attachments，不含 config.json）。
// 改前三处写点都是「读不出来就当空对象重建整文件」⇒ 任何一发写（例如启动时从 DB 回填 salt）
// 只要撞上坏文件，就把另外两把就地抹掉，日志与屏幕上一句话都没有。
// 本文件判的四件事：①正常写不吞兄弟键 ②坏文件先留档再新建 ③留档失败就拒写（不许覆盖）
// ④写走临时文件＋rename（断电不留半截），读侧把「没有文件／读不出／键不在」分成三档说话。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TMP_DIR = join(process.cwd(), 'data', `tmp-config-write-367-${randomBytes(4).toString('hex')}`)
const CONFIG_PATH = join(TMP_DIR, 'config.json')

/** node:fs 里被本模块用到的那几个名字，逐个可换（默认走真 fs） */
interface FsOverrides {
  readFileSync?: typeof import('node:fs').readFileSync
  writeFileSync?: typeof import('node:fs').writeFileSync
  renameSync?: typeof import('node:fs').renameSync
}

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

async function loadRepo(fs: FsOverrides = {}) {
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
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
      ...actual,
      default: actual,
      readFileSync: fs.readFileSync ?? actual.readFileSync,
      writeFileSync: fs.writeFileSync ?? actual.writeFileSync,
      renameSync: fs.renameSync ?? actual.renameSync,
      unlinkSync: actual.unlinkSync,
      existsSync: actual.existsSync
    }
  })
  const mod = await import('../src/main/db/repositories/app-config.repo')
  return mod.appConfigRepo
}

function cfg(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
}
function saltB64(): string {
  return Buffer.from('00112233445566778899aabbccddeeff', 'hex').toString('base64')
}
/** 把三把钥匙都落到文件里，返回坏掉之前那份的**逐字内容**（留档比对要用） */
function seedAllThree(): string {
  const good = JSON.stringify({ masterPasswordSalt: saltB64(), kdfParams: { N: 131072, r: 8, p: 1 }, recoveryBlob: 'rv1:AAAA' }, null, 2)
  writeFileSync(CONFIG_PATH, good, 'utf8')
  return good
}
/** 截断＝真实断电/半写的形状：文件里有内容、JSON.parse 抛 */
function corruptFile(): string {
  const bad = '{ "recoveryBlob": "rv1:AAAA", "masterPasswordSalt": "' + saltB64() + '", '
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
  rmSync(TMP_DIR, { recursive: true, force: true })
  vi.doUnmock('node:fs')
  vi.doUnmock('../src/main/logger')
})

describe('① 正常路径：三把钥匙互不吞（改前 salt×kdf 有现成用例，recovery 这第三把从没被点过）', () => {
  it('P1 写完 recovery 之后，salt 与档位仍在同一份文件里', async () => {
    const repo = await loadRepo()
    repo.setMasterPasswordSalt(Buffer.from('00112233445566778899aabbccddeeff', 'hex'))
    repo.setKdfParams({ N: 131072, r: 8, p: 1 })
    repo.setRecoveryBlob('rv1:AAAA')

    expect(Object.keys(cfg()).sort()).toEqual(['kdfParams', 'masterPasswordSalt', 'recoveryBlob'])
    expect(repo.getRecoveryBlob()).toBe('rv1:AAAA')
    expect(repo.getKdfParams().N).toBe(131072)
    expect(repo.getMasterPasswordSalt()?.toString('hex')).toBe('00112233445566778899aabbccddeeff')
  })

  it('P2 正向对照：一路正常写，目录里不许留下任何留档或临时残骸', async () => {
    const repo = await loadRepo()
    repo.setMasterPasswordSalt(Buffer.alloc(16, 7))
    repo.setRecoveryBlob('rv1:BBBB')
    repo.clearRecoveryBlob()

    expect(filesWith('.corrupt-'), warnLines.join(' | ')).toEqual([])
    expect(filesWith('.tmp-')).toEqual([])
    expect(cfg().recoveryBlob).toBeUndefined()
    expect(cfg().masterPasswordSalt).toBeTypeOf('string')
  })
})

describe('② 坏文件：先留档再新建（＝改前三发写点各自的"损坏则重建"）', () => {
  it('P3 坏文件＋写 salt ⇒ salt 落盘、坏原文逐字留在 .corrupt-* 里、日志说过留了档', async () => {
    const bad = corruptFile()
    const repo = await loadRepo()

    repo.setMasterPasswordSalt(Buffer.from('00112233445566778899aabbccddeeff', 'hex'))

    const archives = filesWith('.corrupt-')
    expect(archives.length, warnLines.join(' | ')).toBe(1)
    const archived = archives[0] ?? ''
    expect(archived).toContain('.corrupt-')
    expect(readFileSync(join(TMP_DIR, archived), 'utf8')).toBe(bad)
    expect(cfg().masterPasswordSalt).toBe(saltB64())
    expect(warnLines.join('\n')).toContain('原文已留档')
  })

  it('P4 坏文件＋写 recovery ⇒ 同样留档，且留档里能看到原本那把 salt（恢复包这发写点也得有牙）', async () => {
    const bad = corruptFile()
    const repo = await loadRepo()

    repo.setRecoveryBlob('rv1:NEW')

    const archives = filesWith('.corrupt-')
    expect(archives.length, warnLines.join(' | ')).toBe(1)
    const archived = archives[0] ?? ''
    expect(archived).toContain('.corrupt-')
    expect(readFileSync(join(TMP_DIR, archived), 'utf8')).toBe(bad)
    expect(bad).toContain(saltB64())
    expect(cfg().recoveryBlob).toBe('rv1:NEW')
  })

  it('P5 留档改名失败 ⇒ 抛错拒写，坏文件仍在且逐字未变（不许被空对象顶掉）', async () => {
    const bad = corruptFile()
    const eperm = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const repo = await loadRepo({ renameSync: (() => { throw eperm }) as never })

    expect(() => repo.setRecoveryBlob('rv1:NEW')).toThrow(/恢复密钥写入 config\.json 失败/)

    expect(filesWith('.corrupt-'), warnLines.join(' | ')).toEqual([])
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(bad)
  })

  it('P6 salt 那一发在同样的失败下不抛（DB 回退副本仍在）但必须说一句，且原文件没被顶掉', async () => {
    const bad = corruptFile()
    const eperm = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const repo = await loadRepo({ renameSync: (() => { throw eperm }) as never })

    expect(() => repo.setMasterPasswordSalt(Buffer.from('00112233445566778899aabbccddeeff', 'hex'))).not.toThrow()

    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(bad)
    expect(warnLines.join('\n')).toContain('salt 写 config.json 失败')
    expect(mockDb.store.get('master_password_salt')).toContain(saltB64())
  })

  it('P9 连文件内容都读不出（EPERM，改前这里 catch 后按空对象重建）⇒ 拒写、原文逐字还在、两侧各按自己的契约说话', async () => {
    const good = seedAllThree()
    const eperm = Object.assign(new Error('EPERM: permission denied, open'), { code: 'EPERM' })
    const repo = await loadRepo({
      // existsSync 仍说"在"，只有读这一发失败——正是改前那条 catch → 空对象的路径
      readFileSync: ((p: string) => {
        if (String(p) === CONFIG_PATH) throw eperm
        return readFileSync(p)
      }) as never
    })

    // 恢复包这一侧没有第二份 ⇒ 必须抛，且说的是"没读出来所以不改写"
    expect(() => repo.setRecoveryBlob('rv1:NEW')).toThrow(/本次不改写/)
    expect(readFileSync(CONFIG_PATH, 'utf8'), '不许把没读出来的键当没有').toBe(good)

    // salt 这一侧回退副本仍在 ⇒ 不抛，但要留痕，同样不许顶掉原文
    expect(() => repo.setMasterPasswordSalt(Buffer.from('00112233445566778899aabbccddeeff', 'hex'))).not.toThrow()
    expect(warnLines.join('\n')).toContain('salt 写 config.json 失败')
    expect(warnLines.join('\n')).toContain('本次不改写')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(good)
    expect(filesWith('.corrupt-'), warnLines.join(' | ')).toEqual([])
  })
})

describe('③ 原子写：临时文件＋rename，写一半不许动目标', () => {
  it('P7 临时文件写到一半抛（断电形状）⇒ 原 config.json 逐字不变、不留 .tmp-*、失败那句被说出来', async () => {
    const good = seedAllThree()
    const boom = Object.assign(new Error('EIO: simulated power loss'), { code: 'EIO' })
    const real = readFileSync
    let captured = ''
    const repo = await loadRepo({
      writeFileSync: ((p: string) => {
        captured = String(p)
        if (String(p) === CONFIG_PATH) throw new Error('写路径不该直接打目标文件：' + p)
        throw boom
      }) as never,
      readFileSync: real
    })

    repo.setKdfParams({ N: 32768, r: 8, p: 1 })

    expect(captured).not.toBe(CONFIG_PATH)
    expect(captured).toContain('.tmp-')
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(good)
    expect(filesWith('.tmp-'), warnLines.join(' | ')).toEqual([])
    expect(warnLines.join('\n')).toContain('KDF 档位写 config.json 失败')
  })

  it('P8 rename 的落点就是 config.json（证 tmp 那次写真的换了名字，而不是"永远绿"的桩）', async () => {
    seedAllThree()
    const seen: Array<[string, string]> = []
    const realRename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync
    const repo = await loadRepo({
      renameSync: ((from: string, to: string) => {
        seen.push([from, to])
        return realRename(from, to)
      }) as never
    })

    repo.setRecoveryBlob('rv1:CCCC')

    const toConfig = seen.filter(([, to]) => to === CONFIG_PATH)
    expect(toConfig.length).toBe(1)
    expect(toConfig[0]?.[0], 'rename 的来源必须是临时文件').toContain('.tmp-')
    expect(cfg().recoveryBlob).toBe('rv1:CCCC')
  })
})

describe('④ 读侧分档：没有文件／读不出／键不在，三件事三种说法', () => {
  it('R1 文件根本不存在 ⇒ null，且不许说话（"没配过"不是故障）', async () => {
    const repo = await loadRepo()
    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(repo.getRecoveryBlob()).toBeNull()
    expect(warnLines.join('\n')).toBe('')
  })

  // §369 把这把钥匙的"解析失败"那一档改成了"按字段扫出来"（它是唯一没有第二份的钥匙），
  // 本行的判语只对**有 DB 回退副本**的两把仍成立；恢复包那档的新契约见 tests/config-json-recovery-carry-369.test.ts。
  // 「三把各自的 label 逐条点得到」这一件不变，所以这一发仍要三句都在。
  it('R2 文件在而解析不出来 ⇒ salt／档位按缺失处理（各有 DB 副本），但必须说「解析失败」，且三把钥匙各自的 label 逐条点得到', async () => {
    corruptFile()
    const repo = await loadRepo()

    expect(repo.getMasterPasswordSalt()).toBeNull()
    expect(repo.getKdfParams().N).toBe(32768)
    expect(repo.getRecoveryBlob(), '§369：恢复包不再被当"没有"').toBe('rv1:AAAA')

    const all = warnLines.join('\n')
    expect(all).toContain('主密码 salt：config.json 解析失败')
    expect(all).toContain('恢复密钥包：config.json 解析失败')
    expect(all).toContain('主密码 KDF 档位：config.json 解析失败')
  })

  it('R3 文件正常而没有这个键 ⇒ null 且不警告（键缺失不该被说成读不到）', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ someOtherKey: 1 }), 'utf8')
    const repo = await loadRepo()
    expect(repo.getRecoveryBlob()).toBeNull()
    expect(warnLines.join('\n'), warnLines.join(' | ')).toBe('')
  })

  it('R4 文件在而读不出（EPERM 之类）⇒ null 且说的是"读不出"，不许与"解析失败"混成一句', async () => {
    seedAllThree()
    const eperm = Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' })
    const repo = await loadRepo({ readFileSync: (() => { throw eperm }) as never })

    expect(repo.getRecoveryBlob()).toBeNull()
    const all = warnLines.join('\n')
    expect(all).toContain('恢复密钥包：config.json 在，但读不出')
    expect(all).not.toContain('解析失败')
  })
})
