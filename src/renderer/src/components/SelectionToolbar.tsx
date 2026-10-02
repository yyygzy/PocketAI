// 应用内划词浮条（选区助手入口）：主窗口选中正文文本后在选区旁浮出动作条，
// 点击动作携带文本唤起浮窗单例并自动执行。输入框/可编辑区内划词不弹（属编辑行为）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { reportIpcError } from '../utils/ipc'
import type { SelectionAction } from '../../../shared/types'
import {
  SELECTION_ACTIONS,
  isEditableSelectionHost,
  normalizeSelectionText
} from '../utils/selection-actions'

interface BarState {
  text: string
  /** 选区视口矩形（用于贴近定位） */
  rect: { top: number; bottom: number; left: number; right: number; width: number }
}

interface Pos {
  left: number
  top: number
}

const MARGIN = 6 // 浮条与选区的间距
const EDGE = 8 // 距视口边缘的最小距离

/**
 * 从当前文档选区读取浮条状态；不满足条件（无选区/输入区/空白）返回 null。
 */
function readSelection(e: Event): BarState | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null

  // 事件目标在浮条自身内（如点击按钮引发的 selectionchange）不处理
  const target = e.target instanceof Node ? e.target : null
  const range = sel.getRangeAt(0)
  const host = (target && target.nodeType === Node.ELEMENT_NODE
    ? (target as Element)
    : range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement)
  const text = normalizeSelectionText(sel.toString())
  if (!text) return null
  const r = range.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  if (isEditableSelectionHost(host)) return null
  return {
    text,
    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }
  }
}

export const SelectionToolbar: React.FC = () => {
  const { t } = useI18n()
  const [bar, setBar] = useState<BarState | null>(null)
  const [pos, setPos] = useState<Pos | null>(null)
  const [enabled, setEnabled] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  // 开关：挂载拉一次，窗口重新聚焦时刷新（设置页改开关回来即生效）
  const refreshEnabled = useCallback(() => {
    window.pocketai
      .getPopupConfig()
      .then((cfg) => setEnabled(cfg.selectionEnabled))
      .catch(() => setEnabled(false))
  }, [])
  useEffect(() => {
    refreshEnabled()
    window.addEventListener('focus', refreshEnabled)
    return () => window.removeEventListener('focus', refreshEnabled)
  }, [refreshEnabled])

  const hide = useCallback(() => {
    setBar(null)
    setPos(null)
  }, [])

  // 选区变化后延迟一帧读取（mouseup/keyup 时浏览器尚未最终化选区的兜底）
  const scheduleUpdate = useCallback(
    (e: Event) => {
      if (!enabled) return
      setTimeout(() => {
        const next = readSelection(e)
        setBar(next)
        if (!next) setPos(null)
      }, 0)
    },
    [enabled]
  )

  useEffect(() => {
    if (!enabled) {
      hide()
      return
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return
      scheduleUpdate(e)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      // 键盘选区（Shift+方向键 / Shift+Home 等）松开后浮出
      if (e.key === 'Shift') scheduleUpdate(e)
    }
    const onMouseDown = (e: MouseEvent) => {
      // 点浮条外区域立即隐藏；浮条内 mousedown 由按钮自己 preventDefault
      if (barRef.current && e.target instanceof Node && barRef.current.contains(e.target)) return
      hide()
    }
    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) hide()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onScroll = () => hide() // 滚动即藏，避免浮条与选区错位
    const onBlur = () => hide()

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [enabled, scheduleUpdate, hide])

  // 浮条渲染后按实际尺寸夹取定位（优先选区上方，空间不足翻下方）
  useLayoutEffect(() => {
    if (!bar || !barRef.current) return
    const el = barRef.current
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const centerX = bar.rect.left + bar.rect.width / 2
    const left = Math.max(EDGE, Math.min(centerX - w / 2, vw - w - EDGE))
    const spaceAbove = bar.rect.top
    const top =
      spaceAbove >= h + MARGIN + EDGE
        ? bar.rect.top - h - MARGIN
        : Math.min(bar.rect.bottom + MARGIN, vh - h - EDGE)
    setPos({ left: Math.round(left), top: Math.round(top) })
  }, [bar])

  const runAction = (action: SelectionAction) => {
    if (!bar) return
    window.pocketai
      .openSelectionPopup(bar.text, action)
      .catch(reportIpcError('selection.openPopup'))
    hide()
  }

  if (!bar || !pos) return null

  return (
    <div
      ref={barRef}
      className="fixed z-[9000] flex items-center gap-0.5 rounded-lg border border-[var(--color-border)] px-1 py-0.5 select-none"
      style={{
        left: pos.left,
        top: pos.top,
        background: 'var(--color-surface)',
        boxShadow: '0 6px 20px rgba(0,0,0,.22)'
      }}
      // 阻止 mousedown 失焦导致选区被清空、点击落空
      onMouseDown={(e) => e.preventDefault()}
    >
      {SELECTION_ACTIONS.map((a) => (
        <button
          key={a}
          className="btn-ghost !px-2 !py-1 text-xs whitespace-nowrap"
          onClick={() => runAction(a)}
          title={t(`popup.act.${a}`)}
        >
          {t(`popup.act.${a}`)}
        </button>
      ))}
    </div>
  )
}
