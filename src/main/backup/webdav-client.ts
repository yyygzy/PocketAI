// WebDAV 客户端封装 — 纯 JS，零原生依赖
// 支持 HTTP Basic / Digest 认证，兼容 Nextcloud / ownCloud / Nutstore / 坚果云等
//
// 注意：webdav 包是纯 ESM（"type":"module"），Electron 主进程构建输出为 CJS，
// 不能用顶层 require()。这里用运行时动态 import() 按需加载，externalizeDepsPlugin
// 会保留动态 import 语句，Node 在 CJS 中支持 import()。
import type { WebDAVClient } from 'webdav'

export interface WebDAVCredentials {
  url: string           // https://cloud.example.com/remote.php/dav/files/username
  username: string
  password: string
  directory?: string    // 远端子目录（可选）
}

export interface BackupFile {
  name: string          // pocketai-backup-20260917T032000Z.enc.zip / pocketai-inc-...json
  size: number          // bytes
  mtime: number         // ms timestamp
  encrypted: boolean    // 是否带 masterKey 加密
  kind: 'full' | 'incremental' // 全量 zip 包 / 增量索引
}

/** createClient 参数子集（仅用到 basic 认证；authType 保留字符串兼容 digest 扩展） */
interface WebdavCreateClientOptions {
  authType: 'basic' | 'digest'
  credentials: { username: string; password: string }
}

/** webdav 模块动态导入后的形状（包是纯 ESM，仅按需 import()） */
interface WebdavModule {
  createClient: (url: string, opts?: WebdavCreateClientOptions) => WebDAVClient
}

/** PROPFIND 目录条目（webdav FileStat 的用到字段子集） */
interface RemoteDirEntry {
  filename: string
  size?: number
  lastmod?: string
  type: 'file' | 'directory'
}

/** 懒加载 webdav 模块（缓存 promise，避免重复动态导入） */
let webdavModulePromise: Promise<WebdavModule> | null = null
function loadWebdav() {
  if (!webdavModulePromise) {
    webdavModulePromise = import('webdav') as Promise<WebdavModule>
  }
  return webdavModulePromise
}

// ─── 传输保护 ────────────────────────────────────────────────────
//
// 威胁模型说明：WebDAV 目标由用户本人在解锁后配置（内网 NAS 是合法场景，
// 故不做私网 IP 拦截）；底层 node-fetch 3.x 已会在跨域/跨协议重定向时
// 剥离 authorization 头。这里补的是可靠性/DoS 缺口：
// 1. webdav 包默认无任何超时 —— 挂死端点会让定时备份/恢复永久 pending
// 2. getFileContents 把整个响应缓冲进内存且无上限（包类型里的
//    maxContentLength/maxBodyLength 是死选项，运行时代码不读取）

/** 轻请求（exists/PROPFIND/mkdir/delete）：20s */
const TIMEOUT_LIGHT_MS = 20_000
/** 连接测试：15s（用户在设置页等待，快速失败） */
const TIMEOUT_TEST_MS = 15_000
/** 上传/下载整包：10min（家用上行带宽传几十 MB 备份可能很慢） */
const TIMEOUT_TRANSFER_MS = 600_000
/** 单次传输体积上限 500MB：getFileContents 整包进内存，超过即用法异常 */
const MAX_TRANSFER_BYTES = 500 * 1024 * 1024

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

/** 上传前体积预检（避免把超大缓冲推到一半才失败） */
export function assertUploadSize(data: Buffer): void {
  if (data.length > MAX_TRANSFER_BYTES) {
    throw new Error(`备份体积 ${(data.length / 1024 / 1024).toFixed(0)}MB 超过 ${MAX_TRANSFER_BYTES / 1024 / 1024}MB 上限`)
  }
}

/** 下载后体积校验（注：此时响应已缓冲，本检查防的是后续处理被错误巨文件拖垮） */
export function assertDownloadSize(buf: Buffer): Buffer {
  if (buf.length > MAX_TRANSFER_BYTES) {
    throw new Error(`远端文件体积 ${(buf.length / 1024 / 1024).toFixed(0)}MB 超过 ${MAX_TRANSFER_BYTES / 1024 / 1024}MB 上限，已中止`)
  }
  return buf
}

export function remotePath(dir: string | undefined, filename: string): string {
  const prefix = dir ? dir.replace(/\/+$/, '') : ''
  return prefix ? `${prefix}/${filename}` : filename
}

/** 远端完整相对路径（directory 前缀 + 相对名，相对名可含子目录） */
export function fullRemotePath(creds: WebDAVCredentials, relName: string): string {
  return remotePath(creds.directory, relName.replace(/^\/+/, ''))
}

