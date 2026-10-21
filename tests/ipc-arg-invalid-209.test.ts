// V4-Iter-209：入参校验的中文消息回码化 ＋ 四语，并保住"看不清就回落中文"这条路
//
// 形状：safeHandle 的 zod 失败返回 `{ ok:false, error:<中文人话>, ipcCode:'IPC_ARG_INVALID', ipcArgs:<path=code=origin=bound>|… }`
//      → 走翻译的调用点读 `ipcCode`/`ipcArgs` 换四语，解析不出来就显示 `error`。
// 为什么回码必须**另开字段、不拼进 error**（这条是整个设计的前提）：渲染层 137 处 `toast.error(…)`
// 加 21 处 `ipcFailText(…)` 直接显示 `error`，走翻译的只有 4 个调用点（6 条链）；把回码塞进那根字符串
// 会让那 150 余处从中文退化成 `IPC_ARG_INVALID:…`，那是净倒退。
// 所以这里既要证"翻译生效"，也要证"error 那根串永远是干净的人话"。
import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn)
    }
  }
}))

import { z } from 'zod'
import { argsSchema, safeHandle } from '../src/main/ipc/safe-handle'
import { glossarySaveSchema } from '../src/shared/schemas/translate'
import { ipcFailureText } from '../src/renderer/src/utils/ipc'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8')
const CH = 'test:arg209'
const eventStub = { sender: {} }

/** 主进程给界面的失败对象（ipcCode/ipcArgs 只在能无损编码时才出现） */
interface Fail {
  ok?: boolean
  error?: string
  ipcCode?: string
  ipcArgs?: string
}

const invoke = (...args: unknown[]): Fail => mocks.handlers.get(CH)!(eventStub, ...args) as unknown as Fail

const dictT =
  (d: Record<string, string>) =>
  (key: string, params?: Record<string, string | number>): string =>
    Object.entries(params ?? {}).reduce(
      (s, [k, v]) => s.replace(`{${k}}`, String(v)),
      d[key] ?? key
    )
const tZh = dictT(zh as unknown as Record<string, string>)
const tEn = dictT(en as unknown as Record<string, string>)

/** 起一个真的 safeHandle 通道，用给定 schema 校验给定参数，返回界面拿到的整个失败对象 */
async function failOf(schema: z.ZodTypeAny, ...args: unknown[]): Promise<Fail> {
  mocks.handlers.clear()
  safeHandle(CH, () => ({ ok: true as const }), argsSchema(schema))
  return invoke(...args)
}

