// V4-Iter-206：主进程回码 ＋ 四语话术的对账闸门（同 V4-Iter-152/153 的口径）
// V4-Iter-208：登记表由 chat 一族扩成全局一张，白名单**清零**——清零之后这条闸门才是
//              "每个回码都必须有话术"，而不是"允许有解释不了的例外"。
//
// 背景：204 把 chat 发起族的失败接到界面上之后，失败**原文**（主进程中文）也会原样弹出来，
// 英/日/韩界面就中英夹拼。206 改成 main 抛 `CODE:中文说明`、渲染层只认冒号前的回码；
// 中文尾段留给日志与 IM 回复面（`channel-service.ts:221` 那条 catch 走的是同一句话）。
// 这类"两侧各有一份名单"的东西一定会漂移，所以两边都要断言，而不是只测映射函数本身。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ipcFailureText, IPC_FAIL_TEXT_KEYS } from '../src/renderer/src/utils/ipc'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8')

/**
 * 只抓 `CODE:中文说明` 这个形状（蛇形大写 ＋ 紧跟冒号）。
 * 故意不管的裸码：`lock/ipc-gate.ts:42` 的 `new Error('APP_LOCKED')`——它不带说明段、
 * 走的是网关 reject（渲染层拿到的是 `Error invoking remote method …: Error: APP_LOCKED`），
 * 不在这条"回码必须有话术"的网上；要收它得先决定 reject 面怎么本地化，那是另一件事。
 */
const CODE_PAT = /new Error\(\s*[`'"]([A-Z][A-Z0-9_]{2,}):/g


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

  it('main 里每个 `CODE:说明` 形状的回码都登记了四语（白名单已在 208 清零）', () => {
    const unregistered: string[] = []
    for (const code of found.keys()) {
      if (code === 'BUDGET_EXCEEDED') continue // 特例：带 scope 与金额，走 usage.budgetBlocked
      if (IPC_FAIL_TEXT_KEYS[code]) continue
      unregistered.push(`${code}（${found.get(code)!.join(', ')}）`)
    }
    expect(unregistered, `新回码必须先在 IPC_FAIL_TEXT_KEYS 登记话术`).toEqual([])
  })

  it('登记表里的回码，main 侧真的会抛出来（防"界面准备了一句永不出现的话"）', () => {
    const dead = Object.keys(IPC_FAIL_TEXT_KEYS).filter((c) => !found.has(c))
    expect(dead).toEqual([])
  })

  it('出处对账：三条在 chat-service，一条在 translate handler，BUDGET_EXCEEDED 仍在', () => {
    expect(found.has('BUDGET_EXCEEDED')).toBe(true)
    for (const code of ['CHAT_NO_TARGET', 'CHAT_MSG_NOT_ASSISTANT', 'CHAT_MSG_NOT_USER']) {
      expect(found.get(code)!.join(','), code).toContain('chat-service.ts')
    }
    expect(found.get('GLOSSARY_TERM_EMPTY')!.join(',')).toContain('translate.ts')
  })

  it('GLOSSARY_TERM_EMPTY 到界面是四语句子，回码与中文尾段都不进界面（V4-Iter-208）', () => {
    const dict = (key: string): string => (zh as unknown as Record<string, string>)[key] ?? key
    const s = ipcFailureText('GLOSSARY_TERM_EMPTY:术语表词条不能为空', dict)
    expect(s).toBe(dict('translate.glossaryTermEmpty'))
    expect(s).not.toContain('GLOSSARY_TERM_EMPTY')
    expect(s).not.toContain('术语表词条不能为空')
  })
})

describe('四语话术齐备且不夹拼', () => {
  const dicts: Array<[string, Record<string, string>]> = [['zh', zh], ['en', en], ['ja', ja], ['ko', ko]]

  for (const [name, d] of dicts) {
    it(`${name}：三条都有、非空、不含冒号回码与前导空白`, () => {
      for (const key of Object.values(IPC_FAIL_TEXT_KEYS)) {
        const s = d[key]
        expect(s, `${name}/${key}`).toBeTruthy()
        expect(s!.trim(), `${name}/${key}`).toBe(s)
        expect(s).not.toMatch(/^[A-Z_]+:/)
      }
    })
  }

  it('回码本身不出现在任何一本字典里（话术不该把 CODE 念给用户）', () => {
    for (const [, d] of dicts) {
      for (const key of Object.values(IPC_FAIL_TEXT_KEYS)) {
        expect(d[key]).not.toMatch(/CHAT_NO_TARGET|CHAT_MSG_NOT_|GLOSSARY_TERM_EMPTY/)
      }
    }
  })
})

describe('调用点接住了这条约定（V4-Iter-208）', () => {
  it('TranslateModule 判了 isIpcFail，失败对象不再被当成词条 append 进列表', () => {
    const src = read('../src/renderer/src/modules/translate/TranslateModule.tsx').replace(/\r\n/g, '\n')
    const start = src.indexOf('.saveGlossaryTerm(')
    expect(start, '找不到 saveGlossaryTerm 调用点').toBeGreaterThanOrEqual(0)
    const region = src.slice(start, start + 900)
    expect(region).toContain('isIpcFail(term)')
    expect(region).toContain('ipcFailureText(')
    // 顺序判据：判失败必须排在 setGlossary 之前，否则失败对象还是先进了列表
    expect(region.indexOf('isIpcFail')).toBeLessThan(region.indexOf('setGlossary'))
  })

  it('preload 的 saveGlossaryTerm 类型带上了失败分支', () => {
    const line = read('../src/preload/index.ts')
      .split('\n')
      .find((l) => l.includes('IPC.GLOSSARY_SAVE'))
    expect(line).toContain('Promise<GlossaryTerm | { ok: false; error: string }>')
  })
})
