// 模型服务商表单两处行为（V4-Iter-108）
// ① 点快捷预设 = 开始配一家**新**服务商：不得残留正在编辑那条的名称/Key/缓存模型
//    （残留的后果不是难看，是把 A 家的 Key 发给 B 家的 URL）；
// ② 已缓存模型可逐个移除，且移除是"改这条记录"（保留 id），不是新建。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { ProviderSettings } from '../src/renderer/src/modules/settings/ProviderSettings'
import { zh } from '../src/renderer/src/i18n/zh'
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
    testProvider: () => ({ ok: true }),
    // V4-Iter-142：编辑态一挂载就会读判定清单 ⇒ 必须预置，否则共享桩按设计抛错
    listDelegateCapabilities: () => [],
    probeDelegateCapability: () => ({ entry: { capability: 'unknown' }, error: null })
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

// B78 的真 Electron 自测撞出来的一族：safeHandle 的失败是**返回值**，不是 rejection。
// 拉取模型失败那次当场把整个应用渲染成白屏（editing.models 被换成 {ok:false,error} 后 map 炸），
// 另两条是静默假成功（显示密钥失败仍翻成"已显示"、删不掉仍报"已删除"）。
describe('IPC 失败必须被当失败（不是 rejection，也不许当成功）', () => {
  const withStubs = (over: Record<string, (...a: unknown[]) => unknown>) =>
    stubPocketai({
      listProviders: () => [GLM],
      saveProvider: (r) => r,
      deleteProvider: () => ({ ok: true }),
      revealProviderKeys: () => ({ ok: true, apiKeys: ['sk-明文'] }),
      fetchModels: () => ['glm-4.6', 'glm-5'],
      testProvider: () => ({ ok: true }),
      listDelegateCapabilities: () => [],
      probeDelegateCapability: () => ({ entry: { capability: 'unknown' }, error: null }),
      setAgentDelegateEnabled: () => ({ ok: true, error: null, models: [] }),
      ...over
    })

  it('拉取模型返回 {ok:false} ⇒ 报失败，且界面不白屏、原缓存模型还在', async () => {
    withStubs({ fetchModels: () => ({ ok: false, error: '获取模型列表失败: fetch failed' }) })
    await openGlm()
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    expect(await screen.findByText(/拉取失败/)).toBeTruthy()
    // 白屏的反证：这一句在旧代码里已经拿不到了（render 抛错后整棵树没了）
    expect(screen.getByText('已缓存模型（2）')).toBeTruthy()
    expect(screen.getByText('glm-4.6')).toBeTruthy()
  })

  it('显示密钥失败 ⇒ 不许把输入框清空并翻成"已显示"（那是静默假成功）', async () => {
    withStubs({ revealProviderKeys: () => ({ ok: false, error: '隐私锁未解锁' }) })
    await openGlm()
    const before = keyBox().value
    fireEvent.click(screen.getByText(zh['provider.revealKeys']))
    expect(await screen.findByText('隐私锁未解锁')).toBeTruthy()
    expect(keyBox().value).toBe(before)
  })

  it('删除失败 ⇒ 不许报「已删除」，也不许清空编辑态', async () => {
    withStubs({ deleteProvider: () => ({ ok: false, error: '该服务商仍被助手引用' }) })
    await openGlm()
    fireEvent.click(screen.getByText(zh['common.delete']))
    expect(await screen.findByText('该服务商仍被助手引用')).toBeTruthy()
    expect(screen.queryByText(zh['provider.deleted'])).toBeNull()
    expect(screen.getByText('我的 GLM 账号')).toBeTruthy()
  })
})

// V4-Iter-142 的接线半边：徽标组件自己那 7 例证明不了"设置页真的挂上了它、真的按模型逐个挂"
const verdictFor = (providerId: string, model: string) => ({
  key: `${providerId}::${model}`,
  providerId,
  model,
  capability: 'native_tools_ok' as const,
  samples: 3,
  nativeHits: 3,
  digest: '',
  checkedAt: 1,
  stale: false
})

