// 自定义 pip 镜像源的合法性（SEC-20，src/shared/schemas/mcp.ts 单一来源）
//
// 主进程 setPipSource 与渲染端表单都用同一把尺，这里钉住判定边界：
// https 放行、本机回环 http 例外、其余（明文远端/其它协议/畸形 URL）拒绝。
import { describe, it, expect } from 'vitest'
import { isAllowedPipSourceUrl, pythonPipSourceSchema } from '../src/shared/schemas/mcp'

describe('isAllowedPipSourceUrl', () => {
  it('https 镜像放行', () => {
    for (const url of [
      'https://pypi.tuna.tsinghua.edu.cn/simple',
      'https://mirrors.example.com/pypi/simple/',
      'https://nexus.corp.internal/repository/pypi/simple'
    ]) {
      expect(isAllowedPipSourceUrl(url), url).toBe(true)
    }
  })

  it('http 仅本机回环例外', () => {
    expect(isAllowedPipSourceUrl('http://localhost:8080/simple')).toBe(true)
    expect(isAllowedPipSourceUrl('http://127.0.0.1:8080/simple')).toBe(true)
    expect(isAllowedPipSourceUrl('http://[::1]:8080/simple')).toBe(true)
    // 明文远端：中继/DNS 劫持可静默投递任意 wheel → 拒
    expect(isAllowedPipSourceUrl('http://pypi.example.com/simple')).toBe(false)
    expect(isAllowedPipSourceUrl('http://192.168.1.10/simple')).toBe(false)
  })

  it('其它协议与畸形输入拒绝', () => {
    for (const url of ['', '   ', 'not a url', 'ftp://x/y', 'file:///C:/wheels', 'pypi.org/simple']) {
      expect(isAllowedPipSourceUrl(url), url).toBe(false)
    }
  })

  it('凭证内嵌的 URL 不因 user:pass@ 前缀被误放行', () => {
    expect(isAllowedPipSourceUrl('http://user:pass@evil.example/simple')).toBe(false)
    expect(isAllowedPipSourceUrl('https://user:pass@mirrors.example/simple')).toBe(true)
  })
})

describe('pythonPipSourceSchema', () => {
  it('两个预置源永远合法', () => {
    expect(pythonPipSourceSchema.safeParse('official').success).toBe(true)
    expect(pythonPipSourceSchema.safeParse('tuna').success).toBe(true)
  })

  it('自定义源走同一校验，失败给出可读原因', () => {
    expect(pythonPipSourceSchema.safeParse('https://mirrors.example/simple').success).toBe(true)
    const bad = pythonPipSourceSchema.safeParse('http://mirrors.example/simple')
    expect(bad.success).toBe(false)
  })

  it('非字符串与未知枚举拒绝', () => {
    expect(pythonPipSourceSchema.safeParse('aliyun').success).toBe(false)
    expect(pythonPipSourceSchema.safeParse(42).success).toBe(false)
    expect(pythonPipSourceSchema.safeParse(null).success).toBe(false)
  })
})
