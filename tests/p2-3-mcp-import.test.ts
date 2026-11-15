// P2-3 MCP 导入通道：包级 sha256、同名并存、凭据清空
//
// 这四条是能真失败的红线：
//  ① 篡改包 → 拒绝且一条都不落库；
//  ② 缺校验和的 Claude Desktop 原生文件 → 放行但标 absent；
//  ③ 同名 → 加序号并存，已有那条不被覆盖；
//  ④ 密钥/令牌/凭据字段 → 落库值为空字符串，非凭据配置原样保留。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>
}))

vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: {
    list: () => h.rows,
    save: (input: Record<string, unknown>) => {
      const rec = { id: `id-${h.rows.length + 1}`, createdAt: Date.now(), ...input }
      h.rows.push(rec)
      return rec
    }
  }
}))

import { buildMcpPackageFile, computeMcpChecksum, verifyMcpPackage } from '../src/main/mcp/mcp-package'
import { importMcpPackageText } from '../src/main/mcp/mcp-import-service'

function pkg(servers: Record<string, unknown>): string {
  return JSON.stringify(buildMcpPackageFile(servers as never, []))
}

beforeEach(() => {
  h.rows.length = 0
})

describe('mcp-package：校验和口径', () => {
  it('导出文件带 sha256 且能验回 ok；exportedAt 不同不影响值', () => {
    const a = buildMcpPackageFile({ fs: { command: 'npx', args: ['-y', 'server-fs'] } }, [], '2026-11-15T00:00:00.000Z')
    const b = buildMcpPackageFile({ fs: { command: 'npx', args: ['-y', 'server-fs'] } }, [], '2027-01-01T00:00:00.000Z')
    expect(a.checksum.algo).toBe('sha256')
    expect(a.checksum.value).toBe(b.checksum.value)
    expect(verifyMcpPackage(JSON.stringify(a))).toMatchObject({ state: 'ok' })
  })

  it('服务顺序与 env 键序不同不影响校验和', () => {
    const a = computeMcpChecksum({
      a: { command: 'x', env: { A: '1', B: '2' } },
      b: { command: 'y' }
    })
    const b = computeMcpChecksum({
      b: { command: 'y' },
      a: { command: 'x', env: { B: '2', A: '1' } }
    })
    expect(a.value).toBe(b.value)
  })

  it('篡改 env 值 → mismatch', () => {
    const payload = JSON.parse(pkg({ fs: { command: 'npx', args: [], env: { TARGET: 'a' } } })) as {
      mcpServers: { fs: { env: Record<string, string> } }
    }
    payload.mcpServers.fs.env.TARGET = 'b'
    expect(verifyMcpPackage(JSON.stringify(payload)).state).toBe('mismatch')
  })

  it('不支持的算法 → unsupported', () => {
    const payload = JSON.parse(pkg({ fs: { command: 'npx', args: [] } })) as {
      checksum: { algo: string }
    }
    payload.checksum.algo = 'md5'
    expect(verifyMcpPackage(JSON.stringify(payload)).state).toBe('unsupported')
  })
})

