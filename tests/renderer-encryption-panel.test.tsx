// @vitest-environment jsdom
// 渲染层组件用例：加密面板的状态显示与新设口令闸门（SEC-1 B2 / SEC-32①②）
//
// 覆盖过去只能在应用里目视的三件事：
// 1) none 模式不得让人误以为「已加密」（警示块 + 字段行说实话 + 不显示密钥派生行）；
// 2) 「密钥派生」行按落盘档位显示，且旧库要给出去升档的指引（{tier} 插值真的被替换）；
// 3) 新设主密码少于 10 位时在本地就拦住，**不发 IPC**；够了才发。
import { describe, it, expect } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import { EncryptionPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import type { EncryptionStatus } from '../src/shared/types'

const none: EncryptionStatus = {
  mode: 'none', unlocked: true, dbEncrypted: false, fieldEncrypted: true,
  masterPasswordVerified: true, kdfN: null, kdfAtCurrentTier: false
}
const dbAt = (n: number): EncryptionStatus => ({
  mode: 'db', unlocked: false, dbEncrypted: true, fieldEncrypted: true,
  masterPasswordVerified: true, kdfN: n, kdfAtCurrentTier: n >= 131072
})

function mount(enc: EncryptionStatus) {
  stubPocketai({
    getLockStatus: () => ({ state: 'unlocked', autoLockTimeout: 0 }),
    setAutoLockTimeout: () => ({ ok: true }),
    enableEncryption: () => ({ ok: true })
  })
  mountWithProviders(<EncryptionPanel enc={enc} onChange={() => {}} />)
}

describe('none 模式的诚实呈现（SEC-1 B2）', () => {
  it('显示明文警示，字段行不说「已加密」', () => {
    mount(none)
    expect(screen.getByText(/不是安全边界/)).toBeTruthy()
    expect(screen.getByText(/仅本地混淆/)).toBeTruthy()
    expect(screen.queryByText(/透明（AES-256-GCM）/)).toBeNull()
  })

  it('不显示密钥派生行（无主密码就谈不上主密钥派生档位）', () => {
    mount(none)
    expect(screen.queryByText(/scrypt N=/)).toBeNull()
  })
})

describe('密钥派生档位行（SEC-32②）', () => {
  it('现行档：显示 N=2^17 且不出现升档指引', () => {
    mount(dbAt(131072))
    expect(screen.getByText(/scrypt N=2\^17 r=8 p=1/)).toBeTruthy()
    expect(screen.queryByText(/改一次主密码即自动升/)).toBeNull()
  })

  it('历史档：显示 N=2^15 并给出升档指引', () => {
    mount(dbAt(32768))
    expect(screen.getByText(/scrypt N=2\^15 r=8 p=1/)).toBeTruthy()
    expect(screen.getByText(/改一次主密码即自动升/)).toBeTruthy()
  })
})

describe('新设主密码下限（SEC-32①）', () => {
  function openForm() {
    mount(none)
    fireEvent.click(screen.getByText('🔐 启用加密'))
    const inputs = document.querySelectorAll('input[type=password]')
    return inputs
  }

  it('9 位在本地被拦下，不发 enableEncryption', () => {
    const inputs = openForm()
    fireEvent.change(inputs[0]!, { target: { value: '123456789' } })
    fireEvent.change(inputs[1]!, { target: { value: '123456789' } })
    fireEvent.click(screen.getByText('确认'))
    expect(screen.getByText('密码至少 10 位')).toBeTruthy()
    expect(calledFns()).not.toContain('enableEncryption')
  })

  it('10 位则提交一次', async () => {
    const inputs = openForm()
    fireEvent.change(inputs[0]!, { target: { value: '1234567890' } })
    fireEvent.change(inputs[1]!, { target: { value: '1234567890' } })
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(calledFns()).toContain('enableEncryption'))
  })
})
