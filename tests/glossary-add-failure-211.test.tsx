// V4-Iter-211：术语表"添加失败也把用户输入清空"（209 从代码里推出、210 在真机读实的那条）
//
// 病根与 196 那一族同源：safeHandle 把失败转成 **resolve 的 `{ok:false}`**，
// 而 `GlossaryPanel.submit()` 只会 catch reject ⇒ 失败路径照样往下走 `setSrc('')/setTgt('')`，
// 注释里那句「失败保留用户输入并提示」于是一直是假的（提示有，是那条 toast；输入却没了）。
// 修法是让 `onAdd` 把"有没有加上"作为布尔交回来。这里真挂载 `TranslateModule`，按行为钉：
// 失败 ⇒ 输入保留 ＋ 不 append 假词条 ＋ toast 那句话；成功 ⇒ 输入清空 ＋ 列表出现该词条（正向对照）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { TranslateModule } from '../src/renderer/src/modules/translate/TranslateModule'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import type { GlossaryTerm } from '../src/shared/types'

const zhD = zh as unknown as Record<string, string>
const enD = en as unknown as Record<string, string>
/** 界面文案一律取字典（拼错 key 就得到 undefined，用例找不到元素即红） */
const L = (lang: 'zh' | 'en', key: string): string => (lang === 'en' ? enD : zhD)[key]!
const rx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const term = (over: Partial<GlossaryTerm> = {}): GlossaryTerm => ({
  id: 'g_1',
  sourceTerm: '人工智能',
  targetTerm: 'Artificial Intelligence',
  createdAt: 1,
  ...over
})

// 非 zh 的字典是**懒加载**的（i18n/index.tsx：加载完成前 t() 回退 zh）⇒ 界面文案一律 findBy 等到位
async function openPanel(lang: 'zh' | 'en'): Promise<void> {
  const name = L(lang, 'translate.glossary.manage').replace('{n}', '0')
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(rx(name)) }))
}

const srcInput = (lang: 'zh' | 'en'): HTMLInputElement =>
  screen.getByPlaceholderText(L(lang, 'translate.glossary.sourcePlaceholder')) as HTMLInputElement
const tgtInput = (lang: 'zh' | 'en'): HTMLInputElement =>
  screen.getByPlaceholderText(L(lang, 'translate.glossary.targetPlaceholder')) as HTMLInputElement

async function fillTerms(source: string, target: string, lang: 'zh' | 'en'): Promise<void> {
  await openPanel(lang)
  fireEvent.change(srcInput(lang), { target: { value: source } })
  fireEvent.change(tgtInput(lang), { target: { value: target } })
  fireEvent.click(screen.getByRole('button', { name: L(lang, 'translate.glossary.add') }))
}

const baseStubs = (saveGlossaryTerm: (...a: any[]) => unknown): Record<string, any> => ({
  listProviders: () => [],
  listTranslations: () => [],
  listGlossary: () => [],
  onTranslateChunk: () => () => {},
  saveGlossaryTerm
})

const toastTexts = (): string[] => screen.queryAllByRole('status').map((e) => e.textContent ?? '')

beforeEach(() => {
  localStorage.clear()
})

