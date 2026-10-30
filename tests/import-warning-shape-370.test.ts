// V4-Iter-370 的常驻闸门：导入这一格的「码 ↔ 登记表 ↔ 四语」三头对账＋改前形状不许回来
//
// 盯的五件事：
//  · 码集合与渲染层登记表**两头钉**（少一个＝界面贴裸码；多一个＝有个码没人翻译）
//  · 登记表指向的每个键在四语字典都有，且句子本身不含裸码
//  · shared／handler 里不许再出现"含中文的 warning 字面量"（改前正是那个形状，四语看不见中文之外的用户）
//  · handler 的四类加总一句都不能漏（漏一类＝屏上的分类明细永远少一栏，而总数还是"对"的）
//  · 渲染层的消费点唯一，且 i18n 的 t() 仍是"函数第二参＋全局替换"（本批 H 组的镜像判据依赖它）
// 一律用 AST 而不是含斜杠的正则：注释里的中文会把字符扫描撑大（第 33 条）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import { IMPORT_WARNING_KEYS } from '../src/renderer/src/utils/import-summary'

const REPO = (...p: string[]): string => path.join(process.cwd(), ...p)
const SHARED_SRC = readFileSync(REPO('src', 'shared', 'conversation-import-external.ts'), 'utf8')
const HANDLER_SRC = readFileSync(REPO('src', 'main', 'ipc', 'handlers', 'conversations.ts'), 'utf8')
const CHAT_SRC = readFileSync(REPO('src', 'renderer', 'src', 'modules', 'chat', 'ChatModule.tsx'), 'utf8')
const I18N_SRC = readFileSync(REPO('src', 'renderer', 'src', 'i18n', 'index.tsx'), 'utf8')

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/

/** shared 源码里 `ExternalWarningCode` 联合的成员名 */
function unionMembers(text: string, name: string): string[] {
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === name && n.type.kind === ts.SyntaxKind.UnionType) {
      for (const t2 of (n.type as ts.UnionTypeNode).types) {
        if (ts.isLiteralTypeNode(t2) && t2.literal.kind === ts.SyntaxKind.StringLiteral) {
          out.push((t2.literal as ts.StringLiteral).text)
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(parse(text))
  return out
}

/**
 * 「这一发 warning 的产出是不是一个含中文的字面量／模板串」——改前的形状。
 * 认三种写法：`warnings.push('中文')`／`addWarning('中文')`／模板串 `` addWarning(`${x}: 中文`) ``。
 */
function chineseWarningLiterals(text: string): string[] {
  const out: string[] = []
  const literalHasCjk = (node: ts.Node | undefined): boolean => {
    if (!node) return false
    if (ts.isStringLiteral(node)) return CJK.test(node.text)
    if (ts.isNoSubstitutionTemplateLiteral(node)) return CJK.test(node.text)
    if (ts.isTemplateExpression(node)) return CJK.test(node.getText())
    return false
  }
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const isPush = ts.isPropertyAccessExpression(callee) && callee.name.text === 'push'
        && ts.isIdentifier(callee.expression) && callee.expression.text === 'warnings'
      const isAdd = ts.isIdentifier(callee) && callee.text === 'addWarning'
      if ((isPush || isAdd) && literalHasCjk(n.arguments[0])) out.push(n.getText().slice(0, 60))
    }
    ts.forEachChild(n, walk)
  }
  walk(parse(text))
  return out
}

