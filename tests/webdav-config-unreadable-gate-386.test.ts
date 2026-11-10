// §386 常驻闸门：WebDAV 配置那一行「存在却读不出来」这一档，从读侧到屏侧一条链都不许断
//
// 这一面钉的是**结构**（行为那一半在 `backup-webdav-config-unreadable-386.test.ts`）：
//   A 契约三颗 flag 齐、catch 分支必须点亮第三颗（其余两支必须 false＝三档互斥）
//   B 六发动作同源（不许再有一处 `if (!cfg) return { ok:false, error:'未配置 WebDAV' }`）
//   C 那一读（LOAD_CONFIG）遇坏行必须回失败信封，且排在掩码之前
//   D 两处屏各自绑门，且第三档排在「没配过」之前（顺序反了＝新档永远不画）
//   E 两个调度器不许再把坏行演成安静
//   F 四语齐＋两两不同字＋渲染层不许硬写那句中文
//   G 读法自证：分类器在合成片段上要能认出"没绑门／绑错顺序"
//
// 计数一律读**去掉注释后的源码**（第 33 条：自己写的注释会把同一串撑大→假红／假绿）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const raw = (rel: string): string => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8')

/** 剥掉块注释与行注释（注释里会引用函数名与句子，计数必须只看代码） */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i + 2)
      i = end < 0 ? src.length : end + 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const SERVICE = stripComments(raw('main/backup/backup-service.ts'))
const HANDLERS = stripComments(raw('main/ipc/handlers/backup.ts'))
const SCHED = stripComments(raw('main/backup/backup-scheduler.ts'))
const TASKS = stripComments(raw('main/backup/task-scheduler.ts'))
const HEALTH = stripComments(raw('main/steward/data-health.ts'))
const DIAG = stripComments(raw('main/steward/diagnose.ts'))
const TYPES = stripComments(raw('shared/types.ts'))
const PANEL = stripComments(raw('renderer/src/modules/settings/DataHealthPanel.tsx'))
// §436：备份卡片片段（dh.backup → dh.tasks）。D/G 原先从全文第一个 value={ / warn={ 起读，
// 新增的冷数据段把锚点截断了；圈定到这一块，断言才有意义。
const BACKUP_SEG = PANEL.slice(PANEL.indexOf("t('dh.backup')"), PANEL.indexOf("t('dh.tasks')"))

const count = (src: string, needle: string): number => src.split(needle).length - 1

/** 取 `export function <name>` 的函数体（按大括号配平，够用到本文件所有锚点） */
function fnBody(src: string, decl: string): string {
  const i = src.indexOf(decl)
  expect(i, `找不到 ${decl}`).toBeGreaterThan(-1)
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1) }
  }
  throw new Error('大括号不配平')
}

/** 取接口文本（`export interface X { … }`） */
function ifaceText(src: string, name: string): string {
  const i = src.indexOf(`export interface ${name}`)
  expect(i, `找不到 interface ${name}`).toBeGreaterThan(-1)
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1) }
  }
  throw new Error('接口大括号不配平')
}

describe('A 契约：三档互斥，坏行必须点亮第三颗', () => {
  const read = fnBody(SERVICE, 'export function readWebDAVConfig')

  it('WebDAVConfigRead 三颗字段齐（cfg／passwordUndecryptable／configUnreadable）', () => {
    const iface = ifaceText(SERVICE, 'WebDAVConfigRead')
    for (const f of ['cfg: WebDAVConfig | null', 'passwordUndecryptable: boolean', 'configUnreadable: boolean']) {
      expect(iface, `契约缺 ${f}`).toContain(f)
    }
  })

  it('三个 return 各带回三颗：坏行那一支 configUnreadable: true，另两支 false', () => {
    const returns = read.split('return ').slice(1)
    expect(returns.length, `现数三个 return，读到 ${returns.length}`).toBe(3)
    for (const r of returns) {
      // 成功那一支是简写（`{ cfg, passwordUndecryptable, configUnreadable: false }`）⇒ 只要求三颗都在场
      for (const f of ['cfg', 'passwordUndecryptable', 'configUnreadable']) {
        expect(r, `有个 return 漏了 ${f}`).toContain(f)
      }
    }
    expect(returns.filter((r) => r.includes('configUnreadable: true')).length, '只许 catch 那一支为 true').toBe(1)
    expect(returns.filter((r) => r.includes('configUnreadable: false')).length).toBe(2)
  })

  it('catch 那一支绝不"重解析成空对象"或交出半成品 cfg（坏行＝cfg 交 null）', () => {
    const catchBranch = read.slice(read.indexOf('catch {'))
    expect(catchBranch).toContain('cfg: null')
    expect(catchBranch).toContain('configUnreadable: true')
    expect(catchBranch, '解不开与读不出来是两档，坏行不许顺带点亮').toContain('passwordUndecryptable: false')
  })

  it('数据健康契约也带第三颗（屏侧要按它画脸）', () => {
    const i = TYPES.indexOf('passwordUndecryptable: boolean')
    expect(i).toBeGreaterThan(-1)
    expect(TYPES.slice(i, i + 900), 'DataHealthReport.backup 缺 configUnreadable').toContain('configUnreadable: boolean')
  })

  it('生产者两处都搬这颗（初始那份＋try 里那份；漏一处＝坏行到屏上退成 false）', () => {
    expect(count(HEALTH, 'configUnreadable: wdRead.configUnreadable'), '现数 2 处').toBe(2)
  })
})

