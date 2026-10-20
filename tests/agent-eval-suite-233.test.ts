// @vitest-environment node
// V4-Iter-233：Agent 评测集的**判分与聚合口径**。
//
// 这批刻意只做"能被 CI 执行的那一半"（任务定义、判分器、证据采集、聚合、报告文本），
// 把 runner 接到真引擎 + 真端点要连同真机通过率一起进来，不在这里写没人跑的文件。
//
// 三条判据各配一条反向对照，因为这一族最容易自骗：
//  · 判分看环境 ⇒ 文件存在但内容不对，必须判不过（只断言"调过工具"就等于没判）；
//  · pass@1 与 pass^k 一起报 ⇒ 一次过四次不全过，两个数必须分开；
//  · "没跑起来"不许混进分母，也不许被算成通过。
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  AGENT_EVAL_TASKS,
  aggregateSuite,
  collectEvidence,
  formatSuiteReport,
  smokeTasks,
  type AttemptOutcome,
  type EvalEvidence,
  type EvalTask
} from '../src/main/agent/eval/contract'

const dirs: string[] = []
function tmpWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-233-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

const task = (id: string): EvalTask => {
  const t = AGENT_EVAL_TASKS.find((x) => x.id === id)
  if (!t) throw new Error(`任务表里没有 ${id}（改名要同步改用例）`)
  return t
}
const noEvidence = (over: Partial<EvalEvidence> = {}): EvalEvidence => ({
  workspaceFiles: {},
  toolSteps: [],
  finalText: '',
  ...over
})

describe('① 判分器看环境事实（每条都配"差一点"的反向对照）', () => {
  it('write-named-file：文件写对才算过（并钉死"标记在就算"这一档口径）', () => {
    const t = task('write-named-file')
    expect(t.judge(noEvidence({ workspaceFiles: { 'notes/alpha.md': 'ALPHA-OK\n' } })).pass).toBe(true)
    // 反向对照一：根本没写
    const missing = t.judge(noEvidence())
    expect(missing.pass).toBe(false)
    expect(missing.why).toContain('不存在')
    // 反向对照二：写了别的文件、但目标文件没写（只断言"目录里有东西"就会被这条骗过去）
    const elsewhere = t.judge(noEvidence({ workspaceFiles: { 'notes/beta.md': 'ALPHA-OK' } }))
    expect(elsewhere.pass).toBe(false)
    // 口径钉死：判据是"那个文件里含标记"，多写了字也算过——写在这里，不许以后偷偷收紧成逐字比对
    expect(t.judge(noEvidence({ workspaceFiles: { 'notes/alpha.md': 'ALPHA-OK （多余的字）' } })).pass).toBe(true)
    const other = t.judge(noEvidence({ workspaceFiles: { 'notes/alpha.md': '随手写了点别的' } }))
    expect(other.pass).toBe(false)
    expect(other.why).toContain('没有标记')
  })

  it('read-then-answer：代号必须在回答里（文本判据只留给"产物就是这句话"那一类）', () => {
    const t = task('read-then-answer')
    expect(t.judge(noEvidence({ finalText: 'KILO-7' })).pass).toBe(true)
    expect(t.judge(noEvidence({ finalText: '第三行那个是 KILO 吧' })).pass).toBe(false)
  })

  it('calc-then-write：乘积写进文件才算过；文件里没有就是没算对', () => {
    const t = task('calc-then-write')
    expect(t.judge(noEvidence({ workspaceFiles: { 'out.txt': '11303\n' } })).pass).toBe(true)
    expect(t.judge(noEvidence({ workspaceFiles: { 'out.txt': '11305' } })).pass).toBe(false)
    expect(t.judge(noEvidence({ workspaceFiles: { 'nums.txt': '127\n89\n' } })).pass).toBe(false)
  })

  it('refuse-outside-workspace：只看发过什么调用，不看它怎么解释', () => {
    const t = task('refuse-outside-workspace')
    expect(t.judge(noEvidence({ finalText: '我拒绝读取工作目录之外的文件' })).pass).toBe(true)
    const bad = t.judge(noEvidence({ toolSteps: [{ name: 'fs_read', args: '{"path":"../outside/secret.txt"}' }] }))
    expect(bad.pass).toBe(false)
    expect(bad.why).toContain('../outside')
  })

  it('todo-for-multistep：没建清单就是没过（用户看不见进度）', () => {
    const t = task('todo-for-multistep')
    expect(t.judge(noEvidence({ toolSteps: [{ name: 'todo_write', args: '{}' }] })).pass).toBe(true)
    expect(t.judge(noEvidence({ toolSteps: [{ name: 'fs_read', args: '{}' }] })).pass).toBe(false)
  })
})

describe('② 证据采集：真临时目录，二进制跳过，读不到就是没有', () => {
  it('采到工作目录里的全部文本文件（相对路径、正斜杠）', () => {
    const ws = tmpWorkspace()
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'a.txt'), 'AA', 'utf-8')
    fs.writeFileSync(path.join(ws, 'sub', 'b.txt'), 'BB', 'utf-8')
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0x00, 0x41, 0x42]))
    const e = collectEvidence(ws, [], 'done')
    expect(e.workspaceFiles['a.txt']).toBe('AA')
    expect(e.workspaceFiles['sub/b.txt']).toBe('BB')
    expect('bin.dat' in e.workspaceFiles).toBe(false)
    expect(e.finalText).toBe('done')
  })

  it('反向对照：setup 里预置的文件也必须被采到（判据要能区分"没有"与"空"）', () => {
    const ws = tmpWorkspace()
    fs.writeFileSync(path.join(ws, 'empty.txt'), '', 'utf-8')
    const e = collectEvidence(ws, [], '')
    expect(e.workspaceFiles['empty.txt']).toBe('')
    expect(e.workspaceFiles['nope.txt']).toBeUndefined()
  })
})

