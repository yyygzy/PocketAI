// pip 下载源的换源确认（B12 / SEC-20）
//
// 口径先对齐代码与审计台账：SEC-20 写的是「UI **切换自定义源**前二次确认」，
// `usePipSource.choosePipSource` 对 official/tuna 是**直接写入、不弹确认**的。
// 清单 B12 原先记成"改成清华镜像要弹确认并列出 URL"——那是清单写错，不是代码缺功能；
// 这里把真实行为钉住（预设源不该被弹窗骚扰、自定义源必须弹且带 URL），并顺手改正清单。
//
// 测 hook 而不是整个 McpPanel：确认逻辑、URL 插值、"取消就不写库"这三件事都在
// `usePipSource` 里，而 McpPanel 挂载要拉起 server 列表/运行时/模板等一堆无关桩。
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import React from 'react'
import { stubPocketai, pocketaiCalls } from './helpers/renderer'
import { I18nProvider } from '../src/renderer/src/i18n'
import { zh } from '../src/renderer/src/i18n/zh'
import { usePipSource } from '../src/renderer/src/modules/agent/mcp/usePipSource'
import type { ConfirmOptions } from '../src/renderer/src/components/ConfirmDialog'

interface SetupOpts {
  initial?: string
  confirmResult?: boolean
  saveResult?: { ok: boolean; source?: string; error?: string }
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <I18nProvider>{children}</I18nProvider>
)

function setup(opts: SetupOpts = {}) {
  const notified: string[] = []
  const confirmed: ConfirmOptions[] = []
  const confirm = async (o: ConfirmOptions) => {
    confirmed.push(o)
    return opts.confirmResult ?? true
  }
  stubPocketai({
    getPythonPipSource: () => ({ ok: true, source: opts.initial ?? 'official' }),
    setPythonPipSource: (v: unknown) => opts.saveResult ?? { ok: true, source: String(v) }
  })
  const { result } = renderHook(() => usePipSource((m) => notified.push(m), confirm), { wrapper })
  return { result, notified, confirmed }
}

function setCalls(): unknown[] {
  return pocketaiCalls()
    .filter((c) => c.fn === 'setPythonPipSource')
    .map((c) => c.args[0])
}

beforeEach(() => {
  localStorage.clear()
  pocketaiCalls()
})

describe('usePipSource 换源确认', () => {
  it('挂载时读回已存的自定义源：展开输入框并填好原值', async () => {
    const { result } = setup({ initial: 'https://mirrors.example.local/pypi' })
    await waitFor(() => expect(result.current.pipCustomOpen).toBe(true))
    expect(result.current.pipCustomUrl).toBe('https://mirrors.example.local/pypi')
  })

  it('切到预设源（清华）：直接写入，不弹确认', async () => {
    const { result, confirmed } = setup()
    await act(async () => {
      await result.current.choosePipSource('tuna')
    })
    expect(confirmed).toHaveLength(0)
    expect(setCalls()).toEqual(['tuna'])
  })

  it('保存自定义 https 源：弹危险确认，且文案里列出目标 URL；确认后才写库', async () => {
    const url = 'https://mirrors.tuna.tsinghua.edu.cn/pypi'
    const { result, confirmed } = setup()
    await act(async () => {
      result.current.setPipCustomUrl(url)
    })
    await act(async () => {
      await result.current.saveCustomPipSource()
    })
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]?.danger).toBe(true)
    expect(confirmed[0]?.message).toContain(url)
    // 文案确实来自字典（不是拼一半的英文/裸 key）
    expect(confirmed[0]?.message).toBe(zh['agent.pipSourceConfirm']!.replace('{url}', url))
    expect(setCalls()).toEqual([url])
  })

  it('用户点取消：一次都不写库（换 wheel 来源必须是显式动作）', async () => {
    const { result, confirmed } = setup({ confirmResult: false })
    await act(async () => {
      result.current.setPipCustomUrl('https://pypi.example')
    })
    await act(async () => {
      await result.current.saveCustomPipSource()
    })
    expect(confirmed).toHaveLength(1)
    expect(setCalls()).toEqual([])
  })

  it('非回环 http 源：就地报错、不弹确认、不写库（与主进程同一把尺）', async () => {
    const { result, confirmed, notified } = setup()
    await act(async () => {
      result.current.setPipCustomUrl('http://10.0.0.7/pypi')
    })
    await act(async () => {
      await result.current.saveCustomPipSource()
    })
    expect(result.current.pipCustomError).toBe(zh['agent.f.pipCustomInvalid'])
    expect(confirmed).toHaveLength(0)
    expect(setCalls()).toEqual([])
    expect(notified).toEqual([])
  })

  it('本机回环 http 允许（内网 Ollama 式镜像），仍走确认', async () => {
    const { result, confirmed } = setup()
    await act(async () => {
      result.current.setPipCustomUrl('http://127.0.0.1:3141/simple')
    })
    await act(async () => {
      await result.current.saveCustomPipSource()
    })
    expect(confirmed).toHaveLength(1)
    expect(setCalls()).toEqual(['http://127.0.0.1:3141/simple'])
  })

  it('主进程拒绝（返回结构化 error）时错误显示在输入框下方，而不是静默', async () => {
    const { result } = setup({ saveResult: { ok: false, error: 'pip 源保存失败：不在允许范围' } })
    await act(async () => {
      result.current.setPipCustomUrl('https://pypi.example')
    })
    await act(async () => {
      await result.current.saveCustomPipSource()
    })
    expect(result.current.pipCustomError).toBe('pip 源保存失败：不在允许范围')
  })
})
