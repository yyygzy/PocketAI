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
import type { AgentToolConfigs } from '../../src/renderer/src/modules/chat/useAgentToolConfigs'

/**
 * 桩的入参故意放宽成 `any[]`：每条真实通道有自己的入参类型，而 `(...args: unknown[]) => unknown`
 * 会因参数逆变把 `(patch: Record<string, unknown>) => …` 这类实现全判成不兼容（V4-Iter-178 现查出 32 处）。
 * **返回值仍锁 `unknown`**——桩返回什么，调用方必须自己判形状（`hasIpcFailed` 那族断言就靠这个）。
 */
type Impl = (...args: any[]) => unknown

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
        // 订阅类通道（如 onPythonEnvEvent）同步返回**卸载函数**，包装成 Promise 会让
        // React 把 Promise 当 cleanup 调用而报错 ⇒ 函数原样放行
        if (typeof out === 'function') return out
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
  // §436：订阅类通道（useStreamSession 挂载即订阅）默认给一个"空退订函数"——
  // 它是 mount 的固定副作用，不是用例要断言的业务调用；不给会被 buildStub 当成漏 mock 直接抛（§266）。
  if (!state.impls.has('onAgentStep')) state.impls.set('onAgentStep', () => () => {})
  if (!state.impls.has('onAgentChunk')) state.impls.set('onAgentChunk', () => () => {})
  if (!state.impls.has('onAgentDone')) state.impls.set('onAgentDone', () => () => {})
  if (!state.impls.has('onAgentError')) state.impls.set('onAgentError', () => () => {})
  // P0-4b：设置页挂载即读的第二份判定表（和 listDelegateCapabilities 一样是 mount 固定副作用）。
  // 默认空表：挂 ProviderSettings 的旧用例主体不是工具判定，不该因为多一读就全红；
  // 专门判这条读的用例必须自己覆盖这个键（覆盖后才验证得到失败面）。
  if (!state.impls.has('listToolCapabilities')) state.impls.set('listToolCapabilities', () => [])
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

/** 渲染层通用 Provider 组合（i18n + Toast）：组件挂载和 renderHook 的 wrapper 都用它 */
export function HookProviders({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <I18nProvider>
      <ToastProvider>{children}</ToastProvider>
    </I18nProvider>
  )
}

/** 包上渲染层通用 Provider（i18n + Toast）后渲染；组件挂在 Modal/遮罩里也能查到 */
export function mountWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<HookProviders>{ui}</HookProviders>)
}

/**
 * §399②b：输入框那颗「+」整份收着 `useAgentToolConfigs` 的返回值，凡挂 `AgentComposer` 的用例都要给一份。
 * 默认＝四发都读到、三个开关都关着（＝没有任何一句「读不到」，那颗徽标不转色）；
 * 要演坏消息的用例按 `over` 覆盖对应那一格。
 */
export function agentToolsStub(over: Partial<AgentToolConfigs> = {}): AgentToolConfigs {
  return {
    workspaceDir: '',
    shellConfig: { enabled: false, policy: 'confirm' },
    calConfig: { enabled: false, paths: [] },
    wsConfig: {
      enabled: false,
      provider: 'tavily',
      apiKey: '',
      hasKey: false,
      searxngBaseUrl: '',
      searxngAllowPrivate: false,
      depth: 'quick'
    },
    wsKeyDraft: '',
    wsUrlDraft: '',
    toolUnread: { workspace: null, shell: null, webSearch: null, calendar: null },
    setWsKeyDraft: () => { /* 那颗凭据框自己的行为由 §340 那族用例判 */ },
    setWsUrlDraft: () => { /* 同上：SearXNG 地址草稿 */ },
    pickWorkspace: async () => { /* 同上：拉起本机对话框那一发在 CI 里只能数被调次数 */ },
    retryWorkspace: () => { /* 同上 */ },
    patchShellConfig: async () => { /* 同上 */ },
    patchWsConfig: async () => { /* 同上 */ },
    secretDialog: null,
    patchCalConfig: async () => { /* 同上 */ },
    addIcs: async () => { /* 同上 */ },
    ...over
  }
}

afterEach(() => {
  cleanup()
  state.calls = []
  state.impls = new Map()
})