describe('主进程产出 → 渲染层解析：两侧话术逐字对齐', () => {
  it('字符串过短：回码在独立字段里，error 仍是那句纯中文', async () => {
    const f = await failOf(z.object({ name: z.string().min(1) }), { name: '' })
    expect(f).toEqual({
      ok: false,
      error: '名称至少需要 1 个字符',
      ipcCode: 'IPC_ARG_INVALID',
      ipcArgs: 'name=too_small=string=1'
    })
    expect(f.error).not.toContain('IPC_ARG_INVALID')
    expect(ipcFailureText(f, tZh)).toBe('名称至少需要 1 个字符')
  })

  it('数值／数组／类型／格式四种形状各证一条', async () => {
    const cases: Array<[z.ZodTypeAny, unknown[], string, string]> = [
      [z.object({ opacity: z.number().max(5) }), [{ opacity: 9 }], 'opacity=too_big=number=5', 'opacity不能大于 5'],
      [z.object({ apiKeys: z.array(z.string()).min(1) }), [{ apiKeys: [] }], 'apiKeys=too_small=array=1', 'API Key至少需要 1 项'],
      [z.object({ content: z.string() }), [{ content: 7 }], 'content=invalid_type==string', '内容类型不对（应为 string）'],
      [z.object({ baseUrl: z.url() }), [{ baseUrl: 'nope' }], 'baseUrl=invalid_format==', 'Base URL格式不正确']
    ]
    for (const [schema, args, token, zhText] of cases) {
      const f = await failOf(schema, ...args)
      expect(f.ipcArgs, token).toBe(token)
      expect(f.ipcCode, token).toBe('IPC_ARG_INVALID')
      expect(f.error, token).toBe(zhText)
      expect(ipcFailureText(f, tZh), token).toBe(zhText)
    }
  })

  it('多条 issue：回码用 | 分条、话术用「；」串起来，顺序一致', async () => {
    const f = await failOf(z.object({ name: z.string().min(3), title: z.string().min(2) }), { name: 'a', title: '' })
    expect(f.ipcArgs).toBe('name=too_small=string=3|title=too_small=string=2')
    expect(f.error).toBe('名称至少需要 3 个字符；标题至少需要 2 个字符')
    expect(ipcFailureText(f, tZh)).toBe('名称至少需要 3 个字符；标题至少需要 2 个字符')
  })

  it('映射不到的字段名：两侧都显示原 key（不编中文名）', async () => {
    const f = await failOf(z.object({ weirdKey: z.string().max(3) }), { weirdKey: 'abcdef' })
    expect(ipcFailureText(f, tZh)).toBe('weirdKey过长，最多 3 个字符')
  })

  it('换到 en／ja／ko 才是各自的话（同一条回码，不再夹中文）', async () => {
    const f = await failOf(z.object({ name: z.string().min(1) }), { name: '' })
    const enText = ipcFailureText(f, tEn)
    expect(enText).toBe('Name needs at least 1 characters')
    expect(enText).not.toContain('至少需要')
    expect(ipcFailureText(f, dictT(ja as unknown as Record<string, string>))).toContain('名前')
    expect(ipcFailureText(f, dictT(ko as unknown as Record<string, string>))).toContain('이름')
  })

  it('回码对象能穿过 IPC 结构化克隆（字段不会被吃掉）', async () => {
    const f = await failOf(z.object({ name: z.string().min(1) }), { name: '' })
    expect(ipcFailureText(structuredClone(f), tZh)).toBe('名称至少需要 1 个字符')
  })

  it('真 schema 走一遍：GLOSSARY_SAVE 的超长术语是这条链上唯一"没自定义文案"的门槛（四语 key 不是死键）', async () => {
    mocks.handlers.clear()
    safeHandle(CH, () => ({ ok: true as const }), argsSchema(glossarySaveSchema))
    const f = await invoke({ sourceTerm: 'x'.repeat(201), targetTerm: 'ok' })
    expect(f).toEqual({
      ok: false,
      error: 'sourceTerm过长，最多 200 个字符',
      ipcCode: 'IPC_ARG_INVALID',
      ipcArgs: 'sourceTerm=too_big=string=200'
    })
    // 字段名不在标签表里 ⇒ 三语都显示原 key（不编中文名），句式本身换成界面语言
    expect(ipcFailureText(f, tEn)).toBe('sourceTerm is too long — max 200 characters')
    expect(ipcFailureText(f, tZh)).toBe('sourceTerm过长，最多 200 个字符')
    // 同一门槛的短术语走自定义文案 ⇒ 无回码 ⇒ 界面保持中文（术语表那条链的常见失败是 GLOSSARY_TERM_EMPTY，由 206 的登记表翻译）
    const g = await invoke({ sourceTerm: '', targetTerm: 'ok' })
    expect(g.ipcCode).toBeUndefined()
    expect(g.error).toBe('源术语不能为空')
  })
})

describe('不该编码的三种情况：整条不给回码字段，不出现半截可解析', () => {
  it('schema 自定义过文案 ⇒ 无回码（通用句式不许盖掉作者措辞）', async () => {
    const f = await failOf(z.object({ text: z.string().min(1, '文本不能为空') }), { text: '' })
    expect(f.error).toBe('文本不能为空')
    expect(f.ipcCode).toBeUndefined()
    expect(f.ipcArgs).toBeUndefined()
    expect(ipcFailureText(f, tEn)).toBe('文本不能为空')
  })

  it('枚举取值 ⇒ 无回码，「（可选：a / b）」那份清单原样留着', async () => {
    const f = await failOf(z.object({ type: z.enum(['a', 'b']) }), { type: 'x' })
    expect(f.ipcCode).toBeUndefined()
    expect(f.error).toContain('（可选：a / b）')
  })

  it('一条能编、一条不能编 ⇒ 整条都不给回码', async () => {
    const f = await failOf(z.object({ name: z.string().min(1), type: z.enum(['a', 'b']) }), { name: '', type: 'x' })
    expect(f.ipcCode).toBeUndefined()
    expect(f.error).toBe('名称至少需要 1 个字符；类型取值不在允许范围内（可选：a / b）')
  })
})

