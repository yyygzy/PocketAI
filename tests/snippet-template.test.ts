// 提示词片段模板变量纯函数测试
import { describe, expect, it } from 'vitest'
import { applyTemplateVars, extractTemplateVars } from '../src/renderer/src/utils/snippet-template'

describe('extractTemplateVars', () => {
  it('无变量返回空数组', () => {
    expect(extractTemplateVars('普通文本，没有占位')).toEqual([])
    expect(extractTemplateVars('')).toEqual([])
  })

  it('提取单个/多个变量', () => {
    expect(extractTemplateVars('{{a}}')).toEqual(['a'])
    expect(extractTemplateVars('把{{内容}}翻译成{{语言}}')).toEqual(['内容', '语言'])
    expect(extractTemplateVars('{{x}}-{{y}}-{{z}}')).toEqual(['x', 'y', 'z'])
  })

  it('同名变量去重且保持首次出现顺序', () => {
    expect(extractTemplateVars('{{b}}{{a}}{{b}}{{a}}')).toEqual(['b', 'a'])
    expect(extractTemplateVars('{{内容}}...{{语言}}...{{内容}}')).toEqual(['内容', '语言'])
  })

  it('容许占位内空白', () => {
    expect(extractTemplateVars('{{ 名前 }}')).toEqual(['名前'])
    expect(extractTemplateVars('{{\tfoo\n}}')).toEqual(['foo'])
  })

  it('支持英文/数字/下划线/中文变量名', () => {
    expect(extractTemplateVars('{{topic_1}}{{主题}}{{A_B}}')).toEqual(['topic_1', '主题', 'A_B'])
  })

  it('非法形态不匹配（空占位、含空格/符号、单括号）', () => {
    expect(extractTemplateVars('{{}}')).toEqual([])
    expect(extractTemplateVars('{{a b}}')).toEqual([])
    expect(extractTemplateVars('{{a-b}}')).toEqual([])
    expect(extractTemplateVars('{a}')).toEqual([])
    expect(extractTemplateVars('{{ a }}')).toEqual(['a']) // 合法：仅外围空白
  })
})

describe('applyTemplateVars', () => {
  it('全部替换', () => {
    expect(applyTemplateVars('你好{{名前}}', { 名前: '世界' })).toBe('你好世界')
    expect(applyTemplateVars('{{a}}{{b}}', { a: '1', b: '2' })).toBe('12')
  })

  it('同名占位的多个实例全部替换', () => {
    expect(applyTemplateVars('{{x}}-{{x}}-{{x}}', { x: 'Q' })).toBe('Q-Q-Q')
  })

  it('值含 $ 等特殊替换串时按字面量处理（无 re.replace 特殊模式注入）', () => {
    expect(applyTemplateVars('{{v}}', { v: '$&$1' })).toBe('$&$1')
  })

  it('空字符串值替换为空（用户显式留空）', () => {
    expect(applyTemplateVars('[{{v}}]', { v: '' })).toBe('[]')
  })

  it('vals 中缺失的变量保留原占位', () => {
    expect(applyTemplateVars('{{a}}{{b}}', { a: 'X' })).toBe('X{{b}}')
  })

  it('无变量内容原样返回', () => {
    expect(applyTemplateVars('plain text', { a: 'X' })).toBe('plain text')
  })
})
