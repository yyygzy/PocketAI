// P1-3e：启动后自动续跑。
// 第一刀只处理 interrupted（不自动重试 failed），且完全复用 chat-service 的 fail-closed 准入：
// 产物事实、锚点、工作目录/内容指纹、工具授权、预算，任何一项不过都不发一次模型。
// 默认开启；`agent.autoResume='0'` 是整机急停开关（DB 不可读时按关闭处理）。
import { randomUUID } from 'node:crypto'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { dbService } from '../db/database'
import { conversationRunRepo } from '../db/repositories/conversation-run.repo'
import { broadcast } from '../ipc/broadcast'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { chatService } from './chat-service'

const logger = createLogger('auto-resume')
export const AUTO_RESUME_KEY = 'agent.autoResume'

let started = false

/** 仅供测试重置「每进程只跑一次」的门闩 */
export function resetAutoResumeForTest(): void {
  started = false
}

export function isAutoResumeEnabled(): boolean {
  try {
    if (!dbService.isOpen()) return false
    return appConfigRepo.get(AUTO_RESUME_KEY) !== '0'
  } catch {
    return false
  }
}

/**
 * 启动钩子调用；重复调用是空操作。
 * 广播走全局广播而不是 IPC sender：启动时可能还没有窗口，事件丢了也没关系，
 * 渲染端挂载时会从库里重新取候选与运行态。
 */
export async function startAutoResume(): Promise<void> {
  if (started) return
  started = true
  try {
    if (!isAutoResumeEnabled()) {
      logger.info('自动续跑已关闭，跳过')
      return
    }
    const candidates = conversationRunRepo.listAutoResumeCandidates()
    if (candidates.length === 0) return
    logger.info(`启动对账发现 ${candidates.length} 条可续候选，逐条复核`)

    for (const { conversationId, requestId } of candidates) {
      try {
        const cand = chatService.getResumeCandidate(conversationId)
        if (!cand || cand.requestId !== requestId) {
          logger.warn(`自动续跑跳过过期候选 ${requestId}`)
          continue
        }
        if (cand.kind !== 'interrupted') {
          logger.warn(`自动续跑跳过非中断候选 ${requestId}（${cand.kind}），失败单步只由用户手动重试`)
          continue
        }
        if (cand.state === 'blocked') {
          logger.warn(`自动续跑拦截 ${requestId}: ${cand.code ?? 'RESUME_ARTIFACTS_MISMATCH'}`)
          continue
        }
        await chatService.resume(
          { requestId: randomUUID(), conversationId, resumeFromRequestId: requestId },
          (channel, data) => broadcast(channel, data)
        )
        logger.info(`自动续跑已启动 ${requestId}（会话 ${conversationId}）`)
      } catch (e) {
        // 单条失败不影响后续会话；错误留在日志里，候选行仍是 interrupted 供下次复核
        logger.warn(`自动续跑 ${requestId} 失败: ${errMsg(e)}`)
      }
    }
  } catch (e) {
    logger.warn(`自动续跑启动扫描失败: ${errMsg(e)}`)
  }
}
