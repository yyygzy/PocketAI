import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PopupApp } from './popup/PopupApp'
import { I18nProvider } from './i18n'
import './styles.css'

// 快捷浮窗与主窗口共用 index.html，用 hash 区分（#/popup），避免新增构建入口
const isPopup = window.location.hash.startsWith('#/popup')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>{isPopup ? <PopupApp /> : <App />}</I18nProvider>
  </React.StrictMode>
)
