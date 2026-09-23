// 渠道层通用逻辑测试（gateway-base）
//
// 覆盖 5 个 IM 网关（slack/feishu/dingtalk/discord/telegram）共用的 4 个已导出设施：
//   - safeError：错误脱敏（URL 含 token 时一律笼统化，避免泄漏到日志/状态广播）
//   - splitMessage：按长度分片，优先在换行处切，避免硬切半句
//   - sleep：可被 AbortSignal 打断的延时（stop 时立即 resolve 由外层 while 退出循环）
//   - StatusEmitter：状态发射去重（同状态同 error 不重复广播，reset 后重允许）
//
// 策略：纯函数直接断言；sleep 用 vi.useFakeTimers + 真实 AbortController；
// StatusEmitter 用 Set 监听器捕获广播次数。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { safeError, splitMessage, sleep, StatusEmitter } from '../src/main/channels/gateway-base'
import type { ChannelStatusEvent } from '../src/shared/types'

describe('safeError — 错误脱敏', () => {
  it('Error 实例 → "method: Name: message"（无敏感字串则保留原文）', () => {
    expect(safeError(new TypeError('boom'), 'poll')).toBe('poll: TypeError: boom')
  })

  it('非 Error 值 → "method: String(value)"', () => {
    expect(safeError('plain string', 'poll')).toBe('poll: plain string')
    expect(safeError(42, 'poll')).toBe('poll: 42')
  })

  it('各平台 token / URL → 一律脱敏为笼统描述', () => {
    const cases: Array<[unknown, string]> = [
      [new Error('failed: bot123: getUpdates'), 'telegram bot token'],
      [new Error('xoxb-1234567890-abc getMe'), 'slack token'],
      [new Error('GET https://api.telegram.org/bot123/sendMessage'), 'telegram api url'],
      [new Error('GET https://discord.com/api/v10/channels/x'), 'discord api url'],
      [new Error('POST https://slack.com/api/chat.postMessage'), 'slack api url'],
      [new Error('GET https://open.feishu.cn/open-apis/'), 'feishu api url'],
      [new Error('GET https://oapi.dingtalk.com/robot/send'), 'dingtalk api url'],
      [new Error('redirect to https://evil.example.com/x'), 'generic https url']
    ]
    for (const [err, label] of cases) {
      expect(safeError(err, 'poll'), `case: ${label}`).toBe('poll 请求失败（网络或凭证错误）')
    }
  })

  it('普通无 token 文本 → 不脱敏', () => {
    expect(safeError(new Error('network unreachable'), 'poll')).toBe('poll: Error: network unreachable')
  })
})

describe('splitMessage — 按长度分片', () => {
  it('文本 ≤ limit → 原样单段', () => {
    expect(splitMessage('hello', 10)).toEqual(['hello'])
    expect(splitMessage('exact10!', 10)).toEqual(['exact10!'])
  })

  it('超长无换行 → 在 limit 处硬切', () => {
    const text = 'a'.repeat(120)
    const out = splitMessage(text, 50)
    expect(out).toHaveLength(3)
    expect(out[0]).toHaveLength(50)
    expect(out[1]).toHaveLength(50)
    expect(out[2]).toHaveLength(20)
    expect(out.join('')).toBe(text)
  })

  it('换行位置在 limit 内且 ≥50% → 在换行处切（不硬切半句）', () => {
    // 'line1\nline2\nline3'，limit 6：每段 5 字符 + 换行点在 index 5（≥3）
    const out = splitMessage('line1\nline2\nline3', 6)
    expect(out).toEqual(['line1', 'line2', 'line3'])
  })

  it('换行位置 <50% limit → 走硬切（不切在过早的换行处）', () => {
    // 'abc\ndefghij'，limit 8：换行在 index 3 < floor(8*0.5)=4 → 硬切 8
    const out = splitMessage('abc\ndefghij', 8)
    expect(out).toEqual(['abc\ndefg', 'hij'])
  })

  it('多段切片去除段首换行（连续换行一并清掉）', () => {
    // 'aaa\n\n\nbbb'，limit 4：第一切在 index 3，剩余段首 3 个换行被 replace 清掉
    const out = splitMessage('aaa\n\n\nbbb', 4)
    expect(out).toEqual(['aaa', 'bbb'])
  })
})

