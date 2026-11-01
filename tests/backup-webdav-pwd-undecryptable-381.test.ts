// §381：WebDAV 备份口令的「有密文却解不开」那一档（＝§375 那一族的第四张快照）
//
// 缺陷形状（探针实测）：`loadWebDAVConfig` 用 `decryptApiKeys(...).length > 0` 判「解没解开」，
// 解不开时**把原始密文原样带回**（非空＝看着像明文），于是四个密钥轮换点
// （`encryption.ts` 改密／启用／禁用／恢复码）把旧钥密文当明文回写，
// 而 `saveWebDAVConfig` 的幂等防护又原样保留密文 ⇒ 那份口令在新密钥下永久解不开，
// 屏上「已配置」＋掩码末 4 位照旧，只有下一次备份会在鉴权那一步失败。
//
// 策略：真加密真解密（换字段密钥来造「解不开」，GCM tag 自己会拒），只桩开库与配置仓。
//
// §384 对本文件的改判（两处期望值翻转，各自注释里写了理由）：`isCipherText` 不再只看前缀、
// save 的幂等防护改吃调用方的意图声明 ⇒ ①的「假阳钉子（二）」与②的第一发不再是"原样落盘/字节不变"。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const KEY_OLD = Buffer.alloc(32, 0x11)
const KEY_NEW = Buffer.alloc(32, 0x22)

const H = vi.hoisted(() => ({
  fieldKey: Buffer.alloc(32, 0x11),
  store: new Map<string, string>(),
  writes: [] as string[]
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    // 这颗必须每次现读：本文件的用例就是把 fieldKey 换掉来造「解不开」
    getFieldKey: () => H.fieldKey,
    getDbKey: () => null,
    isDbEncrypted: () => true,
    hasKey: () => true
  }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => H.store.get(k) ?? null,
    set: (k: string, v: string) => { H.store.set(k, v); H.writes.push(k) },
    delete: (k: string) => { H.store.delete(k) }
  },
  clearAppConfigCache: () => {}
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))
vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({ pragma: () => [] }) } }))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '' }))
vi.mock('../src/main/backup/webdav-client', () => ({
  testConnection: async () => ({ ok: true }),
  uploadBuffer: async () => {},
  downloadFile: async () => Buffer.alloc(0),
  listFiles: async () => [],
  deleteFile: async () => {},
  remoteExists: async () => 'absent',
  uploadRemoteBuffer: async () => {},
  downloadRemoteFile: async () => Buffer.alloc(0)
}))

import {
  loadWebDAVConfig,
  readWebDAVConfig,
  saveWebDAVConfig,
  restoreWebDAVPassword,
  maskWebDAVConfig
} from '../src/main/backup/backup-service'
import { encryptApiKeys } from '../src/main/crypto/field-encrypt'

const PW = 'real-dav-password-42'
const BASE = {
  url: 'https://dav.example.com/remote.php/dav/files/me',
  username: 'me',
  passwordCipher: PW,
  directory: 'pocketai'
}
const rawRow = (): string => H.store.get('webdav_config')!

beforeEach(() => {
  H.store.clear()
  H.writes = []
  H.fieldKey = KEY_OLD
})