describe('B 六发动作同源：不许再有一处把坏行说成「未配置 WebDAV」', () => {
  it('取法出口只此一个，且六发全走它（清单那一发走的是第三档那道门，见下面那颗）', () => {
    expect(count(HANDLERS, 'loadWebDAVConfigOrError()'), '现数 6 发（上传／增量／恢复／合并扫描／合并执行／删除）').toBe(6)
    expect(count(HANDLERS, "'error' in got"), '每一发都得判这一句').toBe(6)
  })

  it('反向钉：backup.ts 里不许再留「!cfg 就说不曾配置」那种塌法', () => {
    expect(HANDLERS, '这一句把坏行与没配过合成一句').not.toContain("if (!cfg) return { ok: false, error: '未配置 WebDAV' }")
    expect(count(HANDLERS, "error: '未配置 WebDAV'"), '字面量一处都不许留（改由出口回）').toBe(0)
  })

  it('清单那一发：坏行回失败信封、真没配过仍回 []（§196 那档"没有备份"是真话，不许一并报失败）', () => {
    const body = fnBody(HANDLERS, 'safeHandle(IPC.BACKUP_WEBDAV_LIST')
    expect(body).toContain('if (read.configUnreadable) return { ok: false as const, error: WEBDAV_CONFIG_UNREADABLE_MSG }')
    expect(body, '坏行回 [] 就是本枚要收的那一形').not.toContain('if (!cfg) return []')
    expect(body).toContain('if (!read.cfg) return []')
  })
})

describe('C 那一读（LOAD_CONFIG）：坏行必须回失败信封，且排在掩码之前', () => {
  const body = fnBody(HANDLERS, 'safeHandle(IPC.BACKUP_WEBDAV_LOAD_CONFIG')

  it('有 configUnreadable 这道门，且门里回的是 ok:false', () => {
    expect(body).toContain('read.configUnreadable')
    expect(body.slice(body.indexOf('if (read.configUnreadable)')).split('\n')[0]).toContain('ok: false')
  })

  it('顺序：门排在 maskWebDAVConfig 之前（排在后面＝永远先画掩码视图）', () => {
    expect(body.indexOf('read.configUnreadable')).toBeLessThan(body.indexOf('maskWebDAVConfig(read)'))
  })
})

describe('D 两处屏各自绑门，第三档必须排在「没配过」之前', () => {
  it('数据健康那一格：backup.configUnreadable 在 !backup.configured 之前，且 warn 位也带上它', () => {
    expect(PANEL.indexOf('backup.configUnreadable')).toBeGreaterThan(-1)
    expect(PANEL.indexOf('backup.configUnreadable'), '顺序反了＝新档永远不画').toBeLessThan(PANEL.indexOf('!backup.configured'))
    // §436：原先取全文第一个 warn={，被上面新增的冷数据段截断 ⇒ 读到的是别人家的 warn。
    // 改成只读备份卡片这一块（dh.backup → dh.tasks），锚点坏了会先撞下面的长度断言，不会静默读空串。
    const warn = BACKUP_SEG.slice(
      BACKUP_SEG.indexOf('warn={'),
      BACKUP_SEG.indexOf('}', BACKUP_SEG.indexOf('warn={'))
    )
    expect(warn.length, '锚点没圈到备份卡片里的 warn').toBeGreaterThan(0)
    expect(warn, 'warn 位不许只靠 !configured 喂绿').toContain('backup.configUnreadable')
  })

  it('管家体检那一格：configUnreadable 分支排在 !wdRead.cfg 之前，且说的是"读不出来"不是"未配置"', () => {
    const i = DIAG.indexOf('wdRead.configUnreadable')
    expect(i).toBeGreaterThan(-1)
    expect(i, '顺序反了＝这一档永远走「未配置 WebDAV」那句').toBeLessThan(DIAG.indexOf('!wdRead.cfg'))
    const branch = DIAG.slice(i, DIAG.indexOf('} else if', i))
    expect(branch).toContain('读不出来')
    expect(branch, '这一档不许同时说"未配置"').not.toContain('未配置 WebDAV')
  })
})

