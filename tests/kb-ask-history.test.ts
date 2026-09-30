// KB 问答留痕纯函数测试
//
// 覆盖 src/shared/kb-ask-session.ts：
// - sessionTitleFrom：常规/超长截断/空白输入
// - parseKbAskMessages：合法/非法 JSON/非数组/非法项过滤/sources 保留
import { describe, it, expect } from 'vitest'
import { sessionTitleFrom, parseKbAskMessages, KB_ASK_TITLE_MAX } from '../src/shared/kb-ask-session'

describe('sessionTitleFrom', () => {
  it('常规问题直接作为标题', () => {
    expect(sessionTitleFrom('  什么是 RAG？ ')).toBe('什么是 RAG？')
  })

  it('超长问题截断加省略号', () => {
    const long = '问'.repeat(KB_ASK_TITLE_MAX + 10)
    const title = sessionTitleFrom(long)
    expect(title).toBe('问'.repeat(KB_ASK_TITLE_MAX) + '…')
    expect(title.length).toBe(KB_ASK_TITLE_MAX + 1)
  })

  it('空白输入返回空串', () => {
    expect(sessionTitleFrom('   ')).toBe('')
    expect(sessionTitleFrom('')).toBe('')
  })
})

describe('parseKbAskMessages', () => {
  it('合法消息数组完整解析', () => {
    const json = JSON.stringify([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答', sources: [{ chunkId: 'c1', docId: 'd1', docTitle: '文档', content: '内容' }] }
    ])
    expect(parseKbAskMessages(json)).toEqual([
      { role: 'user', content: '问题' },
      {
        role: 'assistant',
        content: '回答',
        sources: [{ chunkId: 'c1', docId: 'd1', docTitle: '文档', content: '内容' }]
      }
    ])
  })

  it('非法 JSON 返回空数组', () => {
    expect(parseKbAskMessages('{not-json')).toEqual([])
  })

  it('非数组 JSON 返回空数组', () => {
    expect(parseKbAskMessages('{"role":"user"}')).toEqual([])
    expect(parseKbAskMessages('"str"')).toEqual([])
  })

  it('过滤 role/content 不合法的项', () => {
    const json = JSON.stringify([
      { role: 'system', content: '系统提示词不应入库' },
      { role: 'user' },
      { role: 'user', content: 42 },
      null,
      'str',
      { role: 'user', content: '合法' }
    ])
    expect(parseKbAskMessages(json)).toEqual([{ role: 'user', content: '合法' }])
  })

  it('sources 非法时整条消息被过滤，合法时保留原样', () => {
    const bad = JSON.stringify([{ role: 'assistant', content: 'a', sources: 'not-array' }])
    expect(parseKbAskMessages(bad)).toEqual([])
    const good = JSON.stringify([
      { role: 'assistant', content: 'a', sources: [{ chunkId: 'c', docId: 'd', docTitle: 't', content: 'x', kbId: 'k', seq: 1 }] }
    ])
    const parsed = parseKbAskMessages(good)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.sources).toEqual([{ chunkId: 'c', docId: 'd', docTitle: 't', content: 'x', kbId: 'k', seq: 1 }])
  })
})
