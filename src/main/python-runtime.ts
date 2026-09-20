// Python 运行时管理：检测系统 Python + 下载/管理便携 Python
//
// 便携 Python 来自 python-build-standalone（astral-sh/python-build-standalone，
// 原 indygreg 仓库已迁移）的 install_only 发行包（tar.gz），
// 解压到 runtime/python-{platform}-{arch}/ 下。
// 解压使用 Node 内置 zlib + 自实现的最小 tar 流式解析器（避免引入第三方依赖）。
//
// 供应链验证：每个平台包的官方 SHA256 钉死在 PINNED_SHA256，
// 下载后、解压前比对；升级 Python 版本时必须同步更新该表，
// 哈希取自对应 release 的官方 SHA256SUMS 资产。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, timingSafeEqual } from 'node:crypto'
import { RUNTIME_DIR } from './portable'
import { safeFetch } from './net/safe-fetch'
import type { PythonRuntime } from '../shared/types'

/** 便携 Python 发行信息（python-build-standalone） */
const PYTHON_RELEASE_TAG = '20260901'
const PYTHON_VERSION = '3.12.14'

const PLATFORM_TRIPLES: Record<string, string> = {
  // 注：2025 年起 Windows 三元组去掉了 -shared 后缀
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu'
}

/**
 * 各平台 install_only 包的官方 SHA256（取自 release 20260901 的 SHA256SUMS）。
 * 钉哈希使 TLS/重定向之外再多一层端到端完整性保证：
 * CDN 被投毒、资产被替换时校验失败即中止，绝不解压执行。
 */
const PINNED_SHA256: Record<string, string> = {
  'win32-x64': 'e90c1b6419da3bd812dd73bb3de40287a21abf153438147639ec5e20375ea93f',
  'darwin-arm64': '3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76',
  'darwin-x64': '2e31b23f3f1319f707d0e620b48847a0046577541d357276821f9f1b5492e0ba',
  'linux-x64': '936c246dfdbbfa7cb22dd01814a21f582a892689fae96b06071a5e433baffa22',
  'linux-arm64': 'b61b856c3e1a4fc65b8f6e6b0495ef975dd0924f90c59f3ea61b38a079173b84'
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function portableDir(): string {
  return path.join(RUNTIME_DIR, `python-${process.platform}-${process.arch}`)
}

function portablePythonExe(): string {
  const dir = portableDir()
  if (process.platform === 'win32') return path.join(dir, 'python', 'python.exe')
  return path.join(dir, 'python', 'bin', 'python3')
}

/** 便携 Python 发行包下载 URL */
function portableDownloadUrl(): string | null {
  const triple = PLATFORM_TRIPLES[platformKey()]
  if (!triple) return null
  const asset = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-${triple}-install_only.tar.gz`
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/${asset}`
}

/** 校验下载包 SHA256 是否与官方钉版一致（解压前最后一道关） */
function verifyArchiveHash(filePath: string): void {
  const expected = PINNED_SHA256[platformKey()]
  if (!expected) {
    // PINNED_SHA256 与 PLATFORM_TRIPLES 必须同步覆盖；走到这里是开发期配置错误
    throw new Error(`当前平台缺少钉版 SHA256：${platformKey()}`)
  }
  const actual = createHash('sha256').update(fs.readFileSync(filePath)).digest()
  const expectedBuf = Buffer.from(expected, 'hex')
  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
    throw new Error(
      `便携 Python 校验和不匹配（可能下载损坏或被篡改），期望 ${expected.slice(0, 12)}…，实际 ${actual.toString('hex').slice(0, 12)}…`
    )
  }
}

/** 执行命令并返回 stdout 文本（失败返回 null） */
function execText(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    const proc = spawn(cmd, args, { env, windowsHide: true })
    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (out += d.toString()))
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => resolve(code === 0 ? out.trim() : null))
  })
}

/** 探测单个候选解释器的版本 */
async function probe(candidate: string): Promise<{ version: string; path: string } | null> {
  const out = await execText(candidate, ['--version'])
  if (!out) return null
  const m = out.match(/Python\s+([\d.]+)/i)
  if (!m) return null
  // 解析真实可执行路径
  let resolved = candidate
  try {
    if (process.platform === 'win32') {
      const where = await execText('where', [candidate])
      if (where) resolved = where.split(/\r?\n/)[0]
    } else {
      const which = await execText('which', [candidate])
      if (which) resolved = which.split(/\r?\n/)[0]
    }
  } catch {
    /* 忽略 */
  }
  return { version: m[1], path: resolved }
}

