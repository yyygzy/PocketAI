// 围栏代码块解析纯函数测试
import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import { nodesToText, parseCodeProps } from '../src/renderer/src/utils/code-block'

describe('nodesToText — react-markdown children 拍平', () => {
  it('字符串/数字原样', () => {
    expect(nodesToText('const a = 1')).toBe('const a = 1')
    expect(nodesToText(42)).toBe('42')
  })
  it('null/undefined/boolean → 空串', () => {
    expect(nodesToText(null)).toBe('')
    expect(nodesToText(undefined)).toBe('')
    expect(nodesToText(false)).toBe('')
    expect(nodesToText(true)).toBe('')
  })
  it('数组按序拼接', () => {
    expect(nodesToText(['ab', 'cd'])).toBe('abcd')
  })
  it('递归提取高亮 span（鸭子类型 React 元素），不出现 [object Object]', () => {
    // 模拟 rehype-highlight 产出：['const ', <span class="hljs-keyword">a</span>, ' = 1']
    const span = { props: { className: 'hljs-keyword', children: 'a' } }
    expect(nodesToText(['const ', span, ' = 1'])).toBe('const a = 1')
  })
  it('嵌套元素继续递归', () => {
    const inner = { props: { children: 'x' } }
    const outer = { props: { children: [inner, 'y'] } }
    expect(nodesToText(outer)).toBe('xy')
  })
})

describe('parseCodeProps — 围栏代码块解析', () => {
  it('有语言：返回小写语言名与代码', () => {
    expect(parseCodeProps({ className: 'language-TS', children: 'const a = 1\n' })).toEqual({
      lang: 'ts',
      code: 'const a = 1'
    })
  })
  it('className 含其它类名时仍能提取语言', () => {
    expect(parseCodeProps({ className: 'hljs language-python', children: 'print(1)' })).toEqual({
      lang: 'python',
      code: 'print(1)'
    })
  })
  it('无语言围栏 → lang=null，代码保留', () => {
    expect(parseCodeProps({ children: 'plain text\n' })).toEqual({ lang: null, code: 'plain text' })
  })
  it('仅去掉末尾一个换行', () => {
    expect(parseCodeProps({ className: 'language-sh', children: 'a\n\n\n' }).code).toBe('a\n\n')
  })
  it('空代码', () => {
    expect(parseCodeProps({ className: 'language-js', children: '' })).toEqual({ lang: 'js', code: '' })
  })
  it('高亮 token 数组 children → 还原原始代码', () => {
    const kw = { props: { children: 'function' } }
    const r = parseCodeProps({
      className: 'language-javascript',
      children: [kw, ' foo() {}\n'] as ReactNode[]
    })
    expect(r.lang).toBe('javascript')
    expect(r.code).toBe('function foo() {}')
  })
})
