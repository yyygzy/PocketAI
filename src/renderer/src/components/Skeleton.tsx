// 首屏骨架：只有形状，不带任何文案（不新增 i18n key）。
// 延迟 120ms 才出现：快机器上数据先到就直接渲染，避免骨架闪一下又消失。
import { useEffect, useState } from 'react'

const SKELETON_DELAY_MS = 120
const BAR = 'rounded bg-[var(--color-hover-overlay)] animate-pulse motion-reduce:animate-none'

function useDelayedShow(delay = SKELETON_DELAY_MS): boolean {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), delay)
    return () => clearTimeout(timer)
  }, [delay])
  return show
}

/** 侧栏会话列表骨架：行高与真实行一致（px-2.5 + py-2 + 20px 文本行） */
export function SidebarSkeleton({ rows = 7 }: { rows?: number }) {
  if (!useDelayedShow()) return null
  return (
    <div aria-hidden="true" data-testid="conversation-skeleton" className="px-2.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2 py-2">
          <div className={`h-5 flex-1 ${BAR}`} />
        </div>
      ))}
    </div>
  )
}

/** 消息区骨架：左右交替的气泡形状，只在切换会话且列表尚未就绪时出现 */
export function MessagesSkeleton() {
  if (!useDelayedShow()) return null
  const widths = [70, 52, 82, 46]
  return (
    <div aria-hidden="true" data-testid="messages-skeleton" className="space-y-4 py-2">
      {widths.map((w, i) => (
        <div key={i} className={`flex ${i % 2 === 1 ? 'justify-end' : 'justify-start'}`}>
          <div className={`h-16 ${BAR}`} style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  )
}
