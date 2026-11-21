// WebDAV 端到端替身用例（真机清单 B15/B16/B17 的机制部分）
//
// 这条链路此前从没被任何测试走过：`tests/webdav-client.test.ts` 与本批早前的
// `backup-webdav-mask.test.ts` 都把 webdav-client / backup-service mock 掉了，
// HTTP 请求从未真的发出去。第一次真发请求就抓出 SEC-36（认证选项形状错误，
// createClient 每次当场抛 `Invalid auth type: basic`），所以本文件同时是：
//   ① SEC-36 的回归钉（认证确实发出、且送的是真实口令）
//   ② SEC-35 掩码往返在 HTTP 层的证明（B15：界面上密码框留空＝未改动）
//   ③ digest 兜底的验证（包里 AuthType.Auto 遇 401+Digest 质询会自动升级重发）
//
// 链路全程真码：ipc/handlers/backup.ts → restoreWebDAVPassword → testWebDAV →
// webdav-client → 真 webdav 包 → 127.0.0.1 上的假服务端（Basic / Digest 两种鉴权模式）。
// 不接真实云盘、不读用户 data/：坚果云自家怪癖仍属 B15 的人工部分。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { IPC, type WebDAVConfig } from '../src/shared/types'

const USER = 'backup-bot'
const REAL_PWD = 'r3al-W ebDav#pwd-9f3c'
const MASK = '••••' + REAL_PWD.slice(-4)
const REALM = 'PocketAI-e2e'
const NONCE = 'dce4e172505fae9d'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  mode: 'none' as 'none' | 'db',
  cfgStore: new Map<string, string>(),
  key: null as Buffer | null
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => mocks.handlers.set(ch, fn) },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    static fromWebContents() { return undefined }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: () => {}
  },
  app: { isPackaged: false, getPath: () => process.cwd(), getAppPath: () => process.cwd(), quit: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

// 字段加解密走真实实现，这里只供密钥与模式（B2 闸门读的也是这个桩）
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getMode: () => mocks.mode,
    getFieldKey: () => {
      if (!mocks.key) throw new Error('测试未初始化字段密钥')
      return mocks.key
    },
    hasKey: () => true,
    isDbEncrypted: () => mocks.mode === 'db'
  }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => mocks.cfgStore.get(k) ?? null,
    set: (k: string, v: string) => { mocks.cfgStore.set(k, v) },
    delete: (k: string) => { mocks.cfgStore.delete(k) }
  },
  clearAppConfigCache: () => {}
}))

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '', DATA_DIR: process.cwd() }))
vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/backup/backup-scheduler', () => ({
  getBackupSchedule: () => ({ enabled: false, intervalHours: 24, retentionCount: 7 }),
  setBackupSchedule: () => ({}),
  noteManualBackup: () => {}
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))

import { registerBackupHandlers } from '../src/main/ipc/handlers/backup'
import { saveWebDAVConfig, testWebDAV } from '../src/main/backup/backup-service'

// ─── 假 WebDAV 服务端 ────────────────────────────────────────────

interface Seen {
  method: string
  path: string
  kind: 'basic' | 'digest' | 'none'
  /** Basic 头里解出的口令（digest/none 时为 null） */
  password: string | null
}

let server: http.Server | null = null
let baseUrl = ''
let serverAuth: 'basic' | 'digest' = 'basic'
/** 假服务端认可的口令（默认那条；Latin1 边界用例会换成带重音的那条） */
let expectedPwd = REAL_PWD
const seen: Seen[] = []

const md5 = (s: string): string => createHash('md5').update(s).digest('hex')

function record(req: http.IncomingMessage): Seen {
  const h = req.headers.authorization ?? ''
  const entry: Seen = { method: String(req.method), path: String(req.url), kind: 'none', password: null }
  if (h.startsWith('Basic ')) {
    entry.kind = 'basic'
    // 按 latin1 解：包用 btoa 版 base64（SEC-37 的同一条约束），
    // 用 utf8 解会把 é/ü 这类字符变成替换符，反而测不出「Latin1 内是可用的」
    const decoded = Buffer.from(h.slice(6), 'base64').toString('latin1')
    const i = decoded.indexOf(':')
    entry.password = i < 0 ? null : decoded.slice(i + 1)
  } else if (h.startsWith('Digest ')) {
    entry.kind = 'digest'
  }
  seen.push(entry)
  return entry
}

/** 解析 `Digest k="v", k=v` 形式的参数串 */
function digestParams(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.slice(7).split(/,\s*/)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out[part.slice(0, eq)] = part.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return out
}

