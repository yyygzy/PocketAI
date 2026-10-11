// 运行时日志着色口径：stderr 不等于出错
//
// 钉的是那条真机看到的谎话：官方 server 把启动横幅写到 stderr，一律标红 ⇒
// 「Knowledge Graph MCP Server running on stdio」看起来像报错。
import { describe, it, expect } from 'vitest'
import { logLineTone, logToneClass } from '../src/renderer/src/modules/agent/mcp/log-tone'

describe('logLineTone', () => {
  it('stdout 一律不涂色（无论 server 什么状态）', () => {
    expect(logLineTone('stdout', 'running')).toBe('plain')
    expect(logLineTone('stdout', 'error')).toBe('plain')
    expect(logLineTone('stdout', undefined)).toBe('plain')
  })

  it('server 正常时 stderr 只是警告：启动横幅不该看起来像报错', () => {
    for (const s of ['running', 'starting', 'stopped'] as const) {
      expect(logLineTone('stderr', s)).toBe('warn')
    }
    // 运行时状态还没上报（刚 spawn）同样不能标红
    expect(logLineTone('stderr', undefined)).toBe('warn')
  })

  it('只有该 server 处于 error 态时 stderr 才是 danger', () => {
    expect(logLineTone('stderr', 'error')).toBe('danger')
  })
})

describe('logToneClass', () => {
  it('三档映射到既有 CSS 变量，plain 不加类', () => {
    expect(logToneClass('plain')).toBe('')
    expect(logToneClass('warn')).toBe('text-[var(--color-warning)]')
    expect(logToneClass('danger')).toBe('text-[var(--color-danger)]')
  })

  it('回归：running 的 server 打来的启动横幅，最终 class 不是 danger', () => {
    const cls = logToneClass(logLineTone('stderr', 'running'))
    expect(cls).not.toContain('danger')
  })
})
