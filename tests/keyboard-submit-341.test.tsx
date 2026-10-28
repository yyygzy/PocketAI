// @vitest-environment jsdom
// V4-Iter-341 行为面：口令框那 12 处的键盘提交路径
//
// §340 把 isComposing 铺到了 21 个自由文本框，另 12 处（type 含 password／number）当时判为「未判定」。
// 本批用真 Electron＋CDP 判掉了（见台账）：password 与 number 格里 compositionstart 照发、
// 组字中那次 keydown 的 isComposing 也是 true，锁屏那一格连按八次组字 Enter 会把 SEC-10 限流器打满。
// 这里补上真挂载的那一条：组字不许提交、真 Enter 照常提交（成对，理由同 §340）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { LockOverlay } from '../src/renderer/src/components/LockOverlay'

function mount(onUnlock = vi.fn()) {
  stubPocketai()
  mountWithProviders(
    <LockOverlay dbEncrypted encKnown encPending={false} pwd="" onPwdChange={() => {}} onUnlock={onUnlock} />
  )
  const box = document.querySelector('input[type=password]') as HTMLElement
  return { onUnlock, box }
}

describe('锁屏解锁框：组字 Enter 不提交、真 Enter 提交', () => {
  beforeEach(() => vi.clearAllMocks())

  it('输入法还在组字时按 Enter ⇒ 一次都不发（发出去就是一串半截拼音，还会吃掉一次限流额度）', () => {
    const { onUnlock, box } = mount()
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', isComposing: true })
    expect(onUnlock, '组字那次的 Enter 不许提交').not.toHaveBeenCalled()
  })

  it('反向对照：组字结束后的普通 Enter 照常提交（守卫不许把解锁这条路一起挡掉）', () => {
    const { onUnlock, box } = mount()
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' })
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })
})
