// V4-Iter-375 常驻闸门：轮换导出器不许再把「有密文却解不开」当「没配过」悄悄跳过。
//
// 盯的形状（每颗都挂着 undecryptable-375 那批行为用例演过的后果）：
// - field-encrypt：hasUndecryptableCipher 判据＝「是密文」且「decryptSecret 折成空」（前提：空值从不以密文落盘）
// - 三个导出器（secret-store.exportSecrets / providerRepo.exportAllApiKeys / mcpServerRepo.exportAllSecrets）：
//   体内必须①读原始列、②调 hasUndecryptableCipher、③返回带 undecryptable 的对象——
//   只按 length>0 / 真值判「有没有凭据」＝改前那一形（解不开的行被静默略过、旧钥密文原地烂掉）
// - credential-rotation：export 汇总三路 undecryptable；restore 只转发 snapshot map、绝不把 undecryptable 喂进重写、且非空必 log.warn
// - 界面侧：encryption.ts 改密回值带 undecryptableCount；SettingsModule 消费它并 toast.warning(t('enc.rotateUndecryptable'
// 读法先钉（不证读法，下面的 0 与「含」都可能是分类器瞎了），再把「改前那形」喂进同一套读法必须被认出来。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8')
}

/** 顶层 function 声明 或 对象方法：按名字取函数体文本（花括号配平） */
function bodyOf(src: string, name: string): string {
  const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true)
  let found = ''
  const grab = (body: ts.Node | undefined): void => {
    if (!body) return
    found = body.getText()
  }
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === name) grab(n.body)
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) grab(n.body)
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return found
}

/** 调用了哪些函数名（`foo(` 与 `a.b(` 都算 b） */
function calledNames(body: string): string[] {
  const out: string[] = []
  const sf = ts.createSourceFile('p.ts', 'function __probe(): void {' + body + '}', ts.ScriptTarget.Latest, true)
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) out.push(n.expression.text)
      else if (ts.isPropertyAccessExpression(n.expression)) out.push(n.expression.name.text)
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return out
}

const FE = 'src/main/crypto/field-encrypt.ts'
const SS = 'src/main/crypto/secret-store.ts'
const PV = 'src/main/db/repositories/provider.repo.ts'
const MCP = 'src/main/db/repositories/mcp-server.repo.ts'
const CR = 'src/main/crypto/credential-rotation.ts'
const ENC = 'src/main/ipc/handlers/encryption.ts'
const SM = 'src/renderer/src/modules/settings/SettingsModule.tsx'

describe('读法自证：分类器读得到这些函数体与其中的调用', () => {
  it('五个具名函数体都取到（取空＝分类器瞎了，下面的判定全成数空气）', () => {
    for (const [rel, name] of [[FE, 'hasUndecryptableCipher'], [SS, 'exportSecrets'], [PV, 'exportAllApiKeys'], [MCP, 'exportAllSecrets'], [CR, 'exportFieldCredentials'], [CR, 'restoreFieldCredentials']] as const) {
      expect(bodyOf(read(rel), name), rel + '#' + name + ' 读空').not.toBe('')
    }
  })
  it('调用点名取得到（拿 exportAllApiKeys 里真出现的 decryptApiKeys 当对照）', () => {
    expect(calledNames(bodyOf(read(PV), 'exportAllApiKeys'))).toContain('decryptApiKeys')
  })
})

describe('① hasUndecryptableCipher 的判据两头钉：认密文前缀 ＋ 解出空才算解不开', () => {
  it('体内同时出现 isCipherText 与 decryptSecret，且用 === 空串判', () => {
    const body = bodyOf(read(FE), 'hasUndecryptableCipher')
    expect(body).toContain('isCipherText(')
    expect(body).toContain("decryptSecret(")
    expect(body).toMatch(/===\s*''/)
  })
})

describe('② 三个导出器都必须调 hasUndecryptableCipher 并返回 undecryptable', () => {
  it.each([[SS, 'exportSecrets'], [PV, 'exportAllApiKeys'], [MCP, 'exportAllSecrets']] as const)('%s 里 hasUndecryptableCipher 有被调、返回对象带 undecryptable', (rel, name) => {
    const body = bodyOf(read(rel), name)
    expect(calledNames(body), name + ' 必须请出解不开那一态').toContain('hasUndecryptableCipher')
    expect(body, name + ' 必须回 undecryptable 数组').toMatch(/undecryptable/)
  })

  it('漏杀对照：改前那一形（只按 length>0 判、不调 hasUndecryptableCipher）在这套读法下要认得出「没请出解不开态」', () => {
    const OLD = `function exportAllApiKeys() {
  const snapshot = {}
  for (const row of this.list()) { if (row.apiKeys.length > 0) snapshot[row.id] = row.apiKeys }
  return snapshot
}`
    const body = bodyOf(OLD, 'exportAllApiKeys')
    expect(body).not.toBe('') // 读法本身认得出这颗函数
    expect(calledNames(body)).not.toContain('hasUndecryptableCipher') // 改前根本没请出解不开态 ⇒ 正是本闸要拦的
  })
})

describe('③ credential-rotation：export 汇总三路、restore 只转发 snapshot map 且非空必 warn', () => {
  it('export 把三路 undecryptable 拼进快照', () => {
    const body = bodyOf(read(CR), 'exportFieldCredentials')
    for (const seg of ['kv.undecryptable', 'providers.undecryptable', 'mcp.undecryptable']) {
      expect(body, '少了汇总 ' + seg).toContain(seg)
    }
  })
  it('restore 转发的是各自的 snapshot map（不是整包对象），且解不开非空时说一句', () => {
    const body = bodyOf(read(CR), 'restoreFieldCredentials')
    expect(body).toContain('restoreSecrets(snapshot.kv)')
    expect(body).toContain('providerRepo.restoreAllApiKeys(snapshot.providers)')
    expect(body).toContain('mcpServerRepo.restoreAllSecrets')
    expect(body).toMatch(/undecryptable/)
    expect(calledNames(body), '解不开非空时必须 log.warn 说一句').toContain('warn') // calledNames 把 log.warn 取成 warn
  })
})

describe('④ 界面侧：回值带 undecryptableCount 且 SettingsModule 消费并说四语那句', () => {
  it('encryption.ts 改密回值把 count 透出去', () => {
    expect(read(ENC)).toMatch(/undecryptableCount:\s*fieldSnapshot\.undecryptable\?\.length\s*\?\?\s*0/)
  })
  it('SettingsModule 数了 count 才 toast.warning，且用的是字典键（不是硬写中文）', () => {
    const src = read(SM)
    expect(src).toMatch(/r\.undecryptableCount\s*&&\s*r\.undecryptableCount\s*>\s*0/)
    expect(src).toContain("toast.warning(t('enc.rotateUndecryptable', { n: r.undecryptableCount }))")
    expect(src).not.toContain('toast.warning(\'本次') // 不许硬写中文串上屏
  })
})

describe('⑤ 四语字典齐（i18n-parity 也守，这里补一颗「{n} 占位符每语都在」）', () => {
  it('enc.rotateUndecryptable 四语都在且都含 {n}', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const src = read('src/renderer/src/i18n/' + lang + '.ts')
      const m = src.match(/'enc\.rotateUndecryptable':\s*'([^']*)'/)
      expect(m, lang + ' 缺 enc.rotateUndecryptable').not.toBeNull()
      expect(m![1], lang + ' 少了 {n} 占位符').toContain('{n}')
    }
  })
})
