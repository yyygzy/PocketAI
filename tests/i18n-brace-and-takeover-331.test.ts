// §331（源码级闸门）：括号形状、preload 类型、那一发提醒、以及"先取后清"的定位链
//
// 四面各守一个会漂回原样的形状：
//  · **括号闸门**：`i18n/index.tsx` 的 `t()` 只替换单花括号 `{k}`，而字典里另有 14 处**故意**写双花括号
//    （提示词模板标记 `{{knowledge}}`、变量插入标记 `{{name}}` 等，那些不经过 t 的 params）。
//    改前三颗被带参调用的键（`reminder.fired`／`reminder.missedSummary`／`agent.todoProgress`）也写成
//    `{{x}}` ⇒ 每次提醒到点、每个 todo 进度都渲染出字面大括号（「⏰ 提醒：{喝水}」「{2}/{5} 已完成」）。
//    判据两头钉：带参的键不许有双括号；那 14 颗模板键**必须**还有双括号（防"一把全改"把口径改坏）。
//  · **preload 类型**：三条改前只写成功形状的记录类通道，类型必须带 `{ok:false}` 那一支（tsc 才会逼调用点判）。
//  · **消息右键建提醒那一发**：判了失败并接管（改前整个返回值不接，失败也报「已设置提醒」）。
//  · **定位链**：消费 jumpFocus 时先把 seq 取成局部读数、再清 pending（改前同批清空 ⇒ ChunkPreview 拿到 null）。
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

const SRC = (p: string): string => path.resolve(__dirname, '..', 'src', p)
const read = (p: string): string => fs.readFileSync(SRC(p), 'utf8').replace(/\r\n/g, '\n')

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

const DICTS = ['zh', 'en', 'ja', 'ko'] as const

/** 源码里以 `t('key', { … })` 形式（第二个实参存在＝带参）被调用的键 */
function parametrizedKeys(): Set<string> {
  const keys = new Set<string>()
  const files: string[] = []
  const scan = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) scan(p)
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
    }
  }
  scan(SRC('renderer/src'))
  for (const f of files) {
    const sf = ts.createSourceFile(f, read(path.relative(SRC(''), f).replace(/\\/g, '/')), ts.ScriptTarget.Latest, true)
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || n.arguments.length < 2) return
      if (!(ts.isIdentifier(n.expression) && n.expression.text === 't')) return
      const a = n.arguments[0]
      if (!a || !ts.isStringLiteral(a)) return
      keys.add(a.text)
    })
  }
  return keys
}

/** 字典里值带双花括号的键（按行取，注释不参与——注释不带 `'key': '…'` 形状） */
function doubleBraceKeys(lang: string): Set<string> {
  const out = new Set<string>()
  for (const line of read(`renderer/src/i18n/${lang}.ts`).split('\n')) {
    const m = line.match(/^\s*'([^']+)':\s*'(.*)',\s*$/)
    const key = m ? m[1] : undefined
    const value = m ? m[2] : undefined
    if (key !== undefined && value !== undefined && value.includes('{{')) out.add(key)
  }
  return out
}

describe('331 括号闸门：带参的键不许写双花括号', () => {
  const used = parametrizedKeys()

  it('带参调用的键，四语值里都不许出现 {{（出现就等于给用户渲染字面大括号）', () => {
    for (const lang of DICTS) {
      const bad = [...doubleBraceKeys(lang)].filter((k) => used.has(k))
      expect(bad, `${lang} 下这些键带参却被写成双括号`).toEqual([])
    }
  })

  it('反向钉：那 14 颗模板标记键必须仍是双括号（不许被"顺手全改"清空）', () => {
    const TEMPLATES = [
      'snippet.contentPh', 'snippet.hint',
      'ae.var.date', 'ae.var.time', 'ae.var.weekday', 'ae.var.user', 'ae.var.knowledge', 'ae.var.tools', 'ae.var.skills',
      'ae.kbLabel', 'ae.toolsLabel', 'ae.skillsLabel',
      'skill.usageHint', 'ccb.kbHint'
    ]
    for (const lang of DICTS) {
      const dbl = doubleBraceKeys(lang)
      expect([...dbl].sort(), lang).toEqual([...TEMPLATES].sort())
    }
  })

  it('三颗被改回单括号的键，值里仍带着自己的参数位（不许改成没占位符）', () => {
    const zh = read('renderer/src/i18n/zh.ts')
    expect(zh).toContain("'reminder.fired': '⏰ 提醒：{text}'")
    expect(zh).toContain("'reminder.missedSummary': '有 {count} 条")
    expect(zh).toContain("'agent.todoProgress': '{done}/{total} 已完成'")
  })
})

describe('331 记录类通道的 preload 类型带失败分支', () => {
  const PRELOAD = 'preload/index.ts'
  const CHANNELS = ['createReminder', 'renameKbDocument', 'updateKbDocText', 'getKbAskSession']

  it('四条方法各自的返回类型里都写着 ok: false', () => {
    const src = read(PRELOAD)
    const sf = ts.createSourceFile(SRC(PRELOAD), src, ts.ScriptTarget.Latest, true)
    const found = new Map<string, string>()
    walk(sf, (n) => {
      if (!ts.isPropertyAssignment(n) || !ts.isIdentifier(n.name)) return
      if (!CHANNELS.includes(n.name.text)) return
      if (ts.isArrowFunction(n.initializer) && n.initializer.type) {
        found.set(n.name.text, n.initializer.type.getText(sf))
      }
    })
    for (const ch of CHANNELS) {
      const typeText = found.get(ch)
      expect(typeText, `${ch} 的声明找不到了（改名或整条被搬走）`).toBeTruthy()
      expect(typeText!).toContain('ok: false')
    }
  })
})

