// asar 增量补丁器单元测试
//
// 覆盖 src/main/update/asar-patcher.ts 的安全关键路径：
// - 下载层：404 / 非 gzip / 非法 JSON / 格式版本
// - 验签层：错误私钥签发 → 拒绝（防篡改注入代码）
// - 基线校验：app.asar 缺失 / oldSha256 不匹配（防错版本打补丁）
// - 重建层：越界块引用 / 无效块 / 大小不符 / newSha256 不符
// - 成功路径：r/d 混合块（含末尾非整块）字节级重建 + 延迟替换脚本落盘
// - isPatchPending / restartToApplyPatch 状态与分流
//
// 策略（同 license.test.ts）：内置公钥 mock 成测试 RSA 对，补丁用配套私钥按
// 发布侧 scripts/make-asar-patch.js 相同规范串签发；safeFetch 与 electron 打桩；
// process.resourcesPath 指向含假 app.asar 的临时目录。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  generateKeyPairSync,
  createHash,
  createSign,
  type KeyObject
} from 'node:crypto'
import { gzipSync } from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_VERSION = '1.2.7'

vi.mock('electron', () => ({
  app: {
    getVersion: () => APP_VERSION,
    getPath: vi.fn(),
    quit: vi.fn()
  }
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }))
}))

// 测试密钥对：私钥通过 mock 模块的隐藏导出带回（真实 public-key.ts 无此导出）
vi.mock('../src/main/license/public-key', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const der = (kp.publicKey as string).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  return { PUBLIC_KEY_DER_B64: der, __TEST_PRIVATE_KEY_PEM: kp.privateKey }
})

const safeFetchMock = vi.fn()
vi.mock('../src/main/net/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args)
}))

import { app } from 'electron'
import { spawn } from 'node:child_process'
import {
  downloadAsarPatch,
  isPatchPending,
  restartToApplyPatch
} from '../src/main/update/asar-patcher'
import * as keyModule from '../src/main/license/public-key'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const privPem = (keyModule as any).__TEST_PRIVATE_KEY_PEM as string

// 另一把私钥（用于「签名公钥不匹配」用例）
const wrongKeypair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const wrongPrivPem = wrongKeypair.privateKey as string

// ─── 补丁构造（复刻 scripts/make-asar-patch.js）──────────────────

const SIGN_FIELDS = [
  'blockSize', 'chunksSha256', 'format', 'newSha256',
  'newSize', 'newVersion', 'oldSha256', 'oldVersion'
] as const

const sha256Hex = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex')

interface PatchChunk {
  r?: number
  d?: string
}

