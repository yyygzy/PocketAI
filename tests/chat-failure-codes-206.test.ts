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
 * `CODE:中文说明` 这个形状（蛇形大写 ＋ 紧跟冒号）。
 * V4-Iter-243：下面还有一条 BARE_CODE_PAT——真机点"还原到写入前"时撞出三个**光秃秃**的
 * `SNAPSHOT_*` 码，它们从这条闸门的缝里漏了出去（正则要求冒号，没冒号就什么都看不见），
 * 于是界面把 `SNAPSHOT_DIVERGED` 直接弹给了用户。裸码从此也算回码，例外只留下面那一条。
 */
const CODE_PAT = /new Error\(\s*[`'"]([A-Z][A-Z0-9_]{2,}):/g
/** 光秃秃的大写码：整串就是一个回码，不带说明段 */
const BARE_CODE_PAT = /new Error\(\s*[`'"]([A-Z][A-Z0-9_]{2,})[`'"]\s*\)/g

/**
 * 唯一在册例外，且**钉死它的出处与形态**：`lock/ipc-gate.ts` 的锁网关 reject——
 * 它包在 safeHandle 外面，渲染层拿到的是 `Error invoking remote method …: Error: APP_LOCKED`
 * 整串，不在这条"回码必须有话术"的网上；要收它得先决定 reject 面怎么本地化，那是另一件事。
 * 想再加例外就得先回答这个问题，所以这里断言"它还在原处、还是这条 throw"，不许漂移。
 */
const BARE_EXCEPTIONS: ReadonlyArray<{ code: string; file: string; line: string }> = [
  {
    code: 'APP_LOCKED',
    file: 'lock/ipc-gate.ts',
    line: "throw new Error('APP_LOCKED')"
  }
]

function codesInMain(): Map<string, string[]> {
  const root = path.resolve(__dirname, '../src/main')
  const out = new Map<string, string[]>()
  const add = (code: string, rel: string): void => {
    const arr = out.get(code) ?? []
    if (!arr.includes(rel)) arr.push(rel)
    out.set(code, arr)
  }
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.endsWith('.ts')) {
        const src = read(p)
        const rel = path.relative(root, p).replace(/\\/g, '/')
        for (const m of src.matchAll(CODE_PAT)) add(m[1]!, rel)
        for (const m of src.matchAll(BARE_CODE_PAT)) add(m[1]!, rel)
      }
    }
  }
  walk(root)
  return out
}

describe('主进程回码 ↔ 渲染层登记表 双向对账', () => {
  const found = codesInMain()

  it('main 里每个回码（带说明的与光秃秃的）都登记了四语（白名单已在 208 清零）', () => {
    const unregistered: string[] = []
    for (const code of found.keys()) {
      if (code === 'BUDGET_EXCEEDED') continue // 特例：带 scope 与金额，走 usage.budgetBlocked
      if (BARE_EXCEPTIONS.some((e) => e.code === code)) continue
      if (IPC_FAIL_TEXT_KEYS[code]) continue
      unregistered.push(`${code}（${found.get(code)!.join(', ')}）`)
    }
    expect(unregistered, `新回码必须先在 IPC_FAIL_TEXT_KEYS 登记话术`).toEqual([])
  })

  it('裸码例外只有那一条，且它还钉在原处（V4-Iter-243 把这条缝补上后新加的钉子）', () => {
    expect(BARE_EXCEPTIONS.map((e) => e.code).sort()).toEqual(['APP_LOCKED'])
    for (const e of BARE_EXCEPTIONS) {
      const src = read(`../src/main/${e.file}`).replace(/\r\n/g, '\n')
      expect(src.split('\n').some((l) => l.trim() === e.line), `${e.file} 里找不到 ${e.line}`).toBe(true)
      // 它也真的会被扫到——否则"例外"就成了给一个不存在的码开的空白支票
      expect(found.get(e.code) ?? [], e.code).toContain(e.file)
    }
    // 反向对照：带 `:说明` 的形状不会被这条例外放过（BUDGET_EXCEEDED 也不在例外名单里）
    expect(BARE_EXCEPTIONS.some((e) => e.code === 'SNAPSHOT_DIVERGED')).toBe(false)
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

  it('V4-Iter-243 那五个补上话术的码，出处对账（证明扩形后的闸门真看得见这两个文件）', () => {
    for (const code of ['SNAPSHOT_ID_INVALID']) {
      expect(found.get(code)!.join(','), code).toContain('file-snapshots.ts')
    }
    for (const code of ['SNAPSHOT_NOT_FOUND', 'SNAPSHOT_CONSUMED', 'SNAPSHOT_DIVERGED', 'CURRENT_NOT_TEXT']) {
      expect(found.has(code), code).toBe(true)
    }
    expect(found.get('SNAPSHOT_NOT_FOUND')!.join(',')).toContain('fs-tools.ts')
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
