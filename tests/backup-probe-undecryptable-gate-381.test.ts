// V4-Iter-381 闸门：两把「探测／解密没跑成」不许在同一批里被折成"正常结果"
//
// 起点＝缺陷 hunt 候选 #5（`remoteExists` 任何错塌成 false）＋扫这一面时撞出的更重那枚
// （WebDAV 备份口令＝§375 那一族的第四张快照：解不开时 `loadWebDAVConfig` 把旧钥密文当明文带回，
//  四个密钥轮换点把它当明文回写＝那份口令永久解不开，而屏上「已配置」照旧）。
// 本闸门守六件事：
//   A 契约：三态的 `RemoteExistence`／`passwordUndecryptable`／`blobsProbeUnknown` 都在，且出 IPC 用的是掩码视图那份类型
//   B 轮换四处：§385 起都走同一对出口（capture → 换钥 → restore），逐处钉顺序与留痕；自己读／自己写／自己判那三形归零
//   C 计数：`exists` 才计去重，`unknown` 另立一档并进结果与日志；旧的 `if (await remoteExists(...))` 归零
//   D 消费面：设置页那句「解不开」必须同时绑 `cfg` 与那颗 flag（挂在别的条件上＝那张脸永不出现或永远出现）
//   E 那句「几个没能确认」只在计数 >0 时追加，且数字走 params（不许在字典里写死、也不许手替）
//   F 四语：两颗键四语齐；`{n}` 齐；那句里指的按钮名各语都用自己那条 `bk.saveCfg` 原文
//   G 楠形状：几份手抄 field-encrypt 的测试桩必须带上 hasUndecryptableCipher（漏成员只有跑到 maskWebDAVConfig 那一发才红，
    //     本批第一趙就是这么撞红的）
//   H 读法自证：把改前的形状喂进同一套读法，必须读成"没判／没绑"
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

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

const TYPES = read('shared/types.ts')
const PRELOAD = read('preload/index.ts')
const CLIENT = read('main/backup/webdav-client.ts')
const SERVICE = read('main/backup/backup-service.ts')
const ENC = read('main/ipc/handlers/encryption.ts')
const SETTINGS = read('renderer/src/modules/settings/SettingsModule.tsx')
const DICTS = { zh, en, ja, ko } as const
type Lang = keyof typeof DICTS

const sf = (name: string, src: string): ts.SourceFile =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/**
 * 找到"调了 `captureWebDAVForRekey()` 的那些函数体"，逐体报出：capture 的位置、换钥那一步
 * （三个可能标记里最早的那个）、restore 的位置、留痕 warn 条数。
 *
 * §385 起这一族改成"共用一对出口"，本闸门的判据跟着从"每处自己读自己写"换成
 * "每一处都走出口、且顺序对"（capture 早于换钥、restore 晚于换钥——顺序是这一对出口唯一的牙）。
 * 按**函数体身份**钉、不是数次数（第 37 条），并剔掉外层函数（外层体的文本含内层的调用，会把同一处数两遍）。
 */
function rekeySites(src: string, fileName: string): Array<{ capture: number; swap: number; restore: number; warns: number; at: number }> {
  const file = sf(fileName, src)
  const found: Array<{ start: number; end: number; at: number; capture: number; swap: number; restore: number; warns: number }> = []
  walk(file, (fn) => {
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))) return
    const body = fn.body
    if (!body || !ts.isBlock(body)) return
    const text = body.getText(file)
    const capture = text.indexOf('captureWebDAVForRekey()')
    if (capture < 0) return
    const swaps = ['commitNewMasterKeyState(', 'dbService.enableEncryption(', "rekey = ''"]
      .map((m) => text.indexOf(m))
      .filter((p) => p >= 0)
    found.push({
      start: fn.getStart(file),
      end: fn.getEnd(),
      at: body.getStart(file),
      capture,
      swap: swaps.length ? Math.min(...swaps) : -1,
      restore: text.indexOf('restoreWebDAVAfterRekey('),
      warns: text.split('if (webdavTicket.undecryptable) log.warn(').length - 1
    })
  })
  return found
    .filter((outer) => !found.some((inner) => inner !== outer && outer.at < inner.at && inner.end <= outer.end))
    .map(({ capture, swap, restore, warns, at }) => ({ capture, swap, restore, warns, at }))
    .sort((a, b) => a.at - b.at)
}

