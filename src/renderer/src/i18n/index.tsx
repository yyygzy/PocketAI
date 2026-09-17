import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { zh } from './zh'
import { en } from './en'

export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'pocketai.lang'

type Dict = Record<string, string>
const dicts: Record<Lang, Dict> = { zh, en }

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
    if (v === 'en' || v === 'zh') return v
  } catch { /* ignore */ }
  return 'zh'
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(readInitialLang)

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
      document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN'
    } catch { /* ignore */ }
  }, [])

  const toggleLang = useCallback(() => {
    setLang(lang === 'zh' ? 'en' : 'zh')
  }, [lang, setLang])

  // 语言变化 → 通知主进程重建应用菜单（中/英文）
  useEffect(() => {
    try {
      window.pocketai?.setAppLanguage?.(lang)
    } catch { /* 主进程未就绪时忽略 */ }
  }, [lang])

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    let str = dicts[lang][key] ?? dicts.zh[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
    }
    return str
  }, [lang])

  const value = useMemo(() => ({ lang, setLang, toggleLang, t }), [lang, setLang, toggleLang, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}
