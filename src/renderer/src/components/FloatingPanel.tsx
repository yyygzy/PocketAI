// 通用浮层（输入框「+」菜单的第一份原语）：fixed 定位 + 点外部关闭 + Esc 关闭。
//
// 为什么是 fixed 不是 absolute：Agent 面板的外壳链有 `overflow-hidden`，absolute 浮层会被裁切
// （同一条教训写在 `SnippetManager.tsx` 的前身文件头，那份弹层早就改用 fixed 了）。
// 为什么单独成一份：全仓此前没有 Popover/Dropdown/Menu 原语，三处手写先例各写各的；
// 本枚只把新长出来的「+」菜单挂在这份上，既有两处（SlashMenu／MentionMenu）不动，
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
  /** 嵌套层（第二份 FloatingPanel 装在第一份里面）带上这颗标记，外层的 Esc 就不越级关它 */
  'data-esc-nested'?: string
  /**
   * `'start'`（默认）＝左沿贴锚点、向上长；`'right'`＝摆在锚点**右侧**（嵌套的第二层用它）。
   * 为什么要有这一颗：第二层若还按默认那一形长，它会盖住父菜单上面那几行（真机量到＝外层 252 宽、
   * 内层 340 宽且同样向上长⇒上面四行整片看不见）。
   * 右侧放不下（外层本身就贴着窗口右边时，clamp 会把它拉回来自家父菜单上面＝白改）⇒**翻到左侧**；
   * 两边都放不下才退回那道 clamp（部分重叠＝窄窗口下便宜的兜底，不额外算父层矩形）。
   */
  align?: 'start' | 'right'
}

/** 左右都夹一道：别贴出视口（两支共用一份算法，别各写一遍 clamp） */
const clampLeft = (x: number, width: number): number =>
  Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE))

/** 右侧那一支：放得下就并排，放不下翻到左侧（真机量过：外层贴着窗口右边时"右侧"会被 clamp 拉回父菜单上面） */
const sideLeft = (right: number, left: number, width: number): number =>
  right + width + EDGE <= window.innerWidth ? right : clampLeft(left - GAP - width, width)

export const FloatingPanel: React.FC<Props> = ({
  anchorRef, width, onClose, children, align = 'start', ...rest
}) => {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: EDGE })

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({
      bottom: window.innerHeight - rect.top + GAP,
      left: align === 'right'
        ? clampLeft(sideLeft(rect.right + GAP, rect.left, width), width)
        : clampLeft(rect.left, width)
    })
  }, [anchorRef, width, align])

  // 依赖里不放 onClose 的调用方状态：菜单开着时每次重渲染都不该重挂一遍监听
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const tgt = e.target as Node
      if (panelRef.current?.contains(tgt) || anchorRef.current?.contains(tgt)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 有更内的一层先收它：Esc 落在嵌套层里时不越级把外层一起关掉（§399① 那条口径）。
      // §399②b：嵌套层自己也可以是一份 FloatingPanel ⇒ 判据从"落在带标记的子树里就一律不管"
      // 改成"落在**比我更内**的那一层里才不管"，否则两层都不收、Esc 在这层里变成哑键。
      const tgt = e.target as HTMLElement | null
      const nested = tgt?.closest?.('[data-esc-nested]')
      if (nested && nested !== panelRef.current) return
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
