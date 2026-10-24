// V4-Iter-273：第四面静默名单第六簇——四个清单屏各一发（含"入口整块消失"那一发）。
//
// 名单现查 23 条里这一族占四条（逐条原文 data/tmp/silent-273.json）：
//  · `AssistantMarket.tsx:31` 挂载读助手清单 ⇒ 失败时网格**整片空白**（这一屏原本连「真的没有」那句话都没有）；
//  · `SkillMarket.tsx:51` 挂载读本地技能 ⇒ 「还没有任何技能，点击「导入」或新建一个吧」（＝把故障演成"你一个都没装"，
//    而且这句话正指着市场里那两颗导入键）；
//  · `SkillModule.tsx:366` 挂载读技能模板 ⇒ `!skill && templates.length > 0` 为假 ⇒ **那颗「+ 从模板创建」入口整块不见**
//    （改前那行注释写"保持空列表不影响 UI"，回读 JSX 后确认这条是错的，见台账 §273）；
//  · `UserMemoryPanel.tsx:23` 挂载读用户记忆 ⇒ 「暂无记忆」。
// 四发的出路现查都是"关掉整个弹层／面板再开一次"（各自的 refresh 只在写完东西之后跑），
// 按 §268 判据等于没有出口 ⇒ 四发各配一颗重试键；每颗键都有一条用例点它一次（§271 第 24 条）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AssistantMarket } from '../src/renderer/src/modules/chat/AssistantMarket'
import { SkillMarket } from '../src/renderer/src/modules/skills/SkillMarket'
import { SkillModule } from '../src/renderer/src/modules/skills/SkillModule'
import { UserMemoryPanel } from '../src/renderer/src/modules/settings/UserMemoryPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, SkillRecord, UserMemoryRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const ASSISTANTS_WHAT = L('common.assistantsList')
const SKILLS_WHAT = L('common.skillsList')
const TEMPLATES_WHAT = L('common.skillTemplatesList')
const MEMORY_WHAT = L('set.memory')

const A1 = { id: 'a1', name: 'PROBE-助手', icon: '🤖' } as unknown as AssistantRecord
const S1 = { id: 's1', name: 'PROBE-技能', description: '', icon: '⚡', content: 'c', enabled: true, isBuiltin: false, createdAt: 1 } as unknown as SkillRecord
const T1 = { id: 't1', name: 'PROBE-模板', description: 'd', shape: { name: 'n', description: 'd', icon: '⚡', content: 'c' } } as unknown as { id: string; name: string; description: string; shape: { name: string; description: string; icon: string; content: string } }
const M1 = { id: 'm1', content: 'PROBE-记忆', createdAt: 1, updatedAt: 1 } as unknown as UserMemoryRecord

/** 逐发调用次数：每颗键都要被点一次，并钉"只重发自己那一发" */
const calls = { assistants: 0, skills: 0, templates: 0, memories: 0 }

