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

/** 取**外层**那整个浮层（`<FloatingPanel …>` 到它自己的收尾，§399②b 之后里面还嵌了一层） */
function panelRange(src: string): string {
  const start = src.indexOf('<FloatingPanel')
  expect(start, 'AgentComposer 里没有 <FloatingPanel').toBeGreaterThan(-1)
  // 取最后一个收尾＝外层自己的收尾；§399②b 之前只有单层，`indexOf` 够用，现在会截在嵌套层那儿
  const end = src.lastIndexOf('</FloatingPanel>')
  expect(end, '<FloatingPanel> 没有配平的收尾').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('A 入口唯一', () => {
  it('七颗 testid 各一处；旧的平铺附件写法与第二份片段键都不许回来', () => {
    const ac = read(AC)
    // §399②a 收进文本协议／工作目录两行（五颗）；②b 再收工具策略那一行＋它的嵌套第二层（七颗）
    for (const id of [
      'agent-composer-plus',
      'agent-composer-plus-menu',
      'agent-composer-plus-file',
      'agent-composer-plus-text-protocol',
      'agent-composer-plus-workspace',
      'agent-composer-plus-tools',
      'agent-composer-tools-menu'
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
    // §399②b 把这条判据从"落在带标记的子树里就不管"改成"落在**比我更内**的那一层才不管"⇒ 这颗标记现在有两处：
    // Props 里那一行声明 ＋ `closest('[data-esc-nested]')` 那一处选择器。少一处＝要么没声明（TS 挡住），要么选择器被摘（Esc 越级）
    expect(count(fp, 'data-esc-nested'), '现数 data-esc-nested（声明＋选择器）').toBe(2)
    expect(count(fp, "closest?.('[data-esc-nested]')"), '嵌套层先收那道判据写在 Esc 分支里').toBe(1)
    expect(count(fp, 'nested && nested !== panelRef.current'), '只让位给比自己更内的那一层（本层自己带标记也要收）').toBe(1)
    expect(count(fp, 'anchorRef.current?.contains(tgt)'), '锚点自身不算外部').toBe(1)
    // §399②b 之后多一颗 `align`：默认那一形会把父菜单上面几行整片盖住（真机量到），第二层要往右侧摆。
    //   夹视口那道算术只许有一份（两支各写一遍＝窄窗口下两支会算出不同的位置）
    expect(count(fp, "align = 'start'"), '默认值＝改前那一形，别把既有两处弹层的观感一起改了').toBe(1)
    expect(count(fp, "align === 'right'"), '右侧那一支只有一处').toBe(1)
    expect(count(fp, 'Math.max(EDGE'), '夹视口只有一份（翻左侧那一支走同一颗 clampLeft）').toBe(1)
    expect(count(fp, 'clampLeft('), '现数 clampLeft 调用点（默认支＋右侧支＋翻侧）').toBe(3)
    expect(count(fp, 'sideLeft'), '翻侧：定义一处＋调用一处').toBe(2)
    expect(count(fp, 'right + width + EDGE <= window.innerWidth'), '右侧放得下才并排（放不下翻左侧，别被 clamp 拉回父菜单上面）').toBe(1)
    expect(count(fp, '[anchorRef, width, align]'), 'align 要进 effect 依赖（不进＝换了值不重算位置）').toBe(1)
    // 片段那侧要真的带上这颗标记，否则上面那条判据是空的
    expect(read(SB)).toContain('data-esc-nested')
  })
})

describe('C 「读不到」那张脸不搬进浮层', () => {
  it('七句都在 `<FloatingPanel` 之前＝菜单关着也看得见（四处 alert ＋ ②b 那三句 ShowingDefaultsNotice）', () => {
    const ac = read(AC)
    const panel = ac.indexOf('<FloatingPanel')
    const alerts = [...ac.matchAll(/role="alert"/g)].map((m) => m.index)
    expect(alerts.length, '现数 alert 落点（§399②a 把这两项搬进来时，各配了自己那一句）').toBe(4)
    for (const at of alerts) expect(at < panel, '有一句跑到浮层里面去了').toBe(true)
    // §399②b：工具那三发搬进「+」时**只有控件进去**，那三句「读不到，这里显示的是默认值」留在浮层外面
    const notices = [...ac.matchAll(/\{tools\.toolUnread\.\w+ && <ShowingDefaultsNotice/g)].map((m) => m.index)
    expect(notices.length, '现数工具那三句（少一句＝那一发读失败时没人说话）').toBe(3)
    for (const at of notices) expect(at < panel, '工具那句被关进菜单＝一关就没话说').toBe(true)
    // 出口按有没有天然出口配：这三发的出口是"当场改一次配置"（写成功即清位），所以这里只有句子、不造键
    // 三颗文本协议／工作目录／知识库的出口键同理：它们都在浮层外面，且在浮层之前
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
      // §399②a 收进来的两行用的全是顶栏那两颗徽标的既有键（零新文案）：名单从 5 颗长到 15 颗；
      // §399②b 那一行同样零新文案——`agent.toolConfig`／`agent.expand`／`agent.collapse` 三颗是从那行条搬过来的既有键
      'agent.collapse agent.expand agent.queue.textOnly agent.textProtocol agent.textProtocolHint agent.textProtocolOn ' +
        'agent.textProtocolOnHint agent.textProtocolReadFail agent.textProtocolUnread agent.toolConfig ' +
        'agent.workspaceNone agent.workspacePickTip agent.workspaceReadFail agent.workspaceUnread ' +
        'ccb.none common.attachFile common.docs mention.knowledge'
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

describe('F 升级回显（§399②a 定机关，②b 把工具那三项也接进同一颗判据）', () => {
  it('那颗「+」的颜色由五项一起点名，且危险色只挂在 plusDanger 那一支上', () => {
    const ac = read(AC)
    // 判据盯**渲染条件本身**（第 14 条）：这五项少一项，那一档坏消息就没人说
    expect(
      ac.includes(
        'const plusDanger = !!(kbsFail || snippetsFail || textProtocolUnread || workspaceUnread || anyToolUnread)'
      ),
      '「+」的危险色不再是五项里某几项的函数'
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

describe('G 工具策略那一行与它的嵌套第二层（§399②b）', () => {
  const TB = 'src/renderer/src/modules/agent/components/AgentToolBars.tsx'
  const PANEL = 'src/renderer/src/modules/agent/chat/AgentPanel.tsx'

  it('那一行不再自己管展开：`useState`／展开键／三句「读不到」在 AgentToolBars 里全部归零', () => {
    const tb = read(TB)
    // 收起态那张贴在消息流之上的谎脸（三个开关都关着＝§257 记的那一形）必须由**外层菜单那一行**来画，
    // 所以这份组件里不该再留任何"展开与否"的机关
    expect(tb.split('useState').length - 1, '展开状态归外层菜单管').toBe(0)
    for (const id of ['agent.expand', 'agent.collapse', 'ShowingDefaultsNotice', 'toolUnread.shell', 'toolUnread.webSearch', 'toolUnread.calendar']) {
      expect(tb.split(id).length - 1, `AgentToolBars 里还留着 ${id}`).toBe(0)
    }
    // 那三发**只有 workspace 那一发**在这一块里还有读者：置灰那行的悬停要分「读不到」与「真没设」两张脸（§257）
    expect(tb.split('toolUnread.workspace').length - 1, '现数 toolUnread.workspace 读者').toBe(1)
    // 反向对照：那三句在输入区那侧确实在场（否则上面那条归零是空枪）—— C 段已钉，这里只补一句"没丢"
    expect((read(AC).match(/\{tools\.toolUnread\.\w+ && <ShowingDefaultsNotice/g) ?? []).length).toBe(3)
    // B3 那颗弹窗仍由这份组件渲染（挂在里面＝点「确认」不算点浮层外部；少渲染一个就变成点了没反应的死锁）
    expect(tb.split('{secretDialog}').length - 1, '现数 secretDialog 渲染点').toBe(1)
  })

  it('第二层的形状：嵌在外层里、带 `data-esc-nested`、关闭只收那一层；外层菜单自己的收尾在它之后', () => {
    const ac = read(AC)
    const outer = ac.indexOf('<FloatingPanel')
    const nested = ac.lastIndexOf('<FloatingPanel')
    expect(nested > outer, '嵌套第二层没在 AC 里（<AgentToolBars/> 又被搬回消息流之上了？）').toBe(true)
    expect(ac.indexOf('</FloatingPanel>') > nested, '嵌套层先收、外层后收＝它是嵌进去的，不是并列的').toBe(true)
    expect(ac.indexOf('<AgentToolBars tools={tools} />') > nested, '控件本体只在那一层里面').toBe(true)
    // Esc 不越级：那一层带标记，且它的 onClose 只关自己（写成 setPlusOpen(false)＝Esc 一下把两层都收了）
    const seg = ac.slice(nested, ac.indexOf('</FloatingPanel>', nested))
    expect(seg).toContain('data-esc-nested="1"')
    expect(seg).toContain('onClose={() => setToolsOpen(false)}')
    expect(seg.includes('setPlusOpen'), '那一层的关闭不该去动外层菜单').toBe(false)
    // 位置：第二层往**右侧**摆（默认那一形同样向上长＝真机量到它会盖住父菜单上面那几行）
    expect(seg).toContain('align="right"')
    expect(seg, '宽度要窄到放得下两栏（252＋间距＋这一颗）').toContain('width={300}')
    // 反向钉：外层那颗菜单不许也带上 align（它没有父菜单可让，改了就是动既有观感）
    expect(ac.slice(outer, nested), '外层菜单该走默认那一形').not.toContain('align')
    // 三发读共用一份判据：徽标与那一行读同一个 `anyToolUnread`（按身份钉，不是各算一遍）
    expect(ac.split('anyToolUnread').length - 1, '定义一处＋徽标一处＋那一行一处').toBe(3)
  })

  it('AgentPanel 不再自己挂 `<AgentToolBars/>`（搬完就得是搬完，不许留第二份控件）', () => {
    expect(read(PANEL).split('<AgentToolBars').length - 1).toBe(0)
  })

  it('摘要行与开关同源：`agentToolSummary` 一处定义、一处调用，且不拿名词当兜底', () => {
    const tb = read(TB)
    const ac = read(AC)
    expect(tb.split('export const agentToolSummary').length - 1, '定义一处').toBe(1)
    expect(ac.split('agentToolSummary(tools)').length - 1, '只在摘要那一格调用').toBe(1)
    // §257 那一形：全关着时不许把名词再念一遍冒充读数（`summary || t('agent.toolConfig')`）
    expect(tb.includes("|| t('agent.toolConfig')"), '兜底字面量回来了＝空摘要被画成"工具配置"').toBe(false)
  })
})
