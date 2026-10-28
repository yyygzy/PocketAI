// @vitest-environment jsdom
// V4-Iter-339 渲染层：被安全策略硬拒的那句 shell 结果，屏上要跟着界面语言走
//
// 缺陷形状＝回码写了、四语也写了，缺的是消费点：主进程把「中文句子＋码」写进 tool 结果 content
// （那份原文同时要喂给模型，不能改），而四语字典 `agent.approval.reason.*` 只有审批对话框在读
// ⇒ 非中文界面的用户在红字卡上看到的是 `命令被安全策略拒绝：BLOCKED_ROOT_DELETE`。
// 判据三面：① 纯函数认两种字面（主进程那两条各一种标点）；② 真挂一张卡证明上屏的确实是译文、
// 且裸码不再出现（反向对照：普通结果原样，别把整类 tool 结果都改了）；
// ③ 主进程那两句的字面由源码钉子守着——**改味不会报错，只会悄悄不翻译**，所以必须现数命中次数。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentMessageCard } from '../src/renderer/src/modules/agent/components/AgentMessageCard'
import { localizeShellDenial } from '../src/renderer/src/utils/shell-denial'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import type { AgentMessage } from '../src/renderer/src/modules/agent/agent-shared'

const DICTS: Record<string, Record<string, string>> = {
  zh: zh as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
  ja: ja as unknown as Record<string, string>,
  ko: ko as unknown as Record<string, string>
}
const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const KEY = (code: string): string => `agent.approval.reason.${code}`

/** 只认这个码、别的键一律回「键本身」——这就是运行期 i18n 未命中的形状 */
const tFor = (hit: string): ((k: string) => string) => (k: string) => (k === KEY(hit) ? `译文·${hit}` : k)

describe('① 纯函数：认出那两种字面，认不出就原样', () => {
  it('engine.ts 那条「：CODE」被换成字典那句', () => {
    expect(localizeShellDenial('命令被安全策略拒绝：BLOCKED_ROOT_DELETE', tFor('BLOCKED_ROOT_DELETE')))
      .toBe('译文·BLOCKED_ROOT_DELETE')
  })

  it('shell-tools.ts 那条「（CODE）」同样被换（执行闸门那发用的是全角括号）', () => {
    expect(localizeShellDenial('命令被安全策略拒绝（BLOCKED_FORMAT）', tFor('BLOCKED_FORMAT')))
      .toBe('译文·BLOCKED_FORMAT')
  })

  it('字典里没这个码 ⇒ 原样给回，不许把句子换成空串或裸键（宁可留裸码不丢信息）', () => {
    // 未命中时 i18n 的 `t` 回的是键本身（index.tsx 最后那层兜底），夹具照这个形状写
    const raw = '命令被安全策略拒绝：SOMETHING_NEW'
    expect(localizeShellDenial(raw, (k) => k)).toBe(raw)
  })

  it('分类器没给出码时那句兜底是「：BLOCKED」，字典里也没有 ⇒ 原样', () => {
    const raw = '命令被安全策略拒绝：BLOCKED'
    expect(localizeShellDenial(raw, tFor('BLOCKED_ROOT_DELETE'))).toBe(raw)
  })

  it('普通工具输出与"像但不是"的句子都不许动（多行／带前后缀／码里混小写）', () => {
    const passthrough = [
      '{ "path": "a.md", "bytes": 6 }',
      '命令被安全策略拒绝：BLOCKED_ROOT_DELETE（另有说明）',
      '注意：命令被安全策略拒绝：BLOCKED_FORMAT',
      '命令被安全策略拒绝：blocked_lower'
    ]
    for (const s of passthrough) expect(localizeShellDenial(s, tFor('BLOCKED_ROOT_DELETE'))).toBe(s)
  })
})

