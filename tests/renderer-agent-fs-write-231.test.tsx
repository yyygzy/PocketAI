// @vitest-environment jsdom
// V4-Iter-231 渲染层：`fs_write` 的结果卡上要出现「还原到写入前」，而且**失败不能长得像成功**。
//
// 为什么挂 `AgentMessageCard` 而不是只挂 `FsWriteActions`：这一批的接线断言是"只有 fs_write 那一格有按钮"，
// 判据住在卡片的 `m.toolResult.name === 'fs_write'` 上；只挂小组件等于把这道挂载判据留给自己骗。
// 反向对照：同一条时间线里 `time_now` 的结果卡必须没有按钮（否则"按工具名挂"这条根本没被测到）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentMessageCard } from '../src/renderer/src/modules/agent/components/AgentMessageCard'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AgentMessage } from '../src/renderer/src/modules/agent/agent-shared'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const RESTORE = L('agent.fsWrite.restore')
const RESTORED = L('agent.fsWrite.restored')
const REMOVED = L('agent.fsWrite.removed')
const NOT_RESTORABLE = L('agent.fsWrite.notRestorable')

const statuses = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())

const resultMsg = (name: string, content: string): AgentMessage =>
  ({
    id: `t-${name}`,
    role: 'tool',
    text: '',
    toolResult: { name, content }
  }) as unknown as AgentMessage

let warns: string[] = []
beforeEach(() => {
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
})
afterEach(() => vi.restoreAllMocks())

const SNAP = '2f1c9a6e-0000-4000-8000-000000000001'

/** 挂一张 fs_write 结果卡；`restore` 给 IPC 的返回值（可为函数以便按第几次调用变脸） */
function mountCard(msg: AgentMessage, restore: unknown): { calls: () => number } {
  let n = 0
  stubPocketai({
    restoreFileWrite: () => {
      n += 1
      return typeof restore === 'function' ? (restore as (n: number) => unknown)(n) : restore
    },
    deleteMessage: () => ({ ok: true }),
    createReminder: () => ({ ok: true }),
    reportPerf: () => undefined
  })
  mountWithProviders(<AgentMessageCard m={msg} />)
  return { calls: () => n }
}

describe('① 按钮只在 fs_write 那一格出现', () => {
  const wrote = JSON.stringify({ path: 'a.md', bytes: 6, created: false, snapshotId: SNAP })

  it('fs_write 带快照 ⇒ 出现「还原到写入前」', async () => {
    mountCard(resultMsg('fs_write', wrote), { ok: true, path: 'a.md', bytes: 4, removed: false })
    await waitFor(() => expect(screen.queryByText(RESTORE)).toBeTruthy())
  })

  it('反向对照：别的工具就算返回了 snapshotId 这个字段也不许长出按钮（判据是工具名，不是字段形状）', async () => {
    // MCP server 可以返回任意 JSON——若挂载判据写成"结果里有 snapshotId 就挂"，
    // 那条按钮就会长在别人的结果卡上，点下去注定失败。
    mountCard(
      resultMsg('time_now', JSON.stringify({ now: 'x', snapshotId: '2f1c9a6e-0000-4000-8000-000000000001' })),
      { ok: true, path: 'a.md', bytes: 4, removed: false }
    )
    // 先证数据真到了渲染（否则"按钮不在场"是在空壳上恒真）
    await waitFor(() => expect(screen.getByText(/time_now/)).toBeTruthy())
    expect(screen.queryByText(RESTORE)).toBeNull()
  })

  it('结果里没有 snapshotId ⇒ 不出现按钮（出现一个注定失败的按钮更糟）', async () => {
    mountCard(resultMsg('fs_write', JSON.stringify({ path: 'a.md', bytes: 6, created: false })), { ok: true })
    await waitFor(() => expect(screen.getByText(/fs_write/)).toBeTruthy())
    expect(screen.queryByText(RESTORE)).toBeNull()
  })
})

