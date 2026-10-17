// formatTraceLedger()（V4-Iter-174）——数据健康「Agent 分步明细」那一行的文案
//
// 钉三件事：① 空态**复用** agent 面板已有的那句（`agent.traceEmpty`），不另造一个新词；
// ② 两个数的顺序（总行数在前、单会话最多在后）与千分位；③ 四语模板都带齐两个占位符、成品句不许留残渣。
import { describe, it, expect } from 'vitest'
import { formatTraceLedger } from '../src/renderer/src/utils/trace-ledger'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const DICTS: Record<string, Record<string, string>> = { zh, en, ja, ko }

const fill = (tpl: string | undefined, vars: Record<string, string>): string =>
  (tpl ?? '').replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '')

const tOf = (d: Record<string, string>) => (key: string, vars?: Record<string, string | number>): string =>
  fill(d[key] ?? '', (vars ?? {}) as Record<string, string>)

describe('formatTraceLedger · 四语', () => {
  for (const [lang, dict] of Object.entries(DICTS)) {
    const t = tOf(dict)

    it(`${lang}：非空时等于该语言模板填好的那两个数（顺序：总行数在前、单会话最多在后）`, () => {
      // 先证明模板真的在（不在的话两边都是空串，下面几条会假绿）
      expect((dict['dh.traces.value'] ?? '').length).toBeGreaterThan(0)
      const s = formatTraceLedger({ rows: 12345, maxRowsInOneConversation: 678 }, t)
      expect(s).toBe(fill(dict['dh.traces.value'], { rows: '12,345', max: '678' }))
      expect(s.indexOf('12,345')).toBeLessThan(s.indexOf('678'))
      expect(s).not.toMatch(/\{rows\}|\{max\}/)
    })

    it(`${lang}：千分位按 en-US 分组（与向量索引那张卡同一口径）`, () => {
      const s = formatTraceLedger({ rows: 1234567, maxRowsInOneConversation: 10000 }, t)
      expect(s).toContain('1,234,567')
      expect(s).toContain('10,000')
    })

    it(`${lang}：rows=0 走 agent.traceEmpty 那句，不摆出「0 步」这种像告警的数`, () => {
      expect((dict['agent.traceEmpty'] ?? '').length).toBeGreaterThan(0)
      const s = formatTraceLedger({ rows: 0, maxRowsInOneConversation: 0 }, t)
      expect(s).toBe(dict['agent.traceEmpty'])
      expect(s).not.toMatch(/0/)
    })

    it(`${lang}：标签与值是两把不同的键（标签不许就是那串数字模板）`, () => {
      expect(dict['dh.traces']).toBeTruthy()
      expect(dict['dh.traces']).not.toBe(dict['dh.traces.value'])
    })
  }

  it('模板里两个占位符都必须存在（少一个 ⇒ 上面那条会红，这里再钉一次原因）', () => {
    for (const dict of Object.values(DICTS)) {
      expect(dict['dh.traces.value']).toContain('{rows}')
      expect(dict['dh.traces.value']).toContain('{max}')
    }
  })
})
