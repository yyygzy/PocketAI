// @vitest-environment jsdom
// 渠道凭据在 none 模式下的写入闸（SEC-1：从「渲染层确认」升级为主进程硬拒）
//
// 主进程侧由 channel-config 自己判（见 tests/channel-websearch-none-gate.test.ts）；
// 这里钉的是渲染层同口径：新凭据一个字节都不发出去，省一次必败往返，且**不清草稿**。
// 两个边界必须保持放行（它们不新增密钥材料）：
// - db 模式（有主密码）照常保存，不多一次摩擦；
// - 「清除凭据」与只改非凭据字段照常写入。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ChannelConfig, ChannelType } from '../src/shared/types'
import { mountWithProviders, stubPocketai, pocketaiCalls, calledFns } from './helpers/renderer'
import { ChannelsPanel } from '../src/renderer/src/modules/agent/channels/ChannelsPanel'
import { isUnprotectedMode } from '../src/renderer/src/utils/secret-consent'

const BLOCKED =
  '未设置主密码，这条凭据不会被保存。请先在「设置 → 数据与安全」中设置主密码后重试；已有凭据仍可读取或删除。'

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

beforeEach(() => {
  setChannelConfig.mockClear()
})

describe('isUnprotectedMode（写入闸的判定入口）', () => {
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

describe('渠道凭据在 none 模式下不落库', () => {
  it('新 Token 不发给主进程，给出指路文案，草稿保留', async () => {
    mount('none')
    fireEvent.change(tokenInput(), { target: { value: '123456:ABC-secret-token' } })
    fireEvent.blur(tokenInput())
    await waitFor(() => expect(screen.queryByText(BLOCKED)).toBeTruthy())
    expect(setChannelConfig).not.toHaveBeenCalled()
    expect(tokenInput().value).toBe('123456:ABC-secret-token')
  })

  it('已设主密码（db 模式）照常保存，不出现拦截文案', async () => {
    mount('db')
    fireEvent.change(tokenInput(), { target: { value: '123456:ABC-ok' } })
    fireEvent.blur(tokenInput())
    await waitFor(() => expect(setChannelConfig).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(BLOCKED)).toBeNull()
  })

  it('清除已存凭据不算新增：none 模式下仍可写入', async () => {
    mount('none', true)
    await waitFor(() => expect(tokenInput()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '清除' }))
    await waitFor(() => expect(setChannelConfig).toHaveBeenCalledTimes(1))
    expect(setChannelConfig.mock.calls[0]?.[1]).toEqual({ primarySecret: '' })
    expect(screen.queryByText(BLOCKED)).toBeNull()
  })

  it('只改白名单等非凭据字段 → 照常写入', async () => {
    mount('none')
    const whitelist = screen.getByPlaceholderText('如 ou_xxx, ou_yyy') as HTMLInputElement
    fireEvent.change(whitelist, { target: { value: '111' } })
    fireEvent.blur(whitelist)
    await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'setChannelConfig')).toBe(true))
    expect(screen.queryByText(BLOCKED)).toBeNull()
    expect(calledFns()).toContain('setChannelConfig')
  })
})
