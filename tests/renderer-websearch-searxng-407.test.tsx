// @vitest-environment jsdom
// §407＝补 B227 那条挂载盲区：SearXNG 那一整支的三个新件（「实例地址」框／「允许本机/内网」那颗勾／红色风险句）
// 以前在挂载测试里**一条都没走到**——`renderer-websearch-b3` 的桩恒回 provider:'tavily'，
// `AgentToolBars.tsx:134` 那个三元分支在 jsdom 里从未进过（服务层 28 例钉的是主进程那半）。
// 这里挂真 hook ＋ 真组件，只桩 IPC，把那一支的四条禁用条件、两处同源的那句话、两条提交路径与超长预检演齐。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentToolBars } from '../src/renderer/src/modules/agent/components/AgentToolBars'
import { useAgentToolConfigs } from '../src/renderer/src/modules/agent/hooks/useAgentToolConfigs'

type WsView = {
  enabled: boolean
  provider: string
  apiKey: string
  hasKey: boolean
  searxngBaseUrl: string
  searxngAllowPrivate: boolean
  depth: string
}

const URL_PLACEHOLDER = 'http(s)://…（需自建或可信实例）'
const ALLOW_LABEL = '允许本机/内网'
const ALLOW_WARN = '仅对此地址生效：允许 Agent 访问该内网服务，存在 SSRF 风险'
const TOO_LONG = 'SearXNG 地址过长（上限 512 字符），未保存'

const setWebSearchConfig = vi.fn()

/** 主进程那半的真实形状（`websearch-config.test.ts` 已钉）＝去首尾空白与末尾斜杠后回写 */
function normalize(patch: Partial<WsView>): Partial<WsView> {
  if (typeof patch.searxngBaseUrl === 'string') {
    return { ...patch, searxngBaseUrl: patch.searxngBaseUrl.trim().replace(/\/+$/, '') }
  }
  return patch
}

function mount(over: Partial<WsView> = {}): void {
  let server: WsView = {
    enabled: true,
    provider: 'searxng',
    apiKey: '',
    hasKey: false,
    searxngBaseUrl: 'http://127.0.0.1:8080',
    searxngAllowPrivate: false,
    depth: 'auto',
    ...over
  }
  stubPocketai({
    getEncryptionStatus: () => ({
      mode: 'db', unlocked: true, dbEncrypted: true, fieldEncrypted: true,
      masterPasswordVerified: true, kdfN: 131072, kdfAtCurrentTier: true
    }),
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
    getCalendarConfig: () => ({ enabled: false, paths: [] }),
    getWebSearchConfig: () => ({ ...server }),
    setWebSearchConfig: (patch: Partial<WsView>) => {
      setWebSearchConfig(patch)
      server = { ...server, ...normalize(patch) }
      return { ...server }
    },
    setShellConfig: () => ({}),
    setCalendarConfig: () => ({}),
    pickIcsFile: () => ({ canceled: true })
  })
  const Harness: React.FC = () => {
    const tools = useAgentToolConfigs()
    return <AgentToolBars tools={tools} />
  }
  mountWithProviders(<Harness />)
}

const urlInput = (): HTMLInputElement => screen.getByPlaceholderText(URL_PLACEHOLDER) as HTMLInputElement
const urlLabel = (): HTMLElement => screen.getByText('实例地址')
const allowBox = (): HTMLInputElement =>
  (screen.getByText(ALLOW_LABEL).closest('label') as HTMLLabelElement).querySelector('input') as HTMLInputElement
/** 那颗勾头顶的 label 带 title＝同一句的第二个落点（两处同源） */
const allowLabel = (): HTMLLabelElement => screen.getByText(ALLOW_LABEL).closest('label') as HTMLLabelElement
const providerSelect = (): HTMLSelectElement =>
  (screen.getByText('服务商').parentElement as HTMLElement).querySelector('select') as HTMLSelectElement
