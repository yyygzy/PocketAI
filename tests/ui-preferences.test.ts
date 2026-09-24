// ui-preferences 界面偏好测试
//
// 覆盖 src/main/ui-preferences.ts 的：
// - clampOpacity：透明度限幅（非有限→1、限幅 MIN..MAX=0.6..1）
// - getUiPreferences：读取 opacity（非法→1）+ customCss（缺省→''）
// - setUiPreferences：opacity clamp 后持久化、customCss 截 200K
//
// 策略：clampOpacity 纯函数无依赖；get/setUiPreferences 用 vi.hoisted mock appConfigRepo(Map)。
// setUiPreferences 内部 applyOpacityToMainWindows 调用 BrowserWindow.getAllWindows，
// mock electron 使其返回空数组避免窗口操作。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  appConfigRepo: {
    get: (k: string) => mocks.store.get(k) ?? null,
    set: (k: string, v: string) => { mocks.store.set(k, v) },
    delete: (k: string) => { mocks.store.delete(k) }
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: mocks.appConfigRepo }))

import { clampOpacity, getUiPreferences, setUiPreferences, MIN_OPACITY, MAX_OPACITY, MAX_CSS_LENGTH } from '../src/main/ui-preferences'

beforeEach(() => {
  mocks.store.clear()
})

describe('clampOpacity — 透明度限幅', () => {
  it('正常范围内值原样返回', () => {
    expect(clampOpacity(0.8)).toBe(0.8)
    expect(clampOpacity(0.6)).toBe(0.6)
    expect(clampOpacity(1)).toBe(1)
  })

  it('低于下限 → 抬到 MIN', () => {
    expect(clampOpacity(0.3)).toBe(MIN_OPACITY)
    expect(clampOpacity(0)).toBe(MIN_OPACITY)
    expect(clampOpacity(-1)).toBe(MIN_OPACITY)
  })

  it('高于上限 → 压到 MAX', () => {
    expect(clampOpacity(1.5)).toBe(MAX_OPACITY)
    expect(clampOpacity(2)).toBe(MAX_OPACITY)
  })

  it('非有限值 → 1', () => {
    expect(clampOpacity(NaN)).toBe(1)
    expect(clampOpacity(Infinity)).toBe(1)
    expect(clampOpacity(-Infinity)).toBe(1)
  })

  it('边界值不截断', () => {
    expect(clampOpacity(MIN_OPACITY)).toBe(MIN_OPACITY)
    expect(clampOpacity(MAX_OPACITY)).toBe(MAX_OPACITY)
  })
})

describe('getUiPreferences — 读取偏好', () => {
  it('未配置 → opacity=1, customCss=""', () => {
    const p = getUiPreferences()
    expect(p.opacity).toBe(1)
    expect(p.customCss).toBe('')
  })

  it('已配置 opacity 且合法 → clamp 后返回', () => {
    mocks.store.set('ui.opacity', '0.7')
    expect(getUiPreferences().opacity).toBe(0.7)
  })

  it('opacity 超范围 → clamp', () => {
    mocks.store.set('ui.opacity', '2.0')
    expect(getUiPreferences().opacity).toBe(1)
  })

  it('opacity 非数字 → 回退 1', () => {
    mocks.store.set('ui.opacity', 'abc')
    expect(getUiPreferences().opacity).toBe(1)
  })

  it('opacity 为 0 或负数 → 回退 1（raw>0 判断）', () => {
    mocks.store.set('ui.opacity', '0')
    expect(getUiPreferences().opacity).toBe(1)
  })

  it('已配置 customCss → 原样返回', () => {
    mocks.store.set('ui.custom_css', 'body { color: red; }')
    expect(getUiPreferences().customCss).toBe('body { color: red; }')
  })
})

describe('setUiPreferences — 保存偏好', () => {
  it('设置 opacity → clamp 后持久化为字符串', () => {
    setUiPreferences({ opacity: 0.75 })
    expect(mocks.store.get('ui.opacity')).toBe('0.75')
  })

  it('opacity 超范围 → Zod 校验抛错（schema 边界）', () => {
    expect(() => setUiPreferences({ opacity: 5 })).toThrow()
    expect(mocks.store.has('ui.opacity')).toBe(false)
  })

  it('opacity 非有限 → Zod 校验抛错', () => {
    expect(() => setUiPreferences({ opacity: NaN })).toThrow()
  })

  it('设置 customCss → 持久化', () => {
    setUiPreferences({ customCss: 'a { color: blue; }' })
    expect(mocks.store.get('ui.custom_css')).toBe('a { color: blue; }')
  })

  it('customCss 超 MAX_CSS_LENGTH → 截断', () => {
    const longCss = 'x'.repeat(MAX_CSS_LENGTH + 100)
    setUiPreferences({ customCss: longCss })
    expect(mocks.store.get('ui.custom_css')).toHaveLength(MAX_CSS_LENGTH)
  })

  it('不传任何字段 → 不修改 store', () => {
    setUiPreferences({})
    expect(mocks.store.size).toBe(0)
  })

  it('返回最新偏好', () => {
    const result = setUiPreferences({ opacity: 0.7, customCss: 'x' })
    expect(result.opacity).toBe(0.7)
    expect(result.customCss).toBe('x')
  })
})
