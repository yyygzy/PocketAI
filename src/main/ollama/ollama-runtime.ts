// Ollama 便携运行时管理：下载官方便携发行包 → 解压到 runtime/ → 以平台目录为模型库启动
//
// 设计目标（与便携 Python 同一哲学）：
//  - 不写系统目录、不要管理员权限、不污染 PATH；
//  - 二进制在 runtime/ollama-{platform}-{arch}/，模型在 data/ollama-models/，整个平台文件夹可拷走；
//  - 若系统已装 Ollama 且 11434 在跑，直接复用，不重复下载、不争抢端口；
//  - 发行包 SHA256 钉版（取自 GitHub Release API 的 digest），下载后、解压前校验。
//
// v0.34 起发行包格式：Windows = zip（~1.4GB，含 CUDA 库），Linux = tar.zst（~1.4GB）。
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import unzipper from 'unzipper'
import { RUNTIME_DIR, DATA_DIR } from '../portable'
import { safeFetch } from '../net/safe-fetch'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import type {
  OllamaRuntimeStatus,
  OllamaInstallEvent,
  OllamaPullEvent
} from '../../shared/types'

const OLLAMA_VERSION = 'v0.34.2'
const HOST = '127.0.0.1'
const PORT = 11434
const BASE_URL = `http://${HOST}:${PORT}`
const OLLAMA_API_TIMEOUT_MS = 3000

/** app_config 里的下载镜像前缀（gh-proxy 风格：前缀直接拼官方完整 URL）；空=官方源 */
const K_MIRROR = 'ollama_download_mirror'

interface AssetSpec {
  file: string
  /** GitHub Release API 提供的 sha256 digest（权威，升级版本时重新查取） */
  sha256: string
  format: 'zip' | 'tar.zst'
  size: number
}

/**
 * 钉版资产表（仅 amd64；arm64 Windows / arm64 Linux 暂不支持，UI 会如实告知）。
 * 体积大是因为含 CUDA/ROCm 推理库；CPU-only 用户也用同一包（ollama 按硬件自动选择）。
 */
const ASSETS: Partial<Record<string, AssetSpec>> = {
  'win32-x64': {
    file: 'ollama-windows-amd64.zip',
    sha256: '8f3fd071a2a2f9497b562f43502c77c2b701a99d1ee5dfda28da8c786373063b',
    format: 'zip',
    size: 1_460_825_696
  },
  'linux-x64': {
    file: 'ollama-linux-amd64.tar.zst',
    sha256: 'e155b83589986d2c581fdbf1381ea3ebdb16549883679cd5a0627f7cdc05b12b',
    format: 'tar.zst',
    size: 1_427_644_769
  }
}

/** 下载硬上限 = 钉版体积 +10%（防异常/篡改把磁盘写满） */
const MAX_DOWNLOAD_BYTES = (spec: AssetSpec) => Math.floor(spec.size * 1.1)
const DOWNLOAD_TIMEOUT_MS = 40 * 60 * 1000

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function installDir(): string {
  return path.join(RUNTIME_DIR, `ollama-${process.platform}-${process.arch}`)
}

/** 模型库锚定平台数据目录：U 盘拔走模型随行，不写 ~/.ollama */
function modelsDir(): string {
  return path.join(DATA_DIR, 'ollama-models')
}

/** 各平台解压后的可执行文件路径 */
function portableExe(): string | null {
  const dir = installDir()
  if (process.platform === 'win32') return path.join(dir, 'ollama.exe')
  if (process.platform === 'linux') return path.join(dir, 'usr', 'bin', 'ollama')
  return null
}

function officialDownloadUrl(spec: AssetSpec): string {
  return `https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/${spec.file}`
}

/** 镜像前缀（app_config）；DB 未就绪时静默回退官方源 */
function getMirror(): string {
  try {
    return (appConfigRepo.get(K_MIRROR) || '').trim()
  } catch {
    return ''
  }
}

