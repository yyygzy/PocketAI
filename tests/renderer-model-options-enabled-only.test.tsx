// 翻译/绘图的模型选择器只列设置里确认启用的模型（enabledModels 白名单），
// 不再把 /models 拉回来的全量摆给用户挑。这里把三档形状钉住：
//  ① 勾了白名单 ⇒ 只出现白名单里的型号，默认值也落在白名单；
//  ② 老库 enabledModels=null ⇒ 保持"全部启用"，升级零感知；
//  ③ 历史回填的停用模型 ⇒ 保留一条禁用项（看得见但选不了），与 provider 那一格同口径。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { TranslateModule } from '../src/renderer/src/modules/translate/TranslateModule'
import { ImageModule } from '../src/renderer/src/modules/image/ImageModule'
import type { ProviderRecord, TranslationRecord } from '../src/shared/types'

const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const provider = (over: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: 'p1',
  type: 'openai-compatible',
  name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1',
  apiKeys: [],
  models: ['m-all-1', 'm-on', 'm-all-2'],
  enabledModels: ['m-on'],
  enabled: true,
  createdAt: 1,
  ...over
})

const translateStubs = (list: ProviderRecord[], history: TranslationRecord[] = []) => ({
  listProviders: () => list,
  listTranslations: () => history,
  listGlossary: () => [],
  onTranslateChunk: () => () => {},
  translate: () => new Promise(() => {}),
  abortTranslate: () => ({ ok: true })
})

const imageStubs = (list: ProviderRecord[]) => ({
  listProviders: () => list,
  listImages: () => [],
  abortImage: () => ({ ok: true })
})

const translateModelSelect = (): HTMLSelectElement =>
  screen.getByTestId('translate-model-select') as HTMLSelectElement

const imageDataList = (): HTMLDataListElement =>
  document.getElementById('image-model-options') as HTMLDataListElement

const values = (el: HTMLSelectElement | HTMLDataListElement): string[] =>
  Array.from(el.options).map((o) => o.value)

describe('翻译页模型下拉：只列设置里启用的模型', () => {
  it('白名单只勾 m-on ⇒ 下拉只有它、默认值也是它，不摆全量拉取的 m-all-*', async () => {
    stubPocketai(translateStubs([provider()]))
    mountWithProviders(<TranslateModule />)
    await waitFor(() => expect(translateModelSelect().value).toBe('m-on'), MOUNT_BUDGET)
    expect(values(translateModelSelect())).toEqual(['m-on'])
  })

  it('enabledModels=null（老库未配置）⇒ 仍显示全部拉取模型，升级零感知', async () => {
    stubPocketai(translateStubs([provider({ enabledModels: null })]))
    mountWithProviders(<TranslateModule />)
    await waitFor(() => expect(translateModelSelect().value).toBe('m-all-1'), MOUNT_BUDGET)
    expect(values(translateModelSelect())).toEqual(['m-all-1', 'm-on', 'm-all-2'])
  })

  it('enabledModels=[]（全部停用）⇒ 下拉为空态，不给一个能选的模型', async () => {
    stubPocketai(translateStubs([provider({ enabledModels: [] })]))
    mountWithProviders(<TranslateModule />)
    await waitFor(() => expect(translateModelSelect()).not.toBeNull(), MOUNT_BUDGET)
    expect(translateModelSelect().value).toBe('')
    expect(values(translateModelSelect())).toEqual([''])
  })

  it('切换服务商 ⇒ 落到新服务商的启用模型，而不是全量列表第一项', async () => {
    const p2 = provider({ id: 'p2', name: 'PROBE-2', models: ['x-all', 'x-on'], enabledModels: ['x-on'] })
    stubPocketai(translateStubs([provider(), p2]))
    mountWithProviders(<TranslateModule />)
    await waitFor(() => expect(translateModelSelect().value).toBe('m-on'), MOUNT_BUDGET)
    const providerSelect = Array.from(document.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.textContent?.includes('PROBE-2'))
    )
    expect(providerSelect).toBeDefined()
    fireEvent.change(providerSelect!, { target: { value: 'p2' } })
    await waitFor(() => expect(translateModelSelect().value).toBe('x-on'), MOUNT_BUDGET)
    expect(values(translateModelSelect())).toEqual(['x-on'])
  })

  it('历史回填的模型已被停用 ⇒ 保留禁用项显示，但不能再选它', async () => {
    const row: TranslationRecord = {
      id: 'h1',
      sourceText: '旧文',
      targetText: '旧译',
      sourceLang: 'zh',
      targetLang: 'en',
      style: 'standard',
      providerId: 'p1',
      providerName: 'PROBE-PROVIDER',
      model: 'm-all-1',
      createdAt: 1
    }
    stubPocketai(translateStubs([provider()], [row]))
    mountWithProviders(<TranslateModule />)
    await waitFor(() => expect(translateModelSelect().value).toBe('m-on'), MOUNT_BUDGET)
    fireEvent.click(await screen.findByText('旧文'))
    await waitFor(() => expect(translateModelSelect().value).toBe('m-all-1'), MOUNT_BUDGET)
    expect(values(translateModelSelect())).toEqual(['m-all-1', 'm-on'])
    expect(translateModelSelect().options[0]!.disabled).toBe(true)
    expect(translateModelSelect().options[1]!.disabled).toBe(false)
  })
})

describe('绘图页模型 datalist：只列设置里启用的模型', () => {
  it('白名单只勾 m-on ⇒ datalist 只有它，不带出全量拉取的 m-all-*', async () => {
    stubPocketai(imageStubs([provider()]))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(imageDataList()).not.toBeNull(), MOUNT_BUDGET)
    expect(values(imageDataList())).toEqual(['m-on'])
  })

  it('enabledModels=null ⇒ 仍显示全部拉取模型，升级零感知', async () => {
    stubPocketai(imageStubs([provider({ enabledModels: null })]))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(imageDataList()).not.toBeNull(), MOUNT_BUDGET)
    expect(values(imageDataList())).toEqual(['m-all-1', 'm-on', 'm-all-2'])
  })

  it('enabledModels=[] ⇒ datalist 为空，不留任何可选建议', async () => {
    stubPocketai(imageStubs([provider({ enabledModels: [] })]))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(imageDataList()).not.toBeNull(), MOUNT_BUDGET)
    expect(values(imageDataList())).toEqual([])
  })

  it('切换服务商 ⇒ 建议列表换成新服务商的启用模型', async () => {
    const p2 = provider({ id: 'p2', name: 'PROBE-2', models: ['x-all', 'x-on'], enabledModels: ['x-on'] })
    stubPocketai(imageStubs([provider(), p2]))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(imageDataList()).not.toBeNull(), MOUNT_BUDGET)
    const providerSelect = Array.from(document.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.textContent?.includes('PROBE-2'))
    )
    expect(providerSelect).toBeDefined()
    fireEvent.change(providerSelect!, { target: { value: 'p2' } })
    await waitFor(() => expect(values(imageDataList())).toEqual(['x-on']), MOUNT_BUDGET)
    const input = document.querySelector('input[list="image-model-options"]') as HTMLInputElement
    expect(input.value).toBe('x-on')
  })
})
