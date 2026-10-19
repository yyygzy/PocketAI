// @vitest-environment jsdom
// V4-Iter-218：把四个"用户会看的界面点"从「只有形状闸门」升级成「真挂载演过一遍」。
//
// 214／215／216／217 一共修了 63 个点，其中绝大多数只有"区域里出现了判据文本"这种源码级证据。
// 源码级证据的问题是：**判据在，但它写错了地方／弹不出东西，闸门照样绿**。这一批专门补那一格：
// 真组件、真 IPC 桩、真 toast 面板，失败与成功各演一遍（**每条失败用例都配一条反向对照**，
// 否则"toast 面板为空"这句话既可能是"没弹错"也可能是"什么都没弹"）。
//
// 覆盖：AttachmentGrid 灯箱的复制图片（§216）、DataHealthPanel 的两条修复动作（§216）、
// ChannelsPanel 的停止网关（§217）、McpPanel 的停止服务（§217）。
import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import { ImageLightbox } from '../src/renderer/src/components/AttachmentGrid'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { ChannelsPanel } from '../src/renderer/src/modules/agent/channels/ChannelsPanel'
import { McpPanel } from '../src/renderer/src/modules/agent/mcp/McpPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DataHealthReport } from '../src/shared/types'

const ZH = zh as unknown as Record<string, string>
/** 界面文案一律取字典（拼错 key 就得到 undefined，用例找不到元素即红） */
const L = (key: string): string => ZH[key]!
/**
 * toast 面板：每条 toast 自己就是一个 role=status 的盒子（ToastProvider.tsx:87）。
 * **不滤空串**——`toast.success(null)` 会渲染一条空盒子，滤掉就等于放过"既报错又报成功"的双弹形状。
 */
const panels = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
/**
 * 等指定那次 IPC 真的落地，并在 act 里把微任务与 0ms 定时器排空，之后**同步**读面板。
 * 为什么不用 `waitFor(() => expect(panels()).toEqual([...]))`：两次 setState 分属两个微任务，
 * 中间那一拍正好看见"只有一条 toast"⇒ 抢拍成功、双弹的回归就漏掉了（M218b 第一轮就是这么绿的）。
 */
