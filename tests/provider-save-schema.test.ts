// providerRecordSchema 的 id 口径：**空串 = 新建**，不能加 .min(1)
//
// 回归钉：eec774b 那批 zod 纵深防御给 id 加了 .min(1)，而「新增模型服务商」与首启向导
// 发的正是 id: ''（UUID 由 provider.repo 生成）。结果是两条配置云服务商的路全被挡在 IPC 门口，
// 报错还是一句看不懂的 `Too small: expected string to have >=1 characters`。
// 渲染层的向导/设置用例都 mock 了 window.pocketai，所以 schema 从未被真正跑过 ⇒ 只能在这里钉。
import { describe, it, expect } from 'vitest'
import { providerRecordSchema } from '../src/shared/schemas/providers'

function draft(over: Record<string, unknown> = {}) {
  return {
    id: '',
    type: 'openai-compatible',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeys: ['whatever-key'],
    models: [],
    enabled: true,
    createdAt: 1,
    ...over
  }
}

describe('providerRecordSchema — 新建 provider 的 id 口径', () => {
  it('设置页「+ 新增」的空 id 必须放行', () => {
    expect(providerRecordSchema.safeParse(draft()).success).toBe(true)
  })

  it('首启向导那段载荷（空 id + Date.now()）必须放行', () => {
    const wizardPayload = draft({ id: '', name: 'Kimi', createdAt: Date.now() })
    expect(providerRecordSchema.safeParse(wizardPayload).success).toBe(true)
  })

  it('编辑既有记录照常放行', () => {
    expect(providerRecordSchema.safeParse(draft({ id: 'a1b2c3' })).success).toBe(true)
  })

  it('上限与其余必填项仍然守着（放宽 id 不等于放宽整张表）', () => {
    expect(providerRecordSchema.safeParse(draft({ id: 'x'.repeat(65) })).success).toBe(false)
    expect(providerRecordSchema.safeParse(draft({ name: '' })).success).toBe(false)
    expect(providerRecordSchema.safeParse(draft({ type: 'nope' })).success).toBe(false)
    expect(providerRecordSchema.safeParse(draft({ baseUrl: 'h'.repeat(2049) })).success).toBe(false)
    expect(providerRecordSchema.safeParse(draft({ apiKeys: 'not-an-array' })).success).toBe(false)
  })
})
