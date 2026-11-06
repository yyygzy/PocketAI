// @vitest-environment node
// P0-5 收尾：`agent_traces.tool_args / tool_result` 落库前必须过审批同款脱敏层。
//
// 承重命题：
//  · 两处账本同一口径：审批账本用 audit-redact，诊断账本也用 audit-redact，不在 engine 里另写正则；
//  · **先脱敏、再截断 4000**：密钥跨在边界上时不许在库里留下半截（先截后脱敏的坏法）；
//  · 误伤口径：纯文本工具结果里的示例 `token=` 也会被替换。这是可接受的取舍——
//    保留键名、只换值，且宁可误伤示例文本，也不把真凭据留在诊断账本里。
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-244-trace-redact'
  process.env.POCKETAI_APP_ROOT = dir + sep + 'app'
  return { dir, app: dir + sep + 'app', data: dir + sep + 'app' + sep + 'data' }
})

vi.mock('electron', () => ({
  ipcMain: { handle: () => true },
  BrowserWindow: class { static getAllWindows() { return [] } static fromWebContents() { return undefined } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  app: { isPackaged: false, getPath: () => P.data, getAppPath: () => process.cwd(), quit: () => {} }
}))

const ws = { dir: '' }
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => (key === 'agent.workspace_dir' && ws.dir ? ws.dir : undefined),
    set: (key: string, value: string) => {
      if (key === 'agent.workspace_dir') ws.dir = value
    },
    delete: (key: string) => {
      if (key === 'agent.workspace_dir') ws.dir = ''
    }
  }
}))

import {
  capRedactedToolCallArgs,
  capRedactedToolSignature,
  capRedactedTraceText,
  TRACE_TEXT_MAX_CHARS
} from '../src/main/agent/engine'

const call = (name: string, args: string): { id: string; type: 'function'; function: { name: string; arguments: string } } => ({
  id: `call_${name}`,
  type: 'function',
  function: { name, arguments: args }
})

const src = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

describe('① 已知高频凭据形态：两处账本同一套规则', () => {
  it('Authorization: Bearer xxx ⇒ 值换成统一占位符，头名保留', () => {
    const out = capRedactedTraceText('Authorization: Bearer sk-live-ABC123._-~+/=')!
    expect(out).toBe('Authorization: [redacted]')
  })

  it('api_key= 与 URL query token= 都被替换（键名保留，值不残留）', () => {
    const out = capRedactedTraceText('GET https://api.example.com/v1?token=abc123&api_key=def456')!
    expect(out).toBe('GET https://api.example.com/v1?token=[redacted]&api_key=[redacted]')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('def456')
  })

  it('JSON 参数里的键值对（headers.Authorization）必须走参数级脱敏，文本规则命中不到带引号的键名', () => {
    // `"authorization":` 的键名后多一个引号，文本规则 `authorization\s*[:=]` 匹配不上；
    // 参数级函数先 JSON.parse 再按键名脱敏，这一格才不是裸的。
    const out = capRedactedToolCallArgs([
      call('http_request', '{"headers":{"authorization":"Bearer abc.def.ghi"},"q":"ok"}')
    ])!
    expect(out).not.toContain('abc.def.ghi')
    expect(out).toContain('"authorization":"[redacted]"')
  })

  it('JSON 参数里的 api_key 键同样被替换（键名保留）', () => {
    const out = capRedactedToolCallArgs([call('kb_search', '{"api_key":"sk-live-ZZZ","q":"ok"}')])!
    expect(out).not.toContain('sk-live-ZZZ')
    expect(out).toContain('"api_key":"[redacted]"')
  })

  it('重复拦截那一行的签名也逐参数脱敏（形态与 computeToolSignature 一致）', () => {
    const out = capRedactedToolSignature([
      call('http_request', '{"headers":{"authorization":"Bearer abc.def.ghi"}}')
    ])!
    expect(out).not.toContain('abc.def.ghi')
    expect(out.startsWith('http_request:{')).toBe(true)
  })

  it('JSON 形态的工具返回值（API 响应）按键名脱敏，不是只靠文本规则', () => {
    const out = capRedactedTraceText('{"api_key":"sk-live-WWW","data":"ok"}')!
    expect(out).not.toContain('sk-live-WWW')
    expect(out).toContain('"api_key":"[redacted]"')
  })

  it('以 { 开头但不是合法 JSON 的纯文本：退回文本规则，不因解析失败就原样入库', () => {
    const out = capRedactedTraceText('{ 示例 token=demo-value }')!
    expect(out).toBe('{ 示例 token=[redacted] }')
  })

  it('空与 undefined 仍然落 NULL（"没有"不被写成"空字符串"）', () => {
    expect(capRedactedTraceText('')).toBeUndefined()
    expect(capRedactedTraceText(undefined)).toBeUndefined()
  })
})

