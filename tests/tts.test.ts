// TTS 朗读文本清洗纯函数测试（不碰 speechSynthesis 浏览器 API）
import { describe, it, expect } from 'vitest'
import { stripSpeechText } from '../src/renderer/src/utils/tts'

describe('stripSpeechText', () => {
  it('围栏代码块整块移除', () => {
    const out = stripSpeechText('前文\n```ts\nconst x = 1\n```\n后文')
    expect(out).not.toContain('const x')
    expect(out).not.toContain('```')
    expect(out).toContain('前文')
    expect(out).toContain('后文')
  })

  it('图片语法整体移除，链接保留文字', () => {
    const out = stripSpeechText('看图 ![说明](https://x/a.png) 和 [文档](https://x/d)')
    expect(out).not.toContain('说明')
    expect(out).not.toContain('https://')
    expect(out).toContain('文档')
  })

  it('行内代码保留文字内容', () => {
    expect(stripSpeechText('用 `npm test` 跑测试')).toBe('用 npm test 跑测试')
  })

  it('标题/引用/列表前缀去除，正文保留', () => {
    const md = '# 标题\n\n> 引用行\n\n- 项目一\n+ 项目二\n* 项目三\n1. 第一项\n2. 第二项'
    const out = stripSpeechText(md)
    expect(out).toContain('标题')
    expect(out.startsWith('#')).toBe(false)
    expect(out).toContain('引用行')
    expect(out).toContain('项目一')
    expect(out).toContain('第一项')
    expect(out).not.toMatch(/^\s*[-*+]\s/m)
    expect(out).not.toMatch(/^\s*\d+\.\s/m)
  })

  it('粗体/斜体标记剥离保留文字', () => {
    expect(stripSpeechText('**粗** 和 __粗2__')).toBe('粗 和 粗2')
    expect(stripSpeechText('*斜* 和 _斜2_')).toBe('斜 和 斜2')
  })

  it('HTML 标签与表格管道移除', () => {
    const out = stripSpeechText('<b>粗</b> 文本 | 列1 | 列2 |')
    expect(out).not.toContain('<')
    expect(out).not.toContain('|')
    expect(out).toContain('粗')
    expect(out).toContain('列1')
  })

  it('空白折叠：多空格合一、多空行收敛、首尾 trim', () => {
    expect(stripSpeechText('   hello   world  \n\n\n\n再见 ')).toBe('hello world\n\n再见')
  })

  it('空串/纯空白返回空串', () => {
    expect(stripSpeechText('')).toBe('')
    expect(stripSpeechText('   \n  ')).toBe('')
  })

  it('纯代码块无正文时返回空串', () => {
    expect(stripSpeechText('```\ncode\n```')).toBe('')
  })
})
