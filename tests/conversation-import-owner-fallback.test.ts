// 导入归属助手回落测试（#2 修复钉住的行为）：
// JSON / 加密 / 外部三条导入路径共用 resolveImportOwnerId——
// 归属助手存在 → 落原 id；id 无效或助手已删除 → 静默落 null（自由会话），不报错中断导入。
// 此前 JSON 与加密两条路把 payload 里的 assistantId 原样落库（外部导入早就有校验），
// 跨机导入或助手被删后产生「导入成功但任何列表都见不到」的孤儿会话。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  createdWith: [] as Array<string | null | undefined>,
  /** 模拟助手表：只有这个 id 算存在 */
  knownAssistant: 'asst-real'
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
      return [{}]
    }
    static fromWebContents() {
      return undefined
    }
  },
  dialog: {
    // 加密导入路径要先过文件对话框——直接喂一个伪路径，fs 层在下面一并 mock
    showOpenDialog: async () => ({ canceled: false, filePaths: ['C:\\fake\\import.pocketai'] }),
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: () => {}
  },
  nativeImage: { createFromPath: () => ({}), createFromDataURL: () => ({}) },
  app: { isPackaged: false, getPath: () => process.cwd(), getAppPath: () => process.cwd(), quit: () => {} }
}))

vi.mock('node:fs', () => ({
  default: {
    statSync: () => ({ isFile: () => true, size: 128 }),
    readFileSync: () => 'encrypted-blob',
    writeFileSync: () => {},
    existsSync: () => false,
    mkdirSync: () => {},
    copyFileSync: () => {},
    unlinkSync: () => {},
    readdirSync: () => []
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      transaction: (fn: (msgs: unknown) => void) => (msgs: unknown) => fn(msgs),
      prepare: () => ({ run: () => ({}), get: () => undefined, all: () => [] })
    })
  }
}))

vi.mock('../src/main/db/repositories/conversation.repo', () => ({
  conversationRepo: {
    create: (input: { assistantId?: string | null }) => {
      mocks.createdWith.push(input.assistantId)
      return { id: 'c-new', title: 't' }
    },
    delete: () => {},
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
  assistantRepo: {
    get: (id: string) => (id === mocks.knownAssistant ? { id, name: '助手' } : null),
    list: () => []
  }
}))

vi.mock('../src/main/attachment/attachment-ingestion', () => ({
  deleteMessageAttachmentDocs: () => {}
}))

vi.mock('../src/main/crypto/portable-crypto', () => ({
  encryptWithPassword: () => '',
  // 加密导入：解密直接吐回合法导出 payload 的 JSON 串
  decryptWithPassword: () => (globalThis as { __importPlaintext?: string }).__importPlaintext ?? '{}'
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

function validPayload(assistantId: string | null): unknown {
  return {
    version: 1,
    exportedAt: 1,
    conversation: {
      id: 'c-old',
      assistantId,
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
  mocks.createdWith.length = 0
  mocks.handlers.clear()
  registerConversationHandlers()
})

describe('导入归属助手回落：JSON 路径（CONVERSATION_IMPORT）', () => {
  it('助手存在 ⇒ 落原 id', async () => {
    const handler = mocks.handlers.get(IPC.CONVERSATION_IMPORT)!
    const r = (await handler(null, validPayload('asst-real'))) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(mocks.createdWith).toEqual(['asst-real'])
  })

  it('助手不存在 ⇒ 静默落 null（自由会话），导入不中断', async () => {
    const handler = mocks.handlers.get(IPC.CONVERSATION_IMPORT)!
    const r = (await handler(null, validPayload('asst-ghost'))) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(mocks.createdWith).toEqual([null])
  })

  it('payload 本来就 null ⇒ 落 null', async () => {
    const handler = mocks.handlers.get(IPC.CONVERSATION_IMPORT)!
    const r = (await handler(null, validPayload(null))) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(mocks.createdWith).toEqual([null])
  })
})

describe('导入归属助手回落：加密路径（CONVERSATION_IMPORT_ENCRYPTED）', () => {
  async function runEncrypted(assistantId: string | null) {
    ;(globalThis as { __importPlaintext?: string }).__importPlaintext = JSON.stringify(
      validPayload(assistantId)
    )
    const handler = mocks.handlers.get(IPC.CONVERSATION_IMPORT_ENCRYPTED)!
    return (await handler({ sender: {} }, 'password123')) as { ok: boolean; error?: string }
  }

  it('助手存在 ⇒ 落原 id', async () => {
    const r = await runEncrypted('asst-real')
    expect(r.ok).toBe(true)
    expect(mocks.createdWith).toEqual(['asst-real'])
  })

  it('助手不存在/已删除 ⇒ 静默落 null，导入不中断', async () => {
    const r = await runEncrypted('asst-deleted')
    expect(r.ok).toBe(true)
    expect(mocks.createdWith).toEqual([null])
  })
})
