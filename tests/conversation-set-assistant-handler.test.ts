// CONVERSATION_SET_ASSISTANT 的 IPC 层守卫：宁可报错，不静默回落
//
// Iter-76 的导入路径是「无效 assistantId 静默回落自由会话」（批量导入不该被归属阻断）；
// 单条改归属反过来：目标助手不存在就报错。因为这里静默回落会把用户刚做的选择变成
// 「会话凭空消失」，只能靠猜才知道发生了什么。本用例把这个不对称钉住。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  conv: null as null | { id: string },
  assistant: null as null | { id: string },
  setAssistant: null as unknown
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      mocks.handlers.set(ch, fn)
    },
    // registerConversationHandlers 还注册了一个 send 通道（拖拽导出锁检查）
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
  nativeImage: { createFromPath: () => ({}) },
  app: { isPackaged: false, getPath: () => process.cwd(), getAppPath: () => process.cwd(), quit: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) })
    })
  }
}))

vi.mock('../src/main/db/repositories/conversation.repo', () => ({
  conversationRepo: {
    get: () => mocks.conv,
    setAssistant: (id: string, assistantId: string | null) => {
      mocks.setAssistant = { id, assistantId }
      return true
    },
    list: () => [],
    create: () => ({ id: 'c1' }),
    rename: () => {},
    delete: () => {},
    touch: () => {},
    setNote: () => {},
    setPinned: () => {},
    setArchived: () => {},
    setSystemPromptOverride: () => {},
    setTitleDefault: () => {},
    getDraft: () => '',
    setDraft: () => {},
    deleteIfEmpty: () => false,
    cleanupEmptyConversations: () => 0,
    fork: () => ({ id: 'c2' })
  }
}))

vi.mock('../src/main/db/repositories/assistant.repo', () => ({
  assistantRepo: { get: () => mocks.assistant, list: () => [] }
}))

vi.mock('../src/main/db/repositories/message.repo', () => ({
  messageRepo: { listByConversation: () => [], countByConversation: () => 0 }
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

vi.mock('../src/main/lock/lock', () => ({
  lockService: { isLocked: () => false, getStatus: () => ({ state: 'unlocked' }) }
}))
vi.mock('../src/main/attachment/attachment-ingestion', () => ({ deleteMessageAttachmentDocs: () => {} }))
vi.mock('../src/main/crypto/portable-crypto', () => ({
  encryptWithPassword: (s: string) => s,
  decryptWithPassword: (s: string) => s
}))
vi.mock('../src/main/export/pdf', () => ({ htmlToPdf: async () => new Uint8Array() }))
vi.mock('../src/main/agent/tool-approval', () => ({ clearSessionAllow: () => {} }))

import { registerConversationHandlers } from '../src/main/ipc/handlers/conversations'

registerConversationHandlers()

const call = async (payload: unknown): Promise<Record<string, unknown>> => {
  const fn = mocks.handlers.get(IPC.CONVERSATION_SET_ASSISTANT)
  if (!fn) throw new Error('CONVERSATION_SET_ASSISTANT 未注册')
  return (await fn({}, payload)) as Record<string, unknown>
}

beforeEach(() => {
  mocks.conv = { id: 'c1' }
  mocks.assistant = { id: 'a-2' }
  mocks.setAssistant = null
})

describe('CONVERSATION_SET_ASSISTANT', () => {
  it('目标助手存在 → 写库并返回 ok', async () => {
    expect(await call({ id: 'c1', assistantId: 'a-2' })).toEqual({ ok: true })
    expect(mocks.setAssistant).toEqual({ id: 'c1', assistantId: 'a-2' })
  })

  it('null 是合法目标（回自由会话），不做存在性检查', async () => {
    mocks.assistant = null
    expect(await call({ id: 'c1', assistantId: null })).toEqual({ ok: true })
    expect(mocks.setAssistant).toEqual({ id: 'c1', assistantId: null })
  })

  it('目标助手不存在 → 报错且不写库（静默回落等于让用户找不到会话）', async () => {
    mocks.assistant = null
    const r = await call({ id: 'c1', assistantId: 'gone' })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('助手')
    expect(mocks.setAssistant).toBeNull()
  })

  it('会话不存在 → 报错且不写库', async () => {
    mocks.conv = null
    const r = await call({ id: 'ghost', assistantId: 'a-2' })
    expect(r.ok).toBe(false)
    expect(mocks.setAssistant).toBeNull()
  })

  it('畸形入参被 schema 拦在业务之前（漏字段 / 空串 / 非对象）', async () => {
    for (const bad of [{ id: 'c1' }, { id: '', assistantId: null }, { id: 'c1', assistantId: '' }, 'c1', []]) {
      const r = await call(bad)
      expect(r.ok, JSON.stringify(bad)).toBe(false)
    }
    expect(mocks.setAssistant).toBeNull()
  })

  it('内置默认助手也可作为目标（它确实存在于 assistants 表里）', async () => {
    mocks.assistant = { id: 'asst-default' }
    expect(await call({ id: 'c1', assistantId: 'asst-default' })).toEqual({ ok: true })
  })
})
