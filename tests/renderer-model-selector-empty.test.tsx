// 模型选择器空态三分 + 两级选择器（V4-Iter-115 → 模型启用与两级选择方案 P3/P4）
//
// 改前：原生 <select> 里 enabled.length === 0 才渲染提示项 ⇒ 有启用的服务商但没拉模型时
// 下拉是空盒子。现在触发器是按钮（aria-haspopup="listbox"），空态三分：
// 「没配置」/「没拉取」/「拉取了但一个都没启用」各说各话；面板里一级=来源（服务商）、二级=型号。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ModelSelector } from '../src/renderer/src/modules/chat/ModelSelector'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ChatTarget, ProviderRecord } from '../src/shared/types'

const provider = (id: string, models: string[], enabled = true, name?: string): ProviderRecord =>
  ({ id, name: name ?? id.toUpperCase(), enabled, models }) as unknown as ProviderRecord

function mount(providers: ProviderRecord[], targets: ChatTarget[], onChange: (next: ChatTarget[]) => void = () => {}) {
  return mountWithProviders(
    <ModelSelector providers={providers} targets={targets} onChange={onChange} />
  )
}

const trigger = (): HTMLButtonElement => screen.getByRole('button', { name: /·|未配置|无模型|无已启用模型/ }) as HTMLButtonElement

beforeEach(() => {
  stubPocketai({})
})

describe('模型触发器的空态三分', () => {
  it('正常情形：触发器显示「来源 · 型号」，当前 target 命中', () => {
    mount([provider('glm', ['glm-4.6', 'glm-4-air'])], [{ providerId: 'glm', model: 'glm-4.6' }])
    expect(trigger().textContent).toContain('GLM · glm-4.6')
  })

  it('服务商启用了但模型列表为空 → 提示「无模型，请到设置里拉取」，不是「未配置」', () => {
    mount([provider('glm', [])], [{ providerId: 'glm', model: '' }])
    expect(trigger().textContent).toContain(zh['ms.noModels'])
    expect(trigger().textContent).not.toContain(zh['ms.notConfigured'])
  })

  it('有缓存模型但一个都没启用 → 提示「无已启用模型」，不是「没拉取」', () => {
    const p = provider('glm2', ['glm-4.6']) as ProviderRecord & { enabledModels?: string[] | null }
    p.enabledModels = []
    mountWithProviders(
      <ModelSelector providers={[p]} targets={[{ providerId: 'glm2', model: '' }]} onChange={() => {}} />
    )
    expect(screen.getByRole('button', { name: new RegExp(zh['ms.noEnabledModels']) })).toBeTruthy()
  })

  it('一家启用的服务商都没有 → targets 为空时保留一个「未配置」的独立触发器，不整条消失', () => {
    mount([provider('glm', ['glm-4.6'], false)], [])
    expect(screen.getByText(zh['ms.notConfigured'])).toBeTruthy()
    expect(screen.queryByText(zh['ms.noModels'])).toBeNull()
  })
})

