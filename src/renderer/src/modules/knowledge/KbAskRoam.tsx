// KB 问答历史跨库漫游：全部知识库的问答会话统一入口（搜索 + 最近 200 条）
// 点击条目 → 切到所属库详情的问答 tab 并回放该会话（KnowledgeModule state 跳转）。
import { useEffect, useRef, useState } from 'react'
import type { KbAskRoamItem } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { fmtSessionTime } from './KbAskPanel'

const ROAM_LIMIT = 200

export const KbAskRoam: React.FC<{
  onOpen: (kbId: string, sessionId: string) => void
}> = ({ onOpen }) => {
  const { t } = useI18n()
  const [items, setItems] = useState<KbAskRoamItem[]>([])
  const [keyword, setKeyword] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = (kw: string) => {
    const k = kw.trim()
    const p = k
      ? window.pocketai.searchAllKbAskSessions(k, ROAM_LIMIT)
      : window.pocketai.listAllKbAskSessions(ROAM_LIMIT)
    p.then(setItems).catch(() => {}) // 漫游属增强能力，加载失败静默
  }

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
      {items.length === 0 ? (
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
