// 通用浮层（输入框「+」菜单的第一份原语）：fixed 定位 + 点外部关闭 + Esc 关闭。
//
// 为什么是 fixed 不是 absolute：Agent 面板的外壳链有 `overflow-hidden`，absolute 浮层会被裁切
// （同一条教训写在 `SnippetButton.tsx` 文件头，那份弹层早就改用 fixed 了）。
// 为什么单独成一份：全仓此前没有 Popover/Dropdown/Menu 原语，三处手写先例各写各的；
// 本枚只把新长出来的「+」菜单挂在这份上，既有三处（SnippetButton／SlashMenu／MentionMenu）不动，
// 免得把"零行为变化"的一枚变成四处搬家。
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

const GAP = 4
const EDGE = 8

interface Props {
  /** 锚点（通常是那颗触发键）：坐标按它的矩形算，点它自己不算「点外部」 */
  anchorRef: React.RefObject<HTMLElement>
  width: number
  onClose: () => void
  children: React.ReactNode
  'data-testid'?: string
}

export const FloatingPanel: React.FC<Props> = ({ anchorRef, width, onClose, children, ...rest }) => {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: EDGE })

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({
      bottom: window.innerHeight - rect.top + GAP,
      left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE))
    })
  }, [anchorRef, width])

  // 依赖里不放 onClose 的调用方状态：菜单开着时每次重渲染都不该重挂一遍监听
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const tgt = e.target as Node
      if (panelRef.current?.contains(tgt) || anchorRef.current?.contains(tgt)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 嵌套那一层（片段自己的弹层）先收：Esc 落在它里面时不越级把整层菜单一起关掉
      const tgt = e.target as HTMLElement | null
      if (tgt?.closest?.('[data-esc-nested]')) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [anchorRef, onClose])

  return (
    <div
      ref={panelRef}
      role="menu"
      style={{ position: 'fixed', bottom: pos.bottom, left: pos.left, width }}
      className="z-[9999] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-2xl py-1"
      {...rest}
    >
      {children}
    </div>
  )
}
