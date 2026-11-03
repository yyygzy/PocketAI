// @vitest-environment node
// §399① 常驻闸门：Agent 输入框左端收成一颗「+」——入口唯一、新原语的形状、以及「读不到」那张脸不许搬进浮层。
//
// 钉的五件事：
//   A 入口唯一＝那颗「+」是输入行上唯一的上下文入口（旧的平铺附件键写法不许回来；片段只以 `variant="row"` 出现一次）；
//   B 新原语的形状＝fixed（absolute 会被 `overflow-hidden` 裁切）＋两个监听成对挂摘＋Esc 不越级关嵌套层；
//   C 那句不搬家＝两处 `role="alert"` 都排在 `<FloatingPanel` 之前，且菜单里那句"暂无可选项"必须与 `!kbsFail` 同现
//     （读失败时菜单里一个字都不加——菜单一关就不说话＝替这次失败闭嘴，§268 那条）；
//   D 菜单里的名词全取既有键（要往菜单里塞新文案，先改这份名单＝逼人工过目）；
//   E 读法自证＝把"改前那一版"喂进同一套读法，必须被认成"没有 + 入口、句子在浮层之后"；
//   F §399②a 升级回显＝那颗「+」的危险色由四项一起点名、搬进来的两项各有一句在浮层外面＋同级键，
//     且顶栏那两份第二脸归零（搬完就得是搬完）。
//
// 计数一律读**去掉注释后的源码**（第 33 条：自己写的注释会把同一串撑大→假红／假绿）；
// 取锚点全部写在 `it` 里面（§396 的教训：写在 `describe` 期一漂就整份文件收集期崩，变异轮会把抓到报成存活）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')

/** 剥块注释＋整行／行尾行注释（字符串里的 `//` 不参与：这三份文件里没有那种写法，探针核过） */
function stripComments(src: string): string {
  src = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return src
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('//')) return ''
      return line.replace(/(?<!:)\s\/\/[^"]*$/, '')
    })
    .join('\n')
}

const read = (rel: string): string => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'))

const AC = 'src/renderer/src/modules/agent/components/AgentComposer.tsx'
const BAR = 'src/renderer/src/modules/agent/components/AgentModelBar.tsx'
const FP = 'src/renderer/src/components/FloatingPanel.tsx'
const SB = 'src/renderer/src/components/SnippetButton.tsx'

