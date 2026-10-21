// @vitest-environment jsdom
// §236 技能详情那一屏：常驻开关点下去传什么、自带文件那三张脸、目录导入那颗按钮在不在。
//
// 两条负向判据是这一屏的重点：
//  · 保存失败时不许界面先显示"已经按需了"（徽标必须还是旧的那枚）；
//  · 文件列表"读不到"不许演成"没有自带文件"——那是 §222 那一族反复踩的坑。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { SkillModule } from '../src/renderer/src/modules/skills/SkillModule'
import { SkillMarket } from '../src/renderer/src/modules/skills/SkillMarket'
import { zh } from '../src/renderer/src/i18n/zh'
import type { SkillRecord } from '../src/shared/types'

const skill = (over: Partial<SkillRecord> = {}): SkillRecord =>
  ({
    id: 's1',
    name: '翻译助手',
    description: '专业翻译',
    icon: '🌐',
    content: '忠实原文',
    enabled: true,
    resident: true,
    isBuiltin: false,
    createdAt: 1,
    ...over
  }) as SkillRecord

let skills: SkillRecord[]
let filesResult: unknown
let saveResult: unknown

beforeEach(() => {
  skills = [skill()]
  filesResult = { ok: true, files: [{ path: 'references/api.md', size: 8 }] }
  saveResult = skill()
  stubPocketai({
    listSkills: () => skills,
    syncSkills: () => ({ count: 0, errors: [] }),
    getSkillTemplates: () => [],
    validateSkill: () => ({ ok: true, warnings: [] }),
    saveSkill: () => saveResult,
    deleteSkill: () => ({ ok: true, filesRemoved: false }),
    listSkillFiles: () => filesResult
  })
})

async function openDetail() {
  mountWithProviders(<SkillModule />)
  fireEvent.click(await screen.findByText('翻译助手'))
}

describe('常驻开关', () => {
  it('默认那枚徽标是「常驻中」，点「改为按需」传的是 resident:false（不是顺手把内容也发一遍）', async () => {
    await openDetail()
    expect((await screen.findByTestId('skill-resident-badge')).textContent).toBe(zh['skill.residentOn'])
    fireEvent.click(screen.getByText(zh['skill.makeOnDemand']))
    await waitFor(() => expect(pocketaiCalls().filter((c) => c.fn === 'saveSkill')).toHaveLength(1))
    const call = pocketaiCalls().find((c) => c.fn === 'saveSkill')!
    expect(call.args[0]).toEqual({ id: 's1', name: '翻译助手', resident: false })
  })

  it('保存失败 ⇒ 徽标还停在「常驻中」，并说出失败（不做乐观更新，界面不替主进程抢先承认）', async () => {
    await openDetail()
    await screen.findByTestId('skill-resident-badge')
    saveResult = { ok: false, error: '库被占着' }
    fireEvent.click(screen.getByText(zh['skill.makeOnDemand']))
    expect(await screen.findByText('库被占着')).toBeTruthy()
    expect(screen.getByTestId('skill-resident-badge').textContent).toBe(zh['skill.residentOn'])
  })
})

describe('自带文件那三张脸', () => {
  it('有清单 ⇒ 逐条列出路径，并说一句"模型要靠 load_skill 取它们"', async () => {
    await openDetail()
    const list = await screen.findByTestId('skill-files-list')
    expect(list.textContent).toContain('references/api.md')
    expect(list.textContent).toContain(zh['skill.filesHint'])
    expect(screen.queryByTestId('skill-files-empty')).toBeNull()
  })

  it('确实没有 ⇒ 那一句是"没有自带文件"，不是空白一块', async () => {
    filesResult = { ok: true, files: [] }
    await openDetail()
    expect((await screen.findByTestId('skill-files-empty')).textContent).toBe(zh['skill.filesEmpty'])
  })

  it('读不到 ⇒ 说不"读不到"，且**不许**同时出现"没有自带文件"（这条是负向判据）', async () => {
    filesResult = { ok: false, error: 'SKILL_NOT_FOUND' }
    await openDetail()
    const line = await screen.findByTestId('skill-files-unread')
    expect(line.textContent).toContain(zh['skill.filesUnread'])
    expect(screen.queryByTestId('skill-files-empty')).toBeNull()
    expect(screen.queryByTestId('skill-files-list')).toBeNull()
  })
})

describe('市场那一屏的目录入口', () => {
  it('点「导入技能目录」⇒ 走那条新通道，并把"已按按需导入"与不执行的字段说出来', async () => {
    stubPocketai({
      listSkills: () => skills,
      syncSkills: () => ({ count: 0, errors: [] }),
      getSkillTemplates: () => [],
      validateSkill: () => ({ ok: true, warnings: [] }),
      saveSkill: (rec: Partial<SkillRecord>) => rec as SkillRecord,
      deleteSkill: () => ({ ok: true, filesRemoved: false }),
      listSkillFiles: () => ({ ok: true, files: [] }),
      importSkillFolder: () => ({
        ok: true,
        skill: skill({ id: 'up-1', name: '上游技能' }),
        copied: ['references/api.md'],
        ignoredKeys: ['allowed-tools'],
        forcedOnDemand: true,
        skipped: [{ path: 'scripts/big.bin', reason: 'FILE_TOO_LARGE' }]
      })
    })
    mountWithProviders(<SkillMarket onClose={() => {}} onChanged={async () => skills} />)
    fireEvent.click(await screen.findByTestId('skill-import-folder'))
    const line = await screen.findByText(zh['skill.market.importFolderDone'], { exact: false })
    expect(line.textContent).toContain(zh['skill.market.forcedOnDemand'])
    expect(line.textContent).toContain(
      zh['skill.market.ignoredKeys'].replace('{keys}', 'allowed-tools')
    )
    expect(line.textContent).toContain(zh['skill.market.skippedFiles'].replace('{n}', '1'))
  })
})
