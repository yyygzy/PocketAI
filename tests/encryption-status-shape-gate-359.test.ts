// §359 闸门：`EncryptionStatus` 的字面量必须是主进程真能算出来的那一形状
//
// 为什么开这一面：§357 真机轮顺手读到 scratch 库上 `{mode:'none', fieldEncrypted:true}`，当时判为"未判定"。
// 回读 `src/main/ipc/handlers/encryption.ts` 后答案是**字段自己在说谎**：`unlocked`／`fieldEncrypted`／
// `masterPasswordVerified` 三份都算 `masterKeyManager.hasKey()`，而 `hasKey()` 在 none 模式恒为 true
// （`master-key.ts` 的 `init('none')` 直接标已解锁）⇒ 一台从没设过主密码的库会被告知「主密码已验证通过」。
// 备份那格（全仓唯一读者，`SettingsModule.tsx` 的 `dbEncrypted && masterPasswordVerified`）恰好被前一半挡住⇒ 无牙，
// 但 `backup-service.ts` 早就为同一个 `hasKey()` 坑写过"误报"注释——这颗地雷留着迟早有人踩。
//
// 于是本面做两件事：
//  ① 主进程按语义分开三个字段（`masterPasswordVerified` 改走现成谓词 `isDbEncrypted()`）；
//  ② 全仓扫 `EncryptionStatus` 字面量（源码与测试桩一起扫），**禁止写出主进程算不出的形状**——
//     本批动手前现数：10 个测试文件、11 处桩的形状是主进程算不出来的（`mode:'none'` 却 `masterPasswordVerified:true`、
//     `db` 锁定中 `fieldEncrypted:true`、`db` 档却 `kdfN:null`）。那些形状一旦留在桩里，
//     "照桩写断言"的用例就永远发现不了字段说谎（§330 的同类：桩是断言的地基）。
//  ③ 闸门自己也得有牙：第一趟变异轮 Y3/Y4/Y5 三颗全活，红因不是规则写错而是**字段没被读出来**——
//     `new RegExp('\b' + key)` 里的 `\b` 在 JS 字符串字面量里是退格符（要写 `\\b`），三份正则全 miss ⇒
//     `fields` 恒空 ⇒ 四条形状用例（五条判据）对着空 map 逐条放行、整面无声变绿。所以"不是空转"那一例除了数字面量，
//     还钉「能读出三个以上布尔字面量的条数」（读法一坏这里就是 0），Y7 专门打这颗。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const DIRS = ['src/main', 'src/renderer', 'src/preload', 'src/shared', 'tests']

const files = (() => {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
  }
  for (const d of DIRS) walk(path.join(ROOT, d))
  return out
})()

type Lit = { rel: string; line: number; mode: string; fields: Record<string, string>; raw: string }

/** 取一块 `mode:'none'|'db'` 起、往后最多 4 行、到 `}`／`,` 收尾的对象字面量，抓它那几个布尔字段 */
const lits: Lit[] = []
for (const abs of files) {
  const rel = abs.slice(ROOT.length + 1).replace(/\\/g, '/')
  const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i] ?? ''
    // 只认字面档位（`mode: 'none',`／`mode: 'db'}`）；形参类型 `mode: 'none' | 'db'` 不是形状
    const m = /mode:\s*'(none|db)'\s*(?:[,}]|$)/.exec(cur)
    if (!m) continue
    // 注释里举的例子不是形状（第 33 条：自己写的判语会把同一串撑大）
    if (/^\s*(\/\/|\*|\/\*)/.test(cur)) continue
    const block: string[] = []
    for (let k = i; k < Math.min(lines.length, i + 5); k++) {
      const nk = lines[k] ?? ''
      block.push(nk)
      if (/^\s*[})]/.test(nk) || /kdfAtCurrentTier/.test(nk)) break
    }
    const text = block.join('\n')
    // 不长得像 EncryptionStatus 的不算（别的类型也有 mode 字段）
    if (!/dbEncrypted|masterPasswordVerified|unlocked/.test(text)) continue
    const fields: Record<string, string> = {}
    for (const key of ['unlocked', 'dbEncrypted', 'fieldEncrypted', 'masterPasswordVerified', 'kdfN', 'kdfAtCurrentTier']) {
      // 反斜杠要双写：`'b'` 在字符串字面量里是退格符、`'s'` 是字母 s（变异轮 Y3/Y4/Y5 活着的成因
      // ——三份正则都读不到字段，rules 便对着空 map 逐条放行）
      const fm = new RegExp('\\b' + key + ':\\s*([^,\\n}]+)').exec(text)
      const val = fm ? (fm[1] ?? '').trim() : ''
      // 三元的桩（`mode === 'db' ? … : …`）两档都算得出，不参与判形状
      if (val && !val.includes('?')) fields[key] = val
    }
    lits.push({ rel, line: i + 1, mode: m[1] ?? '', fields, raw: text.replace(/\s+/g, ' ').slice(0, 150) })
  }
}

