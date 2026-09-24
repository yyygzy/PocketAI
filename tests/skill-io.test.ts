// skill-io 技能文件名清理与保存测试
//
// 覆盖 src/main/skills/skill-io.ts 的两个函数：
// - safeFileName：导出文件名净化（去非法字符 / trim / 截 40 / 空值兜底）
// - saveShapeAsSkill：SkillShape → 自定义技能落库（Zod 校验 + isBuiltin=false + 自动 id）
//
// 策略：safeFileName 为纯函数；saveShapeAsSkill 用 vi.hoisted mock skillRepo.save 捕获参数。
// 模块顶层 import electron/skill-parser/safe-fetch，mock 掉避免重依赖。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const savedCalls: Array<Record<string, unknown>> = []
  return {
    savedCalls,
    skillRepo: {
      save: (rec: Record<string, unknown>) => {
        savedCalls.push(rec)
        return { id: 'auto-uuid', isBuiltin: false, enabled: true, ...rec }
      },
      get: () => null,
      list: () => []
    }
  }
})

vi.mock('electron', () => ({ dialog: { showSaveDialog: async () => ({}), showOpenDialog: async () => ({}) } }))
vi.mock('../src/main/db/repositories/skill.repo', () => ({ skillRepo: mocks.skillRepo }))
vi.mock('../src/main/skills/skill-parser', () => ({ parseSkillText: () => ({ shape: null, error: '' }) }))
vi.mock('../src/main/net/safe-fetch', () => ({ safeFetch: async () => ({ status: 200, body: Buffer.alloc(0) }) }))

import { safeFileName, saveShapeAsSkill } from '../src/main/skills/skill-io'
import type { SkillShape } from '../src/main/skills/skill-parser'

beforeEach(() => {
  mocks.savedCalls.length = 0
})

describe('safeFileName — 导出文件名净化', () => {
  it('正常名称 → 原样', () => {
    expect(safeFileName('我的技能')).toBe('我的技能')
  })

  it('去除文件系统非法字符 \\ / : * ? " < > |', () => {
    expect(safeFileName('a\\b/c:d*e?f"g<h>i|j')).toBe('abcdefghij')
  })

  it('前后空白 trim', () => {
    expect(safeFileName('  skill name  ')).toBe('skill name')
  })

  it('超过 40 字符截断', () => {
    const long = 'a'.repeat(50)
    expect(safeFileName(long)).toBe('a'.repeat(40))
  })

  it('恰好 40 字符不截断', () => {
    const name = 'a'.repeat(40)
    expect(safeFileName(name)).toBe(name)
  })

  it('全是非法字符 → 清洗后为空 → 兜底 skill', () => {
    expect(safeFileName('<>:"/\\|?*')).toBe('skill')
  })

  it('空串 → 兜底 skill', () => {
    expect(safeFileName('')).toBe('skill')
  })

  it('纯空白 → 兜底 skill', () => {
    expect(safeFileName('   ')).toBe('skill')
  })

  it('中日韩字符保留', () => {
    expect(safeFileName('技能-测试-v1')).toBe('技能-测试-v1')
  })
})

describe('saveShapeAsSkill — 保存为自定义技能', () => {
  const validShape: SkillShape = {
    name: '测试技能',
    description: '一个测试',
    icon: '🧪',
    content: '你是一个测试助手'
  }

  it('合法 shape → 调用 skillRepo.save 且 enabled=true、不传 id', () => {
    const rec = saveShapeAsSkill(validShape)
    expect(rec.isBuiltin).toBe(false)
    expect(rec.enabled).toBe(true)
    expect(rec.name).toBe('测试技能')
    // save 调用时不传 id（自动生成），isBuiltin 由 skillRepo 默认 false
    const saved = mocks.savedCalls[0]!
    expect(saved).not.toHaveProperty('id')
    expect(saved.enabled).toBe(true)
  })

  it('保存时字段透传 name/description/icon/content', () => {
    saveShapeAsSkill(validShape)
    const saved = mocks.savedCalls[0]!
    expect(saved.name).toBe('测试技能')
    expect(saved.description).toBe('一个测试')
    expect(saved.icon).toBe('🧪')
    expect(saved.content).toBe('你是一个测试助手')
  })

  it('name 为空 → Zod 校验抛错', () => {
    expect(() => saveShapeAsSkill({ ...validShape, name: '' })).toThrow()
  })

  it('缺少必填字段 → Zod 校验抛错', () => {
    expect(() => saveShapeAsSkill({ name: 'x' } as SkillShape)).toThrow()
  })
})