/** handler 里 `dropped.<字段> +=` 的字段名（聚合是否四栏齐全） */
function droppedAggregations(text: string): string[] {
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (n.kind === ts.SyntaxKind.BinaryExpression) {
      const b = n as ts.BinaryExpression
      if (b.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
        && ts.isPropertyAccessExpression(b.left)
        && ts.isIdentifier(b.left.expression) && b.left.expression.text === 'dropped') {
        out.push(b.left.name.text)
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(parse(text))
  return out
}

const DICTS = { zh, en, ja, ko }
const CODES = unionMembers(SHARED_SRC, 'ExternalWarningCode')

describe('读法自证：三根机关都读得到东西，否则下面的 0 与 6 都可能是分类器瞎了', () => {
  it('shared 的码联合读得出成员（读空＝下面所有对账都在数空气）', () => {
    expect(CODES.length).toBe(6)
    expect(CODES).toContain('IMPORT_WRITE_FAILED')
  })

  it('改前那种中文串喂进同一个判据必须报出来（漏杀＝整面闸门无声变宽）', () => {
    const fixture = [
      "const warnings: string[] = []; warnings.push('不是有效的 JSON 文件')",
      'const addWarning = (w: string): void => {}; addWarning(`会话数超过上限 1000，多余会话已跳过`)',
      "const addWarning = (w: string): void => {}; addWarning(`${file.name}: 写入失败已跳过（SQLITE_FULL）`)"
    ].join('\n')
    expect(chineseWarningLiterals('function __f(): void {' + fixture + '}')).toHaveLength(3)
    // 反向对照：改后的写法（码＋槽）一条都不许报
    expect(chineseWarningLiterals("function __g(): void { warnings.push({ code: 'IMPORT_NOT_ARRAY' }); addWarning({ code: 'IMPORT_WRITE_FAILED', args: { err: 'x' }, where: '标题' }) }")).toHaveLength(0)
  })
})

describe('① 码 ↔ 登记表 ↔ 四语 三头对账', () => {
  it('码集合与登记表的键完全相等（少一个＝界面贴裸码；多一个＝有个码没人翻译）', () => {
    expect(Object.keys(IMPORT_WARNING_KEYS).sort()).toEqual([...CODES].sort())
  })

  it('登记表每个键在四语字典都各出现一次（缺一种语言就是那一界面上永远说不清）', () => {
    for (const [code, key] of Object.entries(IMPORT_WARNING_KEYS)) {
      for (const lang of Object.keys(DICTS) as Array<keyof typeof DICTS>) {
        const dict = DICTS[lang] as Record<string, string>
        expect(dict[key], `${lang} 缺 ${code} → ${key}`).toBeTruthy()
        expect(dict[key]!.length).toBeGreaterThan(3)
      }
    }
  })

  it('翻出来的句子本身不含裸码，也不把码当占位文案', () => {
    for (const key of Object.values(IMPORT_WARNING_KEYS)) {
      for (const lang of Object.keys(DICTS) as Array<keyof typeof DICTS>) {
        expect((DICTS[lang] as Record<string, string>)[key]!).not.toMatch(/IMPORT_[A-Z_]+/)
      }
    }
  })

  it('渲染层用到的固定句式键也四语齐（缺一句就拼不出出处／分类明细）', () => {
    const required = [
      'chat.importExternalWarnWhere',
      'chat.importExternalWarnUnknown',
      'chat.importExternalDropped',
      'chat.importExternalDropSep',
      'chat.importExternalDropBadJson',
      'chat.importExternalDropNotEvent',
      'chat.importExternalDropNonText',
      'chat.importExternalDropEmptyText'
    ]
    for (const key of required) {
      for (const lang of Object.keys(DICTS) as Array<keyof typeof DICTS>) {
        expect((DICTS[lang] as Record<string, string>)[key], `${lang} 缺 ${key}`).toBeTruthy()
      }
    }
    // 总数那句要两个槽：总数与明细（少一个就说不全）
    expect(zh['chat.importExternalDropped']).toContain('{n}')
    expect(zh['chat.importExternalDropped']).toContain('{kinds}')
    // 四类明细的槽名也要都对得上（helper 只喂 {n}）
    for (const key of ['chat.importExternalDropBadJson', 'chat.importExternalDropNotEvent', 'chat.importExternalDropNonText', 'chat.importExternalDropEmptyText']) {
      expect((zh as Record<string, string>)[key], key).toContain('{n}')
    }
  })
})

describe('② 改前的形状不许留在源码里', () => {
  it('shared 与 handler 里没有一句含中文的 warning 字面量', () => {
    expect(chineseWarningLiterals(SHARED_SRC)).toEqual([])
    expect(chineseWarningLiterals(HANDLER_SRC)).toEqual([])
  })
})

describe('③ 四类丢弃在 IPC 层真的都被加总', () => {
  it('handler 里 dropped.<字段> += 恰好是四栏、不重不漏', () => {
    expect(droppedAggregations(HANDLER_SRC).sort()).toEqual(
      ['badJson', 'emptyText', 'nonText', 'notEvent']
    )
  })

  it('漏杀对照：少写一栏的聚合在这套读法下要报出来（漏一类＝明细永远缺那一栏）', () => {
    const three = "function __h(): void { dropped.badJson += p.badJson; dropped.notEvent += p.notEvent; dropped.emptyText += p.emptyText }"
    expect(droppedAggregations(three).sort()).toEqual(['badJson', 'emptyText', 'notEvent'])
  })
})

describe('④ 消费点唯一＋插值机构还是那个形状', () => {
  it('渲染层只有 ChatModule 在用这两个函数，且旧那句"中文串直接 join 上屏"没了', () => {
    expect(CHAT_SRC).toContain('importDroppedText(r.droppedMessages, t)')
    expect(CHAT_SRC).toContain('importWarningText(w, t)')
    expect(CHAT_SRC).not.toContain('r.warnings.join')
  })

  it('i18n 的 t() 仍是"函数第二参＋全局替换"（本批 H 组镜像判据的前提）', () => {
    expect(I18N_SRC).toContain("`\\\\{${k}\\\\}`, 'g'")
    expect(I18N_SRC).toContain('() => String(v)')
  })
})