function digestAuthorized(req: http.IncomingMessage): boolean {
  const h = String(req.headers.authorization ?? '')
  if (!h.startsWith('Digest ')) return false
  const p = digestParams(h)
  if (p.username !== USER || p.realm !== REALM || p.nonce !== NONCE) return false
  const ha1 = md5(`${USER}:${REALM}:${expectedPwd}`)
  const ha2 = md5(`${String(req.method)}:${p.uri}`)
  const expect = p.qop
    ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
    : md5(`${ha1}:${p.nonce}:${ha2}`)
  return p.response === expect
}

function challenge(res: http.ServerResponse): void {
  const www =
    serverAuth === 'digest'
      ? `Digest realm="${REALM}",qop="auth",nonce="${NONCE}",opaque="e2e"`
      : 'Basic realm="dav"'
  res.writeHead(401, { 'WWW-Authenticate': www })
  res.end('unauthorized')
}

function authorized(req: http.IncomingMessage, entry: Seen): boolean {
  if (serverAuth === 'digest') return digestAuthorized(req)
  return entry.password === expectedPwd
}

function multistatus(path: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${encodeURI(path)}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection xmlns:d="DAV:"/></d:resourcetype>
        <d:getlastmodified>Mon, 10 Oct 2026 00:00:00 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
}

async function startFakeServer(): Promise<void> {
  server = http.createServer((req, res) => {
    const entry = record(req)
    if (!authorized(req, entry)) {
      challenge(res)
      return
    }
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
      res.end(multistatus(String(req.url ?? '/')))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const addr = server!.address()
  if (!addr || typeof addr === 'string') throw new Error('假服务端启动失败')
  baseUrl = `http://127.0.0.1:${addr.port}/dav`
}

beforeEach(async () => {
  mocks.mode = 'db'
  mocks.key = Buffer.alloc(32, 11)
  mocks.cfgStore = new Map()
  serverAuth = 'basic'
  expectedPwd = REAL_PWD
  seen.length = 0
  registerBackupHandlers()
  await startFakeServer()
}, 30_000)

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server ? server.close((e) => (e ? reject(e) : resolve())) : resolve()
  )
  server = null
})

// ─── 走 IPC 通道（与渲染层调用完全同形） ──────────────────────────

async function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return (await handler({}, ...args)) as T
}

function cfg(password: string, directory = 'bk'): WebDAVConfig {
  return { url: baseUrl, username: USER, passwordCipher: password, directory }
}

/** 界面上的等价操作：密码框留空 ⇒ 提交的是 LOAD 回来的掩码视图 */
async function submitUnchangedPassword(directory: string): Promise<{ ok: boolean; error?: string }> {
  const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
  return call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(loaded!.passwordCipher, directory))
}

describe('B15 密码框留空＝未改动，鉴权用的仍是真实口令（Basic 服务端）', () => {
  it('保存真实口令 → 重载得掩码 → 原样提交 → 测试连接通过，且送出的确是真实口令', async () => {
    expect((await call<{ ok: boolean }>(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(REAL_PWD))).ok).toBe(true)

    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(loaded.passwordCipher).toBe(MASK)

    seen.length = 0
    const r = await call<{ ok: boolean; message?: string }>(IPC.BACKUP_WEBDAV_TEST, cfg(loaded.passwordCipher))
    expect(r.ok).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s.password === REAL_PWD)).toBe(true)
    expect(seen.some((s) => s.password === MASK)).toBe(false)
  })

  it('负向对照：绕过入口回填、直接把掩码交给 testWebDAV → 失败；失败发生在发包之前', async () => {
    // 实测：包的 Basic 头用 btoa 版 base64，`••••` 属非 Latin1 → createClient 阶段就抛，
    // 一个字节都没发出去。所以「掩码不会变成真口令」这件事**不能**依赖这层副作用，
    // 真正的保证是 handler 里的 restoreWebDAVPassword（上一条用例与下面 B17 组的用例钉的就是它）。
    const r = await testWebDAV(cfg(MASK))
    expect(r.ok).toBe(false)
    expect(seen.length).toBe(0)
  })

  it('未配置时的占位提交被拒且一个请求都不发（不会把 •••• 拿去鉴权）', async () => {
    const r = await call<{ ok: boolean; message?: string }>(IPC.BACKUP_WEBDAV_TEST, cfg(MASK))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('掩码')
    expect(seen.length).toBe(0)
  })
})

describe('digest 兜底（AuthType.Auto 遇 401+Digest 质询自动升级）', () => {
  it('只认 digest 的服务端：先被 Basic 拒，最终用 Digest 通过', async () => {
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(REAL_PWD))
    serverAuth = 'digest'
    seen.length = 0

    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    const r = await call<{ ok: boolean; message?: string }>(IPC.BACKUP_WEBDAV_TEST, cfg(loaded.passwordCipher))
    expect(r.ok).toBe(true)
    expect(seen.some((s) => s.kind === 'digest')).toBe(true)
    // Basic 尝试确实发生过（并被拒），否则「兜底」没被走到
    expect(seen.some((s) => s.kind === 'basic' && s.password === REAL_PWD)).toBe(true)
  })
})

