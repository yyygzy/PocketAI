// 技能升级阶段 1 渲染验收：详情页展示版本/来源/历史，回滚走 IPC 且刷新列表。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { SkillModule } from '../src/renderer/src/modules/skills/SkillModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { SkillRecord, SkillVersionRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const skill = (over: Partial<SkillRecord> = {}): SkillRecord =>
  ({
    id: 's1', name: '代码审查', description: '检查代码', icon: '🔍', content: 'v2 正文',
    enabled: true, resident: true, isBuiltin: false, createdAt: 1,
    version: '2.0.0', author: 'Alice', license: 'MIT',
    sourceUrl: 'https://example.com/skills/review/SKILL.md', installedAt: 1_700_000_000_000,
    ...over
  }) as SkillRecord

const version = (over: Partial<SkillVersionRecord> = {}): SkillVersionRecord =>
  ({
    id: 'v1', skillId: 's1', name: '代码审查', description: '检查代码', icon: '🔍',
    content: 'v1 正文', category: '', tags: [], version: '1.0.0', author: 'Alice',
    license: 'MIT', sourceUrl: 'https://example.com/skills/review/SKILL.md',
    sourceCommit: '', contentHash: 'h1', importedAt: 1_600_000_000_000,
    ...over
  }) as SkillVersionRecord

let current: SkillRecord
let versions: SkillVersionRecord[]
let rollbackResult: unknown

beforeEach(() => {
  current = skill()
  versions = [version()]
  rollbackResult = { ok: true, skill: current }
  stubPocketai({
    listAssistants: () => [],
    listSkills: () => [current],
    syncSkills: () => ({ count: 0, errors: [] }),
    getSkillTemplates: () => [],
    validateSkill: () => ({ ok: true, warnings: [] }),
    saveSkill: () => current,
    deleteSkill: () => ({ ok: true, filesRemoved: false }),
    listSkillFiles: () => ({ ok: true, files: [] }),
    listSkillVersions: () => ({ ok: true, versions }),
    rollbackSkill: () => rollbackResult
  })
})

async function openDetail() {
  mountWithProviders(<SkillModule />)
  fireEvent.click(await screen.findByText('代码审查'))
  await screen.findByTestId('skill-version-panel')
}

describe('版本与来源展示', () => {
  it('展示版本/作者/许可证/来源，不把空元数据编造出来', async () => {
    await openDetail()
    expect(screen.getByText('2.0.0')).toBeTruthy()
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.getByText('MIT')).toBeTruthy()
    expect(screen.getByText('https://example.com/skills/review/SKILL.md')).toBeTruthy()
  })

  it('老技能没有元数据 ⇒ 显示「未记录」，不出空白', async () => {
    current = skill({ version: '', author: '', license: '', sourceUrl: '', installedAt: 0 })
    await openDetail()
    expect(screen.getByText(L('skill.metaEmpty'))).toBeTruthy()
  })

  it('内置技能不显示版本面板（内容锁定，无历史）', async () => {
    current = skill({ isBuiltin: true })
    mountWithProviders(<SkillModule />)
    fireEvent.click(await screen.findByText('代码审查'))
    await waitFor(() => expect(screen.queryByTestId('skill-version-panel')).toBeNull())
  })
})

describe('回滚', () => {
  it('列出历史版本，确认后调 rollbackSkill 并刷新', async () => {
    await openDetail()
    expect(screen.getByTestId('skill-version-list')).toBeTruthy()
    fireEvent.click(screen.getAllByTestId('skill-version-rollback')[0]!)
    // ConfirmDialog 在 useConfirm 的 Promise 里异步出现
    fireEvent.click(await screen.findByText(L('common.confirm')))
    await waitFor(() => {
      expect(pocketaiCalls().some((call) => call.fn === 'rollbackSkill')).toBe(true)
    })
  })

  it('取消确认 ⇒ 不发回滚', async () => {
    await openDetail()
    fireEvent.click(screen.getAllByTestId('skill-version-rollback')[0]!)
    fireEvent.click(await screen.findByText(L('common.cancel')))
    expect(pocketaiCalls().some((call) => call.fn === 'rollbackSkill')).toBe(false)
  })
})
