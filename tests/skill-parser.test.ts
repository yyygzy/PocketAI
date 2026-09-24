// 技能解析器测试
import { describe, it, expect } from 'vitest'
import {
  parseSkillJson,
  parseSkillMarkdown,
  parseSkillText,
  validateSkillText,
  parseRegistryIndex,
  toBuiltinSkill
} from '../src/main/skills/skill-parser'

describe('parseSkillJson — JSON 技能解析', () => {
  it('扁平格式解析成功', () => {
    const { shape, error } = parseSkillJson(
      JSON.stringify({ name: 'test', description: 'desc', icon: '⚡', content: 'hello world' })
    )
    expect(error).toBe('')
    expect(shape?.name).toBe('test')
    expect(shape?.content).toBe('hello world')
  })

  it('PocketAI 标准格式（format + skill 嵌套）解析成功', () => {
    const { shape, error } = parseSkillJson(
      JSON.stringify({
        format: 'pocketai-skill',
        skill: { name: 'nested', content: 'body content here' }
      })
    )
    expect(error).toBe('')
    expect(shape?.name).toBe('nested')
  })

  it('非法 JSON 返回错误', () => {
    const { shape, error } = parseSkillJson('{invalid json')
    expect(shape).toBeNull()
    expect(error).toContain('JSON 解析失败')
  })

  it('缺少 name 字段返回错误', () => {
    const { shape, error } = parseSkillJson(JSON.stringify({ content: 'body' }))
    expect(shape).toBeNull()
    expect(error).toContain('name')
  })

  it('缺少 content 字段返回错误', () => {
    const { shape, error } = parseSkillJson(JSON.stringify({ name: 'x' }))
    expect(shape).toBeNull()
    expect(error).toContain('content')
  })

  it('content 超过 8KB 返回错误', () => {
    const longContent = 'a'.repeat(9 * 1024)
    const { shape, error } = parseSkillJson(JSON.stringify({ name: 'x', content: longContent }))
    expect(shape).toBeNull()
    expect(error).toContain('过长')
  })

  it('icon 自动截断到 4 字符', () => {
    const { shape } = parseSkillJson(JSON.stringify({ name: 'x', icon: 'abcde', content: 'body' }))
    expect(shape?.icon).toBe('abcd')
  })

  it('元数据字段（version/author/tags/category）透传', () => {
    const { shape } = parseSkillJson(
      JSON.stringify({
        name: 'x',
        content: 'body',
        version: '1.0.0',
        author: 'me',
        category: 'dev',
        tags: ['a', 'b']
      })
    )
    expect(shape?.version).toBe('1.0.0')
    expect(shape?.author).toBe('me')
    expect(shape?.category).toBe('dev')
    expect(shape?.tags).toEqual(['a', 'b'])
  })
})

describe('parseSkillMarkdown — Markdown 技能解析', () => {
  it('带 frontmatter 解析成功', () => {
    const md = `---
name: my-skill
description: 测试技能
icon: 🚀
---
这是技能正文内容。`
    const { shape, error } = parseSkillMarkdown(md)
    expect(error).toBe('')
    expect(shape?.name).toBe('my-skill')
    expect(shape?.icon).toBe('🚀')
    expect(shape?.content).toBe('这是技能正文内容。')
  })

  it('title 兼容 name', () => {
    const md = `---
title: 标题技能
---
正文内容`
    const { shape } = parseSkillMarkdown(md)
    expect(shape?.name).toBe('标题技能')
  })

  it('无 frontmatter 时正文为 content，name 为空→校验失败', () => {
    const { shape, error } = parseSkillMarkdown('纯正文没有 frontmatter')
    expect(shape).toBeNull()
    expect(error).toContain('name')
  })

  it('tags 支持逗号分隔', () => {
    const md = `---
name: t
tags: code, review, test
---
正文内容足够长满足校验`
    const { shape } = parseSkillMarkdown(md)
    expect(shape?.tags).toEqual(['code', 'review', 'test'])
  })

  it('白名单外的 frontmatter 字段被忽略', () => {
    const md = `---
name: t
malicious: injected
---
正文内容`
    const { shape } = parseSkillMarkdown(md)
    expect(shape).not.toHaveProperty('malicious')
  })

  it('带引号字符串正确解析', () => {
    const md = `---
name: "quoted name"
description: 'single quote'
---
正文`
    const { shape } = parseSkillMarkdown(md)
    expect(shape?.name).toBe('quoted name')
    expect(shape?.description).toBe('single quote')
  })
})

