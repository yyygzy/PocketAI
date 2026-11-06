// @vitest-environment node
// P0-5 第三批①：`conversationRepo.delete()` 调用方的冷数据级联。
//
// 这张表要钉住两件事：
//  · 备份恢复（整库替换）只删「旧库有、新库没有」的会话目录——同机恢复时会话 id 不变，
//    卸载文件仍然有效，整目录清空会把还能用的缓存一起误删；
//  · 合流/导入回滚这些路径**不删会话行**（或会话是刚建的、0 消息），所以不需要 purge。
//    这条用源码门禁钉住：合流服务里一旦出现删除会话的 SQL，这条先红。
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-243-delete-callers'
  return { dir, data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.dir + '/app.db',
  MCP_EXTENSIONS_DIR: P.data + '/mcp',
  isPortable: () => false,
  portableDataDir: () => P.data
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { conversationOffloadDir, OFFLOAD_DIR_NAME } from '../src/main/agent/tool-output-offload'
import { purgeConversationColdData, removedConversationIds } from '../src/main/agent/cold-data'

const src = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

describe('① 备份恢复（整库替换）：只删这次真的消失的会话目录', () => {
  it('旧库有、新库没有 ⇒ 目录删；新库仍有的会话目录不动', () => {
    const root = path.join(P.data, OFFLOAD_DIR_NAME)
    for (const id of ['keep-a', 'keep-b', 'gone-c']) {
      const dir = conversationOffloadDir(root, id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'm1.txt'), 'x', 'utf-8')
    }

    // 恢复后的差集：只有 gone-c 在新库里没有对应行（空数组 ≠ 查询失败，调用方会先判 null）
    expect(removedConversationIds(['keep-a', 'keep-b', 'gone-c'], ['keep-a', 'keep-b'])).toEqual(['gone-c'])

    purgeConversationColdData(
      ['gone-c'],
      (dir) => fs.rmSync(dir, { recursive: true, force: true })
    )
    expect(fs.existsSync(conversationOffloadDir(root, 'gone-c'))).toBe(false)
    // 同机恢复：keep-a / keep-b 的文件还在，冷引用不该因此变 expired
    expect(fs.existsSync(path.join(conversationOffloadDir(root, 'keep-a'), 'm1.txt'))).toBe(true)
    expect(fs.existsSync(path.join(conversationOffloadDir(root, 'keep-b'), 'm1.txt'))).toBe(true)
  })

  it('新库清单拿不到（null）时不得删盘：空集不等于空库', () => {
    // 这条钉的是调用方纪律：`conversationIdsSafe()` 失败返回 null，而 `removedConversationIds`
    // 只接受真实的数组。源码门禁确认恢复处先判 `if (afterIds)` 才调。
    expect(src('src/main/backup/backup-service.ts')).toMatch(/if \(afterIds\) \{[\s\S]*?removedConversationIds/)
  })
})

describe('② 删除调用方清单（源码门禁：只钉"谁必须 purge"）', () => {
  it('IPC 单删与批量删都把 doomed id 交给 purgeConversationColdData', () => {
    const s = src('src/main/ipc/handlers/conversations.ts')
    const hits = s.match(/purgeConversationColdData\(conversationRepo\.delete\(/g) ?? []
    expect(hits.length, '单删/批量删都必须级联删盘').toBe(2)
  })

  it('合流（merge-service）不删会话行 ⇒ 不需要 purge；一旦加删除 SQL 这条先红', () => {
    const s = src('src/main/backup/merge-service.ts')
    expect(s).not.toMatch(/conversationRepo\.delete|DELETE\s+FROM\s+conversations/i)
  })

  it('导入失败回滚删的是刚建、0 消息的会话 ⇒ 不会有卸载目录', () => {
    const s = src('src/main/ipc/handlers/conversations.ts')
    // 两处回滚都在 `catch` 里删本次新建的会话；会话在本次调用中才创建，没有工具消息
    const rollbacks = s.match(/catch[\s\S]{0,220}?conversationRepo\.delete\(/g) ?? []
    expect(rollbacks.length, '导入回滚点数量变了，先核对它们是否可能已有工具消息').toBe(2)
  })
})
