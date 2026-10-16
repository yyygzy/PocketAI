// 判据屏的界面契约（V4-Iter-146 / B81）
//
// 这块屏的价值全在"来源档有没有被区分着画出来"，所以断言落在**某一行的来源徽标文本**上，
// 而不是"页面里出现了某个词"——后者会因为另一行恰好也有同样的词而空过。
// 最后一条"不泄漏字典 key"是动态拼 key 的兜底网：`judgement.reason.${码}` 这种写法 parity 用例扫不到（Iter-102 就漏过）。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
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

/** 某一行的来源徽标**文字**（按 data-row-id 找，不按整页文本找；文字与记号是两个节点，见组件注释） */
function sourceBadge(container: HTMLElement, rowId: string): string {
  const el = container.querySelector(`[data-row-id="${rowId}"] [data-source-code] [data-source-label]`)
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
  })
})

/**
 * V4-Iter-149：真机截图上"测得 / 没读到"都是灰族、第一眼分不开，四条码只靠 gap 并排读起来像一句长句。
 * 这一组钉的是"区分通道不止颜色一条、且每条都在"——jsdom 没有排版引擎，它**不证明肉眼分得开**，
 * 那半留给 B86（同一批已用真 Electron 实例看过）。
 */
describe('来源档要第一眼分得开（记号 + 填充 + 边框样式三条冗余通道）', () => {
  const badgeOf = (rowId: string): Element | null => document.querySelector(`[data-row-id="${rowId}"] [data-source-code]`)

  const mountWith = async (report: LocalJudgementReport, rowId: string) => {
    // 一个用例里要换三份报告看三档 ⇒ 必须先卸载：helpers 的 cleanup 只在 afterEach 跑，
    // 不卸就会读到上一份报告留下的那一行（第一版就是这么红的）
    cleanup()
    stubPocketai({ getLocalJudgement: () => Promise.resolve(report) })
    mountWithProviders(<LocalJudgementPanel />)
    await waitFor(() => expect(document.querySelector(`[data-row-id="${rowId}"]`)).toBeTruthy())
  }

  it('三档各画自己的记号，且三个记号互不相同', async () => {
    await mountWith(baseReport(), 'chat-slots')
    const measured = badgeOf('chat-slots')!.querySelector('[data-source-glyph]')!
    expect(measured.textContent).toBe('●')
    expect(measured.getAttribute('data-source-glyph')).toBe('measured')

    await mountWith(
      baseReport({ totalVramMiB: 12288, capacity: planLocalCapacity({ totalVramMiB: 12288 }) }),
      'chat-slots'
    )
    const conservative = badgeOf('chat-slots')!.querySelector('[data-source-glyph]')!
    expect(conservative.getAttribute('data-source-glyph')).toBe('no-measurement')

    await mountWith(baseReport({ slots: [] }), 'slot-queue')
    const none = badgeOf('slot-queue')!.querySelector('[data-source-glyph]')!
    expect(none.getAttribute('data-source-glyph')).toBe('unavailable')

    const glyphs = [measured.textContent, conservative.textContent, none.textContent]
    expect(new Set(glyphs).size).toBe(3)
    // 记号不许借用"已验证"那类语义符号（✓/✔）——保守默认看起来像绿灯正是这块屏要防的
    expect(glyphs.join('')).not.toMatch(/[✓✔☑]/)
  })

  it('非颜色通道也各自不同：前两档有填充、没读到那档是虚线框且无填充', async () => {
    await mountWith(baseReport(), 'chat-slots')
    const measured = String(badgeOf('chat-slots')!.getAttribute('class'))
    await mountWith(
      baseReport({ totalVramMiB: 12288, capacity: planLocalCapacity({ totalVramMiB: 12288 }) }),
      'chat-slots'
    )
    const conservative = String(badgeOf('chat-slots')!.getAttribute('class'))
    await mountWith(baseReport(), 'slot-queue')
    const none = String(badgeOf('slot-queue')!.getAttribute('class'))

    expect(measured).toContain('bg-[')
    expect(conservative).toContain('bg-[')
    expect(none).toContain('border-dashed')
    expect(none).not.toContain('bg-[')
    // 反向对照：三档的 class 不是同一串（写成同一串就等于只靠文字分）
    expect(new Set([measured, conservative, none]).size).toBe(3)
  })

  it('保守默认那档走琥珀色，全组件不引绿色令牌', async () => {
    await mountWith(
      baseReport({ totalVramMiB: 12288, capacity: planLocalCapacity({ totalVramMiB: 12288 }) }),
      'chat-slots'
    )
    expect(String(badgeOf('chat-slots')!.getAttribute('class'))).toContain('--color-warning')
    // 整份组件源码扫（?raw 在 vitest 里能拿，但类型上是个洞 ⇒ 直接读文件）
    const src = readFileSync('src/renderer/src/modules/settings/LocalJudgementPanel.tsx', 'utf8')
    expect(src).not.toContain('--color-success')
  })
})