interface PatchPayload {
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

function diffChunks(oldBuf: Buffer, newBuf: Buffer, blockSize: number): PatchChunk[] {
  const oldIndex = new Map<string, number[]>()
  for (let i = 0, n = 0; i < oldBuf.length; i += blockSize, n++) {
    const h = sha256Hex(oldBuf.subarray(i, Math.min(i + blockSize, oldBuf.length)))
    const list = oldIndex.get(h)
    if (list) list.push(n)
    else oldIndex.set(h, [n])
  }
  const chunks: PatchChunk[] = []
  for (let i = 0; i < newBuf.length; i += blockSize) {
    const block = newBuf.subarray(i, Math.min(i + blockSize, newBuf.length))
    const list = oldIndex.get(sha256Hex(block))
    if (list && list.length > 0) {
      chunks.push({ r: list.shift() })
    } else {
      chunks.push({ d: block.toString('base64') })
    }
  }
  return chunks
}

interface BuildOptions {
  /** 签发私钥（默认测试配套私钥；传入 wrongPrivPem 模拟伪造补丁） */
  signKey?: string | KeyObject
  /** 签名前篡改 payload（chunksSha256 客户端不单独复验，可借此注入坏块） */
  tamper?: (p: PatchPayload) => void
  oldVersion?: string
  newVersion?: string
  blockSize?: number
}

/** 按发布侧算法构造 gzip 补丁字节 */
function makePatchGz(oldBuf: Buffer, newBuf: Buffer, opts: BuildOptions = {}): Buffer {
  const blockSize = opts.blockSize ?? 128
  const chunks = diffChunks(oldBuf, newBuf, blockSize)
  const payload = {
    format: 1,
    oldVersion: opts.oldVersion ?? APP_VERSION,
    newVersion: opts.newVersion ?? '1.2.8',
    blockSize,
    oldSha256: sha256Hex(oldBuf),
    newSha256: sha256Hex(newBuf),
    newSize: newBuf.length,
    chunksSha256: sha256Hex(Buffer.from(JSON.stringify(chunks), 'utf8')),
    chunks
  } as PatchPayload
  opts.tamper?.(payload)
  const canonical = SIGN_FIELDS.map((k) => `${k}=${String(payload[k])}`).join('&')
  const signer = createSign('RSA-SHA256')
  signer.update(canonical)
  signer.end()
  payload.sig = signer.sign(opts.signKey ?? privPem, 'base64')
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
}

// ─── 临时目录夹具 ────────────────────────────────────────────────

let tmpRoot: string
let resourcesDir: string
let asarPath: string
let tempDir: string

function makeFakeAsar(buf: Buffer): void {
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.writeFileSync(asarPath, buf)
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-patch-test-'))
  resourcesDir = path.join(tmpRoot, 'resources')
  asarPath = path.join(resourcesDir, 'app.asar')
  tempDir = path.join(tmpRoot, 'app-temp')
  fs.mkdirSync(tempDir, { recursive: true })
  vi.mocked(app.getPath).mockReturnValue(tempDir)
  safeFetchMock.mockReset()
  vi.mocked(spawn).mockClear()
  vi.mocked(app.quit).mockClear()
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesDir,
    configurable: true,
    writable: true
  })
})

afterEach(() => {
  // @ts-expect-error 清理 Electron 运行时才有的属性
  delete process.resourcesPath
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// 测试数据：旧 asar 3 块（128/128/44，末尾非整块）；
// 新 asar = A + X(改动) + C(复用末尾非整块) + Y(新增块)
const blockA = Buffer.alloc(128, 0x11)
const blockB = Buffer.alloc(128, 0x22)
const blockC = Buffer.alloc(44, 0x33)
const blockX = Buffer.alloc(128, 0x55)
const blockY = Buffer.alloc(100, 0x66)
const OLD_ASAR = Buffer.concat([blockA, blockB, blockC])
const NEW_ASAR = Buffer.concat([blockA, blockX, blockC, blockY])

const SCRIPT_NAME = process.platform === 'win32' ? 'apply-update.cmd' : 'apply-update.sh'

describe('downloadAsarPatch 下载/解析', () => {
  it('补丁不存在（HTTP 404）→ 抛错回退全量更新', async () => {
    safeFetchMock.mockResolvedValue({ status: 404, body: Buffer.alloc(0) })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/补丁不存在/)
  })

  it('下载 URL 含当前版本与目标版本', async () => {
    safeFetchMock.mockResolvedValue({ status: 404, body: Buffer.alloc(0) })
    await downloadAsarPatch('9.9.9').catch(() => {})
    const url = String(safeFetchMock.mock.calls[0]![0])
    expect(url).toContain(`asar-patch-${APP_VERSION}-9.9.9.json.gz`)
    expect(url).toContain('github.com/yyygzy/PocketAI')
  })

  it('响应体不是 gzip → 补丁文件损坏', async () => {
    safeFetchMock.mockResolvedValue({ status: 200, body: Buffer.from('not gzip at all') })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/补丁文件损坏/)
  })

  it('gzip 内不是合法 JSON → 补丁文件损坏', async () => {
    safeFetchMock.mockResolvedValue({ status: 200, body: gzipSync(Buffer.from('{bad json')) })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/补丁文件损坏/)
  })

  it('format 版本不兼容 → 拒绝', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR, {
      tamper: (p) => { p.format = 2 }
    })
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/格式版本不兼容/)
  })

  it('chunks 不是数组 → 拒绝', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR, {
      // @ts-expect-error 故意制造错误类型
      tamper: (p) => { p.chunks = 'nope' }
    })
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/格式版本不兼容/)
  })
})