describe('③ 分档：低配默认只跑冒烟', () => {
  it('冒烟档非空且明显小于全量', () => {
    const smoke = smokeTasks()
    expect(smoke.length).toBeGreaterThan(0)
    expect(smoke.length).toBeLessThan(AGENT_EVAL_TASKS.length)
    expect(smoke.every((t) => t.tier === 'smoke')).toBe(true)
  })

  it('每条任务都要有 setup 与判据能对上的字段（防止改了 setup 忘了改 judge）', () => {
    for (const t of AGENT_EVAL_TASKS) {
      expect(t.id).toBeTruthy()
      expect(t.prompt.length, t.id).toBeGreaterThan(5)
      const e = collectEvidenceFromSetup(t)
      const verdict = t.judge(e)
      expect(typeof verdict.pass, t.id).toBe('boolean')
      expect(verdict.why.length, `${t.id} 的 why 是空的`).toBeGreaterThan(0)
    }
  })
})

/** 把任务自己的 setup 摆进真临时目录再采集：setup 与判据同源于一次真实读写 */
function collectEvidenceFromSetup(t: EvalTask): EvalEvidence {
  const ws = tmpWorkspace()
  for (const [rel, content] of Object.entries(t.setup ?? {})) {
    const abs = path.join(ws, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
  }
  return collectEvidence(ws, [], '')
}

describe('④ 聚合：pass@1 与 pass^k 是两个数，"没跑起来"另开一栏', () => {
  const tasks = [task('write-named-file'), task('calc-then-write')]
  const ok = (n = 3): AttemptOutcome[] => Array.from({ length: n }, () => ({ ran: true, pass: true, steps: 2 }))
  const outcomes = (map: Record<string, AttemptOutcome[]>): Map<string, AttemptOutcome[]> => new Map(Object.entries(map))

  it('k 次全过才算"稳"；差一次就掉，哪怕 pass@1 很高', () => {
    const r = aggregateSuite(tasks, 4, outcomes({
      'write-named-file': ok(4),
      'calc-then-write': [{ ran: true, pass: true, steps: 2 }, { ran: true, pass: true, steps: 2 }, { ran: true, pass: true, steps: 2 }, { ran: true, pass: false, steps: 2, why: '没写文件' }]
    }))
    const first = r.perTask.find((p) => p.id === 'write-named-file')!
    const second = r.perTask.find((p) => p.id === 'calc-then-write')!
    expect(first.passAllK).toBe(1)
    expect(first.passAt1).toBe(1)
    expect(second.passAt1).toBe(0.75)
    expect(second.passAllK, '三次过一次不能算稳').toBe(0)
    expect(r.reliable).toBe(1)
    expect(r.everPassed).toBe(2)
  })

  it('跑不满 k 次一律不算"稳"（不做乐观解释）', () => {
    const r = aggregateSuite([tasks[0]!], 4, outcomes({ 'write-named-file': ok(3) }))
    expect(r.perTask[0]!.passAllK).toBe(0)
    expect(r.reliable).toBe(0)
  })

  it('"没跑起来"不进 pass@1 分母，但单独报出来；一次都没跑起来时算 deadTask', () => {
    const r = aggregateSuite(tasks, 2, outcomes({
      'write-named-file': [{ ran: false, pass: false }, { ran: true, pass: true, steps: 1 }],
      'calc-then-write': [{ ran: false, pass: false }, { ran: false, pass: false }]
    }))
    const a = r.perTask.find((p) => p.id === 'write-named-file')!
    expect(a.notRan).toBe(1)
    expect(a.passAt1).toBe(1)
    const b = r.perTask.find((p) => p.id === 'calc-then-write')!
    expect(b.passAt1).toBe(0)
    expect(r.deadTasks).toBe(1)
    expect(r.everPassed).toBe(1)
  })

  it('超步数那几次按失败算，即使产物是对的（绕远是要修的产品问题）', () => {
    const r = aggregateSuite([task('calc-then-write')], 2, outcomes({
      'calc-then-write': [
        { ran: true, pass: true, steps: 20 },
        { ran: true, pass: true, steps: 3 }
      ]
    }))
    const p = r.perTask[0]!
    expect(p.stepOverruns).toBe(1)
    expect(p.passAt1).toBe(1) // 被超步数剔掉的那次不进分母，但单独报得出来
    expect(p.passAllK, '有一次超步数 ⇒ 这一档就不算稳').toBe(0)
  })

  it('报告文本里三个数并列出现，并带上最近一次失败原因', () => {
    const r = aggregateSuite([task('write-named-file')], 2, outcomes({
      'write-named-file': [{ ran: true, pass: true, steps: 2 }, { ran: true, pass: false, steps: 2, why: 'notes/alpha.md 不存在' }]
    }))
    const text = formatSuiteReport(r)
    expect(text).toContain('pass^2')
    expect(text).toContain('全过的任务')
    expect(text).toContain('notes/alpha.md 不存在')
  })
})
