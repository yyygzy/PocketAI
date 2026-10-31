// §380：本机 11434 探测的共同底座（两处探针的判据 + 界面文案引用的那个数字）
//
// 为什么单独成一份 shared 文件：
//  1. 本仓有**两处独立探测** Ollama——`main/ollama/ollama-runtime.ts` 打 `/api/version`（便携运行时面板），
//     `main/steward/model-recommend.ts` 打 `/api/tags`（管家页徽标与"未检测到运行中的 Ollama"那句告警）。
//     改前两处都把 `catch` 里的任何东西折成"没在跑"，而"3 秒没答话"与"确实没人听"是两件事。
//     分类判据只写一次，两家共用 ⇒ 不会出现一面修好、另一面继续说谎。（两家的等待预算各自不同，
//     管家那一发是 2.5s；下面这份常量是**面板那一发**，界面文案只报它。）
//  2. 超时数字会显示在设置页那句提示里（"未在 {seconds} 秒内答话"）。数字住在主进程、文案住在四语字典，
//     中间没人钉 ⇒ 就是 §333/§379 那一族跨层手抄。常量搬到 shared、字典只写占位符、调用点带 params。
import type { OllamaLiveness } from './types'

/** 存活探测的等待上限。界面那句"未在 {seconds} 秒内答话"读的就是这一个数 */
export const OLLAMA_PROBE_TIMEOUT_MS = 3000

/**
 * 探测抛错时该怎么表态：只有操作系统明确说"这个地址没人接"才算 `down`。
 * 超时（`AbortError`）与任何认不出的形状都是 `unknown`——宁可对用户说"不知道"，
 * 也不替他把"没答话"签成"没运行"。
 */
export function classifyProbeFailure(error: unknown): OllamaLiveness {
  const e = error as { code?: string; cause?: { code?: string } } | null | undefined
  const code = e?.cause?.code ?? e?.code ?? ''
  if (code === 'ECONNREFUSED' || code === 'EADDRNOTAVAIL') return 'down'
  return 'unknown'
}