describe('importMcpPackageText：落库口径', () => {
  it('校验和一致 → 导入并返回 verified', () => {
    const r = importMcpPackageText(pkg({ fs: { command: 'npx', args: ['-y', 'server-fs'] } }))
    expect(r.ok).toBe(true)
    expect(r.checksum).toBe('verified')
    expect(r.imported).toEqual([{ key: 'fs', name: 'fs' }])
    expect(h.rows).toHaveLength(1)
  })

  it('篡改包 → CHECKSUM_MISMATCH 且一条都不落库', () => {
    const payload = JSON.parse(pkg({ fs: { command: 'npx', args: [] } })) as {
      mcpServers: { fs: { command: string } }
    }
    payload.mcpServers.fs.command = 'rm'
    const r = importMcpPackageText(JSON.stringify(payload))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('CHECKSUM_MISMATCH')
    expect(h.rows).toHaveLength(0)
  })

  it('缺校验和的 Claude Desktop 文件 → 放行并标 absent', () => {
    const r = importMcpPackageText(
      JSON.stringify({ mcpServers: { fs: { command: 'npx', args: [] } } })
    )
    expect(r.ok).toBe(true)
    expect(r.checksum).toBe('absent')
    expect(h.rows).toHaveLength(1)
  })

  it('不支持算法 → CHECKSUM_UNSUPPORTED 且不落库', () => {
    const payload = JSON.parse(pkg({ fs: { command: 'npx', args: [] } })) as {
      checksum: { algo: string }
    }
    payload.checksum.algo = 'sha512'
    const r = importMcpPackageText(JSON.stringify(payload))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('CHECKSUM_UNSUPPORTED')
    expect(h.rows).toHaveLength(0)
  })

  it('同名 → 加序号并存，已有那条不被覆盖', () => {
    h.rows.push({ id: 'old', name: 'fs', command: 'old-cmd' })
    const r = importMcpPackageText(pkg({ fs: { command: 'npx', args: [] } }))
    expect(r.ok).toBe(true)
    expect(r.imported).toEqual([{ key: 'fs', name: 'fs (2)' }])
    expect(h.rows).toHaveLength(2)
    expect(h.rows[0]!.command).toBe('old-cmd')
    expect(h.rows[1]!.name).toBe('fs (2)')
  })

  it('密钥/令牌/凭据字段清空，非凭据配置保留', () => {
    const r = importMcpPackageText(
      pkg({
        fs: {
          command: 'npx',
          args: [],
          env: { PATH: '/usr/bin', API_KEY: 'sk-abcdefgh12345678', GH_TOKEN: 'ghp_abcdefghij123456' }
        },
        remote: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer abcdefghijklmnop', 'X-Trace': 'on' }
        }
      })
    )
    expect(r.ok).toBe(true)
    const byName = new Map(h.rows.map((row) => [String(row.name), row]))
    const savedFs = byName.get('fs') as { env: Record<string, string> }
    const savedRemote = byName.get('remote') as { headers: Record<string, string> }
    expect(savedFs.env.PATH).toBe('/usr/bin')
    expect(savedFs.env.API_KEY).toBe('')
    expect(savedFs.env.GH_TOKEN).toBe('')
    expect(savedRemote.headers.Authorization).toBe('')
    expect(savedRemote.headers['X-Trace']).toBe('on')
    expect(r.clearedKeys).toEqual(
      expect.arrayContaining(['fs>API_KEY', 'fs>GH_TOKEN', 'remote>Authorization'])
    )
  })

  it('导出占位 REDACTED 即使键名不敏感也清空', () => {
    const r = importMcpPackageText(
      pkg({ fs: { command: 'npx', args: [], env: { CUSTOM_FIELD: 'REDACTED' } } })
    )
    expect(r.ok).toBe(true)
    const saved = h.rows[0] as { env: Record<string, string> }
    expect(saved.env.CUSTOM_FIELD).toBe('')
    expect(r.clearedKeys).toContain('fs>CUSTOM_FIELD')
  })

  it('单条结构非法不阻断其他条目', () => {
    const r = importMcpPackageText(
      pkg({
        good: { command: 'npx', args: [] },
        bad: { url: 'ftp://example.com' }
      })
    )
    expect(r.ok).toBe(true)
    expect(r.imported).toEqual([{ key: 'good', name: 'good' }])
    expect(r.failed).toHaveLength(1)
    expect(r.failed![0]!.key).toBe('bad')
    expect(h.rows).toHaveLength(1)
  })
})

describe('粘贴通道：与文件通道同一条解析/落库路径', () => {
  /** 去掉每次自增的 id/createdAt，只比配置本体 */
  function rowsSansIdentity(): Array<Record<string, unknown>> {
    return h.rows.map((row) => {
      const copy = { ...row }
      delete copy.id
      delete copy.createdAt
      return copy
    })
  }

  it('同一段 JSON 走文件通道与粘贴通道，落库结果与 clearedKeys 完全一致', () => {
    const text = JSON.stringify({
      mcpServers: {
        fs: {
          command: 'npx',
          args: [],
          env: { PATH: '/usr/bin', API_KEY: 'sk-abcdefgh12345678' }
        },
        remote: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer abcdefghijklmnop' }
        }
      }
    })
    // 先占一个同名，验证两条通道都走「加序号并存」
    h.rows.push({ id: 'old', name: 'fs', command: 'old-cmd' })
    const byFile = importMcpPackageText(text)
    const fileRows = rowsSansIdentity()
    h.rows.length = 0
    h.rows.push({ id: 'old', name: 'fs', command: 'old-cmd' })
    const byPaste = importMcpPackageText(text, { verifyChecksum: false })
    const pasteRows = rowsSansIdentity()

    expect(byFile.ok).toBe(true)
    expect(byPaste.ok).toBe(true)
    expect(pasteRows).toEqual(fileRows)
    expect(byPaste.clearedKeys).toEqual(byFile.clearedKeys)
    expect(byPaste.imported).toEqual([
      { key: 'fs', name: 'fs (2)' },
      { key: 'remote', name: 'remote' }
    ])
    // 密钥确实为空，非凭据保留
    const savedFs = pasteRows.find((r) => r.name === 'fs (2)') as { env: Record<string, string> }
    expect(savedFs.env.API_KEY).toBe('')
    expect(savedFs.env.PATH).toBe('/usr/bin')
  })

  it('粘贴内容即使带 checksum 也按 absent 处理（没有文件包，不做完整性承诺）', () => {
    const r = importMcpPackageText(pkg({ fs: { command: 'npx', args: [] } }), {
      verifyChecksum: false
    })
    expect(r.ok).toBe(true)
    expect(r.checksum).toBe('absent')
    expect(h.rows).toHaveLength(1)
  })
})