describe('渲染层的回落必须安全（不抛、不留半截回码、不泄英文 key）', () => {
  const tail = '名称至少需要 1 个字符'
  // 每条都用 **en** 判定：回落成功＝显示那句中文；翻译成功＝绝不会是那句中文。用 zh 判会两边同形、白测。
  it.each<[string, Fail]>([
    ['token 段数不对', { error: tail, ipcCode: 'IPC_ARG_INVALID', ipcArgs: 'name=too_small' }],
    ['没见过 code', { error: tail, ipcCode: 'IPC_ARG_INVALID', ipcArgs: 'name=mystery_code=string=1' }],
    ['没见过 origin', { error: tail, ipcCode: 'IPC_ARG_INVALID', ipcArgs: 'name=too_small=weird=1' }],
    ['空 token 表', { error: tail, ipcCode: 'IPC_ARG_INVALID', ipcArgs: '' }],
    ['回码不是入参校验', { error: tail, ipcCode: 'SOMETHING_ELSE', ipcArgs: 'name=too_small=string=1' }]
  ])('%s ⇒ 回落到 error 那句中文（en 界面宁可夹中文）', (_name, f) => {
    const out = ipcFailureText(f, tEn)
    expect(out).toBe(tail)
    expect(out).not.toContain('IPC_ARG_INVALID')
    expect(out).not.toBe('')
  })

  it('只有 error 的老形状（provider 抛错、reject 文案）原样透出', () => {
    expect(ipcFailureText({ error: tail }, tZh)).toBe(tail)
    expect(ipcFailureText(tail, tZh)).toBe(tail)
  })

  it('error 缺失时 helper 给空串——所以调用点一律带兜底文案（见下一条闸门）', () => {
    expect(ipcFailureText({ ipcCode: 'IPC_ARG_INVALID', ipcArgs: 'name=too_small=string=1|nope' }, tZh)).toBe('')
  })

  it('能解析时绝不把回码字段泄进结果', () => {
    const f: Fail = { error: tail, ipcCode: 'IPC_ARG_INVALID', ipcArgs: 'name=too_small=string=1' }
    expect(ipcFailureText(f, tZh)).toBe(tail)
    const outEn = ipcFailureText(f, tEn)
    expect(outEn).not.toBe(tail)
    expect(outEn).not.toContain('至少需要')
    expect(outEn).not.toContain('ipc.arg')
  })
})