describe('①三种到货要分得开：没配过／解得开／解不开', () => {
  it('没配过 ⇒ load 回 null，判据说"不是解不开"，掩码视图也是 null', () => {
    expect(loadWebDAVConfig()).toBe(null)
    // §386 改形状：契约多了第三颗（那一行存在却读不出来）；这一档仍是"没配过"＝两颗都 false
    expect(readWebDAVConfig()).toEqual({ cfg: null, passwordUndecryptable: false, configUnreadable: false })
    expect(maskWebDAVConfig(readWebDAVConfig())).toBe(null)
  })

  it('配过、密钥对得上 ⇒ load 回明文，判据 false，掩码视图带 false（反向对照：别把正常那档也请出第三态）', () => {
    saveWebDAVConfig(BASE)
    expect(loadWebDAVConfig()!.passwordCipher).toBe(PW)
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
    expect(maskWebDAVConfig(readWebDAVConfig())!.passwordUndecryptable).toBe(false)
  })

  it('有密文却解不开 ⇒ load 仍是非 null（这就是病灶），判据 true，掩码视图把 true 带出去', () => {
    saveWebDAVConfig(BASE)
    H.fieldKey = KEY_NEW // 字段密钥换掉、这一行没跟着重写（§323 那种半状态）
    const read = readWebDAVConfig()
    expect(read.cfg, '「解不开」不等于「没配过」：这一发必须仍是非 null').not.toBe(null)
    expect(read.cfg!.passwordCipher.startsWith('v1:'), '解不开时带回来的是原始密文').toBe(true)
    expect(read.passwordUndecryptable).toBe(true)
    const masked = maskWebDAVConfig(read)
    expect(masked!.passwordUndecryptable).toBe(true)
  })

  it('历史明文那档不冤枉成「解不开」（hasUndecryptableCipher 的前提是它是密文）', () => {
    H.store.set('webdav_config', JSON.stringify({ ...BASE, passwordCipher: 'legacy-plain' }))
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
    expect(loadWebDAVConfig()!.passwordCipher).toBe('legacy-plain')
  })

  it('口令是空串（真没填）⇒ 也不冤枉成「解不开」', () => {
    H.store.set('webdav_config', JSON.stringify({ ...BASE, passwordCipher: '' }))
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
  })

  it('假阳钉子（一）：那一列确实是**信封**、里面装的口令恰好以 v1: 开头 ⇒ 不许报成「解不开」', () => {
    // 判据必须排在"把密文覆盖成明文"之前：覆盖之后再判＝拿明文当密文试第二遍（本枚自查撞出的那格）。
    // 这一形怎么来的：早期版本没有 save 的幂等防护，密文可以再套一层，于是出现过这种双重信封。
    const LOOKALIKE = 'v1:look-alike-password'
    H.store.set('webdav_config', JSON.stringify({ ...BASE, passwordCipher: encryptApiKeys([LOOKALIKE]) }))
    expect(loadWebDAVConfig()!.passwordCipher, '先证明这一份确实解得开、拿回来的就是那串明文').toBe(LOOKALIKE)
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
    expect(maskWebDAVConfig(readWebDAVConfig())!.passwordUndecryptable).toBe(false)
  })

  it('假阳钉子（二）＝§384 改判：明文直接以 v1: 开头时，save 不再猜形状 ⇒ 把它当明文包进信封、读回原口令、不报「解不开」', () => {
    // 改前这一发是 SEC-35/36 那族既有歧义的现场（isCipherText 只看前缀 ⇒ 分不出"密文"与"恰好像密文的明文"）：
    // 那串明文被原样落盘，从此读侧叫它「解不开」，屏上那格说"要重填"，而重填同一句还是原样落盘＝出不去的循环。
    // §384 起写侧不再猜：调用方没声明"这串就是库里那份密文原文"⇒ 一律当明文加密。
    const LOOKALIKE = 'v1:look-alike-password'
    saveWebDAVConfig({ ...BASE, passwordCipher: LOOKALIKE })
    expect(rawRow(), '这一列现在被包进了信封（不再原样落盘）').not.toContain(LOOKALIKE)
    expect(rawRow().startsWith('{"url"'), '落盘的仍是那行 JSON').toBe(true)
    expect(loadWebDAVConfig()!.passwordCipher, '口令本身进出一致＝鉴权照常').toBe(LOOKALIKE)
    expect(readWebDAVConfig().passwordUndecryptable, '§384 起它不再被叫成「解不开」').toBe(false)
  })

  it('反向对照（§384）：声明了「这串就是库里那份密文原文」才原样保留＝双重加密那一格仍然守得住', () => {
    const real = encryptApiKeys([PW])
    saveWebDAVConfig({ ...BASE, passwordCipher: real }, { passwordAlreadyCipher: true })
    expect(rawRow(), '原样保留、绝不二次加密').toContain(real)
    expect(loadWebDAVConfig()!.passwordCipher).toBe(PW)
    // 而同一串若不声明就交进来 ⇒ 会被当明文再包一层（这正是"只有调用方知道意图"的代价，所以必须声明）
    saveWebDAVConfig({ ...BASE, passwordCipher: real })
    expect(loadWebDAVConfig()!.passwordCipher, '不声明＝当明文加密，解出来是那串密文而不是口令').toBe(real)
  })
})