describe('sleep — AbortSignal 可打断延时', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('未中止 → 到 ms 才 resolve', async () => {
    const ac = new AbortController()
    let resolved = false
    sleep(1000, ac.signal).then(() => {
      resolved = true
    })
    vi.advanceTimersByTime(999)
    expect(resolved).toBe(false)
    vi.advanceTimersByTime(1)
    await Promise.resolve() // flush 微任务
    expect(resolved).toBe(true)
  })

  it('已中止 → 立即 resolve（不等 ms）', async () => {
    const ac = new AbortController()
    ac.abort()
    let resolved = false
    sleep(1000, ac.signal).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(true)
  })

  it('中途中止 → 立即 resolve 并清 timer（不再在到点二次触发）', async () => {
    const ac = new AbortController()
    let resolved = 0
    sleep(1000, ac.signal).then(() => {
      resolved++
    })
    vi.advanceTimersByTime(500)
    expect(resolved).toBe(0)
    ac.abort()
    await Promise.resolve()
    expect(resolved).toBe(1)
    // 越过原定 1000ms，不应二次触发
    vi.advanceTimersByTime(600)
    await Promise.resolve()
    expect(resolved).toBe(1)
  })
})

describe('StatusEmitter — 状态去重发射', () => {
  it('首次 emit → 广播给所有监听器', () => {
    const em = new StatusEmitter('telegram')
    const a: ChannelStatusEvent[] = []
    const b: ChannelStatusEvent[] = []
    em.add((e) => a.push(e))
    em.add((e) => b.push(e))
    em.emit('starting')
    expect(a).toEqual([{ type: 'telegram', status: 'starting', lastError: null }])
    expect(b).toEqual([{ type: 'telegram', status: 'starting', lastError: null }])
  })

  it('重复同状态同 error → 不广播（去重）', () => {
    const em = new StatusEmitter('telegram')
    const seen: ChannelStatusEvent[] = []
    em.add((e) => seen.push(e))
    em.emit('running', null)
    em.emit('running', null) // 完全相同 → 不广播
    expect(seen).toHaveLength(1)
  })

  it('不同状态 → 广播', () => {
    const em = new StatusEmitter('telegram')
    const seen: ChannelStatusEvent[] = []
    em.add((e) => seen.push(e))
    em.emit('starting')
    em.emit('running')
    expect(seen.map((e) => e.status)).toEqual(['starting', 'running'])
  })

  it('同状态不同 lastError → 广播', () => {
    const em = new StatusEmitter('telegram')
    const seen: ChannelStatusEvent[] = []
    em.add((e) => seen.push(e))
    em.emit('error', 'timeout')
    em.emit('error', 'auth failed') // error 不同 → 广播
    em.emit('error', 'auth failed') // 完全相同 → 不广播
    expect(seen).toHaveLength(2)
    expect(seen.map((e) => e.lastError)).toEqual(['timeout', 'auth failed'])
  })

  it('reset 后再 emit 同状态 → 重新广播（stop→start 场景）', () => {
    const em = new StatusEmitter('telegram')
    const seen: ChannelStatusEvent[] = []
    em.add((e) => seen.push(e))
    em.emit('running')
    em.reset()
    em.emit('running') // reset 清掉 last → 应广播
    expect(seen).toHaveLength(2)
  })

  it('add 返回取消订阅函数', () => {
    const em = new StatusEmitter('telegram')
    const seen: ChannelStatusEvent[] = []
    const off = em.add((e) => seen.push(e))
    em.emit('starting')
    off()
    em.emit('running')
    expect(seen).toHaveLength(1)
  })
})
