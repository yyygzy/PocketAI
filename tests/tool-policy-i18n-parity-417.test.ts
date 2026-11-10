import { describe, expect, it } from 'vitest'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

describe('工具策略屏四语 parity（P0-3a）', () => {
  it('tp.* 四语键集完全一致且都有文案', () => {
    const keys = Object.keys(zh).filter((k) => k.startsWith('tp.'))
    // P0-3c 新增两张视角（当前助手／注册表全量）与五档状态、空数组两句解释：56 → 69
    // P0-3b 新增“写入文件或执行脚本”原因码（DANGEROUS_WRITE）：69 → 70
    // V4-Iter-467 高成本只展示：新增 tp.cost.high／tp.cost.highHint：70 → 72
    expect(keys.length).toBe(72)
    for (const [name, dict] of Object.entries({ zh, en, ja, ko })) {
      const own = Object.keys(dict).filter((k) => k.startsWith('tp.'))
      expect(own.sort(), `${name} 的 tp.* 键集`).toEqual([...keys].sort())
      for (const k of keys) {
        expect((dict as Record<string, string>)[k]?.trim(), `${name}.${k}`).toBeTruthy()
      }
    }
  })
})
