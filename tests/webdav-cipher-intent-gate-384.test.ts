// §384 闸门：WebDAV 备份口令的幂等防护必须「声明 ∧ 形状」两半都在，谁也不许单走
//
// 起点＝§382 真机撞出的那一格（`isCipherText` 只看前缀 ⇒ 恰以 `v1:` 开头的明文被当"已加密"原样落盘，
// 读侧从此叫它「解不开」，重填同一句还是原样落盘＝出不去的循环）。口径 B＝形状判据＋写侧意图声明。
// 本闸门守七件事：
//   A 契约：`RestoredWebDAVPassword`／`SaveWebDAVOptions` 两颗新形状都在，签名逐字对
//   B 写侧不猜：save 体内那一条件必须"声明 ∧ 形状"两半都在；改前那一形（只看 isCipherText）归零
//   C 意图的来源：restore 走 `readWebDAVConfig` 并把那颗 flag 原封交出（走 load＝丢掉 flag＝密文被当明文回写）
//   D handler 转交：SAVE 那发必须把声明转交给 save（不转交＝行为用例②(c) 当场双层化），TEST 那发用 `resolved.cfg`
//   E 轮换点不再自己写那一行：写只发生在出口内部（§385 起四处共用 capture/restore），且交出去的确实是明文
//   F 形状判据四半都在（前缀／%4／字符集／round-trip／字节下界），且不是"只看前缀"那一形
//   G 手抄 `isCipherText` 的测试桩不许留"只看前缀"那一形（桩答太松＝替被测代码把这一格喂绿）
//   H 读法自证：改前那一形喂进同一套读法，必须读成"没声明／只看前缀"
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

