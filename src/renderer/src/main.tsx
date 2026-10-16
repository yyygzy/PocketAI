import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PopupApp } from './popup/PopupApp'
import { DetachedApp } from './detached/DetachedApp'
import type { ModuleId } from './components/Sidebar'
import { DETACHABLE_MODULE_IDS } from '../../shared/types'
import type { SidebarModuleId } from '../../shared/types'
import { I18nProvider } from './i18n'
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
        {isPopup ? (
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
