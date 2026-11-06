import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PopupApp } from './popup/PopupApp'
import { DetachedApp } from './detached/DetachedApp'
import type { ModuleId } from './components/Sidebar'
import { DETACHABLE_MODULE_IDS } from '../../shared/types'
import type { SidebarModuleId } from '../../shared/types'
import { I18nProvider, useI18n } from './i18n'
import { ToastProvider } from './components/ToastProvider'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { loadAndInjectCustomCss } from './custom-css'
import { loadAndApplyChatFontSize } from './chat-font'
import { loadCodeCollapseLines } from './code-collapse'
import './styles.css'

// 快捷浮窗与主窗口共用 index.html，用 hash 区分（#/popup），避免新增构建入口
const isPopup = window.location.hash.startsWith('#/popup')

// 独立窗口（从侧栏右键弹出）：#/detached?module=xxx，同样共用 index.html 入口
let detachedModule: ModuleId | null = null
if (window.location.hash.startsWith('#/detached')) {
  const m = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('module')
  if (m && DETACHABLE_MODULE_IDS.includes(m as SidebarModuleId)) detachedModule = m as ModuleId
}
const isDetached = detachedModule !== null

// 安全桥（preload → contextBridge）整块没注入时，任何 `window.pocketai.*` 都是一发
// "Cannot read properties of undefined"；交给根错误边界只会得到一行难以归因的 TypeError。
// 在挂载前先认这一种环境异常，给一屏说得清"是这个窗口没加载到 preload"的提示。
const bridgeMissing = typeof window.pocketai === 'undefined'

function BridgeMissingScreen(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <div className="text-sm font-semibold text-[var(--color-text)]">{t('bridge.missing.title')}</div>
        <div className="text-xs text-[var(--color-text-muted)] leading-relaxed">{t('bridge.missing.hint')}</div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-xs px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]"
        >
          {t('bridge.missing.reload')}
        </button>
      </div>
    </div>
  )
}

// 标签页系统已下线（V4-Iter-112：标签从不携带实例状态，导航只剩侧栏），
// 清掉它遗留在 localStorage 的布局键，不给后续版本留孤儿数据
localStorage.removeItem('pocketai.tabs.v1')

// 先注入用户自定义 CSS / 应用聊天字号档位，再渲染（异步，可能有极短暂闪烁）
loadAndInjectCustomCss()
loadAndApplyChatFontSize()
loadCodeCollapseLines()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      {/* 根错误边界（V4-Iter-146）：本仓此前没有任何边界，任何一个组件 render 抛错都会让
          React 把整棵 root 卸载 ⇒ 全站白屏（144 的自测就这么撞到过一次）。
          刻意放在 I18nProvider **里面**：兜底屏的文案要走四语字典。代价是 i18n 自身崩了兜不住，
          这条取舍写进台账，不假装全覆盖。 */}
      <AppErrorBoundary>
        {bridgeMissing ? (
          <BridgeMissingScreen />
        ) : isPopup ? (
          <ToastProvider>
            <PopupApp />
          </ToastProvider>
        ) : isDetached ? (
          <DetachedApp moduleId={detachedModule!} />
        ) : (
          <App />
        )}
      </AppErrorBoundary>
    </I18nProvider>
  </React.StrictMode>
)
