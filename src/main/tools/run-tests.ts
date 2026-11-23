// Agent 测试闭环：在用户项目目录（agent.workspace_dir）跑 vitest，返回结构化结果。
//
// 为什么不复用 shell.exec：跑测试只读不改文件，应是 auto 权限、不弹审批；shell.exec 在
// confirm 策略下会拦它，且它的输出是裸文本。这里独立 spawn vitest，解析摘要成字段，
// 让模型（尤其本地模型）能明确看到"过了几条、挂了几条"，形成 编辑→测试→修复 的闭环。
//
// 边界：
//  - cwd 锚定工作目录（复用 resolveWorkspacePath 的穿越守卫），只接受相对 tests 路径；
//  - 120s 上限（与 shell.exec 同口径），超时杀整个进程树；
//  - 默认跑用户项目自己的测试（打包后产品自身 tests/ 不存在，故不跑产品自测）。
import { spawn } from 'node:child_process'
import type { BuiltinTool } from './builtin'
import { resolveWorkspacePath } from './fs-tools'

const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 32 * 1024
const MAX_FILES = 50
const MAX_FILE_CHARS = 200

interface RunTestsArgs {
  files?: unknown
  timeoutMs?: unknown
}

function parseFiles(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('files 必须是字符串数组')
  if (raw.length > MAX_FILES) throw new Error(`一次最多 ${MAX_FILES} 个测试文件`)
  return raw.map((f) => {
    const s = String(f ?? '').trim().replace(/\\/g, '/')
    if (!s) throw new Error('测试文件路径不能为空')
    if (s.length > MAX_FILE_CHARS) throw new Error('测试文件路径过长')
    if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.includes('..')) {
      throw new Error('测试文件路径必须是工作目录内的相对路径')
    }
    return s
  })
}

/** 从 vitest dot 输出里抽 Test Files / Tests 摘要；抽不到就留空，不猜 */
function parseSummary(out: string): { files?: string; tests?: string; failed: boolean } {
  const fileLine = out.match(/Test Files[^\n]*?(\d+)\s+failed[^\n]*/)
  const failedCount = Number(fileLine?.[1] ?? '0')
  return {
    files: (out.match(/Test Files[^\n]*/) ?? [])[0],
    tests: (out.match(/Tests[^\n]*/) ?? [])[0],
    failed: failedCount > 0
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true, detached: true, stdio: 'ignore'
      })
      k.on('error', () => {})
      k.unref()
    } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}

const runTestsTool: BuiltinTool = {
  schema: {
    id: 'run_tests',
    name: 'run_tests',
    description:
      '在 Agent 工作目录里跑 vitest 测试（只读、不改文件，无需确认）。参数：files（可选，相对工作目录的测试文件路径数组；留空则跑全部）、timeoutMs（可选，10000-120000）。返回退出码与 Test Files / Tests 摘要。改完代码后用它验证。',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'number' }
      },
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: MAX_TIMEOUT_MS
  },
  async execute(args) {
    const a = args as RunTestsArgs
    const files = parseFiles(a.files)
    let timeout = Number(a.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (!Number.isFinite(timeout)) timeout = DEFAULT_TIMEOUT_MS
    timeout = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeout))

    const cwdAbs = resolveWorkspacePath('.') // 工作目录守卫（未设置会抛）
    const vitestArgs = ['vitest', 'run', ...files, '--reporter=dot']
    // Windows 下 npx 是 .cmd 批处理，spawn 必须经 cmd.exe（直接 spawn npx.cmd 会 EINVAL）；
    // 与 shell-tools 的 runCommand 同口径。POSIX 直接 spawn npx。
    const [cmd, spawnArgs] = process.platform === 'win32'
      ? ['cmd.exe' as string, ['/d', '/s', '/c', 'npx', ...vitestArgs] as string[]]
      : ['npx' as string, vitestArgs as string[]]
    const child = spawn(cmd, spawnArgs, {
      cwd: cwdAbs,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })

    return await new Promise<string>((resolve) => {
      let out = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid) killTree(child.pid)
      }, timeout)
      const append = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT_CHARS) out += chunk.toString('utf-8').slice(0, MAX_OUTPUT_CHARS - out.length)
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve(JSON.stringify({ ok: false, error: `启动测试失败：${e.message}` }))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const summary = parseSummary(out)
        resolve(JSON.stringify({
          ok: code === 0 && !timedOut,
          exitCode: code,
          timedOut,
          failed: summary.failed,
          files: summary.files ?? null,
          tests: summary.tests ?? null,
          output: out,
          outputTruncated: out.length >= MAX_OUTPUT_CHARS
        }))
      })
    })
  }
}

/** 未设置工作目录时不注册（与 shell/fs 工具同口径） */
export function getRunTestsTools(): BuiltinTool[] {
  try {
    resolveWorkspacePath('.')
  } catch {
    return []
  }
  return [runTestsTool]
}
