// V4-Iter-382 闸门：两处「已配置」不许再把"口令解不开"画成正常
//
// 病灶两枚（同一颗 flag，两个可见面各自说谎）：
//   ①`steward/data-health.ts` 里 `configured = !!loadWebDAVConfig()` ⇒ 数据健康「定时备份」那一格
//     说「已开启，每 N 小时」／「已配置，定时未开启」，且 warn 只由 `!configured || !enabled` 决定；
//   ②`steward/diagnose.ts`（runAudit 的 backup-cloud 那一格）走 else 支 ⇒
//     「WebDAV 已配置，定时备份每 N 小时执行」＋`level:'ok'`（既上管家屏也进导出报告）。
// 修法＝两处都换成 `readWebDAVConfig()`（判据排在密文被覆盖成明文之前，§381 那条纪律）＋三档各自表态。
// `backup/backup-scheduler.ts` 的 tick **故意不动**：那一判只决定"要不要试"，试了必失败并把
// `{ok:false,error}` 落进 K_LAST_RESULT ⇒ 上面两处读得到真失败；改成"解不开就不试"＝把错误咽掉，负收益。
//
// 本闸门守五件事：A 契约两颗字段在／B 两处取法＋反向钉全仓不许有 `!!loadWebDAVConfig(`／
// D 诊断那一格绑在那一条 IfStatement 之内／E 四语那句齐且真说了"解不开"（键＝bk.pwdUndecryptable）／
// F 手抄 backup-service 桩的那几份测试必须带上 readWebDAVConfig／G 诊断改前那一形的读法自证
// （原 C 组守的是数据健康那一格；该格已下线，屏侧判据改钉 `webdav-config-unreadable-gate-386` 的 D 组）
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const ROOT = path.resolve(__dirname, '..')

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
  fs.readFileSync(path.join(ROOT, 'src', rel), 'utf-8').replace(/\r\n/g, '\n')
const read = (rel: string): string => stripComments(raw(rel))

const TYPES = read('shared/types.ts')
const DH = read('main/steward/data-health.ts')
const DIAG = read('main/steward/diagnose.ts')
const SCHED = read('main/backup/backup-scheduler.ts')
const DICTS = { zh, en, ja, ko } as const
type Lang = keyof typeof DICTS

const sf = (name: string, src: string): ts.SourceFile =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node)
  node.forEachChild((c) => walk(c, cb))
}

/** `DataHealthReport.backup` 那一层里的属性名清单（按类型声明读，不数全文出现次数） */
function backupMembers(src: string): string[] {
  const file = sf('types.ts', src)
  const names: string[] = []
  walk(file, (n) => {
    // 接口的成员列表是 InterfaceBody（不是 TypeLiteralNode），两条路分开走
    const members: ts.NodeArray<ts.TypeElement> | undefined = ts.isInterfaceDeclaration(n)
      ? n.members
      : ts.isTypeAliasDeclaration(n) && n.name.getText(file) === 'DataHealthReport' && ts.isTypeLiteralNode(n.type)
        ? n.type.members
        : undefined
    if (!members) return
    if (ts.isInterfaceDeclaration(n) && n.name.getText(file) !== 'DataHealthReport') return
    for (const prop of members) {
      if (!ts.isPropertySignature(prop) || !prop.name) continue
      if (prop.name.getText(file) !== 'backup') continue
      if (!prop.type || !ts.isTypeLiteralNode(prop.type)) continue
      for (const inner of prop.type.members) {
        if (ts.isPropertySignature(inner) && inner.name) names.push(inner.name.getText(file))
      }
    }
  })
  return names
}

/** 某个调用形状在本文件里的出现次数：`name(` 前面不许有 `await` 之外的判断（这里只数身份） */
function callCount(src: string, needle: string): number {
  return src.split(needle).length - 1
}

/**
 * runAudit 里那条「backup-cloud」的 if／else-if 链：返回每一支的 (条件, 体内文本)。
 * 第 34 条：判据要绑到那一条 IfStatement 的 thenStatement 之内，别在宿主函数上汇总。
 */
function backupCloudBranches(src: string): Array<{ cond: string; body: string }> {
  const file = sf('diagnose.ts', src)
  const out: Array<{ cond: string; body: string }> = []
  const matches = (n: ts.Node): n is ts.IfStatement =>
    ts.isIfStatement(n) && n.thenStatement.getText(file).includes("id: 'backup-cloud'")
  walk(file, (n) => {
    if (!matches(n)) return
    // 只取最外那一条：else-if 链里那一支自己也匹配，会把同一条链数两遍
    let p: ts.Node | undefined = n.parent
    while (p) {
      if (matches(p)) return
      p = p.parent
    }
    out.push({ cond: n.expression.getText(file), body: n.thenStatement.getText(file) })
    let cur: ts.Node | undefined = n.elseStatement
    while (cur) {
      if (ts.isIfStatement(cur)) {
        out.push({ cond: cur.expression.getText(file), body: cur.thenStatement.getText(file) })
        cur = cur.elseStatement
      } else {
        out.push({ cond: '<else>', body: cur.getText(file) })
        cur = undefined
      }
    }
  })
  return out
}