describe('② 顺序：先脱敏、再截断 4000（边界上的密钥不许留半截）', () => {
  it('密钥正好跨 4000 边界 ⇒ 整段被替换，库里查不到任何前缀碎片', () => {
    // 让 `api_key=` 从第 3980 个字符附近开始：若先截断，4000 处会剩下 12 个字符的密钥
    const prefix = 'x'.repeat(3980)
    const secret = 'sk-live-SECRET-abcdefgh'
    const raw = `${prefix}api_key=${secret}`
    const out = capRedactedTraceText(raw)!
    expect(out).toContain('api_key=[redacted]')
    expect(out).not.toContain('sk-live')
    expect(out).not.toContain('SECRET')
    // 替换后总长降到 4000 以下，连截断提示都不该出现（证明规则先看到了完整密钥）
    expect(out).not.toContain('此处截断')
  })

  it('脱敏后仍超 4000 ⇒ 截断提示里的"完整 N 字符"是脱敏后的长度（不是原文长度）', () => {
    // 密钥后面空一格再接 5000 字符正文：没有空格的话规则会把正文也当成密钥值整段吃掉
    const body = 'y'.repeat(5000)
    const raw = `api_key=sk-live-ABC ${body}`
    const redacted = 'api_key=[redacted] ' + body
    const out = capRedactedTraceText(raw)!
    expect(out).not.toContain('sk-live')
    expect(out.startsWith('api_key=[redacted]')).toBe(true)
    expect(out).toContain(`完整 ${redacted.length} 字符`)
    expect(out.length).toBeGreaterThan(TRACE_TEXT_MAX_CHARS)
  })

  it('源码门禁：三个 trace 写入点都走脱敏口径，且没有退回 capTraceText 的裸路径', () => {
    const s = src('src/main/agent/engine.ts')
    expect(s).toMatch(/toolArgs:\s*capRedactedToolCallArgs\(toolCalls\)/)
    expect(s).toMatch(/toolArgs:\s*capRedactedToolSignature\(toolCalls\)/)
    expect(s).toMatch(/toolResult:\s*capRedactedTraceText\(rawResultText\)/)
    expect(s).not.toMatch(/toolArgs:\s*capTraceText\(/)
    expect(s).not.toMatch(/toolResult:\s*capTraceText\(/)
    // 不在 engine.ts 里另写一套正则：脱敏只能来自 audit-redact
    expect(s).toMatch(/from '\.\.\/security\/audit-redact'/)
    expect(s).not.toMatch(/Bearer\]?\+|api\[_-\]\?key/)
  })
})

describe('③ 误伤口径（可接受的代价，写清楚而不是假装没有）', () => {
  it('纯文本结果里出现示例 `token=` 也会被替换：保留键名、只换值', () => {
    // 网页正文/文档里完全可能出现这种示例代码，规则无法区分"示例"与"真值"。
    // 取舍：诊断账本是辅助线索，宁可让示例值变成 [redacted]，也不把真凭据留在库里。
    const body = '示例：请求时带上 ?token=demo-value 或 api_key=demo-key'
    expect(capRedactedTraceText(body)).toBe('示例：请求时带上 ?token=[redacted] 或 api_key=[redacted]')
  })

  it('不含凭据形态的正常长文本原样保留（不因"看起来像密码"就乱切）', () => {
    const body = '这是一段很长的正文。'.repeat(10)
    expect(capRedactedTraceText(body)).toBe(body)
  })
})
