// 判据屏的界面契约（V4-Iter-146 / B81）
//
// 这块屏的价值全在"来源档有没有被区分着画出来"，所以断言落在**某一行的来源徽标文本**上，
// 而不是"页面里出现了某个词"——后者会因为另一行恰好也有同样的词而空过。
// 最后一条"不泄漏字典 key"是动态拼 key 的兜底网：`judgement.reason.${码}` 这种写法 parity 用例扫不到（Iter-102 就漏过）。
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { LocalJudgementPanel } from '../src/renderer/src/modules/settings/LocalJudgementPanel'
import { planLocalCapacity } from '../src/main/agent/local-capacity'
import { zh } from '../src/renderer/src/i18n/zh'
import type { LocalJudgementReport } from '../src/shared/local-judgement'

const baseReport = (over: Partial<LocalJudgementReport> = {}): LocalJudgementReport => ({
  collectedAt: new Date('2026-10-16T09:30:00').getTime(),
  totalVramMiB: 4096,
  capacity: planLocalCapacity({ totalVramMiB: 4096 }),
  liveVram: { available: true, rows: [{ name: 'GTX 1050 Ti', totalMiB: 4096, usedMiB: 3149 }] },
  slots: [],
  roleVerdicts: [
    {
      assistantName: '不碰知识库的助手',
      childUsesRetrieval: false,
      verdict: { allowed: false, reasons: ['distinct-roles-not-measured'] }
    }
  ],
  delegations: [
    { key: 'p::m', model: 'qwen2.5:3b-instruct', capability: 'native_tools_ok', samples: 3, nativeHits: 3, stale: false, delegationEnabled: true }
  ],
  ...over
})

function mount(report: LocalJudgementReport | { ok: false; error: string }): void {
  stubPocketai({ getLocalJudgement: () => Promise.resolve(report) })
  mountWithProviders(<LocalJudgementPanel />)
}

/** 某一行的来源徽标文本（按 data-row-id 找，不按整页文本找） */
function sourceBadge(container: HTMLElement, rowId: string): string {
  const el = container.querySelector(`[data-row-id="${rowId}"] [data-source-code]`)
  if (!el) throw new Error(`没有这一行或这行没有来源徽标：${rowId}`)
  return String(el.textContent ?? '')
}

describe('来源档必须分行画出来', () => {
  it('实测档：并行数那行是「测得」', async () => {
    stubPocketai({ getLocalJudgement: () => Promise.resolve(baseReport()) })
    const { container } = mountWithProviders(<LocalJudgementPanel />)
    await waitFor(() => expect(container.querySelector('[data-row-id="chat-slots"]')).toBeTruthy())
    expect(sourceBadge(container, 'chat-slots')).toBe(zh['judgement.source.measured'])
  })

  it('未实测档（12GiB）：同一行降级成「保守默认」——这正是这块屏要防的那次误读', async () => {
    const big = planLocalCapacity({ totalVramMiB: 12288 })
    stubPocketai({
      getLocalJudgement: () => Promise.resolve(baseReport({ totalVramMiB: 12288, capacity: big }))
    })
    const { container } = mountWithProviders(<LocalJudgementPanel />)
    await waitFor(() => expect(container.querySelector('[data-row-id="chat-slots"]')).toBeTruthy())
    expect(sourceBadge(container, 'chat-slots')).toBe(zh['judgement.source.no-measurement'])
    // 反向对照：同屏的现采行仍是「测得」⇒ 上面那条降级不是"整屏都不标测得"造成的
    expect(sourceBadge(container, 'vram-used-live')).toBe(zh['judgement.source.measured'])
  })

  it('此刻没有队列 ⇒ 那行标「没读到」，不许画成测得', async () => {
    stubPocketai({ getLocalJudgement: () => Promise.resolve(baseReport({ slots: [] })) })
    const { container } = mountWithProviders(<LocalJudgementPanel />)
    await waitFor(() => expect(container.querySelector('[data-row-id="slot-queue"]')).toBeTruthy())
    expect(sourceBadge(container, 'slot-queue')).toBe(zh['judgement.source.unavailable'])
    expect(container.querySelector('[data-row-id="slot-queue"]')!.textContent).toContain(zh['judgement.value.no-queue-now'])
  })

  it('现采显存那行带着"不参与判据"这句——它只是观察值', async () => {
    mount(baseReport())
    const el = await waitFor(() => {
      const n = document.querySelector(`[data-row-id="vram-used-live"] [data-note-key="${'judgement.note.not-a-capacity-input'}"]`)
      expect(n).toBeTruthy()
      return n!
    })
    expect(el.textContent).toBe(zh['judgement.note.not-a-capacity-input'])
  })
})

