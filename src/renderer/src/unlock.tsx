// 解锁窗口入口（独立小窗口，不加载主 App.tsx）
import React from 'react'
import { createRoot } from 'react-dom/client'
import { UnlockPage } from './modules/unlock/UnlockPage'
import { I18nProvider, preloadInitialLang } from './i18n'
import './styles.css'

// 与主窗口同口径：非 zh 时先预载当前语言字典（上限 150ms）再挂载。
// 解锁窗在 ready-to-show 后立刻显示，少了这段预载，非中文用户每次冷启动都会先看到一帧中文。
async function boot(): Promise<void> {
  await preloadInitialLang()
  const root = document.getElementById('root')
  if (!root) return
  createRoot(root).render(
    <React.StrictMode>
      <I18nProvider>
        <UnlockPage />
      </I18nProvider>
    </React.StrictMode>
  )
}

void boot()
