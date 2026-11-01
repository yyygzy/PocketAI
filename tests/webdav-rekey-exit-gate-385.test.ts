// §385 闸门：换字段密钥时"搬 WebDAV 备份口令"这件事只许有一个出口，且五处都走它
//
// 起点＝§383 候选 ④ 的回读：那四处轮换点各有一份逐字副本，而**第五发整个漏了**——
// boot 里「首次设置主密码」（`src/main/index.ts` 的 `setPassword` 那支）只搬字段凭据快照、
// 没搬 app_config 里那一行 ⇒ 那一次换钥把备份口令留在旧固定密钥下＝从此真解不开
// （用户路径：禁用加密 → 再在解锁窗首次设密码）。
// 本闸门守六件事：
//   A 契约：`WebDAVRekeyTicket{cfg, undecryptable}` 与两个导出的签名齐，restore 交回"写没写成"
//   B 五处同源：encryption.ts 四处＋index.ts 一处，每处 capture 早于换钥、换钥早于 restore、留一条痕
//   C 三发带回 count：禁用／启用／恢复码的回值都有那颗（§383 的候选 ④ 本体）
//   D 消费面四处各自绑门：设置页两发 toast、向导与解锁窗各自那句，且数字走 params、不许硬写中文
//   E 四语：`enc.rotateUndecryptable` 四语齐、都含 {n}、每语只一颗（本批复用它，不新增键）
//   F 手抄 backup-service 桩且测轮换的测试必须带上这两颗成员（§381 的 G 同族：漏成员只有跑到那一发才红）
//   G 读法自证：改前那一形（只搬字段快照）喂进同一套读法必须数成 0 处
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

const SERVICE = read('main/backup/backup-service.ts')
const ROTATE = read('main/ipc/handlers/encryption.ts')
const BOOT = read('main/index.ts')
const PRELOAD = read('preload/index.ts')
const SETTINGS = read('renderer/src/modules/settings/SettingsModule.tsx')
const WIZARD = read('renderer/src/modules/wizard/FirstRunWizard.tsx')
const UNLOCK = read('renderer/src/modules/unlock/UnlockPage.tsx')
const DICTS = { zh, en, ja, ko } as const
type Lang = keyof typeof DICTS

const sf = (name: string, src: string): ts.SourceFile =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** 具名函数（导出函数声明）的函数体文本；找不到＝''（判据会当场红，不会悄悄喂绿） */
function fnBody(name: string, src: string, fileName: string): string {
  const file = sf(fileName, src)
  let body = ''
  walk(file, (n) => {
    if (!ts.isFunctionDeclaration(n) || n.name?.getText(file) !== name) return
    if (n.body) body = n.body.getText(file)
  })
  return body
}

function ifaceText(name: string, src: string, fileName: string): string {
  const file = sf(fileName, src)
  let out = ''
  walk(file, (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.getText(file) === name) out = n.getText(file)
  })
  return out
}

