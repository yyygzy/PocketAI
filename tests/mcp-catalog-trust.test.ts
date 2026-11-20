// 连接器目录签名信任（阶段 3）的核心行为：
//  · 本地信任库默认空，导入后验签通过；keyId 换公钥/重复公钥都拒绝；
//  · 未签名 v1、未知 keyId、签名不符、serial 回滚、签名密钥被撤销 ⇒ 整份拒绝；
//  · 撤销条目只丢该条；缓存目录在 list 时按当前信任库重新验签。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import {
  catalogSigningInput,
  canonicalJson,
  MCP_CATALOG_ENVELOPE_FORMAT
} from '../src/shared/mcp-catalog-trust'

const h = vi.hoisted(() => ({ store: new Map<string, string>() }))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => (h.store.has(key) ? h.store.get(key)! : null),
    set: (key: string, value: string) => {
      h.store.set(key, value)
    },
    delete: (key: string) => {
      h.store.delete(key)
    }
  }
}))

import {
  commitCatalogSerial,
  importTrustKey,
  listTrustKeys,
  removeTrustKey,
  revokedEntryReason,
  verifyCatalogEnvelope
} from '../src/main/mcp/catalog-trust'
import { listMcpCatalog } from '../src/main/mcp/catalog'

const KEY_ID = 'publisher-test'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ format: 'pem', type: 'spki' }).toString()

const ENTRY = {
  id: 'memory',
  title: '记忆图谱',
  name: 'memory',
  category: 'think',
  summary: '跨会话记住人物、事件与关系。',
  capabilities: ['记录人物与事件'],
  permissionNote: '只读写本地记忆数据，不联网。',
  risk: 'low',
  draft: {
    name: 'memory',
    transport: 'stdio',
    runtime: 'node',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    url: null,
    headers: {},
    pythonPackages: []
  }
}

function envelope(opts: {
  keyId?: string
  serial?: number
  payload?: unknown
  priv?: KeyObject
} = {}): Record<string, unknown> {
  const base: {
    format: typeof MCP_CATALOG_ENVELOPE_FORMAT
    keyId: string
    serial: number
    issuedAt: number
    payload: unknown
  } = {
    format: MCP_CATALOG_ENVELOPE_FORMAT,
    keyId: opts.keyId ?? KEY_ID,
    serial: opts.serial ?? 1,
    issuedAt: 1_700_000_000_000,
    payload: opts.payload ?? { entries: [ENTRY] }
  }
  const signature = sign(
    null,
    Buffer.from(catalogSigningInput(base), 'utf8'),
    opts.priv ?? privateKey
  ).toString('base64url')
  return { ...base, signature }
}

function entryHash(entry: unknown): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex')
}

function importTestKey(): void {
  importTrustKey({ keyId: KEY_ID, publicKey: PUBLIC_PEM, label: '测试发布者' })
}

beforeEach(() => {
  h.store.clear()
})

describe('本地信任库', () => {
  it('默认空；导入后列表带指纹', () => {
    expect(listTrustKeys()).toEqual([])
    const keys = importTrustKey({ keyId: KEY_ID, publicKey: PUBLIC_PEM, label: '测试发布者' })
    expect(keys).toHaveLength(1)
    expect(keys[0]!.keyId).toBe(KEY_ID)
    expect(keys[0]!.source).toBe('user')
    expect(keys[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // 内置官方槽位当前刻意留空，不塞任何密钥
    expect(keys.some((k) => k.source === 'builtin')).toBe(false)
  })

  it('同一 keyId 换公钥被拒绝；同一把公钥换 keyId 也被拒绝', () => {
    importTestKey()
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
    expect(() => importTrustKey({ keyId: KEY_ID, publicKey: other })).toThrow(/已被另一把公钥占用/)
    expect(() => importTrustKey({ keyId: 'another', publicKey: PUBLIC_PEM })).toThrow(/请勿重复导入/)
  })

  it('移除后验签失败（不再信任该发布者）', () => {
    importTestKey()
    removeTrustKey(KEY_ID)
    expect(() => verifyCatalogEnvelope(envelope())).toThrow(/不在本地信任库/)
  })
})

describe('信封验签与撤销', () => {
  it('签名正确时返回 payload', () => {
    importTestKey()
    const verified = verifyCatalogEnvelope(envelope())
    expect(verified.keyId).toBe(KEY_ID)
    expect(verified.serial).toBe(1)
    expect(verified.payload).toBeTruthy()
  })

  it('内容被改动 → 签名校验失败', () => {
    importTestKey()
    const env = envelope()
    const payload = env.payload as { entries: Array<Record<string, unknown>> }
    payload.entries[0]!.summary = '被篡改的说明'
    expect(() => verifyCatalogEnvelope(env)).toThrow(/签名校验失败/)
  })

  it('未签名 v1 目录直接拒绝，并给出明确原因', () => {
    importTestKey()
    expect(() => verifyCatalogEnvelope({ version: 1, entries: [ENTRY] })).toThrow(/未签名的 v1/)
  })

  it('签名密钥在撤销列表里 → 整份拒绝', () => {
    importTestKey()
    expect(() =>
      verifyCatalogEnvelope(envelope({ payload: { entries: [ENTRY], revoked: { keyIds: [KEY_ID] } } }))
    ).toThrow(/已被发布者撤销/)
  })

  it('serial 低于本机高水位 → 拒绝回滚', () => {
    importTestKey()
    verifyCatalogEnvelope(envelope({ serial: 5 }))
    commitCatalogSerial(KEY_ID, 5)
    expect(() => verifyCatalogEnvelope(envelope({ serial: 4 }))).toThrow(/版本回滚/)
    // 同版本重放允许（同一份已验签的目录）
    expect(verifyCatalogEnvelope(envelope({ serial: 5 })).serial).toBe(5)
  })

  it('被撤销的条目按 id / 哈希命中', () => {
    const payload = { entries: [ENTRY], revoked: { entryIds: ['memory'], entryHashes: [entryHash(ENTRY)] } }
    expect(revokedEntryReason(payload, 'memory', ENTRY)).toBe('已被发布者撤销')
    expect(revokedEntryReason(payload, 'other', ENTRY)).toBe('已被发布者撤销')
    expect(revokedEntryReason(payload, 'other', { entries: [] })).toBeNull()
  })
})

describe('缓存目录的加载口径', () => {
  it('验签通过才计入 remoteCount，并带 remoteVerified', () => {
    importTestKey()
    h.store.set('mcp_catalog_index_url', 'https://example.com/catalog.json')
    h.store.set('mcp_catalog_remote_json', JSON.stringify(envelope()))
    h.store.set('mcp_catalog_remote_updated_at', '1')
    const view = listMcpCatalog()
    expect(view.remoteCount).toBe(1)
    expect(view.remoteVerified?.keyId).toBe(KEY_ID)
    expect(view.entries.some((e) => e.id === 'memory' && e.source === 'remote')).toBe(true)
  })

  it('缓存是未签名 v1 → 不加载远程条目，remoteError 说明原因', () => {
    h.store.set('mcp_catalog_index_url', 'https://example.com/catalog.json')
    h.store.set('mcp_catalog_remote_json', JSON.stringify({ version: 1, entries: [ENTRY] }))
    const view = listMcpCatalog()
    expect(view.remoteCount).toBe(0)
    expect(view.entries.some((e) => e.id === 'memory')).toBe(true) // 内置条目仍在
    expect(view.remoteError).toMatch(/未签名的 v1/)
  })
})
