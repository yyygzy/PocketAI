// V4-Iter-326⑤ 挂载用例：目录导入回滚失败那句必须真的上屏。
//
// 为什么不能停在主进程那侧：`importSkillFolder` 回的是 `error` 里的一个码，而渲染层只认
// folderErrorText 里那几个（`CapabilityCenter.tsx`），认不出的一律折叠成通用那句「导入失败」——
// 「码加了、界面没拼进那句」正是 §315 那批被点过名的一步。这一张脸要说的是**列表里留下了一条打不开的记录**，
// 只说"导入失败"用户不会去删那一行。
//
// 迁移说明：原用例挂在 SkillMarket 的导入圈上；该文件 §429 删除后，同一段 keyMap 与同一颗
// `capability-import-folder` 入口都在能力中心，故整组迁到这里，判据不变。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { CapabilityCenter } from '../src/renderer/src/modules/skills/CapabilityCenter'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''

type Impl = (...a: any[]) => unknown

const mountCenter = (importFolder: Impl): void => {
  stubPocketai({
    listSkills: () => [],
    listAssistants: () => [],
    listMcpServers: () => [],
    getMcpRuntimes: () => [],
    getToolPolicy: () => ({ tools: [] }),
    listProviders: () => [],
    onMcpStatus: () => () => {},
    onMcpLog: () => () => {},
    importSkillFolder: importFolder
  })
  mountWithProviders(<CapabilityCenter onClose={() => {}} onChanged={async () => []} />)
}

beforeEach(() => {
  cleanup()
})
afterEach(() => {
  cleanup()
})

/** 走到那颗「导入技能目录」：能力中心首页顶部就有 */
async function clickImportFolder(importFolder: Impl): Promise<void> {
  mountCenter(importFolder)
  await waitFor(() => expect(bodyText()).toContain(L('skill.market.importFolder')))
  fireEvent.click(screen.getByTestId('capability-import-folder'))
}

describe('§326⑤ SKILL_ROW_RESIDUE 那一发', () => {
  it('回这个码 ⇒ 屏上是那句"列表里可能留下一条打不开的记录"，不许被折叠成通用「导入失败」', async () => {
    await clickImportFolder(() => ({ ok: false, error: 'SKILL_ROW_RESIDUE' }))
    await waitFor(() => expect(bodyText()).toContain(L('skill.market.rowResidue')))
    expect(bodyText(), '通用那句会把"要去列表里删一行"这件事整个丢掉').not.toContain(
      L('skill.market.importFailed')
    )
  })

  it('反向对照：认得的旧码仍走旧那一句（新分支不许把别的脸一起改掉）', async () => {
    await clickImportFolder(() => ({ ok: false, error: 'NO_SKILL_MD' }))
    await waitFor(() => expect(bodyText()).toContain(L('skill.market.noSkillMd')))
    expect(bodyText()).not.toContain(L('skill.market.rowResidue'))
  })

  it('反向对照：没登记的码还是折叠成通用那句，且不许把主进程原文贴给用户', async () => {
    await clickImportFolder(() => ({ ok: false, error: '磁盘满了' }))
    await waitFor(() => expect(bodyText()).toContain(L('skill.market.importFailed')))
    expect(bodyText()).not.toContain('磁盘满了')
  })
})
