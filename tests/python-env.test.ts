// python-env sanitizeRequirements pip 依赖校验测试
//
// 覆盖 src/main/mcp/python-env.ts 的 sanitizeRequirements：
// pip 依赖白名单校验——去空行/注释、超长抛错、拒绝 pip 选项行、
// 拒绝 URL/路径字符、必须字母数字开头、拒绝尾随 --选项、数量上限。
//
// 策略：mock ../portable 避免 electron 初始化，直接测试纯函数。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/portable', () => ({ MCP_EXTENSIONS_DIR: '/mock/ext/mcp' }))

import { sanitizeRequirements } from '../src/main/mcp/python-env'

describe('sanitizeRequirements — pip 依赖校验', () => {
  // ── 正常通过 ──────────────────────────────────────────
  it('简单包名 → 通过', () => {
    expect(sanitizeRequirements(['requests'])).toEqual(['requests'])
  })

  it('包名 + 版本约束 → 通过', () => {
    expect(sanitizeRequirements(['requests>=2.28.0'])).toEqual(['requests>=2.28.0'])
  })

  it('包名 + 精确版本 → 通过', () => {
    expect(sanitizeRequirements(['numpy==1.26.0'])).toEqual(['numpy==1.26.0'])
  })

  it('包名 + extras → 通过', () => {
    expect(sanitizeRequirements(['pytest[all]'])).toEqual(['pytest[all]'])
  })

  it('环境标记 → 通过（含引号数字）', () => {
    expect(sanitizeRequirements(['requests; python_version >= "3.8"'])).toEqual([
      'requests; python_version >= "3.8"'
    ])
  })

  it('多个有效依赖 → 全部通过', () => {
    expect(sanitizeRequirements(['requests', 'numpy==1.26.0', 'pytest>=7.0'])).toEqual([
      'requests',
      'numpy==1.26.0',
      'pytest>=7.0'
    ])
  })

  // ── 过滤空行/注释 ─────────────────────────────────────
  it('空行 → 跳过', () => {
    expect(sanitizeRequirements(['', 'requests', ''])).toEqual(['requests'])
  })

  it('注释行 → 跳过', () => {
    expect(sanitizeRequirements(['# this is a comment', 'requests'])).toEqual(['requests'])
  })

  it('空白行 → 跳过', () => {
    expect(sanitizeRequirements(['   ', 'requests', '\t'])).toEqual(['requests'])
  })

  // ── 安全拒绝 ──────────────────────────────────────────
  it('以 - 开头（pip 选项行）→ 抛错', () => {
    expect(() => sanitizeRequirements(['--index-url https://evil.com'])).toThrow(
      '不允许在依赖中使用 pip 选项'
    )
  })

  it('含 URL（http://）→ 抛错', () => {
    expect(() => sanitizeRequirements(['https://example.com/pkg.tar.gz'])).toThrow(
      '不支持 URL/路径类依赖'
    )
  })

  it('含 git+ → 抛错', () => {
    expect(() => sanitizeRequirements(['git+https://github.com/x/y.git'])).toThrow(
      '不支持 URL/路径类依赖'
    )
  })

  it('含 @ 符号 → 抛错', () => {
    expect(() => sanitizeRequirements(['pkg @ https://example.com/x'])).toThrow(
      '不支持 URL/路径类依赖'
    )
  })

  it('含路径穿越 ../ → 抛错', () => {
    expect(() => sanitizeRequirements(['../evil/pkg'])).toThrow('不支持 URL/路径类依赖')
  })

  it('非字母数字开头 → 抛错', () => {
    expect(() => sanitizeRequirements(['.hidden-pkg'])).toThrow('依赖格式无效')
  })

  it('尾随 --no-deps 选项 → 抛错', () => {
    expect(() => sanitizeRequirements(['pkg --no-deps'])).toThrow('不允许在依赖行中夹带 pip 选项')
  })

  it('尾随带引号的 --trusted-host → 抛错', () => {
    expect(() => sanitizeRequirements(['pkg "--trusted-host=evil.com"'])).toThrow(
      '不允许在依赖行中夹带 pip 选项'
    )
  })

  // ── 长度/数量限制 ─────────────────────────────────────
  it('超过 200 字符 → 抛错', () => {
    const long = 'a'.repeat(201)
    expect(() => sanitizeRequirements([long])).toThrow('依赖描述过长')
  })

  it('恰好 200 字符 → 通过', () => {
    const ok = 'a'.repeat(200)
    expect(sanitizeRequirements([ok])).toEqual([ok])
  })

  it('超过 50 个依赖 → 抛错', () => {
    const many = Array.from({ length: 51 }, (_, i) => `pkg${i}`)
    expect(() => sanitizeRequirements(many)).toThrow('依赖数量不能超过 50')
  })

  it('恰好 50 个依赖 → 通过', () => {
    const ok = Array.from({ length: 50 }, (_, i) => `pkg${i}`)
    expect(sanitizeRequirements(ok)).toHaveLength(50)
  })
})
