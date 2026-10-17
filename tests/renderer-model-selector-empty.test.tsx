// 模型下拉在"服务商有、模型没有"时必须说实话（V4-Iter-115）
//
// 改前：`enabled.length === 0` 才渲染提示项 ⇒ 只要有一家启用的服务商，哪怕它一家模型都没有，
// 下拉就是一个**没有任何选项的空盒子**，用户看到的现象是"模型栏不见了、发不出消息"，
// 而输入框提示还是"请先在设置中配置模型服务商"。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ModelSelector } from '../src/renderer/src/modules/chat/ModelSelector'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ChatTarget, ProviderRecord } from '../src/shared/types'

const provider = (id: string, models: string[], enabled = true): ProviderRecord =>
  ({ id, name: id.toUpperCase(), enabled, models }) as unknown as ProviderRecord

function mount(providers: ProviderRecord[], targets: ChatTarget[], onChange: (next: ChatTarget[]) => void = () => {}) {
  return mountWithProviders(
    <ModelSelector providers={providers} targets={targets} onChange={onChange} />
  )
}

beforeEach(() => {
  stubPocketai({})
})

describe('模型下拉的空态', () => {
  it('正常情形：下拉里是「服务商名 / 模型名」，且当前 target 命中该项', () => {
    mount([provider('glm', ['glm-4.6', 'glm-4-air'])], [{ providerId: 'glm', model: 'glm-4.6' }])
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('GLM / glm-4.6')
    expect(select.value).toBe('glm:glm-4.6')
  })

  it('服务商启用了但模型列表为空 → 提示「无模型，请到设置里拉取」，不是「未配置」', () => {
    mount([provider('glm', [])], [{ providerId: 'glm', model: '' }])
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const texts = Array.from(select.options).map((o) => o.textContent)
    expect(texts).toContain(zh['ms.noModels'])
    expect(texts).not.toContain(zh['ms.notConfigured'])
  })

  it('一家启用的服务商都没有 → 才是「未配置」（无 target 时整条下拉不渲染，只有 + 按钮）', () => {
    mount([provider('glm', ['glm-4.6'], false)], [{ providerId: 'glm', model: 'glm-4.6' }])
    expect(screen.getByText(zh['ms.notConfigured'])).toBeTruthy()
    expect(screen.queryByText(zh['ms.noModels'])).toBeNull()
  })

  it('反向对照：模型列表为空时点「+ 加对照」不会新增空目标；有模型时同一个按钮会加', () => {
    const addBtn = () => screen.getByLabelText(zh['ms.addAllTitle']) as HTMLButtonElement
    const seen: ChatTarget[][] = []
    const first = mount([provider('glm', [])], [{ providerId: 'glm', model: '' }], (next) => seen.push(next))
    expect(addBtn().disabled).toBe(false) // 按钮本身可用，挡的是"加出一个空 model 的目标"
    fireEvent.click(addBtn())
    expect(seen).toEqual([])
    first.unmount()

    const seen2: ChatTarget[][] = []
    mountWithProviders(
      <ModelSelector
        providers={[provider('glm', ['glm-4.6', 'glm-4-air'])]}
        targets={[{ providerId: 'glm', model: 'glm-4.6' }]}
        onChange={(next) => seen2.push(next)}
      />
    )
    fireEvent.click(addBtn())
    expect(seen2).toHaveLength(1)
    expect(seen2[0]).toHaveLength(2)
    expect(seen2[0]![1]!.model).toBe('glm-4-air')
  })
})
