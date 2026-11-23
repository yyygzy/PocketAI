// Ollama /api/create 衍生大上下文模型 client 回归（实测字段已验证）：
//  ① 请求体：{model, from, parameters:{num_ctx}, stream:false}，直连 11434
//  ② 名字约定 derivedModelName 与 UI 一致（防两份真相漂移）
//  ③ 错误三态：服务未运行/超时/HTTP 原始 error/坏返回
//  ④ 入参校验：名字非法、同名、num_ctx 越界
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createContextModel, derivedModelName, type CreateContextModelRequest
} from '../src/main/ollama/create-context-model'

const req: CreateContextModelRequest = {
  from: 'qwen3-coder:30b',
  model: 'qwen3-coder:30b-256k',
  numCtx: 262144
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

describe('createContextModel 请求与名字约定', () => {
  it('POST /api/create，实测字段原样送出', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'success' }), { status: 200 }))
    const out = await createContextModel(req)
    expect(out.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/api/create')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'qwen3-coder:30b-256k',
      from: 'qwen3-coder:30b',
      parameters: { num_ctx: 262144 },
      stream: false
    })
  })

  it('derivedModelName 两种档位后缀与 UI 约定一致', () => {
    expect(derivedModelName('qwen3-coder:30b', 131072)).toBe('qwen3-coder:30b-128k')
    expect(derivedModelName('qwen2.5-coder:7b', 262144)).toBe('qwen2.5-coder:7b-256k')
    expect(derivedModelName('qwen3-coder:30b', 1_048_576)).toBe('qwen3-coder:30b-1m')
  })
})

describe('createContextModel 错误三态', () => {
  it('连接被拒 → 服务未运行', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))
    const r = await createContextModel(req)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('服务未运行')
  })

  it('超时（AbortError） → 未能确认状态', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }))
    expect((await createContextModel(req)).error).toContain('未能确认')
  })

  it('非 2xx 带 error → 带出原始错误（from 模型不存在等）', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }))
    expect((await createContextModel(req)).error).toContain('model not found')
  })

  it('2xx 但无 success → 未确认创建成功', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    expect((await createContextModel(req)).error).toContain('未确认创建成功')
  })
})

describe('createContextModel 入参校验', () => {
  it('模型名非法 / 同名 / num_ctx 越界 → 本地拒绝，不发请求', async () => {
    for (const bad of [
      { ...req, from: 'bad name' },
      { ...req, model: 'bad name' },
      { ...req, model: req.from },
      { ...req, numCtx: 1024 },
      { ...req, numCtx: 1.5 },
      { ...req, numCtx: 2_000_000 }
    ]) {
      expect((await createContextModel(bad)).ok).toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
