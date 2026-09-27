// Agent 面板全局键盘快捷键：Ctrl+N 新建 / Ctrl+K 搜索 / Ctrl+/ 聚焦输入框 / Esc 停止
import { useEffect, useRef } from 'react'
import { matchAgentShortcut } from '../agent-shared'

interface Args {
  running: boolean
  /** 搜索是否可用（与头部搜索按钮的 disabled 条件一致：有消息时） */
  searchEnabled: boolean
  onNew: () => void
  onSearch: () => void
  onAbort: () => void
}

/** 面板挂载期间监听 window keydown；动作通过 ref 取最新值，监听器只注册一次 */
export function useAgentShortcuts({ running, searchEnabled, onNew, onSearch, onAbort }: Args): void {
  const ref = useRef({ running, searchEnabled, onNew, onSearch, onAbort })
  ref.current = { running, searchEnabled, onNew, onSearch, onAbort }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const a = ref.current
      const action = matchAgentShortcut(e, { running: a.running, searchEnabled: a.searchEnabled })
      if (!action) return
      e.preventDefault()
      if (action === 'new') {
        a.onNew()
      } else if (action === 'search') {
        a.onSearch()
        // 搜索栏挂载后聚焦（首次打开有过渡帧；已打开则重新聚焦）
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('[data-agent-search-input]')?.focus()
        })
      } else if (action === 'focusComposer') {
        document.querySelector<HTMLTextAreaElement>('[data-agent-composer-input]')?.focus()
      } else {
        a.onAbort()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
