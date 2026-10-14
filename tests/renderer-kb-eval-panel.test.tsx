// 评测集面板的显示层与入参（V4-Iter-137）
// @vitest-environment jsdom
//
// 分数本身是运行器的事（真库用例已钉），这里钉两件界面上才会骗人的东西：
// ① k 输入框留空时**不许**替用户编一个数——要传 undefined，让主进程去用这个库自己的 topN；
// ② 指标/失效/停用/警告四组信息必须同时在场，只把 recall 摆出来就是在一个坏卷子上报喜。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { KbEvalPanel } from '../src/renderer/src/modules/knowledge/KbEvalPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KbEvalRunResult } from '../src/shared/kb-eval'

const result = (over: Partial<KbEvalRunResult> = {}): KbEvalRunResult => ({
  name: '退款政策评测',
  kbId: 'kbE',
  fileName: 'set.json',
  metrics: { k: 2, cases: 4, missedCases: 2, recallAtK: 0.5, mrr: 0.3333333, medianRank: 1.5 },
  rows: [
    {
      caseId: 'c1',
      query: '退款额',
      expected: 1,
      matched: 1,
      firstRank: 1,
      recallAtK: 1,
      missing: [],
      returned: [{ docId: 'dx', seq: 0, title: '退款主文' }]
    },
    {
      caseId: 'c3',
      query: '退款额',
      expected: 1,
      matched: 0,
      firstRank: null,
      recallAtK: 0,
      missing: [{ docId: 'dz' }],
      returned: [{ docId: 'dx', seq: 0, title: '退款主文' }]
    }
  ],
  stale: [{ caseId: 'c4', docId: 'ghost-doc' }],
  disabledTargets: [{ caseId: 'c3', docId: 'dz', title: '已停用文档' }],
  warnings: ['该库没有配置 Embedding 模型：向量路不参与，这份分数只反映全文检索与融合结果'],
  elapsedMs: 5,
  ...over
})

const runKbEval = vi.fn()
const pickKbEvalSet = vi.fn()

beforeEach(() => {
  runKbEval.mockReset()
  pickKbEvalSet.mockReset()
  stubPocketai({ runKbEval, pickKbEvalSet })
})

const mount = (): void => {
  mountWithProviders(<KbEvalPanel kbId="kbE" />)
}