describe('原因码之间有显式分隔符', () => {
  const mountReasons = async (reasons: string[]) => {
    cleanup()
    stubPocketai({
      getLocalJudgement: () =>
        Promise.resolve(
          baseReport({
            roleVerdicts: [{ assistantName: 'A', childUsesRetrieval: false, verdict: { allowed: false, reasons } }]
          })
        )
    })
    mountWithProviders(<LocalJudgementPanel />)
    await waitFor(() => expect(document.querySelector('[data-row-id="distinct-roles:A"]')).toBeTruthy())
    return document.querySelector('[data-row-id="distinct-roles:A"]')!
  }

  it('两条码 ⇒ 一个分隔符，且夹在两码之间', async () => {
    const row = await mountReasons(['distinct-roles-not-measured', 'distinct-models-need-small-ctx'])
    expect(row.querySelectorAll('[data-reason-code]').length).toBe(2)
    const seps = row.querySelectorAll('[data-reason-sep]')
    expect(seps.length).toBe(1)
    expect(seps[0]!.previousElementSibling!.hasAttribute('data-reason-code')).toBe(true)
    expect(seps[0]!.nextElementSibling!.hasAttribute('data-reason-code')).toBe(true)
  })

  it('一条码 ⇒ 一个都不加（反向对照：不是无条件塞符号）；四条重复码 ⇒ 去重后三个', async () => {
    // 单码那条刻意选 retrieval-chain-exclusive：它不触发"容量判定再补一句 small-ctx"那条合并，
    // 否则这一格测的就不是"一条码不加符号"而是合并行为了（上面那格专门钉合并 + 去重）
    const one = await mountReasons(['retrieval-chain-exclusive'])
    expect(one.querySelectorAll('[data-reason-code]').length).toBe(1)
    expect(one.querySelectorAll('[data-reason-sep]').length).toBe(0)
    const four = await mountReasons([
      'distinct-roles-not-measured',
      'retrieval-chain-exclusive',
      'distinct-models-need-small-ctx',
      'local-serial-measured'
    ])
    expect(four.querySelectorAll('[data-reason-code]').length).toBe(4)
    expect(four.querySelectorAll('[data-reason-sep]').length).toBe(3)
  })

  it('分隔符不混进码的文本里（码文本仍逐字等于字典那一条）', async () => {
    const row = await mountReasons(['distinct-roles-not-measured', 'distinct-models-need-small-ctx'])
    const codes = [...row.querySelectorAll('[data-reason-code]')]
    expect(codes.map((c) => c.textContent)).toEqual([
      zh['judgement.reason.distinct-roles-not-measured'],
      zh['judgement.reason.distinct-models-need-small-ctx']
    ])
    for (const c of codes) expect(c.textContent).not.toContain('·')
  })
})
