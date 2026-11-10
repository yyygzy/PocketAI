// @vitest-environment jsdom
// 主题 KV 回填（A-3 收尾）
//
// 覆盖三条：KV 有值 → 不写；KV 无值 → 按当前生效主题写一次；读写失败 → 只记日志、不影响渲染。
// 主题真源仍是 localStorage，这里只验证「主进程镜像缺值时补一次」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { stubPocketai } from './helpers/renderer'
import { backfillThemeIfUnset } from '../src/renderer/src/theme-boot'

const setCalls: Array<'light' | 'dark'> = []

beforeEach(() => {
  setCalls.length = 0
  document.documentElement.classList.remove('light')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.classList.remove('light')
})

describe('backfillThemeIfUnset', () => {
  it('KV 无值 + 当前深色 → 写一次 dark', async () => {
    stubPocketai({
      getUiTheme: () => ({ ok: true, data: { theme: null } }),
      setUiTheme: (theme: 'light' | 'dark') => {
        setCalls.push(theme)
        return { ok: true, data: theme }
      }
    })
    await backfillThemeIfUnset()
    expect(setCalls).toEqual(['dark'])
  })

  it('KV 无值 + 首帧已恢复浅色 → 写一次 light', async () => {
    document.documentElement.classList.add('light')
    stubPocketai({
      getUiTheme: () => ({ ok: true, data: { theme: null } }),
      setUiTheme: (theme: 'light' | 'dark') => {
        setCalls.push(theme)
        return { ok: true, data: theme }
      }
    })
    await backfillThemeIfUnset()
    expect(setCalls).toEqual(['light'])
  })

  it('KV 有值 → 不写（不改变「有值以 KV 为准」的语义）', async () => {
    stubPocketai({
      getUiTheme: () => ({ ok: true, data: { theme: 'light' } }),
      setUiTheme: (theme: 'light' | 'dark') => {
        setCalls.push(theme)
        return { ok: true, data: theme }
      }
    })
    await backfillThemeIfUnset()
    expect(setCalls).toEqual([])
  })

  it('读 KV 失败 → 跳过回填，只记日志', async () => {
    stubPocketai({
      getUiTheme: () => ({ ok: false, error: 'Database not opened' }),
      setUiTheme: (theme: 'light' | 'dark') => {
        setCalls.push(theme)
        return { ok: true, data: theme }
      }
    })
    await expect(backfillThemeIfUnset()).resolves.toBeUndefined()
    expect(setCalls).toEqual([])
    expect(console.warn).toHaveBeenCalled()
  })

  it('写 KV 失败 / 通道抛错 → 不影响渲染，只记日志', async () => {
    stubPocketai({
      getUiTheme: () => ({ ok: true, data: { theme: null } }),
      setUiTheme: () => ({ ok: false, error: 'write failed' })
    })
    await expect(backfillThemeIfUnset()).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalled()

    stubPocketai({
      getUiTheme: () => Promise.reject(new Error('bridge boom'))
    })
    await expect(backfillThemeIfUnset()).resolves.toBeUndefined()
  })
})
