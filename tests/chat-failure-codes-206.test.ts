// V4-Iter-206：主进程回码 ＋ 四语话术的对账闸门（同 V4-Iter-152/153 的口径）
//
// 背景：204 把 chat 发起族的失败接到界面上之后，失败**原文**（主进程中文）也会原样弹出来，
// 英/日/韩界面就中英夹拼。206 改成 main 抛 `CODE:中文说明`、渲染层只认冒号前的回码；
// 中文尾段留给日志与 IM 回复面（`channel-service.ts:221` 那条 catch 走的是同一句话）。
// 这类"两侧各有一份名单"的东西一定会漂移，所以两边都要断言，而不是只测映射函数本身。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_FAIL_TEXT_KEYS } from '../src/renderer/src/utils/ipc'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8')

/** `new Error('CODE:…')` / 模板串里的 `CODE:` 头，大小写敏感的蛇形大写 */
const CODE_PAT = /new Error\(\s*[`'"]([A-Z][A-Z0-9_]{2,})[:'"]/g

/**
 * 不映射到四语的回码白名单，**每条都得写清为什么**（否则这个名单会变成垃圾桶）。
 * APP_LOCKED：`lock/ipc-gate.ts` 直接在网关上 reject（不是 safeHandle 的返回值面），
 * 渲染层拿到的是 `Error invoking remote method …` 这种 reject 文本，且锁屏时根本发不出消息。
 */
const NOT_LOCALIZED: Record<string, string> = {
  APP_LOCKED: '走 reject 面（ipc-gate），不进 chat 失败文案那条路',
  // 翻译通道的旧回码：`TranslateModule.tsx:310` 自己先挡了空输入，所以它到不了界面；
  // 但那条通道的 preload 类型仍只写成功分支（196 那一族的旧形状）——记成台账 §206 的线索，不是本批要修的。
  GLOSSARY_TERM_EMPTY: '非 chat 发起族；界面本地已先挡空输入，回码到不了 UI（线索记在 §206）'
}

function codesInMain(): Map<string, string[]> {
  const root = path.resolve(__dirname, '../src/main')
  const out = new Map<string, string[]>()
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.endsWith('.ts')) {
        const src = read(p)
        for (const m of src.matchAll(CODE_PAT)) {
          const arr = out.get(m[1]!) ?? []
          arr.push(path.relative(root, p))
          out.set(m[1]!, arr)
        }
      }
    }
  }
  walk(root)
  return out
}

describe('主进程回码 ↔ 渲染层登记表 双向对账', () => {
  const found = codesInMain()

  it('main 里抛出的回码，要么登记了四语，要么在白名单里写明理由', () => {
    const unregistered: string[] = []
    for (const code of found.keys()) {
      if (code === 'BUDGET_EXCEEDED') continue // 特例：带 scope 与金额，走 usage.budgetBlocked
      if (CHAT_FAIL_TEXT_KEYS[code]) continue
      if (NOT_LOCALIZED[code]) continue
      unregistered.push(`${code}（${found.get(code)!.join(', ')}）`)
    }
    expect(unregistered, `新回码必须先在 chatSendFailureText 那侧登记话术`).toEqual([])
  })

  it('登记表里的回码，main 侧真的会抛出来（防"界面准备了一句永不出现的话"）', () => {
    const dead = Object.keys(CHAT_FAIL_TEXT_KEYS).filter((c) => !found.has(c))
    expect(dead).toEqual([])
  })

  it('BUDGET_EXCEEDED 仍在（它是这套约定的第一个形状），且三个新码各有出处', () => {
    expect(found.has('BUDGET_EXCEEDED')).toBe(true)
    for (const code of ['CHAT_NO_TARGET', 'CHAT_MSG_NOT_ASSISTANT', 'CHAT_MSG_NOT_USER']) {
      expect(found.get(code)!.join(','), code).toContain('chat-service.ts')
    }
  })
})

describe('四语话术齐备且不夹拼', () => {
  const dicts: Array<[string, Record<string, string>]> = [['zh', zh], ['en', en], ['ja', ja], ['ko', ko]]

  for (const [name, d] of dicts) {
    it(`${name}：三条都有、非空、不含冒号回码与前导空白`, () => {
      for (const key of Object.values(CHAT_FAIL_TEXT_KEYS)) {
        const s = d[key]
        expect(s, `${name}/${key}`).toBeTruthy()
        expect(s!.trim(), `${name}/${key}`).toBe(s)
        expect(s).not.toMatch(/^[A-Z_]+:/)
      }
    })
  }

  it('回码本身不出现在任何一本字典里（话术不该把 CODE 念给用户）', () => {
    for (const [, d] of dicts) {
      for (const key of Object.values(CHAT_FAIL_TEXT_KEYS)) {
        expect(d[key]).not.toMatch(/CHAT_NO_TARGET|CHAT_MSG_NOT_/)
      }
    }
  })
})
