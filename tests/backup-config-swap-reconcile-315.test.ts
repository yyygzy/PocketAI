// @vitest-environment node
// V4-Iter-315 真跨桥：配置被**整批**换掉的那几条入口，收尾必须对账两份以配置行为键的内存态。
//
// 为什么桥层这一份不能省：`mcp-manager` 那份用例证的是 `reconcileRuntimes()` 本身算得对，
// 它证不了**合并／恢复那几条 IPC 有没有去叫它**——而"忘了叫"恰恰是这个缺陷的形状
// （§314 之前也没人叫 forget）。这里把 handler 真注册进 ipcMain 桩、真按通道名 invoke，
// 合并桩与恢复桩只负责"把库换了"，对账是否发生、顺序对不对、summary 那句话诚不诚实，全在这一份里钉。
//
// 真的：electron 桥形状、safeHandle（zod 入参＋抛错转 {ok:false}）、backup handler 本体、summary 拼装。
// 假的：merge-service／backup-service（真下载真换库在 CI 里既慢又不必）、providers/manager、mcp/manager、
//       scheduler／portable／none-mode／logger／path-token。
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { IPC, type MergeStrategy } from '../src/shared/types'

const ID = 'a1b2c3d4-0000-4000-8000-000000000001'

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => Promise<unknown>>(),
  /** 跨界调用按发生顺序记录——"先换库再对账"这种判据只能从序列读出来 */
  calls: [] as string[],
  cfg: null as unknown,
  mergeResult: { ok: true, summary: 'mcp_servers: 3 行(云端)' } as {
    ok: boolean; summary?: string; error?: string; code?: string
  },
  mergeThrows: false,
  restoreThrows: false,
  reconcileStopped: [] as string[],
  reconcileThrows: false,
  reset() {
    this.calls = []
    this.cfg = { url: 'https://dav.example.com/d', directory: '/b', username: 'u', passwordCipher: 'x' }
    this.mergeResult = { ok: true, summary: 'mcp_servers: 3 行(云端)' }
    this.mergeThrows = false
    this.restoreThrows = false
    this.reconcileStopped = []
    this.reconcileThrows = false
  }
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/pocketai-315', getVersion: () => '1.2.8' },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => Promise<unknown>) => {
      H.handlers.set(ch, fn)
    },
    on: () => {},
    removeListener: () => {}
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePaths: [] }),
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

vi.mock('../src/main/portable', () => ({ DATA_DIR: '/tmp/pocketai-315/data' }))

vi.mock('../src/main/backup/backup-scheduler', () => ({
  getBackupSchedule: () => ({ enabled: false }),
  setBackupSchedule: () => ({ enabled: false }),
  noteManualBackup: () => {}
}))

vi.mock('../src/main/crypto/none-mode-gate', () => ({
  isNoneMode: () => false,
  newSecretKeys: () => [],
  NONE_MODE_HINT: ''
}))

vi.mock('../src/main/ipc/dialog-path-token', () => ({
  issuePathToken: (p: string) => `tok:${p}`,
  peekPathToken: (t: string) => (t.startsWith('tok:') ? t.slice(4) : null),
  dropPathToken: () => {}
}))

vi.mock('../src/main/backup/merge-service', () => ({
  scanMergeConflicts: async () => ({ ok: true, tables: [], attachmentsToAdd: 0 }),
  executeMerge: async () => {
    H.calls.push('merge')
    if (H.mergeThrows) throw new Error('云库打不开')
    return H.mergeResult
  }
}))

vi.mock('../src/main/backup/backup-service', () => ({
  loadWebDAVConfig: () => H.cfg,
  saveWebDAVConfig: () => {},
  restoreWebDAVPassword: (c: unknown) => c,
  listWebDAVBackups: async () => [],
  deleteWebDAVBackup: async () => {},
  createLocalBackup: async () => '/tmp/pocketai-315/b.zip',
  createEncryptedLocalBackup: async () => ({ path: '/tmp/pocketai-315/b.enc.zip' }),
  restoreFromLocalFile: async () => {
    H.calls.push('restore-local')
    if (H.restoreThrows) throw new Error('包损坏')
    return { ok: true }
  },
  restoreFromWebDAV: async () => {
    H.calls.push('restore-webdav')
    return { ok: true }
  },
  restoreIncrementalFromWebDAV: async () => {
    H.calls.push('restore-inc')
    if (H.restoreThrows) throw new Error('增量索引坏')
    return { ok: true }
  }
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    invalidate: () => {
      H.calls.push('provider-invalidate')
    }
  }
}))

vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: {
    reconcileRuntimes: async () => {
      H.calls.push('mcp-reconcile')
      if (H.reconcileThrows) throw new Error('停机失败')
      return H.reconcileStopped
    },
    stopAll: async () => {},
    listRuntimes: () => []
  }
}))

import { registerBackupHandlers } from '../src/main/ipc/handlers/backup'

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = H.handlers.get(channel)
  if (!fn) throw new Error(`渲染层指向了一个没人注册的通道：${channel}`)
  return (await fn({ sender: { send: () => {}, isDestroyed: () => false } }, ...args)) as T
}

