// @vitest-environment node
// V4-Iter-323① 真跨桥：本地恢复的「密码重试」那一发，令牌过期之后主进程到底做了什么。
//
// 缺陷本体：重试带的是主进程签发的路径令牌，TTL 十分钟（dialog-path-token.ts:11）。用户为了找
// 备份密码耗过十分钟再来点一次时，`peekPathToken` 返回 null，而改前的分支不报错——它**再弹一次
// 文件选择器**：于是「用户在第二只框里点了取消」被回成 `{ok:true, canceled:true}`，而渲染层
// `handleRestoreResult`（SettingsModule.tsx:1038）只看 `r.ok` ⇒ 关掉密码框、弹「恢复成功」，
// 其实整库一个字没换；若他在第二只框里选了别的备份，那份就被当成原来那份替换掉（不可逆）。
// 同一条规则 assistants.ts:72-73 早已写下：令牌失效不回落成「重新弹框再静默覆盖」。
//
// 真的：electron 桥形状、safeHandle（zod 入参＋抛错转 {ok:false}）、backup handler 本体、令牌语义。
// 假的：backup-service／merge-service（真下载真换库）、providers／mcp 管理器、logger／portable／scheduler／none-mode。
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { IPC } from '../src/shared/types'

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => Promise<unknown>>(),
  calls: [] as string[],
  /** 文件选择器：弹了几次、这次是取消还是选中 */
  dialogCalls: 0,
  dialogCanceled: false,
  dialogPath: 'C:\\ backups \\pocketai-full-2026-10-26.zip',
  /** 令牌是否还在有效期内（false＝过期，peek 返回 null） */
  tokenValid: true,
  restoreResult: { ok: true } as { ok: boolean; canceled?: boolean; code?: string; error?: string },
  /** 恢复实际拿到的那份路径——只有弹框选中的才准进这里 */
  restorePath: '' as string,
  reset() {
    this.calls = []
    this.dialogCalls = 0
    this.dialogCanceled = false
    this.tokenValid = true
    this.restoreResult = { ok: true }
    this.restorePath = ''
  }
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/pocketai-323', getVersion: () => '1.2.8' },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => Promise<unknown>) => {
      H.handlers.set(ch, fn)
    },
    on: () => {},
    removeListener: () => {}
  },
  dialog: {
    showOpenDialog: async () => {
      H.dialogCalls++
      return H.dialogCanceled
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [H.dialogPath] }
    },
    showSaveDialog: async () => ({ canceled: true, filePaths: [] }),
    showErrorBox: () => {}
  },
  // 首选用那发要走到选择器，所以必须有一扇可用的窗
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
    static getAllWindows() {
      return [{ id: 1 }]
    }
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('../src/main/portable', () => ({ DATA_DIR: '/tmp/pocketai-323/data' }))

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
  peekPathToken: (t: string | null | undefined) =>
    !t || !H.tokenValid || !t.startsWith('tok:') ? null : t.slice(4),
  dropPathToken: (t: string | null | undefined) => {
    if (t) H.calls.push('drop-token')
  }
}))

vi.mock('../src/main/backup/merge-service', () => ({
  scanMergeConflicts: async () => ({ ok: true, tables: [], attachmentsToAdd: 0 }),
  executeMerge: async () => ({ ok: true })
}))

vi.mock('../src/main/backup/backup-service', () => ({
  loadWebDAVConfig: () => null,
  saveWebDAVConfig: () => {},
  listWebDAVBackups: async () => [],
  deleteWebDAVBackup: async () => {},
  createLocalBackup: async () => '/tmp/pocketai-323/b.zip',
  createEncryptedLocalBackup: async () => ({ path: '/tmp/pocketai-323/b.enc.zip' }),
  restoreFromLocalFile: async (filePath: string) => {
    H.calls.push('restore-local')
    H.restorePath = filePath
    return H.restoreResult
  },
  restoreFromWebDAV: async () => ({ ok: true }),
  restoreIncrementalFromWebDAV: async () => ({ ok: true })
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: { invalidate: () => H.calls.push('provider-invalidate') }
}))

vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: {
    reconcileRuntimes: async () => {
      H.calls.push('mcp-reconcile')
      return []
    },
    stopAll: async () => {},
    listRuntimes: () => []
  }
}))

import { registerBackupHandlers } from '../src/main/ipc/handlers/backup'

