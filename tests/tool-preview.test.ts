// 工具审批预览字段构造测试
//
// 覆盖 src/shared/tool-preview.ts 的 buildToolPreviewFields 纯函数：
// - 空参数 → null（调用方回退 JSON 展示）
// - 路径类参数经 resolvePath 解析（失败回退原值）
// - content/code/command 类 → mono 长文本截断
// - query/url/expression → 单行字段
// - 原子值 / 嵌套对象 / 字段数上限
import { describe, it, expect } from 'vitest'
import { buildToolPreviewFields } from '../src/shared/tool-preview'

describe('buildToolPreviewFields', () => {
  it('空参数对象返回 null', () => {
    expect(buildToolPreviewFields({})).toBeNull()
  })

  it('path 类参数经 resolvePath 解析', () => {
    // 注意：resolvePath 只做拼接示例，不归一化分隔符
    const fields = buildToolPreviewFields({ path: 'docs/a.md' }, (p) => `C:\\ws\\${p}`)
    expect(fields).toEqual([{ key: 'path', value: 'C:\\ws\\docs/a.md' }])
  })

  it('resolvePath 抛错时回退原始路径', () => {
    const fields = buildToolPreviewFields({ filePath: '../evil' }, () => {
      throw new Error('越界')
    })
    expect(fields![0]!.value).toBe('../evil')
  })

  it('content/command/code 类参数为 mono 字段', () => {
    const fields = buildToolPreviewFields({ content: 'hello', query: 'q' })
    expect(fields![0]).toMatchObject({ key: 'content', mono: true })
    expect(fields![1]).toMatchObject({ key: 'query' })
    expect(fields![1]!.mono).toBeUndefined()
  })

  it('长文本按 800 字符截断并追加省略号', () => {
    const fields = buildToolPreviewFields({ content: 'x'.repeat(1000) })
    expect(fields![0]!.value.length).toBe(801)
    expect(fields![0]!.value.endsWith('…')).toBe(true)
  })

  it('未识别参数名保留原 key（渲染端回退显示）', () => {
    const fields = buildToolPreviewFields({ someFlag: true, count: 3 })
    expect(fields).toEqual([
      { key: 'someFlag', value: 'true' },
      { key: 'count', value: '3' }
    ])
  })

  it('嵌套对象走 JSON 摘要 mono 块', () => {
    const fields = buildToolPreviewFields({ options: { a: 1 } })
    expect(fields![0]).toMatchObject({ key: 'options', mono: true, value: '{"a":1}' })
  })

  it('字段数上限 6，多余丢弃', () => {
    const args: Record<string, unknown> = {}
    for (let i = 0; i < 10; i++) args[`p${i}`] = i
    expect(buildToolPreviewFields(args)!.length).toBe(6)
  })

  it('null/undefined 值跳过', () => {
    const fields = buildToolPreviewFields({ a: null, b: undefined, c: 'ok' })
    expect(fields).toEqual([{ key: 'c', value: 'ok' }])
  })
})