describe('② 点下去之后：成功与失败必须是两张脸', () => {
  const wrote = JSON.stringify({ path: 'a.md', bytes: 6, created: false, snapshotId: SNAP })

  it('成功（覆盖还原）⇒ 按钮变成「已还原到写入前」并 disabled，IPC 恰好一发', async () => {
    const card = mountCard(
      resultMsg('fs_write', wrote),
      { ok: true, path: 'a.md', bytes: 4, removed: false }
    )
    fireEvent.click(screen.getByText(RESTORE))
    await waitFor(() => expect(screen.getByText(`✓ ${RESTORED}`)).toBeTruthy(), { timeout: 6000 })
    expect(card.calls()).toBe(1)
    expect((screen.getByText(`✓ ${RESTORED}`) as HTMLButtonElement).disabled).toBe(true)
  })

  it('成功（那一笔是新建，还原=删除）⇒ 说「已删除这次新建的文件」，不说"已还原"', async () => {
    mountCard(resultMsg('fs_write', wrote), { ok: true, path: 'a.md', bytes: 0, removed: true })
    fireEvent.click(screen.getByText(RESTORE))
    await waitFor(() => expect(screen.getByText(`✓ ${REMOVED}`)).toBeTruthy(), { timeout: 6000 })
    expect(screen.queryByText(`✓ ${RESTORED}`)).toBeNull()
  })

  it('resolve 的 {ok:false} ⇒ 原因原文进提示，按钮不得打勾（§230 那一族的下一档：判了不接管）', async () => {
    mountCard(resultMsg('fs_write', wrote), { ok: false, error: '写入之后这个文件又被改过' })
    fireEvent.click(screen.getByText(RESTORE))
    await waitFor(() => expect(statuses()).toContain('写入之后这个文件又被改过'), { timeout: 6000 })
    expect(screen.queryByText(`✓ ${RESTORED}`)).toBeNull()
  })

  it('真抛错 ⇒ 提示有原文，且痕进日志（不许只把失败咽在 console 之外）', async () => {
    mountCard(resultMsg('fs_write', wrote), () => {
      throw new Error('磁盘脱了')
    })
    fireEvent.click(screen.getByText(RESTORE))
    await waitFor(() => expect(statuses()).toContain('磁盘脱了'), { timeout: 6000 })
    expect(warns.filter((w) => w.startsWith('[ipc] ')).join('|')).toContain('agent.restoreFileWrite')
  })

  it('连点两次只发一发（还原是一次性的，第二发注定被主进程拒）', async () => {
    const card = mountCard(resultMsg('fs_write', wrote), { ok: true, path: 'a.md', bytes: 4, removed: false })
    fireEvent.click(screen.getByText(RESTORE))
    fireEvent.click(screen.getByText(RESTORE))
    await waitFor(() => expect(screen.getByText(`✓ ${RESTORED}`)).toBeTruthy(), { timeout: 6000 })
    expect(card.calls()).toBe(1)
  })
})

describe('③ 没留快照那一档要说为什么', () => {
  it('结果带 notRestorable ⇒ 一句说明在场，且没有按钮', async () => {
    const content = JSON.stringify({
      path: 'e.bin',
      bytes: 2,
      created: false,
      snapshotId: null,
      notRestorable: 'PREV_NOT_TEXT'
    })
    mountCard(resultMsg('fs_write', content), { ok: true })
    await waitFor(() => expect(statuses()).toContain(NOT_RESTORABLE), { timeout: 6000 })
    expect(screen.queryByText(RESTORE)).toBeNull()
  })

  it('反向对照：同一格内容解析不了（模型给了非 JSON）⇒ 既不出现按钮也不出现那句说明', async () => {
    mountCard(resultMsg('fs_write', '写入完成'), { ok: true })
    await waitFor(() => expect(screen.getByText('写入完成')).toBeTruthy())
    expect(screen.queryByText(RESTORE)).toBeNull()
    expect(statuses().join('|')).not.toContain(NOT_RESTORABLE)
  })
})

// V4-Iter-243：§242 真机点「还原到写入前」时屏幕上出现的是 `SNAPSHOT_DIVERGED` 这种码——
// 那五个码原本是光秃秃的 `new Error('SNAPSHOT_*')`，不带 `:说明`，从 §206 那道闸门的缝里漏了出去。
// 判据取向：**五条拒绝各出一语**（撞成一张脸就看不出为什么被拒），且码本身不进界面。
describe('④ 还原被拒：每一档各出一句能懂的话', () => {
  const wrote = JSON.stringify({ path: 'a.md', bytes: 6, created: false, snapshotId: SNAP })
  const refusals: Array<[string, string]> = [
    ['SNAPSHOT_NOT_FOUND:找不到这一笔写入的快照', 'agent.fsWrite.errNotFound'],
    ['SNAPSHOT_CONSUMED:这份快照已经用过了', 'agent.fsWrite.errConsumed'],
    ['SNAPSHOT_DIVERGED:这笔写入之后文件又被改过', 'agent.fsWrite.errDiverged'],
    ['CURRENT_NOT_TEXT:当前内容不是可读文本（过大或二进制）', 'agent.fsWrite.errNotText'],
    ['SNAPSHOT_ID_INVALID:快照编号形状不对', 'agent.fsWrite.errIdInvalid']
  ]

  for (const [error, key] of refusals) {
    it(`${error.split(':')[0]} ⇒ 屏幕上只有 ${L(key)}`, async () => {
      mountCard(resultMsg('fs_write', wrote), { ok: false, error })
      fireEvent.click(screen.getByText(RESTORE))
      await waitFor(() => expect(statuses()).toContain(L(key)), { timeout: 6000 })
      expect(statuses().join('|')).not.toContain(error.split(':')[0]!)
      expect(screen.queryByText(`✓ ${RESTORED}`)).toBeNull()
    })
  }

  it('五句彼此不同（撞成一张脸＝"无论为什么被拒都同一句"，用户不知道该做什么）', () => {
    const texts = refusals.map(([, key]) => L(key))
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('反向对照：没登记的回码仍按原文交出（这一跳是查表换话术，不是"永远换一句"）', async () => {
    mountCard(resultMsg('fs_write', wrote), { ok: false, error: 'FUTURE_CODE:还没登记的说明' })
    fireEvent.click(screen.getByText(RESTORE))
    await waitFor(() => expect(statuses()).toContain('FUTURE_CODE:还没登记的说明'), { timeout: 6000 })
  })
})
