// 侧栏底部：主题选择器 + 语言切换
// 主题状态直接操作 <html class> 并持久化 localStorage（theme-init.js 首帧还原）；
// 可选预设来自 shared/themes.ts 注册表——这里不再有"非浅即深"的取反判断。
import React, { useSyncExternalStore } from 'react'
import { useI18n, LANGS } from '../i18n'
import { hasIpcFailed, logIpcError, reportIpcError } from '../utils/ipc'
import {
  normalizeUiTheme,
  themeClassName,
  themeIdFromClasses,
  UI_THEME_IDS,
  UI_THEMES,
  type UiTheme
} from '../../../shared/themes'

const THEME_KEY = 'pocketai.theme'

// ─── 主题共享状态 ───────────────────────────────────────────────
// 侧栏与设置页各挂一份选择器，任何一处切换都要让另一处跟上（同一个 <html class>，
// 但两处各自 useState 会留下旧值）。用模块级订阅 + useSyncExternalStore 收敛成一份快照。
const listeners = new Set<() => void>()
let snapshot: UiTheme | null = null

function getSnapshot(): UiTheme {
  if (snapshot === null) snapshot = themeIdFromClasses(document.documentElement.classList)
  return snapshot
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function applyTheme(next: UiTheme): void {
  if (next === getSnapshot()) return
  snapshot = next
  const root = document.documentElement
  // 先摘掉所有已知预设 class（dark 是基础态、无 class），再挂目标那一套
  for (const id of UI_THEME_IDS) {
    const cls = UI_THEMES[id].className
    if (cls) root.classList.remove(cls)
  }
  const cls = themeClassName(next)
  if (cls) root.classList.add(cls)
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* ignore */
  }
  for (const cb of listeners) cb()
  // A-3：同步主进程（窗口底色立即跟着变 + 下次启动读回 KV）。
  // 失败不回滚界面主题：localStorage 仍是切换的事实来源，只是下次启动会退回上一次成功的底色。
  window.pocketai
    .setUiTheme(next)
    .then((r) => {
      if (hasIpcFailed(r)) logIpcError('ui.setTheme', r.error)
    })
    .catch(reportIpcError('ui.setTheme'))
}

/** 主题选择器：侧栏（compact）与设置页共用，切换后两个挂载点同步 */
export const ThemeSelect: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const { t } = useI18n()
  const theme = useSyncExternalStore(subscribe, getSnapshot)
  return (
    <select
      value={theme}
      onChange={(e) => applyTheme(normalizeUiTheme(e.target.value))}
      title={t('ui.themeHint')}
      aria-label={t('ui.theme')}
      className={
        compact
          ? 'h-6 w-12 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-0.5 text-[10px] text-[var(--color-text-muted)]'
          : 'h-7 rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1.5 text-xs text-[var(--color-text)]'
      }
    >
      {UI_THEME_IDS.map((id) => (
        <option key={id} value={id}>
          {t(UI_THEMES[id].labelKey)}
        </option>
      ))}
    </select>
  )
}

export const ThemeLangControls: React.FC<{ collapsed?: boolean }> = ({ collapsed }) => {
  const { lang, setLang, toggleLang, t } = useI18n()
  const currentNative = LANGS.find((l) => l.code === lang)?.native ?? '中'

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 py-2 border-t border-[var(--color-border)]">
        <ThemeSelect compact />
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
      <ThemeSelect />
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
