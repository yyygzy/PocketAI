// Ollama Jev 决策模型 /v1/systemone 回归：
//  ① 请求体：直连 127.0.0.1:11434/v1/systemone，model/state/questions 原样透传
//  ② 响应：choice / noul / score 三种题型结构 + usage
//  ③ 错误三态：连接拒绝→未运行、超时→未确认、非 2xx 带原始 error、坏 JSON 明确说无法解析
//  ④ 入参校验：模型名非法、state/questions 形状错、题型不支持、选项不足
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runSystemOne, type SystemOneRequest } from '../src/main/ollama/systemone'

const req: SystemOneRequest = {
  model: 'nimble',
  state: { ticket: 'I was charged twice.' },
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'Payments', technical: 'Bugs' }
    },
    refund: { type: 'noul', instructions: 'Explicit refund request?' },
    urgency: { type: 'score', instructions: 'Urgency?', criteria: ['Routine', 'Urgent'] }
  }
}

const okBody = {
  model: 'nimble',
  answers: {
    team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.98 }, confidence: 0.92 },
    refund: { type: 'noul', noul: 0.99 },
    urgency: { type: 'score', score: 0.8, legend: { '0': 'Routine', '1': 'Urgent' }, probabilities: { '0': 0.4, '1': 0.6 }, confidence: 0.05 }
  },
  usage: { input_tokens: 841, output_tokens: 4 }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

describe('runSystemOne 请求与响应', () => {
  it('直连本地端点，POST + JSON，三种题型原样透传', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(okBody), { status: 200 }))
    const out = await runSystemOne(req)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/v1/systemone')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual(req)
    expect(out.answers.team!.choice).toBe('billing')
    expect(out.answers.refund!.noul).toBeCloseTo(0.99)
    expect(out.answers.urgency!.score).toBeCloseTo(0.8)
    expect(out.usage!.input_tokens).toBe(841)
  })

  it('choices 少于两项 / score 少于两档 → 本地拒绝，不发请求', async () => {
    const bad = {
      ...req,
      questions: { team: { type: 'choice' as const, instructions: 'x', criteria: { only: '1' } } }
    }
    await expect(runSystemOne(bad)).rejects.toThrow('至少需要两个选项')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('runSystemOne 错误三态', () => {
  it('连接被拒 → 明确「服务未运行」，不说「模型没拉」', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('connect'), { cause: { code: 'ECONNREFUSED' } }))
    await expect(runSystemOne(req)).rejects.toThrow('Ollama 服务未运行')
  })

  it('超时（AbortError） → 「未能确认服务状态」', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await expect(runSystemOne(req)).rejects.toThrow('未能确认 Ollama 服务状态')
  })

  it('HTTP 非 2xx 且带 error → 带出原始错误（模型未拉取等）', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'model "nimble" not found' }), { status: 404 }))
    await expect(runSystemOne(req)).rejects.toThrow('model "nimble" not found')
  })

  it('2xx 但 JSON 坏 → 明确「决策结果无法解析」', async () => {
    fetchMock.mockResolvedValue(new Response('<html>oops</html>', { status: 200 }))
    await expect(runSystemOne(req)).rejects.toThrow('决策结果无法解析')
  })
})

describe('runSystemOne 入参校验', () => {
  it('模型名非法字符拒绝', async () => {
    await expect(runSystemOne({ ...req, model: 'bad model' })).rejects.toThrow('模型名包含非法字符')
  })

  it('questions 为空拒绝', async () => {
    await expect(runSystemOne({ ...req, questions: {} })).rejects.toThrow('至少需要一个决策问题')
  })

  it('不支持的题型拒绝', async () => {
    const bad = { ...req, questions: { x: { type: 'bogus', instructions: 'x' } } }
    await expect(runSystemOne(bad as unknown as SystemOneRequest)).rejects.toThrow('类型不支持')
  })
})
