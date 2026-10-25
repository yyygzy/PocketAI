// asar 增量更新补丁器（应用侧）
//
// 流程：download() 从 GitHub Release 下载 asar-patch-{cur}-{latest}.json.gz →
// RSA 验签（复用 license 公钥，防补丁被篡改注入代码）→ 校验当前 app.asar
// oldSha256（防错版本打补丁）→ 按块重建新 asar → 校验 newSha256 →
// 写临时目录（新 asar ＋延迟替换脚本 ＋ 身份记录 patch-meta.json，见 §312）→
// restartToApplyPatch() 拉起那份脚本（app.asar 运行中被锁，脚本由 detached cmd 等待进程退出后替换并重启）。
//
// 陈旧暂存（§312）：暂存目录是**跨进程留在磁盘上**的状态，而「点安装」这一次要装的版本可能早已不是
// 当初打下补丁时那一版（同进程里再检查一次更新就会换目标）。所以消费那一刻必须对账：
// 身份记录里的基线版本＝当前 app.getVersion()、目标版本＝这次要装的版本、两份 asar 的哈希都复验得上。
//
// 失败语义：任何一步失败抛错，由 UpdateManager 回退 electron-updater 全量更新。
// 便携版不适用（asar 解压在 %TEMP%，替换无效），由调用方跳过。
import { app } from 'electron'
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, rmSync } from 'node:fs'
import path from 'node:path'
import { safeFetch } from '../net/safe-fetch'
import { PUBLIC_KEY_DER_B64 } from '../license/public-key'

const GITHUB_OWNER = 'yyygzy'
const GITHUB_REPO = 'PocketAI'
const PATCH_MAX_BYTES = 64 * 1024 * 1024
// 解压后 JSON 上限：压缩流 64MB 不约束解压比（高压缩比 gzip 可放大数百倍，
// 必须在 inflate 阶段就截断，防内存耗尽 DoS）。app.asar 实际远小于此。
export const PATCH_MAX_DECOMPRESSED = 512 * 1024 * 1024
const PATCH_TIMEOUT_MS = 120_000
const HEX64_RE = /^[0-9a-f]{64}$/i
// 签名字段序 —— 必须与 scripts/make-asar-patch.js 完全一致
const SIGN_FIELDS = [
  'blockSize', 'chunksSha256', 'format', 'newSha256',
  'newSize', 'newVersion', 'oldSha256', 'oldVersion'
] as const

interface PatchChunk {
  r?: number // 复用旧 asar 的第 r 个 64KB 块
  d?: string // 新增块（base64）
}

interface AsarPatchPayload {
  format: number
  oldVersion: string
  newVersion: string
  blockSize: number
  oldSha256: string
  newSha256: string
  newSize: number
  chunksSha256: string
  chunks: PatchChunk[]
  sig: string
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 当前安装的 app.asar 路径（安装版：resources/app.asar） */
function currentAsarPath(): string {
  return path.join(process.resourcesPath, 'app.asar')
}

/**
 * 暂存目录里的三份文件（§312）：新 asar、延迟替换脚本、以及**身份记录**。
 * 身份记录最后落盘＝「这一份补丁是给哪一版的」——旧版本的应用没有它，那类残留一律当「没有补丁」。
 */
const WORK_DIR_NAME = 'pocketai-asar-update'
const PENDING_META_FILE = 'patch-meta.json'

interface PendingPatchMeta {
  format: 1
  oldVersion: string
  newVersion: string
  oldSha256: string
  newSha256: string
}

function workDirPath(): string {
  return path.join(app.getPath('temp'), WORK_DIR_NAME)
}
function stagedAsarPath(): string {
  return path.join(workDirPath(), 'app.asar')
}
function pendingScriptPath(): string {
  return path.join(workDirPath(), process.platform === 'win32' ? 'apply-update.cmd' : 'apply-update.sh')
}
function pendingMetaPath(): string {
  return path.join(workDirPath(), PENDING_META_FILE)
}

/** 分块算文件 sha256（一次校验不该把整份 app.asar 读进内存）；读不到返回 null */
function sha256FileSync(file: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const hash = createHash('sha256')
    const buf = Buffer.alloc(4 * 1024 * 1024)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hash.update(buf.subarray(0, n))
    }
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 已经关掉了 */
      }
    }
  }
}

