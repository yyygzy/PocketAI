import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PopupApp } from './popup/PopupApp'
import { DetachedApp } from './detached/DetachedApp'
import type { ModuleId } from './components/Sidebar'
import { I18nProvider } from './i18n'
import { loadAndInjectCustomCss } from './custom-css'
import './styles.css'

// 快捷浮窗与主窗口共用 index.html，用 hash 区分（#/popup），避免新增构建入口
const isPopup = window.location.hash.startsWith('#/popup')

// 独立窗口（标签弹出）：#/detached?module=xxx，同样共用 index.html 入口
const DETACHED_MODULE_IDS: readonly string[] = [
  'chat', 'agent', 'skills', 'knowledge', 'files', 'notes', 'translate', 'image', 'sandbox'
]
let detachedModule: ModuleId | null = null
if (window.location.hash.startsWith('#/detached')) {
  const m = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('module')
  if (m && DETACHED_MODULE_IDS.includes(m)) detachedModule = m as ModuleId
}
const isDetached = detachedModule !== null

// 先注入用户自定义 CSS，再渲染（异步，可能有极短暂闪烁）
loadAndInjectCustomCss()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      {isPopup ? <PopupApp /> : isDetached ? <DetachedApp moduleId={detachedModule!} /> : <App />}
    </I18nProvider>
  </React.StrictMode>
)
