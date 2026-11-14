// 语言 chunk URL 的形状：重试必须换 URL（绕开浏览器 module map 的失败缓存），
// 生产文件名必须与 electron.vite.config.ts 的固定 chunk 名一致。
import { describe, it, expect } from 'vitest'
import { buildLocaleChunkUrl, localeChunkFile } from '../src/renderer/src/i18n/chunk-loader'

describe('语言 chunk URL', () => {
  it('生产态固定文件名，并与 index bundle 同目录', () => {
    expect(localeChunkFile('en', false)).toBe('locale-en.js')
    expect(localeChunkFile('ja', false)).toBe('locale-ja.js')
    expect(localeChunkFile('ko', false)).toBe('locale-ko.js')
    expect(
      buildLocaleChunkUrl('en', 0, false, 'file:///C:/app/out/renderer/assets/index-abc.js')
    ).toBe('file:///C:/app/out/renderer/assets/locale-en.js?retry=0')
  })

  it('每次重试的 URL 都不同', () => {
    const a = buildLocaleChunkUrl('en', 0, false, 'file:///C:/app/out/renderer/assets/index-abc.js')
    const b = buildLocaleChunkUrl('en', 1, false, 'file:///C:/app/out/renderer/assets/index-abc.js')
    expect(a).not.toBe(b)
    expect(a).toContain('retry=0')
    expect(b).toContain('retry=1')
  })

  it('开发态引源码 .ts，由 Vite dev server 转换', () => {
    expect(
      buildLocaleChunkUrl('ja', 2, true, 'http://localhost:5173/src/renderer/src/i18n/chunk-loader.ts')
    ).toBe('http://localhost:5173/src/renderer/src/i18n/ja.ts?retry=2')
  })
})
