// 解锁页的认证退避（B14 / SEC-10 的 UI 那一半）
//
// 限流器本身早有单测（auth-ratelimit：阈值、指数退避、30s 上限、两桶独立），
// 但**退避在界面上到底长什么样**一直没被测过：清单 B14 要求人连输 5 次去看倒计时。
// 这里把 UI 侧钉住，B14 剩下的就只有"真机上眼看过一次"这一件事。
//
// 三条要紧的语义：① 主进程返回里带 retryAfterMs 才进倒计时（普通错密码不该被锁）；
// ② 倒计时期间提交按钮 disabled 且**不再发请求**（否则用户可以继续撞，退避形同虚设）；
// ③ 重启解锁窗后仍按主进程的锁定态显示（否则重开一个窗就绕过了）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { stubPocketai, mountWithProviders, pocketaiCalls } from './helpers/renderer'
import { UnlockPage } from '../src/renderer/src/modules/unlock/UnlockPage'
import { zh } from '../src/renderer/src/i18n/zh'

interface LockState {
  unlock?: { retryAfterMs?: number }
  recover?: { retryAfterMs?: number }
}

function mount(lock: LockState = {}, unlockResults: Array<{ ok: boolean; error?: string; retryAfterMs?: number }> = []) {
  let i = 0
  stubPocketai({
    getAuthLockState: () => ({ unlock: { retryAfterMs: 0 }, recover: { retryAfterMs: 0 }, ...lock }),
    unlockEncryption: () => unlockResults[Math.min(i++, unlockResults.length - 1)] ?? { ok: false, error: '密码不正确' },
    setMasterPassword: () => ({ ok: true }),
    recoverWithCode: () => ({ ok: true }),
    saveRecoveryFile: () => ({ ok: true }),
    copySensitiveToClipboard: () => ({ ok: true })
  })
  return mountWithProviders(<UnlockPage />)
}

function submitButton(): HTMLButtonElement {
  return screen.getByText(zh['unlock.btn']) as HTMLButtonElement
}

function typePwd(container: HTMLElement, value: string): void {
  const input = container.querySelector('input[type="password"]') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
}

beforeEach(() => localStorage.clear())

describe('解锁页退避倒计时', () => {
  it('普通错密码（无 retryAfterMs）：只报错，按钮仍可点', async () => {
    const { container } = mount({}, [{ ok: false, error: '主密码不正确' }])
    typePwd(container, 'wrong')
    fireEvent.click(submitButton())
    await waitFor(() => expect(screen.getByText('主密码不正确')).toBeTruthy())
    expect(submitButton().disabled).toBe(false)
    expect(submitButton().textContent).toBe(zh['unlock.btn'])
  })

  it('命中限流（retryAfterMs=3000）：按钮换成倒计时文案并禁用，再点不再发请求', async () => {
    const { container } = mount(
      {},
      [
        { ok: false, error: '主密码不正确' },
        { ok: false, error: '尝试过于频繁', retryAfterMs: 3000 }
      ]
    )
    typePwd(container, 'wrong')
    fireEvent.click(submitButton())
    await waitFor(() => expect(screen.getByText('主密码不正确')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['unlock.btn']) as HTMLButtonElement)
    const btn = (await waitFor(() => {
      const b = screen.getByText(zh['unlock.tooManyAttempts'].replace('{s}', '3'))
      return b as HTMLButtonElement
    })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    // 倒计时期间再点两次：一次都不该再打到主进程
    const before = pocketaiCallsCount('unlockEncryption')
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(pocketaiCallsCount('unlockEncryption')).toBe(before)
  })

  it('重开解锁窗仍按主进程锁定态显示（不能靠重开窗口绕过退避）', async () => {
    mount({ unlock: { retryAfterMs: 5000 } })
    await waitFor(() =>
      expect((screen.getByText(zh['unlock.tooManyAttempts'].replace('{s}', '5')) as HTMLButtonElement).disabled).toBe(true)
    )
    expect(screen.queryByText(zh['unlock.btn'])).toBeNull()
  })

  it('两个桶相互独立：解锁未锁、恢复码已锁时，切到恢复模式才进倒计时', async () => {
    mount({ unlock: { retryAfterMs: 0 }, recover: { retryAfterMs: 8000 } })
    await waitFor(() => expect(submitButton().disabled).toBe(false))
    fireEvent.click(screen.getByText(zh['unlock.useRecovery']))
    await waitFor(() =>
      expect((screen.getByText(zh['unlock.tooManyAttempts'].replace('{s}', '8')) as HTMLButtonElement).disabled).toBe(true)
    )
  })

  it('倒计时归零后自动恢复可点（不用重开窗口）', async () => {
    const { container } = mount({}, [{ ok: false, error: '尝试过于频繁', retryAfterMs: 400 }])
    typePwd(container, 'wrong')
    fireEvent.click(submitButton())
    await waitFor(() =>
      expect((screen.getByText(zh['unlock.tooManyAttempts'].replace('{s}', '1')) as HTMLButtonElement).disabled).toBe(true)
    )
    await waitFor(() => expect(screen.getByText(zh['unlock.btn'])).toBeTruthy(), { timeout: 3000 })
    expect((screen.getByText(zh['unlock.btn']) as HTMLButtonElement).disabled).toBe(false)
  })
})
function pocketaiCallsCount(fn: string): number {
  return pocketaiCalls().filter((c) => c.fn === fn).length
}
