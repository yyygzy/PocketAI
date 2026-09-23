// 翻译 IPC：流式翻译 / 中止 / 历史记录 / 术语表
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/types'
import type { TranslateRequestPayload } from '../../../shared/types'
import { runTranslate, abortTranslate } from '../../translate/translate-service'
import { translationRepo } from '../../db/repositories/translation.repo'
import { broadcast } from '../broadcast'

export function registerTranslateHandlers(): void {
  // 发起翻译：delta 经 TRANSLATE_CHUNK_EVENT 广播，最终结果作为 invoke 返回值
  ipcMain.handle(IPC.TRANSLATE_RUN, async (_e, payload: TranslateRequestPayload) => {
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
  })
  ipcMain.handle(IPC.TRANSLATE_ABORT, (_e, requestId: string) => {
    if (typeof requestId === 'string') abortTranslate(requestId)
    return { ok: true }
  })
  ipcMain.handle(IPC.TRANSLATION_LIST, () => translationRepo.historyList())
  ipcMain.handle(IPC.TRANSLATION_DELETE, (_e, id: string) => {
    if (typeof id === 'string') translationRepo.historyDelete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.TRANSLATION_CLEAR, () => {
    translationRepo.historyClear()
    return { ok: true }
  })
  ipcMain.handle(IPC.GLOSSARY_LIST, () => translationRepo.glossaryList())
  ipcMain.handle(
    IPC.GLOSSARY_SAVE,
    (_e, input: { sourceTerm?: string; targetTerm?: string }) => {
      const sourceTerm = String(input?.sourceTerm ?? '').trim()
      const targetTerm = String(input?.targetTerm ?? '').trim()
      if (!sourceTerm || !targetTerm) throw new Error('GLOSSARY_TERM_EMPTY')
      return translationRepo.glossaryAdd({ sourceTerm, targetTerm })
    }
  )
  ipcMain.handle(IPC.GLOSSARY_DELETE, (_e, id: string) => {
    if (typeof id === 'string') translationRepo.glossaryDelete(id)
    return { ok: true }
  })
}