async function invoke<T = unknown>(...args: unknown[]): Promise<T> {
  const fn = H.handlers.get(IPC.BACKUP_LOCAL_RESTORE)
  if (!fn) throw new Error('渲染层指向了一个没人注册的通道')
  return (await fn({ sender: { send: () => {}, isDestroyed: () => false } }, ...args)) as T
}

beforeAll(() => {
  registerBackupHandlers()
})

beforeEach(() => {
  H.reset()
})

describe('§323① 本地恢复：密码重试那一发不许把「过期」演成「恢复成功」', () => {
  it('带了令牌但已过期 ⇒ 明确失败、一句「重新选择文件」，一次框都不弹、一次恢复都不发', async () => {
    H.tokenValid = false
    const r = await invoke<{ ok: boolean; canceled?: boolean; error?: string }>({
      restoreToken: 'tok:C:\\backups\\a.zip',
      backupPassword: '备份密码'
    })
    expect(r.ok, '这就是那张谎报成功的脸：ok:true 时界面只会说「恢复成功」').toBe(false)
    expect(r.canceled, '更不许把取消当成一次完成').toBeUndefined()
    expect(r.error).toContain('重新选择')
    expect(H.dialogCalls, '重弹选择器＝用户可能选了另一份备份被当成原来那份').toBe(0)
    expect(H.calls, '什么都没换 ⇒ 恢复与收尾对账都不该发生').toEqual([])
  })

  it('反向对照：令牌还在 ⇒ 一次框都不弹、真走恢复，收尾对账照旧（§315 不许被这枚改动）', async () => {
    const r = await invoke<{ ok: boolean; error?: string }>({
      restoreToken: 'tok:C:\\backups\\a.zip',
      backupPassword: '备份密码'
    })
    expect(r.ok).toBe(true)
    expect(H.dialogCalls).toBe(0)
    expect(H.calls).toEqual(['restore-local', 'drop-token', 'provider-invalidate', 'mcp-reconcile'])
  })

  it('首次调用（没带令牌）⇒ 仍弹一次选择器，选中的那份交给恢复', async () => {
    const r = await invoke<{ ok: boolean }>()
    expect(r.ok).toBe(true)
    expect(H.dialogCalls, '首选用弹框是这套令牌的本意，不许一并砍掉').toBe(1)
    expect(H.calls).toEqual(['restore-local', 'drop-token', 'provider-invalidate', 'mcp-reconcile'])
  })

  it('首次调用里用户取消 ⇒ 语义不动（{ok:true, canceled:true}），但一次恢复都不发、也不对账', async () => {
    H.dialogCanceled = true
    const r = await invoke<{ ok: boolean; canceled?: boolean }>()
    expect(r).toEqual({ ok: true, canceled: true })
    expect(H.calls, '用户没选任何文件 ⇒ 既没换库也不该清运行时；渲染层 :1077 判 canceled 静默').toEqual([])
  })

  it('恢复本身回「需要备份密码」⇒ 令牌留在手里等重试，只把令牌与文件名带回（路径不进渲染层）', async () => {
    H.restoreResult = { ok: false, code: 'needBackupPassword', error: '当前主密码解不开' }
    const r = await invoke<{ ok: boolean; code?: string; restoreToken?: string; fileName?: string }>()
    expect(r.code).toBe('needBackupPassword')
    expect(r.restoreToken).toBe(`tok:${H.dialogPath}`)
    expect(r.fileName).toBe('pocketai-full-2026-10-26.zip')
    expect(H.calls, '令牌要留给下一次重试 ⇒ 不许 drop；对账按 §315「不问成败」照旧跑').toEqual([
      'restore-local',
      'provider-invalidate',
      'mcp-reconcile'
    ])
  })

  it('渲染端硬塞 filePath 也没用：zod 会把它剥掉，路径只能来自这一发的弹框', async () => {
    const r = await invoke<{ ok: boolean; error?: string }>({ filePath: 'C:\\backups\\随便一份.zip' })
    expect(r.ok).toBe(true)
    expect(H.dialogCalls, '没有合法令牌 ⇒ 按首选用走弹框（这条是 SEC-6 的正面：路径由主进程选）').toBe(1)
    // 兜住这条的不是 zod（未知键只是被剥掉），而是 handler 只把弹框返回值喂给恢复
    expect(H.restorePath).toBe(H.dialogPath)
    expect(H.calls).toEqual(['restore-local', 'drop-token', 'provider-invalidate', 'mcp-reconcile'])
  })
})
