// @vitest-environment jsdom
// 渲染层组件用例（基建首航）：Provider 保存的明文 http 危险确认（SEC-16）
//
// 补的是过去只能靠人眼在应用里点的三类断言：
// 1) 非回环 http 必须先弹危险确认，**确认之前不得落库**；
// 2) 回环 http（Ollama/LM Studio）静默放行；
// 3) 缺协议的远程地址不触发确认（它会被补 https，不是明文风险）。
// 判据口径来自 shared/url-policy，这里验的是「接线」而不只是纯函数。
import { describe, it, expect } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import { ProviderSettings } from '../src/renderer/src/modules/settings/ProviderSettings'

const saved = {
  id: 'p1', type: 'openai-compatible' as const, name: 'T', baseUrl: 'x',
  apiKeys: [], models: [], enabled: true, createdAt: 0
}

function mount(baseUrl: string) {
  stubPocketai({
    listProviders: () => [],
    saveProvider: () => Promise.resolve({ ...saved, baseUrl })
  })
  mountWithProviders(<ProviderSettings />)
  fireEvent.click(screen.getByText('+ 新增'))
  const inputs = document.querySelectorAll('input')
  fireEvent.change(inputs[0]!, { target: { value: '测试服务' } })
  fireEvent.change(inputs[1]!, { target: { value: baseUrl } })
  fireEvent.click(screen.getByText('保存'))
}

describe('Provider 保存的明文 http 确认（SEC-16）', () => {
  it('非回环 http ⇒ 先弹危险确认，且确认前没有调用 saveProvider', async () => {
    mount('http://192.168.1.50:8000/v1')
    expect(await screen.findByText(/http 明文且不是本机回环/)).toBeTruthy()
    expect(calledFns()).not.toContain('saveProvider')
  })

  it('确认后才会落库一次', async () => {
    mount('http://api.example.com/v1')
    await screen.findByText(/http 明文且不是本机回环/)
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(calledFns().filter((f) => f === 'saveProvider')).toHaveLength(1))
  })

  it('取消则不落库', async () => {
    mount('http://api.example.com/v1')
    await screen.findByText(/http 明文且不是本机回环/)
    fireEvent.click(screen.getByText('取消'))
    await new Promise((r) => setTimeout(r, 0))
    expect(calledFns()).not.toContain('saveProvider')
  })

  it('回环 http 静默放行（不打扰本地 Ollama / LM Studio）', async () => {
    mount('http://localhost:11434/v1')
    await waitFor(() => expect(calledFns()).toContain('saveProvider'))
    expect(screen.queryByText(/http 明文且不是本机回环/)).toBeNull()
  })

  it('缺协议的远程地址不弹确认（按 SEC-16 会被补 https）', async () => {
    mount('api.deepseek.com')
    await waitFor(() => expect(calledFns()).toContain('saveProvider'))
    expect(screen.queryByText(/http 明文且不是本机回环/)).toBeNull()
  })

  it('伪装成 localhost 前缀的远程域名仍要确认', async () => {
    mount('http://localhost.evil.example/v1')
    expect(await screen.findByText(/http 明文且不是本机回环/)).toBeTruthy()
    expect(calledFns()).not.toContain('saveProvider')
  })
})
