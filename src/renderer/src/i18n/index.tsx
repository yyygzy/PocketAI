import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { zh } from './zh'
import { logIpcError } from '../utils/ipc'

export type Lang = 'zh' | 'en' | 'ja' | 'ko'

export const LANGS: { code: Lang; label: string; native: string }[] = [
  { code: 'zh', label: '中文', native: '中' },
  { code: 'en', label: 'English', native: 'EN' },
  { code: 'ja', label: '日本語', native: '日' },
  { code: 'ko', label: '한국어', native: '한' }
]

const STORAGE_KEY = 'pocketai.lang'

// 主包瘦身：zh（默认语言 + 兜底字典）常驻，其余语言动态 import 按需加载。
// 加载完成前 t() 回退 zh；本地 chunk 加载毫秒级，切换几乎无感。
type Dict = Record<string, string>
const dicts: Partial<Record<Lang, Dict>> = { zh }

const langLoaders: Record<Exclude<Lang, 'zh'>, () => Promise<Dict>> = {
  en: () => import('./en').then((m) => m.en),
  ja: () => import('./ja').then((m) => m.ja),
  ko: () => import('./ko').then((m) => m.ko)
}
const langPromises: Partial<Record<Exclude<Lang, 'zh'>, Promise<Dict>>> = {}
function ensureLang(lang: Exclude<Lang, 'zh'>): Promise<Dict> {
  langPromises[lang] ??= langLoaders[lang]().then((dict) => {
    dicts[lang] = dict
    return dict
  })
  return langPromises[lang]!
}

const HTML_LANG: Record<Lang, string> = { zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko' }

interface I18nValue {
  lang: Lang
  setLang: (lang: Lang) => void
  toggleLang: () => void
  /** 翻译，支持 {name} 插值 */
  t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nValue>({
  lang: 'zh',
  setLang: () => {},
  toggleLang: () => {},
  t: (key) => key
})

function readInitialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'zh' || v === 'en' || v === 'ja' || v === 'ko') return v
  } catch { /* ignore */ }
  // 浏览器语言检测：ja-JP/ko-KR 自动匹配，其余默认中文
  try {
    const nav = navigator.language.toLowerCase()
    if (nav.startsWith('ja')) return 'ja'
    if (nav.startsWith('ko')) return 'ko'
  } catch { /* ignore */ }
  return 'zh'
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(readInitialLang)
  // 懒加载字典到位后要有一次渲染，否则界面会停在 zh 兜底直到下一次无关重渲染
  const [dictVersion, setDictVersion] = useState(0)

  // 初始语言为非 zh 时按需补载对应字典（加载完成前 t() 回退 zh）
  useEffect(() => {
    if (lang === 'zh' || dicts[lang]) return
    let alive = true
    ensureLang(lang).then(() => {
      if (alive) setDictVersion((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    if (next !== 'zh' && !dicts[next]) void ensureLang(next)
    setLangState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
      document.documentElement.lang = HTML_LANG[next]
    } catch { /* ignore */ }
  }, [])

  const toggleLang = useCallback(() => {
    // 循环切换：zh → en → ja → ko → zh
    const order: Lang[] = ['zh', 'en', 'ja', 'ko']
    const idx = order.indexOf(lang)
    setLang(order[(idx + 1) % order.length]!)
  }, [lang, setLang])

  // 语言变化 → 通知主进程重建应用菜单（中/英文）
  useEffect(() => {
    // invoke 是异步拒绝，try/catch 捕获不到，必须 .catch 兜底：解锁窗/浮窗挂载可能早于主进程注册，
    // 那一句 reject 是设计内的（§224 之前整条吞掉）；除此以外说明菜单语言真没同步，留痕
    window.pocketai?.setAppLanguage?.(lang)?.catch?.((e: unknown) => {
      if (!/No handler registered/.test(String(e))) logIpcError('i18n.setAppLanguage', e)
    })
  }, [lang])

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    // 目标语言字典未加载完成时回退 zh（兜底链保证任何时刻都有可用文本）
    let str = dicts[lang]?.[key] ?? dicts.zh?.[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
    }
    return str
  }, [lang])

  const value = useMemo(
    () => ({ lang, setLang, toggleLang, t }),
    // dictVersion：字典迟到时换一次 context 身份，让所有 useI18n 的消费者重渲染
    [lang, setLang, toggleLang, t, dictVersion] // eslint-disable-line react-hooks/exhaustive-deps
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}
