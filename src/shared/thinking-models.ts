// 「哪些模型认 enable_thinking」（v78 思考开关）
//
// 为什么必须收窄：`enable_thinking` 是 DashScope/Qwen3 系的参数，OpenAI/Gemini/Claude
// 对未知字段直接返回 400（不是静默忽略）。开关若对任何模型都下发，用户在 GPT 上点一下
// 就会把整轮打挂。所以能力判定与下发判定共用这一份，主进程与渲染层都从这里取。
//
// 只认 Qwen3 / QwQ 这类默认思考、且官方支持该参数的模型族：
// Qwen2.5 及更早不支持，OpenAI 系不支持，DeepSeek 走的是 reasoning_content 另一套。
const THINKING_CAPABLE_RE = /qwen-?3|qwq|qwen-plus|qwen-max|qwen-turbo|qwen-flash/i

export function isThinkingCapableModel(model: string): boolean {
  return THINKING_CAPABLE_RE.test(String(model ?? ''))
}
