// 编辑后自动验证 hook：把 typecheck 与 vitest related 的结果追加到编辑工具回执。
//
// 设计口径：
//  - 只有用户显式打开 `agent.post_edit_validation_enabled` 才跑（默认关）；
//  - 只跟 fs_write / fs_apply_patch 这两种"确实写了工作区"的工具；
//  - 验证失败不改工具成功状态：写入已经发生，把失败当工具失败会让模型误判需要重写文件；
//  - 输出摘要而非全量日志，避免把 Agent 上下文撑爆。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveWorkspacePath } from '../tools/fs-tools'
import { errMsg } from '../error'

const TYPECHECK_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 180_000
const MAX_OUTPUT_CHARS = 6000
const MAX_PATHS = 20

const EDIT_TOOL_NAMES = new Set([
  'fs.write', 'fs_write', 'fs.apply_patch', 'fs_apply_patch'
])

interface CommandResult {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  output: string
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

async function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    let out = ''
    let timedOut = false
    let aborted = false
    const child = spawn(cmd, args, {
      cwd: resolveWorkspacePath('.'),
      windowsHide: true,
      detached: process.platform !== 'win32',
      ...(env ? { env } : {})
    })
    const append = (chunk: Buffer): void => {
      if (out.length < MAX_OUTPUT_CHARS) {
        out += chunk.toString('utf-8').slice(0, MAX_OUTPUT_CHARS - out.length)
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      if (child.pid) killTree(child.pid)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', (e) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok: false, exitCode: null, timedOut, aborted, output: `启动失败：${errMsg(e)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok: code === 0 && !timedOut && !aborted, exitCode: code, timedOut, aborted, output: out })
    })
  })
}

/**
 * 以 Node 模式直跑工作区里的 vitest 入口（绕开 cmd.exe / npx，模型可控路径不进 shell 命令行）。
 * 工作区未安装 vitest 时返回可读的跳过结果，不抛——验证失败不改工具成功状态。
 */
async function runVitestRelated(
  vitestArgs: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CommandResult> {
  const skip: CommandResult = { ok: false, exitCode: null, timedOut: false, aborted: false, output: '' }
  let entry: string
  try {
    entry = path.join(resolveWorkspacePath('.'), 'node_modules', 'vitest', 'vitest.mjs')
  } catch {
    return { ...skip, output: '未设置 Agent 工作目录，已跳过相关测试' }
  }
  if (!fs.existsSync(entry)) {
    return { ...skip, output: '工作区未安装 vitest（未找到 node_modules/vitest/vitest.mjs），已跳过相关测试' }
  }
  return await runCommand(
    process.execPath,
    [entry, ...vitestArgs],
    timeoutMs,
    signal,
    // 打包后 process.execPath 是 Electron 二进制，必须切 Node 模式才能跑 mjs 入口
    { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  )
}

function summaryLine(out: string): string {
  const testFiles = out.match(/Test Files[^\n]*/)?.[0]
  const tests = out.match(/Tests[^\n]*/)?.[0]
  return [testFiles, tests].filter(Boolean).join('；').slice(0, 240)
}

function commandLabel(r: CommandResult, label: string): string {
  if (r.aborted) return `${label}：已中止`
  if (r.timedOut) return `${label}：超时`
  const detail = summaryLine(r.output)
  if (r.ok) return `${label}：通过${detail ? `（${detail}）` : ''}`
  return `${label}：失败（退出码 ${r.exitCode ?? '未知'}）${detail ? `（${detail}）` : ''}`
}

/** 从编辑工具回执 JSON 中取相对工作目录路径；格式不符时返回空数组（不猜） */
export function collectEditedPaths(toolName: string, content: string): string[] {
  if (!EDIT_TOOL_NAMES.has(toolName)) return []
  try {
    const data = JSON.parse(content) as Record<string, unknown>
    const pick = (raw: unknown): string => {
      const p = String(raw ?? '').trim().replace(/\\/g, '/')
      return p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('..') ? p : ''
    }
    if (toolName === 'fs.write' || toolName === 'fs_write') {
      const path = pick(data.path)
      return path ? [path] : []
    }
    const files = Array.isArray(data.files) ? data.files : []
    return files
      .map((f) => pick((f as Record<string, unknown> | null)?.path))
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 跑一轮自动验证，返回可直接追加到工具回执的摘要。
 * 任何失败都只写进摘要，不抛出——编辑本身成功的事实不能被验证失败改写。
 */
export async function runPostEditValidation(changedPaths: string[], signal?: AbortSignal): Promise<string> {
  const paths = Array.from(new Set(
    changedPaths
      .map((p) => String(p).trim().replace(/\\/g, '/'))
      .filter((p) => p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('..'))
  )).slice(0, MAX_PATHS)
  if (paths.length === 0) return '[自动验证] 未识别到改动文件，已跳过'

  if (process.platform === 'win32') {
    // typecheck 的 argv 是固定串（无模型输入），保留 cmd.exe 口径；
    // vitest related 的文件路径来自模型写入回执（模型可控），不能进 cmd 命令行——
    // 无空格的 & | > 会被 cmd 当分隔符/重定向（SEC-16-01 同族，已在 run_tests 实测复现）。
    // 与 run_tests 同口径：以 Node 模式直跑 vitest 的 mjs 入口（ELECTRON_RUN_AS_NODE），
    // 路径作为独立 argv 传递，元字符永远 inert。
    const typecheck = await runCommand('cmd.exe', ['/d', '/s', '/c', 'npm', 'run', 'typecheck'], TYPECHECK_TIMEOUT_MS, signal)
    const related = await runVitestRelated(['related', ...paths, '--run', '--reporter=dot'], TEST_TIMEOUT_MS, signal)
    const noTests = /No test files found|No test files were found/i.test(related.output)
    return [
      '[自动验证]',
      commandLabel(typecheck, 'typecheck'),
      noTests && related.ok
        ? '相关测试：未找到匹配用例（已跳过）'
        : commandLabel(related, '相关测试')
    ].join('\n')
  }

  const typecheck = await runCommand('npm', ['run', 'typecheck'], TYPECHECK_TIMEOUT_MS, signal)
  const related = await runVitestRelated(['related', ...paths, '--run', '--reporter=dot'], TEST_TIMEOUT_MS, signal)
  const noTests = /No test files found|No test files were found/i.test(related.output)
  return [
    '[自动验证]',
    commandLabel(typecheck, 'typecheck'),
    noTests && related.ok
      ? '相关测试：未找到匹配用例（已跳过）'
      : commandLabel(related, '相关测试')
  ].join('\n')
}
