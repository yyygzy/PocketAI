// 技能扫描结果视图：分级渲染、none 不出块、attention 不折叠、四语对等与死键
//
// 这一份只测「怎么呈现」：不改判定、不引入运行期结论。
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { SkillScanReport } from '../src/renderer/src/modules/skills/SkillScanReport'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import type { SkillScanResult } from '../src/shared/skill-scan'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'skills', 'SkillScanReport.tsx'),
  'utf8'
)

const ATTENTION_SCAN: SkillScanResult = {
  level: 'attention',
  counts: { info: 1, notice: 0, attention: 1 },
  scannedChars: 40,
  resourceCount: 1,
  findings: [
    {
      code: 'BINARY_RESOURCE',
      level: 'attention',
      where: 'resource',
      detail: '随包资源含二进制或可执行文件（仅清单事实，未执行）',
      count: 1,
      examples: ['bin/tool.exe']
    },
    {
      code: 'URL_REFERENCE',
      level: 'info',
      where: 'content',
      detail: '正文含外部 URL（仅事实，未访问）',
      count: 1,
      examples: ['https://example.com/a']
    }
  ]
}

const INFO_SCAN: SkillScanResult = {
  level: 'info',
  counts: { info: 1, notice: 0, attention: 0 },
  scannedChars: 12,
  resourceCount: 0,
  findings: [ATTENTION_SCAN.findings[1]!]
}

const IGNORED_SCAN: SkillScanResult = {
  level: 'info',
  counts: { info: 1, notice: 0, attention: 0 },
  scannedChars: 8,
  resourceCount: 0,
  findings: [
    {
      code: 'IGNORED_DECLARATION',
      level: 'info',
      where: 'declaration',
      detail: '这些声明字段本应用不执行',
      count: 2,
      examples: ['allowed-tools', 'compatibility']
    }
  ]
}

const NONE_SCAN: SkillScanResult = {
  level: 'none',
  counts: { info: 0, notice: 0, attention: 0 },
  scannedChars: 20,
  resourceCount: 0,
  findings: []
}

function mount(scan: SkillScanResult, onClose = vi.fn()) {
  stubPocketai()
  return { ...mountWithProviders(<SkillScanReport skillName="PROBE-技能" scan={scan} onClose={onClose} />), onClose }
}

beforeEach(() => {
  localStorage.clear()
})

describe('分级渲染', () => {
  it('attention 与 info 同时平铺显示，attention 排在前面且没有 <details> 折叠', () => {
    const { container } = mount(ATTENTION_SCAN)

    expect(screen.getByTestId('skill-scan-report').getAttribute('data-scan-level')).toBe('attention')
    expect(screen.getByText(L('skill.scan.title'))).toBeTruthy()
    expect(screen.getByText(L('skill.scan.level.attention'))).toBeTruthy()
    expect(screen.getByText(L('skill.scan.level.info'))).toBeTruthy()
    expect(screen.getByText(L('skill.scan.code.BINARY_RESOURCE'))).toBeTruthy()
    expect(screen.getByText(L('skill.scan.code.URL_REFERENCE'))).toBeTruthy()
    expect(screen.getByText('bin/tool.exe')).toBeTruthy()

    // “不藏在折叠里”：整棵子树没有 details/summary
    expect(container.querySelector('details')).toBeNull()
    expect(container.querySelector('summary')).toBeNull()

    const rows = Array.from(container.querySelectorAll('[data-finding-code]'))
    expect(rows.map((r) => r.getAttribute('data-finding-code'))).toEqual([
      'BINARY_RESOURCE',
      'URL_REFERENCE'
    ])
  })

  it('info 级也渲染事实块（只有 none 才不出现）', () => {
    mount(INFO_SCAN)
    expect(screen.getByTestId('skill-scan-report')).toBeTruthy()
    expect(screen.getByText(L('skill.scan.level.info'))).toBeTruthy()
    expect(screen.getByText(L('skill.scan.code.URL_REFERENCE'))).toBeTruthy()
  })
})

describe('none 不出块', () => {
  it('level=none 时整个视图不渲染，也不写空态文案', () => {
    const { container } = mount(NONE_SCAN)
    expect(screen.queryByTestId('skill-scan-report')).toBeNull()
    expect(container.textContent).toBe('')
    expect(container.textContent).not.toContain(L('skill.scan.title'))
  })
})

describe('白名单外声明字段', () => {
  it('显式说明「本应用不执行」，并列出字段名', () => {
    mount(IGNORED_SCAN)
    expect(screen.getByText(L('skill.scan.code.IGNORED_DECLARATION'))).toBeTruthy()
    expect(
      screen.getByText(L('skill.market.ignoredKeys').replace('{keys}', 'allowed-tools, compatibility'))
    ).toBeTruthy()
  })
})

describe('关闭', () => {
  it('关闭键触发 onClose', () => {
    const { onClose } = mount(INFO_SCAN)
    fireEvent.click(screen.getByText(L('skill.scan.close')))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('四语文案', () => {
  const dicts = { zh, en, ja, ko } as Record<string, Record<string, string>>
  const placeholders = (s: string): string[] => Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]!).sort()
  const scanKeys = Object.keys(zh).filter((k) => k.startsWith('skill.scan.'))

  it('skill.scan.* 在四语中 key 集合一致且都非空', () => {
    expect(scanKeys.length).toBe(17)
    for (const [name, dict] of Object.entries(dicts)) {
      expect(Object.keys(dict).filter((k) => k.startsWith('skill.scan.')).sort(), name).toEqual([...scanKeys].sort())
      for (const key of scanKeys) {
        expect(dict[key]?.trim(), `${name}:${key}`).toBeTruthy()
      }
    }
  })

  it('占位符集合一致（当前只有复用 ignoredKeys 的 {keys}）', () => {
    for (const key of scanKeys) {
      const base = placeholders(dicts.zh![key]!)
      for (const [name, dict] of Object.entries(dicts)) {
        expect(placeholders(dict[key]!), `${name}:${key}`).toEqual(base)
      }
    }
  })

  it('措辞守住「候选」或「仅事实」，不写安全结论', () => {
    const expectations: Record<string, RegExp> = {
      zh: /候选|仅事实|仅清单事实/,
      en: /candidate|fact only/i,
      ja: /候補|事実のみ/,
      ko: /후보|사실만/
    }
    for (const [name, dict] of Object.entries(dicts)) {
      for (const key of scanKeys.filter((k) => k.startsWith('skill.scan.code.') && !k.endsWith('IGNORED_DECLARATION'))) {
        expect(dict[key], `${name}:${key}`).toMatch(expectations[name]!)
      }
      expect(dict['skill.scan.code.IGNORED_DECLARATION'], name).toMatch(
        { zh: /本应用不执行/, en: /not executed/, ja: /実行されません/, ko: /실행되지 않음/ }[name]!
      )
      expect(dict['skill.scan.title'], name).not.toMatch(/暂无风险|no risks? found|リスクなし|위험 없음/i)
    }
  })
})

describe('死键与字面量 key', () => {
  it('每个 skill.scan.* key 都以字面量出现在组件源码里', () => {
    for (const key of Object.keys(zh).filter((k) => k.startsWith('skill.scan.'))) {
      expect(SOURCE.includes(`'${key}'`), key).toBe(true)
    }
  })

  it('组件里没有把变量塞进 t() 的动态调用', () => {
    expect(SOURCE).not.toMatch(/t\(\s*[A-Za-z_$]/)
  })
})
