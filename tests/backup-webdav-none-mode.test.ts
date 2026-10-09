// WebDAV 备份口令保存闸门的 handler 级测试（SEC-1 方案 B2）
//
// 闸在 IPC 入口而不是 saveWebDAVConfig：加密模式切换/改密的轮换流程会直连 service
// 重存口令（那一步恰好处于 none 态），若把闸门做进 service 会把禁用加密的流程打断。
// 这里用 handler 捕获桩直接调通道，断言「新口令拒、原口令放行、db 模式放行」，
// 并确认被拒时 saveWebDAVConfig 一次都没被调用。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC, type WebDAVConfig } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  mode: 'none' as 'none' | 'db',
  stored: '',
  hasCfg: false,
  saved: [] as WebDAVConfig[]
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => mocks.handlers.set(ch, fn) },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    static fromWebContents() { return undefined }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showErrorBox: () => {}
  },
  app: { isPackaged: false, getPath: () => process.cwd(), getAppPath: () => process.cwd(), quit: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getMode: () => mocks.mode }
}))

vi.mock('../src/main/backup/backup-scheduler', () => ({
  getBackupSchedule: () => ({ enabled: false, intervalHours: 24, retentionCount: 7 }),
  setBackupSchedule: () => ({}),
  noteManualBackup: () => {}
}))

vi.mock('../src/main/portable', () => ({ DATA_DIR: process.cwd() }))

vi.mock('../src/main/backup/backup-service', () => ({
  saveWebDAVConfig: (cfg: WebDAVConfig) => { mocks.saved.push(cfg) },
  loadWebDAVConfig: (): WebDAVConfig | null =>
    mocks.hasCfg
      ? { url: 'https://dav.example.com', username: 'u', passwordCipher: mocks.stored, directory: '' }
      : null,
  // 其余导出在被测通道里不会被调用，仅为避免模块形状不符
  createLocalBackup: async () => ({ path: '', size: 0, encrypted: false, saltB64: '' }),
  createEncryptedLocalBackup: async () => ({ path: '', size: 0, encrypted: true, saltB64: '' })
}))

import { registerBackupHandlers } from '../src/main/ipc/handlers/backup'

function cfg(password: string): WebDAVConfig {
  return { url: 'https://dav.example.com', username: 'u', passwordCipher: password, directory: 'bk' }
}

async function callSave(password: string): Promise<{ ok: boolean; error?: string }> {
  const handler = mocks.handlers.get(IPC.BACKUP_WEBDAV_SAVE_CONFIG)
  if (!handler) throw new Error('通道未注册')
  return (await handler({}, cfg(password))) as { ok: boolean; error?: string }
}

beforeEach(() => {
  mocks.mode = 'none'
  mocks.stored = ''
  mocks.hasCfg = false
  mocks.saved = []
  registerBackupHandlers()
})

describe('BACKUP_WEBDAV_SAVE_CONFIG 的 none 模式闸门', () => {
  it('首次配置就带口令 → 拒绝，且不落盘', async () => {
    const r = await callSave('backup-pwd-1')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('备份口令')
    expect(r.error).toContain('主密码')
    expect(mocks.saved).toHaveLength(0)
  })

  it('口令与已存值一致（只改地址/目录）→ 放行', async () => {
    mocks.stored = 'backup-pwd-1'
    mocks.hasCfg = true
    const r = await callSave('backup-pwd-1')
    expect(r.ok).toBe(true)
    expect(mocks.saved).toHaveLength(1)
  })

  it('改口令 → 拒绝，旧配置不动', async () => {
    mocks.stored = 'backup-pwd-1'
    mocks.hasCfg = true
    const r = await callSave('backup-pwd-2')
    expect(r.ok).toBe(false)
    expect(mocks.saved).toHaveLength(0)
  })

  it('根本没填口令 → 放行（没有密钥材料可保护，也不该挡住配置）', async () => {
    const r = await callSave('')
    expect(r.ok).toBe(true)
    expect(mocks.saved).toHaveLength(1)
  })

  it('已设主密码（db 模式）→ 新口令照常保存', async () => {
    mocks.mode = 'db'
    const r = await callSave('backup-pwd-1')
    expect(r.ok).toBe(true)
    expect(mocks.saved).toHaveLength(1)
  })

  it('拒绝文案里不出现口令本身', async () => {
    const r = await callSave('super-secret-backup-pwd')
    expect(r.error).not.toContain('super-secret-backup-pwd')
  })
})
