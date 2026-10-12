// 模型服务商表单两处行为（V4-Iter-108）
// ① 点快捷预设 = 开始配一家**新**服务商：不得残留正在编辑那条的名称/Key/缓存模型
//    （残留的后果不是难看，是把 A 家的 Key 发给 B 家的 URL）；
// ② 已缓存模型可逐个移除，且移除是"改这条记录"（保留 id），不是新建。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ProviderSettings } from '../src/renderer/src/modules/settings/ProviderSettings'
import type { ProviderRecord } from '../src/shared/types'

const GLM: ProviderRecord = {
  id: 'p-glm',
  type: 'openai-compatible',
  name: '我的 GLM 账号',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKeys: ['••••st6I'],
  models: ['glm-4.6', 'glm-5'],
  enabled: true,
  createdAt: 1
}

const saved: ProviderRecord[] = []

beforeEach(() => {
  saved.length = 0
  localStorage.clear()
  stubPocketai({
    listProviders: () => [GLM],
    saveProvider: (r) => {
      saved.push(r as ProviderRecord)
      return r
    },
    deleteProvider: () => ({ ok: true }),
    revealProviderKeys: () => ({ apiKeys: ['sk-real-looking-key'] }),
    fetchModels: () => [],
    testProvider: () => ({ ok: true })
  })
})

async function openGlm(): Promise<void> {
  mountWithProviders(<ProviderSettings />)
  fireEvent.click(await screen.findByText('我的 GLM 账号'))
}

const nameInput = (): HTMLInputElement => screen.getByPlaceholderText('例如：我的 DeepSeek')
const keyBox = (): HTMLTextAreaElement => screen.getByPlaceholderText('sk-...')
const baseUrlInput = (): HTMLInputElement => {
  const label = screen.getByText('Base URL')
  return (label.parentElement as HTMLElement).querySelector('input') as HTMLInputElement
}

describe('快捷预设不得残留上一条的信息', () => {
  it('选中已有 provider 后点预设：名称/URL 换成预设，Key 与缓存模型清空，保存走新建', async () => {
    await openGlm()
    // 前置：编辑态确实是那条 GLM
    expect(nameInput().value).toBe('我的 GLM 账号')
    expect(keyBox().value).toBe('••••st6I')

    fireEvent.click(screen.getByText('火山方舟 豆包'))
    await waitFor(() => expect(nameInput().value).toBe('火山方舟 豆包'))
    expect(baseUrlInput().value).toBe('https://ark.cn-beijing.volces.com/api/v3')
    // 关键两条：旧 Key（掩码）与旧缓存模型都不该留下
    expect(keyBox().value).toBe('')
    expect(screen.getByText('暂无，点「拉取模型」')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].id).toBe('') // 不覆盖左边选中那条
    expect(saved[0].apiKeys).toEqual([])
    expect(saved[0].models).toEqual([])
    expect(saved[0].baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
  })

  it('反向对照：直接点左边那条仍是完整回填（清空只发生在点预设时）', async () => {
    await openGlm()
    expect(baseUrlInput().value).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(keyBox().value).toBe('••••st6I')
    expect(screen.getByText('已缓存模型（2）')).toBeTruthy()
    expect(screen.queryByText('暂无，点「拉取模型」')).toBeNull()
  })
})

describe('已缓存模型逐个移除', () => {
  it('点某个模型上的 ✕ → 只剩其余模型，保存时带的是改后的列表且保留原 id', async () => {
    await openGlm()
    fireEvent.click(screen.getByLabelText('从缓存中移除该模型（保存后生效）: glm-4.6'))
    await waitFor(() => expect(screen.queryByText('glm-4.6')).not.toBeTruthy())
    expect(screen.getByText('已缓存模型（1）')).toBeTruthy()
    expect(screen.getByText('glm-5')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].id).toBe('p-glm') // 这是"改这条"，不是新建
    expect(saved[0].models).toEqual(['glm-5'])
  })

  it('全部移完 → 显示空态而不是留一排空 chip', async () => {
    await openGlm()
    fireEvent.click(screen.getByLabelText('从缓存中移除该模型（保存后生效）: glm-4.6'))
    fireEvent.click(screen.getByLabelText('从缓存中移除该模型（保存后生效）: glm-5'))
    await waitFor(() => expect(screen.getByText('已缓存模型（0）')).toBeTruthy())
    expect(screen.getByText('暂无，点「拉取模型」')).toBeTruthy()
  })
})
