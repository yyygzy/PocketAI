// §385：换字段密钥时"把 WebDAV 备份口令一起搬过去"收成一对出口（capture → 换钥 → restore）
//
// 起点＝§383 候选 ④ 的回读：四处轮换点各有一份逐字副本，而**第五发整个漏了**——
// boot 里「首次设置主密码」那一支（`src/main/index.ts` 的 `setPassword`）只搬字段凭据快照、
// 没搬 app_config 里那一行 ⇒ 那一次换钥把备份口令留在旧固定密钥下＝从此真解不开
// （用户路径：禁用加密 → 再在解锁窗首次设密码）。
// 本文件钉这一对出口的四件事：
//   ①capture 分得开三档（没配过／解得开／解不开），且**解不开时不交回那串密文**（改前的形状会把它当明文带回）
//   ②restore 只写"解得开的那一份"，写完在新密钥下真的解得回来；不写时一个字节都不动
//   ③反向对照：只换钥不 restore＝旧缺陷形状 ⇒ 那份口令当场判死（证明这一对出口确实在救它）
//   ④顺序是判据：capture 排在换钥之后 ⇒ 它只能报"解不开"＝同样救不回来
// 策略：真加密真解密（换字段密钥造"解不开"），只桩开库与配置仓。
// @vitest-environment node
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
    // 每次现读：本文件的用例就是把 fieldKey 换掉来造"换钥"
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
  captureWebDAVForRekey,
  restoreWebDAVAfterRekey,
  loadWebDAVConfig,
  readWebDAVConfig,
  saveWebDAVConfig
} from '../src/main/backup/backup-service'

const PW = 'real-dav-password-42'
const BASE = {
  url: 'https://dav.example.com/remote.php/dav/files/me',
  username: 'me',
  passwordCipher: PW,
  directory: 'pocketai'
}
const ROW = 'webdav_config'
const rawRow = (): string => H.store.get(ROW) ?? ''

beforeEach(() => {
  H.store.clear()
  H.writes = []
  H.fieldKey = KEY_OLD
})

describe('① capture 分得开三档，解不开时不交回那串密文', () => {
  it('没配过 ⇒ cfg 为 null、undecryptable 为 false（两档不是一回事，但都不必重写）', () => {
    expect(captureWebDAVForRekey()).toEqual({ cfg: null, undecryptable: false })
  })

  it('解得开 ⇒ 交回的是**明文**那一份（restore 才有东西可写）', () => {
    saveWebDAVConfig(BASE)
    const t = captureWebDAVForRekey()
    expect(t.undecryptable).toBe(false)
    expect(t.cfg!.passwordCipher, '这一串已经是明文').toBe(PW)
  })

  it('解不开 ⇒ undecryptable 为 true，且 cfg 为 null（改前的形状会把旧钥密文当明文带回＝回写一次就判死）', () => {
    saveWebDAVConfig(BASE)
    H.fieldKey = KEY_NEW // 换钥而那一行没跟着重写（§323 那种半状态）
    const t = captureWebDAVForRekey()
    expect(t.undecryptable).toBe(true)
    expect(t.cfg, '解不开的那一份不许进回写').toBe(null)
  })

  it('历史明文那一档不冤枉成解不开，交回的原样可用', () => {
    H.store.set(ROW, JSON.stringify({ ...BASE, passwordCipher: 'legacy-plain' }))
    const t = captureWebDAVForRekey()
    expect(t.undecryptable).toBe(false)
    expect(t.cfg!.passwordCipher).toBe('legacy-plain')
  })
})

describe('② restore 只写该写的，且写完真的解得回来', () => {
  it('解得开那一份：换钥后 restore ⇒ 新密钥下仍解回原口令、flag false（＝它跟着换了钥）', () => {
    saveWebDAVConfig(BASE)
    const t = captureWebDAVForRekey()
    H.fieldKey = KEY_NEW // ← 换钥
    expect(restoreWebDAVAfterRekey(t)).toBe(true)
    expect(loadWebDAVConfig()!.passwordCipher, '这一份在新密钥下可用').toBe(PW)
    expect(readWebDAVConfig().passwordUndecryptable).toBe(false)
  })

  it('解不开那一份：restore 一个字节都不写，返回值如实说"没写"（不许演成"已处理"）', () => {
    saveWebDAVConfig(BASE)
    H.fieldKey = KEY_NEW
    const t = captureWebDAVForRekey()
    const before = rawRow()
    H.writes = [] // 只清"写痕"，那一行留在原处
    expect(restoreWebDAVAfterRekey(t)).toBe(false)
    expect(H.writes, '解不开＝不写').toEqual([])
    expect(rawRow(), '旧钥密文原地保留（没被当明文回写＝没被判死）').toBe(before)
  })

  it('没配过：restore 不写、返回 false（没有东西可搬，也不算失败）', () => {
    expect(restoreWebDAVAfterRekey(captureWebDAVForRekey())).toBe(false)
    expect(H.writes).toEqual([])
  })
})

describe('③ 反向对照：不走这一对出口＝第五发的旧缺陷形状', () => {
  it('只换钥、不 restore ⇒ 那份口令当场判死（屏上从此说"解不开"，而用户没做错任何事）', () => {
    saveWebDAVConfig(BASE)
    H.fieldKey = KEY_NEW // boot 首次设密码只做了这一步＋字段凭据快照，没搬这一行
    expect(readWebDAVConfig().passwordUndecryptable, '这就是 §385 要收掉的那一格').toBe(true)
    expect(loadWebDAVConfig()!.passwordCipher.startsWith('v1:'), '带回来的是密文原文＝鉴权必败').toBe(true)
  })

  it('顺序反了（capture 排在换钥之后）＝同样救不回来：它只能报"解不开"', () => {
    saveWebDAVConfig(BASE)
    H.fieldKey = KEY_NEW
    const late = captureWebDAVForRekey()
    expect(late.undecryptable, '旧钥密文在新钥下就是解不开，晚读一步就再也拿不到明文').toBe(true)
    expect(restoreWebDAVAfterRekey(late)).toBe(false)
    expect(readWebDAVConfig().passwordUndecryptable).toBe(true)
  })
})
