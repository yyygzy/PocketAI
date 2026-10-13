// 检索降级记账（V4-Iter-125 / 知识库增强 A3）
//
// 治的是「静默」而不是「失败」：向量路与 FTS 路一直是空 catch，重排解析失败也照原序返回，
// 于是「少了一路召回」在界面上不留痕迹（SEC-18 那次 BM25 恒 0 命中就是这么被埋了很久）。
// 本模块只负责把降级**说出来**，不改变任何检索行为：
//  - WARN 进 main.log（可事后 grep，与 MCP 启动失败同一口径）；
//  - 同一条以 label `kb.degrade` 入 perf 环形缓冲 ⇒ 数据健康面板的「最近慢操作」与
//    「跨会话慢事件统计」自动多出一行可数的降级（不新建表：日志本来就是持久层，见 shared/perf-lines.ts）。
import { createLogger } from '../logger'
import { recordPerf } from '../steward/perf-probe'
import type { RetrievalDegradation } from '../../shared/types'

const log = createLogger('kb')

/** 面板与统计用的标签（i18n 键 dh.perf.label.kb.degrade） */
export const KB_DEGRADE_PERF_LABEL = 'kb.degrade'

/**
 * 记一条检索降级。
 * @param ms 该路实际耗时（失败前的等待时长有归因价值：超时类会直接显示成很大的数）
 */
export function noteRetrievalDegradation(d: RetrievalDegradation, ms = 0): void {
  const detail = `stage=${d.stage}${d.kbId ? ` kb=${d.kbId}` : ''} reason=${d.reason}`
  log.warn(`检索降级: ${detail}`)
  recordPerf(KB_DEGRADE_PERF_LABEL, ms, detail)
}