describe('331 消息右键建提醒那一发：判了并接管', () => {
  const src = read('renderer/src/modules/chat/ChatModule.tsx')

  it('createReminder 那一发的结果被 hasIpcFailed 判掉，判完就 return 且说一句话', () => {
    const sf = ts.createSourceFile(SRC('renderer/src/modules/chat/ChatModule.tsx'), src, ts.ScriptTarget.Latest, true)
    let site: ts.Node | null = null
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && n.expression.getText().endsWith('.createReminder')) {
        let up: ts.Node | undefined = n.parent
        while (up) {
          if (ts.isArrowFunction(up) || ts.isFunctionDeclaration(up)) {
            site = up
            break
          }
          up = up.parent
        }
      }
    })
    expect(site, '找不到 createReminder 的调用点').toBeTruthy()
    // **逐条 IfStatement 成对判**（第 32 条）：改前这里把整个函数里所有 if 的 return／toast.error 汇成一个总数，
    // 于是同一函数上面那句无关的 `if (!text) { toast.error; return }` 就把判定喂绿了——
    // W12（把 hasIpcFailed 那句的 return 换成 console.log＝判了不接管）活了下来。
    const judged: Array<{ cond: string; returns: boolean; speaks: boolean }> = []
    walk(site!, (m) => {
      if (!ts.isIfStatement(m)) return
      const cond = m.expression.getText()
      if (!cond.includes('hasIpcFailed')) return
      let returns = false
      let speaks = false
      walk(m.thenStatement, (s) => {
        if (ts.isReturnStatement(s)) returns = true
        if (ts.isCallExpression(s) && s.expression.getText() === 'toast.error') speaks = true
      })
      judged.push({ cond, returns, speaks })
    })
    expect(judged.length, '那一发没判信封 ⇒ 失败照样报成功').toBeGreaterThan(0)
    const taken = judged.filter((j) => j.returns && j.speaks)
    expect(taken.length, '判了不接管＝失败往下走照样弹提示（或接管了却没说话）').toBe(judged.length)
  })

  it('反向钉：这一发不许只挂 .catch（safeHandle 的失败是 resolve 的值，catch 永不触发）', () => {
    const at = src.indexOf('.createReminder({')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('\n  }', at) > 0 ? src.indexOf('\n  }', at) : at + 900)
    expect(body).toContain('hasIpcFailed')
  })
})

describe('331 定位链：先取后清', () => {
  /** 预览那颗 `focusSeq=` 的实参文本——**读 JSX 属性，不对原文 regex**：第 33 条在自家注释上复发了一次
   *  （我那句解释性注释里就写着改前的 `focusSeq={jumpFocus?.seq}`，按行数会把注释算成一个站点） */
  function focusProps(src: string, file: string): string[] {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
    const out: string[] = []
    walk(sf, (n) => {
      if (!ts.isJsxAttribute(n) || n.name.getText() !== 'focusSeq') return
      const init = n.initializer
      if (!init || !ts.isJsxExpression(init) || !init.expression) return
      out.push(init.expression.getText())
    })
    return out
  }

  const FILE = 'renderer/src/modules/knowledge/KnowledgeModule.tsx'
  const src = read(FILE)

  const inspect = (s: string): { takes: boolean; before: boolean } => {
    const at = s.indexOf('const seq = jumpFocus.seq')
    const setAt = s.indexOf('setPreviewFocusSeq(seq)')
    const clears = s.indexOf('onJumpHandled?.()')
    return { takes: at > -1, before: at > -1 && setAt > -1 && setAt < clears }
  }

  it('消费那一趟里先把 seq 取成局部读数、再清 pending', () => {
    const got = inspect(src)
    expect(got.takes, '没找到"先取"那一步').toBe(true)
    expect(got.before, '先清 pending 再取值＝ChunkPreview 挂载时已经拿不到目标分块').toBe(true)
  })

  it('预览只读自己那份读数（focusSeq 的实参恰一处、且不是 jumpFocus）', () => {
    const props = focusProps(src, FILE)
    expect(props, '全文件的 focusSeq 传参').toEqual(['previewFocusSeq'])
  })

  it('漏杀对照：改回"当场读 jumpFocus"（改前形状）⇒ 两条判据各判红', () => {
    const back = src
      .replace('const seq = jumpFocus.seq\n    setAskMode(false)\n    setPreviewFocusSeq(seq)', 'setAskMode(false)\n    setPreviewFocusSeq(jumpFocus.seq)')
      .replace('focusSeq={previewFocusSeq}', 'focusSeq={jumpFocus?.seq ?? null}')
    expect(back, '手术没落到盘上＝对照无效').not.toBe(src)
    expect(inspect(back).takes, '"先取"那一步被抹掉了，判据要红').toBe(false)
    expect(focusProps(back, FILE), '假源码又去读那份会被同一批清空的 jumpFocus').toEqual(['jumpFocus?.seq ?? null'])
  })
})
