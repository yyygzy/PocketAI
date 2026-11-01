// CONVERSATION_IMPORT 失败回滚测试（缺陷：消息事务在事务外 create 的会话之后执行，
// 事务一旦抛错，空会话已成事实落库 ⇒ 列表里多出一条 0 消息的空会话脏数据；
// 加密导入路径早就有失败删会话的收尾，普通导入缺了同款）。
//
// 钉住的行为：
//  ① 消息事务抛错 ⇒ 返回 {ok:false} 且 conversationRepo.delete 被调用清理新会话；
//  ② 事务成功 ⇒ 正常返回 ok:true 且不触发 delete。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  deleted: [] as string[],
  throwInTx: false
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      mocks.handlers.set(ch, fn)
    },
    on: () => {}
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
    static fromWebContents() {
      return undefined
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: () => {}
  },
  nativeImage: { createFromPath: () => ({}), createFromDataURL: () => ({}) },
  app: { isPackaged: false, getPath: () => process.cwd(), getAppPath: () => process.cwd(), quit: () => {} }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      // 事务壳：throwInTx 时返回一个调用即抛的「事务体」，模拟写入中途失败
      transaction: (fn: (msgs: unknown) => void) => (msgs: unknown) => {
        if (mocks.throwInTx) throw new Error('注入失败：磁盘满')
        fn(msgs)
      },
      prepare: () => ({ run: () => ({}), get: () => undefined, all: () => [] })
    })
  }
}))

vi.mock('../src/main/db/repositories/conversation.repo', () => ({
  conversationRepo: {
    create: () => ({ id: 'c-new', title: 't' }),
    delete: (id: string) => {
      mocks.deleted.push(id)
    },
    get: () => null,
    list: () => [],
    rename: () => {},
    touch: () => {},
    setAssistant: () => true,
    setNote: () => {},
    setPinned: () => {},
    setArchived: () => {},
    setSystemPromptOverride: () => {},
    setTitleDefault: () => {},
    getDraft: () => '',
    setDraft: () => {},
    deleteIfEmpty: () => false,
    cleanupEmptyConversations: () => 0,
    listChildren: () => [],
    fork: () => ({ id: 'c2' })
  }
}))

vi.mock('../src/main/db/repositories/conversation-group.repo', () => ({
  conversationGroupRepo: {
    list: () => [],
    create: () => ({}),
    rename: () => {},
    delete: () => {},
    setConversationGroup: () => {}
  }
}))

vi.mock('../src/main/db/repositories/message.repo', () => ({
  messageRepo: { listByConversation: () => [], countByConversation: () => 0 }
}))

vi.mock('../src/main/db/repositories/assistant.repo', () => ({
  assistantRepo: { get: () => null, list: () => [] }
}))

vi.mock('../src/main/attachment/attachment-ingestion', () => ({
  deleteMessageAttachmentDocs: () => {}
}))

vi.mock('../src/main/crypto/portable-crypto', () => ({
  encryptWithPassword: () => '',
  decryptWithPassword: () => ({})
}))

vi.mock('../src/main/export/pdf', () => ({ htmlToPdf: async () => '' }))

vi.mock('../src/main/export/drag-temp', () => ({
  cleanupDragTempDir: () => {},
  writeDragTempFile: () => '',
  isDragTempPath: () => false,
  DRAG_CONTENT_MAX_CHARS: 1
}))

vi.mock('../src/main/conversation/title-config', () => ({
  isSmartTitleEnabled: () => false,
  setSmartTitleEnabled: () => {}
}))

vi.mock('../src/main/lock/lock', () => ({
  lockService: { isLocked: () => false, onChange: () => {} }
}))

vi.mock('../src/main/agent/tool-approval', () => ({ clearSessionAllow: () => {} }))

import { registerConversationHandlers } from '../src/main/ipc/handlers/conversations'

function validPayload(): unknown {
  return {
    version: 1,
    exportedAt: 1,
    conversation: {
      id: 'c-old',
      assistantId: null,
      title: '导入的会话',
      modelLabel: null,
      status: 'done',
      createdAt: 1,
      updatedAt: 1
    },
    messages: [{ id: 'm1', conversationId: 'c-old', role: 'user', content: 'hi' }]
  }
}

beforeEach(() => {
  mocks.deleted.length = 0
  mocks.throwInTx = false
  mocks.handlers.clear()
  registerConversationHandlers()
})

describe('CONVERSATION_IMPORT 失败回滚', () => {
  it('消息事务抛错 ⇒ {ok:false} 且删除已创建会话，不留空会话', async () => {
    mocks.throwInTx = true
    const handler = mocks.handlers.get(IPC.CONVERSATION_IMPORT)!
    const r = (await handler(null, validPayload())) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('回滚')
    expect(mocks.deleted).toEqual(['c-new'])
  })

  it('事务成功 ⇒ ok:true 且不触发删除', async () => {
    const handler = mocks.handlers.get(IPC.CONVERSATION_IMPORT)!
    const r = (await handler(null, validPayload())) as { ok: boolean; messageCount?: number }
    expect(r.ok).toBe(true)
    expect(r.messageCount).toBe(1)
    expect(mocks.deleted).toEqual([])
  })
})
