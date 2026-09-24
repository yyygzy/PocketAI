// 翻译 IPC：流式翻译 / 中止 / 历史记录 / 术语表
import { IPC } from '../../../shared/types'
import type { TranslateRequestPayload } from '../../../shared/types'
import { runTranslate, abortTranslate } from '../../translate/translate-service'
import { translationRepo } from '../../db/repositories/translation.repo'
import { broadcast } from '../broadcast'
import { safeHandle, argsSchema, z } from '../safe-handle'
import { translateRequestSchema, glossarySaveSchema } from '../../../shared/schemas/translate'
import { idSchema } from '../../../shared/schemas/providers'

export function registerTranslateHandlers(): void {
  // 发起翻译：delta 经 TRANSLATE_CHUNK_EVENT 广播，最终结果作为 invoke 返回值
  safeHandle(IPC.TRANSLATE_RUN, async (_e, payload: TranslateRequestPayload) => {
    if (!payload || typeof payload.requestId !== 'string' || !payload.requestId) {
      return { ok: false, aborted: false, error: 'INVALID_REQUEST' }
    }
    if (typeof payload.text !== 'string' || !payload.text.trim()) {
      return { ok: false, aborted: false, error: 'EMPTY_TEXT' }
    }
    if (!payload.providerId || !payload.model) {
      return { ok: false, aborted: false, error: 'MISSING_CONFIG' }
    }
    // 渲染端类型已排除 auto，这里仅防异常入参
    if ((payload as { targetLang?: string }).targetLang === 'auto') {
      return { ok: false, aborted: false, error: 'INVALID_TARGET_LANG' }
    }
    return runTranslate(payload, (requestId, delta) =>
      broadcast(IPC.TRANSLATE_CHUNK_EVENT, { requestId, delta })
    )
  }, argsSchema(translateRequestSchema))
  safeHandle(IPC.TRANSLATE_ABORT, (_e, requestId: string) => {
    if (typeof requestId === 'string') abortTranslate(requestId)
    return { ok: true }
  }, argsSchema(z.string()))
  safeHandle(IPC.TRANSLATION_LIST, () => translationRepo.historyList())
  safeHandle(IPC.TRANSLATION_DELETE, (_e, id: string) => {
    if (typeof id === 'string') translationRepo.historyDelete(id)
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.TRANSLATION_CLEAR, () => {
    translationRepo.historyClear()
    return { ok: true }
  })
  safeHandle(IPC.GLOSSARY_LIST, () => translationRepo.glossaryList())
  safeHandle(
    IPC.GLOSSARY_SAVE,
    (_e, input: { sourceTerm?: string; targetTerm?: string }) => {
      const sourceTerm = String(input?.sourceTerm ?? '').trim()
      const targetTerm = String(input?.targetTerm ?? '').trim()
      if (!sourceTerm || !targetTerm) throw new Error('GLOSSARY_TERM_EMPTY')
      return translationRepo.glossaryAdd({ sourceTerm, targetTerm })
    },
    argsSchema(glossarySaveSchema)
  )
  safeHandle(IPC.GLOSSARY_DELETE, (_e, id: string) => {
    if (typeof id === 'string') translationRepo.glossaryDelete(id)
    return { ok: true }
  }, argsSchema(idSchema))
}
