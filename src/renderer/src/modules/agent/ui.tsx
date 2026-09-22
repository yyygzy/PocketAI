// Agent 模块共享的小型展示组件
import React from 'react'

export const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children
}) => (
  <button
    onClick={onClick}
    className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
      active
        ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
        : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
    }`}
  >
    {children}
  </button>
)

export const StatusDot: React.FC<{ status: string }> = ({ status }) => {
  const color =
    status === 'running' ? 'bg-[var(--color-success)]' :
    status === 'starting' ? 'bg-[var(--color-warning)]' :
    status === 'error' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-text-muted)]'
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={status} />
}

export const MiniBtn: React.FC<{
  onClick?: () => void
  children: React.ReactNode
  danger?: boolean
  disabled?: boolean
  title?: string
}> = ({ onClick, children, danger, disabled, title }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`text-[10px] px-1.5 py-0.5 rounded border disabled:opacity-40 disabled:cursor-not-allowed ${
      danger
        ? 'border-[var(--color-danger-bg)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
    }`}
  >
    {children}
  </button>
)