describe('委派能力入口挂在缓存模型那一行', () => {
  it('两条模型 ⇒ 两个探测入口；点第二条交出去的是 (providerId, model) 这一对', async () => {
    await openGlm()
    const buttons = screen.getAllByText(zh['provider.capProbe'])
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1]!)
    const call = pocketaiCalls().find((c) => c.fn === 'probeDelegateCapability')
    expect(call?.args).toEqual(['p-glm', 'glm-5'])
  })

  it('同 provider 的判定显示在对应那一行（含 3/3 计数据）', async () => {
    stubPocketai({
      listProviders: () => [GLM],
      saveProvider: (r) => r,
      deleteProvider: () => ({ ok: true }),
      revealProviderKeys: () => ({ apiKeys: [] }),
      fetchModels: () => [],
      testProvider: () => ({ ok: true }),
      listDelegateCapabilities: () => [verdictFor('p-glm', 'glm-4.6')],
      probeDelegateCapability: () => ({ entry: verdictFor('p-glm', 'glm-4.6'), error: null })
    })
    await openGlm()
    expect(screen.getAllByText(zh['provider.capNative'])).toHaveLength(1)
    expect(screen.getByText(/3\/3/)).toBeTruthy()
  })

  it('反向对照：另一家 provider 的同名判定不许串到这里（键是 providerId::model，不是模型名）', async () => {
    stubPocketai({
      listProviders: () => [GLM],
      saveProvider: (r) => r,
      deleteProvider: () => ({ ok: true }),
      revealProviderKeys: () => ({ apiKeys: [] }),
      fetchModels: () => [],
      testProvider: () => ({ ok: true }),
      listDelegateCapabilities: () => [verdictFor('other', 'glm-4.6')],
      probeDelegateCapability: () => ({ entry: verdictFor('other', 'glm-4.6'), error: null })
    })
    await openGlm()
    expect(screen.queryByText(zh['provider.capNative'])).toBeNull()
  })
})
// —— V4-Iter-172：B44 对账时现查的缺口 ——
// 名称留空点保存时，用户看到的是**渲染端本地**那句「名称与 Base URL 不能为空」
// （IPC 根本不发，所以 IPC 层的中文校验报错在这个入口撞不到）。此前 provider.nameUrlRequired 全仓 0 引用。
describe('名称/URL 留空被本地先拦（V4-Iter-172 补）', () => {
  const savedCalls = (): number => pocketaiCalls().filter((c) => c.fn === 'saveProvider').length

  it('点「+ 新增」后直接保存 ⇒ 就地出那句本地提示，一次 saveProvider 都不发', async () => {
    mountWithProviders(<ProviderSettings />)
    fireEvent.click(await screen.findByText(zh['provider.add']))
    fireEvent.click(screen.getByText(zh['common.save']))
    expect(await screen.findByText(zh['provider.nameUrlRequired'])).toBeTruthy()
    expect(savedCalls()).toBe(0)
  })

  it('只有名称没填（URL 填了）同样要拦——两个字段是"都要有"不是"有一个"', async () => {
    mountWithProviders(<ProviderSettings />)
    fireEvent.click(await screen.findByText(zh['provider.add']))
    const url = (screen.getByText('Base URL').parentElement as HTMLElement).querySelector('input') as HTMLInputElement
    fireEvent.change(url, { target: { value: 'https://example.com/v1' } })
    fireEvent.click(screen.getByText(zh['common.save']))
    expect(await screen.findByText(zh['provider.nameUrlRequired'])).toBeTruthy()
    expect(savedCalls()).toBe(0)
  })

  it('反向对照：名称与 Base URL 都填上，同一条保存就会发出去（拦的是空值不是保存本身）', async () => {
    mountWithProviders(<ProviderSettings />)
    fireEvent.click(await screen.findByText(zh['provider.add']))
    fireEvent.change(nameInput(), { target: { value: '新的一家' } })
    const url = (screen.getByText('Base URL').parentElement as HTMLElement).querySelector('input') as HTMLInputElement
    fireEvent.change(url, { target: { value: 'https://example.com/v1' } })
    fireEvent.click(screen.getByText(zh['common.save']))
    await waitFor(() => expect(savedCalls()).toBe(1))
    expect(screen.queryByText(zh['provider.nameUrlRequired'])).toBeNull()
  })
})
