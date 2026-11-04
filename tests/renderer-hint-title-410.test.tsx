// @vitest-environment jsdom
// §410＝把 §409 真机撞出的那档缺陷钉进 CI：行内说明挂在 `truncate` 上⇒尾巴被裁、且没 title 可补回。
//
// 先说清这枚能证到哪一步：jsdom 不做布局，**"到底裁没裁"这半仍然只有真机量得出**（`scrollWidth` vs `clientWidth`）。
// 本文件钉的是搬得进 CI 的那半＝结构三样：
//   ① 那两句所在 span 的类名里不再出现 `truncate`（交回给 `flex-wrap` 换行）；
//   ② 每句都带 `title`，且 `title` 与正文**逐字相等**（改前＝正文有、title 没＝悬停也补不回）；
//   ③ 状态换脸（关掉那颗勾／切服务商／选 deep／日历加没加文件）时 title 跟着正文一起换，不许留旧句。
// 同屏那条仍带 `truncate` 的旧形状（终端命令那一行）当**正向对照**留着：它一直有 title＝减罪一档，本枚判为不动。
import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
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
type CalView = { enabled: boolean; paths: string[] }

const HINT_TAVILY = 'Agent 可调用 web_search 获取实时网页结果；Key 仅存本机，需到服务商官网注册获取'
const HINT_OFF = '未启用：Agent 无法联网检索实时信息'
const HINT_SEARXNG_EMPTY = '需自建或可信 SearXNG 实例；留空表示未配置'
const HINT_SEARXNG_URL = 'Agent 可调用 web_search 查询该 SearXNG 实例；地址仅存本机，请确认实例可信'
const DEEP_TAIL = '深度模式并行扩展 3 路检索并补读前 3 条正文，耗时更长、更耗配额'
// 选 deep 时追加的是**整条三档说明**（逐字取 `agent.websearch.depthHint`，不是只追加 DEEP_TAIL 那半句）
const DEPTH_HINT_FULL =
  '自动＝由模型自行选择深度（缺省快速）；快速/深度＝强制覆盖模型选择。' + DEEP_TAIL
const CAL_NO_FILE = '已启用但未添加日历文件：点击「添加 .ics」选择文件'
const CAL_OFF = '未启用：Agent 无法读取日程安排'
const SHELL_OFF = '关闭中：Agent 无法执行 shell 命令'
const URL_PLACEHOLDER = 'http(s)://…（需自建或可信实例）'

let wsServer: WsView
let calServer: CalView

function mount(): void {
  wsServer = {
    enabled: true,
    provider: 'tavily',
    apiKey: '',
    hasKey: false,
    searxngBaseUrl: '',
    searxngAllowPrivate: false,
    depth: 'auto'
  }
  calServer = { enabled: true, paths: [] }
  stubPocketai({
    getEncryptionStatus: () => ({
      mode: 'db', unlocked: true, dbEncrypted: true, fieldEncrypted: true,
      masterPasswordVerified: true, kdfN: 131072, kdfAtCurrentTier: true
    }),
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
    getCalendarConfig: () => ({ ...calServer }),
    getWebSearchConfig: () => ({ ...wsServer }),
    setWebSearchConfig: (patch: Partial<WsView>) => {
      wsServer = { ...wsServer, ...patch }
      return { ...wsServer }
    },
    setCalendarConfig: (patch: Partial<CalView>) => {
      calServer = { ...calServer, ...patch }
      return { ...calServer }
    },
    setShellConfig: () => ({}),
    pickIcsFile: () => ({ canceled: true })
  })
  const Harness: React.FC = () => <AgentToolBars tools={useAgentToolConfigs()} />
  mountWithProviders(<Harness />)
}

/** 按屏上那句正文取承载它的 span（`findByText`＝自己会等到到货；不靠行号也不靠 nth-child＝改排版不会假绿） */
async function hintSpan(text: string | RegExp): Promise<HTMLElement> {
  const el = await screen.findByText(text)
  const span = el.closest('span')
  if (!span) throw new Error('那句说明不在 span 里＝取法要跟着改')
  return span as HTMLElement
}

