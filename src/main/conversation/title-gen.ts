// 会话智能标题：首条用户消息后用模型为会话生成短标题
//
// 设计：
// - title_default=1 的会话首轮消息才触发，进入即消费标记（每会话至多一次 LLM 调用）
// - 开关开启时先同步落「截断标题」保证列表立即可读，再后台升级为模型标题，成功后广播事件
// - 任何失败（无适配器/网络/超时/空返回）静默保留截断标题，绝不阻断对话
import { IPC } from '../../shared/types'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { providerManager } from '../providers/manager'
import { broadcast } from '../ipc/broadcast'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { isSmartTitleEnabled } from './title-config'
import {
  PLACEHOLDER_TITLE,
  TITLE_MAX_TOKENS,
  TITLE_TIMEOUT_MS,
  buildTitlePrompt,
  fallbackTitle,
  sanitizeTitle
} from './title-prompt'

const log = createLogger('title-gen')

export interface FirstMessageTitleArgs {
  conversationId: string
  userContent: string
  /** 用于生成标题的模型适配器（Chat 多目标取首个） */
  providerId: string
  model: string
}

/**
 * 首轮消息的标题处理。同步函数：立即完成截断命名并消费标记，
 * LLM 命名在后台进行（不阻塞流式回答）。不抛出。
 */
export function runFirstMessageTitle(args: FirstMessageTitleArgs): void {
  const conv = conversationRepo.get(args.conversationId)
  if (!conv || !conv.titleDefault) return

  // 进入即定稿标记：无论成功失败、开关与否，每会话只自动处理这一次
  conversationRepo.setTitleDefault(args.conversationId, false)

  if (!isSmartTitleEnabled()) {
    // 关闭时完全保持旧行为：只有「新对话」/空标题才截断改名，助手名等占位原样保留
    if (conv.title === PLACEHOLDER_TITLE || !conv.title) {
      conversationRepo.rename(args.conversationId, fallbackTitle(args.userContent))
    }
    return
  }

  const fallback = fallbackTitle(args.userContent)
  conversationRepo.rename(args.conversationId, fallback)
  // 纯图片等空文本消息不调用文本模型（多模态识图命名不在本批范围）
  if (!args.userContent.trim()) return
  void upgradeTitleWithLlm(args, fallback)
}

/** 后台用模型把截断标题升级为短标题；失败静默保留 fallback */
async function upgradeTitleWithLlm(args: FirstMessageTitleArgs, fallback: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  try {
    const adapter = providerManager.getAdapter(args.providerId)
    const result = await adapter.streamChat(
      [{ role: 'user', content: buildTitlePrompt(args.userContent) }],
      { model: args.model, signal: controller.signal, maxTokens: TITLE_MAX_TOKENS, temperature: 0.3 },
      { onDelta: () => {} }
    )
    const title = sanitizeTitle(result.content ?? '', fallback)
    if (title && title !== fallback) {
      conversationRepo.rename(args.conversationId, title)
      broadcast(IPC.CONVERSATION_TITLE_EVENT, { conversationId: args.conversationId, title })
    }
  } catch (e) {
    log.warn(`智能标题生成失败，保留截断标题「${fallback}」: ${errMsg(e)}`)
  } finally {
    clearTimeout(timer)
  }
}