describe('评测集面板', () => {
  it('没选卷子时运行是禁用点，文件名那一行也不存在', () => {
    mount()
    expect((screen.getByText(zh['kb.evalRun']) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('set.json')).toBeNull()
  })

  it('选完卷子：文件名显示出来，运行才可点；令牌传给主进程', async () => {
    pickKbEvalSet.mockResolvedValue({ token: 'tk-1', fileName: 'set.json' })
    runKbEval.mockResolvedValue(result())
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(screen.getByText('set.json')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(runKbEval).toHaveBeenCalled())
    expect(runKbEval.mock.calls[0]![0]).toBe('kbE')
    expect(runKbEval.mock.calls[0]![1]).toBe('tk-1')
  })

  it('k 输入框留空 ⇒ 第三个参数是 undefined（缺省必须交给主进程用该库的 topN）', async () => {
    pickKbEvalSet.mockResolvedValue({ token: 'tk', fileName: 'set.json' })
    runKbEval.mockResolvedValue(result())
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(screen.getByText('set.json')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(runKbEval).toHaveBeenCalled())
    expect(runKbEval.mock.calls[0]!.length).toBe(3)
    expect(runKbEval.mock.calls[0]![2]).toBeUndefined()
  })

  it('填了 k ⇒ 按填的值传，并被钳进 1..50', async () => {
    pickKbEvalSet.mockResolvedValue({ token: 'tk', fileName: 'set.json' })
    runKbEval.mockResolvedValue(result({ metrics: { ...result().metrics, k: 7 } }))
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(screen.getByText('set.json')).toBeTruthy())
    fireEvent.change(screen.getByLabelText(zh['kb.evalK']), { target: { value: '999' } })
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(runKbEval.mock.calls[0]![2]).toBe(50))
  })

  it('指标四格逐字渲染：recall@k 用运行器给的 k，百分数与三位小数都在场', async () => {
    runKbEval.mockResolvedValue(result())
    pickKbEvalSet.mockResolvedValue({ token: 'tk', fileName: 'set.json' })
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(screen.getByText('set.json')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(screen.getByText('50.0%')).toBeTruthy())
    expect(screen.getByText(zh['kb.evalRecall'].replace('{k}', '2'))).toBeTruthy()
    expect(screen.getByText('0.333')).toBeTruthy()
    expect(screen.getByText('1.5')).toBeTruthy()
    expect(screen.getByText(zh['kb.evalMissed'].replace('{n}', '2'))).toBeTruthy()
    expect(screen.getByText(zh['kb.evalCases'].replace('{n}', '4').replace('{ms}', '5'))).toBeTruthy()
  })

  it('失效目标、停用目标、警告三组信息要和分数同屏（只报 recall 就是在坏卷子上报喜）', async () => {
    runKbEval.mockResolvedValue(result())
    pickKbEvalSet.mockResolvedValue({ token: 'tk', fileName: 'set.json' })
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(screen.getByText('set.json')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(screen.getByText('50.0%')).toBeTruthy())
    expect(screen.getByText(zh['kb.evalStale'].replace('{n}', '1') + ' c4→ghost-doc')).toBeTruthy()
    expect(screen.getByText(zh['kb.evalDisabled'].replace('{n}', '1'))).toBeTruthy()
    expect(screen.getByText('该库没有配置 Embedding 模型：向量路不参与，这份分数只反映全文检索与融合结果')).toBeTruthy()
  })

  it('逐条明细给出未召回的期望与实际返回；firstRank 为 null 时显示破折号而不是 0', async () => {
    runKbEval.mockResolvedValue(result())
    pickKbEvalSet.mockResolvedValue({ token: 'tk', fileName: 'set.json' })
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(screen.getByText('set.json')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(screen.getByText('50.0%')).toBeTruthy())
    // c1 命中在第 1 名，c3 整条没回来
    expect(screen.getByText('#1')).toBeTruthy()
    expect(screen.getByText(zh['kb.evalMissing'] + '：dz')).toBeTruthy()
    // 两题的查询相同 ⇒ 实际返回列表一样，两处都在（不是只渲染第一条）
    expect(screen.getAllByText(zh['kb.evalReturned'] + '：退款主文(0)')).toHaveLength(2)
    // c3 整条没回来 ⇒ 名次是破折号；中位名次这里有值（1.5），所以全场只有一处破折号
    expect(screen.getAllByText('—')).toHaveLength(1)
  })

  it('运行失败 ⇒ 面板内出现中文错误并清掉上一份结果（不留一份过期的分数在屏上）', async () => {
    pickKbEvalSet.mockResolvedValue({ token: 'tk', fileName: 'set.json' })
    runKbEval.mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('评测集格式不符：cases.0.expected — 至少一条'))
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(screen.getByText('set.json')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(screen.getByText('50.0%')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(screen.getByText(/评测集格式不符/)).toBeTruthy())
    expect(screen.queryByText('50.0%')).toBeNull()
  })

  it('真合同：safeHandle 把异常转成**返回值** {ok:false,error}（不 reject）⇒ 界面必须说出原因', async () => {
    pickKbEvalSet.mockResolvedValue({ token: 'tk', fileName: 'set.json' })
    runKbEval.mockResolvedValue({ ok: false, error: '评测集格式不符：cases.0.expected — 至少一条' })
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(screen.getByText('set.json')).toBeTruthy())
    fireEvent.click(screen.getByText(zh['kb.evalRun']))
    await waitFor(() => expect(screen.getByText(/评测集格式不符/)).toBeTruthy())
  })

  it('反向对照：对话框被取消（返回 null）时不报错、也不显示文件名', async () => {
    pickKbEvalSet.mockResolvedValue(null)
    mount()
    fireEvent.click(screen.getByText(zh['kb.evalPick']))
    await waitFor(() => expect(pickKbEvalSet).toHaveBeenCalled())
    expect(screen.queryByText('set.json')).toBeNull()
    expect(screen.queryByText(/读不到评测集/)).toBeNull()
  })
})