describe('E 两个调度器不许把坏行演成安静', () => {
  it('定时备份的 tick：判据是「cfg 为 null 且不是坏行」才安静，且不许再用 loadWebDAVConfig() 那种塌法', () => {
    const body = fnBody(SCHED, 'export async function tick')
    expect(body).toContain('if (!wdRead.cfg && !wdRead.configUnreadable) return')
    expect(body, '这一句把坏行与没配过合成"安静跳过"').not.toContain('if (!loadWebDAVConfig()) return')
  })

  it('反向钉：真没配过那一档仍安静（不许把合法状态刷成每轮一条 warn）', () => {
    const body = fnBody(SCHED, 'export async function tick')
    expect(count(body, 'log.warn'), 'tick 里只许留原来那句异常兜底').toBeLessThanOrEqual(1)
  })

  it('备份校验：warn 必须绑在 configUnreadable 那条 IfStatement 之内', () => {
    const i = TASKS.indexOf('read.configUnreadable')
    expect(i).toBeGreaterThan(-1)
    const block = TASKS.slice(i, i + 400)
    expect(block).toContain('log.warn')
    expect(TASKS.slice(i - 60, i), '这一档必须自己 return，不许继续拿 null 往下跑').toContain('if (!read.cfg)')
  })
})

describe('F 四语与「不许硬写」', () => {
  const KEY = "'dh.backupCfgBroken'"
  const zh = raw('renderer/src/i18n/zh.ts')

  it('四语齐、每语只一颗、都真说出"读不出来"', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const src = raw(`renderer/src/i18n/${lang}.ts`)
      expect(count(src, KEY), lang).toBe(1)
      const m = src.match(/'dh\.backupCfgBroken':\s*'([^']*)'/)
      expect(m, `${lang} 没读到那句的值（读法退化＝整面无声变绿）`).not.toBeNull()
      const line = m![1]!
      expect(line.length, `${lang} 那句是空的`).toBeGreaterThan(10)
      expect(/读不出来|cannot be parsed|読み取れません|읽을 수 없습니다/.test(line), `${lang} 没说清"读不出来"：${line}`).toBe(true)
    }
  })

  it('三句两两不同字（zh）：新那句不许与「未配置」「解不开」共用文案', () => {
    const three = ['dh.backupNotConfigured', 'dh.backupPwdBroken', 'dh.backupCfgBroken'].map(
      (k) => zh.match(new RegExp(`'${k}':\\s*'([^']*)'`))![1]
    )
    expect(new Set(three).size, '三句必须两两不同字').toBe(3)
  })

  it('渲染层不许硬写那句中文（走键）', () => {
    expect(PANEL).not.toContain('读不出来')
    expect(PANEL).toContain("t('dh.backupCfgBroken')")
  })
})

describe('G 读法自证：分类器认得出"没绑门／绑错顺序"', () => {
  // §436：同 D 的锚点问题——从全文第一个 value={ 开始会被冷数据段截断。圈到备份卡片，
  // 并先断言圈到了东西：否则 GOOD 为空时 indexOf 全 -1，两例会以"-1 > -1"/"0 < 0"的形式假失败。
  const GOOD = BACKUP_SEG.slice(BACKUP_SEG.indexOf('value={'), BACKUP_SEG.indexOf('warn={'))

  it('读法本身：好形状能读出"第三档在前"', () => {
    expect(GOOD.length, '锚点没圈到备份卡片里的 value/warn').toBeGreaterThan(0)
    expect(GOOD.indexOf('backup.configUnreadable')).toBeGreaterThan(-1)
    expect(GOOD.indexOf('backup.configUnreadable')).toBeLessThan(GOOD.indexOf('!backup.configured'))
  })

  it('漏杀对照：把两个分支整体调序（＝改前那一形）⇒ 同一条顺序判据必须翻向', () => {
    const order = (src: string): number => src.indexOf('backup.configUnreadable') - src.indexOf('!backup.configured')
    expect(order(GOOD), '好形状＝新档在前').toBeLessThan(0)
    const swapped = GOOD
      .replace('backup.configUnreadable', '@NEW@')
      .replace('!backup.configured', 'backup.configUnreadable')
      .replace('@NEW@', '!backup.configured')
    expect(order(swapped), '调序后判据仍指"在前"＝读的是字面，不是顺序').toBeGreaterThan(0)
  })

  it('漏杀对照②：门在但 warn 位没绑（警示色丢）⇒ warn 判据必须抓出', () => {
    const noWarn = 'warn={!backup.configured || !backup.enabled}'
    expect(noWarn).not.toContain('backup.configUnreadable')
  })

  it('ts 真解析一次：读到的字段数不为零（读法退化成空读＝整面无声变绿，第 41 条）', () => {
    const file = ts.createSourceFile('p.tsx', raw('renderer/src/modules/settings/DataHealthPanel.tsx'), ts.ScriptTarget.ES2022, true)
    let hits = 0
    const walk = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'configUnreadable') hits++
      ts.forEachChild(n, walk)
    }
    walk(file)
    expect(hits, 'AST 读法在真源码上读出 0 处＝正则/AST 本身坏了').toBeGreaterThanOrEqual(2)
  })
})