beforeEach(() => mount())

describe('§410 行内说明不再被 truncate 裁，且 title 与正文同源', () => {
  it('联网搜索那一行（Tavily 那脸）：类名里没有 truncate，title 逐字等于正文', async () => {
    const el = await hintSpan(HINT_TAVILY)
    expect(el.className, '类名里又出现 truncate＝尾巴又要被裁').not.toContain('truncate')
    expect(el.getAttribute('title'), 'title 与正文同源').toBe(HINT_TAVILY)
  })

  it('关掉 🌐 那颗勾：句子换成「未启用」，title 跟着换（不许留上一张脸的全文）', async () => {
    const el = await hintSpan(HINT_TAVILY)
    fireEvent.click(screen.getByRole('checkbox', { name: /联网搜索/ }))
    await waitFor(() => expect(el.textContent).toBe(HINT_OFF))
    expect(el.getAttribute('title')).toBe(HINT_OFF)
    expect(el.className).not.toContain('truncate')
  })

  it('切到 SearXNG＝地址为空与填好两种脸各自同源（被裁看不见的那半句「请确认实例可信」必须在 title 里）', async () => {
    await hintSpan(HINT_TAVILY)
    fireEvent.change(screen.getByRole('combobox', { name: /服务商/ }), { target: { value: 'searxng' } })
    const empty = await hintSpan(HINT_SEARXNG_EMPTY)
    expect(empty.getAttribute('title')).toBe(HINT_SEARXNG_EMPTY)

    const input = screen.getByPlaceholderText(URL_PLACEHOLDER)
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:8080' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const filled = await hintSpan(HINT_SEARXNG_URL)
    expect(filled.getAttribute('title')).toBe(HINT_SEARXNG_URL)
    expect(filled.className).not.toContain('truncate')
  })

  it('选 deep 时追加的那半句进同一颗 title（改前＝正文拼了、悬停没这份）', async () => {
    await hintSpan(HINT_TAVILY)
    fireEvent.change(screen.getByRole('combobox', { name: /搜索深度/ }), { target: { value: 'deep' } })
    const grown = await hintSpan(new RegExp(DEEP_TAIL))
    expect(grown.getAttribute('title'), 'title 必须就是正文那份整句').toBe(grown.textContent)
    expect(grown.getAttribute('title'), '整句＝服务商那句＋分隔符＋深度那一档的说明（逐字取字典，不是截到后半句）').toBe(
      `${HINT_TAVILY} · ${DEPTH_HINT_FULL}`
    )
    expect(grown.className).not.toContain('truncate')
  })

  it('日历那一行：同一形状；服务端加了文件后换脸仍同源', async () => {
    const el = await hintSpan(CAL_NO_FILE)
    expect(el.className).not.toContain('truncate')
    expect(el.getAttribute('title')).toBe(CAL_NO_FILE)

    calServer = { ...calServer, paths: ['C:/ics/a.ics'] }
    fireEvent.click(screen.getByRole('checkbox', { name: /日历/ }))
    await waitFor(() => expect(el.textContent).toBe(CAL_OFF))
    expect(el.getAttribute('title')).toBe(CAL_OFF)
  })

  it('正向对照＋漏网钉：这一屏上带 truncate 的 span 只剩终端那一颗，且它有 title', async () => {
    await hintSpan(HINT_TAVILY)
    const clipped = Array.from(document.querySelectorAll('span.truncate'))
    expect(clipped.map((s) => s.textContent), `现数屏上还带 truncate 的 span：${clipped.map((s) => s.textContent).join('｜')}`).toEqual([SHELL_OFF])
    expect(clipped[0]?.getAttribute('title'), '那颗一直没动是因为它有 title＝悬停补得回').toBe(SHELL_OFF)
  })
})
