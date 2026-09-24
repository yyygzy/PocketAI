// SystemPrompt 模板渲染测试
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderPrompt } from '../src/main/assistant/prompt-template'

describe('renderPrompt — 模板变量渲染', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T14:30:00+08:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('空模板返回空串', () => {
    expect(renderPrompt('')).toBe('')
  })

  it('渲染 {{date}} 为 YYYY-MM-DD', () => {
    const out = renderPrompt('今天是 {{date}}')
    expect(out).toMatch(/今天是 \d{4}-\d{2}-\d{2}/)
  })

  it('渲染 {{time}} 为 HH:MM', () => {
    const out = renderPrompt('当前时间 {{time}}')
    expect(out).toMatch(/当前时间 \d{2}:\d{2}/)
  })

  it('渲染 {{user_name}} 为传入的用户名', () => {
    expect(renderPrompt('你好 {{user_name}}', { userName: '张三' })).toBe('你好 张三')
  })

  it('未传 userName 时 {{user_name}} 为空串', () => {
    expect(renderPrompt('你好 {{user_name}}')).toBe('你好 ')
  })

  it('渲染 {{knowledge}} 为传入的知识上下文', () => {
    expect(renderPrompt('知识：{{knowledge}}', { knowledge: '一些知识内容' })).toBe('知识：一些知识内容')
  })

  it('未知变量保持原样不替换', () => {
    expect(renderPrompt('{{unknown_var}} 保持不变')).toBe('{{unknown_var}} 保持不变')
  })

  it('多个变量同时渲染', () => {
    const out = renderPrompt('日期 {{date}}，用户 {{user_name}}', { userName: 'test' })
    expect(out).toMatch(/日期 \d{4}-\d{2}-\d{2}，用户 test/)
  })

  it('模板含 {{skills}} 时直接替换', () => {
    const out = renderPrompt('技能：{{skills}}', { skills: '技能A' })
    expect(out).toBe('技能：技能A')
  })

  it('模板不含 {{skills}} 但有 skills 时自动追加到末尾', () => {
    const out = renderPrompt('你是助手', { skills: '技能列表' })
    expect(out).toContain('你是助手')
    expect(out).toContain('技能列表')
    expect(out.endsWith('技能列表')).toBe(true)
  })

  it('skills 为空串时不自动追加', () => {
    expect(renderPrompt('你是助手', { skills: '' })).toBe('你是助手')
    expect(renderPrompt('你是助手', { skills: '   ' })).toBe('你是助手')
  })

  it('模板已有 {{skills}} 时不重复追加', () => {
    const out = renderPrompt('技能：{{skills}}', { skills: 'S' })
    expect(out).toBe('技能：S')
    expect(out.match(/S/g)?.length).toBe(1)
  })
})
