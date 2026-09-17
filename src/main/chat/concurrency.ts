// 按 Provider 限流的并发信号量
// 同一服务商最多 N 个并发请求，避免触发 429；不同服务商互不阻塞

class Semaphore {
  private running = 0
  private queue: Array<() => void> = []

  constructor(private readonly capacity: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.capacity) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

const limiters = new Map<string, Semaphore>()
const MAX_CONCURRENCY_PER_PROVIDER = 2

export function withProviderLimit<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
  let limiter = limiters.get(providerId)
  if (!limiter) {
    limiter = new Semaphore(MAX_CONCURRENCY_PER_PROVIDER)
    limiters.set(providerId, limiter)
  }
  return limiter.run(fn)
}
