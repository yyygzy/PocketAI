// @vitest-environment node
// B：MCP 站点级出网约束 + dry-run 出口计数（真库）
//
// 这一面钉两件事：
//  1. 站点策略只作用于 MCP HTTP 传输的 host：默认拒绝清单外地址；显式打开或入清单后才放行；
//     保存侧对非法 host **拒绝**（不是静默丢弃），读取侧才做丢弃（不让一行坏配置锁死全机）。
//  2. MCP 的出口/调用计数真的进了 dry-run 判据：HTTP 请求数并入出口计数，
//     `tools/call` 单独一组；回放作用域内拒绝建立连接并计数。
//
// 没做到的（stdio 子进程出网不可拦、不可数）不在用例里假装能测——见 outbound-policy.ts 文件头。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-site-policy'
  return {
    dir,
    data: dir + sep + 'data',
    logs: dir + sep + 'data' + sep + 'logs',
    db: dir + sep + 'data' + sep + 'app.db',
    config: dir + sep + 'data' + sep + 'config.json'
  }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db,
  LOGS_DIR: P.logs,
  CONFIG_PATH: P.config
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import {
  MCP_MAX_ALLOWED_HOSTS,
  assertMcpHostAllowed,
  getMcpSitePolicy,
  isMcpHostAllowed,
  mcpAllowedPrivateOrigin,
  normalizeMcpSitePolicy,
  sanitizeHost,
  saveMcpSitePolicy
} from '../src/main/mcp/outbound-policy'
import {
  getMcpHttpRequestCount,
  getMcpToolCallCount,
  noteMcpHttpRequest,
  noteMcpToolCall
} from '../src/main/mcp/outbound-metrics'
import {
  DRY_RUN_CONNECT_BLOCKED,
  assertMcpConnectAllowed,
  runWithToolsDisabled
} from '../src/main/agent/dry-run-scope'
import {
  captureDryRunSafetySnapshot,
  defaultDryRunSafetyOptions,
  diffDryRunSafety
} from '../src/main/agent/dry-run-safety'

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  fs.mkdirSync(P.logs, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  dbService.close()
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('host 归一化（纯函数）', () => {
  it('裸域名 / host:port / 完整 URL / 大写 / 尾点 归一到同一个 host', () => {
    expect(sanitizeHost('API.Example.com.')).toBe('api.example.com')
    expect(sanitizeHost('https://api.example.com/v1/mcp')).toBe('api.example.com')
    expect(sanitizeHost('localhost:3000')).toBe('localhost')
    expect(sanitizeHost('http://[::1]:8080/mcp')).toBe('[::1]')
  })

  it('解析不出 host 的输入返回 null，不会被当成空串混进清单', () => {
    expect(sanitizeHost('   ')).toBeNull()
    expect(sanitizeHost('http://')).toBeNull()
    expect(sanitizeHost(null)).toBeNull()
    expect(sanitizeHost(123)).toBeNull()
  })

  it('读取侧：非法项丢弃、重复去重、缺省拒绝清单外地址', () => {
    const p = normalizeMcpSitePolicy({
      allowedHosts: ['A.example.com', 'a.example.com', '', 'http://'],
      allowOtherHosts: false
    })
    expect(p).toEqual({ allowedHosts: ['a.example.com'], allowOtherHosts: false })
    // 缺字段 / 不是对象 ⇒ 默认拒绝（失败关闭），需用户显式打开「允许其它主机」
    expect(normalizeMcpSitePolicy(null)).toEqual({ allowedHosts: [], allowOtherHosts: false })
    expect(normalizeMcpSitePolicy({ allowedHosts: ['x.example.com'] }).allowOtherHosts).toBe(false)
  })

  it('判定：allowOtherHosts=true 放行一切；false 时只放行清单内（大小写不敏感）', () => {
    expect(isMcpHostAllowed('evil.example.net', { allowedHosts: [], allowOtherHosts: true })).toBe(true)
    const strict: { allowedHosts: string[]; allowOtherHosts: boolean } = {
      allowedHosts: ['api.example.com'],
      allowOtherHosts: false
    }
    expect(isMcpHostAllowed('API.example.com', strict)).toBe(true)
    expect(isMcpHostAllowed('evil.example.net', strict)).toBe(false)
  })

  it('私网放行 origin：仅白名单内 host（或显式放开时的回环）返回 origin', () => {
    saveMcpSitePolicy({ allowedHosts: ['localhost:3000'], allowOtherHosts: false })
    expect(mcpAllowedPrivateOrigin('http://localhost:3000/mcp')).toBe('http://localhost:3000')
    expect(mcpAllowedPrivateOrigin('http://127.0.0.1:3000/mcp')).toBeUndefined()
    expect(mcpAllowedPrivateOrigin('https://evil.example.com/mcp')).toBeUndefined()

    saveMcpSitePolicy({ allowedHosts: [], allowOtherHosts: true })
    expect(mcpAllowedPrivateOrigin('http://127.0.0.1:3000/mcp')).toBe('http://127.0.0.1:3000')

    saveMcpSitePolicy({ allowedHosts: [], allowOtherHosts: false })
  })
})

describe('站点策略落库（app_config，无新增迁移）', () => {
  it('保存 → 读回 → 请求前校验按 host 拒绝；显式打开后恢复放行', () => {
    expect(getMcpSitePolicy()).toEqual({ allowedHosts: [], allowOtherHosts: false })

    const saved = saveMcpSitePolicy({
      allowedHosts: ['API.example.com', ' api.example.com ', 'localhost:3000'],
      allowOtherHosts: false
    })
    expect(saved.allowedHosts).toEqual(['api.example.com', 'localhost'])
    expect(getMcpSitePolicy()).toEqual(saved)

    expect(() => assertMcpHostAllowed('https://api.example.com/mcp')).not.toThrow()
    expect(() => assertMcpHostAllowed('https://evil.example.net/mcp', 'evil')).toThrow(/MCP_HOST_BLOCKED/)

    saveMcpSitePolicy({ allowedHosts: [], allowOtherHosts: true })
    expect(() => assertMcpHostAllowed('https://evil.example.net/mcp')).not.toThrow()
  })

  it('保存侧对非法 host 拒绝（不是静默丢弃），原配置保持不变', () => {
    saveMcpSitePolicy({ allowedHosts: ['api.example.com'], allowOtherHosts: false })
    expect(() => saveMcpSitePolicy({ allowedHosts: ['http://'], allowOtherHosts: false })).toThrow(/域名格式无效/)
    expect(getMcpSitePolicy().allowedHosts).toEqual(['api.example.com'])
  })

  it('条数超过上限直接拒绝', () => {
    const many = Array.from({ length: MCP_MAX_ALLOWED_HOSTS + 1 }, (_, i) => `h${i}.example.com`)
    expect(() => saveMcpSitePolicy({ allowedHosts: many, allowOtherHosts: false })).toThrow()
  })
})

describe('dry-run 判据覆盖 MCP', () => {
  it('HTTP 请求与 tools/call 都能被前后对比抓到（默认出口口径含 MCP HTTP）', () => {
    const before = captureDryRunSafetySnapshot(defaultDryRunSafetyOptions())
    noteMcpHttpRequest()
    noteMcpToolCall()
    const after = captureDryRunSafetySnapshot(defaultDryRunSafetyOptions())
    const diff = diffDryRunSafety(before, after)

    expect(after.outboundCount - before.outboundCount).toBe(1)
    expect(after.mcpToolCallCount - before.mcpToolCallCount).toBe(1)
    expect(diff.outboundEqual).toBe(false)
    expect(diff.mcpToolCallsEqual).toBe(false)
    expect(diff.allEqual).toBe(false)
  })

  it('计数与两个取值器同一口径（注入探针时不改变 MCP 两个计数）', () => {
    const httpBefore = getMcpHttpRequestCount()
    const callBefore = getMcpToolCallCount()
    noteMcpHttpRequest()
    noteMcpToolCall()
    expect(getMcpHttpRequestCount() - httpBefore).toBe(1)
    expect(getMcpToolCallCount() - callBefore).toBe(1)
  })

  it('回放作用域内拒绝建立 MCP 连接，并计入 blockedConnects', async () => {
    const read = await runWithToolsDisabled(async (state) => {
      let msg = 'no-throw'
      try {
        assertMcpConnectAllowed('puppeteer')
      } catch (e) {
        msg = (e as Error).message
      }
      return { msg, blocked: state.blockedConnects }
    })
    expect(read.msg).toContain(DRY_RUN_CONNECT_BLOCKED)
    expect(read.blocked).toBe(1)
  })

  it('作用域外不禁连（回放闸不是全局开关）', () => {
    expect(() => assertMcpConnectAllowed('puppeteer')).not.toThrow()
  })
})
