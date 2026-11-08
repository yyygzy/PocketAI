// @vitest-environment jsdom
// 默认索引地址断言：必须走 GitHub Contents API 且 owner 拼写正确
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { CapabilityCenter } from '../src/renderer/src/modules/skills/CapabilityCenter'

const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('能力中心默认索引', () => {
  it('走 GitHub Contents API，owner 为 yyygzy', async () => {
    const urls: string[] = []
    stubPocketai({
      listSkills: () => [],
      listAssistants: () => [],
      listMcpServers: () => [],
      getMcpRuntimes: () => [],
      getToolPolicy: () => ({ tools: [] }),
      listProviders: () => [],
      onMcpStatus: () => () => {},
      onMcpLog: () => () => {},
      saveSkill: (a: Record<string, unknown>) => a,
      fetchSkillIndex: (url: string) => {
        urls.push(url)
        return { ok: true, skills: [] }
      }
    })
    mountWithProviders(<CapabilityCenter onClose={() => {}} onChanged={async () => []} />)

    fireEvent.click(await screen.findByTestId('capability-online-load', {}, MOUNT_BUDGET))
    await waitFor(() => expect(urls.length).toBe(1), MOUNT_BUDGET)
    expect(urls[0]).toBe(
      'https://api.github.com/repos/yyygzy/skill-registry/contents/index.json?ref=main'
    )
  })
})
