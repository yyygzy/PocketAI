// 渲染层根错误边界（V4-Iter-146）
//
// 为什么要有这一层：本仓**没有任何**错误边界（grep ErrorBoundary / componentDidCatch / getDerivedStateFromError
// 在 renderer 里零命中），所以任何一个组件在 render 里抛错，React 18 都会把整棵 root 卸载 ⇒ **全站白屏**
// （`#root` innerHTML 变空），用户只会说"打不开"，而日志里什么都没有——这不是假设，V4-Iter-144 的
// 真 Electron 自测就是这么撞到的：一次"拉取模型失败"把界面抹平了。
//
// 三条刻意的做法：
//  · 挂在 I18nProvider **里面**（`main.tsx`），这样兜底文案还能走四语字典；代价是 i18n 自己崩了就兜不住，
//    这是已知取舍，写在台账里，不假装全覆盖。
//  · 兜底屏**直接显示 error.message 的首行**：白屏最贵的是"没人知道为什么"。没有新的 IPC 上报通道，
//    用户截图或复述这行字就能定位；同时 console.error 留完整堆栈。
//  · 只提供"重新加载"一个动作，不自动重试渲染：自动重试要清状态，那是另一套口径，容易把真问题藏起来。
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useI18n } from '../i18n'

interface State {
  /** null = 没有崩溃过；字符串（哪怕是空串）= 抓到了错误，要显示兜底屏 */
  message: string | null
}

/** 兜底屏自己也不许再抛（比如字典缺 key 时 t() 返回 key 本身，不会抛，但取 error 文本要防 undefined） */
function CrashScreen({ message }: { message: string }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <div className="text-sm font-semibold text-[var(--color-text)]">{t('crash.title')}</div>
        <div className="text-xs text-[var(--color-text-muted)] leading-relaxed">{t('crash.hint')}</div>
        {message && (
          <pre className="text-[10px] text-left p-2 rounded bg-[var(--color-bg-secondary)] border border-[var(--color-border)] overflow-auto max-h-24 whitespace-pre-wrap break-all">
            {message}
          </pre>
        )}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-xs px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]"
        >
          {t('crash.reload')}
        </button>
      </div>
    </div>
  )
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { message: null }

  static getDerivedStateFromError(err: unknown): State {
    const message = err instanceof Error ? String(err.message ?? '').split('\n')[0] ?? '' : String(err)
    return { message: message.slice(0, 300) }
  }

  override componentDidCatch(err: unknown, info: ErrorInfo): void {
    // 完整堆栈只进 DevTools：这一层没有可信的上报通道，写库反而会把"渲染崩溃"变成"写库崩溃"
    console.error('[renderer] 渲染崩溃', err, info.componentStack)
  }

  override render(): ReactNode {
    // 用 `!== null` 而不是真值判断：错误没有 message（`throw new Error()`）时也是崩溃，
    // 那时仍然要给兜底屏，只是那一段留空——否则就退回到"整屏白"这个本批要消灭的状态
    if (this.state.message !== null) return <CrashScreen message={this.state.message} />
    return this.props.children
  }
}