describe('两级面板（来源 → 型号）', () => {
  it('打开面板：一级列启用服务商与数量，二级列该来源的启用模型；点二级行选中', () => {
    const seen: ChatTarget[][] = []
    mount(
      [provider('glm', ['glm-4.6', 'glm-4-air']), provider('ds', ['deepseek-chat'], true, 'DeepSeek')],
      [{ providerId: 'glm', model: 'glm-4.6' }],
      (next) => seen.push(next)
    )
    fireEvent.click(trigger())
    // 一级：两个来源各带启用数量
    expect(screen.getByText('GLM（2）')).toBeTruthy()
    expect(screen.getByText('DeepSeek（1）')).toBeTruthy()
    // 二级：当前来源的启用模型
    expect(screen.getAllByText('glm-4.6').length).toBeGreaterThan(0)
    expect(screen.getAllByText('glm-4-air').length).toBeGreaterThan(0)
    // 切来源 → 二级跟着换
    fireEvent.click(screen.getByText('DeepSeek（1）'))
    fireEvent.click(screen.getAllByText('deepseek-chat')[0]!)
    expect(seen).toHaveLength(1)
    expect(seen[0]![0]).toEqual({ providerId: 'ds', model: 'deepseek-chat' })
  })

  it('只列启用集里的模型：显式白名单外的模型不出现', () => {
    const p = provider('glm', ['glm-4.6', 'glm-4-air']) as ProviderRecord & { enabledModels?: string[] | null }
    p.enabledModels = ['glm-4-air']
    mountWithProviders(
      <ModelSelector providers={[p]} targets={[{ providerId: 'glm', model: 'glm-4-air' }]} onChange={() => {}} />
    )
    fireEvent.click(screen.getByRole('button', { name: /GLM · glm-4-air/ }))
    expect(screen.getAllByText('glm-4-air').length).toBeGreaterThan(0)
    expect(screen.queryByText('glm-4.6')).toBeNull()
  })

  it('当前模型已停用 → 触发器保留原值并标「不可用」，不静默换模型', () => {
    const p = provider('glm', ['glm-4.6']) as ProviderRecord & { enabledModels?: string[] | null }
    p.enabledModels = []
    mountWithProviders(
      <ModelSelector providers={[p]} targets={[{ providerId: 'glm', model: 'glm-4.6' }]} onChange={() => {}} />
    )
    const btn = screen.getByRole('button', { name: /glm-4\.6/ })
    expect(btn.textContent).toContain(zh['ms.pickerUnavailable'])
  })

  it('搜索跨来源同名模型：全部来源视图行内标注来源名，两者值不同可分别选中', () => {
    const seen: ChatTarget[][] = []
    mount(
      [
        provider('sf', ['Qwen/Qwen3-8B'], true, '硅基流动'),
        provider('ark', ['Qwen/Qwen3-8B'], true, '火山方舟')
      ],
      [{ providerId: 'sf', model: 'Qwen/Qwen3-8B' }],
      (next) => seen.push(next)
    )
    fireEvent.click(trigger())
    fireEvent.change(screen.getByPlaceholderText(zh['ms.pickerSearchPh']), { target: { value: 'qwen3' } })
    fireEvent.click(screen.getByText(zh['ms.pickerAllSources'].replace('{n}', '2')))
    // 跨来源同名：两行都有，各自带来源名后缀
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('硅基流动')
    expect(rows[1]!.textContent).toContain('火山方舟')
    fireEvent.click(rows[1]!)
    expect(seen[0]![0]).toEqual({ providerId: 'ark', model: 'Qwen/Qwen3-8B' })
  })

  it('搜索无结果 → 显示「没有匹配的模型」并保留搜索词', () => {
    mount([provider('glm', ['glm-4.6'])], [{ providerId: 'glm', model: 'glm-4.6' }])
    fireEvent.click(trigger())
    const input = screen.getByPlaceholderText(zh['ms.pickerSearchPh'])
    fireEvent.change(input, { target: { value: '不存在的型号' } })
    expect(screen.getByText(zh['ms.pickerNoMatch'])).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('不存在的型号')
  })

  it('键盘：↓ 高亮、Enter 选中；Esc 先清搜索、再关面板', () => {
    const seen: ChatTarget[][] = []
    mount([provider('glm', ['glm-4.6', 'glm-4-air'])], [{ providerId: 'glm', model: 'glm-4.6' }], (next) => seen.push(next))
    fireEvent.click(trigger())
    const input = screen.getByPlaceholderText(zh['ms.pickerSearchPh'])
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(seen).toHaveLength(1)
    // 打开 → 输入搜索词 → Esc 清词 → Esc 关面板
    fireEvent.click(trigger())
    fireEvent.change(screen.getByPlaceholderText(zh['ms.pickerSearchPh']), { target: { value: 'glm' } })
    fireEvent.keyDown(screen.getByPlaceholderText(zh['ms.pickerSearchPh']), { key: 'Escape' })
    expect((screen.getByPlaceholderText(zh['ms.pickerSearchPh']) as HTMLInputElement).value).toBe('')
    fireEvent.keyDown(screen.getByPlaceholderText(zh['ms.pickerSearchPh']), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('来源下没有启用模型 → 一级置灰并标注「暂无已启用模型」；选中后右栏给指引而不是空白', () => {
    const empty = provider('bad', ['m1']) as ProviderRecord & { enabledModels?: string[] | null }
    empty.enabledModels = []
    mountWithProviders(
      <ModelSelector
        providers={[provider('glm', ['glm-4.6']), empty]}
        targets={[{ providerId: 'glm', model: 'glm-4.6' }]}
        onChange={() => {}}
      />
    )
    fireEvent.click(trigger())
    expect(screen.getByText(zh['ms.pickerNoEnabled'])).toBeTruthy()
    // 切到没有启用模型的来源 → 右栏给去设置启用的指引
    fireEvent.click(screen.getByText('BAD（0）'))
    expect(screen.getByText(zh['ms.pickerGoSettings'])).toBeTruthy()
  })
})

describe('对照模式的 + 按钮仍按启用集工作', () => {
  it('反向对照：启用集为空时点「+ 加对照」不会新增空目标；有启用模型时同一个按钮会加', () => {
    const addBtn = () => screen.getByLabelText(zh['ms.addAllTitle']) as HTMLButtonElement
    const p = provider('glm', ['glm-4.6', 'glm-4-air']) as ProviderRecord & { enabledModels?: string[] | null }
    const seen: ChatTarget[][] = []

    // 全部停用 → 不加
    const disabledAll = { ...p, enabledModels: [] as string[] }
    const first = mountWithProviders(
      <ModelSelector providers={[disabledAll]} targets={[{ providerId: 'glm', model: '' }]} onChange={(next) => seen.push(next)} />
    )
    fireEvent.click(addBtn())
    expect(seen).toEqual([])
    first.unmount()

    // 启用集里两个 → 加第一个未被占用的
    const enabledTwo = { ...p, enabledModels: ['glm-4.6', 'glm-4-air'] as string[] }
    mountWithProviders(
      <ModelSelector providers={[enabledTwo]} targets={[{ providerId: 'glm', model: 'glm-4.6' }]} onChange={(next) => seen.push(next)} />
    )
    fireEvent.click(addBtn())
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
    expect(seen[0]![1]!.model).toBe('glm-4-air')
  })
})
