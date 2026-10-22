// V4-Iter-256：绘图页四发的账——三处补上失败面，一处判成「设计内静默」。
//
// 三处收口各自的谎法不一样，所以判据也不一样的形状：
//  · `listImages` 挂载读失败 ⇒ 屏上是空态那句「还没有生成记录…」＝把"没读到"演成"确实一张都没有"；
//    现在补 `galleryFail`，且那一格计数徽标改 `?`（0 会替这次失败报数，同 §250 那颗角标）。
//  · 预览弹窗的 `getImageFile` 失败 ⇒ 以前和"文件确实不在"共用同一张脸（`image.loadFailed`）；
//    现在**三档分开**：读不到／文件确实不在／读到了图，各说各的话（用例逐档对照，断"没有"的那条必须配"有"的那条）。
//  · 生成后懒加载最新大图失败 ⇒ 那一块**永远转「加载中…」**；现在失败就说「读不到：原因」，
//    且只在"仍是最新那次生成"时说话（防串图的那道 `latestIdRef` 守卫没动，只是失败侧也开始说话）。
//  · 生成成功后那发「顺带刷新画廊」判成设计内静默（图与耗时已在最新结果区、flash 已说「生成完成」）
//    ⇒ 不为清零改产品码，源码留理由、闸门 `SILENT_PER_FILE` 按 1 计数。
// 桩按 preload 的真实签名给（`src/preload/index.ts:694/698/699`）：`listImages` 成功回**裸数组**，
// `getImageFile`／`generateImage` 回带 `ok` 的信封——§255 就是栽在这种混合形状上。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ImageModule } from '../src/renderer/src/modules/image/ImageModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ImageListItem, ImageRecord, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())

const PROVIDER: ProviderRecord = {
  id: 'p-img',
  type: 'openai-compatible',
  name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1',
  apiKeys: [],
  models: ['PROBE-MODEL'],
  enabled: true,
  createdAt: 1
}

const record = (over: Partial<ImageRecord> = {}): ImageRecord => ({
  id: 'img-1',
  prompt: 'PROBE-PROMPT',
  model: 'PROBE-MODEL',
  providerId: PROVIDER.id,
  providerName: PROVIDER.name,
  size: '1024x1024',
  fileName: 'images/2026-10/img-1.png',
  bytes: 2048,
  createdAt: 1760000000000,
  ...over
})
const item = (over: Partial<ImageRecord> = {}): ImageListItem => ({ ...record(over), thumbDataUrl: null })

const baseStubs = (over: Record<string, (...a: unknown[]) => unknown> = {}): Record<string, (...a: unknown[]) => unknown> => ({
  listProviders: () => [PROVIDER],
  listImages: () => [],
  abortImage: () => ({ ok: true }),
  ...over
})

/** 画廊标题右边那格计数徽标（读不到时它不许报 0） */
const galleryBadge = (): string => (screen.getByText(L('image.gallery')).parentElement?.textContent ?? '').trim()

