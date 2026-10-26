// V4-Iter-318：知识库问答「发起」那一发不判信封 ＋ 历史全量发过入参上限
//
// 缺陷两面（同一颗按钮）：
// ① `safeHandle` 把入参校验失败与抛出都转成**已 resolve** 的 `{ ok:false, error }`
//    （`src/main/ipc/safe-handle.ts:173`、:179-181），而 preload 把这条通道的返回类型写成
//    `Promise<{ requestId; sources }>`——把失败形状从类型里抹掉了 ⇒ 消费侧
//    `const { requestId } = await kbAsk(...)` 解构出 undefined：编译器不响、五面静默闸门看不见，
//    运行期转圈不消失、「停止」那颗按下去空转（`if (requestRef.current)` 为假），而提问已经落库。
// ② 入参 schema 卡 50 条、主进程拼消息时只取最近 10 条（两个数），于是载入一条超过 10 条历史的
//    旧会话之后每一句都被挡在门外——多出来的那些主进程反正也用不上。§318 把这个上限收成
//    shared/types 的一份出处，渲染层发之前按它裁。
// 同文件其余七发（:107 :145 :170 :192 :252 :416 …）都判了信封，只有发起这一发漏了——
// 所以判据选"屏上此刻是哪颗按钮"：失败必须退回「发送」，成功才许出现「停止」。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KbAskMessage, KnowledgeBase, ProviderRecord } from '../src/shared/types'
import { KB_ASK_MAX_HISTORY } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const SEND = L('kb.askSend')
const STOP = L('kb.askStop')

const PROVIDER: ProviderRecord = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
}
const KB = { id: 'kb1', name: 'PROBE-KB', embeddingModel: 'e', topK: 5, topN: 5 } as unknown as KnowledgeBase

/** 发起与中止的现场：桩把收到的东西留给断言，不去读组件内部状态 */
const seen = { askArgs: [] as Array<{ history: KbAskMessage[]; question: string }>, aborts: [] as string[] }

function stubs(over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> {
  seen.askArgs = []
  seen.aborts = []
  return {
    listProviders: () => [PROVIDER],
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    listKbAskSessions: () => [],
    searchKbAskSessions: () => [],
    saveKbAskSession: () => ({ ok: true }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    kbAsk: (args: { history: KbAskMessage[]; question: string }) => {
      seen.askArgs.push(args)
      return { requestId: 'r-1', sources: [] }
    },
    kbAskAbort: (id: string) => {
      seen.aborts.push(id)
      return { ok: true }
    },
    ...over
  }
}

/** 等到服务商与模型挑完（否则 send 走「还没选模型」那颗早退），再打字、再点「发送」 */
async function send(q: string): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('button', { name: SEND })).toBeTruthy(), MOUNT_BUDGET)
  fireEvent.change(screen.getByPlaceholderText(L('kb.askPlaceholder')), { target: { value: q } })
  fireEvent.click(screen.getByRole('button', { name: SEND }))
}

