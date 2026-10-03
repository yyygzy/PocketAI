// 斜杠快捷指令纯函数测试
import { describe, it, expect } from 'vitest'
import { filterSlashCommands, getSlashQuery, type SlashCommand } from '../src/renderer/src/modules/agent/agent-shared'

const commands: SlashCommand[] = [
  { name: 'summary', label: '总结', template: 'tpl-summary', kind: 'builtin' },
  { name: 'translate', label: '翻译', template: 'tpl-translate', kind: 'builtin' },
  { name: 'polish', label: '润色', template: 'tpl-polish', kind: 'builtin' }
]

describe('getSlashQuery', () => {
  it('空串返回 null', () => {
    expect(getSlashQuery('')).toBeNull()
  })

  it('普通文本返回 null', () => {
    expect(getSlashQuery('你好')).toBeNull()
    expect(getSlashQuery('帮我 /总结 一下')).toBeNull()
  })

  it('单独 / 返回空串（菜单全量展示）', () => {
    expect(getSlashQuery('/')).toBe('')
  })

  it('允许前导空白', () => {
    expect(getSlashQuery('  /s')).toBe('s')
  })

  it('返回命令词', () => {
    expect(getSlashQuery('/sum')).toBe('sum')
    expect(getSlashQuery('/TRANSLATE')).toBe('TRANSLATE')
  })

  it('命令词含空格后视为普通输入（进入正文）返回 null', () => {
    expect(getSlashQuery('/sum ')).toBeNull()
    expect(getSlashQuery('/sum xxx')).toBeNull()
  })

  it('路径式双斜杠不触发', () => {
    expect(getSlashQuery('//')).toBeNull()
    expect(getSlashQuery('/a/b')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  it('空 query 返回全部', () => {
    expect(filterSlashCommands(commands, '')).toHaveLength(3)
    expect(filterSlashCommands(commands, '   ')).toHaveLength(3)
  })

  it('前缀匹配（大小写不敏感）', () => {
    expect(filterSlashCommands(commands, 'sum').map((c) => c.name)).toEqual(['summary'])
    expect(filterSlashCommands(commands, 'TR').map((c) => c.name)).toEqual(['translate'])
    expect(filterSlashCommands(commands, 'p').map((c) => c.name)).toEqual(['polish'])
  })

  it('只做前缀匹配，不做包含匹配', () => {
    expect(filterSlashCommands(commands, 'ummary')).toEqual([])
  })

  it('无命中返回空数组', () => {
    expect(filterSlashCommands(commands, 'zzz')).toEqual([])
  })

  it('保持原数组顺序', () => {
    expect(filterSlashCommands(commands, '').map((c) => c.name)).toEqual(['summary', 'translate', 'polish'])
  })
})
