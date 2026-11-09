// V4-Iter-204：B104 真机①抓到的漏点——主发送链写成 `.then((r) => { void r })`，
// safeHandle 的 `{ok:false}` 于是被咽掉：预算硬阻断时聊天页一条提示也没有、转圈不消失，
// 而 196 那条文件级闸门因为 regenerate/resend 带着 guard 照样全绿。
// 这里按**行为**钉住两个入口（回码文案／划词浮窗；Agent hook 那一半随 P4 批次 2 删壳退场），
// 源码区域的逐点核对在 ipc-failure-visible-196.test.ts。
// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { PopupApp } from '../src/renderer/src/popup/PopupApp'
import { chatSendFailureText } from '../src/renderer/src/utils/ipc'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

// main 侧抛的原始串（assertBudget 的中文尾段），界面只许拿回码换四语。
// v56：回码第三段带**本轮估算所用的币种**，渲染层据此选符号（不再写死 ¥）。
const RAW_DAILY = 'BUDGET_EXCEEDED:daily:0.5:CNY:已达到今日预算上限 ¥0.5'
const BLOCKED_DAILY = zh['usage.budgetBlocked']
  .replace('{scope}', zh['usage.budgetDaily'])
  .replace('{symbol}', '¥')
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
    const s = chatSendFailureText('BUDGET_EXCEEDED:monthly:88.00:CNY:已达到本月预算上限 ¥88.00', dictT)
    expect(s).toContain(zh['usage.budgetMonthly'])
    expect(s).toContain('¥88.00')
  })

  it('币种换成 USD 后符号跟回码走：金额仍是 88.00，但不再挂 ¥（v56 接口/账本口径对齐）', () => {
    const s = chatSendFailureText('BUDGET_EXCEEDED:monthly:88.00:USD:已达到本月预算上限 $88.00', dictT)
    expect(s).toContain('$88.00')
    expect(s).not.toContain('¥')
    expect(s).not.toContain('$¥')
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

  it('软预警 toast 的符号也跟事件币种走（源码门禁：主进程带 currency、渲染端不写死 ¥）', () => {
    const bw = fs.readFileSync(path.resolve(__dirname, '../src/main/usage/budget-warn.ts'), 'utf-8')
    expect(bw).toMatch(/currency:\s*pricing\.currency/)
    const listener = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/src/hooks/BudgetWarningListener.tsx'),
      'utf-8'
    )
    expect(listener).toMatch(/symbol:\s*currencySymbolOf\(e\.currency\)/)
    expect(listener).not.toMatch(/symbol:\s*'¥'/)
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