// 改前那一形（两档 if／else、else 里直接 ok／warn）：喂进同一套读法必须被认成"没判"
const BEFORE_DIAG = [
  '    if (!wdRead.cfg) {',
  "      checks.push({ id: 'backup-cloud', level: 'warn' })",
  '    } else {',
  '      checks.push({',
  "        id: 'backup-cloud',",
  "        level: schedule.enabled ? 'ok' : 'warn',",
  "        detail: 'WebDAV 已配置'",
  '      })',
  '    }'
].join('\n')

describe('A 契约：那一格要两颗字段，不许退回单档布尔', () => {
  it('DataHealthReport.backup 的成员里 configured 与 passwordUndecryptable 都在（读类型声明，不数出现次数）', () => {
    const m = backupMembers(TYPES)
    expect(m, `backup 那层读到的成员＝${m.join(', ')}`).toContain('configured')
    expect(m).toContain('passwordUndecryptable')
  })

  it('反向钉：§381 那份出 IPC 的掩码视图仍带着同一颗（这次没把它挪走或改名）', () => {
    expect(TYPES).toContain('passwordUndecryptable: boolean')
  })
})

describe('B 两处取法：读的是 readWebDAVConfig，且全仓不再有「!!load」那种存在性判法', () => {
  it('data-health 与 diagnose 两处都换成 readWebDAVConfig，本文件里 loadWebDAVConfig 归零', () => {
    expect(callCount(DH, 'readWebDAVConfig(')).toBe(1)
    expect(callCount(DIAG, 'readWebDAVConfig(')).toBe(1)
    expect(callCount(DH, 'loadWebDAVConfig('), 'data-health 还留着那一读＝解不开那档又被折成 true').toBe(0)
    expect(callCount(DIAG, 'loadWebDAVConfig('), 'diagnose 同上').toBe(0)
  })

  it('反向钉：`!!loadWebDAVConfig(` 这种存在性判法全仓归零（新加一处就得在这里过目）', () => {
    const hits: string[] = []
    const srcRoot = path.join(ROOT, 'src')
    const scan = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) {
          scan(abs)
          continue
        }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        // raw() 的参数是"src 之下"的相对路径，这里现算，别把 'src/' 再拼一遍
        const rel = path.relative(srcRoot, abs).replace(/\\/g, '/')
        if (stripComments(raw(rel)).includes('!!loadWebDAVConfig(')) hits.push(rel)
      }
    }
    scan(srcRoot)
    expect(hits, `还有一处把"有配置"判成"能用"：${hits.join(', ')}`).toEqual([])
  })

  it('tick 那一处仍在（§386 把它从 `!loadWebDAVConfig()` 搬成三态那一读；§382 那半口径不许变＝解不开照样往下试）', () => {
    expect(SCHED).toContain('if (!wdRead.cfg && !wdRead.configUnreadable) return')
    // 反向钉：§382 的判语不许被推翻——tick 一旦拿那颗 flag 当门，每轮的真失败就被咽进安静里
    expect(SCHED, 'tick 开始拿 passwordUndecryptable 当门＝§382 的口径被推翻').not.toContain(
      'if (wdRead.passwordUndecryptable) return'
    )
    expect(raw('main/backup/backup-scheduler.ts')).toContain('§382')
  })
})

// 数据健康那一格（第三张脸）已随「备份状态三行」下线，C 组（那一格的 AST 结构）与 G 组里
// 依赖它的两条读法自证一并退役；同一件事的屏侧判据改钉在 `webdav-config-unreadable-gate-386`
// 的 D 组（设置页备份卡片：读不出来与没配过互斥）。

describe('D 诊断那一格：绑在那一条 IfStatement 之内', () => {
  const branches = backupCloudBranches(DIAG)

  it('链上确实有一条走那颗 flag 的独立支（不是塞进 else 里再加一句）', () => {
    const broken = branches.filter((b) => b.cond.includes('passwordUndecryptable'))
    expect(broken.length).toBe(1)
    // 按属性取值，不拿整支的文本去含混过关（那一支头顶的注释里也写着"解不开"，数文本会把它喂绿）
    const detail = /detail:\s*'([^']*)'/.exec(broken[0]!.body)?.[1] ?? ''
    const level = /level:\s*'([^']*)'/.exec(broken[0]!.body)?.[1] ?? ''
    expect(level, '那一支的 level 不是 warn').toBe('warn')
    expect(detail, '那一支的 detail 没说出"解不开"').toContain('解不开')
  })

  it('那一支里不再推 backup-freshness（第三张脸已经比"最近一次成功备份"更重，不摆相互矛盾的两句）', () => {
    const broken = branches.find((b) => b.cond.includes('passwordUndecryptable'))
    expect(broken).toBeTruthy()
    expect(broken!.body).not.toContain('backup-freshness')
  })

  it('正常那一档的旧话术一字未动（正向对照：新判据没把"每 N 小时执行"那句一起删掉）', () => {
    const ok = branches.find((b) => b.cond === '<else>')
    expect(ok).toBeTruthy()
    expect(ok!.body).toContain('每 ${schedule.intervalHours} 小时执行')
    expect(ok!.body).toContain("level: schedule.enabled ? 'ok' : 'warn'")
  })
})

