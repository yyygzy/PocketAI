// KB 问答历史跨库漫游：全部知识库的问答会话统一入口（搜索 + 最近 200 条）
// 点击条目 → 切到所属库详情的问答 tab 并回放该会话（KnowledgeModule state 跳转）。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KbAskRoamItem } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { fmtSessionTime } from './KbAskPanel'

const ROAM_LIMIT = 200

export const KbAskRoam: React.FC<{
  onOpen: (kbId: string, sessionId: string) => void
}> = ({ onOpen }) => {
  const { t } = useI18n()
  const [items, setItems] = useState<KbAskRoamItem[]>([])
  const [keyword, setKeyword] = useState('')
  /**
   * §272：改前失败侧是 `if (!hasIpcFailed(r)) setItems(r)`＝什么都不做 ⇒ 屏上摆「暂无问答历史」，
   * 把通道故障演成"你一条问答都没留过"。这一屏的"自发重发"只有搜索框打字（防抖 200ms），
   * 那不是想看列表的人本来要做的动作 ⇒ 配一颗重试键（§268 判据）。
   */
  const [itemsUnread, setItemsUnread] = useState<{ error?: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback((kw: string) => {
    const k = kw.trim()
    const p = k
      ? window.pocketai.searchAllKbAskSessions(k, ROAM_LIMIT)
      : window.pocketai.listAllKbAskSessions(ROAM_LIMIT)
    // §223 那条老坑（绑到变量的 Promise 会把 `{ok:false}` 当数据写进列表）由这里的判据接着挡住
    p
      .then((r) => {
        if (hasIpcFailed(r)) {
          setItemsUnread({ error: r.error })
          return
        }
        setItemsUnread(null)
        setItems(r)
      })
      .catch((e: unknown) => {
        // reject 面同一张脸；旧写法那条会消失的 toast 等于没说
        setItemsUnread({ error: errText(e, '') })
        logIpcError('kb.searchAllKbAskSessions', e)
      })
  }, [])

  useEffect(() => {
    refresh('')
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 搜索输入：200ms 防抖（与单库历史搜索同模式） */
  const onInput = (kw: string) => {
    setKeyword(kw)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => refresh(kw), 200)
  }

  return (
    <div className="max-w-2xl">
      <h4 className="text-sm font-semibold mb-1">{t('kb.roamTitle')}</h4>
      <input
        className="input text-xs w-full mb-3"
        value={keyword}
        onChange={(e) => onInput(e.target.value)}
        placeholder={t('kb.roamSearchPlaceholder')}
      />
      {/* §272：那句独立挂在列表上方——搜索失败时上一份结果可能仍在屏上，
          那种时刻说的是"这次没读到"，不该把已有的条目一起吞掉（§257 逐发点名的口径）。
          键在 alert 盒子外面（§268），那句的 textContent 才是纯句子。 */}
      {itemsUnread && (
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice what={t('kb.roamTitle')} msg={ipcFailText(itemsUnread, t('common.unknownError'))} />
          <button
            data-testid="kb-ask-roam-retry"
            className="text-xs underline text-[var(--color-text-muted)]"
            onClick={() => refresh(keyword)}
          >
            {t('agent.retryRead')}
          </button>
        </div>
      )}
      {items.length === 0 && !itemsUnread ? (
        <p className="text-xs text-[var(--color-text-muted)] py-6 text-center">
          {keyword.trim() ? t('kb.roamSearchEmpty') : t('kb.roamEmpty')}
        </p>
      ) : (
        <div className="space-y-1">
          {items.map((s) => (
            <button
              key={s.id}
              onClick={() => onOpen(s.kbId, s.id)}
              className="w-full text-left px-3 py-2 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-xs text-[var(--color-text)]">
                  {s.title}
                </span>
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  {s.kbName || t('kb.roamKbDeleted')}
                </span>
              </div>
              <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                {fmtSessionTime(s.updatedAt)} · {t('kb.askMsgCount', { n: s.messageCount })}
                {s.model ? ` · ${s.model}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
