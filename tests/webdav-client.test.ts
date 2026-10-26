// webdav-client 路径拼接、体积校验与备份列表解析测试
//
// 覆盖 src/main/backup/webdav-client.ts 的核心逻辑：
// - remotePath / fullRemotePath：远端路径拼接（directory 前缀 + 相对名）
// - assertUploadSize / assertDownloadSize：传输体积 500MB 上限预检
// - listFiles：远端条目 → BackupFile[] 映射（加密标记、kind、mtime 排序）
//
// 策略：
// - 纯函数直接 import 断言
// - listFiles 需 mock webdav 模块的 createClient，注入 getDirectoryContents 返回值
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebDAVClient } from 'webdav'

const MAX_TRANSFER_BYTES = 500 * 1024 * 1024

// ---------- mock webdav 模块 ----------
// vi.mock factory 被 hoisted，mockGetDirectoryContents 须放在 vi.hoisted 中
const { mockGetDirectoryContents } = vi.hoisted(() => ({
  mockGetDirectoryContents: vi.fn()
}))

vi.mock('webdav', () => ({
  // buildClient 现在从模块里取 AuthType.Auto（认证构造交由包判定 Basic/Digest），
  // 桩必须一并给出，否则解构到 undefined
  AuthType: { Auto: 'auto', Digest: 'digest', Password: 'password', Token: 'token', None: 'none' },
  createClient: () =>
    ({
      getDirectoryContents: mockGetDirectoryContents
    } as unknown as WebDAVClient)
}))

import {
  remotePath,
  fullRemotePath,
  assertUploadSize,
  assertDownloadSize,
  mtimeFromBackupName,
  listFiles
} from '../src/main/backup/webdav-client'
import type { WebDAVCredentials } from '../src/main/backup/webdav-client'

const creds: WebDAVCredentials = {
  url: 'https://cloud.example.com/dav',
  username: 'user',
  password: 'pass'
}

describe('remotePath — 目录前缀 + 文件名拼接', () => {
  it('无目录 → 直接返回文件名', () => {
    expect(remotePath(undefined, 'backup.zip')).toBe('backup.zip')
    expect(remotePath('', 'backup.zip')).toBe('backup.zip')
  })

  it('有目录 → 目录/文件名', () => {
    expect(remotePath('backups', 'backup.zip')).toBe('backups/backup.zip')
  })

  it('目录末尾斜杠被去除', () => {
    expect(remotePath('backups/', 'backup.zip')).toBe('backups/backup.zip')
    expect(remotePath('backups///', 'backup.zip')).toBe('backups/backup.zip')
  })
})

describe('fullRemotePath — directory 前缀 + 相对名（可含子目录）', () => {
  it('无 directory → 相对名去掉开头斜杠', () => {
    expect(fullRemotePath(creds, 'blobs/abc.enc')).toBe('blobs/abc.enc')
    expect(fullRemotePath(creds, '/blobs/abc.enc')).toBe('blobs/abc.enc')
  })

  it('有 directory → 拼接前缀', () => {
    expect(fullRemotePath({ ...creds, directory: 'pocketai' }, 'blobs/abc.enc')).toBe(
      'pocketai/blobs/abc.enc'
    )
  })

  it('directory 末尾斜杠被去除', () => {
    expect(fullRemotePath({ ...creds, directory: 'pocketai/' }, 'x.enc')).toBe('pocketai/x.enc')
  })
})

describe('assertUploadSize — 上传体积 500MB 上限', () => {
  it('空 Buffer / 小体积不抛错', () => {
    expect(() => assertUploadSize(Buffer.alloc(0))).not.toThrow()
    expect(() => assertUploadSize(Buffer.alloc(1024))).not.toThrow()
  })

  it('刚好等于上限不抛错', () => {
    expect(() => assertUploadSize(Buffer.alloc(MAX_TRANSFER_BYTES))).not.toThrow()
  })

  it('超过上限抛错，错误信息含 MB 数', () => {
    expect(() => assertUploadSize(Buffer.alloc(MAX_TRANSFER_BYTES + 1))).toThrow(/超过 500MB 上限/)
  })
})

describe('assertDownloadSize — 下载体积校验', () => {
  it('小体积返回原 Buffer', () => {
    const buf = Buffer.from('hello')
    expect(assertDownloadSize(buf)).toBe(buf)
  })

  it('超过上限抛错', () => {
    expect(() => assertDownloadSize(Buffer.alloc(MAX_TRANSFER_BYTES + 1))).toThrow(/已中止/)
  })

  it('等于上限返回原 Buffer', () => {
    const buf = Buffer.alloc(MAX_TRANSFER_BYTES)
    expect(assertDownloadSize(buf)).toBe(buf)
  })
})

