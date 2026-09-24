// image-service 路径安全与 SSRF 防护测试
//
// 覆盖 src/main/images/image-service.ts 的三个纯函数：
// - resolveDataPath：DB 相对路径 → DATA_DIR 内绝对路径，拒绝穿越/NUL/越界
// - thumbRelOf：图片相对路径 → 缩略图相对路径（images/2026-09/x.png → images/.thumbs/x.jpg）
// - isPrivateHostUrl：图片下载 URL 内网/环回拦截（localhost、私网段、非 http(s)）
//
// 策略：
// - resolveDataPath 依赖 DATA_DIR，vi.mock portable 固定测试路径
// - thumbRelOf / isPrivateHostUrl 为纯函数，直接断言
import { describe, it, expect, vi } from 'vitest'

const { MOCK_DATA_DIR } = vi.hoisted(() => {
  const sep = process.platform === 'win32' ? '\\' : '/'
  return { MOCK_DATA_DIR: ['C:', 'pocketai-test-data'].join(sep) }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: MOCK_DATA_DIR
}))

import { resolveDataPath, thumbRelOf, isPrivateHostUrl } from '../src/main/images/image-service'

describe('resolveDataPath — 图片路径穿越防护', () => {
  it('正常相对路径 → DATA_DIR 下', () => {
    expect(resolveDataPath('images/2026-09/abc.png')).toBe(
      require('node:path').join(MOCK_DATA_DIR, 'images', '2026-09', 'abc.png')
    )
  })

  it('空串 → DATA_DIR 本身', () => {
    expect(resolveDataPath('')).toBe(MOCK_DATA_DIR)
  })

  it('反斜杠自动转正斜杠', () => {
    expect(resolveDataPath('images\\2026-09\\abc.png')).toBe(
      require('node:path').join(MOCK_DATA_DIR, 'images', '2026-09', 'abc.png')
    )
  })

  it('.. 穿越 → 抛错', () => {
    expect(() => resolveDataPath('../etc/passwd')).toThrow()
    expect(() => resolveDataPath('images/../../secret.db')).toThrow()
  })

  it('NUL 注入 → 抛错', () => {
    expect(() => resolveDataPath('images/abc\0.png')).toThrow()
  })

  it('绝对路径越界 → 抛错', () => {
    expect(() => resolveDataPath('C:/Windows/system32')).toThrow()
  })

  it('刚好回到 DATA_DIR（images/..）合法', () => {
    expect(resolveDataPath('images/..')).toBe(MOCK_DATA_DIR)
  })
})

describe('thumbRelOf — 缩略图路径推导', () => {
  it('标准路径 → 同目录 .thumbs 子目录 + .jpg', () => {
    expect(thumbRelOf('images/2026-09/abc.png')).toBe('images/2026-09/.thumbs/abc.jpg')
  })

  it('根目录文件 → ./.thumbs/xxx.jpg', () => {
    expect(thumbRelOf('abc.png')).toBe('./.thumbs/abc.jpg')
  })

  it('多级目录保留层级', () => {
    expect(thumbRelOf('images/2026-09/sub/abc.png')).toBe('images/2026-09/sub/.thumbs/abc.jpg')
  })

  it('不同扩展名统一为 .jpg', () => {
    expect(thumbRelOf('images/x.webp')).toBe('images/.thumbs/x.jpg')
    expect(thumbRelOf('images/x.jpeg')).toBe('images/.thumbs/x.jpg')
    expect(thumbRelOf('images/x.gif')).toBe('images/.thumbs/x.jpg')
  })

  it('无扩展名 → stem.jpg', () => {
    expect(thumbRelOf('images/abc')).toBe('images/.thumbs/abc.jpg')
  })
})

describe('isPrivateHostUrl — 图片 URL SSRF 防护', () => {
  it('公网 http/https → false（允许）', () => {
    expect(isPrivateHostUrl('https://cdn.example.com/img.png')).toBe(false)
    expect(isPrivateHostUrl('http://images.example.com/photo.jpg')).toBe(false)
    expect(isPrivateHostUrl('https://1.2.3.4/img.png')).toBe(false)
  })

  it('localhost → true（拒绝）', () => {
    expect(isPrivateHostUrl('http://localhost/img.png')).toBe(true)
    expect(isPrivateHostUrl('https://localhost:3000/img.png')).toBe(true)
  })

  it('环回 127.x → true', () => {
    expect(isPrivateHostUrl('http://127.0.0.1/img.png')).toBe(true)
    expect(isPrivateHostUrl('http://127.1.2.3/img.png')).toBe(true)
  })

  it('私网段 10.x / 192.168.x / 172.16-31.x → true', () => {
    expect(isPrivateHostUrl('http://10.0.0.1/img.png')).toBe(true)
    expect(isPrivateHostUrl('http://192.168.1.1/img.png')).toBe(true)
    expect(isPrivateHostUrl('http://172.16.0.1/img.png')).toBe(true)
    expect(isPrivateHostUrl('http://172.31.255.255/img.png')).toBe(true)
  })

  it('172.32.x 不在私网段 → false', () => {
    expect(isPrivateHostUrl('http://172.32.0.1/img.png')).toBe(false)
  })

  it('链路本地 169.254.x / 0.x → true', () => {
    expect(isPrivateHostUrl('http://169.254.169.254/latest/meta-data')).toBe(true)
    expect(isPrivateHostUrl('http://0.0.0.0/img.png')).toBe(true)
  })

  it('.local / .internal 域名 → true', () => {
    expect(isPrivateHostUrl('http://nas.local/img.png')).toBe(true)
    expect(isPrivateHostUrl('http://my-pc.internal/img.png')).toBe(true)
  })

  it('IPv6 环回 ::1 → true', () => {
    expect(isPrivateHostUrl('http://[::1]/img.png')).toBe(true)
  })

  it('非 http(s) 协议 → true（拒绝）', () => {
    expect(isPrivateHostUrl('ftp://example.com/img.png')).toBe(true)
    expect(isPrivateHostUrl('file:///etc/passwd')).toBe(true)
    expect(isPrivateHostUrl('data:image/png;base64,xxx')).toBe(true)
  })

  it('非法 URL → true（拒绝）', () => {
    expect(isPrivateHostUrl('not-a-url')).toBe(true)
    expect(isPrivateHostUrl('')).toBe(true)
  })

  it('公网 8.8.8.8 → false', () => {
    expect(isPrivateHostUrl('https://8.8.8.8/img.png')).toBe(false)
  })
})
