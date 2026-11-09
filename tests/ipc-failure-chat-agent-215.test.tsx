// V4-Iter-215：会话面——safeHandle 的失败是 **resolve 的 {ok:false}**，
// 这些点原先把它当"成功后的凭据"用：幻影分组进列表、标题谎、"已删除 undefined 条"、"已转发"、"已设置提醒"、假 Python 运行时条目。
// Agent 壳那几处随 P4 批次 2 删除退场，剩下的逐点切区域做形状闸门。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('形状闸门：逐点核对「判失败」排在「写成功态」之前', () => {
  const readCode = (rel: string): string =>
    fs
      .readFileSync(path.resolve(__dirname, rel), 'utf-8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n')

  const SITES: Array<[string, string, string]> = [
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'deleteConversations(ids)', "toast.success(t('chat.batchDeleteDone'"],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'createConversationGroup(currentAssistantId, name)', 'setGroups('],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'forwardMessage({', "toast.success(t('chat.forwarded'"],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'createNoteFromMessage({', "'pocketai:switch-module'"],
    ['../src/renderer/src/modules/agent/mcp/McpForm.tsx', 'downloadPortablePython()', 'setPyRuntimes(']
  ]

  it('正好 5 个点位（少一处就是闸门在空转）', () => {
    expect(SITES.length).toBe(5)
  })

  for (const [rel, from, until] of SITES) {
    it(`${rel.split('/').pop()} — ${from.slice(0, 30)}… 之后、成功态之前必须判失败`, () => {
      const src = readCode(rel)
      const a = src.indexOf(from)
      expect(a, `锚点丢了：${from}`).toBeGreaterThanOrEqual(0)
      const b = src.indexOf(until, a)
      expect(b, `成功态锚点丢了：${until}`).toBeGreaterThan(a)
      const region = src.slice(a, b)
      expect(region, `${from} 的失败没判`).toMatch(/hasIpcFailed|isIpcFail|'ok' in |failOp\(/)
      expect(region, `${from} 判了却没守住成功态`).toMatch(/\breturn\b|\belse\b/)
      expect(region, `${from} 判了失败但没有反馈面`).toMatch(/toast\.error|setError|fail\(|onChatSendFailed|failSend|failOp\(/)
    })
  }

  it('对话页删会话仍先判失败（不再靠"删后重读"兜差异）', () => {
    const chat = readCode('../src/renderer/src/modules/chat/ChatModule.tsx')
    expect(chat.slice(chat.indexOf('deleteConversations(ids)'), chat.indexOf('batchDeleteDone')).length).toBeGreaterThan(0)
    expect(chat).toContain('if (hasIpcFailed(r))')
  })
})
