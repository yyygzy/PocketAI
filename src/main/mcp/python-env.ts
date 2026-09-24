// Python MCP Server 虚拟环境管理（v2）
//
// 职责：为每个 runtime=python 且声明了 pip 依赖的 MCP Server 提供独立 venv：
//   状态查询（none/installing/ready/stale）→ 显式安装（venv → pip）→ 删除清理。
//
// 安全边界：
//  1. serverId 仅允许 UUID 形态字符，server 目录解析后必须位于 extensions/mcp/ 内，阻断路径穿越；
//  2. 依赖描述经白名单字符集清洗，拒绝以 '-' 开头的 pip 选项行与 URL/路径类描述，
//     最终通过临时 requirements 文件以 `-r` 传给 pip（不拼 shell、不逐包作为自由参数）；
//  3. 所有子进程以参数数组 spawn（无 shell），超时杀整棵进程树；
//  4. 自定义 pip 源仅允许 http(s)，经 PIP_INDEX_URL 环境变量注入。
//
// 便携性：Windows 下 pyvenv.cfg 的 home 为绝对路径，U盘换盘符/移动 runtime 后据此检出 stale，
// 用户一键重装即重建（不在启动路径上做任何隐式联网）。
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { MCP_EXTENSIONS_DIR } from '../portable'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { errMsg } from '../error'
import type {
  McpServerRecord,
  PythonEnvInstallEvent,
  PythonEnvState,
  PythonPipSource
} from '../../shared/types'

/** pip 安装整体超时 10 分钟（大包/弱网兜底） */
const PIP_INSTALL_TIMEOUT = 10 * 60_000
/** 解释器探测（--version）超时 */
const PROBE_TIMEOUT = 10_000
/** 单条依赖描述长度上限 / 单次安装包数上限 */
const MAX_REQ_LINE_LEN = 200
const MAX_REQ_COUNT = 50
/** 服务端事件环形缓冲（每 server 最近 200 行，防止无限增长） */
const EVENT_BUFFER_SIZE = 200

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 递归删除 + Windows 退避重试。
 * 子进程刚退出时，python.exe 映像与 venv 内文件句柄/当前目录锁不会立刻释放，
 * 立刻 rmdir 会抛 EBUSY/EPERM；重试若干轮（总计约 5.5s）仍失败则抛错，交由上层告警。
 */
async function rmrfRetry(target: string, attempts = 5): Promise<void> {
  const delays = [0, 300, 700, 1500, 3000]
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    const d = delays[i]
    if (d) await sleep(d)
    try {
      fs.rmSync(target, { recursive: true, force: true })
      lastErr = undefined
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (lastErr !== undefined) throw lastErr
}

const PIP_SOURCE_CONFIG_KEY = 'python_pip_index_url'
const INDEX_URLS: Record<'official' | 'tuna', string> = {
  official: 'https://pypi.org/simple',
  tuna: 'https://pypi.tuna.tsinghua.edu.cn/simple'
}

interface EnvMarker {
  /** 规范化依赖列表的 sha256，用于包列表变更检测 */
  requirementsHash: string
  /** 安装时使用的 base 解释器绝对路径 */
  basePython: string
  pythonVersion: string
  indexUrl: string
  installedAt: number
}

// ---------- 路径 ----------

/** 校验 id 并返回 extensions/mcp/{id} 绝对路径；任何越界尝试直接抛错 */
export function serverDir(id: string): string {
  // DB 主键由 randomUUID 生成；收紧到 UUID/短横线字符集即可彻底杜绝 ../ 与盘符
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`非法 MCP Server ID: ${id}`)
  }
  const base = path.resolve(MCP_EXTENSIONS_DIR)
  const dir = path.resolve(base, id)
  if (dir !== base && !dir.startsWith(base + path.sep)) {
    throw new Error(`MCP Server 目录路径越界: ${id}`)
  }
  return dir
}

export function venvDir(id: string): string {
  return path.join(serverDir(id), '.venv')
}

/** venv 内解释器候选（按平台；返回首选与候选，存在性由调用方判断） */
export function venvPythonCandidates(id: string): string[] {
  const dir = venvDir(id)
  return process.platform === 'win32'
    ? [path.join(dir, 'Scripts', 'python.exe')]
    : [path.join(dir, 'bin', 'python3'), path.join(dir, 'bin', 'python')]
}

/** venv 内解释器首选路径（文件可能不存在；用于 spawn 与错误展示） */
export function venvPython(id: string): string {
  return venvPythonCandidates(id)[0]!
}

