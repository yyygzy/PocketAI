// V4-Iter-196：safeHandle 把抛错转成 **{ok:false} 返回值**，不是 rejection。
// 这个契约本身有测试钉住（否则"只挂 .catch"的写法看起来天经地义），并抽查四处调用点是否按契约判返回值。
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (e: unknown, ...a: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true }), showErrorBox: () => {} },
  BrowserWindow: class { static getAllWindows() { return [] } },
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  shell: { openPath: async () => '' },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))
vi.mock('../src/main/backup/backup-service', () => ({
  loadWebDAVConfig: vi.fn(() => ({ url: 'https://dav.example', username: 'u', passwordCipher: 'v1:x' })),
  listWebDAVBackups: vi.fn(async () => { throw new Error('WebDAV PROPFIND 401') }),
  createWebDAVClient: vi.fn(),
  runWebDAVBackup: vi.fn(),
  restoreFromWebDAV: vi.fn(),
  restoreFromLocalFile: vi.fn(),
  backupIncremental: vi.fn(),
  backupLocal: vi.fn(),
  listLocalBackups: vi.fn(() => []),
  getBackupSchedule: vi.fn(() => ({})),
  setBackupSchedule: vi.fn(),
  checkBackupIntegrity: vi.fn(async () => []),
  exportManifest: vi.fn()
}))

import { registerBackupHandlers } from '../src/main/ipc/handlers/backup'
import { IPC } from '../src/shared/types'

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8')

describe('列表类通道不许把失败咽成空数组', () => {
  it('WebDAV 列失败 ⇒ 返回 {ok:false,error}，而不是 [] 让界面显示「没有备份」', async () => {
    registerBackupHandlers()
    const r = (await handlers.get(IPC.BACKUP_WEBDAV_LIST)!({})) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(typeof r.error).toBe('string')
    expect(r.error).toContain('401')
  })

  it('反向对照：没配 WebDAV 时仍是空列表，不算失败', async () => {
    const { loadWebDAVConfig } = await import('../src/main/backup/backup-service')
    ;(loadWebDAVConfig as unknown as { mockReturnValue: (v: null) => void }).mockReturnValue(null)
    registerBackupHandlers()
    const r = (await handlers.get(IPC.BACKUP_WEBDAV_LIST)!({})) as unknown[]
    expect(Array.isArray(r)).toBe(true)
    expect(r).toEqual([])
  })
})

describe('调用点按契约判返回值（V4-Iter-196 的四处）', () => {
  const sites: Array<[string, string]> = [
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'if (hasIpcFailed(r))'],
    ['../src/renderer/src/modules/chat/AssistantEditor.tsx', 'if (isIpcFail(saved))'],
    ['../src/renderer/src/modules/chat/ChatConfigBar.tsx', 'if (isIpcFail(saved))'],
    ['../src/renderer/src/modules/settings/SettingsModule.tsx', 'if (hasIpcFailed(items))']
  ]
  for (const [file, needle] of sites) {
    it(`${path.basename(file)} 判了 ${needle}`, () => {
      expect(read(file)).toContain(needle)
    })
  }

  it('preload 的契约不再只声明成功形状（AssistantRecord／文件列表必须带上失败分支）', () => {
    const pre = read('../src/preload/index.ts')
    expect(pre).toContain('Promise<AssistantRecord | { ok: false; error: string }>')
    expect(pre).toContain('Promise<WebDAVBackupFile[] | { ok: false; error: string }>')
  })
})