beforeEach(() => {
  localStorage.clear()
  calls.assistants = 0
  calls.skills = 0
  calls.templates = 0
  calls.memories = 0
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('① 助手市场：那片空白不再演成"你一个助手都没建"', () => {
  const mount = (over: Record<string, (...a: any[]) => unknown> = {}): ReturnType<typeof mountWithProviders> => {
    stubPocketai({
      listAssistants: () => {
        calls.assistants += 1
        return [A1]
      },
      ...over
    })
    return mountWithProviders(<AssistantMarket providers={[]} onClose={() => {}} onChanged={() => {}} />)
  }

  it('读不到 ⇒ 那句上屏并自带一颗键（这一屏没有"点一下就重拉"的格子）', async () => {
    mount({
      listAssistants: () => {
        calls.assistants += 1
        return { ok: false, error: 'ASST:助手通道断了' }
      }
    })
    await waitFor(() => expect(alerts()).toEqual([NAMED(ASSISTANTS_WHAT, 'ASST:助手通道断了')]), MOUNT_BUDGET)
    expect(calls.assistants).toBe(1)
  })

  it('那颗键点了有效：只重发助手这一发，读到即退场、卡片上屏', async () => {
    let fail = true
    mount({
      listAssistants: () => {
        calls.assistants += 1
        return fail ? { ok: false, error: 'ASST:助手通道断了' } : [A1]
      }
    })
    await waitFor(() => expect(alerts()).toHaveLength(1), MOUNT_BUDGET)
    fail = false
    fireEvent.click(screen.getByTestId('assistant-market-assistants-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(calls.assistants, '点一次只多发一次').toBe(2)
    expect(bodyText()).toContain('PROBE-助手')
  })

  it('反向对照：读到 ⇒ 零 alert、卡片照常摆', async () => {
    mount()
    await waitFor(() => expect(bodyText()).toContain('PROBE-助手'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})

describe('② 技能市场本地那一 tab：「还没有任何技能」这张脸让位', () => {
  const mount = (over: Record<string, (...a: any[]) => unknown> = {}): ReturnType<typeof mountWithProviders> => {
    stubPocketai({
      listSkills: () => {
        calls.skills += 1
        return [S1]
      },
      syncSkills: () => ({ count: 0, errors: [] }),
      ...over
    })
    return mountWithProviders(<SkillMarket onClose={() => {}} onChanged={async () => []} />)
  }

  it('读不到 ⇒ 「还没有任何技能…」让位给那句，reject 面也是同一张脸', async () => {
    mount({ listSkills: () => ({ ok: false, error: 'SK:技能通道断了' }) })
    await waitFor(() => expect(alerts()).toEqual([NAMED(SKILLS_WHAT, 'SK:技能通道断了')]), MOUNT_BUDGET)
    expect(screen.queryByText(L('skill.market.empty'))).toBeNull()
  })

  it('那颗键点了有效，而且不去重发别家（这一屏只有本地清单那一发）', async () => {
    let fail = true
    mount({
      listSkills: () => {
        calls.skills += 1
        return fail ? { ok: false, error: 'SK:技能通道断了' } : [S1]
      }
    })
    await waitFor(() => expect(alerts()).toHaveLength(1), MOUNT_BUDGET)
    fail = false
    fireEvent.click(screen.getByTestId('skill-market-skills-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(calls.skills).toBe(2)
    expect(bodyText()).toContain('PROBE-技能')
  })

  it('反向对照：读到 ⇒ 零 alert 且技能卡片在（搜索无结果那句话仍照常摆，两种状态分得开）', async () => {
    mount()
    await waitFor(() => expect(bodyText()).toContain('PROBE-技能'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    fireEvent.change(screen.getByPlaceholderText(L('skill.market.searchPh')), { target: { value: 'zzz' } })
    await waitFor(() => expect(bodyText()).toContain(L('skill.market.noMatch')), MOUNT_BUDGET)
    expect(alerts(), '"没匹配上"不是"读不到"').toEqual([])
  })
})

describe('③ 技能表单的模板那一发：入口整块不见是最隐蔽的一张脸', () => {
  const mountToForm = (over: Record<string, (...a: any[]) => unknown> = {}): void => {
    stubPocketai({
      listSkills: () => [S1],
      syncSkills: () => ({ count: 0, errors: [] }),
      getSkillTemplates: () => {
        calls.templates += 1
        return [T1]
      },
      validateSkill: () => ({ ok: true, warnings: [] }),
      saveSkill: (r) => r,
      ...over
    })
    mountWithProviders(<SkillModule />)
    fireEvent.click(screen.getByText(L('skill.new')))
  }

  it('读不到 ⇒ 那句挂在入口原位，而那颗「+ 从模板创建」确实不出现', async () => {
    mountToForm({ getSkillTemplates: () => ({ ok: false, error: 'TPL:模板通道断了' }) })
    await waitFor(() => expect(alerts()).toEqual([NAMED(TEMPLATES_WHAT, 'TPL:模板通道断了')]), MOUNT_BUDGET)
    expect(screen.queryByText('+ 从模板创建'), '入口不许被读不到吃掉').toBeNull()
  })

  it('那颗键点了有效：读到 ⇒ 那句退场、那颗入口回来', async () => {
    let fail = true
    mountToForm({
      getSkillTemplates: () => {
        calls.templates += 1
        return fail ? { ok: false, error: 'TPL:模板通道断了' } : [T1]
      }
    })
    await waitFor(() => expect(alerts()).toEqual([NAMED(TEMPLATES_WHAT, 'TPL:模板通道断了')]), MOUNT_BUDGET)
    fail = false
    fireEvent.click(screen.getByTestId('skill-form-templates-retry'))
    await waitFor(() => expect(calls.templates).toBe(2), MOUNT_BUDGET)
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(bodyText()).toContain('+ 从模板创建')
  })

  it('读到空列表是真没有 ⇒ 那句不出现（两种"没有"分得开）', async () => {
    mountToForm({
      getSkillTemplates: () => {
        calls.templates += 1
        return []
      }
    })
    await waitFor(() => expect(calls.templates).toBe(1), MOUNT_BUDGET)
    await waitFor(() => expect(bodyText()).toContain(L('skill.new')), MOUNT_BUDGET)
    expect(alerts(), '"库里没有模板"不该被说成读不到').toEqual([])
    expect(screen.queryByTestId('skill-form-templates-retry')).toBeNull()
  })

  it('反向对照：读到两条 ⇒ 零 alert、那颗入口出现', async () => {
    mountToForm()
    await waitFor(() => expect(bodyText()).toContain('+ 从模板创建'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})

describe('④ 用户记忆那一发', () => {
  const mount = (over: Record<string, (...a: any[]) => unknown> = {}): void => {
    stubPocketai({
      listMemories: () => {
        calls.memories += 1
        return [M1]
      },
      ...over
    })
    mountWithProviders(<UserMemoryPanel />)
  }

  it('读不到 ⇒「暂无记忆」让位给那句；reject 面同一张脸', async () => {
    mount({ listMemories: () => ({ ok: false, error: 'MEM:记忆通道断了' }) })
    await waitFor(() => expect(alerts()).toEqual([NAMED(MEMORY_WHAT, 'MEM:记忆通道断了')]), MOUNT_BUDGET)
    expect(screen.queryByText(L('set.memoryEmpty'))).toBeNull()
    expect(bodyText(), '添加那一栏不许被那句吃掉（说实话不等于禁输入）').toContain(L('set.memoryHint'))
  })

  it('那颗键点了有效：只重发记忆这一发', async () => {
    let fail = true
    mount({
      listMemories: () => {
        calls.memories += 1
        return fail ? Promise.reject(new Error('记忆通道断了')) : [M1]
      }
    })
    await waitFor(() => expect(alerts()).toEqual([NAMED(MEMORY_WHAT, '记忆通道断了')]), MOUNT_BUDGET)
    fail = false
    fireEvent.click(screen.getByTestId('user-memory-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(calls.memories, '挂载一次＋点一次').toBe(2)
    expect(bodyText()).toContain('PROBE-记忆')
  })

  it('反向对照：读到 ⇒ 零 alert、条目照常摆', async () => {
    mount()
    await waitFor(() => expect(bodyText()).toContain('PROBE-记忆'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})

// ---------- §292 B160 收口：关掉整个弹层再开 ⇒ 挂载效应在 unmount→mount 时重跑 ----------
// 「这一屏的天然出口是关掉整个弹层再开、代价大到等于没出口」——§273 交付时那句"关掉再开重拉"
// 只在源码级：`AssistantMarket.tsx:31` 与 `SkillMarket.tsx:51` 都在挂载 `useEffect(..., [])` 里读
// 清单，市场面板是条件挂载（父层 `open && <XMarket … />`），关掉就是 unmount、再开就是 remount ⇒
// effect 再跑一次。这条此前没有 CI 读它——有人把清单 store 提升到 Context／全局 memo（§253 那族
// "跨挂载缓存"）或给 effect 加 `if (assistants.length) return` 之类的守卫，两份清单就会停在上一份、
// 用户看不到库里新加的助手／技能，而屏上一句错都不冒。§285 已经在 AssistantEditor 上钉过同形状，
// 这里把两格市场弹层补齐。
describe('⑤ §292 B160：AssistantMarket／SkillMarket 关掉再开 ⇒ 通道各重发一次', () => {
  it('助手市场：挂→等→unmount→重挂 ⇒ listAssistants 从 1 涨到 2', async () => {
    // 借用 describe ① 里同形状的 mount，只是这里要拿 render 结果去 unmount
    const mountAgain = (): ReturnType<typeof mountWithProviders> => {
      stubPocketai({
        listAssistants: () => {
          calls.assistants += 1
          return [A1]
        }
      })
      return mountWithProviders(<AssistantMarket providers={[]} onClose={() => {}} onChanged={() => {}} />)
    }
    const r1 = mountAgain()
    await waitFor(() => expect(calls.assistants).toBe(1), MOUNT_BUDGET)
    r1.unmount()
    mountAgain()
    await waitFor(() => expect(calls.assistants, '关→重开必须重发清单那一发').toBe(2), MOUNT_BUDGET)
  })

  it('技能市场：挂→等→unmount→重挂 ⇒ listSkills 从 1 涨到 2（syncSkills 不参与计数——§273 那两发里只算清单）', async () => {
    const mountAgain = (): ReturnType<typeof mountWithProviders> => {
      stubPocketai({
        listSkills: () => {
          calls.skills += 1
          return [S1]
        },
        syncSkills: () => ({ count: 0, errors: [] })
      })
      return mountWithProviders(<SkillMarket onClose={() => {}} onChanged={async () => []} />)
    }
    const r1 = mountAgain()
    await waitFor(() => expect(calls.skills).toBe(1), MOUNT_BUDGET)
    r1.unmount()
    mountAgain()
    await waitFor(() => expect(calls.skills, '关→重开必须重发清单那一发').toBe(2), MOUNT_BUDGET)
  })
})
