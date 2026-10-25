// @vitest-environment node
// V4-Iter-314 真跨桥：删除 MCP Server 那一发到底调的是 forget 还是 stop。
//
// 为什么桥层这一份不能省：mcp-manager.test.ts 那份只证「forget 这个办法本身是对的」，
// 它证不了**删除那条 IPC 有没有用它**。这一份把 handler 真的注册进 ipcMain 桩、真的按通道名 invoke，
// 于是这条链上任何一环写错（退回 stop、挪到操作锁外面、忘了先停再删库）都会当场红。
//
// 真的：electron 桥的形状、safeHandle（含 zod 入参校验与抛错转 {ok:false}）、withServerOp 互斥语义、
//       mcpServerRepo 的增删查、handler 文件本体。
// 假的：McpManager（子进程与握手在这里没有意义）、python-env / python-runtime / 调用日志 / 广播。
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { IPC, type McpServerRecord } from '../src/shared/types'

const ID = 'a1b2c3d4-0000-4000-8000-000000000001'

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => Promise<unknown>>(),
  /** 按发生顺序记录跨界调用，用来读「谁在谁之前」 */
  calls: [] as string[],
  records: [] as McpServerRecord[],
  /** withServerOp 当前持锁的 serverId（null＝没人在操作这台） */
  opHeld: null as string | null,
  /** forget 被调用的那一刻锁在不在手上——挪到 withServerOp 外面就变了 */
  opAtForget: 'unset' as string | null | 'unset',
  forgetImpl: (async () => {}) as () => Promise<void>,
  reset() {
    this.calls = []
    this.records = []
    this.opHeld = null
    this.opAtForget = 'unset'
    this.forgetImpl = async () => {}
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => Promise<unknown>) => {
      H.handlers.set(ch, fn)
    },
    on: () => {},
    removeListener: () => {}
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: true, filePaths: [] }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showErrorBox: () => {}
  },
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
    static getAllWindows() {
      return []
    }
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: {
    list: () => H.records,
    get: (id: string) => H.records.find((r) => r.id === id) ?? null,
    save: (r: McpServerRecord) => r,
    delete: (id: string) => {
      H.calls.push(`repo.delete:${id}`)
      H.records = H.records.filter((r) => r.id !== id)
    }
  }
}))

vi.mock('../src/main/db/repositories/mcp-call-log.repo', () => ({
  mcpCallLogRepo: {
    list: () => [],
    clear: () => 0,
    append: () => {}
  }
}))

vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: {
    start: async (id: string) => {
      H.calls.push(`start:${id}`)
      return { id }
    },
    stop: async (id: string) => {
      H.calls.push(`stop:${id}`)
    },
    forget: async (id: string) => {
      H.calls.push(`forget:${id}`)
      H.opAtForget = H.opHeld
      await H.forgetImpl()
    },
    restart: async (id: string) => ({ id }),
    listTools: async () => [],
    callTool: async () => ({}),
    listRuntimes: () => [],
    stopAll: async () => {},
    onCall: () => {},
    onStatus: () => {},
    onLog: () => {}
  }
}))

vi.mock('../src/main/mcp/python-env', () => ({
  pythonEnvService: {
    // 与真实实现同语义：同一台正在操作时立即失败，不排队
    withServerOp: async (id: string, fn: () => Promise<unknown>) => {
      if (H.opHeld === id) throw new Error(`该 MCP Server 正在执行其他操作：${id}`)
      H.opHeld = id
      try {
        return await fn()
      } finally {
        H.opHeld = null
      }
    },
    removeServerEnv: async (id: string) => {
      H.calls.push(`removeServerEnv:${id}`)
    },
    installForServer: async () => ({ status: 'ready' }),
    getEnvState: async () => ({ status: 'ready' }),
    recentEvents: () => [],
    onInstall: () => {}
  },
  getPipSource: () => ({ url: 'https://pypi.org/simple' }),
  setPipSource: () => {}
}))

vi.mock('../src/main/python-runtime', () => ({
  listPythonRuntimes: async () => [],
  downloadPortablePython: async () => ({ ok: true })
}))

vi.mock('../src/main/ipc/broadcast', () => ({
  broadcast: () => {}
}))

// 工具注册表只要那两个纯函数；真模块会拖进整条内置工具链
vi.mock('../src/main/tools/registry', () => ({
  stringifyMcpResult: (r: unknown) => JSON.stringify(r),
  mcpResultIsError: (r: unknown) => !!(r as { isError?: boolean }).isError
}))

import { registerMcpHandlers } from '../src/main/ipc/handlers/mcp'

function makeRecord(id: string): McpServerRecord {
  return {
    id,
    name: 'srv',
    transport: 'stdio',
    runtime: 'binary',
    command: 'node',
    args: [],
    env: {},
    url: null,
    headers: {},
    enabled: true,
    createdAt: 0,
    trustReadOnly: false,
    pythonPackages: []
  }
}

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = H.handlers.get(channel)
  if (!fn) throw new Error(`渲染层指向了一个没人注册的通道：${channel}`)
  return (await fn({ sender: { send: () => {}, isDestroyed: () => false } }, ...args)) as T
}

beforeAll(() => {
  registerMcpHandlers()
})

beforeEach(() => {
  H.reset()
  H.records = [makeRecord(ID)]
})

describe('§314 删除 MCP Server 的接线', () => {
  it('删除那一发走 forget（不是 stop），并且把库里那条一起删掉', async () => {
    const r = await invoke<{ ok: boolean }>(IPC.MCP_SERVER_DELETE, ID)
    expect(r.ok).toBe(true)
    expect(H.calls).toEqual([`forget:${ID}`, `removeServerEnv:${ID}`, `repo.delete:${ID}`])
    expect(H.records, '库里的记录要跟着消失').toEqual([])
  })

  it('forget 发生在该 Server 的操作锁里面（与安装/重装互斥这件事才成立）', async () => {
    await invoke(IPC.MCP_SERVER_DELETE, ID)
    expect(H.opAtForget, '挪到 withServerOp 外面就是拿锁窗口和安装抢同一台').toBe(ID)
  })

  it('forget 抛错 ⇒ 整发回 {ok:false}，库里那条不删（界面不会出现「条目没了但进程还在」）', async () => {
    H.forgetImpl = async () => {
      throw new Error('shutdown 卡住')
    }
    const r = await invoke<{ ok: boolean; error?: string }>(IPC.MCP_SERVER_DELETE, ID)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('shutdown 卡住')
    expect(H.calls, '停不干净就不该往下删环境、删记录').toEqual([`forget:${ID}`])
    expect(H.records.map((x) => x.id)).toEqual([ID])
  })

  it('装依赖那一发仍然只 stop：记录还在，运行时 entry 不该被摘走（防把 forget 铺到所有停机点）', async () => {
    const r = await invoke<{ ok: boolean }>(IPC.PYTHON_ENV_INSTALL, ID)
    expect(r.ok).toBe(true)
    expect(H.calls).toContain(`stop:${ID}`)
    expect(H.calls.filter((c) => c.startsWith('forget:'))).toEqual([])
  })

  it('用户点「停止」那一发也仍然只 stop（停机不摘凭据缓冲，重启还要用同一条 entry）', async () => {
    await invoke(IPC.MCP_SERVER_STOP, ID)
    expect(H.calls).toEqual([`stop:${ID}`])
  })

  it('入参为空串被 zod 挡在门外，forget 一次都不会被调到', async () => {
    const r = await invoke<{ ok: boolean; error?: string }>(IPC.MCP_SERVER_DELETE, '')
    expect(r.ok).toBe(false)
    expect(H.calls).toEqual([])
  })
})
