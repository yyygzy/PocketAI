// P4-5 IPC 入站 payload 资源上限测试
//
// 覆盖三类直通危险 sink 的共享 schema：
// - chat.ts：content/附件 → LLM 请求体 + SQLite（普通对话与 Agent 共用 CHAT_SEND）
// - mcp.ts：command/args/env → spawn，pythonPackages → pip，url → 未来 http 出网
// - files.ts：base64 → 解码写盘（解码前字符预检防内存翻倍）
//
// 巨型字符串用例按实际常量构造（最大 32MB，顺序执行可被 GC 回收）。
import { describe, it, expect } from 'vitest'
import {
  sendMessagePayloadSchema,
  regeneratePayloadSchema,
  resendPayloadSchema,
  CHAT_MAX_CONTENT_CHARS,
  CHAT_MAX_TARGETS,
  CHAT_MAX_ATTACHMENTS,
  CHAT_MAX_ATTACHMENT_DATA_CHARS,
  CHAT_MAX_ATTACHMENT_TOTAL_CHARS
} from '../src/shared/schemas/chat'
import { mcpServerSaveSchema, pythonPipSourceSchema } from '../src/shared/schemas/mcp'
import {
  base64Content,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BASE64_CHARS
} from '../src/shared/schemas/files'

// ── chat：基础合法形态 ────────────────────────────────────
const validPayload = {
  requestId: 'req-1',
  conversationId: 'conv-1',
  assistantId: null,
  content: '你好',
  targets: [{ providerId: 'p1', model: 'gpt-x' }]
}

describe('chat schema — 资源上限', () => {
  it('合法 payload 通过', () => {
    expect(sendMessagePayloadSchema.safeParse(validPayload).success).toBe(true)
  })

  it('content 上限边界：恰好等于上限通过', () => {
    const r = sendMessagePayloadSchema.safeParse({
      ...validPayload,
      content: '字'.repeat(CHAT_MAX_CONTENT_CHARS)
    })
    expect(r.success).toBe(true)
  })

  it('content 超 100 万字符拒绝', () => {
    const r = sendMessagePayloadSchema.safeParse({
      ...validPayload,
      content: 'a'.repeat(CHAT_MAX_CONTENT_CHARS + 1)
    })
    expect(r.success).toBe(false)
  })

  it('targets 为空拒绝（至少一个目标模型）', () => {
    expect(sendMessagePayloadSchema.safeParse({ ...validPayload, targets: [] }).success).toBe(false)
  })

  it(`targets 超过 ${CHAT_MAX_TARGETS} 个拒绝`, () => {
    const targets = Array.from({ length: CHAT_MAX_TARGETS + 1 }, (_, i) => ({
      providerId: 'p',
      model: `m${i}`
    }))
    expect(sendMessagePayloadSchema.safeParse({ ...validPayload, targets }).success).toBe(false)
  })

  it('target 标识超长拒绝', () => {
    const r = sendMessagePayloadSchema.safeParse({
      ...validPayload,
      targets: [{ providerId: 'p'.repeat(201), model: 'm' }]
    })
    expect(r.success).toBe(false)
  })

  it('运行时 id 超长拒绝（UUID 形态 ≤64）', () => {
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, requestId: 'x'.repeat(65) }).success
    ).toBe(false)
  })

  it('assistantId 允许 null 与 ≤64 字符串', () => {
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, assistantId: null }).success
    ).toBe(true)
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, assistantId: 'a'.repeat(64) }).success
    ).toBe(true)
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, assistantId: 'a'.repeat(65) }).success
    ).toBe(false)
  })
})

// ── chat：附件 ────────────────────────────────────────────
const att = (over: Partial<{ type: 'image' | 'text'; name: string; mimeType: string; size: number; data: string }> = {}) => ({
  type: 'image' as const,
  name: 'a.png',
  mimeType: 'image/png',
  size: 3,
  data: 'abc',
  ...over
})