describe('listFiles — 远端条目 → BackupFile[]', () => {
  beforeEach(() => {
    mockGetDirectoryContents.mockReset()
  })

  it('过滤非备份文件，映射为 BackupFile 并按 mtime 降序', async () => {
    mockGetDirectoryContents.mockResolvedValue([
      {
        filename: 'pocketai-backup-20260920T032000Z.enc.zip',
        size: 1024,
        lastmod: '2026-09-20T03:20:00Z',
        type: 'file'
      },
      {
        filename: 'pocketai-inc-20260921T032000Z.json.enc',
        size: 512,
        lastmod: '2026-09-21T03:20:00Z',
        type: 'file'
      },
      { filename: 'readme.txt', size: 100, lastmod: '2026-09-01T00:00:00Z', type: 'file' },
      { filename: 'subdir', type: 'directory' }
    ])

    const result = await listFiles(creds)

    expect(result).toHaveLength(2)
    // 增量备份 mtime 更晚，排第一
    expect(result[0]!.name).toBe('pocketai-inc-20260921T032000Z.json.enc')
    expect(result[0]!.kind).toBe('incremental')
    expect(result[0]!.encrypted).toBe(true)
    expect(result[0]!.size).toBe(512)

    // 全量备份排第二
    expect(result[1]!.name).toBe('pocketai-backup-20260920T032000Z.enc.zip')
    expect(result[1]!.kind).toBe('full')
    expect(result[1]!.encrypted).toBe(true)
  })

  it('未加密全量备份 encrypted=false', async () => {
    mockGetDirectoryContents.mockResolvedValue([
      {
        filename: 'pocketai-backup-20260920T032000Z.zip',
        size: 1024,
        lastmod: '2026-09-20T03:20:00Z',
        type: 'file'
      }
    ])

    const result = await listFiles(creds)
    expect(result).toHaveLength(1)
    expect(result[0]!.encrypted).toBe(false)
    expect(result[0]!.kind).toBe('full')
  })

  it('未加密增量备份 encrypted=false', async () => {
    mockGetDirectoryContents.mockResolvedValue([
      {
        filename: 'pocketai-inc-20260921T032000Z.json',
        size: 512,
        lastmod: '2026-09-21T03:20:00Z',
        type: 'file'
      }
    ])

    const result = await listFiles(creds)
    expect(result).toHaveLength(1)
    expect(result[0]!.encrypted).toBe(false)
    expect(result[0]!.kind).toBe('incremental')
  })

  it('size／lastmod 都缺 ⇒ 体积空着（不再演成 0 KB）、时间用包名里那份（不再当成"刚刚"）', async () => {
    mockGetDirectoryContents.mockResolvedValue([
      {
        filename: 'pocketai-backup-20260920T032000Z.zip',
        type: 'file'
      }
    ])

    const result = await listFiles(creds)
    expect(result).toHaveLength(1)
    // §327：改前是 `?? 0`（一个字节都没有的 0 KB）与 `?? Date.now()`（把"服务器没说"演成"刚刚备份过"，
    // 那份会被当成最新、把真正的最新挤进待删区）
    expect(result[0]!.size).toBeNaN()
    expect(result[0]!.mtime).toBe(Date.UTC(2026, 8, 20, 3, 20, 0))
  })

  it('§327 三种 lastmod 形状：标准串用服务器的，空串与带属性的对象用包名兜', async () => {
    mockGetDirectoryContents.mockResolvedValue([
      // 服务器给的比名字新 ⇒ 说明"谁优先"没写反
      { filename: 'pocketai-backup-20260101T000000Z.zip', size: 10, lastmod: '2026-09-30T10:00:00Z', type: 'file' },
      { filename: 'pocketai-backup-20260910T000000Z.zip', size: 20, lastmod: '', type: 'file' },
      {
        filename: 'pocketai-backup-20260912T000000Z.zip',
        size: 30,
        lastmod: { '#text': 'Sat, 12 Sep 2026 00:00:00 GMT', '@xml:lang': 'en' },
        type: 'file'
      },
      { filename: 'pocketai-backup-.zip', size: 40, lastmod: '', type: 'file' }
    ])

    const result = await listFiles(creds)
    const byName = new Map(result.map((f) => [f.name, f]))
    expect(byName.get('pocketai-backup-20260101T000000Z.zip')!.mtime).toBe(
      Date.parse('2026-09-30T10:00:00Z')
    )
    expect(byName.get('pocketai-backup-20260910T000000Z.zip')!.mtime).toBe(
      Date.UTC(2026, 8, 10)
    )
    expect(byName.get('pocketai-backup-20260912T000000Z.zip')!.mtime).toBe(
      Date.UTC(2026, 8, 12)
    )
    // 名字里也没有日期 ⇒ 留 NaN，交给"不可判就不删"那道闸（绝不编一个时间出来）
    expect(byName.get('pocketai-backup-.zip')!.mtime).toBeNaN()
    expect(
      result.filter((f) => Number.isFinite(f.mtime)).map((f) => f.name),
      '排序得是可判的那三份（新→旧）'
    ).toEqual([
      'pocketai-backup-20260101T000000Z.zip',
      'pocketai-backup-20260912T000000Z.zip',
      'pocketai-backup-20260910T000000Z.zip'
    ])
  })

  it('空目录返回空数组', async () => {
    mockGetDirectoryContents.mockResolvedValue([])
    const result = await listFiles(creds)
    expect(result).toEqual([])
  })
})

// ── §327 包名里的时间戳 ──────────────────────────────────
describe('mtimeFromBackupName — 两个世代的名字都要认', () => {
  it('紧凑写法与带横杠的 ISO 都还原成同一时刻', () => {
    expect(mtimeFromBackupName('pocketai-backup-20260920T032000Z.zip')).toBe(
      Date.UTC(2026, 8, 20, 3, 20, 0)
    )
    expect(mtimeFromBackupName('pocketai-backup-2026-09-20T032000000Z.zip')).toBe(
      Date.UTC(2026, 8, 20, 3, 20, 0)
    )
    expect(mtimeFromBackupName('pocketai-inc-2026-09-21T032000000Z.json.enc')).toBe(
      Date.UTC(2026, 8, 21, 3, 20, 0)
    )
    expect(mtimeFromBackupName('pocketai-backup-2026-10-25.zip')).toBe(Date.UTC(2026, 9, 25))
  })

  it('越界的月／日不猜（Date.UTC 会静默进位＝编一个不存在的时间）', () => {
    expect(mtimeFromBackupName('pocketai-backup-2026-13-40.zip')).toBeNaN()
    expect(mtimeFromBackupName('pocketai-backup-.zip')).toBeNaN()
    expect(mtimeFromBackupName('pocketai-backup-notes.zip')).toBeNaN()
  })
})
