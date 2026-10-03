// conversation.repo 行映射测试
//
// 覆盖 src/main/db/repositories/conversation.repo.ts 的 rowToRecord：
// DB 行 → ConversationRecord 映射（title null→'新对话'、status null→'idle'）。
//
// 策略：mock dbService 的 prepare() 链（捕获 SQL/参数），rowToRecord/buildConvListQuery 为纯函数。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: {
    lastSql: '',
    lastParams: [] as unknown[],
    rows: [] as unknown[],
    row: undefined as unknown,
    runSqls: [] as string[],
    runChanges: 1 as number,
    transactionRuns: 0 as number
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        all: (...params: unknown[]) => {
          state.lastSql = sql
          state.lastParams = params
          return state.rows
        },
        get: (...params: unknown[]) => {
          state.lastSql = sql
          state.lastParams = params
          return state.row
        },
        run: (...params: unknown[]) => {
          state.lastSql = sql
          state.lastParams = params
          state.runSqls.push(sql)
          return { changes: state.runChanges }
        }
      }),
      // 立即执行事务体（delete 级联测试用）
      transaction: (fn: () => unknown) => () => {
        state.transactionRuns++
        fn()
      }
    })
  }
}))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))

import { rowToRecord, buildConvListQuery, conversationRepo } from '../src/main/db/repositories/conversation.repo'

beforeEach(() => {
  state.lastSql = ''
  state.lastParams = []
  state.rows = []
  state.row = undefined
  state.runSqls = []
  state.runChanges = 1
  state.transactionRuns = 0
})

describe('rowToRecord — DB 行映射为 ConversationRecord', () => {
  it('全 null 可选字段 → 默认值填充', () => {
    const rec = rowToRecord({
      id: 'c1',
      assistant_id: null,
      title: null,
      model: null,
      params: null,
      status: null,
      created_at: 100,
      updated_at: 200
    })
    expect(rec.id).toBe('c1')
    expect(rec.assistantId).toBeNull()
    expect(rec.title).toBe('新对话')
    expect(rec.modelLabel).toBeNull()
    expect(rec.status).toBe('idle')
    expect(rec.createdAt).toBe(100)
    expect(rec.updatedAt).toBe(200)
  })

  it('非空字段 → 原样透传', () => {
    const rec = rowToRecord({
      id: 'c2',
      assistant_id: 'asst-1',
      title: '我的对话',
      model: 'gpt-4o',
      params: null,
      status: 'streaming',
      created_at: 300,
      updated_at: 400,
      note: 'VIP 客户'
    })
    expect(rec.assistantId).toBe('asst-1')
    expect(rec.title).toBe('我的对话')
    expect(rec.modelLabel).toBe('gpt-4o')
    expect(rec.status).toBe('streaming')
    expect(rec.note).toBe('VIP 客户')
  })

  it('note 缺省/NULL → null（v38 前旧行无该列值）', () => {
    const rec = rowToRecord({
      id: 'c2b',
      assistant_id: null,
      title: null,
      model: null,
      params: null,
      status: null,
      created_at: 0,
      updated_at: 0
    })
    expect(rec.note).toBeNull()
  })

  it('status=空串 → 透传空串（不回退 idle）', () => {
    const rec = rowToRecord({
      id: 'c3',
      assistant_id: null,
      title: null,
      model: null,
      params: null,
      status: '',
      created_at: 0,
      updated_at: 0
    })
    expect(rec.status).toBe('')
  })

  it('title=空串 → 透传空串（不回退 新对话）', () => {
    const rec = rowToRecord({
      id: 'c4',
      assistant_id: null,
      title: '',
      model: null,
      params: null,
      status: null,
      created_at: 0,
      updated_at: 0
    })
    expect(rec.title).toBe('')
  })

  it('置顶/归档新字段：旧库行缺列 → 安全默认；新行 0/1 → boolean', () => {
    // 旧库 ALTER 前查询理论上不走新代码，这里验证 undefined 防御
    const legacy = rowToRecord({
      id: 'c5', assistant_id: null, title: null, model: null, params: null,
      status: null, created_at: 0, updated_at: 0
    })
    expect(legacy.pinned).toBe(false)
    expect(legacy.archived).toBe(false)
    expect(legacy.archivedAt).toBeNull()

    const pinned = rowToRecord({
      id: 'c6', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 1, updated_at: 2, pinned: 1, archived: 0, archived_at: null
    })
    expect(pinned.pinned).toBe(true)
    expect(pinned.archived).toBe(false)

    const archived = rowToRecord({
      id: 'c7', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 1, updated_at: 2, pinned: 0, archived: 1, archived_at: 999
    })
    expect(archived.archived).toBe(true)
    expect(archived.archivedAt).toBe(999)
  })

  it('titleDefault：旧库行缺列 → true（可自动命名）；0 → false；1 → true', () => {
    const legacy = rowToRecord({
      id: 'c8', assistant_id: null, title: '新对话', model: null, params: null,
      status: null, created_at: 0, updated_at: 0
    })
    expect(legacy.titleDefault).toBe(true)

    const finalized = rowToRecord({
      id: 'c9', assistant_id: null, title: '手改标题', model: null, params: null,
      status: null, created_at: 0, updated_at: 0, title_default: 0
    })
    expect(finalized.titleDefault).toBe(false)

    const fresh = rowToRecord({
      id: 'c10', assistant_id: null, title: '新对话', model: null, params: null,
      status: null, created_at: 0, updated_at: 0, title_default: 1
    })
    expect(fresh.titleDefault).toBe(true)
  })

  it('lastMessagePreview：非 list 查询缺列 → null；list 带出 → 透传', () => {
    const noPreview = rowToRecord({
      id: 'c11', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 0, updated_at: 0
    })
    expect(noPreview.lastMessagePreview).toBeNull()

    const withPreview = rowToRecord({
      id: 'c12', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 0, updated_at: 0, last_preview: '最近一条消息内容'
    })
    expect(withPreview.lastMessagePreview).toBe('最近一条消息内容')
  })

  it('hasDraft：旧库行缺列 → false；0 → false；1 → true', () => {
    const legacy = rowToRecord({
      id: 'c13', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 0, updated_at: 0
    })
    expect(legacy.hasDraft).toBe(false)

    const noDraft = rowToRecord({
      id: 'c14', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 0, updated_at: 0, has_draft: 0
    })
    expect(noDraft.hasDraft).toBe(false)

    const hasDraft = rowToRecord({
      id: 'c15', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 0, updated_at: 0, has_draft: 1
    })
    expect(hasDraft.hasDraft).toBe(true)
  })
})

