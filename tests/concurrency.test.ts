// Provider 级并发信号量测试
import { describe, it, expect, vi } from 'vitest'

async function loadConcurrency() {
  vi.resetModules()
  return await import('../src/main/chat/concurrency')
}

describe('Semaphore 信号量', () => {
  it('capacity=2 时最多 2 个并发，第 3 个排队等待', async () => {
    const { withProviderLimit } = await loadConcurrency()
    const order: string[] = []
    const release: Array<() => void> = []

    const p1 = withProviderLimit('p', () => new Promise<void>((r) => { release.push(r); order.push('start1') }))
    const p2 = withProviderLimit('p', () => new Promise<void>((r) => { release.push(r); order.push('start2') }))
    const p3 = withProviderLimit('p', () => new Promise<void>((r) => { release.push(r); order.push('start3') }))

    await Promise.resolve()
    await Promise.resolve() // 让微任务充分执行
    expect(order).toEqual(['start1', 'start2'])

    release[0]!()
    await p1
    await Promise.resolve()
    expect(order).toEqual(['start1', 'start2', 'start3'])

    release[1]!()
    release[2]!()
    await Promise.all([p2, p3])
  })

  it('fn 抛错时仍释放信号量，不阻塞后续请求', async () => {
    const { withProviderLimit } = await loadConcurrency()
    const order: string[] = []

    await withProviderLimit('p', async () => { order.push('start') })

    await expect(
      withProviderLimit('p', async () => { order.push('err'); throw new Error('boom') })
    ).rejects.toThrow('boom')

    const result = await withProviderLimit('p', async () => { order.push('ok'); return 42 })
    expect(result).toBe(42)
    expect(order).toEqual(['start', 'err', 'ok'])
  })

  it('不同 provider 互不阻塞', async () => {
    const { withProviderLimit } = await loadConcurrency()
    let aRunning = 0
    let bRunning = 0
    let maxA = 0
    let maxB = 0

    const fnA = async () => { aRunning++; maxA = Math.max(maxA, aRunning); await new Promise((r) => setTimeout(r, 10)); aRunning-- }
    const fnB = async () => { bRunning++; maxB = Math.max(maxB, bRunning); await new Promise((r) => setTimeout(r, 10)); bRunning-- }

    await Promise.all([
      withProviderLimit('A', fnA),
      withProviderLimit('A', fnA),
      withProviderLimit('B', fnB),
      withProviderLimit('B', fnB)
    ])

    expect(maxA).toBeLessThanOrEqual(2)
    expect(maxB).toBeLessThanOrEqual(2)
  })

  it('同一 provider 共享限额（最多 2 并发）', async () => {
    const { withProviderLimit } = await loadConcurrency()
    const running = { count: 0, max: 0 }

    const track = async () => {
      running.count++
      running.max = Math.max(running.max, running.count)
      await new Promise((r) => setTimeout(r, 5))
      running.count--
    }

    await Promise.all([
      withProviderLimit('same', track),
      withProviderLimit('same', track),
      withProviderLimit('same', track)
    ])

    expect(running.max).toBe(2)
  })
})