describe('downloadAsarPatch 验签', () => {
  it('非配套私钥签发 → 签名校验失败（防篡改）', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR, { signKey: wrongPrivPem })
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    makeFakeAsar(OLD_ASAR)
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/签名校验失败/)
  })
})

describe('downloadAsarPatch 基线校验', () => {
  it('app.asar 不存在 → 未找到 app.asar', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR)
    fs.mkdirSync(resourcesDir, { recursive: true }) // 目录存在但无 app.asar
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/未找到 app\.asar/)
  })

  it('当前 asar 与补丁 oldSha256 不符（错版本）→ 拒绝', async () => {
    const otherOld = Buffer.concat([Buffer.alloc(128, 0xaa), blockB, blockC])
    const gz = makePatchGz(otherOld, NEW_ASAR)
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    makeFakeAsar(OLD_ASAR)
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/基线不匹配/)
  })
})

describe('downloadAsarPatch 重建校验', () => {
  beforeEach(() => makeFakeAsar(OLD_ASAR))

  it('引用越界块 → 拒绝', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR, {
      tamper: (p) => { p.chunks = [{ r: 99999 }] }
    })
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/越界块/)
  })

  it('既无 d 也无 r 的无效块 → 拒绝', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR, {
      tamper: (p) => { p.chunks = [{}] }
    })
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/补丁块 0 无效/)
  })

  it('重建块数为 0、大小不符 → 拒绝', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR, {
      tamper: (p) => { p.chunks = [] }
    })
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/重建大小不匹配/)
  })

  it('新块内容被篡改导致 newSha256 不符 → 拒绝', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR, {
      tamper: (p) => {
        const evil = Buffer.alloc(128, 0x77)
        p.chunks = [{ r: 0 }, { d: evil.toString('base64') }, { r: 2 }, { d: blockY.toString('base64') }]
      }
    })
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    await expect(downloadAsarPatch('1.2.8')).rejects.toThrow(/newSha256 不匹配/)
  })
})

describe('downloadAsarPatch 成功路径', () => {
  it('r/d 混合块（含末尾非整块）字节级重建 + 落盘替换脚本', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR)
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    makeFakeAsar(OLD_ASAR)

    const r = await downloadAsarPatch('1.2.8')

    expect(r.ok).toBe(true)
    expect(r.patchBytes).toBe(gz.length)
    expect(r.newSize).toBe(NEW_ASAR.length)
    // 原 app.asar 未被改动（运行中文件，替换延迟到退出后）
    expect(fs.readFileSync(asarPath)).toEqual(OLD_ASAR)
    // 新 asar 字节级一致
    const workDir = path.join(tempDir, 'pocketai-asar-update')
    const built = fs.readFileSync(path.join(workDir, 'app.asar'))
    expect(built).toEqual(NEW_ASAR)
    // 延迟替换脚本已生成，且指向目标 asar 与当前可执行文件
    const script = fs.readFileSync(path.join(workDir, SCRIPT_NAME), 'utf8')
    expect(script).toContain(asarPath)
    expect(script).toContain(process.execPath)
  })

  it('成功后 isPatchPending() 为 true；全新临时目录为 false', async () => {
    expect(isPatchPending()).toBe(false)
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR)
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    makeFakeAsar(OLD_ASAR)
    await downloadAsarPatch('1.2.8')
    expect(isPatchPending()).toBe(true)
  })
})

describe('restartToApplyPatch', () => {
  it('替换脚本不存在 → 抛错且不退出应用', async () => {
    expect(() => restartToApplyPatch()).toThrow(/替换脚本不存在/)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('脚本就绪 → detached 拉起脚本并退出应用', async () => {
    const gz = makePatchGz(OLD_ASAR, NEW_ASAR)
    safeFetchMock.mockResolvedValue({ status: 200, body: gz })
    makeFakeAsar(OLD_ASAR)
    await downloadAsarPatch('1.2.8')

    restartToApplyPatch()

    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0]!
    expect(typeof cmd).toBe('string')
    expect(Array.isArray(args)).toBe(true)
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(app.quit).toHaveBeenCalledTimes(1)
  })
})
