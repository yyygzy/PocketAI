// V4-Iter-254：知识库那一簇的三处收口（列表／KbForm 的服务商清单／ChunkPreview 的分块清单）。
//
// 证据分两层：**列表那处真挂载**（`KnowledgeModule` 是导出的，挂载它只会发一发 `listKnowledgeBases`，成本压得住）；
// 另两处（`KbForm`、`ChunkPreview` 都不是导出组件，挂载要先把整条详情链路桩起来——§214 当时就是为此写下
// "几十个 IPC 桩，成本高到不值"）用**接线计数**：新落点逐条数得出、旧写法必须归零。
// 三条用例摆在一起是为了**三种状态互相分辨**：读到 N 条 / 读到 0 条 / 读不到——只断"读不到那句在"会放过
// "永远转加载中"与"把没有演成确实没有"两种写法（§222 那条纪律）。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { KnowledgeModule } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())

describe('① 知识库列表：读不到不许长成「还没有知识库」', () => {
  it('resolve 的 {ok:false} ⇒ 那句「读不到：…」常驻，空态那句不在场', async () => {
    stubPocketai({ listKnowledgeBases: () => ({ ok: false, error: '索引正在重建' }) })
    mountWithProviders(<KnowledgeModule />)
    await waitFor(() => expect(alerts()).toEqual([FAILED('索引正在重建')]))
    expect(screen.queryByText(L('kb.empty'))).toBeNull()
  })

  it('反向对照：读到 0 条 ⇒ 空态那句回来，一个 alert 都不许有（两句分得开才有意义）', async () => {
    stubPocketai({ listKnowledgeBases: () => [] })
    mountWithProviders(<KnowledgeModule />)
    await waitFor(() => expect(screen.queryByText(L('kb.empty'))).not.toBeNull())
    expect(alerts()).toEqual([])
  })

  it('反向对照二：读到一条 ⇒ 既没有 alert 也没有空态', async () => {
    stubPocketai({
      listKnowledgeBases: () => [{ id: 'kb1', name: '测试库', embeddingDim: 1024, docCount: 0, status: 'ready' }]
    })
    mountWithProviders(<KnowledgeModule />)
    await waitFor(() => expect(screen.queryByText('测试库')).not.toBeNull())
    expect(alerts()).toEqual([])
    expect(screen.queryByText(L('kb.empty'))).toBeNull()
  })
})

describe('② 另两处（未导出组件）：接线计数', () => {
  // 这个文件是 w/lf；仍先归一，判"写法落点"才与行尾无关
  const SRC = fs
    .readFileSync(path.resolve(__dirname, '../src/renderer/src/modules/knowledge/KnowledgeModule.tsx'), 'utf-8')
    .replace(/\r\n/g, '\n')
  const count = (re: RegExp): number => (SRC.match(re) ?? []).length

  it('服务商清单与分块清单：两条失败面都落到各自的可见通道', () => {
    const cases: Array<[string, RegExp, number]> = [
      ['KbForm 的服务商读：resolve 面写进 error', /setError\(t\('common\.loadFailed', \{ msg: ipcFailText\(ps/g, 1],
      ['KbForm 的服务商读：reject 面同样写进 error', /setError\(t\('common\.loadFailed', \{ msg: errText\(e\) \}\)\)/g, 1],
      ['ChunkPreview 的分块读：resolve 面写 chunkErr', /setChunkErr\(ipcFailText\(v, t\('common\.unknownError'\)\)\)/g, 1],
      ['ChunkPreview 的分块读：reject 面写 chunkErr', /setChunkErr\(errText\(e, t\('common\.unknownError'\)\)\)/g, 1],
      ['分块读不到时那句原因上屏', /chunkErr && <LoadFailNotice msg=\{chunkErr\} \/>/g, 1],
      ['有原因时空态那句「没有分块」让位', /chunks\.length === 0 && !chunkErr/g, 1],
      ['知识库列表：两条失败面都写 kbsErr', /setKbsErr\((ipcFailText|errText)\(/g, 2]
    ]
    for (const [what, re, want] of cases) expect(count(re), what).toBe(want)
  })

  it('旧写法必须归零（这条是上面那条的反向对照，也挡住"只改 reject 面"）', () => {
    const leftovers: Array<[string, RegExp]> = [
      ['知识库列表', /if \(!hasIpcFailed\(v\)\) setKbs\(v\)/g],
      ['服务商清单', /if \(!hasIpcFailed\(ps\)\) setProviders\(/g],
      ['分块清单', /if \(!hasIpcFailed\(v\)\) setChunks\(v\)/g]
    ]
    for (const [what, re] of leftovers) expect(count(re), `这一处还留着"判了不接管"的老写法：${what}`).toBe(0)
  })

  it('成功分支一条都没被顺手删', () => {
    expect(count(/setKbs\(v\)/g), 'setKbs(v)').toBe(1)
    expect(count(/setProviders\(ps\.filter/g), 'setProviders(...)').toBe(1)
    expect(count(/setChunks\(v\)/g), 'setChunks(v)').toBe(1)
  })
})
