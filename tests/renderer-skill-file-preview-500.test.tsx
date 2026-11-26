// 阶段 4 UI：资源清单可点开只读预览；越界错误如实上屏，不演成空白。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { SkillModule } from '../src/renderer/src/modules/skills/SkillModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { SkillRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const skill: SkillRecord = {
  id: 's-preview', name: '带资料的技能', description: '当需要查 API 时使用这条技能',
  icon: '📚', content: '正文', enabled: true, resident: true,
  isBuiltin: false, createdAt: 1
} as SkillRecord

type ReadResult =
  | { ok: true; file: { path: string; content: string; size: number; truncated: boolean; verified: boolean } }
  | { ok: false; error: string }

let readResult: ReadResult

beforeEach(() => {
  readResult = {
    ok: true,
    file: { path: 'references/api.md', content: 'API 说明', size: 8, truncated: false, verified: true }
  }
  stubPocketai({
    listAssistants: () => [],
    listSkills: () => [skill],
    syncSkills: () => ({ count: 0, errors: [] }),
    getSkillTemplates: () => [],
    validateSkill: () => ({ ok: true, warnings: [] }),
    saveSkill: () => skill,
    deleteSkill: () => ({ ok: true, filesRemoved: false }),
    listSkillFiles: () => ({ ok: true, files: [{ path: 'references/api.md', size: 8 }] }),
    readSkillFile: () => readResult,
    listSkillVersions: () => ({ ok: true, versions: [] }),
    rollbackSkill: () => ({ ok: true, skill })
  })
})

async function openPreview() {
  mountWithProviders(<SkillModule />)
  fireEvent.click(await screen.findByText('带资料的技能'))
  await screen.findByTestId('skill-files-list')
  fireEvent.click(screen.getAllByTestId('skill-file-preview')[0]!)
}

describe('技能资源预览', () => {
  it('点清单文件打开只读模态，展示内容、路径与校验状态', async () => {
    await openPreview()
    const modal = await screen.findByTestId('skill-file-preview-modal')
    expect(within(modal).getByTestId('skill-file-preview-content').textContent).toBe('API 说明')
    expect(within(modal).getByText(L('skill.filePreviewVerified'))).toBeTruthy()
    expect(within(modal).getByText(new RegExp('references/api\\.md'))).toBeTruthy()
    fireEvent.click(screen.getByTestId('skill-file-preview-close'))
    expect(screen.queryByTestId('skill-file-preview-modal')).toBeNull()
  })

  it('读文件失败时显示错误而不是空白模态', async () => {
    readResult = { ok: false, error: '只允许读取技能自带的 references/ 或 assets/ 下的文本文件' }
    await openPreview()
    expect(await screen.findByTestId('skill-file-preview-error')).toBeTruthy()
    expect(screen.queryByTestId('skill-file-preview-modal')).toBeNull()
  })
})