const mergePayload = { filename: 'pocketai-full-2026-10-25.zip', strategy: 'cloud' satisfies MergeStrategy }

beforeAll(() => {
  registerBackupHandlers()
})

beforeEach(() => {
  H.reset()
})

describe('§315 合并／恢复收尾的运行时对账', () => {
  it('合并成功 ⇒ 换库之后立刻对账两份登记表，停了几台走结构化字段回界面', async () => {
    H.reconcileStopped = [ID, 'srv2']
    const r = await invoke<{ ok: boolean; summary?: string; mcpStopped?: number }>(
      IPC.BACKUP_WEBDAV_MERGE_EXECUTE,
      mergePayload
    )
    expect(H.calls, '顺序必须是先换库、再清适配器、再对账运行时').toEqual([
      'merge',
      'provider-invalidate',
      'mcp-reconcile'
    ])
    expect(r.mcpStopped).toBe(2)
    // summary 这条通道渲染层今天一个字都不读（成功分支只拼 mergeOk／mergeCredNote）⇒ 不该往里写字
    expect(r.summary).toBe('mcp_servers: 3 行(云端)')
  })

  it('一台都没停 ⇒ 不许回 mcpStopped（界面那句也就不会出现）', async () => {
    H.reconcileStopped = []
    const r = await invoke<{ ok: boolean; summary?: string; mcpStopped?: number }>(IPC.BACKUP_WEBDAV_MERGE_EXECUTE, mergePayload)
    expect(r.mcpStopped, '写了 0 就等于让界面说"停了 0 台"').toBeUndefined()
    expect(r.summary).toBe('mcp_servers: 3 行(云端)')
  })

  it('合并本身回 ok:false 也要对账——整表覆盖排在附件合并之前，失败的那发可能已经换了配置', async () => {
    H.mergeResult = { ok: false, code: 'badPassword', error: '备份密码不对' }
    const r = await invoke<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_MERGE_EXECUTE, mergePayload)
    expect(r.ok).toBe(false)
    expect(H.calls).toEqual(['merge', 'provider-invalidate', 'mcp-reconcile'])
  })

  it('合并抛错 ⇒ 仍对账，且这次结果照旧是 {ok:false,错误原文}（对账不能把失败洗成成功）', async () => {
    H.mergeThrows = true
    const r = await invoke<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_MERGE_EXECUTE, mergePayload)
    expect(r.ok).toBe(false)
    // errMsg(e, 前缀) 的语义是"有原文就用原文"，所以这里必须是抛出去那句而不是「合并失败」
    expect(r.error).toBe('云库打不开')
    expect(H.calls).toEqual(['merge', 'provider-invalidate', 'mcp-reconcile'])
  })

  it('本地恢复成功 ⇒ 对账被调（库文件整体换掉了，适配器与运行时都还是旧库那份）', async () => {
    const r = await invoke<{ ok: boolean }>(IPC.BACKUP_LOCAL_RESTORE, { restoreToken: 'tok:C:\\b.zip' })
    expect(r.ok).toBe(true)
    expect(H.calls).toEqual(['restore-local', 'provider-invalidate', 'mcp-reconcile'])
  })

  it('WebDAV 全量恢复与增量恢复两条分支都要对账（少一条就是漏了一个入口）', async () => {
    await invoke(IPC.BACKUP_WEBDAV_RESTORE, 'pocketai-full-2026-10-25.zip')
    expect(H.calls).toEqual(['restore-webdav', 'provider-invalidate', 'mcp-reconcile'])
    H.calls.length = 0
    H.reconcileStopped = [ID]
    const r = await invoke<{ ok: boolean }>(IPC.BACKUP_WEBDAV_RESTORE, 'pocketai-inc-2026-10-25.zip')
    expect(r.ok).toBe(true)
    expect(H.calls).toEqual(['restore-inc', 'provider-invalidate', 'mcp-reconcile'])
  })

  it('增量恢复抛错 ⇒ 错误原文照旧带回（那句默认前缀只在没有 message 时生效），且仍然对账', async () => {
    H.restoreThrows = true
    const r = await invoke<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_RESTORE, 'pocketai-inc-2026-10-25.zip')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('增量索引坏')
    expect(H.calls).toEqual(['restore-inc', 'provider-invalidate', 'mcp-reconcile'])
  })

  it('对账自己失败 ⇒ 不把已经做成的合并报成失败，但要把"没做成"回给界面（那句只能建议重启）', async () => {
    H.reconcileThrows = true
    const r = await invoke<{ ok: boolean; error?: string; mcpStopped?: number; reconcileFailed?: boolean }>(
      IPC.BACKUP_WEBDAV_MERGE_EXECUTE,
      mergePayload
    )
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.reconcileFailed).toBe(true)
    expect(r.mcpStopped, '对账没做成 ⇒ 不知道停了几台，就不能回一个数字')
      .toBeUndefined()
  })

  it('没配 WebDAV ⇒ 早退，什么都没换就别去清运行时（反向钉：对账只跟着真换库的入口走）', async () => {
    H.cfg = null
    const r = await invoke<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_MERGE_EXECUTE, mergePayload)
    expect(r.ok).toBe(false)
    expect(H.calls, '连合并都没开始，更不该清适配器').toEqual([])
  })
})
