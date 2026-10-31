// V4-Iter-378（候选 #8）：`formatBytes` 以前把「确实没有」和「读不到」折成同一个 '-'。
//
// 真机现场（§377 第三趟）：清理与 VACUUM 都跑成了、可回收字节是 0 ⇒ 屏上「VACUUM 回收 -」；
// 数据健康屏那六个体积在新装机器上天然全是 0 ⇒ 六格一排 '-'，与"这一项压根没读到"长成同一个串。
// 修法＝helper 分两档（0 ⇒ '0 B'；非有限值／负数 ⇒ '-'）＋ `DataHealthPanel.onClearCache`
// 里那处 `report ? ... : formatBytes(0)`（借 0 当"没有报告"的哨兵，而那颗键只在 `!report` 那道门之后才存在）改成早退。
//
// 判据分三档：①helper 本体（tests/format.test.ts 里拆出来的两档）；
// ②本文件＝真挂载看得到脸（数据健康屏七个体积格＋确认框与回执里那个数）；
// ③steward 那两格由 §377 的挂载文件补一颗（回收 0 字节该说 0 B）。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DataHealthReport } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const T = (key: string, params: Record<string, string | number>): string => {
  let out = L(key)
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, String(v))
  return out
}
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())

/** 全 0 的体积＝新装机器／刚清理完的真实形状（不是为测试编的形状） */
const zeroSizes: DataHealthReport['sizes'] = {
  userDataBytes: 0,
  dbBytes: 0,
  attachmentsBytes: 0,
  extensionsBytes: 0,
  logsBytes: 0,
  otherBytes: 0,
  browserCacheBytes: 0,
  browserCacheFiles: 0
}

const fullReport = (sizes: DataHealthReport['sizes']): DataHealthReport => ({
  sizes,
  traces: { rows: 0, maxRowsInOneConversation: 0 },
  kb: {
    total: 0,
    byStatus: { pending: 0, parsing: 0, indexing: 0, ready: 0, error: 0 },
    errorDocs: [],
    integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
    vectorIndex: { count: 0, dims: [] }
  },
  backup: { configured: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
  tasks: { kbHealthCheckLastRunAt: null, backupVerifyLastRunAt: null },
  boot: { stages: [{ id: 'window', ms: 900 }], totalMs: 900 },
  recentPerf: [],
  perfHistory: []
})

type CacheResult = { beforeBytes: number; afterBytes: number }

async function mount(
  sizes: DataHealthReport['sizes'],
  cacheResult: CacheResult = { beforeBytes: 0, afterBytes: 0 }
): Promise<void> {
  stubPocketai({
    getDataHealth: () => fullReport(sizes),
    openDataFolder: () => ({ ok: true }),
    clearBrowserCache: () => ({ ok: true, ...cacheResult }),
    cleanKbOrphans: () => ({ removedVectors: 0, removedChunks: 0 }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    deduplicateKbDocs: () => ({ removed: 0 })
  })
  mountWithProviders(<DataHealthPanel />)
  await screen.findByText(L('dh.total'))
}

/** 按标签找到那一格：从标签节点往上走到"文本不再只有标签本身"的那一层（卡片与行两种结构共用一套读法） */
const rowText = (label: string): string => {
  let el: HTMLElement | null = screen.getByText(label)
  while (el && (el.textContent ?? '').trim() === label) el = el.parentElement
  expect(el, `「${label}」那一格找不到（往上每一层都只有标签本身）`).not.toBeNull()
  return (el?.textContent ?? '').trim()
}

describe('① 体积那七格：全 0 该说 0 B，不许再借「-」演「读不到」', () => {
  it('新装机器（体积全 0）⇒ 合计／主数据库／附件／扩展／日志／其他／浏览器缓存都写 0 B', async () => {
    await mount(zeroSizes)
    for (const label of [
      L('dh.total'),
      L('dh.db'),
      L('dh.attachments'),
      L('dh.extensions'),
      L('dh.logs'),
      L('dh.other'),
      L('dh.browserCache')
    ]) {
      const text = rowText(label)
      expect(text, `「${label}」那一格没说 0 B`).toContain('0 B')
      expect(text, `「${label}」那一格还在借 '-' 演"读不到"`).not.toMatch(/(^|[^\w.\]])-(?![\w.%])/)
    }
  })

  it('正向对照：真有体积时数字照旧（0 B 这一档不是把单位换算一起改坏）', async () => {
    await mount({
      ...zeroSizes,
      userDataBytes: 20 * 1024 * 1024,
      dbBytes: 8 * 1024 * 1024,
      logsBytes: 512 * 1024
    })
    expect(rowText(L('dh.total'))).toContain('20.0 MB')
    expect(rowText(L('dh.db'))).toContain('8.0 MB')
    expect(rowText(L('dh.logs'))).toContain('512 KB')
    // 附件仍是 0 ⇒ 那一格该说 0 B（同一份屏上两张脸各自对）
    expect(rowText(L('dh.attachments'))).toContain('0 B')
  })
})

describe('② 清理 HTTP 缓存：确认框与回执里的数也不能是「-」', () => {
  it('面板显示 0 B ⇒ 确认框那句「（面板显示 {bytes}）」也说 0 B，不是「显示 -」', async () => {
    await mount(zeroSizes)
    fireEvent.click(screen.getByText(L('dh.browserCache.clear')))
    // 门的到货见证＝确认框那颗「确认」真的在（不是拿"某句本来就在的话"当门）
    await waitFor(() => expect(screen.queryByText(L('common.confirm'))).not.toBeNull())
    const want = T('dh.browserCache.clearConfirm', { bytes: '0 B' })
    const line = [...document.querySelectorAll('p')].map((n) => (n.textContent ?? '').trim()).find((t) => t === want)
    expect(line, '确认框里没有那句逐字的「面板显示 0 B」').toBeTruthy()
  })

  it('清完前后都是 0 ⇒ 成功回执说「已清理：0 B → 0 B」，不再报「- → -」', async () => {
    await mount(zeroSizes)
    fireEvent.click(screen.getByText(L('dh.browserCache.clear')))
    await waitFor(() => expect(screen.queryByText(L('common.confirm'))).not.toBeNull())
    fireEvent.click(screen.getByText(L('common.confirm')))
    const want = T('dh.browserCache.clearDone', { before: '0 B', after: '0 B' })
    await waitFor(() => expect(toasts().join(' '), '回执那句没上屏').toContain(want))
    expect(toasts().join(' ')).not.toContain('- → -')
  })
})
