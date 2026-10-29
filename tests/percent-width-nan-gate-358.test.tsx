// @vitest-environment jsdom
// V4-Iter-358：把「算出来的百分比交给 CSS」那一面钉住（NaN 族的第五种形状）。
//
// 为什么不是第四面／第五面那种"判没判信封"：这一面的输入不是信封，是**分母**。
// `safeHandle` 的失败在这条路上根本不出现——主进程老老实实回了一份汇总，只是那份汇总里
// 最大的那一项就是 0。`0/0` 是 NaN，`Math.max(NaN, 2)` 还是 NaN，于是 React 把
// `width: NaN%` 交给 CSSOM；Chromium 的处理是**整条声明丢掉**（不是当 0），块级元素回落到
// `width:auto`＝**占满轨道**。真机量过（`data/tmp/nan-width-probe.html`，同形状六行：
// `NaN%`→computed 600px＝轨道满宽；`0%`→0px；`50%`→300px）。
// 所以这条的观感不是"少了根条"，而是**把"这家一点没用过"画成"这家用得最多"**。
//
// 口径三条：
//  ① 分母为 0 就画 0（零用量是界面事实，不是需要遮掩的失败）；
//  ② 闸门按**站点**扫（不靠手挑文件清单，§351 那条纪律），每一处 `${…}%`／`${…}deg` 型尺寸插值
//     要么本行含兜底，要么它引用的那个量的定义行含兜底（往上找 12 行）；
//  ③ 桶二（靠上游守卫的）逐个钉住它依赖的那行出口代码——"依赖"不能只是一句判语（第 23 条）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { act } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import { UsagePanel } from '../src/renderer/src/modules/settings/UsagePanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { UsageAssistantItem, UsageConversationItem, UsagePricing, UsageSummary } from '../src/shared/types'

const ROOT = path.resolve(__dirname, '..')
const ZH = zh as unknown as Record<string, string>
const L = (key: string): string => ZH[key]!
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const settleAfter = async (fn: string): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  expect(calledFns()).toContain(fn)
  await settle()
}

// ─── ② 行为：真挂载，把 NaN 挡在 CSSOM 之前 ─────────────────────────────
const summary = (byModel: UsageSummary['byModel']): UsageSummary => ({
  days: 30,
  totals: { requests: 4, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cost: 0 },
  daily: [{ date: '2026-10-01', totalTokens: 0, cost: 0 }],
  byProvider: [],
  byModel
})

const okReads = {
  getUsageConversations: () => [] as UsageConversationItem[],
  getUsageAssistants: () => [] as UsageAssistantItem[],
  getUsagePricing: () => ({ currency: 'CNY', prices: {} } as unknown as UsagePricing),
  getUsageBudget: () => ({ daily: null, monthly: null, hardBlock: false, warnEnabled: true, todayCost: 0, monthCost: 0 })
}

/** 模型那一行的内层条：行用 `title="provider/model"` 那个 **span** 认，条＝轨道 div 的唯一子节点 */
const barWidths = (container: HTMLElement): string[] => {
  const rows = Array.from(container.querySelectorAll('span[title]'))
    .map((el) => el.parentElement)
    .filter((el): el is HTMLDivElement => !!el)
  expect(rows.length, '模型那几行都得找到').toBeGreaterThan(0)
  return rows.map((row) => {
    const track = Array.from(row.querySelectorAll(':scope > div')).find((d) => (d.getAttribute('class') ?? '').includes('overflow-hidden'))
    const bar = track?.firstElementChild as HTMLElement | undefined
    if (!bar) return '(找不到那根条)'
    return (bar.getAttribute('style') ?? '').includes('width') ? bar.style.width : '(没有宽度声明)'
  })
}

