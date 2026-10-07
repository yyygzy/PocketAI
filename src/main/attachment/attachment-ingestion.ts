// 消息附件自动入库：助手关联知识库时，文本附件内容追加到知识库向量索引
//
// 设计决策：
// 1. 只处理 text 类型附件（txt/md/docx/pdf 等已解析为文本的），图片需 OCR 另行处理
// 2. 入库通过 ingestText 复用现有分块+embedding+存储链路，不新建向量表
// 3. source 存 msg_${messageId} 前缀，便于按会话清理；标题前缀 [附件]
// 4. 助手未关联 KB 时不入库（没有检索入口，入库无意义）
// 5. 入库失败静默忽略（不阻断聊天主流程），仅记日志
import { ingestionService } from '../knowledge/ingestion'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import type { ChatAttachment } from '../../shared/types'
import { errMsg } from '../error'
import { createLogger } from '../logger'

const logger = createLogger('attachment-ingestion')

/**
 * 将消息中的文本附件入库到指定知识库。
 * @param kbId 目标知识库 id
 * @param messageId 来源消息 id（用于 source 标记与后续清理）
 * @param attachments 消息附件列表（自动过滤出 text 类型）
 */
export async function ingestTextAttachmentsToKb(
  kbId: string,
  messageId: string,
  attachments: ChatAttachment[]
): Promise<void> {
  const textAtts = attachments.filter((a) => a.type === 'text' && a.data?.trim())
  if (textAtts.length === 0) return

  for (const att of textAtts) {
    try {
      const doc = kbDocRepo.insert({
        kbId,
        source: `msg_${messageId}`,
        sourceType: 'txt',
        title: `[附件] ${att.name}`
      })
      await ingestionService.ingestText(kbId, doc.id, att.data, att.name)
      logger.info(`附件入库成功: ${att.name} → kb=${kbId}, doc=${doc.id}`)
    } catch (e) {
      logger.warn(`附件入库失败: ${att.name}: ${errMsg(e)}`)
    }
  }
}

/**
 * 清理指定消息关联的附件文档（会话删除时调用）。
 * 按 source 精确匹配：msg_${messageId}
 */
export function deleteMessageAttachmentDocs(messageId: string): void {
  const docs = kbDocRepo.listAll().filter((d) => d.source === `msg_${messageId}`)
  for (const doc of docs) {
    kbDocRepo.delete(doc.id)
  }
}
