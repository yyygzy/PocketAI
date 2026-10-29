// @vitest-environment jsdom
// 渠道凭据的 B3 显式确认（SEC-1 收口：无人值守依赖不拦写入，但新凭据要用户承认）
//
// 断言的是「确认前不得落库」这条时序，以及两个边界：
// - db 模式不该多弹一次（无谓摩擦）；
// - 「清除凭据」不算新写入，也不该弹。
// 顺带钉住取消路径保留草稿——面板保存失败时最怕把用户刚贴的 Token 吞掉。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ChannelConfig, ChannelType } from '../src/shared/types'
import { mountWithProviders, stubPocketai, pocketaiCalls, calledFns } from './helpers/renderer'
import { ChannelsPanel } from '../src/renderer/src/modules/agent/channels/ChannelsPanel'
import { isUnprotectedMode } from '../src/renderer/src/utils/secret-consent'

const WARN =
  '当前未设置主密码：这条凭据只会用源码中公开的固定密钥做本地混淆，拿到本机数据目录的人可以还原。确认仍要保存？'

function fakeCfg(type: ChannelType, hasSecret = false): ChannelConfig {
  return {
    type,
    enabled: false,
    hasPrimarySecret: hasSecret,
    hasSecondarySecret: false,
    appId: '',
    whitelist: '',
    assistantId: '',
    providerId: '',
    model: '',
    agentMode: false
  }
}

const setChannelConfig = vi.fn()

function mount(mode: 'none' | 'db', hasSecret = false): void {
  stubPocketai({
    getEncryptionStatus: () => ({
      mode, unlocked: true, dbEncrypted: mode === 'db', fieldEncrypted: true,
      masterPasswordVerified: mode === 'db', kdfN: mode === 'db' ? 131072 : null, kdfAtCurrentTier: mode === 'db'
    }),
    getChannelConfig: (type: unknown) => fakeCfg(type as ChannelType, hasSecret),
    listChannelStatus: () => ({}),
    onChannelStatus: () => () => {},
    listProviders: () => [],
    listAssistants: () => [],
    startChannel: () => ({ ok: true }),
    stopChannel: () => ({ ok: true }),
    setChannelConfig: (type: unknown, patch: { primarySecret?: string }) => {
      setChannelConfig(type, patch)
      return Promise.resolve({ ...fakeCfg(type as ChannelType, true) })
    }
  })
  mountWithProviders(<ChannelsPanel />)
}

const tokenInput = (): HTMLInputElement =>
  screen.getByPlaceholderText('粘贴 Bot Token（形如 123456:ABC-xxx）') as HTMLInputElement

async function submitToken(value: string): Promise<void> {
  fireEvent.change(tokenInput(), { target: { value } })
  fireEvent.blur(tokenInput())
  await waitFor(() => expect(screen.queryByText(WARN)).toBeTruthy())
}

beforeEach(() => {
  setChannelConfig.mockClear()
})

describe('isUnprotectedMode（B3 的判定入口）', () => {
  it('none → true，db → false', async () => {
    mount('none')
    expect(await isUnprotectedMode()).toBe(true)
  })

  it('读状态失败时不打扰（返回 false）', async () => {
    stubPocketai({
      getEncryptionStatus: () => {
        throw new Error('locked')
      }
    })
    expect(await isUnprotectedMode()).toBe(false)
  })
})

describe('渠道凭据保存前的一次承认', () => {
  it('确认前不落库；点确认后写入一次', async () => {
    mount('none')
    await submitToken('123456:ABC-secret-token')
    expect(setChannelConfig).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => expect(setChannelConfig).toHaveBeenCalledTimes(1))
    expect(setChannelConfig.mock.calls[0]?.[1]).toEqual({ primarySecret: '123456:ABC-secret-token' })
  })

  it('取消则不写入，且草稿保留供重试', async () => {
    mount('none')
    await submitToken('123456:ABC-keep-me')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText(WARN)).toBeNull())
    expect(setChannelConfig).not.toHaveBeenCalled()
    expect(tokenInput().value).toBe('123456:ABC-keep-me')
  })

  it('已设主密码（db 模式）不多弹一次确认', async () => {
    mount('db')
    fireEvent.change(tokenInput(), { target: { value: '123456:ABC-ok' } })
    fireEvent.blur(tokenInput())
    await waitFor(() => expect(setChannelConfig).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(WARN)).toBeNull()
  })

  it('清除已存凭据不算新写入：不弹确认', async () => {
    mount('none', true)
    await waitFor(() => expect(tokenInput()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '清除' }))
    await waitFor(() => expect(setChannelConfig).toHaveBeenCalledTimes(1))
    expect(setChannelConfig.mock.calls[0]?.[1]).toEqual({ primarySecret: '' })
    expect(screen.queryByText(WARN)).toBeNull()
  })

  it('只改白名单等非凭据字段 → 不弹确认', async () => {
    mount('none')
    const whitelist = screen.getByPlaceholderText('如 ou_xxx, ou_yyy') as HTMLInputElement
    fireEvent.change(whitelist, { target: { value: '111' } })
    fireEvent.blur(whitelist)
    await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'setChannelConfig')).toBe(true))
    expect(screen.queryByText(WARN)).toBeNull()
    expect(calledFns()).toContain('setChannelConfig')
  })
})
