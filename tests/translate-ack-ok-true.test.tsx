// 翻译页三枚 ack 通道（清空历史 / 删单条历史 / 删术语）成功时也回 `{ok:true}`。
// 过去用 isIpcFail（只判 `'ok' in v`）会把成功认成失败：库已经清了，屏上却留着旧列表，
// 看起来就是「点清空没反应」。这里真挂载 TranslateModule 按行为钉住，并保留失败侧对照。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { TranslateModule } from '../src/renderer/src/modules/translate/TranslateModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { GlossaryTerm, TranslationRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const toastTexts = (): string[] => screen.queryAllByRole('status').map((e) => e.textContent ?? '')

const HISTORY: TranslationRecord = {
  id: 'h1',
  sourceText: 'PROBE-历史原文',
  targetText: 'PROBE-历史译文',
  sourceLang: 'zh',
  targetLang: 'en',
  style: 'standard',
  providerId: 'p1',
  providerName: 'PROBE-PROVIDER',
  model: 'm1',
  createdAt: 1700000000000
}
const TERM: GlossaryTerm = {
  id: 'g1',
  sourceTerm: 'PROBE-术语',
  targetTerm: 'PROBE-译法',
  createdAt: 1700000000000
}

const baseStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [],
  listTranslations: () => [HISTORY],
  listGlossary: () => [TERM],
  onTranslateChunk: () => () => {},
  clearTranslations: () => ({ ok: true }),
  deleteTranslation: () => ({ ok: true }),
  deleteGlossaryTerm: () => ({ ok: true }),
  ...over
})

async function mountTranslate(over: Record<string, (...a: any[]) => unknown> = {}): Promise<void> {
  stubPocketai(baseStubs(over))
  mountWithProviders(<TranslateModule />)
  await waitFor(() => expect(bodyText()).toContain(HISTORY.sourceText))
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('清空历史：{ok:true} 是成功，不是失败', () => {
  it('确认后列表立即清空、出现空态、零 toast', async () => {
    let clearCalls = 0
    await mountTranslate({
      clearTranslations: () => {
        clearCalls += 1
        return { ok: true }
      }
    })

    fireEvent.click(await screen.findByRole('button', { name: L('translate.history.clear') }))
    fireEvent.click(await screen.findByRole('button', { name: L('common.confirm') }))

    await waitFor(() => expect(bodyText()).not.toContain(HISTORY.sourceText))
    expect(bodyText()).toContain(L('translate.history.empty'))
    expect(toastTexts().join('|')).toBe('')
    expect(clearCalls).toBe(1)
  })

  it('取消确认不发清空，也不动列表', async () => {
    let clearCalls = 0
    await mountTranslate({
      clearTranslations: () => {
        clearCalls += 1
        return { ok: true }
      }
    })

    fireEvent.click(await screen.findByRole('button', { name: L('translate.history.clear') }))
    fireEvent.click(await screen.findByRole('button', { name: L('common.cancel') }))

    expect(clearCalls).toBe(0)
    expect(bodyText()).toContain(HISTORY.sourceText)
  })

  it('失败侧仍要说话，并留住列表', async () => {
    await mountTranslate({ clearTranslations: () => ({ ok: false, error: 'IO:清空失败' }) })

    fireEvent.click(await screen.findByRole('button', { name: L('translate.history.clear') }))
    fireEvent.click(await screen.findByRole('button', { name: L('common.confirm') }))

    await waitFor(() => expect(toastTexts().join('|')).toContain('IO:清空失败'))
    expect(bodyText()).toContain(HISTORY.sourceText)
  })
})

describe('同族 ack 通道：删除也要认 ok:true', () => {
  it('删单条历史后那一行消失', async () => {
    await mountTranslate()

    fireEvent.click(screen.getByTitle(L('translate.history.delete')))

    await waitFor(() => expect(bodyText()).not.toContain(HISTORY.sourceText))
    expect(toastTexts().join('|')).toBe('')
  })

  it('删术语后那一条消失', async () => {
    await mountTranslate()

    fireEvent.click(
      await screen.findByRole('button', { name: L('translate.glossary.manage').replace('{n}', '1') })
    )
    await waitFor(() => expect(bodyText()).toContain(TERM.sourceTerm))
    const row = Array.from(document.querySelectorAll('div.group')).find((el) =>
      (el.textContent ?? '').includes(TERM.sourceTerm)
    )
    expect(row, '术语行在场').toBeTruthy()
    fireEvent.click(row!.querySelector('button')!)

    await waitFor(() => expect(bodyText()).not.toContain(TERM.sourceTerm))
    expect(toastTexts().join('|')).toBe('')
  })
})