describe('KbAskPanel — 发起那一发要判信封（§318）', () => {
  it('入参被挡（回码形状）⇒ 转圈退回「发送」、四语说清哪一项过长、且不假装发起成功', async () => {
    // 主进程 argFail 的真实形状：ipcCode ＋ ipcArgs=path=code=origin=bound
    stubPocketai(
      stubs({
        kbAsk: (args: { question: string }) => {
          seen.askArgs.push(args as never)
          return {
            ok: false,
            error: '提问过长，最多 100000 个字符',
            ipcCode: 'IPC_ARG_INVALID',
            ipcArgs: 'question=too_big|string=100000'
          }
        }
      })
    )
    mountWithProviders(<KbAskPanel kb={KB} />)
    await send('PROBE-超长提问')
    // 失败必须把 pending 收回去：屏上重新出现「发送」，而不是永远挂在「停止」上
    await waitFor(() => expect(screen.queryByRole('button', { name: SEND })).toBeTruthy(), MOUNT_BUDGET)
    expect(screen.queryByRole('button', { name: STOP }), '失败之后不该还挂着「停止」').toBeNull()
    const sentence = L('ipc.argTooBigChar').replace('{field}', L('ipc.field.question')).replace('{n}', '100000')
    expect(bodyText(), '界面说四语，而不是把主进程那句中文原样贴出来').toContain(sentence)
    expect(seen.aborts, '没发起成功就没有句柄可中止，那颗按钮不许空转').toEqual([])
    expect(seen.askArgs).toHaveLength(1)
  })

  it('正向对照：成功回执照常挂上「停止」，点它确实把 requestId 交出去（守卫没挡住正常发起）', async () => {
    stubPocketai(stubs())
    mountWithProviders(<KbAskPanel kb={KB} />)
    await send('PROBE-正常提问')
    await waitFor(() => expect(screen.queryByRole('button', { name: STOP })).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(screen.getByRole('button', { name: STOP }))
    await waitFor(() => expect(seen.aborts).toEqual(['r-1']), MOUNT_BUDGET)
  })

  it('载入 12 条的旧会话再追问 ⇒ 送出去的 history 恰为最近 10 条（上限一份出处）', async () => {
    const msgs: KbAskMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `M${i}`
    }))
    stubPocketai(
      stubs({
        getKbAskSession: () => ({ id: 's1', kbId: 'kb1', createdAt: 1, messages: msgs })
      })
    )
    mountWithProviders(<KbAskPanel kb={KB} openSessionId="s1" onSessionOpened={() => {}} />)
    // 等历史真回放完（第 12 条在屏上）——否则发问时 msgsRef 还是空的
    await waitFor(() => expect(bodyText()).toContain('M11'), MOUNT_BUDGET)
    await send('PROBE-追问')
    await waitFor(() => expect(seen.askArgs).toHaveLength(1), MOUNT_BUDGET)
    const sent = seen.askArgs[0]!.history
    expect(sent.length, `上限就是那一个数（KB_ASK_MAX_HISTORY=${KB_ASK_MAX_HISTORY}）`).toBe(KB_ASK_MAX_HISTORY)
    expect(sent.map((m) => m.content), '裁的是最早的，留最近十条').toEqual(
      Array.from({ length: KB_ASK_MAX_HISTORY }, (_, i) => `M${12 - KB_ASK_MAX_HISTORY + i}`)
    )
    expect(seen.askArgs[0]!.question).toBe('PROBE-追问')
  })
})

/**
 * 两面源码钉：
 *  · 上限写两处迟早和实现不一致 ⇒ 钉住"schema 与主进程裁剪都引用同一个导出"，两侧都不许再写死数字；
 *  · 类型撒谎时那五面闸门看不见这根通道 ⇒ 钉住三条发起类声明都带失败形状（漏杀对照在变异轮里跑）。
 */
describe('§318 源码面：一份上限 ＋ 诚实的返回类型', () => {
  const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')

  it('追问历史上限只有一份出处：schema 与主进程裁剪都写 KB_ASK_MAX_HISTORY', () => {
    const handler = read('../src/main/ipc/handlers/knowledge.ts')
    const service = read('../src/main/knowledge/ask-service.ts')
    expect(handler).toMatch(/history: z\.array\([\s\S]*?\)\)\.max\(KB_ASK_MAX_HISTORY\)/)
    expect(service).toMatch(/\.slice\(-KB_ASK_MAX_HISTORY\)/)
    expect(service, '数字不许在第二处再定义一遍').not.toMatch(/export const KB_ASK_MAX_HISTORY =/)
  })

  it('发起类通道的返回类型必须带失败形状（三条逐钉）', () => {
    const src = read('../src/preload/index.ts')
    for (const anchor of [
      '}): Promise<{ requestId: string; sources: MessageSource[] } | { ok: false',
      'syncSkills: (): Promise<{ count: number; errors: string[] } | { ok: false',
      'createLocalBackup: (): Promise<{ path: string; size: number; encrypted: boolean } | { ok: false'
    ]) {
      expect(src.includes(anchor), `preload 声明缺了失败形状：${anchor.slice(0, 44)}…`).toBe(true)
    }
  })
})
