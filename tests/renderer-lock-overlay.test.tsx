// @vitest-environment jsdom
// 锁屏遮罩的双模式呈现（SEC-31）
//
// 这条文案在 App.tsx 与 DetachedApp.tsx 两处重复时改漏过一次，抽成 LockOverlay 后
// 只测这一份；断言的是「有没有向用户暗示锁定=受保护」：
// - db 模式：要口令、按钮是「解锁」、副标题才是那句「隐私保护已激活」；
// §343 起这里测的是三种脸而非两种：加密态「还在确认」与「读不到」都不许演成 none 模式那句
// 「未设主密码：数据仍是明文…不需要任何凭据」——那一格是启动即锁定时最容易演错的地方
// - none 模式：没有口令可输（主进程 LOCK_UNLOCK 本就忽略 password），
//   副标题必须说清「只是界面遮挡、不需要任何凭据」，按钮也不能写成需要凭据的样子。
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { LockOverlay } from '../src/renderer/src/components/LockOverlay'

function mount(
  dbEncrypted: boolean,
  onUnlock = vi.fn(),
  flags: { encKnown?: boolean; encPending?: boolean; encErr?: string | null } = {}
) {
  stubPocketai()
  mountWithProviders(
    <LockOverlay
      dbEncrypted={dbEncrypted}
      encKnown={flags.encKnown ?? true}
      encPending={flags.encPending ?? false}
      encErr={flags.encErr ?? null}
      pwd=""
      onPwdChange={() => {}}
      onUnlock={onUnlock}
    />
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
      <LockOverlay dbEncrypted encKnown encPending={false} pwd="" onPwdChange={() => {}} error="密码错误" onUnlock={() => {}} />
    )
    expect(screen.getByText('密码错误')).toBeTruthy()
  })
})

describe('加密态还没读回来时的三种脸（V4-Iter-343）', () => {
  it('读还在飞：不说「明文」也不说「已激活」，不给口令框，按钮是「处理中…」且点不动', () => {
    const onUnlock = mount(false, vi.fn(), { encKnown: false, encPending: true })
    expect(screen.queryByPlaceholderText('输入主密码解锁')).toBeNull()
    expect(screen.queryByText(/只是界面遮挡/)).toBeNull()
    expect(screen.queryByText('墨匣隐私保护已激活')).toBeNull()
    const btn = screen.getByText('处理中…')
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(btn)
    expect(onUnlock, '确认中不许提交（空口令会白吃一发限流失败计数）').not.toHaveBeenCalled()
  })

  it('读不到：中性那句带上原因，仍然给口令框（按「可能设过主密码」处理），按钮不许写成「继续（无需密码）」', () => {
    mount(false, vi.fn(), { encKnown: false, encPending: false, encErr: 'boom' })
    expect(screen.getByText(/加密状态读不到：boom/)).toBeTruthy()
    expect(screen.queryByText(/只是界面遮挡/)).toBeNull()
    expect(screen.queryByText('继续（无需密码）')).toBeNull()
    expect(screen.getByPlaceholderText('输入主密码解锁')).toBeTruthy()
    expect(screen.getByText('解锁')).toBeTruthy()
  })

  it('反向对照：确认过「没设主密码」时，SEC-31 那两句照旧要说（新面不许把已知态一起吞掉）', () => {
    mount(false, vi.fn(), { encKnown: true, encPending: false })
    expect(screen.getByText(/只是界面遮挡/)).toBeTruthy()
    expect(screen.getByText('继续（无需密码）')).toBeTruthy()
    expect(screen.queryByText(/加密状态读不到/)).toBeNull()
  })
})