describe('判定行把样本数与开关一起带出来', () => {
  it('可当管控者 3/3 + 已被点名允许委派', async () => {
    stubPocketai({ getLocalJudgement: () => Promise.resolve(baseReport()) })
    const { container } = mountWithProviders(<LocalJudgementPanel />)
    await waitFor(() => expect(container.querySelector('[data-row-id="delegation:p::m"]')).toBeTruthy())
    const text = container.querySelector('[data-row-id="delegation:p::m"]')!.textContent ?? ''
    expect(text).toContain('3/3')
    expect(text).toContain(zh['judgement.note.delegation-on'])
    // 参数替换过：不许把模板原样吐出来
    expect(text).not.toContain('{hits}')
    expect(text).not.toContain('{model}')
  })

  it('判定过期 ⇒ 来源档降级并说"需重探"（旧结论不能继续当事实）', async () => {
    const r = baseReport()
    r.delegations = [{ ...r.delegations[0]!, stale: true }]
    stubPocketai({ getLocalJudgement: () => Promise.resolve(r) })
    const { container } = mountWithProviders(<LocalJudgementPanel />)
    await waitFor(() => expect(container.querySelector('[data-row-id="delegation:p::m"]')).toBeTruthy())
    expect(sourceBadge(container, 'delegation:p::m')).toBe(zh['judgement.source.no-measurement'])
    expect(container.querySelector('[data-row-id="delegation:p::m"]')!.textContent).toContain(zh['judgement.note.stale'])
  })
})

describe('失败不许被画成数据', () => {
  it('通道返回 {ok:false,error} ⇒ 只出错误文本，一行都不画', async () => {
    mount({ ok: false as const, error: 'nvidia-smi 起不来' })
    await waitFor(() => expect(screen.getByText(/nvidia-smi 起不来/)).toBeTruthy())
    expect(document.querySelectorAll('[data-row-id]')).toHaveLength(0)
  })

  it('反向对照：同一份组件在成功时确实会画出行（上面那条不是"永远不画"）', async () => {
    mount(baseReport())
    await waitFor(() => expect(document.querySelectorAll('[data-row-id]').length).toBeGreaterThan(4))
  })
})

describe('采集时刻与重采', () => {
  it('报告顶部显示这一份数据的采集时刻', async () => {
    mount(baseReport())
    const el = await waitFor(() => {
      const n = document.querySelector('[data-collected-at]')
      expect(n).toBeTruthy()
      return n!
    })
    expect(el.getAttribute('data-collected-at')).toBe(String(baseReport().collectedAt))
    expect(el.textContent).toContain(zh['judgement.collectedAt'].replace('{at}', ''))
  })

  it('点「重新采集」⇒ 再走一次通道（现采值要真的重新读）', async () => {
    mount(baseReport())
    await waitFor(() => expect(document.querySelector('[data-row-id="chat-slots"]')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: zh['judgement.refresh'] }))
    await waitFor(() =>
      expect(pocketaiCalls().filter((c) => c.fn === 'getLocalJudgement').length).toBe(2)
    )
  })
})

describe('字典完整性（动态拼 key 的兜底网）', () => {
  it('整屏渲染文本里不出现未解析的 judgement.* / set.* key', async () => {
    const smallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })
    // 把每一族码都覆盖进去：实测档 + 两条合取的三种取值 + 队列 + 四种判定 + 现采不可用
    mount(
      baseReport({
        capacity: smallCtx,
        liveVram: { available: false, rows: [] },
        slots: [{ origin: '127.0.0.1:11434', busy: 1, waiting: 1, capacity: 1 }],
        roleVerdicts: [
          { assistantName: 'A', childUsesRetrieval: false, verdict: { allowed: true, reasons: ['distinct-roles-allowed'] } },
          { assistantName: 'B', childUsesRetrieval: true, verdict: { allowed: false, reasons: ['retrieval-chain-exclusive'] } },
          {
            assistantName: 'C',
            childUsesRetrieval: false,
            verdict: { allowed: false, reasons: ['distinct-roles-not-measured', 'distinct-models-need-small-ctx'] }
          }
        ],
        delegations: (['native_tools_ok', 'fence_only', 'no_delegation', 'unknown'] as const).map((cap) => ({
          key: `p::${cap}`,
          model: cap,
          capability: cap,
          samples: 3,
          nativeHits: cap === 'native_tools_ok' ? 3 : 0,
          stale: false,
          delegationEnabled: false
        }))
      })
    )
    await waitFor(() => expect(document.querySelectorAll('[data-row-id]').length).toBeGreaterThan(6))
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/judgement\.[a-z]/)
    expect(text).not.toMatch(/set\.localJudgement/)
  })

  it('字典没这一码时退回显示码本身，而不是吐一个 key 字符串', async () => {
    const spy = vi.fn()
    stubPocketai({
      getLocalJudgement: () =>
        Promise.resolve(
          baseReport({
            // 一个字典里不存在的码（模拟判据以后新增码但文案没跟上）
            roleVerdicts: [{ assistantName: 'Z', childUsesRetrieval: false, verdict: { allowed: false, reasons: ['brand-new-code'] } }]
          })
        )
    })
    mountWithProviders(<LocalJudgementPanel />)
    await waitFor(() => expect(document.querySelector('[data-row-id="distinct-roles:Z"]')).toBeTruthy())
    const el = document.querySelector('[data-reason-code="brand-new-code"]')!
    expect(el.textContent).toBe('brand-new-code')
    expect(el.textContent).not.toContain('judgement.reason.')
    spy()
  })
})
