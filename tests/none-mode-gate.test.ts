// none 模式新密钥写入闸的判定单元测试（SEC-1 方案 B2）
//
// 钉住判定口径：按**值**而非按键名识别新密钥材料，
// 于是「只改名称/命令」「改键名不改值」「删键」都放行，「新增键值 / 改写值」才拦。
// 拒绝文案只出现键名，绝不回显值。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ mode: 'none' as 'none' | 'db' }))
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getMode: () => mocks.mode }
}))

import {
  isNoneMode,
  newSecretKeys,
  noneModeSecretBlock,
  NONE_MODE_HINT
} from '../src/main/crypto/none-mode-gate'
import { maskSecretMap, restoreMaskedMap } from '../src/shared/secret-mask'

describe('newSecretKeys：按值识别新密钥', () => {
  it('新增键值 → 命中键名', () => {
    expect(newSecretKeys({ API_KEY: 'sk-new' }, {})).toEqual(['API_KEY'])
  })

  it('原样回填（值未变）→ 不命中', () => {
    expect(newSecretKeys({ API_KEY: 'sk-old' }, { API_KEY: 'sk-old' })).toEqual([])
  })

  it('换键名不换值 → 不命中（不是新密钥材料）', () => {
    expect(newSecretKeys({ TOKEN_V2: 'sk-old' }, { TOKEN: 'sk-old' })).toEqual([])
  })

  it('改写值 → 命中', () => {
    expect(newSecretKeys({ TOKEN: 'sk-rotate' }, { TOKEN: 'sk-old' })).toEqual(['TOKEN'])
  })

  it('空值不算密钥；删掉的键不算新增', () => {
    expect(newSecretKeys({ EMPTY: '', OTHER: 'x' }, {})).toEqual(['OTHER'])
    expect(newSecretKeys({}, { GONE: 'x' })).toEqual([])
  })

  it('掩码往返后不产生新密钥（表单只改名称的保存路径）', () => {
    const stored = { API_KEY: 'sk-secret-abcdef' }
    const incoming = { ...maskSecretMap(stored), TIMEOUT: '30' }
    const restored = restoreMaskedMap(incoming, stored)
    // 非密钥的普通环境变量照常写入
    expect(newSecretKeys(restored, stored)).toEqual(['TIMEOUT'])
    // 掩码回填的那一项不算新密钥
    expect(newSecretKeys({ API_KEY: restored.API_KEY ?? '' }, stored)).toEqual([])
  })
})

describe('noneModeSecretBlock：模式闸门与文案', () => {
  beforeEach(() => {
    mocks.mode = 'none'
  })

  it('none 模式有新密钥 → 拒绝，列出字段与键名', () => {
    const msg = noneModeSecretBlock([
      { field: 'env', next: { API_KEY: 'sk-new' }, existing: {} },
      { field: 'headers', next: { Authorization: 'Bearer x' }, existing: {} }
    ])
    expect(msg).toContain('env：API_KEY')
    expect(msg).toContain('headers：Authorization')
    expect(msg).toContain(NONE_MODE_HINT)
  })

  it('拒绝文案不回显密钥值', () => {
    const msg = noneModeSecretBlock([{ field: 'env', next: { API_KEY: 'sk-super-secret' } }])
    expect(msg).not.toContain('sk-super-secret')
  })

  it('无新密钥 → 放行', () => {
    expect(
      noneModeSecretBlock([{ field: 'env', next: { A: 'same' }, existing: { A: 'same' } }])
    ).toBeNull()
  })

  it('db 模式即使全是新密钥也放行（真实密钥保护下正常写入）', () => {
    mocks.mode = 'db'
    expect(isNoneMode()).toBe(false)
    expect(noneModeSecretBlock([{ field: 'env', next: { A: 'brand-new' } }])).toBeNull()
  })
})
