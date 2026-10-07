// 消息附件自动入库：助手关联知识库时，文本/图片附件内容追加到知识库向量索引
//
// 设计决策：
// 1. text 附件直接走 ingestText；image 附件需 OCR 配置才入库（ocrProviderId && ocrModel）
// 2. 入库通过 ingestText 复用现有分块+embedding+存储链路，不新建向量表
// 3. source 存 msg_${messageId} 前缀，便于按会话清理；标题前缀 [附件]
// 4. 助手未关联 KB 时不入库（没有检索入口，入库无意义）
// 5. 入库失败静默忽略（不阻断聊天主流程），仅记日志
import { ingestionService } from '../knowledge/ingestion'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { ocrImageDataUrl } from '../knowledge/ocr'
import type { ChatAttachment } from '../../shared/types'
import { errMsg } from '../error'
import { createLogger } from '../logger'

const logger = createLogger('attachment-ingestion')

/** OCR 配置：providerId + model，均非空才启用图片识别 */
export interface KbOcrConfig {
  providerId: string
  model: string
}

/**
 * 将消息中的附件入库到指定知识库。
 * - text 附件：直接 ingestText
 * - image 附件：仅当 ocrConfig 存在时 OCR 识别后入库；未配 OCR 的 KB 跳过
 * - kb 类型附件：跳过（已是 KB 文档引用）
 * @param kbId 目标知识库 id
 * @param messageId 来源消息 id（用于 source 标记与后续清理）
 * @param attachments 消息附件列表
 * @param ocrConfig 该 KB 的 OCR 配置（null=不处理图片）
 */
export async function ingestAttachmentsToKb(
  kbId: string,
  messageId: string,
  attachments: ChatAttachment[],
  ocrConfig: KbOcrConfig | null
): Promise<void> {
  for (const att of attachments) {
    if (att.type === 'kb') continue

    if (att.type === 'text') {
      if (!att.data?.trim()) continue
      try {
        const doc = kbDocRepo.insert({
          kbId,
          source: `msg_${messageId}`,
          sourceType: 'txt',
          title: `[附件] ${att.name}`
        })
        await ingestionService.ingestText(kbId, doc.id, att.data, att.name)
        logger.info(`文本附件入库成功: ${att.name} → kb=${kbId}, doc=${doc.id}`)
      } catch (e) {
        logger.warn(`文本附件入库失败: ${att.name}: ${errMsg(e)}`)
      }
      continue
    }

    // image 类型：需 OCR 配置
    if (att.type === 'image') {
      if (!ocrConfig || !att.data) continue
      try {
        const text = await ocrImageDataUrl(att.data, ocrConfig.providerId, ocrConfig.model)
        const doc = kbDocRepo.insert({
          kbId,
          source: `msg_${messageId}`,
          sourceType: 'txt',
          title: `[附件] ${att.name}`
        })
        await ingestionService.ingestText(kbId, doc.id, text, att.name)
        logger.info(`图片附件 OCR 入库成功: ${att.name} → kb=${kbId}, doc=${doc.id}`)
      } catch (e) {
        logger.warn(`图片附件 OCR 入库失败: ${att.name}: ${errMsg(e)}`)
      }
    }
  }
}

/**
 * 清理指定消息关联的附件文档（会话删除时调用）。
 * 按 source 精确匹配：msg_${messageId}，跨所有 KB 清理。
 */
export function deleteMessageAttachmentDocs(messageId: string): void {
  const docs = kbDocRepo.listAll().filter((d) => d.source === `msg_${messageId}`)
  for (const doc of docs) {
    kbDocRepo.delete(doc.id)
  }
}