/** 某个 safeHandle(IPC.X, 回调) 的回调体（按通道身份钉，不靠全文正则——同文件里别的通道也 return {ok:true}） */
function handlerBody(channel: string, src: string, fileName: string): string {
  const file = sf(fileName, src)
  let out = ''
  walk(file, (n) => {
    if (!ts.isCallExpression(n) || n.arguments.length < 2) return
    if (n.arguments[0]!.getText(file) !== `IPC.${channel}`) return
    const cb = n.arguments[1]!
    if (!(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return
    if (cb.body) out = cb.body.getText(file)
  })
  return out
}

const count = (hay: string, needle: string): number => hay.split(needle).length - 1

/**
 * 走这一对出口的函数体（按身份钉，第 37 条）：capture 的位置／换钥那一步／restore 的位置／留痕。
 * 外层函数剔掉（外层体的文本含内层的调用，会把同一处数两遍）。
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
      warns: text.split('if (webdavTicket.undecryptable)').length - 1
    })
  })
  return found
    .filter((outer) => !found.some((inner) => inner !== outer && outer.at < inner.at && inner.end <= outer.end))
    .map(({ capture, swap, restore, warns, at }) => ({ capture, swap, restore, warns, at }))
    .sort((a, b) => a.at - b.at)
}

const ROTATE_SITES = rekeySites(ROTATE, 'encryption.ts')
const BOOT_SITES = rekeySites(BOOT, 'index.ts')

describe('A 契约：一对出口＋一张票，restore 要交回"写没写成"', () => {
  it('WebDAVRekeyTicket 两项齐（cfg 为 null 与 undecryptable 为 true 不是同一档）', () => {
    const i = ifaceText('WebDAVRekeyTicket', SERVICE, 'backup-service.ts')
    expect(i, '契约没读到').not.toBe('')
    expect(i).toContain('cfg: WebDAVConfig | null')
    expect(i).toContain('undecryptable: boolean')
  })

  it('两个签名：capture 交回那张票、restore 交回布尔（不许演成"已处理"）', () => {
    expect(SERVICE).toMatch(/export function captureWebDAVForRekey\(\): WebDAVRekeyTicket/)
    expect(SERVICE).toMatch(/export function restoreWebDAVAfterRekey\(ticket: WebDAVRekeyTicket\): boolean/)
  })

  it('出口内部：解不开／没配过都直接不写（`if (!ticket.cfg) return false` 是第一句判据）', () => {
    const body = fnBody('restoreWebDAVAfterRekey', SERVICE, 'backup-service.ts')
    expect(body, '函数体没读到').not.toBe('')
    expect(body.indexOf('if (!ticket.cfg) return false')).toBeLessThan(body.indexOf('saveWebDAVConfig('))
  })
})

describe('B 五处同源：capture 早于换钥、换钥早于 restore、每处留一条痕', () => {
  it('encryption.ts 四处（改密／启用／禁用／恢复码）', () => {
    expect(ROTATE_SITES.length, '现数走出口的轮换点数').toBe(4)
  })

  it('index.ts 一处＝§383 漏收的那第五发（boot 首次设主密码）', () => {
    expect(BOOT_SITES.length, 'boot 那一发没走出口＝那一行的口令会被换钥判死').toBe(1)
  })

  it('每一处（五处一起过）：顺序对、且留一条痕', () => {
    const all = [...ROTATE_SITES, ...BOOT_SITES]
    expect(all.length).toBe(5)
    for (const [i, s] of all.entries()) {
      expect(s.swap, `第 ${i + 1} 处找不到"换钥那一步"`).toBeGreaterThan(-1)
      expect(s.restore, `第 ${i + 1} 处没有 restore 那一句`).toBeGreaterThan(-1)
      expect(s.capture < s.swap, `第 ${i + 1} 处 capture 排在换钥之后＝只能报"解不开"`).toBe(true)
      expect(s.swap < s.restore, `第 ${i + 1} 处 restore 排在换钥之前＝写的还是旧密钥`).toBe(true)
      expect(s.warns, `第 ${i + 1} 处没有留痕`).toBe(1)
    }
  })

  it('反向钉：五处之外没有第二份"自己搬那一行"的副本（这一层不再自己读／自己写）', () => {
    expect(count(ROTATE, 'saveWebDAVConfig('), 'encryption.ts 不许再自己写').toBe(0)
    expect(count(BOOT, 'saveWebDAVConfig('), 'index.ts 不许再自己写').toBe(0)
    expect(BOOT, 'index.ts 不许绕过出口自己读那一行').not.toMatch(/readWebDAVConfig\(/)
    expect(SERVICE.match(/export function captureWebDAVForRekey|export function restoreWebDAVAfterRekey/g), '出口各一颗').toHaveLength(2)
  })
})

describe('C 三发带回 count（§383 候选 ④ 的本体：解不开不只改密那发才有）', () => {
  it('四发的 return 都带 undecryptableCount，且都并进同一个 N（字段级 ∧ 出口那颗）', () => {
    expect(count(ROTATE, 'undecryptableCount: (fieldSnapshot.undecryptable?.length ?? 0) + (webdavTicket.undecryptable ? 1 : 0)'),
      '现数四处（改密／启用／禁用／恢复码）').toBe(4)
  })

  it('四发逐通道（按身份钉）：回调体里既走出口、又把那颗带回 return', () => {
    for (const ch of ['ENCRYPTION_CHANGE_PASSWORD', 'ENCRYPTION_DISABLE', 'ENCRYPTION_ENABLE', 'ENCRYPTION_RECOVER']) {
      const body = handlerBody(ch, ROTATE, 'encryption.ts')
      expect(body, `${ch} 的回调体没读到（通道改名？判据要跟着搬）`).not.toBe('')
      expect(body, `${ch} 没走这一对出口`).toContain('captureWebDAVForRekey()')
      expect(body, `${ch} 没走这一对出口`).toContain('restoreWebDAVAfterRekey(')
      expect(body, `${ch} 的回值没带 undecryptableCount＝那一发的"解不开"只留在日志`).toContain('undecryptableCount:')
    }
  })

  it('preload 三处类型都带上那颗（类型不诚实＝渲染层读不到，只有 tsc 看得见）', () => {
    expect(count(PRELOAD, 'undecryptableCount?: number'), '改密＋禁用＋启用＋恢复码').toBe(4)
    expect(PRELOAD).toMatch(/disableEncryption: \(password: string\): Promise<\{ ok: boolean; error\?: string; undecryptableCount\?: number \}>/)
    expect(PRELOAD).toMatch(/enableEncryption: \(password: string\): Promise<\{ ok: boolean; error\?: string; undecryptableCount\?: number \}>/)
    expect(PRELOAD).toMatch(/Promise<AuthResult & \{ recoveryCode\?: string; undecryptableCount\?: number \}>/)
  })
})

describe('D 消费面四处各自绑门：数字走 params，不许硬写中文', () => {
  const CALL = "t('enc.rotateUndecryptable', { n:"

  it('设置页三发（改密／启用／禁用）各一句 toast，且都先数了 count', () => {
    expect(count(SETTINGS, "r.undecryptableCount && r.undecryptableCount > 0"), '三道门各一处').toBe(3)
    expect(count(SETTINGS, 'toast.warning(t(\'enc.rotateUndecryptable\', { n: r.undecryptableCount }))'), '三句上屏').toBe(3)
  })

  it('向导那一格：state 从回值来、渲染绑 `> 0` 那道门', () => {
    expect(count(WIZARD, 'setEncUndecryptable(r.undecryptableCount ?? 0)'), '只有一处写').toBe(1)
    expect(count(WIZARD, 'encUndecryptable > 0'), '只有一处门').toBe(1)
    expect(count(WIZARD, "t('enc.rotateUndecryptable', { n: encUndecryptable })"), '只有一句').toBe(1)
  })

  it('解锁窗恢复成功页那一格：同样从回值来、绑门、走 params', () => {
    expect(count(UNLOCK, 'setRotatedUndecryptable(r.undecryptableCount ?? 0)'), '只有一处写').toBe(1)
    expect(count(UNLOCK, 'rotatedUndecryptable > 0'), '只有一处门').toBe(1)
    expect(count(UNLOCK, "t('enc.rotateUndecryptable', { n: rotatedUndecryptable })"), '只有一句').toBe(1)
  })

  it('反向钉：这一句在四个消费点都只走字典（不许有人把中文抄进组件）', () => {
    for (const [name, src] of [['SettingsModule', SETTINGS], ['FirstRunWizard', WIZARD], ['UnlockPage', UNLOCK]] as const) {
      expect(count(src, '本次密码轮换有'), `${name} 里出现硬写的中文那句`).toBe(0)
      expect(count(src, CALL), `${name} 的调用点总数`).toBeGreaterThan(0)
    }
  })
})

describe('E 四语：复用 §375 那一句，一字未动、每语一颗、都含 {n}', () => {
  it('四语都在且都含 {n}', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const v = (DICTS[lang] as Record<string, string>)['enc.rotateUndecryptable']
      expect(v, `${lang} 缺那颗`).toBeTruthy()
      expect(v, `${lang} 少了 {n}（数字必须走 params＝§379 那族口径）`).toContain('{n}')
    }
  })

  it('每语只出现一次（本批不新增键，也不许有人抄第二份）', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko'] as const) {
      expect(count(raw(`renderer/src/i18n/${lang}.ts`), "'enc.rotateUndecryptable':"), lang).toBe(1)
    }
  })
})

describe('F 手抄 backup-service 桩、又真测轮换的测试必须带上这一对出口', () => {
  const testDir = path.resolve(__dirname)
  const SELF = path.basename(__filename)
  const stubbers = fs
    .readdirSync(testDir)
    .filter((f) => f !== SELF && /\.(test|spec)\.[tj]sx?$/.test(f))
    .filter((f) => {
      const src = stripComments(fs.readFileSync(path.join(testDir, f), 'utf-8').replace(/\r\n/g, '\n'))
      return (
        src.includes("vi.mock('../src/main/backup/backup-service'") &&
        /ENCRYPTION_(DISABLE|ENABLE|RECOVER|CHANGE_PASSWORD)|registerEncryptionHandlers/.test(src)
      )
    })
    .sort()

  it('名单现数（多一处＝有人新抄这一层；少一处＝某份的读法漂了）', () => {
    expect(stubbers, `抄了 backup-service 又测轮换的测试：${stubbers.join(', ')}`).toEqual([
      'encryption-state-commit-order.test.ts',
      'unlock-boot-preverify.test.ts'
    ])
  })

  it('每一份的桩里都有 captureWebDAVForRekey（漏＝只有跑到那一发才以 {ok:false} 的脸出现）', () => {
    for (const f of stubbers) {
      const src = fs.readFileSync(path.join(testDir, f), 'utf-8')
      expect(src, `${f} 的手抄桩缺 captureWebDAVForRekey`).toContain('captureWebDAVForRekey')
      expect(src, `${f} 的手抄桩缺 restoreWebDAVAfterRekey`).toContain('restoreWebDAVAfterRekey')
    }
  })

  it('反向对照：把那颗摘掉，这套读法当场认得出缺', () => {
    const src = stripComments(fs.readFileSync(path.join(testDir, stubbers[0]!), 'utf-8').replace(/\r\n/g, '\n'))
    const one = src.replace(/^\s*captureWebDAVForRekey:.*$\n?/m, '')
    expect(one, '这一刀必须真削掉一行').not.toBe(src)
    expect(one).not.toContain('captureWebDAVForRekey')
  })
})

describe('G 读法自证：改前那一形喂进同一套读法，必须数成 0 处', () => {
  it('boot 改前那一支（只搬字段快照、没有这一行）＝读不出走出口的一处', () => {
    const BEFORE = [
      'async function bootSetPassword() {',
      '  const fieldSnapshot = exportFieldCredentials()',
      '  dbService.enableEncryption(prepared.key)',
      '  commitNewMasterKeyState(prepared)',
      '  restoreFieldCredentials(fieldSnapshot)',
      '}'
    ].join('\n')
    expect(rekeySites(BEFORE, 'before.ts'), '改前形状不该被数成"走出口"').toEqual([])
    // 同一套读法用在改后那一支上＝capture 在前、换钥在中、restore 在后、留痕一条
    const AFTER = [
      'async function bootSetPassword() {',
      '  const webdavTicket = captureWebDAVForRekey()',
      '  const fieldSnapshot = exportFieldCredentials()',
      '  dbService.enableEncryption(prepared.key)',
      '  restoreFieldCredentials(fieldSnapshot)',
      '  restoreWebDAVAfterRekey(webdavTicket)',
      '  if (webdavTicket.undecryptable) { log.warn("x") }',
      '}'
    ].join('\n')
    const s = rekeySites(AFTER, 'after.ts')
    expect(s.length).toBe(1)
    expect(s[0]!.capture).toBeLessThan(s[0]!.swap)
    expect(s[0]!.swap).toBeLessThan(s[0]!.restore)
    expect(s[0]!.warns, '块状的 if 那一形也认').toBe(1)
  })

  it('这套读法不是"碰巧"数出来的：换钥那一步挪走了，顺序判据当场没牙（swap 读成 -1）', () => {
    // 合成件：把改后那一支里的两个换钥标记都拿掉 ⇒ rekeySites 必须报 swap=-1（B 那一节会因此红，而不是放行）
    const NO_SWAP = [
      'async function h() {',
      '  const t = captureWebDAVForRekey()',
      '  restoreWebDAVAfterRekey(t)',
      '  if (t.undecryptable) log.warn("x")',
      '}'
    ].join('\n')
    const s = rekeySites(NO_SWAP, 'no-swap.ts')
    expect(s.length, '走出口的那一处还是该被数到（否则"5 处同源"是数了个空气）').toBe(1)
    expect(s[0]!.swap, '找不到换钥那一步＝这一处的顺序判据失去对象').toBe(-1)
  })
})
