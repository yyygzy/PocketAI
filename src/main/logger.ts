// 主进程统一日志
//
// - 级别：debug < info < warn < error
//   开发（未打包）默认 debug，打包后默认 info；可用环境变量 MOXIA_LOG_LEVEL 覆盖
// - 输出：控制台带级别标签与时间戳；打包后同步落盘 userData/logs/main.log
//   文件超过 1MB 滚动一次（main.log → main.old.log），避免无限增长
// - 日志路径解析失败（如 electron 未就绪、测试环境打桩）时自动禁落盘，绝不抛错影响业务

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const MAX_LOG_BYTES = 1024 * 1024 // main.log 达到 1MB 时滚动

// ANSI 颜色（仅 TTY 控制台使用，不写入文件）
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // 灰
  info: '\x1b[36m', // 青
  warn: '\x1b[33m', // 黄
  error: '\x1b[31m' // 红
}
const RESET = '\x1b[0m'

function resolveInitialLevel(): LogLevel {
  const env = process.env.MOXIA_LOG_LEVEL
  if (env && (LEVEL_ORDER as readonly string[]).includes(env)) return env as LogLevel
  try {
    return app.isPackaged ? 'info' : 'debug'
  } catch {
    return 'info'
  }
}

let currentLevel: LogLevel = resolveInitialLevel()

/** 运行时调整日志级别（设置页/调试开关可复用） */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * 创建带模块标签的 logger，输出形如：
 *   2026-09-23 16:46:39 INFO  [backup] 本地备份完成
 */
export function createLogger(scope: string): Logger {
  const tag = `[${scope}]`
  return {
    debug: (...args: unknown[]) => emit('debug', tag, args),
    info: (...args: unknown[]) => emit('info', tag, args),
    warn: (...args: unknown[]) => emit('warn', tag, args),
    error: (...args: unknown[]) => emit('error', tag, args)
  }
}

// ─── 内部实现 ────────────────────────────────────────────────────────────

function timestamp(): string {
  const d = new Date()
  const p = (n: number, len = 2) => String(n).padStart(len, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
      try {
        return inspect(a, { depth: 4, breakLength: 120 })
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

function emit(level: LogLevel, tag: string, args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return
  const time = timestamp()
  const text = formatArgs(args)
  const label = level.toUpperCase().padEnd(5)

  // 控制台：TTY 下着色
  const sink =
    level === 'warn' ? console.warn : level === 'error' ? console.error : console.log
  if (process.stdout?.isTTY) {
    sink(`${time} ${COLORS[level]}${label}${RESET} ${tag} ${text}`)
  } else {
    sink(`${time} ${label} ${tag} ${text}`)
  }

  appendToFile(`${time} ${label} ${tag} ${text}`)
}

// ─── 文件落盘（惰性初始化，失败自禁用） ──────────────────────────────────

let configuredDir: string | null = null
let logFilePath: string | null | undefined
let fileFailures = 0

/**
 * 指定日志目录（主进程 boot 阶段 ensureDirs 后用 portable.LOGS_DIR 注入，
 * 保证便携版日志落在 exe 同级 data/logs，而非 %APPDATA%）。
 * 未注入时回退 userData/logs。
 */
export function configureLogDir(dir: string): void {
  configuredDir = dir
  logFilePath = undefined
  fileFailures = 0
}

function resolveLogFile(): string | null {
  if (logFilePath !== undefined) return logFilePath
  try {
    const dir = configuredDir ?? path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    logFilePath = path.join(dir, 'main.log')
  } catch {
    // electron 未就绪 / userData 不可用（测试打桩等）：禁落盘，仅控制台
    logFilePath = null
  }
  return logFilePath
}

function rotateIfNeeded(file: string): void {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return // 文件尚不存在，无需滚动
  }
  if (size < MAX_LOG_BYTES) return
  const oldFile = file.replace(/\.log$/, '.old.log')
  try {
    fs.rmSync(oldFile, { force: true })
    fs.renameSync(file, oldFile)
  } catch {
    // 滚动失败（权限/占用）不影响本次写入
  }
}

function appendToFile(line: string): void {
  if (fileFailures >= 3) return
  const file = resolveLogFile()
  if (!file) return
  try {
    rotateIfNeeded(file)
    fs.appendFileSync(file, `${line}\n`)
  } catch {
    fileFailures++
  }
}
