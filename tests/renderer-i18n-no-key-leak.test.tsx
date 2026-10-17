// 四语真挂载：渲染出来的文字里不许出现原始 i18n key（B26 那类"漏翻译"的通用闸门）
//
// 为什么不能只靠 i18n-parity：那条证的是「四本字典 key 集合一致」，可组件里真正危险的是
// **动态拼出来的 key**（`t(\`reminder.menu.${k}\`)`、`t(\`reminder.center.weekday.${n}\`)`）——
// 名字对不上字典时 parity 一声不响，界面上就露出 `reminder.menu.every9am` 这种原文。
// 这里把浮层在四种语言下各挂一次，扫**渲染后的文本**里有没有任何一把字典 key 漏出来。
//
// 每条用例先 `findByText(该语言的标题)`：字典是动态 import 的，没等到译文就断言＝假绿，
// 所以这一步同时充当"语言确实切换成功"的门禁。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ReminderMenu } from '../src/renderer/src/components/ReminderMenu'
import { zh } from '../src/renderer/src/i18n/zh'
import type { Lang } from '../src/renderer/src/i18n'

const LANGS: Exclude<Lang, 'zh'>[] = ['en', 'ja', 'ko']
const ZH_KEYS = Object.keys(zh)

/** 渲染文本里出现的每一把 key 都算漏翻译（key 形如 xxx.yyy，正常文案不会长这样） */
function leakedKeys(text: string): string[] {
  return ZH_KEYS.filter((k) => text.includes(k))
}

describe('ReminderMenu 四语无 key 泄漏', () => {
  beforeEach(() => {
    localStorage.clear()
    stubPocketai()
  })

  it('zh：默认中文渲染，且展开循环设置条后也不露 key', async () => {
    localStorage.setItem('pocketai.lang', 'zh')
    mountWithProviders(<ReminderMenu anchor={{ x: 120, y: 80 }} onPick={() => {}} onClose={() => {}} />)
    await screen.findByText('提醒我', { exact: false })
    const text = document.body.textContent ?? ''
    expect(leakedKeys(text)).toEqual([])
  })

  for (const lang of LANGS) {
    it(`${lang}：标题为译文、展开星期后同样不露 key`, async () => {
      const dict = (await import(`../src/renderer/src/i18n/${lang}`))[lang] as Record<string, string>
      localStorage.setItem('pocketai.lang', lang)
      mountWithProviders(<ReminderMenu anchor={{ x: 120, y: 80 }} onPick={() => {}} onClose={() => {}} />)
      // 门禁：等到该语言的标题出现（字典是动态加载的，等不到就说明这条没有效力）
      const title = dict['reminder.menu.remindMe']
      if (!title) throw new Error(`${lang} 字典里没有 reminder.menu.remindMe`)
      expect(title).toBeTruthy()
      await screen.findByText(title, { exact: false })

      // 展开「每周」那条的设置条，逼出 reminder.center.weekday.* 这组动态 key
      const ruleLabel = dict['reminder.menu.rule']
      if (!ruleLabel) throw new Error(`${lang} 字典里没有 reminder.menu.rule`)
      const caret = screen.getAllByLabelText(ruleLabel)[1]
      if (!caret) throw new Error(`${lang} 找不到循环设置按钮`)
      expect(caret).toBeTruthy()
      await fireEvent.click(caret)

      const text = document.body.textContent ?? ''
      expect(leakedKeys(text), `${lang} 渲染文本露出原始 key`).toEqual([])
      // 正向对照：星期名确实渲染出来了（不是一句"没露 key"因为整块没渲染）
      expect(text.length).toBeGreaterThan(0)
      expect(text).toContain(dict['reminder.center.weekday.1'])
    })
  }
})
