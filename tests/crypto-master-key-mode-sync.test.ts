// V4-Iter-195：密钥管理器的状态同步（用**真** master-key 与真 field-encrypt，不 mock 加密本身）
//
// 钉住两条审计确认的缺陷不再回来：
//  · 禁用加密时 `init('none')` 必须清掉 masterKey——否则 getFieldKey() 继续返回旧主密钥，
//    restoreFieldCredentials 就用旧密钥重加密落盘，而下次启动是按固定密钥解的 ⇒ 凭据全体变空。
//  · commitNewMasterKeyState 必须把内存里的 mode 定成 db——否则 isNoneMode() 仍判明文：
//    当场存新 API Key 被 B1 拒、隐私锁不清密钥。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  dialog: { showErrorBox: () => {} },
  ipcMain: { handle: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))
vi.mock('../src/main/db/database', () => ({ dbService: { isOpen: () => false, getHandle: () => ({ prepare: () => ({ get: () => 1 }) }) } }))

const cfg = vi.hoisted(() => ({ salt: null as Buffer | null, kdf: null as unknown, writes: [] as string[] }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: () => undefined,
    set: () => {},
    getKdfParams: () => cfg.kdf ?? { N: 32768, r: 8, p: 1 },
    setMasterPasswordSalt: (b: Buffer) => { cfg.salt = b; cfg.writes.push('salt') },
    setKdfParams: (k: unknown) => { cfg.kdf = k; cfg.writes.push('kdf') }
  }
}))

import { KDF_LEGACY } from '../src/main/crypto/index'
import { masterKeyManager } from '../src/main/crypto/master-key'
import { commitNewMasterKeyState, prepareNewMasterKey } from '../src/main/crypto/master-password'
import { decryptSecret, encryptSecret } from '../src/main/crypto/field-encrypt'

const PW = 'a-long-master-passphrase'

beforeEach(() => {
  masterKeyManager.init('none')
  masterKeyManager.clear()
  masterKeyManager.init('none')
})

describe('禁用加密那一趟的密钥切换', () => {
  it('init(none) 之后 getFieldKey 不再是旧主密钥 ⇒ 密文下次启动仍解得开', () => {
    masterKeyManager.setKey(PW, randomBytes(16), KDF_LEGACY)
    const sealed = encryptSecret('sk-real-looking-api-key')
    // 主密钥态下能解开
    expect(decryptSecret(sealed)).toBe('sk-real-looking-api-key')

    // 库里已经 rekey 成明文 ⇒ 禁用流程走 init('none')（195 之前它不清 masterKey）
    masterKeyManager.init('none')
    expect(masterKeyManager.isDbEncrypted()).toBe(false)
    // 关键一步：重加密发生在"这一趟会话"里，此时管理器状态就是 init 之后的样子
    const resealed = encryptSecret('sk-real-looking-api-key')
    // 模拟重启后的新进程：内存里从来没有旧主密钥，只有固定密钥 ⇒ 上面落盘的密文必须解得开
    masterKeyManager.clear()
    masterKeyManager.init('none')
    expect(decryptSecret(resealed)).toBe('sk-real-looking-api-key')
  })

  it('反面对照：拿旧主密钥加密的密文，在固定密钥下必然 fail-closed 成空串', () => {
    masterKeyManager.setKey(PW, randomBytes(16), KDF_LEGACY)
    const withMaster = encryptSecret('topsecret')
    // 手工把 masterKey 清掉（等价于"下次启动的明文模式"），旧密文就该读不出东西
    masterKeyManager.clear()
    masterKeyManager.init('none')
    expect(decryptSecret(withMaster)).toBe('')
  })
})

describe('启用加密后的模式同步', () => {
  it('commitNewMasterKeyState 把 mode 定成 db（带 key 时才同步）', () => {
    expect(masterKeyManager.getMode()).toBe('none')
    commitNewMasterKeyState(prepareNewMasterKey(PW))
    expect(masterKeyManager.getMode()).toBe('db')
    expect(masterKeyManager.isDbEncrypted()).toBe(true)
    // salt 与档位仍是成对落盘（SEC-33 那条不变量没被这次同步削弱）
    expect(cfg.writes).toEqual(['salt', 'kdf'])
    expect(cfg.salt).not.toBeNull()
  })
})