describe('②回写那条路：解不开的那一份绝不能当明文写回去', () => {
  it('不声明意图就把 load 的结果交给 save ⇒ 那一列被重写成双层信封（＝§381 四处轮换点必须先判的原因）', () => {
    saveWebDAVConfig(BASE)
    H.fieldKey = KEY_NEW
    const before = rawRow()
    const stale = loadWebDAVConfig()! // 解不开时带回来的是旧钥密文原文
    saveWebDAVConfig(stale) // ← 改前那四个轮换点做的正是这件事（以为 cfg.passwordCipher 是明文）
    expect(rawRow(), '§384 起这一发不再"原样保留"，而是被当明文再包一层').not.toBe(before)
    expect(loadWebDAVConfig()!.passwordCipher, '绕一圈拿回来的是那串密文＝当口令必败').toBe(stale.passwordCipher)
    expect(readWebDAVConfig().passwordUndecryptable, '屏上从此看不出问题（新信封解得开）＝misuse 的代价').toBe(false)
  })

  it('同一份走掩码回填那一路＝带回那颗 flag、save 原样保留（handler 的实际形状，屏上仍如实说「解不开」）', () => {
    saveWebDAVConfig(BASE)
    H.fieldKey = KEY_NEW
    const before = rawRow()
    const restored = restoreWebDAVPassword({ ...BASE, passwordCipher: '••••d-42' })!
    expect(restored.passwordIsStoredCipher, '解不开那一份必须由回填那一步说成密文').toBe(true)
    saveWebDAVConfig(restored.cfg, { passwordAlreadyCipher: restored.passwordIsStoredCipher })
    expect(rawRow(), '原样保留＝没有把旧钥密文再包一层').toBe(before)
    expect(readWebDAVConfig().passwordUndecryptable, '这一档仍然如实上报').toBe(true)
  })

  it('解得开那一份走同一条路＝换新密钥重加密，换钥后仍能解开（正向对照：轮换本身是有效的）', () => {
    saveWebDAVConfig(BASE)
    const cfg = loadWebDAVConfig()!
    H.fieldKey = KEY_NEW // 密钥已换
    cfg.passwordCipher = PW // 轮换点用先前捕获的明文重写
    saveWebDAVConfig(cfg)
    expect(loadWebDAVConfig()!.passwordCipher).toBe(PW)
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
  })

  it('走判据分支（解不开＝不进回写）时，这一行一次写都没有 ⇒ 不产生「看着做了其实没做」的落盘', () => {
    saveWebDAVConfig(BASE)
    H.store.clear()
    H.writes = []
    saveWebDAVConfig(BASE) // 建好一份
    H.writes = []
    H.fieldKey = KEY_NEW
    const read = readWebDAVConfig()
    // 轮换点的形状（encryption.ts 四处同构）：先判、解不开就不碰这一行
    if (read.passwordUndecryptable) {
      /* skip */
    } else if (read.cfg) {
      read.cfg.passwordCipher = PW
      saveWebDAVConfig(read.cfg)
    }
    expect(H.writes, '解不开那一档不该有任何一次写入').toEqual([])
  })
})

describe('③出 IPC 的掩码视图', () => {
  it('三种到货都只露 `••••`＋末 4 位，明文口令与整串密文都不许出去', () => {
    saveWebDAVConfig(BASE)
    const okMasked = maskWebDAVConfig(readWebDAVConfig())!
    expect(okMasked.passwordCipher.startsWith('••••'), okMasked.passwordCipher).toBe(true)
    expect(okMasked.passwordCipher).not.toContain(PW.slice(0, -4))

    H.fieldKey = KEY_NEW
    const badMasked = maskWebDAVConfig(readWebDAVConfig())!
    expect(badMasked.passwordCipher.startsWith('••••'), badMasked.passwordCipher).toBe(true)
    expect(badMasked.passwordCipher).not.toContain('v1:')
    expect(JSON.stringify(badMasked)).not.toContain(PW)
  })

  it('url／username／directory 照旧带出（解不开不代表这份配置读不出来）', () => {
    saveWebDAVConfig(BASE)
    H.fieldKey = KEY_NEW
    const m = maskWebDAVConfig(readWebDAVConfig())!
    expect(m.url).toBe(BASE.url)
    expect(m.username).toBe(BASE.username)
    expect(m.directory).toBe(BASE.directory)
  })
})