// ---------- 本地 API 探测（环回地址，不能走 safeFetch —— 它按 SSRF 策略拦截 127.0.0.1） ----------

async function apiGetJson<T>(apiPath: string, timeoutMs = OLLAMA_API_TIMEOUT_MS): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE_URL}${apiPath}`, { signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function isApiUp(): Promise<boolean> {
  return (await apiGetJson<{ version?: string }>('/api/version')) != null
}

async function getApiVersion(): Promise<string | null> {
  const v = await apiGetJson<{ version?: string }>('/api/version')
  return v?.version ?? null
}

async function listApiModels(): Promise<string[]> {
  const r = await apiGetJson<{ models?: Array<{ name?: string }> }>('/api/tags')
  if (!r?.models) return []
  return r.models.map((m) => m.name).filter((n): n is string => typeof n === 'string')
}

// ---------- 便携 serve 进程 ----------

let serveProc: ChildProcess | null = null

function killTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      // ollama.exe 会衍生 runner 子进程，必须 /T 整树终止
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      // spawn 时 detached:true → 负 pid 杀整个进程组
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        process.kill(pid, 'SIGTERM')
      }
    }
  } catch {
    /* 进程已退出 */
  }
}

/** 启动便携 serve；若 11434 已有服务（系统 Ollama）则直接复用 */
async function startServe(): Promise<{ started: boolean; reused: boolean }> {
  if (await isApiUp()) return { started: false, reused: true }

  const exe = portableExe()
  if (!exe || !fs.existsSync(exe)) {
    throw new Error('便携 Ollama 未安装，请先下载')
  }

  fs.mkdirSync(modelsDir(), { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OLLAMA_HOST: `${HOST}:${PORT}`,
    OLLAMA_MODELS: modelsDir()
  }
  if (process.platform === 'linux') {
    // tgz 布局：usr/bin/ollama + usr/lib/ollama/*，手动指定库搜索路径
    const libDir = path.join(installDir(), 'usr', 'lib', 'ollama')
    env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter)
  }

  serveProc = spawn(exe, ['serve'], {
    cwd: path.dirname(exe),
    env,
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
  serveProc.stdout?.on('data', () => { /* 吞掉常规日志，避免污染主进程输出 */ })
  serveProc.stderr?.on('data', (d) => {
    const msg = String(d).trim()
    if (msg) console.log(`[ollama] ${msg}`)
  })
  serveProc.on('exit', (code) => {
    if (code !== 0 && code !== null) console.warn(`[ollama] serve 退出，code=${code}`)
    serveProc = null
  })

  // 健康轮询（最多约 30s；首次启动要加载 GPU 库）
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (serveProc.killed || serveProc.exitCode !== null) {
      throw new Error('Ollama 服务启动后立即退出，可能被安全软件拦截或缺少系统依赖（Linux 需 glibc 2.31+）')
    }
    if (await isApiUp()) return { started: true, reused: false }
  }
  killTree(serveProc)
  serveProc = null
  throw new Error('Ollama 服务启动超时（30 秒内未响应），请检查端口 11434 是否被占用')
}

/** 仅停止本平台启动的便携 serve；系统 Ollama 不动 */
async function stopServe(): Promise<void> {
  if (!serveProc) return
  const proc = serveProc
  serveProc = null
  killTree(proc)
}

// ---------- 下载与解压 ----------

function verifyHash(filePath: string, spec: AssetSpec): void {
  const actual = createHash('sha256').update(fs.readFileSync(filePath)).digest()
  const expected = Buffer.from(spec.sha256, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(
      `Ollama 发行包校验和不匹配（下载损坏或被篡改），期望 ${spec.sha256.slice(0, 12)}…，实际 ${actual.toString('hex').slice(0, 12)}…`
    )
  }
}

/** zip 条目名安全校验（与 backup-service 同一 Zip Slip 规则） */
function isSafeZipEntryName(rawName: string): boolean {
  const name = String(rawName ?? '').replace(/\\/g, '/')
  if (!name) return false
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return !name.split('/').includes('..')
}

async function extractZip(archive: string, dest: string): Promise<void> {
  // 与 backup-service 同一范式：Open.file 先读中央目录预校验全部条目（防 Zip Slip），
  // 再用 Extract 落盘到全新创建的 dest
  const zip = await unzipper.Open.file(archive)
  for (const f of zip.files) {
    if (!isSafeZipEntryName(f.path)) {
      throw new Error(`zip 条目路径非法，已中止解压：${f.path}`)
    }
  }
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(archive)
      .pipe(unzipper.Extract({ path: dest }))
      .on('close', resolve)
      .on('error', reject)
  })
}

/** 执行一条解压命令，成功 resolve 失败 reject（收集 stderr 用于提示） */
function runExtract(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true })
    let err = ''
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))))
  })
}

async function extractTarZst(archive: string, dest: string): Promise<void> {
  // 现代 GNU tar / Windows 11 bsdtar 能按内容自动识别 zstd；不行再显式指定 zstd 程序
  try {
    await runExtract('tar', ['-xf', archive, '-C', dest])
    return
  } catch (e1) {
    try {
      await runExtract('tar', ['--use-compress-program=zstd', '-xf', archive, '-C', dest])
      return
    } catch {
      throw new Error(
        `解压 tar.zst 失败：系统缺少 zstd 支持（Ubuntu/Debian 可执行 sudo apt install zstd；错误：${(e1 as Error).message.slice(0, 200)}）`
      )
    }
  }
}

/** 下载并解压便携 Ollama */
async function install(onEvent?: (e: OllamaInstallEvent) => void): Promise<OllamaRuntimeStatus> {
  const spec = ASSETS[platformKey()]
  if (!spec) throw new Error(`当前平台（${platformKey()}）暂无便携 Ollama 发行包，仅支持 Windows x64 / Linux x64`)
  if (await isApiUp()) throw new Error('已检测到运行中的 Ollama 服务（系统安装版），无需重复安装便携版')

  const dir = installDir()
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tmpArchive = path.join(dir, spec.file)

  const url = (() => {
    const official = officialDownloadUrl(spec)
    const mirror = getMirror()
    // gh-proxy 类约定：代理地址前缀 + 官方完整 URL
    return mirror ? `${mirror.replace(/\/+$/, '')}/${official}` : official
  })()

  // 下载（2 次重试）
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      onEvent?.({ stage: 'download', percent: 0, receivedBytes: 0, totalBytes: spec.size })
      await safeFetch(url, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBytes: MAX_DOWNLOAD_BYTES(spec),
        sinkFile: tmpArchive,
        headers: { 'User-Agent': 'PocketAI' },
        onProgress: (received, total) => {
          const t = total ?? spec.size
          onEvent?.({
            stage: 'download',
            percent: Math.min(94, (received / t) * 94),
            receivedBytes: received,
            totalBytes: t
          })
        }
      })
      lastErr = null
      break
    } catch (e) {
      lastErr = e as Error
      if (fs.existsSync(tmpArchive)) fs.rmSync(tmpArchive, { force: true })
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  if (lastErr) throw new Error(`下载失败：${lastErr.message}（可在设置中切换国内镜像后重试）`)

  // 钉版校验
  onEvent?.({ stage: 'verify', percent: 95 })
  verifyHash(tmpArchive, spec)

  // 解压
  onEvent?.({ stage: 'extract', percent: 96 })
  try {
    if (spec.format === 'zip') await extractZip(tmpArchive, dir)
    else await extractTarZst(tmpArchive, dir)
  } catch (e) {
    throw new Error(`解压失败：${(e as Error).message}`)
  } finally {
    fs.rmSync(tmpArchive, { force: true })
  }

  // Linux 二进制补执行权限
  const exe = portableExe()
  if (exe && process.platform === 'linux') {
    try {
      fs.chmodSync(exe, 0o755)
    } catch {
      /* 某些 FAT 格式 U 盘不支持权限位，忽略 */
    }
  }

  // 验证可执行
  onEvent?.({ stage: 'verify', percent: 99 })
  if (!exe || !fs.existsSync(exe)) throw new Error('安装验证失败：解压后未找到 ollama 可执行文件')
  const ver = await probeExeVersion(exe)
  if (!ver) throw new Error('安装验证失败：ollama --version 无响应，可能被安全软件拦截')

  onEvent?.({ stage: 'done', percent: 100 })
  return getStatus()
}

function probeExeVersion(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { windowsHide: true, timeout: 8000 }, (_err, stdout, stderr) => {
      const m = `${stdout} ${stderr}`.match(/(\d+\.\d+\.\d+)/)
      resolve(m ? m[1] : null)
    })
  })
}

// ---------- 模型拉取（/api/pull NDJSON 流式） ----------

let pullCtrl: AbortController | null = null

async function pullModel(model: string, onEvent?: (e: OllamaPullEvent) => void): Promise<void> {
  if (!(await isApiUp())) throw new Error('Ollama 服务未运行，请先启动')
  if (!/^[\w.\-:]+(\/[\w.\-:]+)*$/.test(model)) {
    // 仅允许模型名安全字符，防止把任意 JSON/头注入到本地 API
    throw new Error('模型名包含非法字符')
  }

  pullCtrl?.abort()
  const ctrl = new AbortController()
  pullCtrl = ctrl

  const res = await fetch(`${BASE_URL}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal: ctrl.signal
  })
  if (!res.ok || !res.body) throw new Error(`拉取请求失败：HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        const evt = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string }
        if (evt.error) throw new Error(evt.error)
        const percent = evt.total && evt.total > 0 ? Math.min(100, (evt.completed! / evt.total) * 100) : 0
        const finished = evt.status === 'success'
        onEvent?.({ model, status: evt.status ?? '', percent, done: finished })
        if (finished) return
      }
    }
  } finally {
    if (pullCtrl === ctrl) pullCtrl = null
  }
}

function abortPull(): void {
  pullCtrl?.abort()
  pullCtrl = null
}

// ---------- 状态聚合 ----------

async function getStatus(): Promise<OllamaRuntimeStatus> {
  const spec = ASSETS[platformKey()]
  const exe = portableExe()
  const installed = !!exe && fs.existsSync(exe)
  const running = await isApiUp()
  const version = running ? await getApiVersion() : null
  const models = running ? await listApiModels() : []
  return {
    platformSupported: !!spec,
    installed,
    running,
    source: running ? (serveProc ? 'portable' : 'system') : null,
    version,
    installDir: installed && exe ? path.dirname(exe) : null,
    modelsDir: modelsDir(),
    downloadUrl: spec ? officialDownloadUrl(spec) : null,
    downloadBytes: spec?.size ?? null,
    models
  }
}

export const ollamaRuntime = {
  getStatus,
  install,
  start: startServe,
  stop: stopServe,
  listModels: listApiModels,
  pullModel,
  abortPull,
  /** 应用退出时调用：只清理本平台启动的 serve */
  cleanup: stopServe,
  getMirror,
  setMirror: (prefix: string): void => {
    const v = String(prefix ?? '').trim()
    // 空值=回官方源；非空必须是 http(s) 前缀（真正下载时 safeFetch 还会逐跳做 SSRF 校验）
    if (v && !/^https?:\/\/[^\s/$.?#].\S*$/i.test(v)) {
      throw new Error('镜像地址需以 http:// 或 https:// 开头')
    }
    appConfigRepo.set(K_MIRROR, v)
  },
  mirrorConfigKey: K_MIRROR
}
