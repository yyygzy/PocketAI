import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

describe('terminal-service', () => {
  it('should classify deny-only commands', async () => {
    const { classifyDenyOnly } = await import('../src/main/tools/shell-tools')
    expect(classifyDenyOnly('rm -rf /')).not.toBeNull()
    expect(classifyDenyOnly('rm -rf C:\\')).not.toBeNull()
    expect(classifyDenyOnly('ls')).toBeNull()
    expect(classifyDenyOnly('echo hello')).toBeNull()
  })

  it('should strip ANSI escape codes', async () => {
    const { stripAnsi } = await import('../src/renderer/src/modules/terminal/TerminalModule')
    expect(stripAnsi('\x1B[31mred\x1B[0m')).toBe('red')
    expect(stripAnsi('plain')).toBe('plain')
    expect(stripAnsi('\x1B[1;32mgreen\x1B[0m')).toBe('green')
  })
})
