// M5：License 文件加载只认主进程对话框签发的令牌，渲染层直传路径被拒
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../src/shared/types'
import { peekPathToken, resetPathTokensForTest, issuePathToken } from '../src/main/ipc/dialog-path-token'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  loadFromFileAsync: vi.fn(async (..._args: unknown[]) => ({ valid: true })),
  showOpenDialog: vi.fn(),
  setLicensePath: vi.fn((..._args: unknown[]) => undefined),
  getLicensePath: vi.fn((..._args: unknown[]) => '')
}))

let tmp: string

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
  dialog: { showOpenDialog: (...args: unknown[]) => mocks.showOpenDialog(...args) }
}))

vi.mock('../src/main/license/license', () => ({
  licenseService: {
    loadFromStringAsync: vi.fn(),
    loadFromFileAsync: (...args: unknown[]) => mocks.loadFromFileAsync(...args),
    waitForBootLoad: vi.fn(),
    getStatus: () => ({}),
    hasFeature: () => false,
    clear: () => {}
  }
}))
vi.mock('../src/main/license/activation-client', () => ({ activateOnline: vi.fn() }))
vi.mock('../src/main/steward/hardware', () => ({ getDiskFingerprintAsync: vi.fn() }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    setLicensePath: (...args: unknown[]) => mocks.setLicensePath(...args),
    getLicensePath: (...args: unknown[]) => mocks.getLicensePath(...args)
  }
}))
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ warn: () => {} }) }))
vi.mock('../src/main/ipc/safe-handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/ipc/safe-handle')>()
  return {
    ...actual,
    // 保留真实 argsSchema 类型导出，只截获注册以便直接调用 listener；
    // schema 本身的拒绝由 ipc-schema-limits.test.ts 覆盖。
    safeHandle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn)
    }
  }
})

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-license-path-'))
  vi.doMock('../src/main/portable', () => ({ DATA_DIR: tmp }))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  mocks.handlers.clear()
  mocks.loadFromFileAsync.mockClear()
  mocks.showOpenDialog.mockReset()
  resetPathTokensForTest()
})

describe('LICENSE_LOAD_FILE 路径令牌', () => {
  it('对话框选中文件后签发令牌；令牌可换取该路径', async () => {
    const selected = path.join(tmp, 'license.lic')
    fs.writeFileSync(selected, 'LICENSE-CONTENT', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

    const { registerLicenseHandlers } = await import('../src/main/ipc/handlers/license')
    registerLicenseHandlers()
    const imported = (await mocks.handlers.get(IPC.LICENSE_IMPORT_FILE)!({})) as {
      canceled: boolean
      pathToken?: string
    }
    expect(imported.canceled).toBe(false)
    expect(imported.pathToken).toMatch(/^[0-9a-f-]{36}$/)
    expect(peekPathToken(imported.pathToken!)).toBe(selected)

    const status = await mocks.handlers.get(IPC.LICENSE_LOAD_FILE)!({}, imported.pathToken)
    expect(status).toEqual({ valid: true })
    expect(mocks.loadFromFileAsync).toHaveBeenCalledWith(selected)
  })

  it('渲染层直传绝对路径 / UNC 路径 → 无令牌，拒绝读取', async () => {
    const { registerLicenseHandlers } = await import('../src/main/ipc/handlers/license')
    registerLicenseHandlers()
    const load = mocks.handlers.get(IPC.LICENSE_LOAD_FILE)!
    for (const raw of ['C:\\Windows\\win.ini', '\\\\attacker\\share\\x', '/etc/passwd']) {
      await expect(load({}, raw)).rejects.toThrow(/令牌无效/)
      expect(mocks.loadFromFileAsync).not.toHaveBeenCalled()
    }
  })

  it('伪造/过期令牌同样被拒；只有 issued 的令牌有效', async () => {
    const selected = path.join(tmp, 'ok.lic')
    fs.writeFileSync(selected, 'LICENSE-CONTENT', 'utf8')
    const token = issuePathToken(selected)
    const { registerLicenseHandlers } = await import('../src/main/ipc/handlers/license')
    registerLicenseHandlers()
    await expect(
      mocks.handlers.get(IPC.LICENSE_LOAD_FILE)!({}, '00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow(/令牌无效/)
    await expect(mocks.handlers.get(IPC.LICENSE_LOAD_FILE)!({}, token)).resolves.toEqual({ valid: true })
  })
})
