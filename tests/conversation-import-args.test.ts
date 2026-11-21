// CONVERSATION_IMPORT_EXTERNAL 入参 schema 测试（Iter-76 归属助手扩展）
import { describe, it, expect } from 'vitest'
import { conversationImportExternalArgsSchema } from '../src/shared/schemas/conversations'

const validFiles = [{ name: 'conversations.json', text: '[]' }]

describe('conversationImportExternalArgsSchema', () => {
  it('合法：files + assistantId', () => {
    const r = conversationImportExternalArgsSchema.safeParse({
      files: validFiles,
      assistantId: 'asst-abc'
    })
    expect(r.success).toBe(true)
  })

  it('合法：assistantId 为 null 或缺省（自由会话）', () => {
    expect(
      conversationImportExternalArgsSchema.safeParse({ files: validFiles, assistantId: null }).success
    ).toBe(true)
    expect(conversationImportExternalArgsSchema.safeParse({ files: validFiles }).success).toBe(true)
  })

  it('拒绝：files 为空数组 / 超过 10 个', () => {
    expect(conversationImportExternalArgsSchema.safeParse({ files: [] }).success).toBe(false)
    expect(
      conversationImportExternalArgsSchema.safeParse({
        files: Array.from({ length: 11 }, () => validFiles[0]!)
      }).success
    ).toBe(false)
  })

  it('拒绝：name 为空', () => {
    expect(
      conversationImportExternalArgsSchema.safeParse({ files: [{ name: '', text: 'x' }] }).success
    ).toBe(false)
  })

  it('拒绝：text 超 30MB', () => {
    expect(
      conversationImportExternalArgsSchema.safeParse({
        files: [{ name: 'a.json', text: 'x'.repeat(30 * 1024 * 1024 + 1) }]
      }).success
    ).toBe(false)
  })

  it('拒绝：assistantId 空串 / 超 200 字符', () => {
    expect(
      conversationImportExternalArgsSchema.safeParse({ files: validFiles, assistantId: '' }).success
    ).toBe(false)
    expect(
      conversationImportExternalArgsSchema.safeParse({
        files: validFiles,
        assistantId: 'x'.repeat(201)
      }).success
    ).toBe(false)
  })

  it('30MB 整边界 text 合法', () => {
    expect(
      conversationImportExternalArgsSchema.safeParse({
        files: [{ name: 'a.json', text: 'x'.repeat(30 * 1024 * 1024) }]
      }).success
    ).toBe(true)
  })
})