describe('§359 EncryptionStatus 的字面量形状必须算得出来', () => {
  it('这一面不是空转：字面量数量、以及「字段真的被读出来了」的数量都要对上现查', () => {
    expect(lits.length, `现数 ${lits.length}：\n${lits.map((l) => `  ${l.rel}:${l.line}`).join('\n')}`).toBeGreaterThanOrEqual(12)
    // 第二条钉的是**读法**而不是名单：正则一退化成"读不到字段"（`'\b'` 是退格符那类写法），
    // 四条形状用例（五条判据）就全对着空 map 放行、整面变绿而无声——只有这一句会红。（变异轮 Y3/Y4/Y5 第一趟就是这么活的）
    const read = lits.filter((l) => Object.keys(l.fields).length >= 3)
    expect(read.length, `现数 ${read.length}：能读出三个以上布尔字段的字面量（读法坏了这里是 0）\n${lits.map((l) => `  ${l.rel}:${l.line} -> ${JSON.stringify(l.fields)}`).join('\n')}`).toBeGreaterThanOrEqual(12)
  })

  it('none 档不许出现"已加密／主密码已验证／有档位 N"（主进程算不出这一形状）', () => {
    const bad = lits
      .filter((l) => l.mode === 'none')
      .filter((l) => l.fields.dbEncrypted === 'true' || l.fields.masterPasswordVerified === 'true' || (l.fields.kdfN !== undefined && l.fields.kdfN !== 'null') || l.fields.kdfAtCurrentTier === 'true')
    expect(bad.map((l) => `${l.rel}:${l.line} ${l.raw}`), 'none 档的非法字面量').toEqual([])
  })

  it('db 档：`dbEncrypted` 必 true，且 `masterPasswordVerified` 与 `unlocked` 同值（锁定时就是没验证过）', () => {
    const bad = lits
      .filter((l) => l.mode === 'db')
      .filter((l) => {
        if (l.fields.dbEncrypted !== undefined && l.fields.dbEncrypted !== 'true') return true
        if (l.fields.masterPasswordVerified !== undefined && l.fields.unlocked !== undefined) {
          return l.fields.masterPasswordVerified !== l.fields.unlocked
        }
        return false
      })
    expect(bad.map((l) => `${l.rel}:${l.line} ${l.raw}`), 'db 档的非法字面量').toEqual([])
  })

  it('`fieldEncrypted` 与 `unlocked` 同值（两份都取 `hasKey()`，桩不许各写一个值）', () => {
    const bad = lits.filter((l) => l.fields.fieldEncrypted !== undefined && l.fields.unlocked !== undefined && l.fields.fieldEncrypted !== l.fields.unlocked)
    expect(bad.map((l) => `${l.rel}:${l.line} ${l.raw}`), '两值不一致的字面量').toEqual([])
  })

  it('db 档的 `kdfN` 不许是 null（主进程只有 none 模式才回 null）', () => {
    const bad = lits.filter((l) => l.mode === 'db' && l.fields.kdfN === 'null')
    expect(bad.map((l) => `${l.rel}:${l.line} ${l.raw}`), 'db 档却写 kdfN:null').toEqual([])
  })

  it('主进程那一发按语义分算三个字段（逐字钉住，别退回三份 `hasKey()`）', () => {
    const body = fs.readFileSync(path.join(ROOT, 'src/main/ipc/handlers/encryption.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(/masterPasswordVerified:\s*masterKeyManager\.isDbEncrypted\(\)/.test(body), '「主密码已验证」得走 db 档且已解锁那道谓词').toBe(true)
    expect(/dbEncrypted:\s*masterKeyManager\.getMode\(\) === 'db'/.test(body), '「库已加密」只看模式（锁定后必须仍为 true，锁屏 UI 靠它）').toBe(true)
    expect(/fieldEncrypted:\s*masterKeyManager\.hasKey\(\)/.test(body), '字段那一发仍是「现在能不能加解密」').toBe(true)
  })

  it('唯一读者那一行仍是与运算（none 档改值不可能改屏上结果＝结构可证的零变化）', () => {
    const sm = fs
      .readFileSync(path.join(ROOT, 'src/renderer/src/modules/settings/SettingsModule.tsx'), 'utf8')
      .split('\r')
      .join('')
    expect(/const encrypted = !!enc\?\.dbEncrypted && !!enc\?\.masterPasswordVerified/.test(sm), 'BackupPanel 那格的闸门写法变了：本批「零界面变化」的论证不再成立，要补真挂载用例').toBe(true)
  })
})