describe('buildConvListQuery — 列表过滤/排序条件', () => {
  it('默认（活跃）：排除归档且置顶优先按更新时间', () => {
    const q = buildConvListQuery({})
    expect(q.where).toContain('archived = 0')
    expect(q.where).not.toContain('archived = 1')
    expect(q.orderBy).toBe('pinned DESC, updated_at DESC')
    expect(q.vals).toEqual([])
  })

  it('archivedOnly：只取归档并按归档时间排序', () => {
    const q = buildConvListQuery({ archivedOnly: true })
    expect(q.where).toContain('archived = 1')
    expect(q.orderBy).toBe('pinned DESC, archived_at DESC, updated_at DESC')
  })

  it('asst-default / 普通助手 / agent 过滤组合与参数顺序', () => {
    const def = buildConvListQuery({ assistantId: 'asst-default', isAgent: false })
    expect(def.where).toContain("(assistant_id = 'asst-default' OR assistant_id IS NULL)")
    expect(def.where).toContain("(model NOT LIKE 'agent:%' OR model IS NULL)")
    expect(def.vals).toEqual([])

    const asst = buildConvListQuery({ assistantId: 'asst-9', isAgent: true, archivedOnly: true })
    expect(asst.where).toContain('assistant_id = ?')
    expect(asst.where).toContain("model LIKE 'agent:%'")
    expect(asst.where).toContain('archived = 1')
    // 参数顺序：assistantId 先于 archived 条件之前的拼装位置（archived 无参数），仅一个绑定值
    expect(asst.vals).toEqual(['asst-9'])
  })

  it('list() SQL 带出 has_draft EXISTS 子查询并映射 📝 标记', () => {
    state.rows = [{
      id: 'c16', assistant_id: null, title: 't', model: null, params: null,
      status: null, created_at: 0, updated_at: 0, has_draft: 1
    }]
    const list = conversationRepo.list()
    expect(state.lastSql).toContain('EXISTS(SELECT 1 FROM conversation_drafts d WHERE d.conversation_id = c.id) AS has_draft')
    expect(list[0]!.hasDraft).toBe(true)
  })
})

