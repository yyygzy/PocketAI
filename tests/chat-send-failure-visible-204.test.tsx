// V4-Iter-204：B104 真机①抓到的漏点——主发送链写成 `.then((r) => { void r })`，
// safeHandle 的 `{ok:false}` 于是被咽掉：预算硬阻断时聊天页一条提示也没有、转圈不消失，
// 而 196 那条文件级闸门因为 regenerate/resend 带着 guard 照样全绿。
// 这里按**行为**钉住三个入口（回码文案／Agent hook／划词浮窗），源码区域的逐点核对在 ipc-failure-visible-196.test.ts。
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { act, renderHook } from '@testing-library/react'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import { PopupApp } from '../src/renderer/src/popup/PopupApp'
import { chatSendFailureText } from '../src/renderer/src/utils/ipc'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import type { AssistantRecord, ConversationRecord, ProviderRecord } from '../src/shared/types'

// main 侧抛的原始串（assertBudget 的中文尾段），界面只许拿回码换四语
const RAW_DAILY = 'BUDGET_EXCEEDED:daily:0.5:已达到今日预算上限 ¥0.5'
const BLOCKED_DAILY = zh['usage.budgetBlocked']
  .replace('{scope}', zh['usage.budgetDaily'])
  .replace('{limit}', '0.5')

const dictT = (key: string, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (s, [k, v]) => s.replace(`{${k}}`, String(v)),
    (zh as unknown as Record<string, string>)[key] ?? key
  )