describe('② 真挂一张结果卡：上屏的是译文，裸码不再出现', () => {
  const DENIED = '命令被安全策略拒绝：BLOCKED_ROOT_DELETE'
  const deniedMsg = () =>
    ({ id: 't1', role: 'tool', text: '', isError: true, toolResult: { name: 'shell_exec', content: DENIED } }) as unknown as AgentMessage

  beforeEach(() => {
    stubPocketai({
      deleteMessage: () => ({ ok: true }),
      createReminder: () => ({ ok: true }),
      reportPerf: () => undefined
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('硬拒那张红字卡显示当前语言的整句，屏上找不到裸码', () => {
    mountWithProviders(<AgentMessageCard m={deniedMsg()} />)
    expect(screen.getByText(L(KEY('BLOCKED_ROOT_DELETE')))).toBeTruthy()
    expect(screen.queryByText(/BLOCKED_ROOT_DELETE/)).toBeNull()
  })

  it('反向对照：普通结果卡内容一字不改（新判据不许顺手把整类 tool 结果改掉）', () => {
    const plain = JSON.stringify({ ok: true, stdout: 'hello' })
    mountWithProviders(
      <AgentMessageCard m={{ id: 't2', role: 'tool', text: '', toolResult: { name: 'time_now', content: plain } } as unknown as AgentMessage} />
    )
    expect(screen.getByText(plain)).toBeTruthy()
  })

  // 这一张卡上有两颗「复制」（卡角那颗按钮＋右键菜单那颗），两处必须给同一份屏上文本。
  // 判据按槽位各取一次再比，不写「屏上出现过这句译文」（那种写法少一路也照样绿）
  it('卡角「复制」与右键「复制」写进剪贴板的是同一份译文，都不是裸码那句', async () => {
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (s: string) => { writes.push(s) } }
    })
    mountWithProviders(<AgentMessageCard m={deniedMsg()} onDelete={() => {}} />)
    const COPY = L('common.copy')

    // 右键菜单没打开时屏上只有一颗「复制」＝卡角那颗；打开后是两颗＝菜单那颗也出现了
    const cardBtn = screen.getAllByRole('button', { name: COPY })
    expect(cardBtn, '未开菜单时只该有卡角那颗复制').toHaveLength(1)
    fireEvent.click(cardBtn[0]!)

    const denied = '命令被安全策略拒绝：BLOCKED_ROOT_DELETE'
    fireEvent.contextMenu(screen.getByText(L(KEY('BLOCKED_ROOT_DELETE'))).closest('div')!)
    const withMenu = await screen.findAllByRole('button', { name: COPY })
    expect(withMenu, '右键菜单里那颗「复制」').toHaveLength(2)
    fireEvent.click(withMenu[1]!)

    expect(writes).toEqual([L(KEY('BLOCKED_ROOT_DELETE')), L(KEY('BLOCKED_ROOT_DELETE'))])
    expect(writes.includes(denied), '两条复制都不许给那句中文＋裸码').toBe(false)
  })
})

describe('③ 主进程那两句字面与四语覆盖（改味只会悄悄失效 ⇒ 必须钉字面）', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, rel), 'utf-8').replace(/\r\n/g, '\n')
  const engine = read('../src/main/agent/engine.ts')
  const shell = read('../src/main/tools/shell-tools.ts')
  const hits = (hay: string, needle: string): number => hay.split(needle).length - 1

  const ENGINE_LINE = 'content: `命令被安全策略拒绝：${classification.reason ?? \'BLOCKED\'}`'
  const SHELL_LINE = 'throw new Error(`命令被安全策略拒绝（${classification.reason ?? \'BLOCKED\'}）`)'

  it('两条渲染侧字面各自恰好一次（多了＝冒出第三种形状，少了＝那句被改味）', () => {
    expect(hits(engine, ENGINE_LINE), 'engine.ts 里那条 tool 结果字面').toBe(1)
    expect(hits(shell, SHELL_LINE), 'shell-tools.ts 里那条抛错字面').toBe(1)
  })

  it('判据对字面敏感：主进程那句改成同义说法后不再被翻译（所以那颗字面钉子红才是真信号）', () => {
    const reworded = '命令被安全策略拒绝，原因：BLOCKED_ROOT_DELETE'
    expect(localizeShellDenial(reworded, tFor('BLOCKED_ROOT_DELETE'))).toBe(reworded)
  })

  it('分类器会产出的每一档 deny 码，四语字典都有句子（回码写了、句子没写就是裸码）', () => {
    const codes = [...new Set([...shell.matchAll(/'(BLOCKED_[A-Z0-9_]+|SHELL_DISABLED)'/g)].map((m) => m[1]!))].sort()
    expect(codes).toEqual([
      'BLOCKED_BOOTCFG',
      'BLOCKED_CIPHER_WIPE',
      'BLOCKED_DISKPART',
      'BLOCKED_FORKBOMB',
      'BLOCKED_FORMAT',
      'BLOCKED_MKFS',
      'BLOCKED_REG_HIVE',
      'BLOCKED_ROOT_DELETE',
      'BLOCKED_SHUTDOWN',
      'BLOCKED_SYSTEM_DELETE',
      'SHELL_DISABLED'
    ])
    for (const code of codes) {
      for (const [lang, dict] of Object.entries(DICTS)) {
        expect(dict[KEY(code)], `${lang} 缺 reason ${code}`).toBeTruthy()
      }
    }
  })
})
