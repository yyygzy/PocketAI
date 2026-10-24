// §281：assistantRepo.duplicate 第二参 displayName——渲染层传可见名（已本地化＋已加"副本"后缀），
// 命中内置助手时不再落 DB 里的中文原始串；不传时回落到旧行为（`${src.name} 副本`）。
// 判据钉在 INSERT 落库的 name 实参上，不是"函数返回了啥"。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: { insertParams: [] as unknown[][], sourceName: '通用问答' }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        get: (...params: unknown[]) => {
          // 只有查内置源那一条返回行；save 里对新 UUID 的存在性查询返回 undefined（走 INSERT 分支）
          if (sql.startsWith('SELECT * FROM assistants WHERE id=?') && params[0] === 'asst-default') {
            return {
              id: 'asst-default', name: state.sourceName, description: '默认助手', avatar: '💬',
              system_prompt: null, default_provider_id: null, default_model: null, default_params: null,
              tool_permissions: null, skill_ids: null, knowledge_base_ids: null, welcome_message: null,
              is_builtin: 1, is_pinned: 1, created_at: 1, updated_at: 1
            }
          }
          return undefined
        },
        run: (...params: unknown[]) => {
          if (/^INSERT INTO assistants/.test(sql)) state.insertParams = params
          return { changes: 1 }
        },
        all: () => []
      }),
      transaction: (fn: () => unknown) => fn()
    })
  }
}))
vi.mock('../src/main/db/must-get', () => ({ mustGet: (getter: () => unknown) => getter() ?? { id: 'x' } }))

import { assistantRepo } from '../src/main/db/repositories/assistant.repo'

beforeEach(() => {
  state.insertParams = []
  state.sourceName = '通用问答'
})

// INSERT 参数顺序：id, name(第 2), ...  ⇒ insertParams[1] 是落库的 name
describe('assistantRepo.duplicate displayName 覆盖', () => {
  it('传可见名 ⇒ 落库用它（不再拼中文原始名）', () => {
    assistantRepo.duplicate('asst-default', 'General Q&A Copy')
    expect(state.insertParams[1]).toBe('General Q&A Copy')
  })

  it('不传 ⇒ 回落旧行为：中文原始名 + " 副本"', () => {
    assistantRepo.duplicate('asst-default')
    expect(state.insertParams[1]).toBe('通用问答 副本')
  })

  it('传空白串 ⇒ 视同没传，仍回落（trim 后为空不许落一个空名）', () => {
    assistantRepo.duplicate('asst-default', '   ')
    expect(state.insertParams[1]).toBe('通用问答 副本')
  })
})
