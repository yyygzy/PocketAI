import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { zh } from './zh'
import { logIpcError } from '../utils/ipc'
import { buildLocaleChunkUrl, importLocaleChunk, type LazyLang } from './chunk-loader'

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

// 每个语言记录已尝试次数：失败后递增，URL 随之变化，绕开浏览器 module map 对失败 URL 的缓存。
const langLoadAttempts: Record<LazyLang, number> = { en: 0, ja: 0, ko: 0 }
const langLoaders: Record<LazyLang, () => Promise<Dict>> = {
  en: () => importLocaleChunk(buildLocaleChunkUrl('en', langLoadAttempts.en++)).then((m) => m.en as Dict),
  ja: () => importLocaleChunk(buildLocaleChunkUrl('ja', langLoadAttempts.ja++)).then((m) => m.ja as Dict),
  ko: () => importLocaleChunk(buildLocaleChunkUrl('ko', langLoadAttempts.ko++)).then((m) => m.ko as Dict)
}
const langPromises: Partial<Record<LazyLang, Promise<Dict>>> = {}
function ensureLang(lang: LazyLang): Promise<Dict> {
  langPromises[lang] ??= langLoaders[lang]().then(
    (dict) => {
      dicts[lang] = dict
      return dict
    },
    (e: unknown) => {
      // 失败不能留在缓存里：清掉 promise 才能让下一次调用真正发起新 URL 的加载。
      delete langPromises[lang]
      throw e
    }
  )
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

/**
 * 首帧去闪：非 zh 时在首次 render 前预载当前语言字典（只预载这一份，不预热全部）。
 * 最多等 capMs：chunk 异常/过慢时先按 zh 兜底渲染，Provider 随后照旧补一次渲染——
 * 与改造前的最坏情况相同，不会把启动卡死。
 */
export function preloadInitialLang(capMs = 150): Promise<void> {
  const lang = readInitialLang()
  if (lang === 'zh') return Promise.resolve()
  const loaded = ensureLang(lang).then(() => undefined, () => undefined)
  return Promise.race([
    loaded,
    new Promise<void>((resolve) => setTimeout(resolve, capMs))
  ])
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(readInitialLang)
  // 懒加载字典到位后要有一次渲染，否则界面会停在 zh 兜底直到下一次无关重渲染
  const [dictVersion, setDictVersion] = useState(0)
  // setLang 是稳定引用，用 ref 读取当前语言，判断是否为「同语言重试」
  const langRef = useRef<Lang>(lang)
  langRef.current = lang

  // 初始语言为非 zh 时按需补载对应字典（加载完成前 t() 回退 zh）
  useEffect(() => {
    if (lang === 'zh' || dicts[lang]) return
    let alive = true
    ensureLang(lang).then(
      () => {
        if (alive) setDictVersion((n) => n + 1)
      },
      (e: unknown) => {
        // 失败可见但不打断使用：界面继续走 zh 兜底（完整可用），这里留一条可查日志；
        // 不弹 UI 提示——解锁窗/分体窗这一层没有 ToastProvider，为非阻断失败新开四语文案不划算，
        // 且用户再切一次语言就会触发新的 ensureLang 重试。
        if (alive) logIpcError('i18n.ensureLang', e)
      }
    )
    return () => {
      alive = false
    }
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    if (next !== 'zh' && !dicts[next]) {
      const pending = ensureLang(next)
      // 同语言重试时 lang 不变、effect 不会重跑：自己补一次渲染与日志，
      // 保证换 URL 后加载成功能立刻显示；同时绝不让拒绝逃逸成 unhandledrejection。
      if (next === langRef.current) {
        pending.then(
          () => setDictVersion((n) => n + 1),
          (e: unknown) => logIpcError('i18n.ensureLang', e)
        )
      }
    }
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
        // 第二参必须是函数：字符串第二参会展开替换模式，值里的 $&／$'／$`／$$／$1 会被当成
        // 「引用这份文案自己」——$' 把占位符右侧的整段文案搬进值位、$& 反吐占位符本身，
        // 而参数值多数取自库外（模型回文、文件名、用户起的名字）。四语文案都走这一发插值，
        // 所以同一个名字在四种语言上坏法一样（§361 实测）。
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v))
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
