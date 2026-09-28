// credential-rotation 字段级凭据轮换伴生工具测试
//
// 覆盖主密码切换（none↔db / 改密）时的凭据快照导出与恢复：
// - exportFieldCredentials 组合 KV secrets + Provider apiKeys 两路来源
// - restoreFieldCredentials 按原路转发恢复
// - 导出→恢复往返数据一致
//
// 策略：vi.mock secret-store 与 providerRepo 两个底层依赖，
// 验证组合转发逻辑（模块本身不含加密逻辑，加密由底层负责）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  exportSecrets: vi.fn(),
  restoreSecrets: vi.fn(),
  exportAllApiKeys: vi.fn(),
  restoreAllApiKeys: vi.fn()
}))

vi.mock('../src/main/crypto/secret-store', () => ({
  exportSecrets: mocks.exportSecrets,
  restoreSecrets: mocks.restoreSecrets
}))

vi.mock('../src/main/db/repositories/provider.repo', () => ({
  providerRepo: {
    exportAllApiKeys: mocks.exportAllApiKeys,
    restoreAllApiKeys: mocks.restoreAllApiKeys
  }
}))

import {
  exportFieldCredentials,
  restoreFieldCredentials,
  type FieldCredentialSnapshot
} from '../src/main/crypto/credential-rotation'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('exportFieldCredentials — 快照导出', () => {
  it('组合 KV secrets 与 Provider apiKeys 两路来源', () => {
    mocks.exportSecrets.mockReturnValue({ webdavPassword: 'enc:xxx' })
    mocks.exportAllApiKeys.mockReturnValue({ 'prov-1': ['sk-a', 'sk-b'] })

    const snapshot = exportFieldCredentials()

    expect(snapshot).toEqual({
      kv: { webdavPassword: 'enc:xxx' },
      providers: { 'prov-1': ['sk-a', 'sk-b'] }
    })
    expect(mocks.exportSecrets).toHaveBeenCalledTimes(1)
    expect(mocks.exportAllApiKeys).toHaveBeenCalledTimes(1)
  })

  it('无任何凭据时返回空快照', () => {
    mocks.exportSecrets.mockReturnValue({})
    mocks.exportAllApiKeys.mockReturnValue({})

    const snapshot = exportFieldCredentials()

    expect(snapshot).toEqual({ kv: {}, providers: {} })
  })
})

describe('restoreFieldCredentials — 快照恢复', () => {
  it('按原路转发：kv → restoreSecrets、providers → restoreAllApiKeys', () => {
    const snapshot: FieldCredentialSnapshot = {
      kv: { webdavPassword: 'enc:yyy' },
      providers: { 'prov-2': ['sk-c'] }
    }

    restoreFieldCredentials(snapshot)

    expect(mocks.restoreSecrets).toHaveBeenCalledWith({ webdavPassword: 'enc:yyy' })
    expect(mocks.restoreAllApiKeys).toHaveBeenCalledWith({ 'prov-2': ['sk-c'] })
  })

  it('空快照也正常转发（空对象恢复语义由底层决定）', () => {
    restoreFieldCredentials({ kv: {}, providers: {} })

    expect(mocks.restoreSecrets).toHaveBeenCalledWith({})
    expect(mocks.restoreAllApiKeys).toHaveBeenCalledWith({})
  })
})

describe('导出 → 恢复往返', () => {
  it('restore 收到的数据与 export 产出的快照完全一致', () => {
    const kv = { webdavPassword: 'enc:round-trip', telegramToken: 'enc:tt' }
    const providers = { 'prov-a': ['sk-1'], 'prov-b': ['sk-2', 'sk-3'] }
    mocks.exportSecrets.mockReturnValue(kv)
    mocks.exportAllApiKeys.mockReturnValue(providers)

    const snapshot = exportFieldCredentials()
    restoreFieldCredentials(snapshot)

    expect(mocks.restoreSecrets).toHaveBeenCalledWith(kv)
    expect(mocks.restoreAllApiKeys).toHaveBeenCalledWith(providers)
  })
})
