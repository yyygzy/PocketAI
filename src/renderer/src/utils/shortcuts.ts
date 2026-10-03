// 应用内键盘快捷键：纯判定函数（渲染端单中枢 useGlobalShortcuts 使用，亦可单测）
// 注意：这是「应用内」快捷键（窗口聚焦时生效），与主进程 globalShortcut 唤起快捷浮窗无关。

export interface ShortcutKeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  target?: EventTarget | null
}

export type AppShortcutId =
  | 'tab' // 切换第 N 个标签（tabIndex 为 1-9）
  | 'closeTab'
  | 'openSettings'
  | 'lock'
  | 'newConv'
  | 'focusSearch'
  | 'focusComposer'
  | 'abort'
  | 'commandPalette' // 全局命令面板（仅主窗；filterShortcutForContext 默认屏蔽）

export interface AppShortcutMatch {
  id: AppShortcutId
  /** id === 'tab' 时：标签序号（1-9） */
  tabIndex?: number
}

/** 会话类动作（由中枢派发给当前活动的 chat / agent 实例） */
export type ConversationShortcutAction = Extract<
  AppShortcutId,
  'newConv' | 'focusSearch' | 'focusComposer' | 'abort'
>

/** 焦点是否在可编辑元素内（输入框 / 文本域 / 下拉 / 富文本）；鸭子类型，纯 node 亦可判定 */
export function isEditableTarget(el: EventTarget | null | undefined): boolean {
  if (!el || typeof el !== 'object') return false
  const node = el as { tagName?: unknown; isContentEditable?: unknown }
  if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true
  return node.isContentEditable === true
}

/**
 * 识别应用内快捷键：
 * - Ctrl/⌘+1~9 切标签；+W 关标签；+, 打开设置；+L 锁屏；+N 新建会话；+K 聚焦搜索；+/ 聚焦输入框
 * - Esc（无任何修饰键、焦点不在输入框、流式运行中）停止生成
 * 规则：Alt 组合一律不识别（避输入法/系统快捷键冲突）；Ctrl 与 Meta 等价（Win/Linux 与 Mac）。
 */
export function matchAppShortcut(e: ShortcutKeyLike, ctx: { running: boolean }): AppShortcutMatch | null {
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
  const key = e.key.toLowerCase()
  if (mod) {
    if (key >= '1' && key <= '9') return { id: 'tab', tabIndex: Number(key) }
    switch (key) {
      case 'w':
        return { id: 'closeTab' }
      case ',':
        return { id: 'openSettings' }
      case 'l':
        return { id: 'lock' }
      case 'n':
        return { id: 'newConv' }
      case 'k':
        return { id: 'focusSearch' }
      case 'p':
        return { id: 'commandPalette' }
      case '/':
        return { id: 'focusComposer' }
      default:
        return null
    }
  }
  // Esc 停止：无修饰、非编辑态焦点（编辑态的 Esc 留给输入框/弹层自身）、运行中
  if (
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    key === 'escape' &&
    ctx.running &&
    !isEditableTarget(e.target)
  ) {
    return { id: 'abort' }
  }
  return null
}

/** 当前平台主修饰键显示名（macOS 显示 ⌘，其余显示 Ctrl） */
export function modLabel(): string {
  const platform = typeof navigator !== 'undefined' ? navigator.platform ?? '' : ''
  return /mac/i.test(platform) ? '⌘' : 'Ctrl'
}

/** 非主窗口上下文：detached=独立窗（单模块无标签栏）、popup=快捷浮窗（简易问答） */
export type ShortcutContext = 'detached' | 'popup'

/**
 * 按窗口上下文裁剪快捷键动作（纯函数）：
 * - detached：放行会话类四动作 + lock；屏蔽 tab/closeTab（无标签栏）与 openSettings（单模块无模块切换）
 * - popup：仅放行 newConv（清空重开一轮问答）；其余由浮窗自身局部处理
 * 返回 null 表示该上下文不响应此动作。
 */
export function filterShortcutForContext(
  match: AppShortcutMatch,
  ctx: ShortcutContext
): AppShortcutMatch | null {
  if (ctx === 'popup') {
    return match.id === 'newConv' ? match : null
  }
  // detached
  switch (match.id) {
    case 'newConv':
    case 'focusSearch':
    case 'focusComposer':
    case 'abort':
    case 'lock':
      return match
    default:
      return null
  }
}