describe('E 四语：屏上那句「解不开」齐、且每一语都真的说了这件事', () => {
  const MUST: Record<Lang, string> = {
    zh: '解不开',
    en: 'cannot be decrypted',
    ja: '復号できません',
    ko: '해독할 수 없습니다'
  }

  // 数据健康那一格退役后，这句的可见面只剩备份卡片上的 `bk.pwdUndecryptable`（同一件事、同一口径）
  it('bk.pwdUndecryptable 四语都在、非空', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const v = (DICTS[lang] as unknown as Record<string, string>)['bk.pwdUndecryptable']
      expect(v, `${lang} 缺那颗键`).toBeTruthy()
    }
  })

  it('每一语都含自己那语的"解不开"说法（不许只翻译了一半就把事说成正常）', () => {
    for (const lang of Object.keys(DICTS) as Lang[]) {
      const v = (DICTS[lang] as unknown as Record<string, string>)['bk.pwdUndecryptable']!
      expect(v, `${lang} 那句没说出"解不开"`).toContain(MUST[lang])
    }
  })

  it('zh 那两句两两不同字（撞字＝按文本找元素的那套读法会认错）', () => {
    const two = ['dh.backupNotConfigured', 'bk.pwdUndecryptable'].map((k) => zh[k as keyof typeof zh])
    expect(new Set(two).size).toBe(2)
  })
})

describe('F 手抄 backup-service 桩的那几份测试必须带上 readWebDAVConfig', () => {
  const testDir = path.join(ROOT, 'tests')
  // 现数：谁 mock 了这一层、又真跑到 data-health／diagnose，谁就得连新那颗一起抄。
  // 闸门文件自己也含这两串（读法用字面量），必须按文件名排除自身，否则名单永远多一颗
  const SELF = 'webdav-configured-face-gate-382.test.ts'
  const stubbers = fs
    .readdirSync(testDir)
    .filter((f) => /\.test\.(ts|tsx)$/.test(f) && f !== SELF)
    .filter((f) => {
      const src = stripComments(fs.readFileSync(path.join(testDir, f), 'utf-8').replace(/\r\n/g, '\n'))
      return (
        src.includes("vi.mock('../src/main/backup/backup-service'") &&
        /(steward\/data-health|steward\/diagnose)/.test(src)
      )
    })
    .sort()

  it('名单现数五份（多一处＝有人在抄这一层而没被看到；少一处＝某份的读法漂了）', () => {
    expect(stubbers).toEqual([
      'data-health-backup-face-382.test.ts',
      'data-health-sizes-real-fs.test.ts',
      // §395 新增：这一份 mock 了同一层、又真跑 data-health 的任务那一组，桩形状必须跟着带 readWebDAVConfig
      'data-health-task-last-ok-395.test.ts',
      'data-health.test.ts',
      'diagnose.test.ts'
    ])
  })

  it('每一份的桩里都有 readWebDAVConfig（漏＝只有跑到那一发才红，本批就是这么撞过一次 §381）', () => {
    for (const f of stubbers) {
      const src = fs.readFileSync(path.join(testDir, f), 'utf-8')
      expect(src, `${f} 的手抄桩缺 readWebDAVConfig`).toContain('readWebDAVConfig')
    }
  })

  it('反向对照：把那颗摘掉，这套读法当场认得出缺（"名单齐"不是瞎的）', () => {
    // 注释里也可能提到那颗（本批新写的桩就带了说明），所以按剥注释后的源码判
    const one = stripComments(fs.readFileSync(path.join(testDir, stubbers[0]!), 'utf-8').replace(/\r\n/g, '\n'))
      .replace(/^\s*readWebDAVConfig:.*$/m, '')
    expect(one).not.toContain('readWebDAVConfig')
  })
})

describe('G 读法自证：改前的形状喂进同一套读法，必须读成"没判"', () => {
  it('诊断那一形（两档 if／else、else 里直接 ok／warn）⇒ 链上没有走 flag 的那一支', () => {
    const branches = backupCloudBranches(BEFORE_DIAG)
    expect(branches.length).toBeGreaterThan(0)
    expect(branches.some((b) => b.cond.includes('passwordUndecryptable'))).toBe(false)
    expect(branches.some((b) => b.body.includes("level: schedule.enabled ? 'ok' : 'warn'"))).toBe(true)
  })
})