function stripComments(src: string): string {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  return out
    .split('\n')
    .map((line) => {
      let inS: string | null = null
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (inS) {
          if (c === '\\') i++
          else if (c === inS) inS = null
          continue
        }
        if (c === '"' || c === "'" || c === '`') inS = c
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

const raw = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf-8').replace(/\r\n/g, '\n')
const read = (rel: string): string => stripComments(raw(rel))

const ENC = read('main/crypto/field-encrypt.ts')
const SERVICE = read('main/backup/backup-service.ts')
const HANDLER = read('main/ipc/handlers/backup.ts')
const ROTATE = read('main/ipc/handlers/encryption.ts')

const sf = (name: string, src: string): ts.SourceFile =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** 具名函数（导出函数声明）的**函数体**文本；找不到就返回 ''（判据会因此当场红，不会悄悄喂绿） */
function fnBody(name: string, src: string, fileName: string): string {
  const file = sf(fileName, src)
  let body = ''
  walk(file, (n) => {
    if (!ts.isFunctionDeclaration(n)) return
    if (n.name?.getText(file) !== name) return
    const b = n.body
    if (b) body = b.getText(file)
  })
  return body
}

/** 接口体的文本（同上，找不到＝''） */
function ifaceBody(name: string, src: string, fileName: string): string {
  const file = sf(fileName, src)
  let body = ''
  walk(file, (n) => {
    if (!ts.isInterfaceDeclaration(n)) return
    if (n.name.getText(file) !== name) return
    body = n.getText(file)
  })
  return body
}

const count = (hay: string, needle: string): number => hay.split(needle).length - 1

const SAVE_BODY = fnBody('saveWebDAVConfig', SERVICE, 'backup-service.ts')
const RESTORE_BODY = fnBody('restoreWebDAVPassword', SERVICE, 'backup-service.ts')
const IS_CIPHER = fnBody('isCipherText', ENC, 'field-encrypt.ts')

describe('A 契约：两颗新形状齐，签名逐字对', () => {
  it('RestoredWebDAVPassword 带 cfg 与 passwordIsStoredCipher 两项', () => {
    const i = ifaceBody('RestoredWebDAVPassword', SERVICE, 'backup-service.ts')
    expect(i, '契约没了＝handler 只能自己猜').toContain('cfg: WebDAVConfig')
    expect(i).toContain('passwordIsStoredCipher: boolean')
  })

  it('SaveWebDAVOptions 的 passwordAlreadyCipher 是**可选**的（四处轮换点不传＝默认按明文）', () => {
    const i = ifaceBody('SaveWebDAVOptions', SERVICE, 'backup-service.ts')
    expect(i).toContain('passwordAlreadyCipher?: boolean')
  })

  it('两个签名：restore 交出那份契约、save 收第二参且有默认值', () => {
    expect(SERVICE).toMatch(/export function restoreWebDAVPassword\(cfg: WebDAVConfig\): RestoredWebDAVPassword \| null/)
    expect(SERVICE).toMatch(/export function saveWebDAVConfig\(raw: WebDAVConfig, opts: SaveWebDAVOptions = \{\}\): void/)
  })
})

describe('B 写侧不再猜形状：条件＝声明 ∧ 形状，两半缺一即加密', () => {
  it('save 体内那一条件逐字在，且 true 分支原样、false 分支加密', () => {
    expect(SAVE_BODY, '函数体没读到＝判据失去对象').not.toBe('')
    expect(SAVE_BODY).toMatch(
      /opts\.passwordAlreadyCipher === true && isCipherText\(raw\.passwordCipher\)\s*\?\s*raw\.passwordCipher\s*:\s*encryptApiKeys\(\[raw\.passwordCipher\]\)/
    )
  })

  it('改前那一形归零：赋值号后面直接跟裸 isCipherText 的三元（只看形状）', () => {
    expect(SAVE_BODY, '旧形还活着＝明文恰好像密文又会被原样落盘').not.toMatch(
      /const passwordCipher = isCipherText\(raw\.passwordCipher\)\s*\?/
    )
    expect(count(SAVE_BODY, 'isCipherText('), '这一发判据只许出现一次').toBe(1)
  })
})

describe('C 意图的来源：回填那一步把「这是库里那份密文原文」说出来', () => {
  it('走 readWebDAVConfig 并把那颗 flag 原封交出；未改动那一支交 false', () => {
    expect(RESTORE_BODY, '函数体没读到').not.toBe('')
    expect(RESTORE_BODY).toMatch(/const read = readWebDAVConfig\(\)/)
    expect(RESTORE_BODY).toMatch(/passwordIsStoredCipher: read\.passwordUndecryptable/)
    expect(RESTORE_BODY).toMatch(/return \{ cfg, passwordIsStoredCipher: false \}/)
  })

  it('反向钉：这一颗里不许再用 loadWebDAVConfig（那一份只交 cfg＝flag 被丢掉）', () => {
    expect(RESTORE_BODY, '丢 flag 那一形还活着').not.toMatch(/loadWebDAVConfig\(/)
  })
})

describe('D handler 把声明转交给写侧（不转交＝解不开那一份被双层化）', () => {
  it('SAVE 那发逐字一句：把 resolved.passwordIsStoredCipher 交给 opts', () => {
    expect(
      count(HANDLER, 'saveWebDAVConfig(resolved.cfg, { passwordAlreadyCipher: resolved.passwordIsStoredCipher })'),
      '转交那句只许出现一次'
    ).toBe(1)
  })

  it('消费面一律走 `resolved.cfg`（5 处）；旧形 `resolved.passwordCipher` 与 `testWebDAV(resolved)` 归零', () => {
    expect(count(HANDLER, 'resolved.cfg'), '现数 5 处：判 changed／验字符集／落盘／测试验字符集／测试鉴权').toBe(5)
    expect(HANDLER, '改前那一形还活着（把契约当配置用＝字段全是 undefined）').not.toMatch(/resolved\.passwordCipher/)
    expect(HANDLER, '测试那一路不许把契约整个交给 testWebDAV').not.toMatch(/testWebDAV\(resolved\)/)
    expect(count(HANDLER, 'testWebDAV(resolved.cfg)')).toBe(1)
  })

  it('回填仍是"先判再写"那一步之前的第一动作（顺序反了会把只改目录当成改口令）', () => {
    const restore = HANDLER.indexOf('restoreWebDAVPassword(cfg)')
    const changed = HANDLER.indexOf('newSecretKeys(')
    expect(restore, '找不到回填那一句').toBeGreaterThan(-1)
    expect(changed, '找不到 B2 判定那一句').toBeGreaterThan(-1)
    expect(restore < changed, '回填必须排在判定之前').toBe(true)
  })
})

describe('E 轮换点不再自己写那一行：写只发生在出口内部，且交出去的确实是明文', () => {
  // §385 把"换钥时搬 WebDAV 行"收成一对出口 ⇒ 本节的旧锚点（四处各一次 `saveWebDAVConfig(savedCfg)`）
  // 已随代码搬家失效，判据跟着改指新地方：这一层不再出现写、也不再自己判 flag。
  it('encryption.ts 里 saveWebDAVConfig／readWebDAVConfig 双双归零，四处只调 capture', () => {
    expect(count(ROTATE, 'saveWebDAVConfig('), '写那一行只许出口做').toBe(0)
    expect(count(ROTATE, 'readWebDAVConfig('), '读那一行只许出口做').toBe(0)
    expect(count(ROTATE, 'captureWebDAVForRekey()'), '现数四处（改密／启用／禁用／恢复码）').toBe(4)
    expect(ROTATE, '自己判 flag 的旧形不许回来').not.toMatch(/if \(read\.cfg && !read\.passwordUndecryptable\)/)
  })

  it('出口内部那一句写的是 `ticket.cfg`、不带第二参（＝声明"这是明文"，新密钥下重包）', () => {
    const body = fnBody('restoreWebDAVAfterRekey', SERVICE, 'backup-service.ts')
    expect(body, '函数体没读到').not.toBe('')
    expect(count(body, 'saveWebDAVConfig(ticket.cfg)'), '只此一处写，且不声明已是密文').toBe(1)
    expect(body).not.toMatch(/saveWebDAVConfig\(ticket\.cfg,/)
  })
})

describe('F 形状判据四半都在（前缀／长度／字符集／round-trip／字节下界）', () => {
  it('isCipherText 体内五件齐', () => {
    expect(IS_CIPHER, '函数体没读到').not.toBe('')
    expect(IS_CIPHER).toMatch(/startsWith\(CIPHER_PREFIX\)/)
    expect(IS_CIPHER).toMatch(/body\.length % 4 !== 0/)
    expect(IS_CIPHER).toMatch(/body\.length < \(\(IV_LEN \+ TAG_LEN\) \/ 3\) \* 4/)
    expect(IS_CIPHER).toMatch(/\[A-Za-z0-9\+\/\]/)
    expect(IS_CIPHER).toMatch(/buf\.toString\('base64'\) !== body/)
    expect(IS_CIPHER).toMatch(/buf\.length < IV_LEN \+ TAG_LEN/)
  })

  it('反向钉：改前那一形（只回一个 startsWith）归零', () => {
    expect(IS_CIPHER, '旧形还活着').not.toMatch(/^\s*\{\s*return s\.startsWith\(CIPHER_PREFIX\)\s*\}\s*$/)
    expect(count(IS_CIPHER, 'return'), '一句 return 装不下这四半').toBeGreaterThanOrEqual(2)
  })
})

describe('G 手抄 isCipherText 的测试桩不许留「只看前缀」那一形', () => {
  const testDir = path.resolve(__dirname)
  const SELF = path.basename(__filename)
  const loose = fs
    .readdirSync(testDir)
    .filter((f) => f !== SELF && /\.(test|spec)\.[tj]sx?$/.test(f))
    .filter((f) => {
      const src = stripComments(fs.readFileSync(path.join(testDir, f), 'utf-8').replace(/\r\n/g, '\n'))
      return /isCipherText:[^\n]*startsWith\(['"]v1:/.test(src)
    })
    .sort()

  it('现数名单为空（谁把桩抄松了，谁就替被测代码把「声明 ∧ 形状」那一格喂绿）', () => {
    expect(loose, `留"只看前缀"那一形的测试：${loose.join(', ')}`).toEqual([])
  })

  it('读法自证：那一形喂进同一套读法必须被认出', () => {
    const BEFORE = "vi.mock('x', () => ({ isCipherText: (s: string) => s.startsWith('v1:') }))\n"
    expect(/isCipherText:[^\n]*startsWith\(['"]v1:/.test(stripComments(BEFORE)), '这套读法是瞎的').toBe(true)
    const AFTER =
      "vi.mock('x', () => ({ isCipherText: (s: string) => looksLikeEnvelope(s) }))\n" +
      'const looksLikeEnvelope = (s: string): boolean => {\n  if (!s.startsWith(\'v1:\')) return false\n  const b = s.slice(3)\n  return b.length % 4 === 0\n}\n'
    expect(/isCipherText:[^\n]*startsWith\(['"]v1:/.test(stripComments(AFTER)), '收紧后的桩不该被算进名单').toBe(false)
  })
})

describe('H 读法自证：改前的 save／handler 喂进同一套读法，必须读成「没声明」', () => {
  const BEFORE_SAVE = [
    'export function saveWebDAVConfig(raw: WebDAVConfig): void {',
    '  webdavConfigSchema.parse(raw)',
    '  const passwordCipher = isCipherText(raw.passwordCipher)',
    '    ? raw.passwordCipher',
    '    : encryptApiKeys([raw.passwordCipher])',
    '  appConfigRepo.set(CFG_KEY, JSON.stringify({ ...raw, passwordCipher }))',
    '}'
  ].join('\n')
  const BEFORE_RESTORE = [
    'export function restoreWebDAVPassword(cfg: WebDAVConfig): WebDAVConfig | null {',
    '  if (!isMaskedSecret(cfg.passwordCipher)) return cfg',
    '  const stored = loadWebDAVConfig()?.passwordCipher',
    '  if (!stored) return null',
    '  return { ...cfg, passwordCipher: stored }',
    '}'
  ].join('\n')
  const BEFORE_CIPHER = 'export function isCipherText(s: string): boolean {\n  return s.startsWith(CIPHER_PREFIX)\n}'

  it('B：改前那一读法读不出"声明"（条件不在＝判据没牙）', () => {
    const body = fnBody('saveWebDAVConfig', BEFORE_SAVE, 'before.ts')
    expect(body).not.toMatch(/opts\.passwordAlreadyCipher === true &&/)
    expect(/const passwordCipher = isCipherText\(raw\.passwordCipher\)\s*\?/.test(body), '反向钉该认出旧形').toBe(true)
  })

  it('C：改前那一读法读不出 flag（走 load＝交不出第二样东西）', () => {
    const body = fnBody('restoreWebDAVPassword', BEFORE_RESTORE, 'before.ts')
    expect(body).not.toMatch(/passwordIsStoredCipher: read\.passwordUndecryptable/)
    expect(/loadWebDAVConfig\(/.test(body), '反向钉该认出"走 load 那一形"').toBe(true)
  })

  it('F：改前那一读法读得出"只看前缀"', () => {
    const body = fnBody('isCipherText', BEFORE_CIPHER, 'before.ts')
    expect(/^\s*\{\s*return s\.startsWith\(CIPHER_PREFIX\)\s*\}\s*$/.test(' ' + body + ' '), '该认出旧形').toBe(true)
    expect(IS_CIPHER, '真源码不许长得和旧形一样').not.toBe(body)
  })
})