describe('失败路径：输入必须留住（注释承诺的那件事现在真的成立）', () => {
  it('zod 自定义文案的失败 ⇒ 两个框仍是用户打的那两个词、列表不多出假词条、toast 逐字给那句中文', async () => {
    stubPocketai(baseStubs(() => ({ ok: false, error: '源术语不能为空' })))
    mountWithProviders(<TranslateModule />)
    await fillTerms('人工智能', 'AI', 'zh')

    await waitFor(() => expect(toastTexts().join('|')).toContain('源术语不能为空'))
    expect(srcInput('zh').value).toBe('人工智能')
    expect(tgtInput('zh').value).toBe('AI')
    // 库里没有 ⇒ 空态那句话还在（失败对象没被 append 成一条假词条）
    expect(screen.queryByText(L('zh', 'translate.glossary.empty'))).not.toBeNull()
  })

  it('带 ipcCode 的失败（209 那个形状）在真组件上换成界面语言，回码不进 DOM，输入同样保留', async () => {
    localStorage.setItem('pocketai.lang', 'en')
    stubPocketai(
      baseStubs(() => ({
        ok: false,
        error: 'sourceTerm过长，最多 200 个字符',
        ipcCode: 'IPC_ARG_INVALID',
        ipcArgs: 'sourceTerm=too_big=string=200'
      }))
    )
    mountWithProviders(<TranslateModule />)
    const long = 'x'.repeat(201)
    await fillTerms(long, 'ok', 'en')

    await waitFor(() => expect(toastTexts().join('|')).toContain('sourceTerm is too long — max 200 characters'))
    const toast = toastTexts().join('|')
    expect(toast).not.toContain('IPC_ARG_INVALID')
    expect(toast).not.toContain('sourceTerm=')
    expect(toast).not.toContain('过长')
    expect(srcInput('en').value).toBe(long)
  })

  it('reject 路径（桥异常）：内联那句「添加失败，请重试」出现，输入也保留', async () => {
    stubPocketai(
      baseStubs(() => {
        throw new Error('桥断了')
      })
    )
    mountWithProviders(<TranslateModule />)
    await fillTerms('人工智能', 'AI', 'zh')

    await waitFor(() => expect(document.body.textContent).toContain(L('zh', 'translate.glossary.addFail')))
    expect(srcInput('zh').value).toBe('人工智能')
  })
})

describe('正向对照：成功仍然清空输入并落进列表（本批只该改失败那一半）', () => {
  it('saveGlossaryTerm 返回记录 ⇒ 两个框变空、列表出现该行、没有 toast', async () => {
    stubPocketai(baseStubs(() => term()))
    mountWithProviders(<TranslateModule />)
    await fillTerms('人工智能', 'Artificial Intelligence', 'zh')

    await waitFor(() => expect(document.body.textContent).toContain('Artificial Intelligence'))
    expect(srcInput('zh').value).toBe('')
    expect(tgtInput('zh').value).toBe('')
    expect(toastTexts().join('|')).toBe('')
    expect(screen.queryByText(L('zh', 'translate.glossary.empty'))).toBeNull()
  })

  it('库里已有的词条不因失败那一趟被挤掉，也不会多出一行新的', async () => {
    stubPocketai({
      ...baseStubs(() => ({ ok: false, error: '源术语不能为空' })),
      listGlossary: () => [term({ id: 'g_0', sourceTerm: '既有条目', targetTerm: 'Existing' })]
    })
    mountWithProviders(<TranslateModule />)
    await openPanel('zh')
    await waitFor(() => expect(document.body.textContent).toContain('既有条目'))

    fireEvent.change(srcInput('zh'), { target: { value: '人工智能' } })
    fireEvent.change(tgtInput('zh'), { target: { value: 'AI' } })
    fireEvent.click(screen.getByRole('button', { name: L('zh', 'translate.glossary.add') }))
    await waitFor(() => expect(toastTexts().join('|')).toContain('源术语不能为空'))

    expect(document.body.textContent).toContain('既有条目')
    expect(document.body.textContent).not.toContain('人工智能')
    expect(document.querySelectorAll('.group')).toHaveLength(1)
  })
})

describe('闸门：那条顺序不许再被写反', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/modules/translate/TranslateModule.tsx'), 'utf-8')
  const start = src.indexOf('const submit = async () => {')
  const body = src.slice(start, start + 400)

  it('submit 里「取 onAdd 的返回值」必须排在清空输入之前，且失败走提前 return', () => {
    expect(start).toBeGreaterThan(-1)
    const used = body.indexOf('await onAdd(')
    const cleared = body.indexOf("setSrc('')")
    expect(used).toBeGreaterThanOrEqual(0)
    expect(cleared).toBeGreaterThan(used)
    expect(body).toMatch(/if \(!\(await onAdd\(src, tgt\)\)\) return/)
  })

  it('onAdd 的契约是 Promise<boolean>（退回 void 就等于把这条链断掉）', () => {
    expect(src).toContain('onAdd: (sourceTerm: string, targetTerm: string) => Promise<boolean>')
    expect(src).toContain('async (sourceTerm: string, targetTermInput: string): Promise<boolean> => {')
  })
})
