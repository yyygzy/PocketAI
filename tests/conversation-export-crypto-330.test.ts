// 会话导出族的两处主进程口径（V4-Iter-330）
//
// ① 多选消息导出那道大小闸：改前它是 `content.max(5MB)` 字面量，而同一份 Markdown 走拖出通道
//    用的是 DRAG_CONTENT_MAX_CHARS（10MB）⇒ 7MB 的选中集拖得出去、点必失败。两条出口现在同闸。
// ② 加密导出：改前 `encryptWithPassword`（PBKDF2 一大轮）排在保存对话框之前 ⇒ 点完导出要先等
//    一轮才算弹框，用户在框里取消时那一轮纯白跑。现在只有真落盘那一发才做 KDF。
//
// 用例走真注册＋真 invoke（第 30 条：能真注册就别退到源码判据）；夹具抄 tests/conversation-set-assistant-handler.test.ts。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  conv: null as null | { id: string; title: string; assistantId: string | null },
  saveResult: { canceled: true } as { canceled: boolean; filePath?: string },
  saveCalls: 0,
  encrypt: null as null | ((s: string, p: string) => string)
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
      return {}
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => {
      mocks.saveCalls += 1
      return mocks.saveResult
    },
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
    setAssistant: () => true,
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
  assistantRepo: { get: () => null, list: () => [] }
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
  encryptWithPassword: (s: string, p: string) => mocks.encrypt!(s, p),
  decryptWithPassword: (s: string) => s
}))
vi.mock('../src/main/export/pdf', () => ({ htmlToPdf: async () => new Uint8Array() }))
vi.mock('../src/main/agent/tool-approval', () => ({ clearSessionAllow: () => {} }))

import { registerConversationHandlers } from '../src/main/ipc/handlers/conversations'
import { DRAG_CONTENT_MAX_CHARS } from '../src/main/export/drag-temp'

registerConversationHandlers()

const call = async (channel: string, ...args: unknown[]): Promise<Record<string, unknown>> => {
  const fn = mocks.handlers.get(channel)
  if (!fn) throw new Error(`${channel} 未注册`)
  return (await fn({}, ...args)) as Record<string, unknown>
}

const MB = 1024 * 1024

beforeEach(() => {
  mocks.conv = { id: 'c1', title: '会话一', assistantId: null }
  mocks.saveResult = { canceled: true }
  mocks.encrypt = vi.fn(() => 'cipher-blob')
  mocks.saveCalls = 0
})

let writeSpy: ReturnType<typeof vi.spyOn>
afterEach(() => {
  writeSpy.mockRestore()
})

beforeEach(() => {
  writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)
})

describe('① CONVERSATION_EXPORT_MESSAGES 与拖出通道同一道大小闸', () => {
  it(`6MB（改前必被 5MB 那道字面量挡死）现在走得通：进得了对话框`, async () => {
    mocks.saveResult = { canceled: true }
    const r = await call(IPC.CONVERSATION_EXPORT_MESSAGES, {
      defaultName: '会话一-12',
      content: 'x'.repeat(6 * MB)
    })
    expect(r).toEqual({ ok: true, canceled: true })
  })

  it(`超过共用上限（${DRAG_CONTENT_MAX_CHARS / MB}MB）仍然挡——两条出口同罪`, async () => {
    const r = await call(IPC.CONVERSATION_EXPORT_MESSAGES, {
      defaultName: '会话一-12',
      content: 'x'.repeat(DRAG_CONTENT_MAX_CHARS + 1)
    })
    expect(r.ok).toBe(false)
    expect(r.ipcCode).toBe('IPC_ARG_INVALID')
    // 挡在对话框之前（正向对照：合法大小那发确实弹了框）
    expect(mocks.saveCalls).toBe(0)
  })

  it(`同一份内容走拖出通道也进得了业务（闸确实同源：两路都在 6MB 放行）`, async () => {
    const drag = await call(IPC.EXPORT_PREPARE_DRAG, {
      defaultName: '会话一',
      ext: 'md',
      content: 'x'.repeat(6 * MB)
    })
    const msg = await call(IPC.CONVERSATION_EXPORT_MESSAGES, {
      defaultName: '会话一-12',
      content: 'x'.repeat(6 * MB)
    })
    // 拖出那路会真写临时文件（os.tmpdir 下），成功形状是 {ok:true,path}
    expect(drag.ok).toBe(true)
    expect(msg).toEqual({ ok: true, canceled: true })
  })
})

describe('② CONVERSATION_EXPORT_ENCRYPTED：KDF 只在真要落盘之后做', () => {
  it('对话框里取消 ⇒ 一轮 KDF 都不做（改前白跑一轮）', async () => {
    mocks.saveResult = { canceled: true }
    const r = await call(IPC.CONVERSATION_EXPORT_ENCRYPTED, 'c1', 'hunter2hunter2')
    expect(r).toEqual({ ok: true, canceled: true })
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(mocks.saveCalls).toBe(1)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('选定路径 ⇒ KDF 一次并写盘（正向对照：守卫不是恒跳过）', async () => {
    const target = path.join(process.cwd(), 'data', 'tmp', '330-encrypted.bin')
    mocks.saveResult = { canceled: false, filePath: target }
    const r = await call(IPC.CONVERSATION_EXPORT_ENCRYPTED, 'c1', 'hunter2hunter2')
    expect(r).toEqual({ ok: true, path: target })
    expect(mocks.encrypt).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(String((writeSpy.mock.calls[0] as unknown[])[0])).toBe(target)
  })

  it('会话不存在 ⇒ 报错且不弹框、不做 KDF', async () => {
    mocks.conv = null
    const r = await call(IPC.CONVERSATION_EXPORT_ENCRYPTED, 'ghost', 'hunter2hunter2')
    expect(r.ok).toBe(false)
    expect(mocks.saveCalls).toBe(0)
    expect(mocks.encrypt).not.toHaveBeenCalled()
  })
})