/** 检测系统已安装的 Python */
export async function detectSystemPython(): Promise<PythonRuntime[]> {
  const candidates = process.platform === 'win32' ? ['py -3', 'python', 'python3'] : ['python3', 'python']
  const runtimes: PythonRuntime[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    const parts = c.split(/\s+/)
    const cmd = parts[0]
    const args = parts.slice(1)
    const out = await execText(cmd, [...args, '--version'])
    if (!out) continue
    const m = out.match(/Python\s+([\d.]+)/i)
    if (!m) continue
    // 取真实路径
    let realPath = cmd
    try {
      if (process.platform === 'win32') {
        const where = await execText('where', [cmd])
        if (where) realPath = where.split(/\r?\n/)[0]
      } else {
        const which = await execText('which', [cmd])
        if (which) realPath = which.split(/\r?\n/)[0]
      }
    } catch {
      /* ignore */
    }
    if (seen.has(realPath.toLowerCase())) continue
    seen.add(realPath.toLowerCase())
    runtimes.push({ name: `Python ${m[1]}`, version: m[1], path: realPath, source: 'system' })
  }
  return runtimes
}

/** 列出所有可用 Python 运行时（系统 + 已下载便携版） */
export async function listPythonRuntimes(): Promise<PythonRuntime[]> {
  const list: PythonRuntime[] = []
  const portable = portablePythonExe()
  if (fs.existsSync(portable)) {
    const p = await probe(portable)
    if (p) list.push({ name: `Python ${p.version} (便携)`, version: p.version, path: p.path, source: 'portable' })
  }
  const system = await detectSystemPython()
  list.push(...system)
  return list
}

// ---------- tar.gz 下载与解压 ----------

interface DownloadOptions {
  timeoutMs?: number
}

/** 便携发行包体积上限（install_only 实测 30~60MB，200MB 为异常/篡改留余量） */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

/**
 * 下载 URL 到本地文件。
 * 安全：统一走 safeFetch —— 禁止 http 降级/非 http(s) 协议、逐跳 IP 校验
 * （DNS rebinding 钉连）、私网/环回/云元数据地址拦截、体积与超时上限。
 * GitHub release 会 302 到 objects.githubusercontent.com 等 CDN，
 * safeFetch 手动跟随重定向且每跳重新校验，原生 fetch 的 follow 模式做不到。
 * 注：safeFetch 整体缓冲响应体，下载阶段无字节级进度（包体几十 MB，可接受）。
 */
async function downloadToFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const res = await safeFetch(url, {
    timeoutMs: opts.timeoutMs ?? 180_000,
    maxBytes: MAX_DOWNLOAD_BYTES,
    headers: { 'User-Agent': 'PocketAI' }
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`下载失败：HTTP ${res.status}`)
  }
  fs.writeFileSync(dest, res.body)
}

/**
 * 把 tar 条目名解析为 base 内的绝对路径，越界（../、绝对路径、盘符）即抛错。
 * 下载的 tar 包来自网络，必须按 Zip Slip 同级防护处理 —— 包内文件随后会被执行，
 * 一个逃逸到 runtime 目录外的写入即可覆盖任意可执行文件。
 */
function resolveUnder(base: string, name: string): string {
  const abs = path.resolve(base, name)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`tar 条目路径越界: ${name}`)
  }
  return abs
}

/**
 * 最小 tar 流式解压器（基于 Node 内置 zlib）。
 * 支持：普通文件(0/\0)、目录(5)、符号链接(2)、GNU 长名(L)；跳过 pax/其他头部。
 * 不支持稀疏文件等高级特性，足以解压 python-build-standalone。
 * 安全：所有条目路径与符号链接目标都必须落在 destDir 内（resolveUnder）。
 */
