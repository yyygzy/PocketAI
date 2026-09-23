// 侧栏底部：明暗主题切换 + 语言切换
// 主题状态直接操作 <html class="light"> 并持久化 localStorage（index.html 内联脚本防闪烁）
import React, { useState } from 'react'
import { useI18n, LANGS } from '../i18n'

const THEME_KEY = 'pocketai.theme'

export const ThemeLangControls: React.FC<{ collapsed?: boolean }> = ({ collapsed }) => {
  const { lang, setLang, toggleLang, t } = useI18n()
  const [light, setLight] = useState(() => document.documentElement.classList.contains('light'))
  const currentNative = LANGS.find((l) => l.code === lang)?.native ?? '中'

  const toggleTheme = () => {
    const next = !light
    setLight(next)
    document.documentElement.classList.toggle('light', next)
    try {
      localStorage.setItem(THEME_KEY, next ? 'light' : 'dark')
    } catch {
      /* ignore */
    }
  }

  const iconBtnCls =
    'h-7 w-7 shrink-0 rounded flex items-center justify-center text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors'

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 py-2 border-t border-[var(--color-border)]">
        <button onClick={toggleTheme} className={iconBtnCls} title={t('controls.toggleTheme')} aria-label={t('controls.toggleTheme')}>
          {light ? '🌙' : '☀️'}
        </button>
        <button
          onClick={toggleLang}
          className="h-6 px-1 rounded text-[10px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors"
          title={t('controls.toggleLang')}
        >
          {currentNative}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-2 border-t border-[var(--color-border)]">
      <button onClick={toggleTheme} className={iconBtnCls} title={t('controls.toggleTheme')}>
        {light ? '🌙' : '☀️'}
      </button>
      <div className="ml-auto flex items-center rounded border border-[var(--color-border)] overflow-hidden text-[10px] font-semibold">
        {LANGS.map((l) => (
          <button
            key={l.code}
            onClick={() => setLang(l.code)}
            title={l.label}
            className={`px-1.5 h-6 transition-colors ${
              lang === l.code
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]'
            }`}
          >
            {l.native}
          </button>
        ))}
      </div>
    </div>
  )
}
