// 成品文件服务（v67）——真库 + 真磁盘
//
// 要钉住的语义：
//  · 同名绝不覆盖（第二份自动 -2），第一份字节不变；
//  · 幂等只认「同运行 + 同工具步 + 同 kind + 同标题」，重放返回原产物；
//  · 磁盘文件被外部删掉时，读取返回 null、幂等查找不复用幽灵记录；
//  · 删除先删库再删盘，文件已不在也算成功；
//  · 标题清洗守住 Windows 非法字符 / 保留设备名 / 隐藏文件前缀。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-artifacts-svc'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import {
  ARTIFACTS_DIR,
  cleanArtifactTitle,
  deleteArtifact,
  getArtifactPath,
  listArtifacts,
  readArtifact,
  saveArtifact
} from '../src/main/artifacts/artifact-service'

describe('artifact-service（真库 + 真磁盘）', () => {
  beforeAll(() => {
    fs.rmSync(P.dir, { recursive: true, force: true })
    fs.mkdirSync(P.dir, { recursive: true })
    dbService.open()
    dbService.runMigrations()
  })

  afterAll(() => {
    try {
      dbService.close()
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(P.dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    dbService.getHandle().exec('DELETE FROM artifacts')
    fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true })
  })

  it('迁移 v69 建出 artifacts 表（kind 已含 xlsx）', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(69)
    const cols = (
      dbService.getHandle().prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'kind',
        'title',
        'file_name',
        'size',
        'conversation_id',
        'request_id',
        'step_index',
        'created_at'
      ])
    )
    // CHECK 是四选一：docx / xlsx 都必须能写进去（v68/v69 重建表的目的）
    const docx = saveArtifact({ kind: 'docx', title: '迁移校验', bytes: Buffer.from('docx-check') })
    expect(docx.kind).toBe('docx')
    const xlsx = saveArtifact({ kind: 'xlsx', title: '迁移校验表', bytes: Buffer.from('xlsx-check') })
    expect(xlsx.kind).toBe('xlsx')
  })

  it('保存 xlsx → 文件名带 .xlsx，字节原样可读', () => {
    const bytes = Buffer.from('fake-xlsx-bytes')
    const meta = saveArtifact({ kind: 'xlsx', title: '季度数据', bytes })
    expect(meta.fileName).toBe('季度数据.xlsx')
    expect(readArtifact(meta.id)?.bytes.equals(bytes)).toBe(true)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, meta.fileName))).toBe(true)
  })

  it('保存 docx → 文件名带 .docx，字节原样可读', () => {
    const bytes = Buffer.from('fake-docx-bytes')
    const meta = saveArtifact({ kind: 'docx', title: '会议纪要', bytes })
    expect(meta.fileName).toBe('会议纪要.docx')
    expect(readArtifact(meta.id)?.bytes.equals(bytes)).toBe(true)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, meta.fileName))).toBe(true)
  })

  it('保存 pptx → 字节原样可读，文件名带扩展名', () => {
    const bytes = Buffer.from('fake-pptx-bytes')
    const meta = saveArtifact({ kind: 'pptx', title: '季度汇报', bytes })
    expect(meta.fileName).toBe('季度汇报.pptx')
    expect(meta.size).toBe(bytes.length)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, meta.fileName))).toBe(true)
    expect(readArtifact(meta.id)?.bytes.equals(bytes)).toBe(true)
    expect(getArtifactPath(meta.id)).toBe(path.join(ARTIFACTS_DIR, meta.fileName))
  })

  it('同名第二份自动 -2，第一份字节不变', () => {
    const first = saveArtifact({ kind: 'pptx', title: '同名', bytes: Buffer.from('one') })
    const second = saveArtifact({ kind: 'pptx', title: '同名', bytes: Buffer.from('two') })
    expect(first.fileName).toBe('同名.pptx')
    expect(second.fileName).toBe('同名-2.pptx')
    expect(fs.readFileSync(path.join(ARTIFACTS_DIR, first.fileName), 'utf8')).toBe('one')
    expect(fs.readFileSync(path.join(ARTIFACTS_DIR, second.fileName), 'utf8')).toBe('two')
  })

  it('幂等：同运行 + 同工具步 + 同 kind + 同标题 → 返回原产物，不再落第二份', () => {
    const input = {
      kind: 'pptx' as const,
      title: '幂等稿',
      bytes: Buffer.from('idem'),
      conversationId: 'conv-1',
      requestId: 'req-1',
      stepIndex: 3
    }
    const a = saveArtifact(input)
    const b = saveArtifact(input)
    expect(b.id).toBe(a.id)
    const files = fs.readdirSync(ARTIFACTS_DIR).filter((n) => n.endsWith('.pptx'))
    expect(files).toEqual(['幂等稿.pptx'])
  })

  it('磁盘文件被外部删掉：读取返回 null，幂等查找不复用幽灵记录', () => {
    const input = {
      kind: 'pptx' as const,
      title: '被删了',
      bytes: Buffer.from('gone'),
      conversationId: 'conv-1',
      requestId: 'req-2',
      stepIndex: 1
    }
    const a = saveArtifact(input)
    fs.rmSync(path.join(ARTIFACTS_DIR, a.fileName))
    expect(readArtifact(a.id)).toBeNull()
    expect(getArtifactPath(a.id)).toBeNull()
    const b = saveArtifact(input)
    expect(b.id).not.toBe(a.id)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, b.fileName))).toBe(true)
  })

  it('删除：库与盘一起清掉；文件已不在也算成功', () => {
    const meta = saveArtifact({ kind: 'md', title: '待删', bytes: Buffer.from('# hi') })
    expect(deleteArtifact(meta.id)).toBe(true)
    expect(listArtifacts()).toEqual([])
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, meta.fileName))).toBe(false)
    expect(deleteArtifact(meta.id)).toBe(false)
  })

  it('md 按 UTF-8 落盘', () => {
    const meta = saveArtifact({ kind: 'md', title: '说明', bytes: Buffer.from('# 标题\n正文', 'utf8') })
    expect(meta.fileName).toBe('说明.md')
    expect(fs.readFileSync(path.join(ARTIFACTS_DIR, meta.fileName), 'utf8')).toBe('# 标题\n正文')
  })

  it('标题清洗：非法字符 / 尾随点 / 保留设备名 / 隐藏文件 / 空值', () => {
    expect(cleanArtifactTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
    expect(cleanArtifactTitle('  报告...  ')).toBe('报告')
    expect(cleanArtifactTitle('CON')).toBe('_CON')
    expect(cleanArtifactTitle('.env')).toBe('_.env')
    expect(cleanArtifactTitle('   ')).toBe('未命名文件')
    expect(cleanArtifactTitle('a'.repeat(200))).toHaveLength(80)
  })
})
