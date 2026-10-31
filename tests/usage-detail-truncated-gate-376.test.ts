// V4-Iter-376 常驻闸门：用量明细对话框不许把「截断页的合计」当「全量合计」上屏。
//
// producer（usage-service.listUsageDetail）已经老实回 {items, truncated}、IPC/preload 一路带到渲染层，
// 但 UsagePanel 的两个 openDetail 若只 setDetailItems(r.items)、不接 r.truncated ⇒ footer 无条件 reduce
// ⇒ >EXPORT_LIMIT 的窗口里那个合计是**少算的假总数**（§376 的靶）。
//
// 三处各钉一颗（对齐 §345/§350「读不到那张脸」族的分诊：footer 是聚合位＝必须显式带出处）：
// ① 每个 loader 成功分支都把 r.truncated 落到 state（不是只看 r.items）
// ② 每次开弹窗先重置 detailTruncated=false（否则上一发的 true 会漏进下一发的没截断结果＝谎报）
// ③ footer 的 caveat 行绑在 detailTruncated 条件里（不是无条件下面挂一句、也不是恒显）
// 加：④ 键名＋{limit} 占位符四语都在、⑤ 消费点用的是字典键不是硬写中文。
// UsagePanel 真挂载要几十个 IPC 桩、成本高到不值（§214 台账原话），本批走源码级判据＝如实写进台账。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const UP = path.join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'settings', 'UsagePanel.tsx')
const SRC = readFileSync(UP, 'utf8')

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true)
}

/** 取 `const <name> = useCallback(async (…) => { … }, [deps])` 那个箭头函数的体文本 */
function callbackBodyOf(name: string): string {
  let out = ''
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      const init = n.initializer
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useCallback') {
        const cb = init.arguments[0]
        if (cb && ts.isArrowFunction(cb) && ts.isBlock(cb.body)) out = cb.body.getText()
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(parse(SRC))
  return out
}

const LOADERS = ['openDetail', 'openAsstDetail'] as const

describe('读法自证：分类器读得到两个 loader 的 useCallback 箭头体', () => {
  for (const name of LOADERS) {
    it(`${name} 的 useCallback 体取到（空＝下面判定全在数空气）`, () => {
      const body = callbackBodyOf(name)
      expect(body, name).not.toBe('')
      expect(body).toContain('getUsageDetail') // 体里真有那一发
    })
  }
  // 漏杀对照：把 loader 换回改前那一形（只 setDetailItems、不管 truncated）⇒ 读法认得出「没请出 truncated」
  it('漏杀对照：改前那一形（else 里只写 items、根本不读 r.truncated）在这套读法下要被认成"没接住 flag"', () => {
    const OLD = `const openDetail = useCallback(async (id: string, title: string) => {
  setDetail({ title, showConv: false })
  setDetailLoading(true)
  setDetailItems([])
  const r = await window.pocketai.getUsageDetail(days, 1, id)
  if (!r.ok) toast.error('x')
  else setDetailItems(r.items)
}, [days])`
    const body = (() => {
      let out = ''
      const walk = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'openDetail' && n.initializer && ts.isCallExpression(n.initializer)) {
          const cb = n.initializer.arguments[0]
          if (cb && ts.isArrowFunction(cb) && ts.isBlock(cb.body)) out = cb.body.getText()
        }
        ts.forEachChild(n, walk)
      }
      walk(parse(OLD))
      return out
    })()
    expect(body).not.toBe('')
    expect(body).not.toMatch(/setDetailTruncated\s*\(\s*r\.truncated\s*\)/)
  })
})

describe('① 两个 loader 的成功分支都把 r.truncated 落到 state', () => {
  for (const name of LOADERS) {
    it(`${name}：setDetailTruncated(r.truncated) 在体内`, () => {
      expect(callbackBodyOf(name)).toMatch(/setDetailTruncated\s*\(\s*r\.truncated\s*\)/)
    })
  }
})

describe('② 两个 loader 一开先重置 detailTruncated=false（防上一发的 true 漏进没截断的结果）', () => {
  for (const name of LOADERS) {
    it(`${name}：await 之前先 setDetailTruncated(false)`, () => {
      const body = callbackBodyOf(name)
      const reset = body.indexOf('setDetailTruncated(false)')
      const call = body.indexOf('getUsageDetail')
      expect(reset, '必须重置').toBeGreaterThanOrEqual(0)
      expect(reset, '重置要排在 await 之前').toBeLessThan(call)
    })
  }
})

describe('③ footer 的 caveat 行绑在 detailTruncated 条件里、且用字典键带 {limit}', () => {
  it('detailTruncated && (...) 这一条件 JSX 出现（不是无条件挂一句、也不是恒显）', () => {
    expect(SRC).toMatch(/\{\s*detailTruncated\s*&&\s*\(/)
  })
  it('caveat 那一格调 t("usage.detailTruncated", { limit: EXPORT_LIMIT })（键名＋上限都传进去）', () => {
    expect(SRC).toMatch(/t\('usage\.detailTruncated',\s*\{\s*limit:\s*EXPORT_LIMIT\s*\}\)/)
  })
  it('反向钉：footer 那句中文/英文不许被硬写进 TSX（只走字典键）', () => {
    expect(SRC).not.toMatch(/>\s*合计只覆盖/)
    expect(SRC).not.toMatch(/>\s*Total covers/)
  })
})

describe('④ 四语字典齐：usage.detailTruncated 都在、都含 {limit}、与 CSV 那句不撞车', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko'] as const) {
    it(`${lang}：键在、{limit} 在、且与 usage.exportCsvTruncated 不同句`, () => {
      const src = readFileSync(path.join(process.cwd(), 'src/renderer/src/i18n', `${lang}.ts`), 'utf8')
      const grab = (key: string): string | null => {
        const m = src.match(new RegExp(`'${key}':\\s*'([^']*)'`))
        return m ? m[1]! : null
      }
      const detail = grab('usage\\.detailTruncated')
      const csv = grab('usage\\.exportCsvTruncated')
      expect(detail, lang + ' 缺 usage.detailTruncated').not.toBeNull()
      expect(detail).toContain('{limit}')
      expect(csv).not.toBeNull()
      expect(detail, lang + ' 与 CSV 那句同字＝复用了不该复用的两句').not.toBe(csv)
    })
  }
})