beforeAll(() => {
  // jsdom 不实现 Element.scrollTo（真实 Chromium 有），浮窗挂载时会自动滚到底 ⇒ 补个空实现。
  // 滚动本身不是这里要证的东西。
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('回码 → 界面文案（全项目只翻译这一次）', () => {
  it('daily 换成「每日预算」那句，且 main 的中文尾段不进界面', () => {
    expect(chatSendFailureText(RAW_DAILY, dictT)).toBe(BLOCKED_DAILY)
    expect(chatSendFailureText(RAW_DAILY, dictT)).not.toContain('已达到今日预算上限')
  })

  it('monthly 走「每月预算」，limit 原样带过去', () => {
    const s = chatSendFailureText('BUDGET_EXCEEDED:monthly:88.00:已达到本月预算上限 ¥88.00', dictT)
    expect(s).toContain(zh['usage.budgetMonthly'])
    expect(s).toContain('88.00')
  })

  it('登记过的回码换四语，冒号后的中文说明不进界面（V4-Iter-206）', () => {
    expect(chatSendFailureText('CHAT_NO_TARGET:未选择模型', dictT)).toBe(zh['chat.errNoTarget'])
    expect(chatSendFailureText('CHAT_MSG_NOT_ASSISTANT:消息不存在或非助手消息', dictT)).toBe(zh['chat.errMsgNotAssistant'])
    expect(chatSendFailureText('CHAT_MSG_NOT_USER:消息不存在或非用户消息', dictT)).toBe(zh['chat.errMsgNotUser'])
    expect(chatSendFailureText('CHAT_NO_TARGET:未选择模型', dictT)).not.toContain('未选择模型')
  })

  it('没登记的（provider／网络报错）原样透出——把普通报错咽成空串是不允许的', () => {
    const raw = '请求失败: connect ECONNREFUSED 127.0.0.1:11434'
    expect(chatSendFailureText(raw, dictT)).toBe(raw)
  })

  it('四语把 scope 拼进 budgetBlocked 后不许出现叠词（真机露出过「已达到每日预算预算上限」）', () => {
    const dicts: Array<[string, Record<string, string>]> = [['zh', zh], ['en', en], ['ja', ja], ['ko', ko]]
    for (const [name, d] of dicts) {
      for (const key of ['usage.budgetDaily', 'usage.budgetMonthly']) {
        const scope = d[key]!
        const s = d['usage.budgetBlocked']!.replace('{scope}', scope).replace('{limit}', '1')
        // 叠词判据：scope 结尾那个词（汉字取末两字、拉丁取末一个词）不许紧挨着自己再来一遍
        const tail = /[A-Za-z]+$/.exec(scope)?.[0] ?? scope.slice(-2)
        expect(s.replace(/\s+/g, '').toLowerCase(), `${name}/${key} ⇒ ${s}`).not.toContain((tail + tail).toLowerCase())
      }
    }
  })
})

describe('Agent 页发起失败：运行态停下 ＋ toast 给文案', () => {
  const PROVIDERS = [
    { id: 'p1', name: 'P', type: 'openai', enabled: true, models: ['m1'] }
  ] as unknown as ProviderRecord[]
  const ASSISTANTS = [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]
  const CONV_RECORD = { id: 'c1', assistantId: 'a1', title: 't', modelLabel: null } as unknown as ConversationRecord

  let sendReturn: () => unknown = () => ({ ok: true })

  beforeEach(() => {
    sendReturn = () => ({ ok: true })
    stubPocketai({
      getUiPrefs: () => ({ ok: true, data: {} }),
      setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
      listConversations: () => [CONV_RECORD],
      listMessages: () => [],
      getLatestRunStats: () => null,
      getSessionStats: () => null,
      getAgentTextProtocol: () => [],
      // §234：模型栏那颗「上下文窗口」挂载要读这张表（桩给空表=没有一台设过）
      getModelContextWindows: () => ({}),
      setModelContextWindow: () => ({ windows: {} }),
      sendMessage: () => sendReturn(),
      abortAgent: () => ({ ok: true }),
      onAgentStep: () => () => {},
      onAgentChunk: () => () => {},
      onAgentDone: () => () => {},
      onAgentError: () => () => {},
      onConversationTitle: () => () => {}
    })
  })

  async function mountAndSend(): Promise<{ current: ReturnType<typeof useAgentChat> }> {
    const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
    act(() => result.current.setAssistantId('a1'))
    await waitFor(() => expect(result.current.conversationId).toBe('c1'))
    act(() => result.current.changeProvider('p1'))
    act(() => result.current.setModel('m1'))
    await act(async () => {
      void result.current.send('你好', [])
    })
    return result
  }

  it('{ok:false} 带预算回码 ⇒ running 复位，toast 是专门文案', async () => {
    sendReturn = () => ({ ok: false, error: RAW_DAILY })
    const result = await mountAndSend()
    expect(result.current.running).toBe(false)
    expect(screen.getByText(BLOCKED_DAILY)).toBeTruthy()
  })

  it('反向对照：{ok:true} 时运行态保持、一条 toast 也不弹', async () => {
    const result = await mountAndSend()
    expect(result.current.running).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('浮动 promise 那两条入口（resume／截断重跑）也接得住：同一条收口', async () => {
    sendReturn = () => ({ ok: false, error: 'CHAT_NO_TARGET:未选择模型' })
    const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
    act(() => result.current.setAssistantId('a1'))
    await waitFor(() => expect(result.current.conversationId).toBe('c1'))
    act(() => result.current.changeProvider('p1'))
    act(() => result.current.setModel('m1'))
    // resume 内部就是 send(...)，且调用方写的是 void chat.resume()
    await act(async () => {
      void result.current.resume()
    })
    expect(result.current.running).toBe(false)
    expect(screen.getByText(zh['chat.errNoTarget'])).toBeTruthy()
    expect(screen.queryByText('CHAT_NO_TARGET')).toBeNull()
  })
})

describe('划词／快捷浮窗：裸 promise 留下的空气泡现在有出口', () => {
  let popupSend: () => unknown = () => ({ ok: true })

  beforeEach(() => {
    localStorage.clear()
    popupSend = () => ({ ok: true })
    stubPocketai({
      listProviders: () => [{ id: 'p1', name: 'P', type: 'openai', enabled: true, models: ['m1'] }],
      listAssistants: () => [{ id: 'a1', name: '通用问答', isBuiltin: true }],
      getPopupPayload: () => null,
      onPopupPayload: () => () => {},
      onChatChunk: () => () => {},
      onChatDone: () => () => {},
      onChatError: () => () => {},
      createConversation: () => ({ id: 'cv1' }),
      sendMessage: () => popupSend(),
      abortChat: () => ({ ok: true }),
      hidePopup: () => ({ ok: true })
    })
  })

  async function sendFromPopup(): Promise<void> {
    mountWithProviders(<PopupApp />)
    const ta = await screen.findByPlaceholderText(zh['popup.inputPlaceholder'])
    fireEvent.change(ta, { target: { value: '你好' } })
    fireEvent.click(screen.getByText(zh['popup.send']))
  }

  it('预算硬阻断：气泡换成专门文案，且发送按钮回来（不再显示「停止」）', async () => {
    popupSend = () => ({ ok: false, error: RAW_DAILY })
    await sendFromPopup()
    expect(await screen.findByText(BLOCKED_DAILY)).toBeTruthy()
    expect(screen.queryByText(zh['popup.stop'])).toBeNull()
  })

  it('反向对照：成功返回 {ok:true} ⇒ 仍在生成中（出现「停止」，没有错误气泡）', async () => {
    await sendFromPopup()
    expect(await screen.findByText(zh['popup.stop'])).toBeTruthy()
    expect(screen.queryByText(BLOCKED_DAILY)).toBeNull()
  })
})
