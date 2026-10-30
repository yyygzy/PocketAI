// @vitest-environment jsdom
// V4-Iter-369：设置页「恢复密钥」那一格的第三句话——包是从坏文件里扫出来的，就必须说出来
//
// 挂载面：`RecoveryKeyCard` 自己拉一发 `hasRecoveryKey`（§345 那批就点过这块：桩不给就挂不起来）。
// 通道形状在 §369 从布尔改成两件事 `{ has, carriedFrom }`，本文件判的是这两件事在屏上各自画成什么：
//   ① has＋carriedFrom ⇒ 「已设置」那行照旧，另起一句点名那份文件（用户得知道这把是扫回来的）；
//   ② has＋carriedFrom=null ⇒ 那句一句都不许有（正常来源不该被说成救回来的）；
//   ③ 没有包 ⇒ 那句不许单独出现（「取回了一份」没有主语＝比 ② 更糟的谎）；
//   ④ 那一发失败 ⇒ 走 notice，不许把失败读成"扫回来了一份"。
// 每处都配一条正向对照（②③④），摘掉条件就会红。
// 屏上那句话的探针串**从字典里现取**，不手抄中文（§355 那一档"手抄中文"只有闸门看得见）。
import { describe, it, expect, beforeAll } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { RecoveryKeyCard } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

type Dict = Record<string, string>
const L = (key: string): string => (zh as unknown as Dict)[key]!
/** 那句里占位符**前面**的一截：从字典现取，用于"这句在不在屏上"的负向判据 */
const CARRY_PROBE = L('enc.recoveryCarried').split('{file}')[0]!.trim()
const CARRIED = (file: string): string => L('enc.recoveryCarried').replace('{file}', file)
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const hasCarrySentence = (): boolean =>
  screen.queryAllByText((text) => text.includes(CARRY_PROBE)).length > 0

// NoticeFn 的入参可以是 null（＝清空那条提示），桩要照抄这个真实形状
const notices: Array<{ ok: boolean; text: string }> = []
const setNotice = (n: { ok: boolean; text: string } | null): void => {
  if (n) notices.push(n)
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

function mountWith(impl: unknown): void {
  notices.length = 0
  stubPocketai({ hasRecoveryKey: () => impl as never })
  mountWithProviders(<RecoveryKeyCard setNotice={setNotice} />)
}

describe('① 那把包是扫回来的 ⇒ 屏上要点名那份文件', () => {
  it('has＋carriedFrom ⇒ 「已设置」那行照旧，另起一句带文件名的话，且整屏只出现一次', async () => {
    mountWith({ has: true, carriedFrom: 'config.json.corrupt-1700000000000' })

    await waitFor(() => expect(screen.getAllByText(L('enc.recoverySet')).length).toBe(1))
    expect(
      screen.getAllByText(CARRIED('config.json.corrupt-1700000000000')).length,
      '一句只能有一处（两处＝同一个标记挂在两个槽位）'
    ).toBe(1)
    expect(notices).toEqual([])
  })

  it('反向对照 ②：has 而没有 carriedFrom ⇒ 那句一句都不许有（正常来源不该被说成救回来的）', async () => {
    mountWith({ has: true, carriedFrom: null })

    await waitFor(() => expect(screen.getAllByText(L('enc.recoverySet')).length).toBe(1))
    expect(hasCarrySentence(), '没有取回这回事，就不该说').toBe(false)
    expect(screen.getAllByText(L('enc.recoveryRegen')).length, '已设置那一格的键名').toBe(1)
  })

  it('反向对照 ③：根本没有包 ⇒ 「未设置」那行在、那句"取回"不许单独出现', async () => {
    mountWith({ has: false, carriedFrom: null })

    await waitFor(() => expect(screen.getAllByText(L('enc.recoveryNotSet')).length).toBe(1))
    expect(hasCarrySentence(), '「取回了一份」没有主语＝比 ② 更糟的谎').toBe(false)
  })

  it('反向对照 ③′：没有包但带着来源标记 ⇒ 那句仍不许出现（只看标记＝画一句没有主语的话）', async () => {
    mountWith({ has: false, carriedFrom: 'config.json' })

    await waitFor(() => expect(screen.getAllByText(L('enc.recoveryNotSet')).length).toBe(1))
    expect(hasCarrySentence(), 'blob 不在，来源就不该被说出去').toBe(false)
  })

  it('反向对照 ④：那一发失败 ⇒ 走 notice，不许把失败读成"扫回来了一份"', async () => {
    mountWith({ ok: false, error: '配置目录读不出' })

    await waitFor(() => expect(notices.length, '失败必须进 notice（§222 那一族的静默形状）').toBe(1))
    expect(notices[0]?.ok).toBe(false)
    expect(notices[0]?.text).toContain('配置目录读不出')
    // 这颗门等的是 notices.length（非 DOM 信号）⇒ 按 §364／§365 的口径，紧随的读屏要先让那一发落定再读，
    // 否则这一句读的是"发出那一刻"的屏，负载窗里会假红（闸门 waitfor-gate-364 第一趟就把这里抓出来了）
    await settle()
    expect(hasCarrySentence()).toBe(false)
  })
})

describe('② 这句话的文案自己也有牙', () => {
  it('屏上没有裸的 {file}（§361 那一族的"占位符没填"）', async () => {
    mountWith({ has: true, carriedFrom: 'config.json' })

    await waitFor(() => expect(screen.getAllByText(CARRIED('config.json')).length).toBe(1))
    expect(
      screen.queryAllByText((text) => text.includes('{file}')).length,
      '插值没落地＝屏上留着一个裸占位符'
    ).toBe(0)
  })

  it('四语字典都有这一句、都带着同一个占位符，且四句互不相同', () => {
    const texts = [zh, en, ja, ko].map((d) => (d as unknown as Dict)['enc.recoveryCarried'])
    for (const t of texts) {
      expect(typeof t).toBe('string')
      expect(t, '每份字典都得留那个占位符').toContain('{file}')
    }
    expect(new Set(texts).size, '四语是四条不同文案（不是复制粘贴同一句）').toBe(4)
  })
})
