// 真起进程的崩溃用例：**不 mock child_process**
//
// 「必然失败的启动被当崩溃重播 4 遍」这种问题，桩掉 spawn 的测试永远测不出来
// （Windows npx ENOENT 藏了几百个绿用例就是同一类）。这里让子进程真的起来、真的打一行
// stderr、真的以 code 1 退出，然后数它被拉起了几次。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerRecord, McpServerStatusEvent } from '../src/shared/types'

const mocks = vi.hoisted(() => ({ repoList: [] as McpServerRecord[] }))

vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: {
    list: () => mocks.repoList.slice(),
    get: (id: string) => mocks.repoList.find((r) => r.id === id) ?? null
  }
}))
vi.mock('../src/main/mcp/python-env', () => ({
  pythonEnvService: { getEnvState: async () => ({ status: 'none' }) },
  venvPython: (id: string) => `/venv/${id}/python.exe`,
  venvDir: (id: string) => `/venv/${id}`,
  venvBinDir: (id: string) => `/venv/${id}/bin`
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { McpManager } from '../src/main/mcp/manager'

const dir = path.join(os.tmpdir(), 'pocketai-crash-test')
const extDir = path.join(dir, 'ext')
const attemptsFile = path.join(dir, 'attempts.txt')

vi.mock('../src/main/portable', () => ({
  MCP_EXTENSIONS_DIR: path.join(os.tmpdir(), 'pocketai-crash-test', 'ext')
}))

/** 起来 → 记一次尝试 → 打一行 stderr → 150ms 后 code 1 退出（留时间给父进程读完那行） */
const SCRIPT = [
  'const fs=require("node:fs");',
  'fs.appendFileSync(process.env.POCKETAI_ATTEMPTS_FILE,"attempt\\n");',
  'process.stderr.write("npm error code E404 simulated\\n");',
  'setTimeout(()=>process.exit(1),150);'
].join('')

function crashRecord(over: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: 'crash1',
    name: 'crash',
    transport: 'stdio',
    runtime: 'binary',
    command: process.execPath,
    args: ['-e', SCRIPT],
    env: { POCKETAI_ATTEMPTS_FILE: attemptsFile },
    url: null,
    headers: {},
    enabled: true,
    pythonPackages: [],
    trustReadOnly: false,
    createdAt: 1,
    ...over
  } as McpServerRecord
}

beforeAll(() => {
  fs.mkdirSync(extDir, { recursive: true })
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('stdio 启动即退出（真实进程）', () => {
  it('只拉起一次就转 error，并把 stderr 里的真实原因带进 lastError', async () => {
    fs.writeFileSync(attemptsFile, '')
    mocks.repoList = [crashRecord()]
    const mgr = new McpManager()
    const events: McpServerStatusEvent[] = []
    const off = mgr.onStatus((e) => events.push(e))

    await expect(mgr.start('crash1')).rejects.toThrow()

    // 修复前：handleExit 把它当崩溃，最多重启 3 次 ⇒ 这里会出现 2–4 行
    const attempts = fs
      .readFileSync(attemptsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(attempts).toHaveLength(1)

    const last = events.at(-1)!
    expect(last.status).toBe('error')
    expect(last.lastError).toContain('进程启动后立即退出 (code=1')
    expect(last.lastError).toContain('E404 simulated')
    expect(events.some((e) => e.lastError?.includes('自动重启'))).toBe(false)
    off()
  }, 20_000)
})
