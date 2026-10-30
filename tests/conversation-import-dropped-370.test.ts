// V4-Iter-370：导入这一格「少了的那几个数」——消息级丢弃的分类计数
//
// 缺陷本体（现查）：屏上那句「导入 {c} 个会话 / {m} 条消息」与「跳过 {n} 个会话或文件」都只算**会话层**，
// 而文件里每一条被跳过的内容都是静默 `continue`：
//  · Claude JSONL 五发——整行 JSON 坏（`:292` catch）、解析出来不是对象／是数组（`:290`）、
//    type 不是 user/assistant（`:299`）、`textFromClaudeContent` 回 null（工具包裹／isMeta／没有 text 块，`:311`）、
//    正文 trim 后为空（`:315`）
//  · ChatGPT conversations.json 四发——节点没有 message、role 不是 user/assistant、
//    content_type 不是 text、正文为空
// ⇒「导入 800 条」可以比文件里真实的消息少几十条，而屏上没有一句话说明少了、更没说少在哪一类。
//
// 本文件判的是**分类正确**而不只是总数对得上：把 system 行算进"坏行"会把一份正常文件说成坏了，
// 把工具包裹算成"正文为空"会让人以为导出缺内容——所以每一颗都钉到具体那一个字段。
import { describe, it, expect } from 'vitest'
import {
  parseChatGptExport,
  parseClaudeJsonl,
  droppedMessageTotal,
  MAX_EXTERNAL_MESSAGES_PER_CONV
} from '../src/shared/conversation-import-external'

/** Claude：一行合法的用户发言 */
const claudeOk = (text: string, type: 'user' | 'assistant' = 'user'): string =>
  JSON.stringify({ type, content: text, timestamp: '2026-01-01T00:00:00Z' })

const zero = { badJson: 0, notEvent: 0, nonText: 0, emptyText: 0 }

describe('parseClaudeJsonl 的丢弃分类', () => {
  it('D1 正向对照：一份正常文件四类全 0（判据不是"数出个数"，是"不该数的时候一个都不数"）', () => {
    const r = parseClaudeJsonl(
      [claudeOk('你好'), claudeOk('我在这儿', 'assistant'), claudeOk('第二问')].join('\n'),
      'f'
    )
    expect(r.conversations[0]!.messages).toHaveLength(3)
    expect(r.droppedMessages).toEqual(zero)
    expect(droppedMessageTotal(r.droppedMessages)).toBe(0)
  })

  it('D2 四类各命中一发 ⇒ 每类正好 1（不是只数一个总数）', () => {
    const r = parseClaudeJsonl(
      [
        '{ "type": "user", "content": "半截的',
        '[1,2,3]',
        JSON.stringify({ type: 'summary', content: 'x' }),
        JSON.stringify({ type: 'user', isMeta: true, content: '工具回填' }),
        claudeOk('   '),
        claudeOk('这条是收下的')
      ].join('\n'),
      'f'
    )
    expect(r.droppedMessages).toEqual({ badJson: 1, notEvent: 2, nonText: 1, emptyText: 1 })
    expect(droppedMessageTotal(r.droppedMessages)).toBe(5)
    expect(r.conversations[0]!.messages).toHaveLength(1)
  })

  it('D3 整行 JSON 坏只算 badJson，不顺手算进别类（一发顶两数＝屏上的分类明细就是假的）', () => {
    const r = parseClaudeJsonl(['not json at all', claudeOk('ok')].join('\n'), 'f')
    expect(r.droppedMessages.badJson).toBe(1)
    expect({ ...r.droppedMessages, badJson: 0 }).toEqual(zero)
  })

  it('D4 解析得出来但不是对象（数组／裸字符串）算 notEvent，不算坏行', () => {
    const r = parseClaudeJsonl(['[1,2]', '"a bare string"', '42', claudeOk('ok')].join('\n'), 'f')
    expect(r.droppedMessages).toEqual({ ...zero, notEvent: 3 })
  })

  it('D5 非对话事件（system／queue／未知 type）算 notEvent——真实 CLI 导出里这是常态，不能报成"读不出"', () => {
    const r = parseClaudeJsonl(
      [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'queue-operation' }),
        JSON.stringify({ model_setting: 'x' }),
        claudeOk('ok')
      ].join('\n'),
      'f'
    )
    expect(r.droppedMessages).toEqual({ ...zero, notEvent: 3 })
  })

  it('D6 工具包裹／isMeta／content 里只有非 text 块都算 nonText，不算 emptyText', () => {
    const r = parseClaudeJsonl(
      [
        JSON.stringify({ type: 'user', content: [{ type: 'tool_result', content: 'r' }] }),
        JSON.stringify({ type: 'user', isMeta: true, content: 'meta' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 't' }] } }),
        claudeOk('ok')
      ].join('\n'),
      'f'
    )
    expect(r.droppedMessages).toEqual({ ...zero, nonText: 3 })
  })

  it('D7 正文取到了但是空白 ⇒ emptyText（与"没有文本"是两件事）', () => {
    const r = parseClaudeJsonl(
      [
        claudeOk('   '),
        JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: '' }] }),
        claudeOk('ok')
      ].join('\n'),
      'f'
    )
    expect(r.droppedMessages).toEqual({ ...zero, emptyText: 2 })
  })

  it('D8 空行一类都不计（一份正常导出文件行尾常带空行，数进去＝凭空多几条"丢弃"）', () => {
    const r = parseClaudeJsonl(`\n\n${claudeOk('ok')}\n\n   \n`, 'f')
    expect(r.droppedMessages).toEqual(zero)
  })

  it('D9 一条都没收下（skipped=1）时，丢弃计数照样带回去——这一路过去连告警都整条丢掉', () => {
    const r = parseClaudeJsonl(['{坏行', JSON.stringify({ type: 'system' }), claudeOk('  ')].join('\n'), 'f')
    expect(r.skippedConversationCount).toBe(1)
    expect(r.conversations).toHaveLength(0)
    expect(r.droppedMessages).toEqual({ badJson: 1, notEvent: 1, nonText: 0, emptyText: 1 })
  })

  it('D10 上限截断不算丢弃：收了 10000 条、break 掉的剩余行没被读过，一句"没被认出"都不许多说', () => {
    const lines: string[] = []
    for (let i = 0; i < MAX_EXTERNAL_MESSAGES_PER_CONV + 5; i++) lines.push(claudeOk(`m${i}`))
    const r = parseClaudeJsonl(lines.join('\n'), 'f')
    expect(r.conversations[0]!.messages).toHaveLength(MAX_EXTERNAL_MESSAGES_PER_CONV)
    expect(droppedMessageTotal(r.droppedMessages)).toBe(0)
    expect(r.warnings).toEqual([{ code: 'IMPORT_MSG_LIMIT', args: { max: MAX_EXTERNAL_MESSAGES_PER_CONV } }])
  })
})