/** 取 `<FloatingPanel …> … </FloatingPanel>` 那一段（菜单本体的边界，不含输入框其余 JSX） */
function panelRange(src: string): string {
  const start = src.indexOf('<FloatingPanel')
  expect(start, 'AgentComposer 里没有 <FloatingPanel').toBeGreaterThan(-1)
  const end = src.indexOf('</FloatingPanel>', start)
  expect(end, '<FloatingPanel> 没有配平的收尾').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('A 入口唯一', () => {
  it('五颗 testid 各一处；旧的平铺附件写法与第二份片段键都不许回来', () => {
    const ac = read(AC)
    // §399②a 又收进来两行（文本协议／工作目录），所以这份名单从三颗长到五颗
    for (const id of [
      'agent-composer-plus',
      'agent-composer-plus-menu',
      'agent-composer-plus-file',
      'agent-composer-plus-text-protocol',
      'agent-composer-plus-workspace'
    ]) {
      expect(ac.split(`data-testid="${id}"`).length - 1, `现数 ${id}`).toBe(1)
    }
    // 改前那一形：附件键直接挂在输入行上（`onClick={openPicker}`），现在它只能是菜单里那一行
    expect(ac.includes('onClick={openPicker}'), '平铺的附件键写法回来了').toBe(false)
    expect(ac.split('<SnippetButton').length - 1, '片段键只能有一处').toBe(1)
    expect(panelRange(ac)).toContain('variant="row"')
  })

  it('`openPicker()` 全文件恰好两处＝菜单那一行＋@ 路径的「选择新文件」，没多出第三个入口', () => {
    const ac = read(AC)
    expect(ac.split('openPicker()').length - 1, '现数 openPicker 调用点').toBe(2)
    // 片段与知识库接的也是既有出口：`addKbChip(` 两处＝定义＋一处调用（@ 那条路改走同一颗 helper）
    expect(ac.split('addKbChip(').length - 1, '现数 addKbChip 出现').toBe(2)
  })
})

describe('B 新原语的形状', () => {
  it('fixed 一处、absolute 零处；两个监听成对挂摘；Esc 不越级关嵌套层', () => {
    const fp = read(FP)
    const count = (s: string, x: string): number => s.split(x).length - 1
    expect(count(fp, "position: 'fixed'"), '浮层必须是 fixed（absolute 会被 overflow-hidden 裁切）').toBe(1)
    expect(count(fp, "position: 'absolute'"), '这份原语里不许混 absolute').toBe(0)
    expect(count(fp, 'addEventListener'), 'mousedown＋keydown 两颗').toBe(2)
    expect(count(fp, 'removeEventListener'), '摘除要成对（挂在 effect 里不摘＝泄漏）').toBe(2)
    expect(count(fp, 'Escape'), 'Esc 一颗').toBe(1)
    expect(count(fp, 'data-esc-nested'), '嵌套层先收那道判据在').toBe(1)
    expect(count(fp, 'anchorRef.current?.contains(tgt)'), '锚点自身不算外部').toBe(1)
    // 片段那侧要真的带上这颗标记，否则上面那条判据是空的
    expect(read(SB)).toContain('data-esc-nested')
  })
})

describe('C 「读不到」那张脸不搬进浮层', () => {
  it('四处 `role="alert"`（知识库／片段／文本协议／工作目录）都排在 `<FloatingPanel` 之前＝菜单关着也看得见', () => {
    const ac = read(AC)
    const panel = ac.indexOf('<FloatingPanel')
    const alerts = [...ac.matchAll(/role="alert"/g)].map((m) => m.index)
    expect(alerts.length, '现数 alert 落点（§399②a 把这两项搬进来时，各配了自己那一句）').toBe(4)
    for (const at of alerts) expect(at < panel, '有一句跑到浮层里面去了').toBe(true)
    // 三颗出口同理：它们都在浮层外面，且在浮层之前
    for (const id of ['agent-composer-kbs-retry', 'agent-composer-text-protocol-retry', 'agent-composer-workspace-retry']) {
      const at = ac.indexOf(id)
      expect(at, `${id} 该在场`).toBeGreaterThan(-1)
      expect(at < panel, `${id} 被关进菜单＝一关就没出口`).toBe(true)
    }
  })

  it('菜单里那句"暂无可选项"与 `!kbsFail` 同现＝读失败时那里一个字都不加（不是"这里没东西"的替身）', () => {
    const seg = panelRange(read(AC))
    const at = seg.indexOf('ccb.none')
    expect(at, '菜单里没有那句空态').toBeGreaterThan(-1)
    // 那句所在的那一支条件（往前 200 字里找它自己的守卫）必须带 `!kbsFail`
    expect(seg.slice(Math.max(0, at - 200), at)).toContain('!kbsFail')
    // 「还在加载」那一支与它是**两个条件**（§222：两种到货分开），且各自独立成段
    expect(seg.slice(0, at)).toContain('kbsRef.current === null')
  })
})

describe('D 菜单里的名词全取既有键', () => {
  it('现数名单逐字钉死：往菜单里塞新文案要先改这份名单（＝逼人工过目）', () => {
    const seg = panelRange(read(AC))
    // 去重：同一份屏上数据会被多处取（那颗附件键既当 `title` 又当行内文字），判据问的是"有哪些键"
    const keys = [...new Set([...seg.matchAll(/t\('([A-Za-z.]+)'\)/g)].map((m) => m[1] as string))].sort()
    expect(
      keys.join(' '),
      `菜单里的键漂了（现数 ${keys.join(' ')}）——新文案要先想清楚是不是该在②那枚再收进来`
    ).toBe(
      // §399②a 收进来的两行用的全是顶栏那两颗徽标的既有键（零新文案）：名单从 5 颗长到 15 颗
      'agent.queue.textOnly agent.textProtocol agent.textProtocolHint agent.textProtocolOn agent.textProtocolOnHint ' +
        'agent.textProtocolReadFail agent.textProtocolUnread agent.workspaceNone agent.workspacePickTip ' +
        'agent.workspaceReadFail agent.workspaceUnread ccb.none common.attachFile common.docs mention.knowledge'
    )
  })

  it('那颗新键四语都在且非空（一致性由 i18n-parity 守，这里只钉"别只写了中文"）', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const d = fs.readFileSync(path.join(ROOT, 'src/renderer/src/i18n', `${lang}.ts`), 'utf-8')
      const v = /'agent\.plusMenu':\s*'([^']+)'/.exec(d)?.[1]
      expect(v, `${lang} 缺这颗或值是空的`).toBeTruthy()
    }
    // 它必须真的被引用（死键判据）
    expect(read(AC).split('agent.plusMenu').length - 1, '现数引用次数').toBe(2)
  })
})

describe('E 读法自证：改前那一版喂进同一套读法，要认得出"没分岔"', () => {
  it('合成"两颗平铺键＋句子搬进浮层"的形状⇒ A 与 C 的三条判据都要认出来', () => {
    const bad = `<button onClick={openPicker} title={t('common.attachFile')}>clip</button>
      <SnippetButton onInsert={insertAtCursor} disabled={running} />
      <FloatingPanel anchorRef={plusRef} onClose={close}>
        <div role="alert">{t('common.loadFailedNamed')}</div>
        {t('ccb.none')}
      </FloatingPanel>`
    // A：平铺那颗键回来了
    expect(bad.includes('onClick={openPicker}'), '改前那一形该被认出来').toBe(true)
    // C：句子跑到浮层里面（现行判据＝alert 必须在 `<FloatingPanel` 之前）
    expect(bad.indexOf('role="alert"') > bad.indexOf('<FloatingPanel'), '这一版的句子在浮层里＝判据要认得出').toBe(true)
    // C 的另一半：那句"暂无可选项"没有 `!kbsFail` 守卫＝它成了"读不到"的替身
    expect(panelRangeish(bad)).not.toContain('!kbsFail')
  })

  it('反向对照：现行源码过同一套读法（合成段能被抓红不代表读法本身空转）', () => {
    const ac = read(AC)
    expect(ac.includes('onClick={openPicker}')).toBe(false)
    expect(ac.indexOf('role="alert"')).toBeLessThan(ac.indexOf('<FloatingPanel'))
    expect(panelRange(ac)).toContain('!kbsFail')
  })
})