/** venv 可执行目录（注入 PATH 用） */
export function venvBinDir(id: string): string {
  return path.dirname(venvPython(id))
}

function markerPath(id: string): string {
  return path.join(venvDir(id), 'pai-marker.json')
}

// ---------- requirements 清洗（防注入） ----------

/**
 * 把用户输入的依赖列表清洗为可写入 requirements 文件的行。
 * 允许：包名（PEP 508 宽字符集）+ extras + 版本说明符 + 环境标记。
 * 拒绝：'-' 开头的 pip 选项行（-i/--index-url/-r 等）、URL/git/路径类描述
 * （含 : / @ 字符）、空行与 # 注释（静默丢弃）、超长/超量。
 */
export function sanitizeRequirements(input: string[]): string[] {
  const out: string[] = []
  for (const raw of input) {
    const line = String(raw ?? '').trim()
    if (!line || line.startsWith('#')) continue
    if (line.length > MAX_REQ_LINE_LEN) {
      throw new Error(`依赖描述过长（>${MAX_REQ_LINE_LEN} 字符）：${line.slice(0, 40)}…`)
    }
    if (line.startsWith('-')) {
      throw new Error(`不允许在依赖中使用 pip 选项：${line}`)
    }
    // 白名单字符集：不放行 : / @ ? #，从而拒绝 URL、git+、直接引用与路径穿越
    if (!/^[A-Za-z0-9._~\-\[\] <>=!,;()'"*]+$/.test(line)) {
      throw new Error(`仅支持 pip 包名与版本说明符，不支持 URL/路径类依赖：${line}`)
    }
    // 必须以字母或数字开头（包名首字符约束，顺带挡住空白/符号混淆）
    if (!/^[A-Za-z0-9]/.test(line)) {
      throw new Error(`依赖格式无效：${line}`)
    }
    // 按空白分词：只允许第一个 token 是需求本身，其后任何以 '-' 开头的 token
    // 都视为尾随 pip 选项（如 `pkg --no-deps`、`pkg --trusted-host=x`）一并拒绝。
    // pip 按 shlex 规则剥引号，故扫描前先把成对/孤立引号抹成空白，
    // 挡住 `pkg "--no-deps"` 这类带引号形态（环境标记里的 "3.8" 不受影响）。
    const unquoted = line.replace(/['"]/g, ' ')
    const tokens = unquoted.split(/\s+/)
    const trailingOpt = tokens.slice(1).find((tok) => tok.startsWith('-'))
    if (trailingOpt) {
      throw new Error(`不允许在依赖行中夹带 pip 选项：${trailingOpt}`)
    }
    out.push(line)
  }
  if (out.length > MAX_REQ_COUNT) {
    throw new Error(`单次安装的依赖数量不能超过 ${MAX_REQ_COUNT} 个`)
  }
  return out
}

function hashRequirements(lines: string[]): string {
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

// ---------- 子进程执行（参数数组 / 超时杀树 / 逐行回调） ----------

interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onLine?: (line: string) => void
}

/**
 * 无 shell 执行，逐行回调 stdout+stderr。
 * 非零退出抛错（携带末尾输出）；超时杀整个进程树。
 */
function runProcess(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const output: string[] = []
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const append = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue
        output.push(line)
        if (output.length > EVENT_BUFFER_SIZE) output.shift()
        opts.onLine?.(line)
      }
    }
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)

    const killTree = () => {
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            windowsHide: true,
            detached: true,
            stdio: 'ignore'
          })
          killer.unref()
          return
        } catch {
          /* 退回单进程杀 */
        }
      }
      try {
        if (proc.pid) process.kill(proc.pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return
        killTree()
        // close 回调里以超时错误拒绝
      }, opts.timeoutMs)
    }

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(new Error(`无法启动 ${path.basename(cmd)}：${err.message}`))
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const text = output.join('\n')
      if (code === 0) {
        resolve({ code: code ?? 0, output: text })
      } else {
        const tail = output.slice(-15).join('\n')
        reject(new Error(`退出码 ${code}${tail ? `\n${tail}` : ''}`))
      }
    })
  })
}

/** 探测解释器版本（失败返回 null） */
async function probeVersion(exe: string): Promise<string | null> {
  try {
    const { output } = await runProcess(exe, ['--version'], { timeoutMs: PROBE_TIMEOUT })
    const m = output.match(/Python\s+([\d.]+)/i)
    return m ? m[1] ?? null : null
  } catch {
    return null
  }
}

