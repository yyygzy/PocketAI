// @vitest-environment jsdom
// P1-1 收尾：在线技能安装成功后不再只弹 toast，而是就地进已装技能详情（绑定区同屏）。
// 同时钉住已有的 inline 失败口径：绑定失败只写在详情里，不靠 toast 一闪而过。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { CapabilityCenter } from '../src/renderer/src/modules/skills/CapabilityCenter'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, SkillRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const BUDGET = { timeout: 8000, interval: 50 }

type Impl = (...a: any[]) => unknown

const onlineSkill = (id: string, name: string): unknown => ({
  id,
  name,
  icon: '⚡',
  description: '在线一条',
  url: `https://probe/${id}`
})

let skills: SkillRecord[] = []
const installed: SkillRecord = {
  id: 'imp-1',
  name: 'PROBE-已装',
  icon: '⚡',
  description: '已安装',
  content: '# PROBE',
  enabled: true,
  isBuiltin: false,
  resident: false
} as unknown as SkillRecord

const assistant = {
  id: 'a1',
  name: 'PROBE-助手',
  isBuiltin: false,
  skillIds: []
} as unknown as AssistantRecord

function mount(over: Record<string, Impl> = {}) {
  stubPocketai({
    listSkills: () => skills,
    listAssistants: () => [assistant],
    listMcpServers: () => [],
    getMcpRuntimes: () => [],
    getToolPolicy: () => ({ tools: [] }),
    listProviders: () => [],
    onMcpStatus: () => () => {},
    onMcpLog: () => () => {},
    saveSkill: (a: Record<string, unknown>) => a,
    ...over
  })
  return mountWithProviders(<CapabilityCenter onClose={() => {}} onChanged={async () => skills} />)
}

beforeEach(() => {
  localStorage.clear()
  skills = []
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('P1-1 在线安装直达绑定', () => {
  it('安装成功 ⇒ 同屏出现已装技能详情与绑定区（不再停在在线详情/只 toast）', async () => {
    mount({
      fetchSkillIndex: () => ({ ok: true, skills: [onlineSkill('on-1', 'PROBE-在线')] }),
      importSkillFromUrl: () => {
        skills = [installed]
        return { ok: true, skill: installed }
      }
    })

    fireEvent.click(await screen.findByTestId('capability-online-load', {}, BUDGET))
    await waitFor(() => expect(bodyText()).toContain('PROBE-在线'), BUDGET)

    fireEvent.click(screen.getByText('PROBE-在线'))
    fireEvent.click(await screen.findByText(L('skill.market.importRemote'), {}, BUDGET))

    await waitFor(() => expect(screen.getByText(L('skill.market.bindTitle'))).toBeTruthy(), BUDGET)
    expect(bodyText()).toContain('PROBE-已装')
    expect(screen.queryByText(L('skill.market.importRemote'))).toBeNull()
  })

  it('绑定失败 ⇒ 详情内 inline 可读，不静默', async () => {
    mount({
      fetchSkillIndex: () => ({ ok: true, skills: [onlineSkill('on-1', 'PROBE-在线')] }),
      importSkillFromUrl: () => {
        skills = [installed]
        return { ok: true, skill: installed }
      },
      saveAssistant: () => ({ ok: false, error: 'PROBE-BIND-FAIL' })
    })

    fireEvent.click(await screen.findByTestId('capability-online-load', {}, BUDGET))
    await waitFor(() => expect(bodyText()).toContain('PROBE-在线'), BUDGET)
    fireEvent.click(screen.getByText('PROBE-在线'))
    fireEvent.click(await screen.findByText(L('skill.market.importRemote'), {}, BUDGET))
    await waitFor(() => expect(screen.getByText(L('skill.market.bindTitle'))).toBeTruthy(), BUDGET)

    const bindBtn = document.querySelector('[data-skill-bind="a1"]')
    expect(bindBtn).toBeTruthy()
    await act(async () => {
      fireEvent.click(bindBtn as Element)
    })

    await waitFor(() => {
      const el = screen.getByTestId('capability-bind-error')
      expect(el.textContent).toContain('PROBE-BIND-FAIL')
    }, BUDGET)
  })
})