/** E 段那份合成源码的"面板区间"取法（与 `panelRange` 同一口径，只是不预先断存在） */
function panelRangeish(src: string): string {
  const start = src.indexOf('<FloatingPanel')
  const end = src.indexOf('</FloatingPanel>', start)
  return src.slice(start, end < 0 ? src.length : end)
}

describe('F 升级回显（§399②a：常态只一颗徽标，坏消息时才就地长句子）', () => {
  it('那颗「+」的颜色由四项一起点名，且危险色只挂在 plusDanger 那一支上', () => {
    const ac = read(AC)
    // 判据盯**渲染条件本身**（第 14 条）：这四项少一项，那一档坏消息就没人说
    expect(
      ac.includes('const plusDanger = !!(kbsFail || snippetsFail || textProtocolUnread || workspaceUnread)'),
      '「+」的危险色不再是四项里某几项的函数'
    ).toBe(true)
    expect(ac.split('plusDanger').length - 1, '定义一处＋徽标那一支一处').toBe(2)
    // 取徽标那一支（第二处 `plusDanger` 之后）：JSX 里它与 `? …` 之间会换行，别按单行拼锚点
    const at = ac.lastIndexOf('plusDanger')
    expect(at, '徽标的 className 没走 plusDanger 三元').toBeGreaterThan(ac.indexOf('plusDanger'))
    const win = ac.slice(at, at + 300)
    expect(win).toContain('text-[var(--color-danger)]')
    // 反向钉：两色各一次＝这是"二选一"，不是"那颗徽标常驻危险色"（常态不占行、也不常驻报警色）
    expect(win.split('text-[var(--color-danger)]').length - 1, '危险色那一支').toBe(1)
    expect(win.split('text-[var(--color-text-muted)]').length - 1, '常态那一支').toBe(1)
  })

  it('搬进来的这两项：一句一条件一键，且各自的键都在浮层外面（不是把顶栏那颗 title 搬进菜单就当说过了）', () => {
    const ac = read(AC)
    // 守卫名与名词成对（第 22 条）：只数文案会放过把守卫换成 `false &&` 那种写法
    expect((ac.match(/\{textProtocolUnread && \(/g) ?? []).length, '文本协议那句挂在渲染条件里').toBe(1)
    expect((ac.match(/\{workspaceUnread && \(/g) ?? []).length, '工作目录那句挂在渲染条件里').toBe(1)
    expect(ac.split('data-testid="agent-composer-text-protocol-retry"').length - 1).toBe(1)
    expect(ac.split('data-testid="agent-composer-workspace-retry"').length - 1).toBe(1)
    // 原因挂在句子的悬停上（句子本体是既有的那张脸，四语都有）
    expect(ac).toContain('role="alert" className="text-xs text-[var(--color-danger)]" title={textProtocolUnread}')
    expect(ac).toContain('role="alert" className="text-xs text-[var(--color-danger)]" title={workspaceUnread}')
    // 出口按"有没有天然出口"配：这两发的读只在挂载跑一次，没有"再点那一格自己会重拉"那种顺路出口
    expect(ac.split('onRetryTextProtocol').length - 1, 'props 声明＋解构＋那颗键的 onClick').toBe(3)
    expect(ac.split('onRetryWorkspace').length - 1, '同上').toBe(3)
  })

  it('顶栏不再自己画这两颗（搬完就得是搬完，不许留一份第二张脸）', () => {
    const bar = read(BAR)
    for (const id of [
      'workspaceDir',
      'onPickWorkspace',
      'workspaceUnread',
      'textProtocolForced',
      'textProtocolUnread',
      'onToggleTextProtocol'
    ]) {
      expect(bar.split(id).length - 1, `顶栏里还留着 ${id}`).toBe(0)
    }
    // 反向对照：这两颗在输入区那侧确实在场（否则上面那条归零是空枪）
    const ac = read(AC)
    for (const id of ['workspaceUnread', 'textProtocolUnread', 'onPickWorkspace', 'onToggleTextProtocol']) {
      expect(ac.split(id).length - 1, `现数 ${id}`).toBeGreaterThan(0)
    }
  })

  it('四语都有这两句用的键（新句子不许只写了中文——一致性由 i18n-parity 守，这里钉"别漏语言"）', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const d = fs.readFileSync(path.join(ROOT, 'src/renderer/src/i18n', `${lang}.ts`), 'utf-8')
      for (const key of ['agent.textProtocolUnread', 'agent.workspaceUnread', 'agent.retryRead']) {
        expect(d.includes(`'${key}'`), `${lang} 缺 ${key}`).toBe(true)
      }
    }
  })
})
