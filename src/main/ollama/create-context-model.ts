// 本地 Ollama 上下文窗口适配：用 native /api/create 从基础模型派生一个带大 num_ctx 的版本。
//
// 为什么需要：Ollama 的 OpenAI 兼容 /v1/chat/completions **不接受** num_ctx / options.num_ctx
// （实测 0.40.17 两者均 400）。官方唯一方式是用 Modelfile 或 /api/create 的 parameters 覆盖
// 创建衍生模型。实测字段：{model, from, parameters:{num_ctx}, stream:false}，创建后
// /api/show 可见 "num_ctx 8192"。这里把这条已验证的路径封装成可复用的 client。
//
// 与 systemone.ts 同风格：不引 DB/electron，纯 node 单测可直接 import；直连 127.0.0.1
// （safeFetch 按 SSRF 策略拦截环回地址）。
import { classifyProbeFailure } from '../../shared/ollama-probe'

const BASE_URL = 'http://127.0.0.1:11434'
const CREATE_TIMEOUT_MS = 300_000 // 大模型派生可能要几分钟（复制权重层）

const MODEL_RE = /^[\w.\-:]+$/
const MAX_NAME_CHARS = 128
/** Ollama 官方与常见 coder 模型的上下文上限档位；拒绝离谱值（如 10 亿） */
const MIN_CTX = 2048
const MAX_CTX = 1_048_576

export interface CreateContextModelRequest {
  /** 基础模型名（已在本地），如 qwen3-coder:30b */
  from: string
  /** 派生模型名，如 qwen3-coder:30b-256k */
  model: string
  /** 目标上下文 token 数，如 131072 */
  numCtx: number
}

export interface CreateContextModelResult {
  ok: boolean
  error?: string
}

function validate(req: CreateContextModelRequest): string | null {
  if (!req || typeof req !== 'object') return '请求格式不正确'
  if (typeof req.from !== 'string' || !MODEL_RE.test(req.from.trim()) || req.from.length > MAX_NAME_CHARS) {
    return '基础模型名包含非法字符'
  }
  if (typeof req.model !== 'string' || !MODEL_RE.test(req.model.trim()) || req.model.length > MAX_NAME_CHARS) {
    return '新模型名包含非法字符'
  }
  if (req.model.trim() === req.from.trim()) return '新模型名不能与基础模型相同'
  if (!Number.isInteger(req.numCtx) || req.numCtx < MIN_CTX || req.numCtx > MAX_CTX) {
    return `上下文长度需为 ${MIN_CTX} 到 ${MAX_CTX} 之间的整数`
  }
  return null
}

/**
 * 派生一个带大上下文的本地模型。失败分三类措辞，与 systemone/keepalive 同口径：
 *  - 连接层（没在跑/超时）⇒ 服务态提示；
 *  - HTTP 非 2xx（多为 from 模型不存在）⇒ 带原始 error；
 *  - 2xx 但没有 success ⇒ 明确说"未确认创建成功"。
 */
export async function createContextModel(req: CreateContextModelRequest): Promise<CreateContextModelResult> {
  const invalid = validate(req)
  if (invalid) return { ok: false, error: invalid }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CREATE_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(`${BASE_URL}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model.trim(),
          from: req.from.trim(),
          parameters: { num_ctx: req.numCtx },
          stream: false
        }),
        signal: ctrl.signal
      })
    } catch (e) {
      const kind = classifyProbeFailure(e)
      if (kind === 'down') return { ok: false, error: 'Ollama 服务未运行，请先启动' }
      if (kind === 'unknown') return { ok: false, error: '未能确认 Ollama 服务状态（请求未成功送达），请重试' }
      return { ok: false, error: 'Ollama 服务连接失败，请重试' }
    }
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { error?: string }
        detail = typeof body?.error === 'string' ? body.error : ''
      } catch {
        /* 非 JSON 错误体，用 HTTP 码兜底 */
      }
      return { ok: false, error: detail ? `创建失败：${detail}` : `创建失败：HTTP ${res.status}` }
    }
    try {
      const body = (await res.json()) as { status?: string }
      if (body?.status !== 'success') return { ok: false, error: '未确认创建成功（返回体无 success）' }
      return { ok: true }
    } catch {
      return { ok: false, error: '创建结果无法解析' }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 派生名约定：基础名 + 后缀，如 qwen3-coder:30b → qwen3-coder:30b-256k */
export function derivedModelName(from: string, numCtx: number): string {
  const label = numCtx >= 1_000_000 ? `${Math.round(numCtx / 1_000_000)}m` : `${Math.round(numCtx / 1024)}k`
  return `${from.trim()}-${label}`
}

export const createContextModelClient = { createContextModel, derivedModelName }