describe('① 模型 Top10 条形图：整屏零用量时不许把 NaN 交给 CSS', () => {
  it('byModel 全 0 token ⇒ 每根条是 0%（旧写法这里是空声明＝浏览器丢掉＝画满）', async () => {
    stubPocketai({
      ...okReads,
      getUsageSummary: () =>
        summary([
          { provider: 'ollama', model: 'llama3:8b', requests: 2, totalTokens: 0, cost: 0 },
          { provider: 'glm', model: 'glm-4.6', requests: 2, totalTokens: 0, cost: 0 }
        ])
    })
    const { container } = mountWithProviders(React.createElement(UsagePanel))
    await settleAfter('getUsageSummary')
    expect(container.innerHTML).not.toContain('NaN')
    const widths = barWidths(container)
    expect(widths.length, '两行都该有那根条').toBe(2)
    // 判据按值不按"看不见"：jsdom 也会像 Chromium 一样丢掉非法值，所以这里要的是"声明存在且为 0%"
    expect(widths, '零用量就画零').toEqual(['0%', '0%'])
  })

  it('反向对照：正常用量照常按最大值归一（不是恒 0，也不是把小的抹平成 2%）', async () => {
    stubPocketai({
      ...okReads,
      getUsageSummary: () =>
        summary([
          { provider: 'ollama', model: 'llama3:8b', requests: 3, totalTokens: 1000, cost: 0 },
          { provider: 'glm', model: 'glm-4.6', requests: 1, totalTokens: 250, cost: 0 }
        ])
    })
    const { container } = mountWithProviders(React.createElement(UsagePanel))
    await settleAfter('getUsageSummary')
    expect(container.innerHTML).not.toContain('NaN')
    expect(barWidths(container)).toEqual(['100%', '25%'])
  })

  it('L(`usage.byModel`) 那一格确实渲染出来了（否则上两条是在数空气）', async () => {
    stubPocketai({ ...okReads, getUsageSummary: () => summary([]) })
    const { container } = mountWithProviders(React.createElement(UsagePanel))
    await settleAfter('getUsageSummary')
    expect(container.textContent).toContain(L('usage.byModel'))
  })
})