describe('chat schema — 附件上限', () => {
  it('合法单个附件通过', () => {
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, attachments: [att()] }).success
    ).toBe(true)
  })

  it(`附件数量超过 ${CHAT_MAX_ATTACHMENTS} 拒绝`, () => {
    const attachments = Array.from({ length: CHAT_MAX_ATTACHMENTS + 1 }, () => att())
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, attachments }).success
    ).toBe(false)
  })

  it('附件 name/mimeType 超长拒绝', () => {
    expect(
      sendMessagePayloadSchema.safeParse({
        ...validPayload,
        attachments: [att({ name: 'n'.repeat(256) })]
      }).success
    ).toBe(false)
    expect(
      sendMessagePayloadSchema.safeParse({
        ...validPayload,
        attachments: [att({ mimeType: 'm'.repeat(101) })]
      }).success
    ).toBe(false)
  })

  it('非法 type 拒绝', () => {
    expect(
      sendMessagePayloadSchema.safeParse({
        ...validPayload,
        // @ts-expect-error 故意构造非法枚举
        attachments: [att({ type: 'audio' })]
      }).success
    ).toBe(false)
  })

  it(`单个附件 data 超过 ${CHAT_MAX_ATTACHMENT_DATA_CHARS} 字符拒绝`, () => {
    const attachments = [att({ data: 'a'.repeat(CHAT_MAX_ATTACHMENT_DATA_CHARS + 1), size: 0 })]
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, attachments }).success
    ).toBe(false)
  })

  it('单个附件恰好等于 data 上限通过（总量未超）', () => {
    const attachments = [att({ data: 'a'.repeat(CHAT_MAX_ATTACHMENT_DATA_CHARS), size: 0 })]
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, attachments }).success
    ).toBe(true)
  }, 30_000)

  it(`附件 data 总量超 ${CHAT_MAX_ATTACHMENT_TOTAL_CHARS} 拒绝（2×1600 万）`, () => {
    // 单个均未超 2000 万，但合计 3200 万 > 3000 万总量
    const big = 'a'.repeat(16_000_000)
    const attachments = [
      att({ data: big, size: 0 }),
      att({ name: 'b.png', data: big, size: 0 })
    ]
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, attachments }).success
    ).toBe(false)
  }, 30_000)

  it('size 字段为负/非整数拒绝', () => {
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, attachments: [att({ size: -1 })] })
        .success
    ).toBe(false)
    expect(
      sendMessagePayloadSchema.safeParse({ ...validPayload, attachments: [att({ size: 1.5 })] })
        .success
    ).toBe(false)
  })
})

// ── chat：regenerate / resend ─────────────────────────────
describe('chat schema — regenerate/resend', () => {
  const regen = {
    requestId: 'r',
    conversationId: 'c',
    assistantId: null,
    messageId: 'm',
    targets: [{ providerId: 'p', model: 'm' }]
  }

  it('regenerate 合法通过 / messageId 超长拒绝', () => {
    expect(regeneratePayloadSchema.safeParse(regen).success).toBe(true)
    expect(
      regeneratePayloadSchema.safeParse({ ...regen, messageId: 'x'.repeat(65) }).success
    ).toBe(false)
  })

  it('resend content 可选，超长拒绝', () => {
    expect(resendPayloadSchema.safeParse({ ...regen }).success).toBe(true)
    expect(
      resendPayloadSchema.safeParse({
        ...regen,
        content: 'a'.repeat(CHAT_MAX_CONTENT_CHARS + 1)
      }).success
    ).toBe(false)
  })
})

// ── mcp：SERVER_SAVE ──────────────────────────────────────
const validMcp = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: '我的 MCP',
  transport: 'stdio' as const,
  runtime: 'node' as const,
  command: 'node',
  args: ['server.js'],
  env: {},
  url: null,
  enabled: true,
  createdAt: 1700000000000,
  pythonPackages: []
}

describe('mcpServerSaveSchema — 类型与资源上限', () => {
  it('合法完整 stdio 记录通过', () => {
    expect(mcpServerSaveSchema.safeParse(validMcp).success).toBe(true)
  })

  it('部分更新（仅 name）通过', () => {
    expect(mcpServerSaveSchema.safeParse({ name: '新名字' }).success).toBe(true)
  })

  it("id 含 '../' / 路径分隔符拒绝（与 serverDir 白名单一致）", () => {
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, id: '../etc' }).success).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, id: 'a/b' }).success).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, id: 'a\\b' }).success).toBe(false)
    // 点号同样不在 serverDir 白名单（^[a-zA-Z0-9_-]+$），入口与文件系统层严格一致
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, id: 'a.b' }).success).toBe(false)
  })

  it('id 超 64 字符拒绝；合法短 id 接受', () => {
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, id: 'x'.repeat(65) }).success).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, id: 'abc-123_XYZ' }).success).toBe(true)
  })

  it('name 为空/超 100 字符拒绝', () => {
    expect(mcpServerSaveSchema.safeParse({ name: '' }).success).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false)
  })

  it('command 超 1024 字符拒绝', () => {
    expect(
      mcpServerSaveSchema.safeParse({ ...validMcp, command: 'c'.repeat(1025) }).success
    ).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, command: null }).success).toBe(true)
  })

  it('args 超 32 项 / 单项超 4096 拒绝', () => {
    expect(
      mcpServerSaveSchema.safeParse({
        ...validMcp,
        args: Array.from({ length: 33 }, (_, i) => String(i))
      }).success
    ).toBe(false)
    expect(
      mcpServerSaveSchema.safeParse({ ...validMcp, args: ['x'.repeat(4097)] }).success
    ).toBe(false)
  })

  it('env 超 64 项 / 键超长 / 值超长拒绝', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v']))
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, env: tooMany }).success).toBe(false)
    expect(
      mcpServerSaveSchema.safeParse({ ...validMcp, env: { ['k'.repeat(257)]: 'v' } }).success
    ).toBe(false)
    expect(
      mcpServerSaveSchema.safeParse({ ...validMcp, env: { K: 'v'.repeat(32_769) } }).success
    ).toBe(false)
    // 64 项合法
    const atLimit = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`K${i}`, 'v']))
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, env: atLimit }).success).toBe(true)
  })

  it('pythonPackages 超 50 个 / 单项超 200 拒绝（对齐 pip 服务层）', () => {
    expect(
      mcpServerSaveSchema.safeParse({
        ...validMcp,
        pythonPackages: Array.from({ length: 51 }, (_, i) => `pkg${i}`)
      }).success
    ).toBe(false)
    expect(
      mcpServerSaveSchema.safeParse({ ...validMcp, pythonPackages: ['p'.repeat(201)] }).success
    ).toBe(false)
  })

  it('transport/runtime 非法枚举拒绝', () => {
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, transport: 'ws' }).success).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, runtime: 'deno' }).success).toBe(false)
  })

  it('createdAt 负数/非整数拒绝', () => {
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, createdAt: -1 }).success).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, createdAt: 1.2 }).success).toBe(false)
  })
})

