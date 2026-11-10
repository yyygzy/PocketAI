// theme-init.js 的首帧语言映射（A-3）：
// 这段脚本在 React 挂载前跑，只写 <html lang>（供首帧选对 CJK 字形）与浅色 class，不加载字典。
// 用 new Function 注入三个最小全局来跑真实文件，避免另写一份逻辑做「测了个寂寞」。
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const code = fs.readFileSync(path.resolve(__dirname, '../src/renderer/public/theme-init.js'), 'utf-8')

function run(opts: {
  storedLang?: string | null
  nav?: string
  storedTheme?: string | null
  onReport?: (theme: string) => void
}): {
  lang: string
  light: boolean
} {
  const classes: string[] = []
  const doc = {
    documentElement: {
      lang: 'zh-CN',
      classList: {
        add: (c: string) => classes.push(c)
      }
    }
  }
  const storage = {
    getItem: (k: string) =>
      k === 'pocketai.theme' ? (opts.storedTheme ?? null) : k === 'pocketai.lang' ? (opts.storedLang ?? null) : null
  }
  const nav = { language: opts.nav ?? 'zh-CN' }
  // 与真实环境同形：preload 在页面脚本前注入 window.pocketai；未传 onReport 时保持桥缺失态
  const win: Record<string, unknown> = opts.onReport
    ? {
        pocketai: {
          reportWindowTheme: (theme: string) => {
            opts.onReport!(theme)
            return Promise.resolve({ ok: true })
          }
        }
      }
    : {}
  new Function('localStorage', 'navigator', 'document', 'window', code)(storage, nav, doc, win)
  return { lang: doc.documentElement.lang, light: classes.includes('light') }
}

describe('theme-init.js — 首帧语言/主题', () => {
  it('存储语言 en/ja/ko 都写进 <html lang>（不再只处理 en）', () => {
    expect(run({ storedLang: 'en' }).lang).toBe('en')
    expect(run({ storedLang: 'ja' }).lang).toBe('ja')
    expect(run({ storedLang: 'ko' }).lang).toBe('ko')
  })

  it('中文/无存储保持 html 默认 zh-CN（不凭空改默认）', () => {
    expect(run({ storedLang: 'zh' }).lang).toBe('zh-CN')
    expect(run({}).lang).toBe('zh-CN')
  })

  it('无存储时按浏览器语言兜底（与 i18n readInitialLang 同口径）', () => {
    expect(run({ nav: 'ja-JP' }).lang).toBe('ja')
    expect(run({ nav: 'ko-KR' }).lang).toBe('ko')
    expect(run({ nav: 'fr-FR' }).lang).toBe('zh-CN')
  })

  it('存储值优先于浏览器语言；浅色 class 仍照旧生效', () => {
    const r = run({ storedLang: 'ko', nav: 'ja-JP', storedTheme: 'light' })
    expect(r.lang).toBe('ko')
    expect(r.light).toBe(true)
  })

  it('首帧主题上报：浅色报 light、缺省报 dark（只上报，不改 class 语义）', () => {
    const reports: string[] = []
    run({ storedTheme: 'light', onReport: (t) => reports.push(t) })
    run({ onReport: (t) => reports.push(t) })
    expect(reports).toEqual(['light', 'dark'])
  })

  it('桥缺失（window 无 pocketai）不抛错，主题仍照常还原', () => {
    expect(() => run({ storedTheme: 'light' })).not.toThrow()
    expect(run({ storedTheme: 'light' }).light).toBe(true)
  })
})
