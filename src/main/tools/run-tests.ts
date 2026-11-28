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
import fs from 'node:fs'
import path from 'node:path'
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

// 测试文件路径白名单（SEC-16-01 纵深防御）：
//  - 字符集不含空格与 cmd 元字符（& | < > ^ % ! " ' ( )）——执行侧已改为直跑 Node（元字符 inert），
//    白名单兜底防未来有人改回经 shell 的执行方式；允许中文文件名（\u4e00-\u9fa5）
//  - 必须是 .test. / .spec. 后缀的测试文件（vitest 的 files 是过滤器，收敛成测试文件语义，
//    不支持目录/任意路径用法——目录过滤如需支持须另加白名单校验，不得放宽为任意路径）
const TEST_PATH_RE = /^[\w@.\-/\u4e00-\u9fa5]+$/
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/

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
    if (!TEST_PATH_RE.test(s) || !TEST_FILE_RE.test(s)) {
      throw new Error('测试文件路径非法：只允许形如 tests/foo.test.ts 的相对路径')
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
      '在 Agent 工作目录里跑 vitest 测试（只读、不改文件，无需确认）。参数：files（可选，相对工作目录的测试文件路径数组，只允许 .test./.spec. 后缀，不支持目录；留空则跑全部）、timeoutMs（可选，10000-120000）。要求工作区已安装 vitest。返回退出码与 Test Files / Tests 摘要。改完代码后用它验证。',
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
    // SEC-16-01：不再经 cmd.exe / npx 执行——模型提供的 files 参数曾可拼进 cmd 命令行，
    // 无空格的 & | > 会被 cmd 当分隔符/重定向（已实测复现）。改为以 Node 模式直跑 vitest 的
    // mjs 入口：路径作为独立 argv 传递，元字符永远 inert。
    // 注意两点：① 打包后 process.execPath 是 Electron 二进制，必须 ELECTRON_RUN_AS_NODE=1
    // 才是 Node；② 直跑入口没有 npx 的自动下载能力，要求 vitest 已安装在工作区。
    const vitestEntry = path.join(cwdAbs, 'node_modules', 'vitest', 'vitest.mjs')
    if (!fs.existsSync(vitestEntry)) {
      return JSON.stringify({
        ok: false,
        error: '工作区未安装 vitest（未找到 node_modules/vitest/vitest.mjs）。请先在项目里安装 vitest 再跑测试。'
      })
    }
    const child = spawn(
      process.execPath,
      [vitestEntry, 'run', ...files, '--reporter=dot'],
      {
        cwd: cwdAbs,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    )

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
