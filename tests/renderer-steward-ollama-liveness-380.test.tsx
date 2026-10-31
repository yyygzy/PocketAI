// @vitest-environment jsdom
// §380 真挂载：管家页那枚 Ollama 徽标与那条告警，三态各说各话
//
// 这一屏的谎来自第二处探针（`model-recommend.ts` 的 `probeOllamaModels`）：catch 一律 `running:false`，
// 于是 2.5 秒没答话同时被画成「○ 未运行」和「未检测到运行中的 Ollama 服务：安装并启动…」——
// 教用户去重装一个可能正在慢慢启动的服务。
// 夹具抄 §255 那份管家页挂载桩（`renderer-steward-read-255.test.tsx`），桩按类型写死、缺字段编译期就红。
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { StewardModule } from '../src/renderer/src/modules/steward/StewardModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AuditResult, ModelRecommendation, OllamaLiveness } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const hardwareSample = {
  os: { platform: 'win32', release: '10.0', arch: 'x64', hostname: 'BOX' },
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}
const healthSample = {
  totalConversations: 3,
  totalMessages: 12,
  kbCount: 1,
  totalAttachmentsBytes: 0,
  orphanMessages: 0,
  orphanChunks: 0
}

const RECO = (liveness: OllamaLiveness, warnings: string[] = []): ModelRecommendation => ({
  tier: 'entry',
  summary: 'cpu_low',
  summaryParams: {},
  localPicks: [{ id: 'PROBE-PICK:latest', tag: 'primary', reason: 'qwen3b_q4_lowvram', installed: false }],
  onlineHint: 'low_end',
  ollamaLiveness: liveness,
  installedModels: [],
  warnings: warnings as ModelRecommendation['warnings']
})

const stubs = (data: ModelRecommendation): Record<string, (...a: unknown[]) => unknown> => ({
  getHardwareInfo: () => ({ ok: true, data: hardwareSample }),
  checkIntegrity: () => ({ ok: true, data: { ok: true, details: 'ok' } }),
  getHealthReport: () => ({ ok: true, data: healthSample }),
  getUpdateInfo: () => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: false }),
  runAudit: () => ({ ok: true, data: { score: 88, checks: [] } as AuditResult }),
  onOllamaPullEvent: () => () => {},
  recommendModels: () => ({ ok: true, data })
})

const badge = async (): Promise<HTMLElement> => {
  await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
  return screen.getByText(/^Ollama /)
}

describe('① 徽标三张脸', () => {
  it('up ⇒ 「● 运行中」，另外两句都不在场', async () => {
    stubPocketai(stubs(RECO('up')) as never)
    mountWithProviders(<StewardModule />)
    const el = await badge()
    expect(el.textContent).toBe(`Ollama ${L('steward.ollamaRunning')}`)
    expect(el.textContent).not.toContain(L('steward.ollamaStopped'))
    expect(el.textContent).not.toContain(L('steward.ollamaUnknown'))
  })

  it('down ⇒ 「○ 未运行」（这一句现在只有这一档能拿到）', async () => {
    stubPocketai(stubs(RECO('down')) as never)
    mountWithProviders(<StewardModule />)
    const el = await badge()
    expect(el.textContent).toBe(`Ollama ${L('steward.ollamaStopped')}`)
  })

  it('unknown ⇒ 「? 状态未知」，且「○ 未运行」那一句绝不出场（改前这两档是同一句）', async () => {
    stubPocketai(stubs(RECO('unknown')) as never)
    mountWithProviders(<StewardModule />)
    const el = await badge()
    expect(el.textContent).toBe(`Ollama ${L('steward.ollamaUnknown')}`)
    expect(el.textContent).not.toContain(L('steward.ollamaStopped'))
  })

  it('反向对照：三档各自一句、两两不同（共用一句就等于有一档在说谎）', () => {
    const labels = [L('steward.ollamaRunning'), L('steward.ollamaStopped'), L('steward.ollamaUnknown')]
    expect(new Set(labels).size).toBe(3)
  })
})

describe('② 那条告警码：unknown 不许借用「安装并启动」那句', () => {
  it('warnings=[ollama_unknown] ⇒ 屏上是「无法确认」那句，「未检测到运行中的 Ollama 服务」不在场', async () => {
    stubPocketai(stubs(RECO('unknown', ['ollama_unknown'])) as never)
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
    expect(screen.queryByText(L('modelRec.warn.ollama_unknown'), { exact: false })).not.toBeNull()
    expect(screen.queryByText(L('modelRec.warn.no_ollama'), { exact: false })).toBeNull()
  })

  it('warnings=[no_ollama] ⇒ 正向对照：那句"安装并启动"确实会摆出来（上一条不是恒真）', async () => {
    stubPocketai(stubs(RECO('down', ['no_ollama'])) as never)
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
    expect(screen.queryByText(L('modelRec.warn.no_ollama'), { exact: false })).not.toBeNull()
  })

  it('探测没成功 ⇒ 那颗拉取键点不动，但 tooltip 不再声称"未运行"以外的判断', async () => {
    stubPocketai(stubs(RECO('unknown')) as never)
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
    const btn = screen.getByRole('button', { name: new RegExp(L('ollama.pullBtn')) }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toBe(L('steward.pullNeedRunning'))
  })
})
