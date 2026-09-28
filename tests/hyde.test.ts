// HyDE 假设文档生成测试
//
// 覆盖 src/main/knowledge/hyde.ts 的 generateHypotheticalDoc：
// - 无 adapter → null（调用方降级）
// - streamChat 成功：content trim 后返回；空白内容 → null
// - streamChat 抛错 → null（不传播）
// - 请求参数：system 提示词 + user query，temperature/maxTokens 固定
//
// 策略：vi.mock providers/manager，adapter.streamChat 用可控实现
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateHypotheticalDoc } from '../src/main/knowledge/hyde'

const mocks = vi.hoisted(() => ({
  adapter: null as
    | {
        streamChat: ReturnType<typeof vi.fn>
      }
    | null,
  reset() {
    this.adapter = null
  }
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => mocks.adapter
  }
}))

beforeEach(() => {
  mocks.reset()
  mocks.adapter = {
    streamChat: vi.fn(async () => ({ content: '  假设性答案段落  ' }))
  }
})

describe('generateHypotheticalDoc 假设文档生成', () => {
  it('无 adapter：返回 null 且不发起请求', async () => {
    mocks.adapter = null
    const r = await generateHypotheticalDoc('查询', 'p1', 'm1')
    expect(r).toBeNull()
  })

  it('成功：返回 trim 后的正文', async () => {
    const r = await generateHypotheticalDoc('什么是 HyDE', 'p1', 'm1')
    expect(r).toBe('假设性答案段落')
  })

  it('请求参数正确：system 提示词 + user 查询 + 固定生成参数', async () => {
    await generateHypotheticalDoc('什么是 HyDE', 'p1', 'm1')
    expect(mocks.adapter!.streamChat).toHaveBeenCalledWith(
      [
        { role: 'system', content: expect.stringContaining('知识库内容生成助手') },
        { role: 'user', content: '什么是 HyDE' }
      ],
      { model: 'm1', temperature: 0.7, maxTokens: 400 },
      { onDelta: expect.any(Function) }
    )
  })

  it('content 全空白：返回 null', async () => {
    mocks.adapter!.streamChat = vi.fn(async () => ({ content: '   \n  ' }))
    expect(await generateHypotheticalDoc('q', 'p', 'm')).toBeNull()
  })

  it('content 为空串：返回 null', async () => {
    mocks.adapter!.streamChat = vi.fn(async () => ({ content: '' }))
    expect(await generateHypotheticalDoc('q', 'p', 'm')).toBeNull()
  })

  it('streamChat 抛错：吞掉异常返回 null，不传播', async () => {
    mocks.adapter!.streamChat = vi.fn(async () => {
      throw new Error('网络炸了')
    })
    await expect(generateHypotheticalDoc('q', 'p', 'm')).resolves.toBeNull()
  })
})
