// 解锁窗口入口（独立小窗口，不加载主 App.tsx）
import React from 'react'
import { createRoot } from 'react-dom/client'
import { UnlockPage } from './modules/unlock/UnlockPage'
import { I18nProvider } from './i18n'
import './styles.css'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <I18nProvider>
        <UnlockPage />
      </I18nProvider>
    </React.StrictMode>
  )
}