// ─── ③ 闸门：全仓的百分比／角度插值逐处点名 ────────────────────────────
const GUARD = /\?\?\s*0|\|\|\s*0|Math\.max\(|>\s*0|===\s*0|!==\s*0|\.length\s*===\s*0/
// 站点：JSX 的 style 插值 或 conic-gradient 的角度插值
const SITE = /style=\{\{\s*(?:width|height):\s*`[^`]*\$\{[^`]*\}%`|\$\{[^}]*\}deg/
// 依赖登记（桶二）：这一处本行与近旁都没有兜底写法，靠的是上游那一行——把它钉成代码（第 23 条）
const OLLAMA_NAIL = /if\s*\(totalSum > 0\)\s*\{\s*\n\s*percent = Math\.min\(100, \(completedSum \/ totalSum\) \* 100\)/
const NAKED: Array<{ rel: string; expr: RegExp; upstream: string; nail: RegExp; why: string }> = [
  {
    rel: 'src/renderer/src/components/OllamaPanel.tsx',
    expr: /\$\{pullEvt\.percent\}/,
    upstream: 'src/main/ollama/ollama-runtime.ts',
    nail: OLLAMA_NAIL,
    why: 'percent 初值 0，唯一的除法写在 `if (totalSum > 0)` 之内'
  },
  {
    rel: 'src/renderer/src/modules/steward/StewardModule.tsx',
    expr: /\$\{pullEvt\.percent\}/,
    upstream: 'src/main/ollama/ollama-runtime.ts',
    nail: OLLAMA_NAIL,
    why: '同一份事件流，同一颗守卫'
  },
  {
    rel: 'src/renderer/src/modules/settings/SettingsModule.tsx',
    expr: /\$\{progress\}/,
    upstream: 'src/renderer/src/modules/settings/SettingsModule.tsx',
    nail: /const progress = status\?\.progress \?\? 0/,
    why: '这份进度条的值在 90 行外就 `?? 0` 过了一道'
  }
]

describe('② 闸门：把百分比交给 CSS 的每一处都得先兜住分母', () => {
  const filesIn = (dir: string): string[] => {
    const out: string[] = []
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name)
      if (f.isDirectory()) out.push(...filesIn(p))
      else if (f.name.endsWith('.tsx')) out.push(p)
    }
    return out
  }

  const sites = (() => {
    const rows: { rel: string; line: number; text: string; guarded: boolean }[] = []
    for (const abs of filesIn(path.join(ROOT, 'src/renderer/src'))) {
      const rel = abs.slice(ROOT.length + 1).replace(/\\/g, '/')
      const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n')
      lines.forEach((l, i) => {
        if (!SITE.test(l)) return
        // 注释行不算站点（自己写的判语会把同一串撑大——第 33 条）
        if (l.trim().startsWith('//') || l.trim().startsWith('*')) return
        const own = GUARD.test(l)
        const near = lines.slice(Math.max(0, i - 12), i + 1).some((x) => /const\s+\w+\s*=[^;]*\??\s*0\b|Math\.max\(|>\s*0\s*\?/.test(x))
        rows.push({ rel, line: i + 1, text: l.trim().slice(0, 120), guarded: own || near })
      })
    }
    return rows
  })()

  it('现查站点总数守恒（新增一处插值就得进这里看过）', () => {
    const n = sites.length
    expect(n, `全仓百分比／角度插值现数 ${n}：\n${sites.map((s) => `  ${s.rel}:${s.line} ${s.text}`).join('\n')}`).toBe(10)
  })

  it('裸插值的名单逐条点名（新增一处裸插值就红；每条还得对上它依赖的那行守卫）', () => {
    const naked = sites.filter((s) => !s.guarded)
    // 名单按 "文件＋那行文本" 对：多一处＝有人新写了一处没兜底的插值，少一处＝登记过期了
    const seen = naked.map((s) => `${s.rel}::${s.text}`).sort()
    const expectSet = NAKED.map((n) => {
      const hit = naked.find((s) => s.rel === n.rel && n.expr.test(s.text))
      expect(hit, `登记里的 ${n.rel}（${n.expr}）没在扫描结果里找到＝这一处已改或已被删，登记要跟着更新`).toBeTruthy()
      return `${hit!.rel}::${hit!.text}`
    }).sort()
    expect(seen, '现数裸插值与名单不等').toEqual(expectSet)
    for (const n of NAKED) {
      const abs = path.join(ROOT, n.upstream)
      expect(fs.existsSync(abs), `登记指向的文件不存在：${n.upstream}`).toBe(true)
      const body = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
      expect(n.nail.test(body), `${n.rel} 依赖的上游守卫（${n.why}）不再长这样——这一处裸插值现在没人兜`).toBe(true)
    }
  })

  it('§358 那一处逐字钉住（分母判 0 在前、算式在后；不许退回去掉 `> 0` 那半）', () => {
    const abs = path.join(ROOT, 'src/renderer/src/modules/settings/UsagePanel.tsx')
    const body = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
    const at = body.indexOf('const maxModelTokens')
    expect(at, 'maxModelTokens 这个名字要在（改名这条判据就悄悄失效）').toBeGreaterThan(-1)
    const win = body.slice(at, at + 400)
    expect(win.indexOf('maxModelTokens > 0 ?'), '分母判 0 得在算式之前').toBeLessThan(win.indexOf('m.totalTokens / maxModelTokens'))
    expect(/maxModelTokens > 0 \?[\s\S]{0,80}:\s*0/.test(win), '零用量那一档要落回 0，不是 NaN').toBe(true)
    expect(/summary\.byModel\[0\]\?\.totalTokens \?\? 0/.test(win), '取最大那份得走可选链＋?? 0（`[0]!` 在空表上是另一颗雷）').toBe(true)
  })
})