const settleAfter = async (fn: string): Promise<void> => {
  await waitFor(() => expect(calledFns()).toContain(fn))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('① 灯箱「📋 复制图片」：失败不许显示「✓ 已复制」，也不能把按钮卡住', () => {
  it('writeImageClipboard 回 {ok:false} ⇒ 按钮仍是「复制图片」且可再点，toast 逐字给原因', async () => {
    stubPocketai({ writeImageClipboard: () => ({ ok: false, error: '图片解码失败' }) })
    mountWithProviders(<ImageLightbox src="data:image/png;base64,zz" onClose={() => { /* 用例不关心关闭 */ }} />)
    fireEvent.click(screen.getByRole('button', { name: L('lightbox.copyImage') }))
    await settleAfter('writeImageClipboard')
    expect(panels()).toEqual(['图片解码失败'])
    const btn = screen.getByRole('button', { name: L('lightbox.copyImage') }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(screen.queryByText(L('lightbox.copiedImage'))).toBeNull()
  })

  it('反向对照：成功 ⇒ 按钮才变「✓ 已复制」，且没有任何 toast', async () => {
    stubPocketai({ writeImageClipboard: () => ({ ok: true }) })
    mountWithProviders(<ImageLightbox src="data:image/png;base64,ok" onClose={() => { /* 同上 */ }} />)
    fireEvent.click(screen.getByRole('button', { name: L('lightbox.copyImage') }))
    await screen.findByRole('button', { name: L('lightbox.copiedImage') })
    expect(panels()).toEqual([])
  })
})

const reportWith = (integrity: Partial<DataHealthReport['kb']['integrity']>): DataHealthReport => ({
  sizes: {
    userDataBytes: 1024, dbBytes: 1024, attachmentsBytes: 1024, extensionsBytes: 1024, logsBytes: 1024,
    otherBytes: 0, browserCacheBytes: 1024, browserCacheFiles: 1
  },
  traces: { rows: 0, maxRowsInOneConversation: 0 },
  kb: {
    total: 1,
    byStatus: { pending: 0, parsing: 0, indexing: 0, ready: 1, error: 0 },
    errorDocs: [],
    integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [], ...integrity },
    vectorIndex: { count: 0, dims: [] }
  },
  backup: { configured: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
  tasks: { kbHealthCheckLastRunAt: null, backupVerifyLastRunAt: null },
  boot: { stages: [], totalMs: 0 },
  recentPerf: [],
  perfHistory: []
})

describe('② 数据健康面板的两条修复动作：改前弹的是"可数的假数字"', () => {
  const mount = (impls: Record<string, () => unknown>): void => {
    stubPocketai({ getDataHealth: () => reportWith({ orphanVectors: 12, orphanChunks: 4, brokenDocs: [{ id: 'd1', title: '坏文档', kbName: '库A', reason: 'missing-vec' }] }), ...impls })
    mountWithProviders(<DataHealthPanel />)
  }

  it('清理失败 ⇒ 红 toast 逐字给原因，绝不出现「已清理 undefined 条孤儿向量…」', async () => {
    mount({ cleanKbOrphans: () => ({ ok: false, error: '向量库正被占用' }) })
    fireEvent.click(await screen.findByRole('button', { name: L('dh.integrity.clean') }))
    await settleAfter('cleanKbOrphans')
    expect(panels()).toEqual(['向量库正被占用'])
    expect(screen.queryByText(/已清理/)).toBeNull()
  })

  it('反向对照：清理成功 ⇒ 逐字「已清理 7 条孤儿向量、3 条孤儿分块」，没有红 toast', async () => {
    mount({ cleanKbOrphans: () => ({ removedVectors: 7, removedChunks: 3 }) })
    fireEvent.click(await screen.findByRole('button', { name: L('dh.integrity.clean') }))
    await settleAfter('cleanKbOrphans')
    expect(panels()).toEqual([L('dh.integrity.cleanDone').replace('{vectors}', '7').replace('{chunks}', '3')])
  })

  it('重建索引失败 ⇒ 报原因而不是「已入队 undefined 篇文档重建索引」', async () => {
    mount({ reindexKbDocs: () => ({ ok: false, error: '索引器未就绪' }) })
    fireEvent.click(await screen.findByRole('button', { name: L('dh.integrity.reindex') }))
    await settleAfter('reindexKbDocs')
    expect(panels()).toEqual(['索引器未就绪'])
    expect(screen.queryByText(/已入队/)).toBeNull()
  })
})

describe('③ 渠道网关的「停止」：改前停没停下来完全看不出来（同文件的「启动」早就判了）', () => {
  const cfg = { type: 'telegram', enabled: true, hasPrimarySecret: true, hasSecondarySecret: false, appId: '', whitelist: '', assistantId: '', providerId: '', model: '', agentMode: false }
  const running = { telegram: { type: 'telegram', status: 'running', lastError: null } }
  const mount = (stop: () => unknown): void => {
    stubPocketai({
      listProviders: () => [],
      listAssistants: () => [],
      onChannelStatus: () => () => { /* 订阅卸载函数 */ },
      getChannelConfig: () => cfg,
      listChannelStatus: () => running,
      stopChannel: stop
    })
    mountWithProviders(<ChannelsPanel />)
  }

  it('stopChannel 回 {ok:false} ⇒ 红 toast 逐字给原因', async () => {
    mount(() => ({ ok: false, error: '网关进程已不在' }))
    fireEvent.click(await screen.findByRole('button', { name: L('channel.stop') }))
    await settleAfter('stopChannel')
    expect(panels()).toEqual(['网关进程已不在'])
  })

  it('反向对照：停止成功（{ok:true}）⇒ 不弹任何东西', async () => {
    mount(() => ({ ok: true }))
    fireEvent.click(await screen.findByRole('button', { name: L('channel.stop') }))
    await settleAfter('stopChannel')
    expect(panels()).toEqual([])
  })
})

describe('④ MCP 的「停止」：与渠道同一形状，另一个文件', () => {
  const record = { id: 'srv1', name: '探针服务', transport: 'stdio', runtime: 'binary', command: 'node', args: [], env: {}, headers: {}, enabled: true, readOnly: false, url: '' }
  const running = [{ id: 'srv1', name: '探针服务', transport: 'stdio', runtime: 'binary', command: 'node', args: [], env: {}, status: 'running', tools: [], lastError: null }]
  const mount = (stop: () => unknown): void => {
    stubPocketai({
      listMcpServers: () => [record],
      getMcpRuntimes: () => running,
      listMcpCallLogs: () => ({ ok: true, logs: [] }),
      onMcpStatus: () => () => { /* 订阅卸载函数 */ },
      onMcpLog: () => () => { /* 订阅卸载函数 */ },
      onPythonEnvEvent: () => () => { /* 订阅卸载函数 */ },
      getPythonPipSource: () => ({ ok: true, source: 'default', url: '' }),
      stopMcpServer: stop
    })
    mountWithProviders(<McpPanel />)
  }

  it('stopMcpServer 回 {ok:false} ⇒ 红 toast 逐字给原因', async () => {
    mount(() => ({ ok: false, error: '进程已自己退出' }))
    fireEvent.click(await screen.findByRole('button', { name: L('common.stop') }))
    await settleAfter('stopMcpServer')
    expect(panels()).toEqual(['进程已自己退出'])
  })

  it('反向对照：停止成功 ⇒ 不弹任何东西（这条挡住"把成功也弹一遍"的过度修）', async () => {
    mount(() => ({ ok: true }))
    fireEvent.click(await screen.findByRole('button', { name: L('common.stop') }))
    await settleAfter('stopMcpServer')
    expect(panels()).toEqual([])
  })
})
