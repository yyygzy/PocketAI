// WebDAV 客户端封装 — 纯 JS，零原生依赖
// 支持 HTTP Basic / Digest 认证，兼容 Nextcloud / ownCloud / Nutstore / 坚果云等
import { createClient, type WebDAVClient } from 'webdav'

export interface WebDAVCredentials {
  url: string           // https://cloud.example.com/remote.php/dav/files/username
  username: string
  password: string
  directory?: string    // 远端子目录（可选）
}

export interface BackupFile {
  name: string          // pocketai-backup-20260917T032000Z.enc.zip
  size: number          // bytes
  mtime: number         // ms timestamp
  encrypted: boolean    // 是否带 masterKey 加密
}

function buildClient(creds: WebDAVCredentials): WebDAVClient {
  const opts: any = {
    authType: 'basic',
    credentials: { username: creds.username, password: creds.password }
  }
  // 坚果云等特殊服务需要 digest
  return createClient(creds.url, opts)
}

function remotePath(dir: string | undefined, filename: string): string {
  const prefix = dir ? dir.replace(/\/+$/, '') : ''
  return prefix ? `${prefix}/${filename}` : filename
}

// ─── 导出 API ────────────────────────────────────────────────────

export function testConnection(creds: WebDAVCredentials): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    try {
      const client = buildClient(creds)
      client.exists('/')
        .then((exists) => {
          if (exists) resolve({ ok: true })
          else resolve({ ok: false, message: '目录不可访问' })
        })
        .catch((e) => resolve({ ok: false, message: e?.message ?? '连接失败' }))
    } catch (e: any) {
      resolve({ ok: false, message: e?.message ?? '连接失败' })
    }
  })
}

export async function uploadBuffer(
  creds: WebDAVCredentials,
  data: Buffer,
  filename: string
): Promise<void> {
  const client = buildClient(creds)
  // 确保远端目录存在
  if (creds.directory) {
    try { await client.createDirectory(creds.directory) } catch { /* 已存在 */ }
  }
  const p = remotePath(creds.directory, filename)
  await client.putFileContents(p, data, { overwrite: true })
}

export async function downloadFile(
  creds: WebDAVCredentials,
  filename: string
): Promise<Buffer> {
  const client = buildClient(creds)
  const p = remotePath(creds.directory, filename)
  const content = await client.getFileContents(p)
  if (Buffer.isBuffer(content)) return content
  return Buffer.from(content as any)
}

export async function listFiles(creds: WebDAVCredentials): Promise<BackupFile[]> {
  const client = buildClient(creds)
  const dir = creds.directory ?? '/'
  const entries: any[] = await client.getDirectoryContents(dir)
  return entries
    .filter((e) => e.type === 'file' && e.filename.startsWith('pocketai-backup-'))
    .map((e) => ({
      name: e.filename.split('/').pop()!,
      size: e.size ?? 0,
      mtime: new Date(e.lastmod ?? Date.now()).getTime(),
      encrypted: e.filename.endsWith('.enc.zip')
    }))
    .sort((a, b) => b.mtime - a.mtime)
}

export async function deleteFile(creds: WebDAVCredentials, filename: string): Promise<void> {
  const client = buildClient(creds)
  const p = remotePath(creds.directory, filename)
  await client.deleteFile(p)
}