function canonicalize(p: AsarPatchPayload): string {
  return SIGN_FIELDS.map((k) => `${k}=${String(p[k])}`).join('&')
}

/** RSA-SHA256 验签（license 公钥），失败抛错 */
function verifySignature(p: AsarPatchPayload): void {
  const pubKey = createPublicKey({
    key: Buffer.from(PUBLIC_KEY_DER_B64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(canonicalize(p), 'utf8'), pubKey, Buffer.from(p.sig, 'base64'))
  if (!ok) throw new Error('补丁签名校验失败（可能被篡改）')
}

/**
 * 补丁元数据校验（在验签后执行；签名保证字段未被改，这里防发布侧工具出错/
 * 怪异 JSON 类型导致后续乘法/拼接失控）。
 */
function validatePayload(p: unknown): asserts p is AsarPatchPayload {
  if (!p || typeof p !== 'object') throw new Error('补丁格式版本不兼容')
  const o = p as Partial<AsarPatchPayload>
  if (o.format !== 1 || !Array.isArray(o.chunks)) throw new Error('补丁格式版本不兼容')
  if (!Number.isSafeInteger(o.blockSize) || (o.blockSize as number) <= 0) {
    throw new Error('补丁块大小非法')
  }
  if (!Number.isSafeInteger(o.newSize) || (o.newSize as number) < 0 || (o.newSize as number) > PATCH_MAX_DECOMPRESSED) {
    throw new Error('补丁声明体积非法或超限')
  }
  for (const k of ['oldSha256', 'newSha256', 'chunksSha256'] as const) {
    if (typeof o[k] !== 'string' || !HEX64_RE.test(o[k] as string)) {
      throw new Error('补丁元数据校验失败（哈希字段非法）')
    }
  }
  if (typeof o.oldVersion !== 'string' || !o.oldVersion ||
      typeof o.newVersion !== 'string' || !o.newVersion ||
      typeof o.sig !== 'string' || !o.sig) {
    throw new Error('补丁元数据校验失败（版本/签名字段非法）')
  }
}

export interface AsarPatchApplyResult {
  ok: boolean
  error?: string
  patchBytes: number
  newSize: number
}

/**
 * 下载并应用增量补丁（不重启）。
 * 成功 → 补丁就绪，quitAndInstall 走 restartToApplyPatch。
 * 补丁不存在（404）/任何校验失败 → 抛错（调用方回退全量更新）。
 */
export async function downloadAsarPatch(latestVersion: string): Promise<AsarPatchApplyResult> {
  const currentVersion = app.getVersion()
  const url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/asar-patch-${currentVersion}-${latestVersion}.json.gz`

  // 1. 下载
  const res = await safeFetch(url, { maxBytes: PATCH_MAX_BYTES, timeoutMs: PATCH_TIMEOUT_MS })
  if (res.status !== 200) {
    throw new Error(`补丁不存在（HTTP ${res.status}），回退全量更新`)
  }
  const patchBytes = res.body.length

  // 2. 解压（inflate 阶段即截断，防 gzip 解压炸弹）+ 解析
  let payload: AsarPatchPayload
  try {
    const json = gunzipSync(res.body, { maxOutputLength: PATCH_MAX_DECOMPRESSED })
    payload = JSON.parse(json.toString('utf8')) as AsarPatchPayload
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error('补丁解压后体积超限（可能是恶意补丁）')
    }
    throw new Error('补丁文件损坏（解压/解析失败）')
  }

  // 3. 元数据校验 → 验签（先验签再看内容，但字段类型先收紧避免验签过程被畸形值利用）
  validatePayload(payload)
  verifySignature(payload)

  // 3.5 §312：签名只保证「发布侧签的就是这两个版本」，还得跟**本机当前版本／这次要装的目标版本**对账——
  // 否则一个过期补丁文件（例如目标版本已经往前走了）也能通过下面全部校验，把旧一版的 asar 盖上来。
  if (payload.oldVersion !== currentVersion || payload.newVersion !== latestVersion) {
    throw new Error('补丁的基线版本或目标版本与当前不符')
  }

  // 4. 复验块清单哈希：签名字段 chunksSha256 必须与 chunks 实际内容一致。
  //    JSON.stringify 键序必须与发布侧 make-asar-patch.js 完全一致（r/d 单键对象，传输链不重序列化）。
  const chunksCanonical = Buffer.from(JSON.stringify(payload.chunks), 'utf8')
  if (sha256Hex(chunksCanonical) !== payload.chunksSha256.toLowerCase()) {
    throw new Error('补丁块清单校验失败（chunksSha256 不匹配）')
  }

  // 5. 校验当前 asar 与补丁基线一致
  const asarPath = currentAsarPath()
  if (!existsSync(asarPath)) throw new Error('未找到 app.asar')
  const oldBuf = readFileSync(asarPath)
  if (sha256Hex(oldBuf) !== payload.oldSha256.toLowerCase()) {
    throw new Error('当前 app.asar 与补丁基线不匹配')
  }

  // 6. 重建新 asar
  const blockSize = payload.blockSize
  const parts: Buffer[] = []
  for (let i = 0; i < payload.chunks.length; i++) {
    const c = payload.chunks[i]!
    if (typeof c.d === 'string') {
      parts.push(Buffer.from(c.d, 'base64'))
    } else if (Number.isSafeInteger(c.r) && (c.r as number) >= 0) {
      const off = (c.r as number) * blockSize
      if (off >= oldBuf.length) throw new Error('补丁引用越界块')
      parts.push(oldBuf.subarray(off, Math.min(off + blockSize, oldBuf.length)))
    } else {
      throw new Error(`补丁块 ${i} 无效`)
    }
  }
  const newBuf = Buffer.concat(parts)
  if (newBuf.length !== payload.newSize) {
    throw new Error(`重建大小不匹配（${newBuf.length} != ${payload.newSize}）`)
  }
  if (sha256Hex(newBuf) !== payload.newSha256.toLowerCase()) {
    throw new Error('重建结果校验失败（newSha256 不匹配）')
  }

  // 7. 写临时目录 + 生成延迟替换脚本 + 落身份记录（记录**最后**写：半截的暂存目录不当作「补丁就绪」）
  const workDir = workDirPath()
  mkdirSync(workDir, { recursive: true })
  const newAsarPath = stagedAsarPath()
  writeFileSync(newAsarPath, newBuf)
  writeReplaceScript(workDir, newAsarPath, asarPath)
  const meta: PendingPatchMeta = {
    format: 1,
    oldVersion: payload.oldVersion,
    newVersion: payload.newVersion,
    oldSha256: payload.oldSha256.toLowerCase(),
    newSha256: payload.newSha256.toLowerCase()
  }
  writeFileSync(pendingMetaPath(), JSON.stringify(meta), 'utf8')

  return { ok: true, patchBytes, newSize: newBuf.length }
}

/** 生成延迟替换脚本：等待本进程退出 → 替换 app.asar → 重新启动应用 */
function writeReplaceScript(workDir: string, newAsarPath: string, targetAsar: string): void {
  const exePath = process.execPath
  if (process.platform === 'win32') {
    const cmd = [
      '@echo off',
      'timeout /t 2 /nobreak >nul',
      `move /y "${newAsarPath}" "${targetAsar}"`,
      `start "" "${exePath}"`,
      'del "%~f0"'
    ].join('\r\n')
    writeFileSync(path.join(workDir, 'apply-update.cmd'), cmd, 'utf8')
  } else {
    const sh = [
      '#!/bin/sh',
      'sleep 2',
      `mv -f "${newAsarPath}" "${targetAsar}"`,
      `exec "${exePath}" &`,
      `rm -f "$0"`
    ].join('\n')
    writeFileSync(path.join(workDir, 'apply-update.sh'), sh, { encoding: 'utf8', mode: 0o755 })
  }
}

/** 读身份记录；缺文件／形状不对（含旧版本应用留下的无记录残留）一律返回 null＝「没有补丁」 */
function readPendingMeta(): PendingPatchMeta | null {
  let raw: Partial<PendingPatchMeta>
  try {
    raw = JSON.parse(readFileSync(pendingMetaPath(), 'utf8')) as Partial<PendingPatchMeta>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || raw.format !== 1) return null
  if (typeof raw.oldVersion !== 'string' || !raw.oldVersion ||
      typeof raw.newVersion !== 'string' || !raw.newVersion) {
    return null
  }
  for (const k of ['oldSha256', 'newSha256'] as const) {
    if (typeof raw[k] !== 'string' || !HEX64_RE.test(raw[k] as string)) return null
  }
  return raw as PendingPatchMeta
}

/** 清掉暂存（陈旧或对账失败）。删失败也不影响判据——「有没有补丁」只由对账结果决定 */
export function clearPendingPatch(): void {
  for (const p of [stagedAsarPath(), pendingScriptPath(), pendingMetaPath()]) {
    try {
      rmSync(p, { force: true })
    } catch {
      /* 占用／权限问题：留给下一次 */
    }
  }
}

/**
 * 补丁是否可用（§312）：调用方必须交出**这次要装的目标版本**。
 * 五样全对上才算数：身份记录在、目标版本一致、基线版本就是当前跑的版本、
 * 暂存的那份新 asar 没被动过、当前 resources/app.asar 仍是补丁的基线。
 * 任一样不过 ⇒ 判「没有补丁」并顺手清掉那份陈旧暂存（调用方据此回退全量安装）。
 */
export function isPatchPending(targetVersion: string): boolean {
  const meta = readPendingMeta()
  if (!meta) {
    // 旧版本应用留下的无记录残留（只有脚本与暂存件）：既不当补丁用，也不留在盘上等着被误用
    clearPendingPatch()
    return false
  }
  const usable =
    meta.newVersion === targetVersion &&
    meta.oldVersion === app.getVersion() &&
    existsSync(pendingScriptPath()) &&
    sha256FileSync(stagedAsarPath()) === meta.newSha256 &&
    sha256FileSync(currentAsarPath()) === meta.oldSha256
  if (!usable) {
    clearPendingPatch()
    return false
  }
  return true
}

/**
 * 启动延迟替换脚本并退出应用（由 UpdateManager.quitAndInstall 分流调用）。
 * §312：这里**再对账一次**——不能只信调用方那句「有补丁」，两个判断之间隔着一次 IPC。
 */
export function restartToApplyPatch(targetVersion: string): void {
  const script = pendingScriptPath()
  if (!existsSync(script)) throw new Error('替换脚本不存在，请重新下载更新')
  if (!isPatchPending(targetVersion)) {
    throw new Error('补丁已过期或与要安装的版本不符，请重新检查更新')
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: workDirPath()
    })
    child.on('error', () => { /* 更新脚本启动失败由用户手动处理 */ })
    child.unref()
  } else {
    const child = spawn('sh', [script], { detached: true, stdio: 'ignore', cwd: workDirPath() })
    child.on('error', () => { /* 更新脚本启动失败由用户手动处理 */ })
    child.unref()
  }
  app.quit()
}
