// V4-Iter-196：safeHandle 把抛错转成 **{ok:false} 返回值**，不是 rejection。
// 这个契约本身有测试钉住（否则"只挂 .catch"的写法看起来天经地义），并抽查调用点是否按契约判返回值。
// V4-Iter-204 起：chat 发起链改成按调用点切区域逐个判——文件级 toContain 会放行漏判的那条。
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

// V4-Iter-204：上面那种"文件级 toContain"对 chat 发起链不够用——
// ChatModule 里有 send／regenerate／resend 三条链共用 `if (hasIpcFailed(r))` 这串字符，
// 主发送链写成 `.then((r) => { void r })` 时文件里仍留着另外两条的 guard ⇒ CI 全绿、真机零反馈。
// 所以按调用点切区域，一条一条判。
describe('chat 发起类通道：五个入口逐个核对（V4-Iter-204）', () => {
  const CHAINS: Array<[string, string, string]> = [
    ['../src/renderer/src/modules/chat/ChatModule.tsx', '.sendMessage(', 'onChatSendFailed'],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', '.regenerateMessage(', 'onChatSendFailed'],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', '.resendMessage(', 'onChatSendFailed'],
    ['../src/renderer/src/modules/agent/hooks/useAgentChat.ts', '.sendMessage(', 'fail('],
    ['../src/renderer/src/popup/PopupApp.tsx', '.sendMessage(', 'failSend(']
  ]

  for (const [file, chan, handler] of CHAINS) {
    it(`${path.basename(file)} 的 ${chan} 判了返回值并接上 ${handler}`, () => {
      const text = read(file).replace(/\r\n/g, '\n')
      const start = text.indexOf(chan)
      expect(start, `找不到调用点 ${chan}`).toBeGreaterThanOrEqual(0)
      const end = text.indexOf('.catch(', start)
      expect(end, `${chan} 之后必须挂 .catch(`).toBeGreaterThan(start)
      const region = text.slice(start, end)
      // 区域不许溢出到下一条链：否则"隔壁的 guard"会把漏判的那条照绿（就是 196 闸门当时的失效方式）
      expect(region).not.toContain('window.pocketai')
      expect(region).toContain('hasIpcFailed(r)')
      // V4-Iter-209：交接的是**整个失败对象**——先抽 `ipcFailText(r, …)` 就把 ipcCode/ipcArgs 丢了，回码永不生效
      expect(region, `${chan} 必须把失败对象 r 交给 ${handler}`).toMatch(
        new RegExp(`${handler.replace(/[()]/g, '\\$&')}[^\\n]*\\br\\)`)
      )
      expect(region).not.toContain('ipcFailText(r')
    })
  }

  it('BUDGET_EXCEEDED 回码只在 utils/ipc.ts 翻译一次（再写一份正则就会有一个入口漏文案）', () => {
    const root = path.resolve(__dirname, '../src/renderer')
    // 注释里提这个词是讲历史，不算翻译点
    const codeOf = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/^(\/\/|\*|\/\*)/.test(l.trim()))
        .join('\n')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(ent.name) && codeOf(read(p)).includes('BUDGET_EXCEEDED')) hits.push(path.relative(root, p))
      }
    }
    walk(root)
    expect(hits.map((h) => h.replace(/\\/g, '/'))).toEqual(['src/utils/ipc.ts'])
  })
})
