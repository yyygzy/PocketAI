// V4-Iter-259：§258 名单里"还会当场崩"的那一族点——MCP 的清单与运行状态两发（Agent 会话列表那两发随 P4 批次 2 删壳退场）。
//
// 探针实测（临时用例，跑完即删）：`listMcpServers` 回 `{ok:false,error}` ⇒ **`records.map is not a function`**
// （`McpPanel.tsx:301`），整屏空白。这是"绑了变量、只判真值（或根本不判）就把失败对象当数据用"这一档，
// 第四面闸门看不见它们（判的是变量，不是信封），所以 §258 只能靠只读扫描把它们捞出来。
//
// 收口形状照仓里既有的脸，且**逐发点名**（§257 的口径）：两个状态各自说话，不合并成一句"整屏不可信"。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { McpPanel } from '../src/renderer/src/modules/agent/mcp/McpPanel'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string => L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''

// ───────── ① MCP 那两张表 ─────────

const RECORD = {
  id: 'srv1', name: '探针服务', transport: 'stdio', runtime: 'binary', command: 'node',
  args: [], env: {}, headers: {}, enabled: true, readOnly: false, url: ''
}
const RUNTIME = [{
  id: 'srv1', name: '探针服务', transport: 'stdio', runtime: 'binary', command: 'node',
  args: [], env: {}, status: 'running', tools: [], lastError: null
}]

type Impl = (...a: any[]) => unknown
const mcpStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  listMcpServers: () => [RECORD],
  getMcpRuntimes: () => RUNTIME,
  listMcpCallLogs: () => ({ ok: true, logs: [] }),
  onMcpStatus: () => () => { /* 订阅卸载 */ },
  onMcpLog: () => () => { /* 订阅卸载 */ },
  onPythonEnvEvent: () => () => { /* 订阅卸载 */ },
  getPythonPipSource: () => ({ ok: true, source: 'default', url: '' }),
  getAgentToolSurface: () => 'grouped',
  ...over
})

describe('① MCP 的清单与运行状态：两发各自点名，且这一屏不许再是空白', () => {
  it('两发都回 {ok:false} ⇒ 两句各说各的，空态「尚未配置」让位，屏上仍有内容', async () => {
    stubPocketai(mcpStubs({
      listMcpServers: () => ({ ok: false, error: 'MCP_LIST:配置文件读不到' }),
      getMcpRuntimes: () => ({ ok: false, error: 'RUNTIME:状态读不到' })
    }))
    mountWithProviders(<McpPanel />)
    // DOM 序就是这两句的顺序（运行状态那句在列表上方做整列的注脚，清单那句占的是空态那一格）
    await waitFor(() => expect(alerts()).toEqual([
      L('agent.runtimeUnread').replace('{msg}', 'RUNTIME:状态读不到'),
      NAMED('MCP 服务器列表', 'MCP_LIST:配置文件读不到')
    ]))
    // 这一条才是本批的立项理由：以前 records 是失败对象 ⇒ map TypeError ⇒ 整屏空白
    process.stdout.write(`DBG-ALERTS=${JSON.stringify(alerts())}
DBG-BODY=${JSON.stringify(bodyText().slice(0,160))}
`)
    expect(bodyText()).toContain('MCP Servers')
    expect(bodyText()).not.toContain(L('agent.noServers'))
    expect(bodyText()).not.toContain('undefined')
  })

  it('只有清单读不到 ⇒ 那句在，运行状态那句不许顺带冒（逐发点名）', async () => {
    stubPocketai(mcpStubs({ listMcpServers: () => ({ ok: false, error: 'MCP_LIST:配置文件读不到' }) }))
    mountWithProviders(<McpPanel />)
    await waitFor(() => expect(alerts()).toContain(NAMED('MCP 服务器列表', 'MCP_LIST:配置文件读不到')))
    expect(alerts().join(' ')).not.toContain('运行状态读不到')
    // 清单没读到 ⇒ 一张卡都不该有（那句占的就是空态那一格）
    expect(screen.queryAllByRole('button', { name: L('common.stop') })).toEqual([])
  })

  it('只有运行状态读不到 ⇒ 服务器照常列出（读到的那份不能被一起扔了），且没有「尚未配置」', async () => {
    stubPocketai(mcpStubs({ getMcpRuntimes: () => ({ ok: false, error: 'RUNTIME:状态读不到' }) }))
    mountWithProviders(<McpPanel />)
    await waitFor(() => expect(alerts()).toContain(L('agent.runtimeUnread').replace('{msg}', 'RUNTIME:状态读不到')))
    // 这个名字会同时出现在卡片与"调用记录"的过滤项里 ⇒ 断"至少一处"而不是断唯一
    expect(screen.getAllByText('探针服务').length).toBeGreaterThan(0)
    expect(bodyText()).not.toContain(L('agent.noServers'))
    expect(screen.queryAllByRole('button', { name: L('common.start') }), '运行状态没读到 ⇒ 每台按未启动显示').not.toEqual([])
    expect(alerts().join(' ')).not.toContain('MCP 服务器列表读不到')
  })

  it('反向对照：两发都读到 ⇒ 一句"读不到"都不许有', async () => {
    stubPocketai(mcpStubs())
    mountWithProviders(<McpPanel />)
    await waitFor(() => expect(screen.getAllByText('探针服务').length).toBeGreaterThan(0))
    expect(alerts()).toEqual([])
  })

  it('后来到货（从模板建了一台）⇒ 那两句必须自己收回', async () => {
    let failing = true
    stubPocketai(mcpStubs({
      listMcpServers: () => (failing ? { ok: false, error: 'MCP_LIST:配置文件读不到' } : [RECORD]),
      getMcpRuntimes: () => (failing ? { ok: false, error: 'RUNTIME:状态读不到' } : RUNTIME),
      saveMcpServer: () => ({ ...RECORD, name: 'memory' })
    }))
    mountWithProviders(<McpPanel />)
    await waitFor(() => expect(alerts()).toContain(NAMED('MCP 服务器列表', 'MCP_LIST:配置文件读不到')))
    fireEvent.click(screen.getByText(L('agent.templates')))
    const card = await waitFor(() => screen.getByText('memory').closest('div[class*="rounded"]') as HTMLElement)
    const btn = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === L('agent.tplCreate'))
    if (!btn) throw new Error('模板卡片 memory 上找不到「创建」按钮')
    failing = false
    fireEvent.click(btn)
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.getAllByText('探针服务').length).toBeGreaterThan(0)
  })
})

// ───────── ② 接线计数：旧形状归零 ─────────

describe('② 接线计数', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8').replace(/\r\n/g, '\n')
  const MCP = read('src/renderer/src/modules/agent/mcp/McpPanel.tsx')
  const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

  it('"拿到就写进 state"的相邻两行必须归零（那正是探针撞到的形状）', () => {
    expect(count(MCP, /setRecords\(recs\)\n\s*setRuntimes\(runs\)/g), 'MCP 两发不许再挨着裸写').toBe(0)
  })

  it('新落点数得出：两半各判一次、各清一次位', () => {
    expect(count(MCP, /if \(hasIpcFailed\(recs\) \|\| !Array\.isArray\(recs\)\)/g)).toBe(1)
    expect(count(MCP, /if \(hasIpcFailed\(runs\) \|\| !Array\.isArray\(runs\)\)/g)).toBe(1)
    expect(count(MCP, /setRecords\(recs\)/g), '成功支没被顺手删').toBe(1)
    expect(count(MCP, /setRuntimes\(runs\)/g)).toBe(1)
  })
})