async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  const gunzip = zlib.createGunzip()
  const input = fs.createReadStream(tarPath).pipe(gunzip)

  let buffer = Buffer.alloc(0)
  let pending: (() => void) | null = null
  let ended = false
  let streamError: Error | null = null
  const queue: Buffer[] = []

  const onReadable = () => {
    const chunk = input.read()
    if (chunk) queue.push(chunk)
    if (pending) {
      const fn = pending
      pending = null
      fn()
    }
  }
  input.on('readable', onReadable)
  input.on('end', () => {
    ended = true
    if (pending) {
      const fn = pending
      pending = null
      fn()
    }
  })
  input.on('error', (err) => {
    streamError = err
    ended = true
    if (pending) {
      const fn = pending
      pending = null
      fn()
    }
  })

  const readAsync = (size: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const tryRead = () => {
        if (streamError) return reject(streamError)
        while (queue.length) buffer = Buffer.concat([buffer, queue.shift()!])
        if (buffer.length >= size) {
          const out = buffer.subarray(0, size)
          buffer = buffer.subarray(size)
          resolve(out)
        } else if (ended) {
          reject(new Error('tar 流提前结束'))
        } else {
          pending = tryRead
        }
      }
      tryRead()
    })

  const skipBlocks = async (count: number) => {
    for (let i = 0; i < count; i++) await readAsync(512)
  }

  let longName = ''
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const header = await readAsync(512).catch(() => null)
    if (!header) break
    // 全零块 = tar 结束
    if (header.every((b) => b === 0)) break

    const name = header.toString('utf8', 0, 100).replace(/\0+$/, '')
    const sizeStr = header.toString('utf8', 124, 136).replace(/\0+$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const typeflag = String.fromCharCode(header[156])
    const linkname = header.toString('utf8', 157, 257).replace(/\0+$/, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0+$/, '')

    let fullName = longName || (prefix ? `${prefix}/${name}` : name)
    const dataBlocks = Math.ceil(size / 512)

    if (typeflag === 'L') {
      // GNU 长文件名：数据块内容为下一个条目的真实文件名
      const data = await readAsync(size)
      const pad = (512 - (size % 512)) % 512
      if (pad) await readAsync(pad)
      longName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }

    if (typeflag === 'x' || typeflag === 'g') {
      // pax 全局/扩展头：跳过数据
      await skipBlocks(dataBlocks)
      continue
    }

    if (typeflag === '5') {
      // 目录
      const dir = resolveUnder(destDir, fullName)
      fs.mkdirSync(dir, { recursive: true })
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      // 普通文件
      const filePath = resolveUnder(destDir, fullName)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const fileStream = fs.createWriteStream(filePath)
      let remaining = size
      while (remaining > 0) {
        const data = await readAsync(Math.min(remaining, 65536))
        fileStream.write(data)
        remaining -= data.length
      }
      await new Promise<void>((res, rej) => fileStream.end((err?: NodeJS.ErrnoException) => (err ? rej(err) : res())))
      // 跳过填充字节使总长度对齐到 512
      const pad = (512 - (size % 512)) % 512
      if (pad) await readAsync(pad)
    } else if (typeflag === '2') {
      // 符号链接：链接本身与目标都必须在 destDir 内。
      // 放行包内相对链接（bin/python3 → python3.12 等）；
      // 绝对目标或 ../ 逃逸目标拒绝，防止后续条目经链接写出目录。
      const linkPath = resolveUnder(destDir, fullName)
      if (path.isAbsolute(linkname)) {
        throw new Error(`tar 符号链接指向绝对路径，已拒绝: ${fullName} -> ${linkname}`)
      }
      const target = path.resolve(path.dirname(linkPath), linkname)
      if (target !== destDir && !target.startsWith(destDir + path.sep)) {
        throw new Error(`tar 符号链接目标越界，已拒绝: ${fullName} -> ${linkname}`)
      }
      fs.mkdirSync(path.dirname(linkPath), { recursive: true })
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath)
      try {
        fs.symlinkSync(linkname, linkPath)
      } catch {
        // Windows 无开发者模式/管理员权限时创建符号链接会 EPERM：
        // 目标已通过越界校验，创建失败按旧行为跳过（python win 发行包通常不含符号链接）
      }
    } else {
      // 其他类型（含 pax 数据块已在上方处理，此处兜底）：跳过数据块
      await skipBlocks(dataBlocks)
    }
    longName = ''
  }
}

/** 下载并解压便携 Python 到 runtime 目录 */
export async function downloadPortablePython(
  onProgress?: (percent: number, stage: 'download' | 'extract' | 'done') => void
): Promise<PythonRuntime> {
  const url = portableDownloadUrl()
  if (!url) throw new Error(`不支持的平台：${platformKey()}`)

  const dir = portableDir()
  // 先清理旧的（若存在）
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const tmpGz = path.join(dir, 'python.tar.gz')

  // 下载（重试 3 次）；每次下载后立即做 SHA256 钉版校验，不通过按下载失败重试
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      onProgress?.(0, 'download')
      // safeFetch 整体缓冲，下载阶段无字节级进度
      await downloadToFile(url, tmpGz)
      verifyArchiveHash(tmpGz)
      lastErr = null
      break
    } catch (e) {
      lastErr = e as Error
      if (fs.existsSync(tmpGz)) fs.unlinkSync(tmpGz)
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  if (lastErr) throw new Error(`便携 Python 下载失败：${lastErr.message}`)

  // 解压
  onProgress?.(0, 'extract')
  try {
    await extractTarGz(tmpGz, dir)
  } catch (e) {
    throw new Error(`便携 Python 解压失败：${(e as Error).message}`)
  } finally {
    if (fs.existsSync(tmpGz)) fs.unlinkSync(tmpGz)
  }

  // 验证
  const exe = portablePythonExe()
  const p = await probe(exe)
  if (!p) throw new Error('便携 Python 安装验证失败：无法执行 python --version')

  onProgress?.(100, 'done')
  return { name: `Python ${p.version} (便携)`, version: p.version, path: p.path, source: 'portable' }
}

/** 已下载便携 Python 的版本信息（未下载返回 null） */
export function getPortablePythonInfo(): { path: string; exists: boolean } {
  const exe = portablePythonExe()
  return { path: exe, exists: fs.existsSync(exe) }
}