const depthSelect = (): HTMLSelectElement =>
  (screen.getByText('搜索深度').parentElement as HTMLElement).querySelector('select') as HTMLSelectElement
const keyInput = (): HTMLInputElement => screen.getByPlaceholderText('输入 API Key') as HTMLInputElement

/** 落定一拍：用来读「不该发生第二发」那种负向句 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  setWebSearchConfig.mockClear()
})

describe('provider=SearXNG 那一支：三个新件各按各自的条件画', () => {
  it('切到 SearXNG ⇒ 长出「实例地址」框与那颗勾，且没有 API Key 那格（免 Key）', async () => {
    mount()
    await waitFor(() => expect(urlLabel()).toBeTruthy())
    expect(urlInput()).toBeTruthy()
    expect(allowBox()).toBeTruthy()
    expect(allowLabel().getAttribute('title')).toBe(ALLOW_WARN)
    expect(screen.queryByPlaceholderText('输入 API Key')).toBeNull()
    // 未勾时正文不许长出那句话（title 那半恒在，见上一条断言）
    expect(screen.queryByText(ALLOW_WARN)).toBeNull()
  })

  it('反向对照：provider=tavily ⇒ 有 API Key 那格、没有「实例地址」与那颗勾', async () => {
    mount({ provider: 'tavily', hasKey: true })
    await waitFor(() => expect(keyInput()).toBeTruthy())
    expect(screen.queryByText('实例地址')).toBeNull()
    expect(screen.queryByText(ALLOW_LABEL)).toBeNull()
  })

  it('未勾 🌐 ⇒ 地址框、那颗勾与两个下拉一律禁用（净新增能力不默认开）', async () => {
    mount({ enabled: false })
    await waitFor(() => expect(urlLabel()).toBeTruthy())
    expect(urlInput().disabled).toBe(true)
    expect(allowBox().disabled).toBe(true)
    expect(providerSelect().disabled).toBe(true)
    expect(depthSelect().disabled).toBe(true)
  })

  it('地址留空 ⇒ 那颗勾禁用；Enter 落库之后解禁', async () => {
    mount({ searxngBaseUrl: '' })
    await waitFor(() => expect(urlLabel()).toBeTruthy())
    expect(allowBox().disabled).toBe(true)

    fireEvent.change(urlInput(), { target: { value: 'http://127.0.0.1:8080' } })
    fireEvent.keyDown(urlInput(), { key: 'Enter', code: 'Enter' })
    // 到货见证＝那颗自己会变的属性（初值禁用、落库后解禁）；这里屏上没有新字长出
    await waitFor(() => expect(allowBox().disabled).toBe(false))
    expect(setWebSearchConfig).toHaveBeenCalledTimes(1)
    expect(setWebSearchConfig.mock.calls[0]?.[0]).toEqual({ searxngBaseUrl: 'http://127.0.0.1:8080' })
  })

  it('勾上那颗 ⇒ 红色风险句上屏；再取消 ⇒ 那句收回（payload 各发一次）', async () => {
    mount()
    await waitFor(() => expect(allowBox().disabled).toBe(false))

    fireEvent.click(allowBox())
    await waitFor(() => expect(screen.getByText(ALLOW_WARN)).toBeTruthy())
    expect(screen.getByText(ALLOW_WARN).className).toContain('var(--color-danger)')
    expect(setWebSearchConfig.mock.calls[0]?.[0]).toEqual({ searxngAllowPrivate: true })

    // 取消那发的到货见证＝那颗勾自己收回（checked 由回写驱动，点之前是 true）；
    // 那句话与 checked 读同一份 state ⇒ 同一帧，紧随的负向句不再需要额外落定（§364 的修法①）
    fireEvent.click(allowBox())
    await waitFor(() => expect(allowBox().checked).toBe(false))
    expect(setWebSearchConfig.mock.calls[1]?.[0]).toEqual({ searxngAllowPrivate: false })
    expect(screen.queryByText(ALLOW_WARN)).toBeNull()
    // 那句收回了，两处同源里 title 那一半照旧在（不是跟着一起消失）
    expect(allowLabel().getAttribute('title')).toBe(ALLOW_WARN)
  })

  it('Enter 与失焦各提交一发；同值再 Enter 不重发；屏上回落成后端规整那一版', async () => {
    mount({ searxngBaseUrl: '' })
    await waitFor(() => expect(urlLabel()).toBeTruthy())

    fireEvent.change(urlInput(), { target: { value: '  http://127.0.0.1:8080/  ' } })
    fireEvent.keyDown(urlInput(), { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(screen.getByDisplayValue('http://127.0.0.1:8080')).toBeTruthy())
    expect(setWebSearchConfig).toHaveBeenCalledTimes(1)
    expect(setWebSearchConfig.mock.calls[0]?.[0]).toEqual({ searxngBaseUrl: 'http://127.0.0.1:8080/' })

    // 同值（规整后相等）再 Enter ⇒ 不该追第二发
    fireEvent.keyDown(urlInput(), { key: 'Enter', code: 'Enter' })
    await settle()
    expect(setWebSearchConfig).toHaveBeenCalledTimes(1)

    // 换值走失焦那条路 ⇒ 第二发到货
    fireEvent.change(urlInput(), { target: { value: 'http://127.0.0.1:8081' } })
    fireEvent.blur(urlInput())
    await waitFor(() => expect(screen.getByDisplayValue('http://127.0.0.1:8081')).toBeTruthy())
    expect(setWebSearchConfig).toHaveBeenCalledTimes(2)

    // 失焦那条路也一样：同值再失焦不该追第三发（Enter 与 onBlur 是两条独立的守卫）
    fireEvent.blur(urlInput())
    await settle()
    expect(setWebSearchConfig).toHaveBeenCalledTimes(2)
  })

  it('组字态那次 Enter 不提交；同一颗框非组字时照发（正向对照，证明负向不是空枪）', async () => {
    mount({ searxngBaseUrl: '' })
    await waitFor(() => expect(urlLabel()).toBeTruthy())
    expect(allowBox().disabled).toBe(true)

    fireEvent.change(urlInput(), { target: { value: 'http://127.0.0.1:8090' } })
    fireEvent.keyDown(urlInput(), { key: 'Enter', code: 'Enter', isComposing: true })
    await settle()
    expect(setWebSearchConfig).not.toHaveBeenCalled()
    expect(urlInput().value).toBe('http://127.0.0.1:8090')

    fireEvent.keyDown(urlInput(), { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(allowBox().disabled).toBe(false))
    expect(setWebSearchConfig).toHaveBeenCalledTimes(1)
  })

  it('地址超过 512 字符 ⇒ 说一句、不发那一发、也不清掉刚粘进去的草稿', async () => {
    mount({ searxngBaseUrl: '' })
    await waitFor(() => expect(urlLabel()).toBeTruthy())

    const tooLong = `http://${'a'.repeat(600)}`
    fireEvent.change(urlInput(), { target: { value: tooLong } })
    fireEvent.blur(urlInput())
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(TOO_LONG))
    expect(setWebSearchConfig).not.toHaveBeenCalled()
    expect(urlInput().value).toBe(tooLong)
  })

  it('切走 provider ⇒ 那两样消失、API Key 那格回来（不许留着第二份脸）', async () => {
    mount()
    await waitFor(() => expect(urlLabel()).toBeTruthy())

    fireEvent.change(providerSelect(), { target: { value: 'tavily' } })
    await waitFor(() => expect(keyInput()).toBeTruthy())
    expect(setWebSearchConfig).toHaveBeenCalledWith({ provider: 'tavily' })
    expect(screen.queryByText('实例地址')).toBeNull()
    expect(screen.queryByText(ALLOW_LABEL)).toBeNull()
  })
})
