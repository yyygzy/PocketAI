// @vitest-environment jsdom
// 锁屏遮罩的双模式呈现（SEC-31）
//
// 这条文案在 App.tsx 与 DetachedApp.tsx 两处重复时改漏过一次，抽成 LockOverlay 后
// 只测这一份；断言的是「有没有向用户暗示锁定=受保护」：
// - db 模式：要口令、按钮是「解锁」、副标题才是那句「隐私保护已激活」；
// - none 模式：没有口令可输（主进程 LOCK_UNLOCK 本就忽略 password），
//   副标题必须说清「只是界面遮挡、不需要任何凭据」，按钮也不能写成需要凭据的样子。
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { LockOverlay } from '../src/renderer/src/components/LockOverlay'

function mount(dbEncrypted: boolean, onUnlock = vi.fn()) {
  stubPocketai()
  mountWithProviders(
    <LockOverlay dbEncrypted={dbEncrypted} pwd="" onPwdChange={() => {}} onUnlock={onUnlock} />
  )
  return onUnlock
}

describe('锁屏遮罩文案（SEC-31）', () => {
  it('db 模式：要主密码，按钮是「解锁」', () => {
    mount(true)
    expect(screen.getByPlaceholderText('输入主密码解锁')).toBeTruthy()
    expect(screen.getByText('解锁')).toBeTruthy()
    expect(screen.getByText('墨匣隐私保护已激活')).toBeTruthy()
    expect(screen.queryByText(/只是界面遮挡/)).toBeNull()
  })

  it('none 模式：没有口令输入，且明说只是界面遮挡', () => {
    mount(false)
    expect(screen.queryByPlaceholderText('输入主密码解锁')).toBeNull()
    expect(screen.getByText(/只是界面遮挡/)).toBeTruthy()
    expect(screen.getByText('继续（无需密码）')).toBeTruthy()
    expect(screen.queryByText('墨匣隐私保护已激活')).toBeNull()
  })

  it('none 模式点按钮仍走同一个解锁回调（不因为没口令就假称已保护）', () => {
    const onUnlock = mount(false)
    fireEvent.click(screen.getByText('继续（无需密码）'))
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('db 模式下回车等价于点解锁，错误信息按传入原样显示', () => {
    const onUnlock = mount(true)
    const input = screen.getByPlaceholderText('输入主密码解锁')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUnlock).toHaveBeenCalledTimes(1)
    mountWithProviders(
      <LockOverlay dbEncrypted pwd="" onPwdChange={() => {}} error="密码错误" onUnlock={() => {}} />
    )
    expect(screen.getByText('密码错误')).toBeTruthy()
  })
})
