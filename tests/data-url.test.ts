// 图片 data URL 解析纯函数测试：MIME 白名单、字节上限、默认文件名清洗
import { describe, it, expect } from 'vitest'
import { parseImageDataUrl, defaultImageFileName } from '../src/main/images/data-url'

function dataUrl(mime: string, bytes: number | Buffer, fill = 0): string {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(bytes, fill)
  return `data:${mime};base64,${buf.toString('base64')}`
}

describe('parseImageDataUrl', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/bmp', 'bmp']
  ])('合法 %s → ext=%s 且字节往返一致', (mime, ext) => {
    const buf = Buffer.from([1, 2, 3, 4, 5, 255, 0])
    const r = parseImageDataUrl(dataUrl(mime, buf))
    expect(r.mime).toBe(mime)
    expect(r.ext).toBe(ext)
    expect(r.buffer.equals(buf)).toBe(true)
  })

  it('容忍 base64 中的空白换行', () => {
    const raw = Buffer.alloc(8, 0x41).toString('base64')
    const spaced = raw.replace(/(.{4})/g, '$1\n ')
    const r = parseImageDataUrl(`data:image/png;base64,${spaced}`)
    expect(r.buffer.length).toBe(8)
  })

  it('非字符串/空串抛错', () => {
    expect(() => parseImageDataUrl('')).toThrow()
    // @ts-expect-error 故意传非法类型
    expect(() => parseImageDataUrl(null)).toThrow()
  })

  it('MIME 不在白名单（image/svg+xml / text/plain）抛错', () => {
    expect(() => parseImageDataUrl('data:image/svg+xml;base64,' + Buffer.from('<svg>').toString('base64'))).toThrow()
    expect(() => parseImageDataUrl('data:text/plain;base64,' + Buffer.from('x').toString('base64'))).toThrow()
    expect(() => parseImageDataUrl('http://example.com/a.png')).toThrow()
  })

  it('空 base64 内容抛错', () => {
    expect(() => parseImageDataUrl('data:image/png;base64,')).toThrow()
  })

  it('超 maxBytes 抛错（解码后字节精校）', () => {
    const big = Buffer.alloc(100, 0)
    expect(() => parseImageDataUrl(dataUrl('image/png', big), 50)).toThrow()
  })

  it('默认上限 12MB：13MB 抛错，1MB 通过', () => {
    expect(() => parseImageDataUrl(dataUrl('image/png', Buffer.alloc(13 * 1024 * 1024)))).toThrow()
    expect(parseImageDataUrl(dataUrl('image/jpeg', Buffer.alloc(1024 * 1024)))).toBeTruthy()
  })
})

describe('defaultImageFileName', () => {
  it('无扩展名时按 mime 补；已有扩展名保留', () => {
    expect(defaultImageFileName('截图', 'png')).toBe('截图.png')
    expect(defaultImageFileName('photo.jpg', 'jpg')).toBe('photo.jpg')
  })
  it('空名兜底 image；路径/非法字符清洗防穿越', () => {
    expect(defaultImageFileName(undefined, 'webp')).toBe('image.webp')
    expect(defaultImageFileName('  ', 'gif')).toBe('image.gif')
    const cleaned = defaultImageFileName('../../etc/passwd?.png', 'png')
    expect(cleaned).not.toContain('..')
    expect(cleaned).not.toContain('/')
    expect(cleaned).not.toContain('\\')
  })
})
