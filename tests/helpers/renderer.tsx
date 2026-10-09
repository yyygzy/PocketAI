// 渲染层用例共用底座：window.pocketai 桩 + i18n Provider + 自动卸载
//
// 桩的关键取向：**未预置的 IPC 一律当场抛错**，而不是回一个 resolve(undefined) 的
// Promise。组件调到我没 mock 的通道时，静默 undefined 会让用例"绿着"验证一段空行为；
// 抛错则立刻暴露（调用仍会被记录，报错信息里能看到是哪个通道）。
import { afterEach } from 'vitest'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from '../../src/renderer/src/i18n'
import { ToastProvider } from '../../src/renderer/src/components/ToastProvider'

type Impl = (...args: unknown[]) => unknown

const state = {
  impls: new Map<string, Impl>(),
  calls: [] as Array<{ fn: string; args: unknown[] }>
}

function buildStub(): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined
      // Promise 相关探测（await / .then）不该记成一次 IPC 调用
      if (prop === 'then' || prop === 'catch' || prop === '__esModule') return undefined
      return (...args: unknown[]) => {
        state.calls.push({ fn: prop, args })
        const impl = state.impls.get(prop)
        if (!impl) throw new Error(`未预置的 IPC 通道：window.pocketai.${prop}（用例里补上 mock，别让它静默返回 undefined）`)
        const out = impl(...args)
        // 真实 preload 走 ipcRenderer.invoke，永远返回 Promise；
        // 用例里常图省事写 `() => []`，而组件直接 .then() 就炸 ⇒ 这里统一包一层
        return out instanceof Promise ? out : Promise.resolve(out)
      }
    },
    has: () => true
  })
}

/** 安装 window.pocketai 桩；impls 里给了实现的通道按实现返回，其余通道被调用即抛错 */
export function stubPocketai(impls: Record<string, Impl> = {}): void {
  state.impls = new Map(Object.entries(impls))
  // i18n Provider 挂载时会同步调这个通道（真实代码里是可选链 + catch），默认给个空实现
  if (!state.impls.has('setAppLanguage')) state.impls.set('setAppLanguage', () => Promise.resolve())
  const g = globalThis as unknown as { window: { pocketai: unknown } }
  g.window.pocketai = buildStub()
}

/** 已发生的 IPC 调用（按顺序），用于断言「确认前不该有写操作」这类时序不变量 */
export function pocketaiCalls(): Array<{ fn: string; args: unknown[] }> {
  return state.calls
}

export function calledFns(): string[] {
  return state.calls.map((c) => c.fn)
}

/** 包上渲染层通用 Provider（i18n + Toast）后渲染；组件挂在 Modal/遮罩里也能查到 */
export function mountWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <ToastProvider>{ui}</ToastProvider>
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  state.calls = []
  state.impls = new Map()
})
