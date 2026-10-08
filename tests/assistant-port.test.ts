import { describe, expect, it } from 'vitest'
import { buildAssistantExportPayload, resolveAssistantImportItem } from '../src/shared/assistant-port'
import type { AssistantRecord } from '../src/shared/types'

function makeRecord(overrides: Partial<AssistantRecord> = {}): AssistantRecord {
  return {
    id: 'a1',
    name: 'Test',
    description: 'desc',
    avatar: '🤖',
    systemPrompt: 'prompt',
    welcomeMessage: 'hello',
    defaultProviderId: 'p1',
    defaultModel: 'm1',
    defaultParams: { temperature: 0.7 },
    toolPermissions: ['*'],
    skillIds: ['s1'],
    knowledgeBaseIds: ['kb1'],
    isBuiltin: false,
    isPinned: false,
    createdAt: 0,
    ...overrides
  }
}

describe('assistant-port', () => {
  describe('buildAssistantExportPayload', () => {
    it('should filter out builtin assistants and keep whitelist fields', () => {
      const records = [
        makeRecord({ id: 'a1', isBuiltin: true }),
        makeRecord({ id: 'a2', name: 'Custom' })
      ]
      const payload = buildAssistantExportPayload(records)
      expect(payload.version).toBe(1)
      expect(payload.assistants).toHaveLength(1)
      expect(payload.assistants[0]!.name).toBe('Custom')
      expect('id' in payload.assistants[0]!).toBe(false)
      expect('isBuiltin' in payload.assistants[0]!).toBe(false)
      expect('createdAt' in payload.assistants[0]!).toBe(false)
    })

    it('should return empty assistants when all are builtin', () => {
      const records = [makeRecord({ isBuiltin: true })]
      const payload = buildAssistantExportPayload(records)
      expect(payload.assistants).toHaveLength(0)
    })
  })

  describe('resolveAssistantImportItem', () => {
    it('should return null for non-object input', () => {
      expect(resolveAssistantImportItem(null, new Set(), new Set())).toBeNull()
      expect(resolveAssistantImportItem('str', new Set(), new Set())).toBeNull()
    })

    it('should return null when name is missing or empty', () => {
      expect(resolveAssistantImportItem({}, new Set(), new Set())).toBeNull()
      expect(resolveAssistantImportItem({ name: '' }, new Set(), new Set())).toBeNull()
      expect(resolveAssistantImportItem({ name: '   ' }, new Set(), new Set())).toBeNull()
    })

    it('should keep existing kb/skill ids and drop missing ones', () => {
      const item = resolveAssistantImportItem(
        {
          name: 'A',
          knowledgeBaseIds: ['kb1', 'kb2'],
          skillIds: ['s1', 's2']
        },
        new Set(['kb1']),
        new Set(['s1'])
      )
      expect(item).not.toBeNull()
      expect(item!.draft.knowledgeBaseIds).toEqual(['kb1'])
      expect(item!.draft.skillIds).toEqual(['s1'])
      expect(item!.droppedKb).toBe(1)
      expect(item!.droppedSkills).toBe(1)
    })

    it('导入不携带工具授权：toolPermissions 清空并计入 droppedTools（SEC-3）', () => {
      const item = resolveAssistantImportItem(
        { name: 'A', toolPermissions: ['*', 'shell.exec', 'kb.search'] },
        new Set(),
        new Set()
      )
      expect(item!.draft.toolPermissions).toEqual([])
      expect(item!.droppedTools).toBe(3)
    })

    it('未声明 toolPermissions 时 droppedTools 为 0', () => {
      const item = resolveAssistantImportItem({ name: 'A' }, new Set(), new Set())
      expect(item!.draft.toolPermissions).toEqual([])
      expect(item!.droppedTools).toBe(0)
    })

    it('should truncate long fields to max length', () => {
      const longName = 'x'.repeat(200)
      const longDesc = 'd'.repeat(600)
      const item = resolveAssistantImportItem(
        { name: longName, description: longDesc },
        new Set(),
        new Set()
      )
      expect(item!.draft.name).toBe('x'.repeat(100))
      expect(item!.draft.description).toBe('d'.repeat(500))
    })

    it('should default avatar to 🤖 when missing or invalid', () => {
      const item = resolveAssistantImportItem({ name: 'A' }, new Set(), new Set())
      expect(item!.draft.avatar).toBe('🤖')
    })

    it('should parse defaultParams as object or null', () => {
      const item = resolveAssistantImportItem(
        { name: 'A', defaultParams: { temperature: 0.5 } },
        new Set(),
        new Set()
      )
      expect(item!.draft.defaultParams).toEqual({ temperature: 0.5 })

      const item2 = resolveAssistantImportItem(
        { name: 'A', defaultParams: 'not-object' },
        new Set(),
        new Set()
      )
      expect(item2!.draft.defaultParams).toBeNull()
    })
  })
})