describe('conversationRepo 草稿读写（getDraft/setDraft）', () => {
  it('getDraft：有行 → 透传 draft 文本，SQL 按 conversation_id 查询', () => {
    state.row = { draft: '写到一半的内容' }
    const d = conversationRepo.getDraft('c100')
    expect(d).toBe('写到一半的内容')
    expect(state.lastSql).toContain('SELECT draft FROM conversation_drafts WHERE conversation_id=?')
    expect(state.lastParams).toEqual(['c100'])
  })

  it('getDraft：无行 → 空串（新会话/已发送清空）', () => {
    state.row = undefined
    expect(conversationRepo.getDraft('c101')).toBe('')
  })

  it('setDraft：非空 → UPSERT（ON CONFLICT 更新 draft/updated_at），参数 [id, text, ts]', () => {
    conversationRepo.setDraft('c102', '草稿文本')
    expect(state.lastSql).toContain('INSERT INTO conversation_drafts')
    expect(state.lastSql).toContain('ON CONFLICT(conversation_id) DO UPDATE')
    expect(state.lastParams[0]).toBe('c102')
    expect(state.lastParams[1]).toBe('草稿文本')
    expect(typeof state.lastParams[2]).toBe('number')
    expect((state.lastParams[2] as number) > 0).toBe(true)
  })

  it('setDraft：空串 → DELETE 草稿行（发送/手动清空）', () => {
    conversationRepo.setDraft('c103', '')
    expect(state.lastSql).toContain('DELETE FROM conversation_drafts WHERE conversation_id=?')
    expect(state.lastParams).toEqual(['c103'])
  })
})

describe('conversationRepo.setNote — 备注（v38）', () => {
  it('非空备注 → trim 后 UPDATE，不动 updated_at（备注不改变活跃排序）', () => {
    conversationRepo.setNote('c400', '  重要客户  ')
    expect(state.lastSql).toBe('UPDATE conversations SET note=? WHERE id=?')
    expect(state.lastParams).toEqual(['重要客户', 'c400'])
    expect(state.lastSql).not.toContain('updated_at')
  })

  it('纯空格 → trim 后为空存 NULL（清除备注）', () => {
    conversationRepo.setNote('c401', '   ')
    expect(state.lastSql).toBe('UPDATE conversations SET note=? WHERE id=?')
    expect(state.lastParams).toEqual([null, 'c401'])
  })

  it('null → 存 NULL', () => {
    conversationRepo.setNote('c402', null)
    expect(state.lastParams).toEqual([null, 'c402'])
  })
})

describe('conversationRepo.delete — 草稿级联删除', () => {
  it('删除会话事务内同步删除 messages/fts/草稿/会话四步', () => {
    conversationRepo.delete('c200')
    expect(state.transactionRuns).toBe(1)
    expect(state.runSqls.some((s) => s.includes('DELETE FROM conversation_drafts WHERE conversation_id=?'))).toBe(true)
    expect(state.lastSql).toContain('DELETE FROM conversations WHERE id=?')
    expect(state.lastParams).toEqual(['c200'])
  })
})

describe('空会话自动清理（deleteIfEmpty / cleanupEmptyConversations）', () => {
  it('deleteIfEmpty：SQL 含四重守卫（自动标题/未置顶/无消息/无草稿）+ 绑定 id，changes=1→true', () => {
    state.runChanges = 1
    const deleted = conversationRepo.deleteIfEmpty('c300')
    expect(deleted).toBe(true)
    expect(state.lastSql).toContain('DELETE FROM conversations')
    expect(state.lastSql).toContain('id=? AND title_default=1 AND pinned=0')
    expect(state.lastSql).toContain('NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id)')
    expect(state.lastSql).toContain('NOT EXISTS (SELECT 1 FROM conversation_drafts WHERE conversation_id = conversations.id)')
    expect(state.lastParams).toEqual(['c300'])
  })

  it('deleteIfEmpty：守卫未命中（已重命名/置顶/有消息/有草稿）changes=0 → false', () => {
    state.runChanges = 0
    expect(conversationRepo.deleteIfEmpty('c301')).toBe(false)
    expect(state.lastParams).toEqual(['c301'])
  })

  it('cleanupEmptyConversations：全局清扫无 id 绑定、守卫同款，返回删除条数', () => {
    state.runChanges = 3
    const count = conversationRepo.cleanupEmptyConversations()
    expect(count).toBe(3)
    expect(state.lastSql).toContain('DELETE FROM conversations')
    expect(state.lastSql).toContain('title_default=1 AND pinned=0')
    expect(state.lastSql).toContain('NOT EXISTS (SELECT 1 FROM messages')
    expect(state.lastSql).toContain('NOT EXISTS (SELECT 1 FROM conversation_drafts')
    expect(state.lastParams).toEqual([])
  })
})