describe('parseChatGptExport 的丢弃分类', () => {
  /** 一条主干节点：给 role/content_type/parts 三个旋钮 */
  const node = (id: string, role: string | undefined, contentType: string | undefined, parts: unknown): Record<string, unknown> => ({
    id,
    parent: id === 'root' ? null : 'prev',
    children: [],
    message: role === undefined && contentType === undefined && parts === undefined
      ? null
      : { author: role === undefined ? {} : { role }, create_time: 1767225600, content: { content_type: contentType, parts } }
  })

  const tree = (nodes: Record<string, unknown>[]): string => {
    const mapping: Record<string, unknown> = {}
    const rootId = 'root'
    mapping[rootId] = { id: rootId, parent: null, children: ['a'], message: null }
    let prev = rootId
    nodes.forEach((n, i) => {
      const id = String(n.id)
      mapping[id] = { ...n, parent: prev, children: i + 1 < nodes.length ? [`${id}-next`] : [] }
      // 主干沿 parent 回溯：把上一条接到这一条下面
      const prevNode = mapping[prev] as { children: string[] }
      prevNode.children = [id]
      prev = id
    })
    return JSON.stringify([{ title: 'T', current_node: prev, create_time: 1767225600, mapping }])
  }

  it('D11 正向对照：一条 user 一条 assistant ⇒ 四类全 0', () => {
    const r = parseChatGptExport(tree([
      node('a', 'user', 'text', ['问']),
      node('b', 'assistant', 'text', ['答'])
    ]))
    expect(r.conversations[0]!.messages).toHaveLength(2)
    expect(r.droppedMessages).toEqual(zero)
  })

  it('D12 三类各一发 ⇒ notEvent 1、nonText 1、emptyText 1；树上没有 message 的结构节点不计数', () => {
    const r = parseChatGptExport(tree([
      node('a', undefined, undefined, undefined),
      node('b', 'system', 'text', ['x']),
      node('c', 'assistant', 'multimodal_text', [{ type: 'image_url' }]),
      node('d', 'user', 'text', ['   ']),
      node('e', 'assistant', 'text', ['收下的这条'])
    ]))
    // a 是结构节点（message 为 null）：它不是"一条被丢掉的内容"，数进去会让正常导出凭空多几条
    expect(r.droppedMessages).toEqual({ badJson: 0, notEvent: 1, nonText: 1, emptyText: 1 })
    expect(r.conversations[0]!.messages).toHaveLength(1)
  })

  it('D13 整份文件读不出来＝一个消息都没看过 ⇒ dropped 全 0（不许把一份坏文件说成几千条坏行）', () => {
    const r = parseChatGptExport('{bad')
    expect(r.droppedMessages).toEqual(zero)
    expect(r.warnings).toEqual([{ code: 'IMPORT_FILE_NOT_JSON' }])
  })

  it('D14 会话级跳过（item 不是对象／无有效消息）不进消息计数——两把尺子各数各的', () => {
    const text = JSON.stringify([
      '我不是对象',
      { title: '空会话', mapping: {} },
      { title: 'T', current_node: 'a', mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } } } } }
    ])
    const r = parseChatGptExport(text)
    expect(r.skippedConversationCount).toBe(2)
    expect(r.droppedMessages).toEqual(zero)
    expect(r.conversations).toHaveLength(1)
  })
})
