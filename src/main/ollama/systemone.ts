// Ollama Jev 风格决策模型：/v1/systemone（Ollama ≥0.35，跨平台）。
//
// 与 chat/embed 走 OpenAICompatibleAdapter 不同，systemone 是 Ollama 专有端点，
// 且必须直连本地 11434（safeFetch 按 SSRF 策略会拦截 127.0.0.1），故独立成模块。
// 不引入 DB / electron 依赖，保证纯 node 单测可直接 import。
import { classifyProbeFailure } from '../../shared/ollama-probe'
import type {
  SystemOneRequest,
  SystemOneResponse
} from '../../shared/types'

const BASE_URL = 'http://127.0.0.1:11434'
const SYSTEMONE_TIMEOUT_MS = 60_000

export type { SystemOneRequest, SystemOneResponse, SystemOneAnswer, SystemOneQuestion } from '../../shared/types'

const MODEL_RE = /^[\w.\-:]+$/

function validateRequest(req: SystemOneRequest): string | null {
  if (!req || typeof req !== 'object') return '决策请求格式不正确'
  if (typeof req.model !== 'string' || !MODEL_RE.test(req.model.trim())) return '模型名包含非法字符'
  if (!req.state || typeof req.state !== 'object' || Array.isArray(req.state)) return 'state 必须是对象'
  for (const [k, v] of Object.entries(req.state)) {
    if (!k || typeof v !== 'string') return `state 的键「${k}」值必须是文本`
  }
  if (!req.questions || typeof req.questions !== 'object' || Array.isArray(req.questions)) return 'questions 必须是对象'
  const names = Object.keys(req.questions)
  if (names.length === 0) return '至少需要一个决策问题'
  if (names.length > 16) return '决策问题最多 16 个'
  for (const name of names) {
    const q = req.questions[name]!
    if (!q || typeof q !== 'object') return `问题「${name}」格式不正确`
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) return `问题「${name}」缺少说明`
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria ?? {})
      if (keys.length < 2) return `问题「${name}」的 choice 至少需要两个选项`
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) return `问题「${name}」的 score 至少需要两个档位`
    } else if (q.type !== 'noul') {
      return `问题「${name}」的类型不支持（仅 choice / noul / score）`
    }
  }
  return null
}

/**
 * 调本地 /v1/systemone。失败分三类，避免把"没在跑"与"模型没拉"混成一句：
 *  - 连接层（没在跑/超时/有人听但没正常答）⇒ 服务态提示；
 *  - HTTP 非 2xx（多为模型未拉取）⇒ 带原始错误；
 *  - 响应 JSON 不合法 ⇒ 明确说"返回无法解析"。
 */
export async function runSystemOne(req: SystemOneRequest): Promise<SystemOneResponse> {
  const invalid = validateRequest(req)
  if (invalid) throw new Error(invalid)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SYSTEMONE_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(`${BASE_URL}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model.trim(),
          state: req.state,
          questions: req.questions
        }),
        signal: ctrl.signal
      })
    } catch (e) {
      // classifyProbeFailure 把"连接被拒"与"超时/无响应"分开，措辞与状态面板一致
      const kind = classifyProbeFailure(e)
      if (kind === 'down') throw new Error('Ollama 服务未运行，请先启动')
      if (kind === 'unknown') throw new Error('未能确认 Ollama 服务状态（请求未成功送达），请重试')
      throw new Error('Ollama 服务连接失败，请重试')
    }
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { error?: string }
        detail = typeof body?.error === 'string' ? body.error : ''
      } catch {
        /* 非 JSON 错误体，用 HTTP 码兜底 */
      }
      throw new Error(detail ? `决策请求失败：${detail}` : `决策请求失败：HTTP ${res.status}`)
    }
    try {
      const body = (await res.json()) as SystemOneResponse
      if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') {
        throw new Error('返回结构不正确')
      }
      return body
    } catch (e) {
      throw new Error(`决策结果无法解析：${e instanceof Error ? e.message : String(e)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

export const systemOneClient = { runSystemOne }
