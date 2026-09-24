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

  it('size 缺失时默认为 0，lastmod 缺失时用当前时间', async () => {
    mockGetDirectoryContents.mockResolvedValue([
      {
        filename: 'pocketai-backup-20260920T032000Z.zip',
        type: 'file'
      }
    ])

    const result = await listFiles(creds)
    expect(result).toHaveLength(1)
    expect(result[0]!.size).toBe(0)
    expect(typeof result[0]!.mtime).toBe('number')
  })

  it('空目录返回空数组', async () => {
    mockGetDirectoryContents.mockResolvedValue([])
    const result = await listFiles(creds)
    expect(result).toEqual([])
  })
})