describe('B16 只改目录（口令未动）后仍可鉴权，且新目录真的生效', () => {
  it('改目录保存 → 测试连接与列目录都通，请求落在新目录路径上', async () => {
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(REAL_PWD, 'old-dir'))
    expect((await submitUnchangedPassword('new-dir')).ok).toBe(true)

    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(loaded.directory).toBe('new-dir')
    expect(loaded.passwordCipher).toBe(MASK)

    seen.length = 0
    const t = await call<{ ok: boolean }>(IPC.BACKUP_WEBDAV_TEST, cfg(loaded.passwordCipher, loaded.directory))
    expect(t.ok).toBe(true)
    // 「刷新列表」不经过渲染层回传，直接读主进程已存配置
    expect(await call<unknown[]>(IPC.BACKUP_WEBDAV_LIST)).toEqual([])
    expect(seen.every((s) => s.password === REAL_PWD)).toBe(true)
    expect(seen.some((s) => s.path.includes('/dav/new-dir'))).toBe(true)
    expect(seen.some((s) => s.password === MASK)).toBe(false)
  })
})

describe('B17 none 模式的口令闸门在鉴权之前', () => {
  it('none 模式改口令 → 拒绝，且不向服务端发出任何请求', async () => {
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(REAL_PWD))
    seen.length = 0
    mocks.mode = 'none'
    const r = await call<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg('brand-new-pwd'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('主密码')
    expect(seen.length).toBe(0)
    // 本机存的仍是旧口令：掩码提交照样能鉴权
    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect((await call<{ ok: boolean }>(IPC.BACKUP_WEBDAV_TEST, cfg(loaded.passwordCipher))).ok).toBe(true)
  })

  it('none 模式下未改动（掩码回填）仍可保存——闸门不误伤', async () => {
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(REAL_PWD))
    mocks.mode = 'none'
    expect((await submitUnchangedPassword('kept')).ok).toBe(true)
  })
})

describe('SEC-37 非拉丁字符口令：只拦新写入，不回头锁死存量', () => {
  const CJK_PWD = '中文口令-abc'
  const ACCENT_PWD = 'café-crème-üñí'

  it('Latin1 边界（é/ü/ñ）可用——证明划线是「能否编码」而不是「是否 ASCII」', async () => {
    expect((await call<{ ok: boolean }>(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(ACCENT_PWD))).ok).toBe(true)
    expectedPwd = ACCENT_PWD // 假服务端只认同这条口令
    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    seen.length = 0
    expect((await call<{ ok: boolean }>(IPC.BACKUP_WEBDAV_TEST, cfg(loaded.passwordCipher))).ok).toBe(true)
    expect(seen.every((s) => s.password === ACCENT_PWD)).toBe(true)
  })

  it('新输入中文口令 → 拒绝、不落盘、且一个请求都不发（不再暴露英文 btoa 报错）', async () => {
    await call(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(REAL_PWD))
    seen.length = 0
    const r = await call<{ ok: boolean; error?: string }>(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg(CJK_PWD))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('非拉丁字符')
    expect(r.error).not.toContain('Latin1 range')
    expect(seen.length).toBe(0)
    // 存的仍是旧口令
    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(loaded.passwordCipher).toBe(MASK)
  })

  it('测试连接同理：中文口令当场给出可读中文提示，不发请求', async () => {
    const r = await call<{ ok: boolean; message?: string }>(IPC.BACKUP_WEBDAV_TEST, cfg(CJK_PWD))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('非拉丁字符')
    expect(seen.length).toBe(0)
  })

  it('历史存下的中文口令不锁死配置：只改目录仍可保存', async () => {
    // 绕过 handler 直接写库，模拟 SEC-37 校验上线前已存在的配置
    saveWebDAVConfig(cfg(CJK_PWD, 'old-dir'))
    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(loaded.passwordCipher).toBe('••••' + CJK_PWD.slice(-4))

    const r = await call<{ ok: boolean; error?: string }>(
      IPC.BACKUP_WEBDAV_SAVE_CONFIG,
      cfg(loaded.passwordCipher, 'new-dir')
    )
    expect(r.ok).toBe(true)
    const after = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    expect(after.directory).toBe('new-dir')
    expect(after.passwordCipher).toBe('••••' + CJK_PWD.slice(-4))
  })

  it('但这条存量配置测试连接时会被明白告知（不让人对着英文报错猜）', async () => {
    saveWebDAVConfig(cfg(CJK_PWD, 'old-dir'))
    const loaded = await call<WebDAVConfig>(IPC.BACKUP_WEBDAV_LOAD_CONFIG)
    const r = await call<{ ok: boolean; message?: string }>(IPC.BACKUP_WEBDAV_TEST, cfg(loaded.passwordCipher))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('非拉丁字符')
    expect(seen.length).toBe(0)
  })
})