// ---------- pyvenv.cfg / 标记 ----------

/** 读取 pyvenv.cfg 的 home（损坏/缺失返回 null） */
function readVenvHome(id: string): string | null {
  try {
    const cfgPath = path.join(venvDir(id), 'pyvenv.cfg')
    const text = fs.readFileSync(cfgPath, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*home\s*=\s*(.+?)\s*$/i)
      if (m) return m[1] ?? null
    }
    return null
  } catch {
    return null
  }
}

function readMarker(id: string): EnvMarker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath(id), 'utf8')) as EnvMarker
  } catch {
    return null
  }
}

// ---------- pip 源（app_config 持久化） ----------

/** 读取 pip 源设置：'official' | 'tuna' | 自定义 URL（缺省 official） */
export function getPipSource(): PythonPipSource {
  const raw = appConfigRepo.get(PIP_SOURCE_CONFIG_KEY)
  if (raw === 'tuna') return 'tuna'
  if (raw && raw !== 'official') return raw // 自定义 URL（写入时已校验）
  return 'official'
}

/** 持久化 pip 源；自定义值必须是非空 http(s) URL */
export function setPipSource(source: PythonPipSource): void {
  if (source === 'official' || source === 'tuna') {
    appConfigRepo.set(PIP_SOURCE_CONFIG_KEY, source)
    return
  }
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error('自定义 pip 源不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('自定义 pip 源仅支持 http(s) 协议')
  }
  appConfigRepo.set(PIP_SOURCE_CONFIG_KEY, source.trim())
}

function resolveIndexUrl(source: PythonPipSource): string {
  if (source === 'official') return INDEX_URLS.official
  if (source === 'tuna') return INDEX_URLS.tuna
  return source // 自定义 URL（写入时已校验 http(s)）
}

// ---------- 服务 ----------

/**
 * 脱敏日志行中的 URL 内嵌凭据（如自定义 pip 源 https://user:token@host/）。
 * pip 自身的 "Looking in indexes" 行会原样回显源地址，必须在进入事件缓冲/广播前抹掉 userinfo。
 */
function redactUrlCredentials(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s"'<>@]+@/g, '$1***@')
}

/** 把 pip 常见英文错误映射成小白可执行的中文下一步（原始错误仍保留在前一行） */
function friendlyPipHint(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('no matching distribution') || m.includes('could not find a version')) {
    return '请检查包名或版本号拼写是否正确（可先只填包名、不锁定版本再试）。'
  }
  if (
    m.includes('timed out') ||
    m.includes('connection') ||
    m.includes('network is unreachable') ||
    m.includes('temporary failure') ||
    m.includes('ssl') ||
    m.includes('proxy')
  ) {
    return '网络连接异常：可在左上角把 pip 源切换为「清华镜像」后重试。'
  }
  return '请检查包名拼写与网络连接，或切换 pip 镜像后重试。'
}

class PythonEnvService extends EventEmitter {
  /** 正在安装的 serverId（同 server 互斥；不同 server 可并行；状态查询也读它） */
  private installing = new Set<string>()
  /**
   * 正在执行「安装（含前置 stop）/删除」整段操作的 serverId。
   * 安装的 pip 子进程在 installForServer 内才上锁，但 IPC handler 在更早的
   * mcpManager.stop（最长约 3.5s）期间就需要挡住并发删除，因此操作锁必须在 handler 入口持有。
   * 采用拒绝而非排队语义：避免删除请求被 10 分钟安装挂住。
   */
  private opsBusy = new Set<string>()
  /** 每 server 事件环形缓冲（兼顾晚订阅与内存上限） */
  private buffers = new Map<string, PythonEnvInstallEvent[]>()

