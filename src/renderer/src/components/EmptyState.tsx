// 统一空态组件：收口此前各模块散布的 text-muted text-center 纯文本提示。
// 支持图标 / 操作区，为空态升级提供统一结构。
import React from 'react'

interface EmptyStateProps {
  /** 空态提示文案 */
  message: string
  /** 可选 emoji 图标 */
  icon?: string
  /** 可选操作区（如「新建」按钮） */
  action?: React.ReactNode
  /** 容器类名：默认居中小字，调用方可传原 className 保持视觉一致 */
  className?: string
}

export const EmptyState: React.FC<EmptyStateProps> = ({ message, icon, action, className }) => (
  <div className={className ?? 'py-8 text-center text-xs text-[var(--color-text-muted)]'}>
    {icon && <div className="text-3xl mb-3 opacity-50">{icon}</div>}
    <p>{message}</p>
    {action && <div className="mt-4">{action}</div>}
  </div>
)