async function buildClient(creds: WebDAVCredentials): Promise<WebDAVClient> {
  // 显式协议白名单：node-fetch 本身只支持 http(s)，提前校验给出可读错误，
  // 也防止未来底层更换后 file:/自定义协议被意外放行
  let parsed: URL
  try {
    parsed = new URL(creds.url)
  } catch {
    throw new Error('WebDAV 地址无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`WebDAV 仅支持 http/https 协议（收到 ${parsed.protocol}）`)
  }
  const { createClient } = await loadWebdav()
  const opts: WebdavCreateClientOptions = {
    authType: 'basic',
    credentials: { username: creds.username, password: creds.password }
  }
  // 坚果云等特殊服务需要 digest
  return createClient(creds.url, opts)
}

// ─── 导出 API ────────────────────────────────────────────────────

export async function testConnection(
  creds: WebDAVCredentials
): Promise<{ ok: boolean; message?: string }> {
  try {
    const client = await buildClient(creds)
    const exists = await client.exists('/', { signal: timeoutSignal(TIMEOUT_TEST_MS) })
    return exists ? { ok: true } : { ok: false, message: '目录不可访问' }
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    const msg = name === 'TimeoutError' || name === 'AbortError'
      ? '连接超时（15s）'
      : (e instanceof Error && e.message ? e.message : '连接失败')
    return { ok: false, message: msg }
  }
}

export async function uploadBuffer(
  creds: WebDAVCredentials,
  data: Buffer,
  filename: string
): Promise<void> {
  const client = await buildClient(creds)
  assertUploadSize(data)
  // 确保远端目录存在
  if (creds.directory) {
    try { await client.createDirectory(creds.directory, { signal: timeoutSignal(TIMEOUT_LIGHT_MS) }) } catch { /* 已存在 */ }
  }
  const p = remotePath(creds.directory, filename)
  await client.putFileContents(p, data, { overwrite: true, signal: timeoutSignal(TIMEOUT_TRANSFER_MS) })
}

export async function downloadFile(
  creds: WebDAVCredentials,
  filename: string
): Promise<Buffer> {
  const client = await buildClient(creds)
  const p = remotePath(creds.directory, filename)
  // 未启用 details 选项，返回体只可能是 Buffer / string / ArrayBuffer
  const content = (await client.getFileContents(p, { signal: timeoutSignal(TIMEOUT_TRANSFER_MS) })) as
    | Buffer
    | string
    | ArrayBuffer
  if (Buffer.isBuffer(content)) return assertDownloadSize(content)
  if (typeof content === 'string') return assertDownloadSize(Buffer.from(content))
  return assertDownloadSize(Buffer.from(content))
}

export async function listFiles(creds: WebDAVCredentials): Promise<BackupFile[]> {
  const client = await buildClient(creds)
  const dir = creds.directory ?? '/'
  const entries = (await client.getDirectoryContents(dir, {
    signal: timeoutSignal(TIMEOUT_LIGHT_MS)
  })) as RemoteDirEntry[]
  return entries
    .filter(
      (e) =>
        e.type === 'file' &&
        (e.filename.startsWith('pocketai-backup-') || e.filename.startsWith('pocketai-inc-'))
    )
    .map((e) => {
      const name = e.filename.split('/').pop()!
      const encrypted = e.filename.endsWith('.enc.zip') || e.filename.endsWith('.json.enc')
      return {
        name,
        size: e.size ?? 0,
        mtime: new Date(e.lastmod ?? Date.now()).getTime(),
        encrypted,
        kind: name.startsWith('pocketai-inc-')
          ? ('incremental' as const)
          : ('full' as const)
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

// ─── 增量备份：内容寻址 blob 存取 ──────────────────────────────────

/** 远端相对路径（可含 blobs/ 子目录）的对象是否存在（HEAD/PROPFIND） */
export async function remoteExists(
  creds: WebDAVCredentials,
  relName: string
): Promise<boolean> {
  const client = await buildClient(creds)
  try {
    return await client.exists(fullRemotePath(creds, relName), { signal: timeoutSignal(TIMEOUT_LIGHT_MS) })
  } catch {
    return false
  }
}

/**
 * 上传到相对路径（可含子目录，如 blobs/att-xxx.enc）；
 * 自动创建配置目录与所有父级子目录
 */
export async function uploadRemoteBuffer(
  creds: WebDAVCredentials,
  data: Buffer,
  relName: string
): Promise<void> {
  const client = await buildClient(creds)
  assertUploadSize(data)
  // 逐级创建目录：配置目录 → 相对路径上的各级子目录
  const dirs: string[] = []
  if (creds.directory) dirs.push(creds.directory)
  const slashIdx = relName.lastIndexOf('/')
  if (slashIdx >= 0) {
    const subParts = relName.slice(0, slashIdx).split('/').filter(Boolean)
    let acc = creds.directory ? creds.directory.replace(/\/+$/, '') : ''
    for (const part of subParts) {
      acc = acc ? `${acc}/${part}` : part
      dirs.push(acc)
    }
  }
  for (const d of dirs) {
    try {
      await client.createDirectory(d, { signal: timeoutSignal(TIMEOUT_LIGHT_MS) })
    } catch {
      /* 已存在 */
    }
  }
  await client.putFileContents(fullRemotePath(creds, relName), data, {
    overwrite: true,
    signal: timeoutSignal(TIMEOUT_TRANSFER_MS)
  })
}

/** 下载相对路径（可含子目录）的对象 */
export async function downloadRemoteFile(
  creds: WebDAVCredentials,
  relName: string
): Promise<Buffer> {
  const client = await buildClient(creds)
  // 未启用 details 选项，返回体只可能是 Buffer / string / ArrayBuffer
  const content = (await client.getFileContents(fullRemotePath(creds, relName), {
    signal: timeoutSignal(TIMEOUT_TRANSFER_MS)
  })) as Buffer | string | ArrayBuffer
  if (Buffer.isBuffer(content)) return assertDownloadSize(content)
  if (typeof content === 'string') return assertDownloadSize(Buffer.from(content))
  return assertDownloadSize(Buffer.from(content))
}

export async function deleteFile(creds: WebDAVCredentials, filename: string): Promise<void> {
  const client = await buildClient(creds)
  const p = remotePath(creds.directory, filename)
  await client.deleteFile(p, { signal: timeoutSignal(TIMEOUT_LIGHT_MS) })
}