describe('① 历史画廊：一条／0 条／读不到，三档互相分辨', () => {
  it('listImages 回 {ok:false} ⇒ 空态那句让位，屏上是「读不到：原因」，计数不报 0', async () => {
    stubPocketai(baseStubs({ listImages: () => ({ ok: false, error: 'IMAGES_DB:库被占用' }) }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(alerts()).toContain(FAILED('IMAGES_DB:库被占用')))
    expect(screen.queryByText(L('image.empty'))).toBeNull()
    expect(galleryBadge()).toContain('?')
    expect(galleryBadge()).not.toContain('0')
  })

  it('反向对照：读到 0 条 ⇒ 空态回来、计数是 0、一个 alert 都不许有', async () => {
    stubPocketai(baseStubs({ listImages: () => [] }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(screen.queryByText(L('image.empty'))).not.toBeNull())
    expect(alerts()).toEqual([])
    expect(galleryBadge()).toBe(`${L('image.gallery')}0`)
  })

  it('反向对照：读到一条 ⇒ 画廊有格子，两句谎话都不出现（空态与读不到）', async () => {
    stubPocketai(baseStubs({ listImages: () => [item()] }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(screen.queryByText(L('image.empty'))).toBeNull())
    expect(alerts()).toEqual([])
    expect(galleryBadge()).toBe(`${L('image.gallery')}1`)
  })

  it('读不到之后清单又到货（生成后那发顺带刷新）⇒ 那句必须收回，不许挂在有数据的屏上', async () => {
    let n = 0
    stubPocketai(baseStubs({
      // 第一次＝挂载读失败；第二次＝生成成功后的顺带刷新 ⇒ 读到那一条
      listImages: () => {
        n += 1
        return n === 1 ? { ok: false, error: 'IMAGES_DB:库被占用' } : [item()]
      },
      generateImage: () => ({ ok: true, record: record(), durationMs: 1000 }),
      getImageFile: () => ({ ok: true, dataUrl: 'data:image/png;base64,PROBE-REFRESH' })
    }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(alerts()).toContain(FAILED('IMAGES_DB:库被占用')))
    await screen.findByText('PROBE-PROVIDER')
    fireEvent.change(screen.getByPlaceholderText(L('image.modelPlaceholder')), { target: { value: 'PROBE-MODEL' } })
    fireEvent.change(screen.getByPlaceholderText(L('image.promptPlaceholder')), { target: { value: 'PROBE-PROMPT' } })
    fireEvent.click(screen.getByRole('button', { name: /生成$/ }))
    await waitFor(() => expect(galleryBadge()).toBe(`${L('image.gallery')}1`))
    expect(alerts()).toEqual([])
    expect(screen.queryByText(L('image.empty'))).toBeNull()
  })
})

describe('② 预览弹窗：读不到／文件确实不在／读到了，三张脸', () => {
  const openPreview = async (fileResult: (...a: unknown[]) => unknown): Promise<void> => {
    stubPocketai(baseStubs({ listImages: () => [item()], getImageFile: fileResult }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(screen.queryByText(L('image.empty'))).toBeNull())
    fireEvent.click(screen.getByTitle('PROBE-PROMPT'))
  }

  it('getImageFile 回 {ok:false} ⇒ 说的是「读不到：原因」，不是那句「文件已不存在」', async () => {
    await openPreview(() => ({ ok: false, error: 'IMG_FILE:磁盘读失败' }))
    await waitFor(() => expect(alerts()).toContain(FAILED('IMG_FILE:磁盘读失败')))
    expect(screen.queryByText(L('image.loadFailed'))).toBeNull()
  })

  it('读到成功但没带回文件 ⇒ 保留原来那句「图片加载失败或文件已不存在」，且没有「读不到」', async () => {
    await openPreview(() => ({ ok: true }))
    await waitFor(() => expect(screen.queryByText(L('image.loadFailed'))).not.toBeNull())
    expect(alerts()).toEqual([])
  })

  it('反向对照：读到 dataUrl ⇒ 图上屏，两句都没有', async () => {
    await openPreview(() => ({ ok: true, dataUrl: 'data:image/png;base64,PROBE-DATA' }))
    await waitFor(() => expect(screen.queryByText(L('image.loadFailed'))).toBeNull())
    expect((screen.getByAltText('PROBE-PROMPT') as HTMLImageElement).src).toContain('PROBE-DATA')
    expect(alerts()).toEqual([])
  })
})

describe('③ 最新结果那一读：失败不许演成「永远加载中」', () => {
  const runGenerate = async (fileResult: (...a: unknown[]) => unknown): Promise<void> => {
    stubPocketai(baseStubs({
      listImages: () => [],
      generateImage: () => ({ ok: true, record: record(), durationMs: 1234 }),
      getImageFile: fileResult
    }))
    mountWithProviders(<ImageModule />)
    // 服务商那发读是异步的：没等到它就点「生成」，`handleGenerate` 会先被「需要先选服务商」拦下（点了等于没点）
    await screen.findByText('PROBE-PROVIDER')
    fireEvent.change(screen.getByPlaceholderText(L('image.modelPlaceholder')), { target: { value: 'PROBE-MODEL' } })
    fireEvent.change(screen.getByPlaceholderText(L('image.promptPlaceholder')), { target: { value: 'PROBE-PROMPT' } })
    fireEvent.click(screen.getByRole('button', { name: /生成$/ }))
  }

  it('生成成功但大图读不到 ⇒ 「读不到：原因」上屏，那句「加载中…」不在场', async () => {
    await runGenerate(() => ({ ok: false, error: 'IMG_LATE:文件还没落盘' }))
    await waitFor(() => expect(alerts()).toContain(FAILED('IMG_LATE:文件还没落盘')))
    expect(screen.queryByText(L('common.loading'))).toBeNull()
  })

  it('反向对照：读到大图 ⇒ img 上屏、没有 alert、也没有「加载中」', async () => {
    await runGenerate(() => ({ ok: true, dataUrl: 'data:image/png;base64,PROBE-LATEST' }))
    await waitFor(() => expect(screen.queryByText(L('common.loading'))).toBeNull())
    expect((screen.getByAltText('PROBE-PROMPT') as HTMLImageElement).src).toContain('PROBE-LATEST')
    expect(alerts()).toEqual([])
  })
})

describe('④ 接线计数：旧写法只剩设计内那一条，且它头上必须还留着理由', () => {
  const SRC = fs
    .readFileSync(path.resolve(__dirname, '../src/renderer/src/modules/image/ImageModule.tsx'), 'utf-8')
    .replace(/\r\n/g, '\n')
  const count = (re: RegExp): number => (SRC.match(re) ?? []).length

  it('三处新落点逐条数得出', () => {
    expect(count(/setGalleryFail\(/g), '画廊：resolve 失败＋清位＋reject').toBe(3)
    expect(count(/setPreviewFail\(/g), '预览：两档清位＋resolve 失败＋reject').toBe(4)
    expect(count(/setLatestFail\(/g), '最新结果：清位＋resolve 失败＋reject').toBe(3)
    expect(count(/LoadFailNotice msg=/g), '三张「读不到」脸').toBe(3)
    expect(count(/gallery\.length === 0 && galleryFail \? '\?' : gallery\.length/g), '读不到且屏上空着时才用 ? 顶替计数').toBe(1)
    expect(count(/gallery\.length === 0 && galleryFail && <LoadFailNotice/g), '那句也只替空屏说话').toBe(1)
  })

  it('旧写法归零，只有设计内那条还在，并且带着 §256 的理由', () => {
    expect(count(/if \(alive && r\.ok && r\.dataUrl\)/g), '预览那处的旧写法必须归零').toBe(0)
    expect(count(/if \(latestIdRef\.current === res\.record\.id && r\.ok && r\.dataUrl\)/g), '最新结果那处的旧写法必须归零').toBe(0)
    expect(count(/if \(!hasIpcFailed\(v\)\) setGallery\(v\)/g), '画廊只剩设计内那发顺带刷新').toBe(1)
    expect(SRC).toContain('// §256 复核：这一发是生成成功之后的「顺带刷新画廊」')
  })
})
