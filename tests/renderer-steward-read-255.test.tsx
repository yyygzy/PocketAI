// V4-Iter-255：管家页三处「判了不接管」＋一处判成"设计内静默"的账。
//
// 这一簇四处同一形状（`if (r.ok && r.data) setX(r.data)`），但失败时屏上给的东西并不一样，所以**逐处回读后才分两档**：
//  · 模型推荐那一读失败 ⇒ 整块「模型推荐」不出现（§254 那档"把没有读到演成这台机器不该有"）⇒ 补 `recErr`＋`LoadFailNotice`；
//  · 「开始体检」「故障诊断」两颗是**用户按的** ⇒ 失败必须当场说一句（同文件其余 handler 早就 `toast.error`）；
//  · 清理后那发"顺带刷新诊断"是设计内静默（上一份诊断还在屏上、清理本身已 toast）⇒ **不为清零去改产品码**，
//    只在源码里留一句理由、在闸门的 `SILENT_PER_FILE` 里继续计数。
// 两层证据：① 真挂载（`StewardModule` 是导出的，挂载只发四发读）跑"读不到／读到"两档；
// ② 接线计数钉住那颗按键与"旧写法只剩那一条、且它头上必须还留着设计内的理由注释"。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { StewardModule } from '../src/renderer/src/modules/steward/StewardModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AuditResult, ModelRecommendation } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())

// 桩按 `ModelRecommendation` 类型写死：缺字段编译期就红，避免断言靠默认值假绿。
const RECO: ModelRecommendation = {
  tier: 'entry',
  summary: 'cpu_low',
  summaryParams: {},
  localPicks: [{ id: 'PROBE-PICK:latest', tag: 'primary', reason: 'qwen3b_q4_lowvram', installed: false }],
  onlineHint: 'low_end',
  ollamaRunning: true,
  installedModels: [],
  warnings: []
}

const AUDIT: AuditResult = { score: 88, checks: [{ id: 'PROBE-CHECK', label: 'PROBE-AUDIT-OK', level: 'ok', detail: 'PROBE-DETAIL' }] }

type Impl = (...a: unknown[]) => unknown

const baseStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  // preload 的形状是混的：这几发返回**裸值**（不是 {ok,data} 信封），只有 recommendModels 这类
  // 显式带判定面的才带信封 ⇒ 桩必须照 `src/preload/index.ts:116/122/1204/1210` 的签名给，
  // 否则 `{ok:true,data:null}` 会被当成真快照往下渲染（我第一次就栽在这）
  getHardwareInfo: () => null,
  checkIntegrity: () => null,
  getHealthReport: () => null,
  getUpdateInfo: () => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: false }),
  onOllamaPullEvent: () => () => {},
  ...over
})

describe('① 模型推荐那块：读不到 ≠ 这台机器不该有', () => {
  it('recommendModels 回 {ok:false} ⇒ 「模型推荐」那一块显示「读不到：原因」', async () => {
    stubPocketai(baseStubs({ recommendModels: () => ({ ok: false, error: 'OLLAMA_UNREACHABLE:探测超时' }) }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(alerts()).toContain(FAILED('OLLAMA_UNREACHABLE:探测超时')))
    expect(screen.getByText(L('steward.modelRec'))).toBeTruthy()
  })

  it('反向对照：读到推荐 ⇒ 那块照常显示内容，一个 alert 都不许有', async () => {
    stubPocketai(baseStubs({ recommendModels: () => ({ ok: true, data: RECO }) }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
    expect(screen.getByText(L('steward.modelRec'))).toBeTruthy()
    expect(alerts()).toEqual([])
  })
})

describe('② 两颗用户按下的键：失败得当场说一句', () => {
  it('点「开始安全检测」而通道回 {ok:false} ⇒ toast 里是那条原因，不是"点了没反应"', async () => {
    stubPocketai(baseStubs({ recommendModels: () => ({ ok: true, data: RECO }), runAudit: () => ({ ok: false, error: 'AUDIT_BUSY:体检正在进行' }) }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
    fireEvent.click(screen.getByText(L('steward.startAudit')))
    await waitFor(() => expect(toasts().join(' ')).toContain('AUDIT_BUSY:体检正在进行'))
    expect(alerts()).toEqual([])
  })

  it('反向对照：检测成功 ⇒ 结果逐条上屏，且没有那条 toast', async () => {
    stubPocketai(baseStubs({
      recommendModels: () => ({ ok: true, data: RECO }),
      runAudit: () => ({ ok: true, data: AUDIT })
    }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
    fireEvent.click(screen.getByText(L('steward.startAudit')))
    await waitFor(() => expect(screen.queryByText('PROBE-AUDIT-OK')).not.toBeNull())
    expect(toasts().join(' ')).not.toContain('AUDIT_BUSY')
    expect(alerts()).toEqual([])
  })

  it('点「故障诊断」那一颗同理：失败进 toast，不许只把「诊断中」收掉', async () => {
    stubPocketai(baseStubs({ recommendModels: () => ({ ok: true, data: RECO }), runDiagnose: () => ({ ok: false, error: 'DIAG_IO:读不到诊断项' }) }))
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
    fireEvent.click(screen.getByText(L('steward.startDiagnose')))
    await waitFor(() => expect(toasts().join(' ')).toContain('DIAG_IO:读不到诊断项'))
  })
})

describe('③ 接线计数：旧写法只剩那一条，且它头上必须还留着设计内的理由', () => {
  const SRC = fs
    .readFileSync(path.resolve(__dirname, '../src/renderer/src/modules/steward/StewardModule.tsx'), 'utf-8')
    .replace(/\r\n/g, '\n')
  const count = (re: RegExp): number => (SRC.match(re) ?? []).length

  it('三处新落点数得出、那颗按键的两条失败面都进 toast', () => {
    expect(count(/setRecErr\(ipcFailText\(r, t\('common\.unknownError'\)\)\)/g), '推荐：resolve 面').toBe(1)
    expect(count(/setRecErr\(errText\(e, t\('common\.unknownError'\)\)\)/g), '推荐：reject 面').toBe(1)
    expect(count(/!recommendation && recErr && \(/g), '推荐：读不到时的渲染分支').toBe(1)
    expect(count(/toast\.error\(ipcFailText\(r, t\('common\.unknownError'\)\)\)/g), '两颗按键的失败都走 toast').toBe(2)
    expect(count(/setAudit\(r\.data\)/g), '体检成功分支还在').toBe(1)
    expect(count(/setDiagnose\(r\.data\)/g), '诊断成功分支还在（handler 一处＋设计内那处）').toBe(2)
  })

  it('旧写法只剩清理后那发设计内刷新（它必须带着那行理由注释，否则就是漏收）', () => {
    expect(count(/if \(r\.ok && r\.data\) setAudit\(r\.data\)/g), '体检那处的旧写法必须归零').toBe(0)
    const left = count(/if \(r\.ok && r\.data\) setDiagnose\(r\.data\)/g)
    expect(left, '诊断的旧写法只许剩 1 处（设计内那处）').toBe(1)
    expect(SRC).toContain('// §255 复核：这一发是"顺带更新"')
  })
})