describe('走翻译那几个文件的调用点：接线形状闸门', () => {
  const files = [
    '../src/renderer/src/modules/chat/ChatModule.tsx',
    '../src/renderer/src/modules/agent/hooks/useAgentChat.ts',
    '../src/renderer/src/popup/PopupApp.tsx',
    '../src/renderer/src/modules/translate/TranslateModule.tsx'
  ]
  // 第一个实参必须是**整个失败对象**（裸标识符），不能是 `x.error`／`ipcFailText(x, …)`——那样 ipcCode 就丢了
  const CALL = /(?:ipcFailureText|chatSendFailureText)\(\s*([A-Za-z_]\w*)\s*,\s*t\s*\)/g
  const sites: Array<{ file: string; line: string; arg: string }> = []
  for (const rel of files) {
    for (const line of read(rel).split(/\r?\n/)) {
      if (line.trimStart().startsWith('import ')) continue
      for (const m of line.matchAll(CALL)) sites.push({ file: rel, line, arg: m[1]! })
    }
  }

  it('正好八处在调这两个 helper（少一处＝闸门空转，多一处＝没登记）', () => {
    // 4 → 7：V4-Iter-217 给 TranslateModule 的删除翻译／清空历史／删除术语表词条三处补上了失败判定，
    // 用的是本文件立的同一个收口 helper（而不是 ipcFailText），这样将来这些通道回码化时界面不用再改。
    // 7 → 8：V4-Iter-238 的插队失败那一发（RUN_NOT_FOUND 与 zod 挡下来都走同一条口）。
    expect(sites.length).toBe(8)
    expect(sites.map((s) => s.arg).sort()).toEqual(['msg', 'msg', 'msg', 'msg', 'r', 'r', 'r', 'term'])
  })

  it('每处都带 `|| t(…)` 兜底（error 为空时不许弹一句空 toast）', () => {
    for (const s of sites) {
      expect(s.line, `${s.file}: ${s.line.trim()}`).toMatch(/\|\|\s*t\('/)
    }
  })

  it('发起链把失败对象整个交给收口函数，不再先抽 error 字符串', () => {
    const chat = read('../src/renderer/src/modules/chat/ChatModule.tsx')
    expect(chat).toContain('onChatSendFailed(requestId, convId, r)')
    expect(chat).toContain('onChatSendFailed(requestId, currentConvId, r)')
    expect(chat).not.toContain('onChatSendFailed(requestId, currentConvId, ipcFailText')
  })

  it('主进程侧不许再把回码拼进 error 串（旧形状已被这条设计否掉）', () => {
    expect(read('../src/main/ipc/safe-handle.ts')).not.toMatch(/IPC_ARG_INVALID:/)
  })
})

describe('两侧名单不许漂移（字段名与句式 key）', () => {
  const ipcSrc = read('../src/renderer/src/utils/ipc.ts')
  const fieldBlock = /const ARG_FIELD_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(ipcSrc)?.[1] ?? ''
  const rendererFields = [...fieldBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
  const mainSrc = read('../src/main/ipc/safe-handle.ts')
  const labelBlock = /const ISSUE_FIELD_LABELS: Record<string, string> = \{([\s\S]*?)\n\}/.exec(mainSrc)?.[1] ?? ''
  const mainFields = [...labelBlock.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((m) => m[1]!)

  it('渲染层认识的字段名与主进程标签表是同一批（少一个就会漏翻译，多一个就是死键）', () => {
    expect(rendererFields.length).toBeGreaterThan(0)
    expect([...rendererFields].sort()).toEqual([...mainFields].sort())
  })

  it('主进程每个字段都有四语标签，且非空', () => {
    for (const d of [zh, en, ja, ko] as Array<Record<string, string>>) {
      for (const f of mainFields) {
        expect(d[`ipc.field.${f}`], `ipc.field.${f}`).toBeTruthy()
      }
    }
  })

  it('句式 key 全部登记在字典里（拼错即红）', () => {
    const shapeBlock = /const ARG_SHAPE_KEYS: Record<string, string> = \{([\s\S]*?)\n\}/.exec(ipcSrc)?.[1] ?? ''
    const keys = [...shapeBlock.matchAll(/'(ipc\.arg[A-Za-z]*)'/g)].map((m) => m[1]!)
    expect(keys.length).toBe(6)
    for (const d of [zh, en, ja, ko] as Array<Record<string, string>>) {
      for (const k of [...keys, 'ipc.argType', 'ipc.argFormat', 'ipc.argUnnamed']) {
        expect(d[k], k).toBeTruthy()
        expect(d[k]!.trim(), k).toBe(d[k])
      }
    }
    // 每条句式都得同时带 {field} 与 {n}（少了占位符就会拼出缺主语的残句）
    const zhDict = zh as unknown as Record<string, string>
    for (const k of keys) {
      expect(zhDict[k], k).toContain('{field}')
      expect(zhDict[k], k).toContain('{n}')
    }
  })

  it('主进程编码出来的 code／origin 集合，渲染层句式表都得认识（否则永远回落中文）', () => {
    const coded = /const ARG_SHAPE_KEYS[\s\S]*?\n\}/.exec(ipcSrc)?.[0] ?? ''
    for (const origin of ['string', 'number', 'array']) {
      for (const code of ['too_small', 'too_big']) {
        expect(coded, `${code}|${origin}`).toContain(`'${code}|${origin}'`)
      }
    }
    expect(ipcSrc).toContain("'invalid_type'")
    expect(ipcSrc).toContain("'invalid_format'")
  })
})
