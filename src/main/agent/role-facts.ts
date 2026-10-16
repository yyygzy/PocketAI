// 跨模型角色第二条合取里"检索链"那一条的事实（V4-Iter-150）——引擎与判据屏共用一个出处
//
// 为什么单开这块：150 之前那条合取的算法是"助手绑了库 / 工具面有 kb_search 就拦"，
// 而拦的理由（M10"一个 embed 把对话模型顶出去"）说的是**本机 GPU**。内置那路 embedding 走 onnxruntime 的
// CPU 推理、云端 embedding 不碰这张卡 ⇒ 拿 M10 当它们的理由是撒谎。判"落点"要读库与 provider 两张表，
// 那份算法因此不能住在 `shared/delegation-rules`（纯规则不许碰库，144 分家的理由），但**也只能有一处**：
// 引擎筛清单、prepareDelegation 逐次放行、判据屏画那一行，三处算的必须是同一个事实。
import { kbRepo } from '../db/repositories/kb.repo'
import { providerRepo } from '../db/repositories/provider.repo'
import { isLocalInferenceBaseUrl } from '../providers/local-slot'
import { BUILTIN_EMBED_PROVIDER_ID } from '../../shared/types'
import { retrievalEmbeddingHitsLocalEndpoint } from '../../shared/delegation-rules'

/**
 * 启用中、且 baseUrl 判为本地推理端点的 provider id。
 * 判"本地"直接复用 141 闸门那一个谓辞（`isLocalInferenceBaseUrl`），不在这里另写一份"什么算本地"——
 * 两处迟早漂移，而漂移的方向是把本地当云 ⇒ 该拦的没拦。
 */
function localInferenceProviderIds(): Set<string> {
  const out = new Set<string>()
  for (const p of providerRepo.list()) {
    if (!p?.enabled || !p.baseUrl) continue
    if (isLocalInferenceBaseUrl(p.baseUrl)) out.add(p.id)
  }
  return out
}

/**
 * 「这条编排的检索链会不会把 embedding 模型压进本机推理端点」。
 * 判的是**会被检索的那几个库**：`kb_search` 只搜助手绑定的库（kbIds 由引擎按次运行透传，工具本身没有
 * "指定别的库"的参数），所以这件事在 run 开头就能定死，不必等委派那一刻——判据屏能按助手画一行也是这个前提。
 * 库里没配 embedding（只做 BM25）、配的是内置 CPU 那路、或 provider 已停用/不在本地 ⇒ 都算不吃本机显存。
 */
export function retrievalHitsLocalEndpoint(kbIds: ReadonlyArray<string>): boolean {
  if (kbIds.length === 0) return false
  const wanted = new Set(kbIds)
  const kbs = kbRepo.list().filter((k) => wanted.has(k.id))
  return retrievalEmbeddingHitsLocalEndpoint(kbs, {
    builtinEmbedProviderId: BUILTIN_EMBED_PROVIDER_ID,
    localProviderIds: localInferenceProviderIds()
  })
}