/** 那句 JSX 的守卫条件链（同 §380 那套：if／三元／`cond && (<JSX/>)` 三种落法都认） */
function guardingConditions(src: string, fileName: string, exact: string): string[][] {
  const file = sf(fileName, src)
  const leaves: ts.Node[] = []
  walk(file, (n) => {
    if (n.getText(file) !== exact) return
    let childSame = false
    n.forEachChild((c) => {
      if (c.getText(file) === exact) childSame = true
    })
    if (childSame) return
    let inJsx = false
    let p: ts.Node | undefined = n.parent
    while (p) {
      if (ts.isJsxElement(p) || ts.isJsxFragment(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxText(p)) inJsx = true
      p = p.parent
    }
    if (!inJsx) return
    leaves.push(n)
  })
  return leaves.map((leaf) => {
    const conds: string[] = []
    let cur: ts.Node | undefined = leaf.parent
    while (cur) {
      if (ts.isIfStatement(cur)) conds.push(cur.expression.getText(file))
      if (ts.isConditionalExpression(cur)) conds.push(cur.condition.getText(file))
      if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        conds.push(cur.left.getText(file))
      }
      cur = cur.parent
    }
    return conds
  })
}

describe('A 契约：三态与两颗新字段都在，且不许退回旧形状', () => {
  it('webdav-client 的探测回三态，catch 那一支交的是 unknown（不是 false）', () => {
    expect(CLIENT).toMatch(/export type RemoteExistence = 'exists' \| 'absent' \| 'unknown'/)
    expect(CLIENT).toMatch(/Promise<RemoteExistence>/)
    expect(CLIENT).toMatch(/\}\s*catch\s*\{\s*return 'unknown'/)
    expect(CLIENT, '旧的"塌成 false"归零').not.toMatch(/Promise<boolean>\s*\{\s*const client = await buildClient/)
  })

  it('shared 契约：掩码视图带 passwordUndecryptable、增量结果带 blobsProbeUnknown', () => {
    expect(TYPES).toMatch(/export interface MaskedWebDAVConfig extends WebDAVConfig \{[\s\S]{0,400}passwordUndecryptable: boolean/)
    expect(TYPES).toMatch(/blobsProbeUnknown: number/)
  })

  it('preload 出 IPC 那一发用的是掩码视图那份类型（退回 WebDAVConfig＝那颗 flag 到不了渲染层）', () => {
    // §386：这一发从此还会回信封（那一行读不出来＝第三档），锚点跟着带上失败分支
    expect(PRELOAD).toMatch(
      /loadWebDAVConfig: \(\): Promise<MaskedWebDAVConfig \| \{ ok: false; error: string \} \| null>/
    )
    expect(PRELOAD).not.toMatch(/loadWebDAVConfig: \(\): Promise<WebDAVConfig \| null>/)
  })

  it('backup-service：读这一颗把三态一起带出，且判据排在"覆盖成明文"之前', () => {
    expect(SERVICE).toMatch(/export function readWebDAVConfig\(\): WebDAVConfigRead/)
    expect(SERVICE).toMatch(/passwordUndecryptable: read\.passwordUndecryptable/)
    expect(SERVICE, 'load 只许是薄封装（否则两处读会各判各的）').toMatch(/export function loadWebDAVConfig\(\): WebDAVConfig \| null \{\s*return readWebDAVConfig\(\)\.cfg/)
    const body = SERVICE.slice(SERVICE.indexOf('export function readWebDAVConfig'), SERVICE.indexOf('export function loadWebDAVConfig'))
    const judge = body.indexOf('hasUndecryptableCipher(')
    const overwrite = body.indexOf('cfg.passwordCipher = pwdArr[0]')
    expect(judge, '读这一颗里根本没有判据').toBeGreaterThan(-1)
    expect(overwrite, '覆盖成明文那一句不见了').toBeGreaterThan(-1)
    expect(judge < overwrite, '判据排在覆盖之后＝拿明文当密文再判一遍（口令恰好以 v1: 开头会误报）').toBe(true)
  })
})

describe('B 轮换四处：都走同一对出口、capture 排在换钥之前、四处都留痕、改前那几形归零', () => {
  // §385 把这一族收成一对出口（capture → 换钥 → restore）⇒ 本节的判据跟着换：
  // 不再数"每处自己声明了那颗 flag"（那种形状已不存在，数出来永远是 0＝空转），
  // 改成按函数体身份钉"这一处真的走了出口、且顺序对"。第五处在 `src/main/index.ts`，由 §385 的新闸门守。
  const sites = rekeySites(ENC, 'encryption.ts')

  it('现数 4 处走出口（改密／启用／禁用／恢复码），少一处＝漏收一个轮换点', () => {
    expect(sites.length, '现数走出口的轮换点数').toBe(4)
  })

  it('每一处：capture 早于换钥、换钥早于 restore（顺序反了＝那一行救不回来）', () => {
    for (const [i, s] of sites.entries()) {
      expect(s.swap, `第 ${i + 1} 处找不到"换钥那一步"（标记换了地方，判据要跟着搬）`).toBeGreaterThan(-1)
      expect(s.restore, `第 ${i + 1} 处没有 restore 那一句`).toBeGreaterThan(-1)
      expect(s.capture < s.swap, `第 ${i + 1} 处 capture 排在换钥之后＝只能报"解不开"`).toBe(true)
      expect(s.swap < s.restore, `第 ${i + 1} 处 restore 排在换钥之前＝写的还是旧密钥`).toBe(true)
    }
  })

  it('每一处：解不开那一档都留一条 warn（不重写就得说得出口）', () => {
    for (const [i, s] of sites.entries()) {
      expect(s.warns, `第 ${i + 1} 处没有留痕`).toBe(1)
    }
  })

  it('反向钉：这一层不再自己读、自己写、自己判（三形一律归零＝出口是唯一路径）', () => {
    expect(ENC, '旧形还活着').not.toMatch(/if \(oldCfg\) \{ webDAVPassword = oldCfg\.passwordCipher/)
    expect(ENC, '不许再拿解密结果当密文判第二遍').not.toMatch(/webDAVPasswordUndecryptable\(/)
    expect(ENC, '这一层只许出口自己读那一行').not.toMatch(/readWebDAVConfig\(/)
    expect(ENC, '这一层只许出口自己写那一行').not.toMatch(/saveWebDAVConfig\(/)
    expect(ENC, '自己声明那颗 flag 的旧形不许回来').not.toMatch(/let webdavUndecryptable = false/)
  })

  it('改密那发的 count 把这一项并进 §375 那一个 N（不是另起一句、也不是漏计）', () => {
    expect(ENC).toMatch(/undecryptableCount: \(fieldSnapshot\.undecryptable\?\.length \?\? 0\) \+ \(webdavTicket\.undecryptable \? 1 : 0\)/)
  })
})

describe('C 计数：unknown 不许被记成"去重命中"', () => {
  it('uploadBlob 里 exists 才加 blobsSkipped，unknown 加 blobsProbeUnknown，顺序是先判 exists 再判 unknown', () => {
    expect(SERVICE).toMatch(/const state = await remoteExists\(creds, rel\)/)
    expect(SERVICE).toMatch(/if \(state === 'exists'\) \{\s*blobsSkipped \+= 1/)
    expect(SERVICE).toMatch(/if \(state === 'unknown'\) blobsProbeUnknown \+= 1/)
  })

  it('旧的"直接把 exists 的结果当布尔"归零；这一档要进日志与结果两处', () => {
    expect(SERVICE, '旧形还活着').not.toMatch(/if \(await remoteExists\(creds, rel\)\)/)
    expect(SERVICE).toMatch(/探测未确认 \$\{blobsProbeUnknown\}/)
    expect(SERVICE).toMatch(/return \{[\s\S]{0,300}blobsProbeUnknown,[\s\S]{0,200}attachmentsTotal: atts\.length/)
  })

  it('unknown 那一档仍走重传（内容寻址＋overwrite＝安全），不许演成"整片中止"', () => {
    const upBlob = SERVICE.slice(SERVICE.indexOf('const uploadBlob'), SERVICE.indexOf('// 3. DB blob'))
    expect(upBlob, '重传那句必须对 absent／unknown 两档都跑').toContain('await uploadRemoteBuffer(creds, payload, rel)')
    expect(upBlob.indexOf("if (state === 'unknown')"), '计数排在重传之前，抛出时也不丢这一档').toBeLessThan(upBlob.indexOf('await uploadRemoteBuffer'))
  })
})

describe('D 设置页那句「解不开」绑在它自己的条件上', () => {
  const key = "t('bk.pwdUndecryptable')"
  const conds = guardingConditions(SETTINGS, 'SettingsModule.tsx', key)

  it('出现恰好一次，且条件同时含"有配置"与那颗 flag（缺任一条＝那张脸要么永不出现要么盖住"没配过"）', () => {
    expect(conds.length, key + ' 在屏上的出现数').toBe(1)
    const [list] = conds
    expect(list!.some((c) => c.includes('wdPwdUndecryptable')), '没绑 flag').toBe(true)
    expect(list!.some((c) => /(^|\s)cfg(&&|\s|$)/.test(c)), '没绑"配置已在手"').toBe(true)
  })

  it('flag 只由那一读写入（成功档），失败／null／reject 三档都写成 false（陈旧谎报不许留着）', () => {
    expect(SETTINGS.match(/setWdPwdUndecryptable\(/g), '表态点总数').toHaveLength(5)
    expect(SETTINGS).toMatch(/setWdPwdUndecryptable\(c\.passwordUndecryptable\)/)
    expect(SETTINGS.match(/setWdPwdUndecryptable\(false\)/g), '失败／null／reject 三档各写一次＋保存只在新口令那发清零').toHaveLength(4)
  })

  it('保存那发的清零必须绑"用户真输入了新口令"（沿用已存那份时不许替它说话）', () => {
    expect(SETTINGS).toMatch(/if \(wdPwd\) setWdPwdUndecryptable\(false\)/)
  })
})

describe('E 增量那句「没能确认」只在真有过的时候追加', () => {
  it('绑 r.blobsProbeUnknown > 0，数字走 params（字典里不许写死、调用点不许手替）', () => {
    // 这一句不是 JSX 条件渲染，而是拼进那一行结论的字符串（同 bk.schedulePruned 的既有约定）
    // ⇒ 判据按"出现一次＋紧邻的那道门就是计数本身"来钉，不走 guardingConditions 那套（它只看 JSX）。
    const callText = "t('bk.incProbeUnknown', { n: r.blobsProbeUnknown })"
    expect(SETTINGS.split(callText).length - 1, '出现次数（多一处就没人知道哪一处在说谎）').toBe(1)
    const at = SETTINGS.indexOf(callText)
    const window = SETTINGS.slice(Math.max(0, at - 120), at + 120)
    expect(window, '这句必须被 `r.blobsProbeUnknown > 0` 那道门包住').toContain('r.blobsProbeUnknown > 0 ?')
    expect(SETTINGS).toMatch(/\(r\.blobsProbeUnknown > 0 \? ' ' \+ t\('bk\.incProbeUnknown', \{ n: r\.blobsProbeUnknown \}\) : ''\)/)
    expect((zh as Record<string, string>)['bk.incProbeUnknown']).toContain('{n}')
  })

  it('原来那句不动它自己的四个占位符（本枚只加一句、不重排账目）', () => {
    expect(SETTINGS).toMatch(/t\('bk\.incDone', \{\s*total: r\.attachmentsTotal,\s*uploaded: r\.blobsUploaded,\s*skipped: r\.blobsSkipped,/)
  })
})

describe('F 四语：两键齐、{n} 齐、指的按钮名各语对得上', () => {
  it('bk.pwdUndecryptable 与 bk.incProbeUnknown 四语都在', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      expect((DICTS[lang] as Record<string, string>)['bk.pwdUndecryptable'], `${lang} 缺`).toBeTruthy()
      expect((DICTS[lang] as Record<string, string>)['bk.incProbeUnknown'], `${lang} 缺`).toBeTruthy()
    }
  })

  it('bk.incProbeUnknown 四语都带 {n}（数字由调用点带出＝§379 那族的口径）', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      expect((DICTS[lang] as Record<string, string>)['bk.incProbeUnknown'], `${lang} 少了 {n}`).toContain('{n}')
    }
  })

  it('那句指的按钮名＝各语自己的 bk.saveCfg 原文（别的语的字样不许混进来）', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const d = DICTS[lang] as Record<string, string>
      expect(d['bk.pwdUndecryptable'], `${lang} 那句没含 ${lang} 的按钮名 ${d['bk.saveCfg']}`).toContain(d['bk.saveCfg'])
      for (const other of Object.keys(DICTS) as Lang[]) {
        if (other === lang) continue
        const otherLabel = (DICTS[other] as Record<string, string>)['bk.saveCfg'] ?? ''
        if (otherLabel === d['bk.saveCfg'] || otherLabel.length < 4) continue
        expect(d['bk.pwdUndecryptable'], `${lang} 那句混进了 ${other} 的按钮名 ${otherLabel}`).not.toContain(otherLabel)
      }
    }
  })

  it('既有那句 enc.rotateUndecryptable 一字未动（本枚把 WebDAV 计进同一个 N，不另起一句）', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const line = raw(`renderer/src/i18n/${lang}.ts`).match(/'enc\.rotateUndecryptable':\s*'([^']*)'/)
      expect(line, `${lang} 找不到那一句`).not.toBeNull()
      expect(line![1]!, `${lang} 那句不该被改动`).toContain('{n}')
    }
  })
})

describe('G 手抄 field-encrypt 桩的那几份测试必须带上 hasUndecryptableCipher', () => {
  // 本批第一趟就是被这一格撞红的：backup-service 现在会调 `hasUndecryptableCipher`，
  // 而 `vi.mock(field-encrypt)` 是**手抄的形状**——漏一个成员不会在装载时报错，
  // 只有跑到那一发才以「handler 抛 ⇒ 回 {ok:false}」的脸出现（§366／§359 同族）。
  const testDir = path.resolve(__dirname)
  const SELF = path.basename(__filename)
  const stubbers = fs.readdirSync(testDir)
    .filter((f) => f !== SELF) // 本文件自己就含那串字面量（它是判据的 needle），不算一份桩
    .filter((f) => /\.(test|spec)\.[tj]sx?$/.test(f))
    .filter((f) => fs.readFileSync(path.join(testDir, f), 'utf-8').includes("vi.mock('../src/main/crypto/field-encrypt'"))
    .sort()

  it('现数名单：谁手抄了这层，就得连新那颗一起抄（或把这行改掉并写明理由）', () => {
    expect(stubbers, `手抄 field-encrypt 的测试文件现数 ${stubbers.length} 份：${stubbers.join(', ')}`).toEqual([
      'backup-crypto-v2.test.ts',
      'backup-kdf-tier.test.ts',
      'backup-local-restore.test.ts',
      'backup-restore-cleanup-323.test.ts',
      'backup-service.test.ts',
      'backup-webdav-mask.test.ts',
      'merge-crypto.test.ts'
    ])
  })

  it('每一份的桩里都有 hasUndecryptableCipher（漏＝只有跑到 maskWebDAVConfig 那一发才红）', () => {
    for (const f of stubbers) {
      const src = fs.readFileSync(path.join(testDir, f), 'utf-8')
      expect(src, `${f} 的手抄桩缺 hasUndecryptableCipher`).toContain('hasUndecryptableCipher')
    }
  })

  it('反向对照：把那颗摘掉，这套读法当场认得出缺（"名单齐"不是瞎的）', () => {
    const src = fs.readFileSync(path.join(testDir, stubbers[0]!), 'utf-8')
    const one = src.replace(/^\s*hasUndecryptableCipher:.*$\n?/m, '')
    expect(one, '这一刀必须真削掉一行（削不动＝对照在空转）').not.toBe(src)
    expect(src).toContain('hasUndecryptableCipher')
    expect(one).not.toContain('hasUndecryptableCipher')
  })
})

describe('H 读法自证：改前的形状喂进同一套读法，必须读成"没走出口／没绑"', () => {
  it('rekeySites 认不出改前那一形（没走出口＝没有这一处），也剔得掉外层函数', () => {
    const BEFORE = [
      'async function h() {',
      '  let webDAVPassword: string | null = null',
      '  let savedCfg = null',
      '  const read = readWebDAVConfig()',
      '  if (read.cfg) { webDAVPassword = read.cfg.passwordCipher; savedCfg = read.cfg }',
      '  commitNewMasterKeyState(prepared)',
      '  if (webDAVPassword && savedCfg) saveWebDAVConfig(savedCfg)',
      '}'
    ].join('\n')
    expect(rekeySites(BEFORE, 'before.ts'), '改前形状不该被数成"走出口的一处"').toEqual([])
    // 同一套读法用在改后形状上＝capture 在前、换钥在中、restore 在后、留痕一条
    const AFTER = [
      'async function h() {',
      '  const t = captureWebDAVForRekey()',
      '  commitNewMasterKeyState(prepared)',
      '  restoreWebDAVAfterRekey(t)',
      '  if (t.undecryptable) log.warn("x")',
      '}'
    ].join('\n')
    const s = rekeySites(AFTER, 'after.ts')
    expect(s.length).toBe(1)
    expect(s[0]!.capture).toBeLessThan(s[0]!.swap)
    expect(s[0]!.swap).toBeLessThan(s[0]!.restore)
    // 外层函数（体内含同一串）不许被数第二遍：把上面那段套进一个外层函数再数
    const NESTED = [
      'function outer() {',
      '  const h = async () => {',
      '    const webdavTicket = captureWebDAVForRekey()',
      '    commitNewMasterKeyState(prepared)',
      '    restoreWebDAVAfterRekey(webdavTicket)',
      '    if (webdavTicket.undecryptable) log.warn("x")',
      '  }',
      '  return h',
      '}'
    ].join('\n')
    const n = rekeySites(NESTED, 'nested.ts')
    expect(n.length, '嵌套两层的文本只许数到最内层那一处').toBe(1)
    expect(n[0]!.warns, '留痕那条也按函数体身份数（外层不许把内层的 warn 顶给自己）').toBe(1)
  })

  it('guardingConditions 认得出 `cond && (<JSX/>)`，而挂在一个不含 flag 的 if 上的同一句会被判成"没绑"', () => {
    const WITH = '<div>{cfg && wdPwdUndecryptable && (<p>{t("bk.pwdUndecryptable")}</p>)}</div>'
    const WITHOUT = '<div>{cfg && (<p>{t("bk.pwdUndecryptable")}</p>)}</div>'
    const of = (src: string): string[][] =>
      guardingConditions(src.replace(/t\("bk\.pwdUndecryptable"\)/g, "t('bk.pwdUndecryptable')"), 'x.tsx', "t('bk.pwdUndecryptable')")
    expect(of(WITH)[0]!.some((c) => c.includes('wdPwdUndecryptable'))).toBe(true)
    expect(of(WITHOUT)[0]!.some((c) => c.includes('wdPwdUndecryptable')), '没绑 flag 那一形必须读成"没绑"').toBe(false)
  })
})