  /**
   * per-server 串行操作段：同 id 的安装/删除整段互斥，并发调用立即拒绝（不排队）。
   * 不同 server 之间互不阻塞。
   */
  async withServerOp<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    serverDir(serverId) // 顺带做 id 合法性/越界校验
    if (this.opsBusy.has(serverId)) {
      throw new Error('该 Server 正在执行安装或删除，请等待当前操作完成后再试')
    }
    this.opsBusy.add(serverId)
    try {
      return await fn()
    } finally {
      this.opsBusy.delete(serverId)
    }
  }

  private emitEvent(raw: PythonEnvInstallEvent): void {
    // 缓冲与广播统一走脱敏后的副本，避免凭据经日志面板/截图外泄
    const evt: PythonEnvInstallEvent = { ...raw }
    if (evt.message) evt.message = redactUrlCredentials(evt.message)
    if (evt.line) evt.line = redactUrlCredentials(evt.line)
    const buf = this.buffers.get(evt.serverId) ?? []
    buf.push(evt)
    if (buf.length > EVENT_BUFFER_SIZE) buf.shift()
    this.buffers.set(evt.serverId, buf)
    this.emit('event', evt)
  }

  onInstall(handler: (e: PythonEnvInstallEvent) => void): () => void {
    this.on('event', handler)
    return () => this.off('event', handler)
  }

  /** 拉取某 server 的缓冲事件（表单打开时回填最近输出） */
  recentEvents(serverId: string): PythonEnvInstallEvent[] {
    return this.buffers.get(serverId) ?? []
  }

  isInstalling(serverId: string): boolean {
    return this.installing.has(serverId)
  }

  /**
   * 查询环境状态。
   * - 未声明依赖：恒 none（脚本模式不使用 venv）；
   * - 安装进行中：installing；
   * - venv 缺失/解释器不可执行/base 已变更：stale（或 none）；
   * - 物理可用但标记缺失/依赖或解释器不匹配：stale（需重装，venv 可复用）；
   * - 全部一致：ready。
   */
  async getEnvState(record: McpServerRecord): Promise<PythonEnvState> {
    const id = record.id
    const packages = record.transport === 'stdio' && record.runtime === 'python' ? record.pythonPackages ?? [] : []
    const basePython = record.command ? path.resolve(record.command) : null
    const state = (status: PythonEnvState['status'], installedPackages: string[] = [], pythonVersion: string | null = null): PythonEnvState => ({
      serverId: id,
      status,
      packages,
      pythonVersion,
      basePython,
      installedPackages
    })

    if (packages.length === 0) return state('none')
    if (this.installing.has(id)) return state('installing')

    // base 解释器不存在：环境必然不可用
    if (!basePython || !fs.existsSync(basePython)) return state('stale')

    const exe = venvPythonCandidates(id).find((p) => fs.existsSync(p))
    if (!exe) return state('none')

    const version = await probeVersion(exe)
    if (!version) return state('stale', [], null)

    // pyvenv.cfg home 必须与当前 base 解释器目录一致（盘符/路径变化检测）
    const cfgHome = readVenvHome(id)
    const expectedHome = path.dirname(basePython)
    const samePath = (a: string, b: string) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    if (!cfgHome || !samePath(path.resolve(cfgHome), expectedHome)) {
      return state('stale', [], version)
    }

    const marker = readMarker(id)
    if (!marker) return state('stale', [], version)
    if (
      !marker.basePython ||
      !samePath(path.resolve(marker.basePython), basePython) ||
      marker.requirementsHash !== hashRequirements(sanitizeRequirements(packages))
    ) {
      return state('stale', [], version)
    }
    return state('ready', packages, marker.pythonVersion ?? version)
  }

  /**
   * 显式安装（幂等）：
   * venv 物理失效（缺失/不可执行/base 变更）或依赖列表变化（marker hash 不一致）→ 删除重建，
   * 保证被删掉的包不会残留在 site-packages；仅当环境与需求完全一致时才复用 venv 直接 pip
   * （覆盖「上次 pip 失败后重试」场景）。成功写标记并返回最新状态；失败发 error 事件且不写标记。
   */
  async installForServer(record: McpServerRecord): Promise<PythonEnvState> {
    const id = record.id
    serverDir(id) // 路径校验
    if (record.transport !== 'stdio' || record.runtime !== 'python') {
      throw new Error('仅 Python 运行时的 MCP Server 支持安装依赖')
    }
    if (!record.command) {
      throw new Error('请先选择 Python 解释器，再安装依赖')
    }
    const basePython = path.resolve(record.command)
    if (!fs.existsSync(basePython)) {
      throw new Error(`选择的 Python 解释器不存在：${basePython}`)
    }
    const requirements = sanitizeRequirements(record.pythonPackages ?? [])
    if (requirements.length === 0) {
      throw new Error('依赖列表为空，请至少填写一个 pip 包名')
    }
    if (this.installing.has(id)) {
      throw new Error('该 Server 的依赖正在安装中，请等待当前安装完成')
    }

    this.installing.add(id)
    const emit = (stage: PythonEnvInstallEvent['stage'], patch: Partial<PythonEnvInstallEvent> = {}) =>
      this.emitEvent({ serverId: id, stage, timestamp: Date.now(), ...patch })

    // 注意：状态查询必须在 finally 清锁「之后」进行，
    // 否则 getEnvState 会读到 installing（try 内的任何求值都早于 finally）
    let succeeded = false

    try {
      const dir = serverDir(id)
      fs.mkdirSync(dir, { recursive: true })

      // 决定是否需要（重）建 venv：物理可用 + marker 的 base 解释器与依赖 hash 均一致才复用，
      // 否则（含改包列表）一律重建，避免旧包残留造成环境漂移
      const exe = venvPythonCandidates(id).find((p) => fs.existsSync(p))
      const exeVersion = exe ? await probeVersion(exe) : null
      const cfgHome = exe ? readVenvHome(id) : null
      const prevMarker = exe ? readMarker(id) : null
      const expectedHome = path.dirname(basePython)
      const samePath = (a: string, b: string) =>
        process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
      const venvUsable =
        exe !== undefined &&
        exeVersion !== null &&
        cfgHome !== null &&
        samePath(path.resolve(cfgHome), expectedHome) &&
        prevMarker !== null &&
        Boolean(prevMarker.basePython) &&
        samePath(path.resolve(prevMarker.basePython), basePython) &&
        prevMarker.requirementsHash === hashRequirements(requirements)

      if (!venvUsable) {
        emit('venv', { message: '正在创建独立虚拟环境…' })
        // 旧 venv 可能仍被刚退出的进程锁住（Windows），rmrfRetry 内含退避重试
        await rmrfRetry(venvDir(id))
        await runProcess(basePython, ['-m', 'venv', venvDir(id)], {
          cwd: dir,
          timeoutMs: PIP_INSTALL_TIMEOUT,
          onLine: (line) => emit('venv', { line })
        })
      }

      // requirements 临时文件（-r 传参，杜绝选项注入）；安装结束即删
      const reqFile = path.join(dir, '.pai-requirements.txt')
      fs.writeFileSync(reqFile, requirements.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })

      const source = getPipSource()
      const indexUrl = resolveIndexUrl(source)
      const pipEnv: NodeJS.ProcessEnv = {
        PIP_INDEX_URL: indexUrl,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1'
      }
      emit('pip', {
        message: `正在安装依赖（pip 源：${indexUrl}）…`
      })
      try {
        await runProcess(
          venvPython(id),
          ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', reqFile],
          {
            cwd: dir,
            env: pipEnv,
            timeoutMs: PIP_INSTALL_TIMEOUT,
            onLine: (line) => emit('pip', { line })
          }
        )
      } finally {
        try {
          fs.unlinkSync(reqFile)
        } catch {
          /* 忽略清理失败 */
        }
      }

      const venvExe = venvPythonCandidates(id).find((p) => fs.existsSync(p)) ?? venvPython(id)
      const pythonVersion = (await probeVersion(venvExe)) ?? ''
      const marker: EnvMarker = {
        requirementsHash: hashRequirements(requirements),
        basePython,
        pythonVersion,
        indexUrl,
        installedAt: Date.now()
      }
      fs.writeFileSync(markerPath(id), JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 })

      emit('done', { message: `依赖安装完成（Python ${pythonVersion || '?'}，${requirements.length} 个包）` })
      succeeded = true
    } catch (e) {
      // pip 尾部输出可能回显含凭据的 index URL；事件流已在 emitEvent 脱敏，
      // 这里对经 IPC 错误通道（invoke → 表单错误条）抛出的 message 同样脱敏
      const rawMsg = errMsg(e)
      const msg = redactUrlCredentials(rawMsg)
      // 原始 pip 英文输出之后附一条可执行的中文下一步，降低小白排查成本
      emit('error', { message: `依赖安装失败：${msg}` })
      emit('error', { message: `下一步：${friendlyPipHint(msg)}` })
      throw new Error(msg)
    } finally {
      this.installing.delete(id)
    }
    // 锁已释放，查询才不会读到 installing；catch 必抛错，走到这里一定是成功
    if (!succeeded) throw new Error('依赖安装未成功完成')
    return this.getEnvState(record)
  }

  /**
   * 删除 Server 的整个工作目录（含 .venv）。
   * 调用方必须先停止运行中的 Server；目录不存在视为成功。
   * Windows 下进程退出后句柄释放有延迟，内部带退避重试；最终失败会抛错（由上层转 warning）。
   */
  async removeServerEnv(id: string): Promise<void> {
    const dir = serverDir(id) // 含越界校验
    if (fs.existsSync(dir)) {
      await rmrfRetry(dir)
    }
    this.buffers.delete(id)
  }
}

export const pythonEnvService = new PythonEnvService()