describe('parseSkillText — 自动格式检测', () => {
  it('{ 开头走 JSON 解析', () => {
    const { shape } = parseSkillText(JSON.stringify({ name: 'json-skill', content: 'body' }))
    expect(shape?.name).toBe('json-skill')
  })

  it('非 { 开头走 Markdown 解析', () => {
    const md = `---
name: md-skill
---
正文内容`
    const { shape } = parseSkillText(md)
    expect(shape?.name).toBe('md-skill')
  })
})

describe('validateSkillText — 校验+警告', () => {
  it('合法技能返回 ok:true，无警告', () => {
    const result = validateSkillText(JSON.stringify({
      name: 'x', description: 'd', icon: '🤖', content: 'a'.repeat(30)
    }))
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('缺少 description 产生警告', () => {
    const result = validateSkillText(JSON.stringify({
      name: 'x', icon: '🤖', content: 'a'.repeat(30)
    }))
    expect(result.ok).toBe(true)
    expect(result.warnings).toContainEqual(expect.stringContaining('description'))
  })

  it('content 过短产生警告', () => {
    const result = validateSkillText(JSON.stringify({
      name: 'x', description: 'd', icon: '🤖', content: 'short'
    }))
    expect(result.ok).toBe(true)
    expect(result.warnings).toContainEqual(expect.stringContaining('过短'))
  })

  it('非法技能返回 ok:false', () => {
    const result = validateSkillText('not a skill')
    expect(result.ok).toBe(false)
  })
})

describe('parseRegistryIndex — 远程索引解析', () => {
  it('正常解析 skills 数组', () => {
    const text = JSON.stringify({
      skills: [
        { id: 'a', name: 'A', url: 'https://x/a.json' },
        { id: 'b', name: 'B', url: 'https://x/b.json', icon: '🚀' }
      ]
    })
    const { skills, error } = parseRegistryIndex(text)
    expect(error).toBe('')
    expect(skills).toHaveLength(2)
    expect(skills[0]!.id).toBe('a')
    expect(skills[1]!.icon).toBe('🚀')
  })

  it('支持 data 字段兼容', () => {
    const text = JSON.stringify({ data: [{ id: 'a', name: 'A', url: 'u' }] })
    const { skills } = parseRegistryIndex(text)
    expect(skills).toHaveLength(1)
  })

  it('非法 JSON 返回错误', () => {
    const { skills, error } = parseRegistryIndex('bad')
    expect(skills).toEqual([])
    expect(error).toContain('解析失败')
  })

  it('不完整条目被跳过', () => {
    const text = JSON.stringify({
      skills: [
        { id: 'a', name: 'A', url: 'u' },
        { id: 'b' }, // 缺 name 和 url
        { name: 'C', url: 'u' } // 缺 id
      ]
    })
    const { skills } = parseRegistryIndex(text)
    expect(skills).toHaveLength(1)
  })
})

describe('toBuiltinSkill — 转换', () => {
  it('正确映射字段', () => {
    const builtin = toBuiltinSkill('id-1', {
      name: 'n', description: 'd', icon: '⚡', content: 'c'
    })
    expect(builtin).toEqual({ id: 'id-1', name: 'n', description: 'd', icon: '⚡', content: 'c' })
  })
})