// ── mcp：http url（v1 未启用，入口前置免疫） ──────────────
describe('mcpServerSaveSchema — url 协议', () => {
  it('http/https URL 通过，null 通过', () => {
    expect(
      mcpServerSaveSchema.safeParse({ ...validMcp, url: 'http://127.0.0.1:8080/mcp' }).success
    ).toBe(true)
    expect(
      mcpServerSaveSchema.safeParse({
        ...validMcp,
        transport: 'http',
        command: null,
        url: 'https://mcp.example.com/sse'
      }).success
    ).toBe(true)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, url: null }).success).toBe(true)
  })

  it('ftp/file/javascript 协议与畸形 URL 拒绝', () => {
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, url: 'ftp://x/y' }).success).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, url: 'file:///c:/x' }).success).toBe(false)
    expect(
      mcpServerSaveSchema.safeParse({ ...validMcp, url: 'javascript:alert(1)' }).success
    ).toBe(false)
    expect(mcpServerSaveSchema.safeParse({ ...validMcp, url: 'not a url' }).success).toBe(false)
  })
})

// ── pip 源（与 python-env 服务层共用同一 schema） ─────────
describe('pythonPipSourceSchema', () => {
  it('official / tuna 关键字通过', () => {
    expect(pythonPipSourceSchema.safeParse('official').success).toBe(true)
    expect(pythonPipSourceSchema.safeParse('tuna').success).toBe(true)
  })

  it('自定义镜像：https 通过；http 仅本机回环例外（SEC-20 收紧）', () => {
    expect(pythonPipSourceSchema.safeParse('https://mirrors.aliyun.com/pypi/simple').success).toBe(
      true
    )
    expect(pythonPipSourceSchema.safeParse('http://localhost:3141/simple').success).toBe(true)
    // 明文远端（含内网地址）一律拒：换源等于替换落进 venv 的 wheel 来源
    expect(pythonPipSourceSchema.safeParse('http://192.168.1.2:3141/simple').success).toBe(false)
  })

  it('非 http(s) 协议 / 空串 / 畸形值拒绝', () => {
    expect(pythonPipSourceSchema.safeParse('ftp://pypi/x').success).toBe(false)
    expect(pythonPipSourceSchema.safeParse('').success).toBe(false)
    expect(pythonPipSourceSchema.safeParse('not-a-url').success).toBe(false)
  })
})

// ── files：base64 预检 ────────────────────────────────────
describe('base64Content — 上传收口', () => {
  it('空串拒绝', () => {
    expect(base64Content.safeParse('').success).toBe(false)
  })

  it('正常 base64 通过', () => {
    expect(base64Content.safeParse('aGVsbG8=').success).toBe(true)
  })

  it('上限常量数学自洽：140MiB 字符足以编码 100MiB 二进制', () => {
    // 不在测试中暴力分配 146MB 字符串，只验证边界数学：
    // n 字节的 base64 长度为 ceil(n/3)*4
    const needed = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4
    expect(MAX_UPLOAD_BASE64_CHARS).toBeGreaterThanOrEqual(needed)
    // 上限必须接近理论值（不允许误配成极小值使正常文件被拒）
    expect(MAX_UPLOAD_BASE64_CHARS).toBeLessThanOrEqual(MAX_UPLOAD_BYTES * 1.42)
  })
})
