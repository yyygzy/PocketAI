// 内置主题注册表（L1）
//
// 由二元 `light | dark` 扩成 id 集合后，**所有**「当前是哪个主题」的判断都必须查这张表——
// 主进程建窗底色、首帧脚本、KV 归一、mermaid 主题选择都从这里取。
// 反面：任何 `theme === 'light' ? A : B` 的写法都会把第三套预设悄悄当成深色（或浅色）。
//
// 兼容：`dark` / `light` 的 id 与历史存储值逐字相同，老用户的 localStorage 与 KV 无需迁移；
// 桌面壳换 id 时只要保留这两个 id，就不会出现"选择值失效 → 跳回默认"的跳变。
//
// 颜色不在本文件：每套色板是 `renderer/src/theme.css` 里的一段（`--color-*` / `--hljs-*`），
// 这里只声明"加哪个 class"与"窗口底色是什么"（BrowserWindow.backgroundColor 只能取纯色，
// 必须与该预设的 `--color-surface` 逐字一致，否则首帧会先看到一条异色的底）。

export const UI_THEME_IDS = ['dark', 'light', 'ocean', 'sand'] as const

export type UiTheme = (typeof UI_THEME_IDS)[number]

/** 缺省/脏值统一落这里：与改造前的默认深色一致（本次不动默认值） */
export const DEFAULT_UI_THEME: UiTheme = 'dark'

export interface UiThemePreset {
  readonly id: UiTheme
  /** 加在 `<html>` 上的 class；空串 = 基础态（:root 那套，即深色） */
  readonly className: string
  /** BrowserWindow.backgroundColor；必须等于 theme.css 该预设的 --color-surface */
  readonly windowBackground: string
  /** color-scheme：决定原生控件（select 弹层、滚动条）跟哪一侧 */
  readonly nativeColorScheme: 'light' | 'dark'
  /** mermaid 只认内置的 dark/default，映射到最接近的一套 */
  readonly mermaidTheme: 'default' | 'dark'
  /** 四语字典里的预设名 key（字面量，i18n 死键闸门据此判定"有人引用"） */
  readonly labelKey: string
}

export const UI_THEMES: Readonly<Record<UiTheme, UiThemePreset>> = {
  dark: {
    id: 'dark',
    className: '',
    windowBackground: '#1e1e2e',
    nativeColorScheme: 'dark',
    mermaidTheme: 'dark',
    labelKey: 'ui.theme.dark'
  },
  light: {
    id: 'light',
    className: 'light',
    windowBackground: '#eff1f5',
    nativeColorScheme: 'light',
    mermaidTheme: 'default',
    labelKey: 'ui.theme.light'
  },
  ocean: {
    id: 'ocean',
    className: 'ocean',
    windowBackground: '#0f2033',
    nativeColorScheme: 'dark',
    mermaidTheme: 'dark',
    labelKey: 'ui.theme.ocean'
  },
  sand: {
    id: 'sand',
    className: 'sand',
    windowBackground: '#faf7f0',
    nativeColorScheme: 'light',
    mermaidTheme: 'default',
    labelKey: 'ui.theme.sand'
  }
}

/** 已知 id 白名单判定：IPC / KV / localStorage 的脏值都必须先过这一关 */
export function isUiTheme(v: unknown): v is UiTheme {
  return typeof v === 'string' && (UI_THEME_IDS as readonly string[]).includes(v)
}

/** 非法/缺失回退默认（深色），与改造前 `normalizeUiTheme` 的可观测行为一致 */
export function normalizeUiTheme(v: unknown): UiTheme {
  return isUiTheme(v) ? v : DEFAULT_UI_THEME
}

export function themePreset(theme: unknown): UiThemePreset {
  return UI_THEMES[normalizeUiTheme(theme)]
}

/** 首帧脚本可直接使用的 class（空串 = 不需要加任何 class） */
export function themeClassName(theme: unknown): string {
  return themePreset(theme).className
}

export function themeWindowBackground(theme: unknown): string {
  return themePreset(theme).windowBackground
}

/**
 * 从 `<html class>` 反查主题 id：命中第一个已知 class 即返回，否则默认深色。
 * theme-init.js（纯 JS，不能 import）里有一份同样的映射，由 tests/theme-registry 钉住不许漂移。
 */
export function themeIdFromClasses(classes: { contains(c: string): boolean }): UiTheme {
  for (const id of UI_THEME_IDS) {
    const cls = UI_THEMES[id].className
    if (cls && classes.contains(cls)) return id
  }
  return DEFAULT_UI_THEME
}
