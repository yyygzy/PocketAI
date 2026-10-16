// 委派真链（V4-Iter-144 / B78、B79）——真引擎循环 + 真 HTTP 端点 + 真临时库，不 mock 网络层
//
// 为什么这条链必须真跑：144 的三条硬规矩（子级 ⊆ 父级、不递归、独立会话）全都只有
// "发出去的那次请求里到底带了什么"才证得到。把 adapter 打桩只能断"函数被调过"，
// 而本批要防的正是 V4-Iter-118 那族缺陷——清单/闸门/执行三处口径不同源，
// 结果"工具进了清单、模型真去调、执行报 TOOL_NOT_ALLOWED"。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-delegation-chain'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { toolRegistry } from '../src/main/tools/registry'
import { delegateTaskTool } from '../src/main/tools/delegate-tool'
import { agentEngine } from '../src/main/agent/engine'
import { setDelegationEnabled } from '../src/main/agent/delegate-capability'
import { setTextProtocolModel } from '../src/main/agent/text-protocol-prefs'
import {
  budgetExhausted,
  canOpenChild,
  childToolSurface,
  DELEGATE_ROLES,
  DELEGATE_TOOL_NAME,
  DELEGATION_MAX_CHILDREN,
  DELEGATION_MAX_LLM_CALLS,
  newRunBudget,
  parseDelegateArgs,
  readDelegateRoleForDisplay,
  type RunBudget
} from '../src/shared/delegation-rules'
import type { DelegateCapabilityEntry } from '../src/shared/delegate-capability'
import { IPC, type AgentDoneEvent, type AgentStepEvent } from '../src/shared/types'

const MODEL = 'chain-model'
const CHILD_MARK = '你是资料检索子代理'
const PARENT_TASK = '父任务-写汇报'
const CHILD_TASK = '子任务-取证'

// ---------- 假端点：按"父的调用 / 子的调用 / 规划调用"分别回话，并记录每次发了什么 ----------
interface Req {
  tools: string[]
  isChild: boolean
  /**
   * 元数据类请求（首轮标题升级 / 任务规划）：**不带任何 tools**。
   * 第一版没把它们摘出去 ⇒ 标题那次请求吃掉了"该委派"的脚本回复，真循环里模型拿到的
   * 是最终回答，于是整条链一个工具都没调、断言全空——假绿的反面：假红一片。
   * （规划请求带 system 消息，所以只按"没有 system"判会漏掉它 —— 这就是第二轮红出来的原因。）
   */
  isMeta: boolean
  hasParentTask: boolean
  rawText: string
}

let reqs: Req[] = []
/**
 * 父 run 发到窗口的那批 step 事件（148 的角色标签原料）。
 * 子 run 的事件走 `childEmit` 被吞掉 ⇒ 这里只可能收到父的，正是"用户在分步明细里看到什么"。
 */
let stepEvents: AgentStepEvent[] = []
/** 父 run 前 N 次要委派；子 run 前 N 步要调工具（之后一律给最终回答） */
const script = { parentDelegations: 1, childToolSteps: 1, holdChild: false, childBlockedCall: false }
/** 挂住的子请求（abort 测试用）：close 前一律放行，否则 server.close() 会卡在一个永不结束的响应上 */
let pending: Array<(text: string) => void> = []

function classify(body: Record<string, unknown>): Req {
  const tools = (body.tools ?? []) as { function?: { name?: string }; name?: string }[]
  const msgs = (body.messages ?? []) as { role?: string; content?: unknown }[]
  const text = JSON.stringify(msgs)
  const names = tools.map((t) => t.function?.name ?? t.name ?? '').filter(Boolean)
  return {
    tools: names,
    isChild: text.includes(CHILD_MARK),
    isMeta: names.length === 0,
    hasParentTask: text.includes(PARENT_TASK),
    rawText: text
  }
}

function ssePart(res: http.ServerResponse, d: unknown): void {
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n')
}

function replyContent(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  ssePart(res, { content: text })
  ssePart(res, { finish_reason: 'stop' })
  res.write('data: [DONE]\n\n')
  res.end()
}

function replyToolCall(res: http.ServerResponse, name: string, args: Record<string, unknown>, id: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  ssePart(res, {
    tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  })
  ssePart(res, { finish_reason: 'tool_calls' })
  res.write('data: [DONE]\n\n')
  res.end()
}

let server: http.Server
let baseUrl = ''
let providerId = ''
let assistantId = ''

async function waitFor(predicate: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!predicate() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25))
  if (!predicate()) throw new Error(`等不到条件成立（已记录 ${reqs.length} 次请求）`)
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  server = http.createServer((incoming, res) => {
    const chunks: Buffer[] = []
    incoming.on('data', (c: Buffer) => chunks.push(c))
    incoming.on('end', () => {
      const body = (JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') || {}) as Record<string, unknown>
      const r = classify(body)
      reqs.push(r)

      if (r.isMeta) return replyContent(res, '无需计划')
      if (r.isChild && script.holdChild) {
        // 挂住子的回答，让测试有机会中止父 run；releasePending 会兜底放行
        pending.push((text) => replyContent(res, text))
        return
      }
      if (r.isChild) {
        // 子代理"凭记忆"调一台父级被允许、但被从子清单里摘掉的工具（confirm 类）——
        // 必须被闸门拒掉，而不是替用户弹一个不会来的确认框
        if (script.childBlockedCall) {
          script.childBlockedCall = false
          return replyToolCall(res, 'calendar_read', {}, 'call_child_blocked')
        }
        if (script.childToolSteps > 0) {
          script.childToolSteps--
          return replyToolCall(res, 'time_now', {}, 'call_child_tool')
        }
        return replyContent(res, '子代理结论：证据 A、B')
      }
      if (script.parentDelegations > 0) {
        script.parentDelegations--
        return replyToolCall(res, 'delegate_task', { role: DELEGATE_ROLES[0], task: CHILD_TASK }, 'call_parent_delegate')
      }
      return replyContent(res, '综合完成')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '链测端点',
    baseUrl,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id
  // 显式 '*'（而不是依赖"无助手时的默认"）：这样"内置全授权 + 委派开关"两层的叠加关系是被测的
  assistantId = assistantRepo.save({
    name: '链测助手',
    systemPrompt: '你是主控代理，按任务需要调用工具。',
    toolPermissions: ['*'],
    knowledgeBaseIds: [],
    skillIds: []
  }).id
})

afterAll(async () => {
  // 先放行所有挂住的响应，再关服务：否则 close() 等一个永不结束的 SSE
  pending.splice(0).forEach((release) => release('收尾放行'))
  await new Promise<void>((r) => server.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

/** 把这台模型的判定写进真库（键与存储位置逐字同 `delegate-capability`）：开关的前置条件走的是真数据 */
function seedVerdict(capability: DelegateCapabilityEntry['capability'], hits = 3): void {
  const entry = {
    key: `${providerId}::${MODEL}`,
    providerId,
    model: MODEL,
    capability,
    samples: 3,
    nativeHits: hits,
    digest: '',
    checkedAt: Date.now()
  }
  appConfigRepo.set('agent.delegate_capability', JSON.stringify([entry]))
}

function freshParent(): string {
  return conversationRepo.create({ assistantId, title: '父会话' }).id
}

function runParent(conversationId: string, requestId: string): Promise<AgentDoneEvent | null> {
  let done: AgentDoneEvent | null = null
  // 父 run 发到窗口的那批 step 事件（子 run 的走 childEmit，被吞掉 ⇒ 这里只可能收到父的）
  stepEvents.length = 0
  const emit = (channel: string, data: unknown): void => {
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
    else if (channel === IPC.AGENT_STEP_EVENT) stepEvents.push(data as AgentStepEvent)
  }
  return agentEngine
    .run(
      {
        requestId,
        conversationId,
        assistantId,
        content: PARENT_TASK,
        targets: [{ providerId, model: MODEL }],
        agentMode: true
      },
      emit
    )
    .then(() => done)
}

function delegateToolMsg(convId: string): string {
  const msg = messageRepo
    .listByConversation(convId)
    .find((m) => m.role === 'tool' && String(m.content).includes('delegate_task'))
  return msg ? String(msg.content) : ''
}

/**
 * 清账前先把**上一个用例的迟到请求**放干。
 * B79 那条"一条子请求都不发"会偶红（本轮 145 的三遍全量里红过，单独跑这个文件也复现得出），
 * 根因不在委派链：子会话一进门就 fire-and-forget 发一条**后台标题升级**
 * （`title-gen.ts` 的 `void upgradeTitleWithLlm`，自带 controller、父中止也拦不住它），
 * 载荷里带着角色开场白 ⇒ 被 `isChild` 认成"子的推理"。它在**上一个**用例发出、在**下一个**用例归零之后才落到服务端。
 * 所以 `reqs = []` 与"只记窗口边界"都挡不住（迟到那条是在归零之后 append 进来的）；
 * 唯一稳的是"等到不再有新请求到达再清"（连续 3 拍 20ms 静默，上限 1.5s）。
 */
async function resetScript(): Promise<void> {
  const t0 = Date.now()
  let last = reqs.length
  let quiet = 0
  while (quiet < 3 && Date.now() - t0 < 1500) {
    await new Promise((r) => setTimeout(r, 20))
    if (reqs.length === last) quiet++
    else {
      quiet = 0
      last = reqs.length
    }
  }
  reqs = []
  script.parentDelegations = 1
  script.childToolSteps = 1
  script.holdChild = false
  script.childBlockedCall = false
}

describe('委派开关（决策③：默认关，用户点名才开）', () => {
  beforeEach(resetScript)

  it('没探测过 ⇒ 开不了；清单里没有 delegate_task，模型凭空调也**一次子请求都不发**', async () => {
    appConfigRepo.set('agent.delegate_capability', '')
    const denied = setDelegationEnabled(providerId, MODEL, true)
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain('还没探测')

    const conv = freshParent()
    await runParent(conv, 'req-off-1')
    const parentReq = reqs.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.tools, '开关没开就不该出现在清单里').not.toContain('delegate_task')
    const msg = delegateToolMsg(conv)
    expect(msg, '被拒要留下一条工具消息，父代理才看得见').toContain('DELEGATION_DISABLED')
    expect(reqs.filter((r) => r.isChild)).toHaveLength(0)
  })

  it('判定不是「可当管控者」⇒ 开不了，并把实际判定说清楚', () => {
    seedVerdict('fence_only', 0)
    const r = setDelegationEnabled(providerId, MODEL, true)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('fence_only')
  })

  it('开着文本协议 ⇒ 即便判定是可当管控者也不许开（委派靠的就是原生工具那条路）', () => {
    seedVerdict('native_tools_ok')
    setTextProtocolModel(providerId, MODEL, true)
    const r = setDelegationEnabled(providerId, MODEL, true)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('文本协议')
    setTextProtocolModel(providerId, MODEL, false)
  })

  it('关闭永远允许（不需要判定）', () => {
    appConfigRepo.set('agent.delegate_capability', '')
    const r = setDelegationEnabled(providerId, MODEL, false)
    expect(r.ok).toBe(true)
  })
})

describe('委派规则本身（纯函数，链外也要能单独断言）', () => {
  const tool = (name: string, permission?: 'auto' | 'confirm' | 'deny') => ({ name, permission })

  it('childToolSurface：摘掉委派本身 + confirm/deny，其余原样保留（顺序与内容都不许扩）', () => {
    const parent = [tool('time_now'), tool('delegate_task'), tool('calendar_read', 'confirm'), tool('fs_write', 'deny'), tool('kb_search')]
    const child = childToolSurface(parent)
    expect(child.map((t) => t.name)).toEqual(['time_now', 'kb_search'])
    // 反向对照：父面里本来就没有 delegate_task 时也不许凭空造出来
    expect(childToolSurface([tool('time_now')]).map((t) => t.name)).toEqual(['time_now'])
  })

  it('parseDelegateArgs：角色必须点名、任务不许空也不许超长（不做"宽容纠正"）', () => {
    expect(parseDelegateArgs({ role: 'researcher', task: '查清检索为什么慢' })).toMatchObject({ ok: true })
    expect(parseDelegateArgs({ role: 'boss', task: '随便' }).ok).toBe(false)
    expect(parseDelegateArgs({ role: 'writer', task: '   ' }).ok).toBe(false)
    expect(parseDelegateArgs({ role: 'writer', task: '字'.repeat(4001) }).ok).toBe(false)
  })

  it('registry 那条路走到 delegate_task 时必须明确失败（不是含糊的"未注册"）', async () => {
    // 引擎按名字截走，正常永远到不了这里；到得了就说明有新的执行入口没接上委派分支
    const out = await delegateTaskTool.execute({}, {})
    expect(out).toContain('DELEGATE_UNHANDLED')
  })

  it('预算与子会话数：触顶即真（用 >= 而不是 >，多一次都不许发）', () => {
    const b = newRunBudget()
    expect(b.max).toBe(DELEGATION_MAX_LLM_CALLS)
    expect(budgetExhausted(b)).toBe(false)
    b.used = b.max - 1
    expect(budgetExhausted(b)).toBe(false)
    b.used = b.max
    expect(budgetExhausted(b)).toBe(true)
    expect(canOpenChild(b)).toBe(true)
    b.children = DELEGATION_MAX_CHILDREN
    expect(canOpenChild(b)).toBe(false)
  })
})

describe('委派真链（开关打开后）', () => {
  // resetScript 现在是 async（清账前要放干迟到请求）：**这里必须 await**——
  // `beforeEach(() => { resetScript() })` 会把那个 promise 丢掉，清账就跑在测试体中间，
  // 把 `script.parentDelegations` 之类的设置**在测试进行中原样重置回去**，一次红 6 条（本批踩过）。
  beforeEach(async () => {
    await resetScript()
    seedVerdict('native_tools_ok')
    expect(setDelegationEnabled(providerId, MODEL, true).ok).toBe(true)
  })

  it('父派子做：子清单 ⊆ 父清单、不含 delegate_task、不含 confirm 类；子会话看不到父的上下文', async () => {
    const conv = freshParent()
    const done = await runParent(conv, 'req-on-1')
    expect(done).not.toBeNull()

    const parentReqs = reqs.filter((r) => !r.isChild && !r.isMeta)
    const childReqs = reqs.filter((r) => r.isChild)
    expect(parentReqs[0]!.tools).toContain('delegate_task')
    expect(childReqs.length).toBeGreaterThan(0)

    const parentTools = new Set(parentReqs[0]!.tools)
    const blockedNames = new Set(
      toolRegistry.listAll().filter((t) => t.permission === 'confirm' || t.permission === 'deny').map((t) => t.name)
    )
    // 先证明这一格不是空断言：父面里**确实有**需要确认的工具，"子清单里没有"才有意义
    expect(blockedNames.size, '本仓应当存在 confirm/deny 类内置工具，否则这条断言是空的').toBeGreaterThan(0)
    expect([...parentTools].some((n) => blockedNames.has(n)), '父面里没有 confirm 类工具 ⇒ 下面那条断言会空过').toBe(true)
    for (const c of childReqs) {
      for (const t of c.tools) expect(parentTools.has(t), `子级出现父级没有的工具：${t}`).toBe(true)
      expect(c.tools, '不许递归委派').not.toContain('delegate_task')
      for (const n of c.tools) expect(blockedNames.has(n), `confirm/deny 类不该进子清单：${n}`).toBe(false)
    }

    // 独立会话最直接的证据：子请求里没有父任务那句话，只有派给它的任务
    expect(childReqs.some((c) => c.hasParentTask), '子 run 不该带父上下文').toBe(false)
    expect(childReqs.every((c) => c.rawText.includes(CHILD_TASK))).toBe(true)

    // 归因：子会话带 parent + role；子的 trace 指回父 request；父的 trace 是 NULL
    const kids = conversationRepo
      .list(undefined, undefined, { includeSubSessions: true })
      .filter((c) => c.parentConversationId === conv)
    expect(kids).toHaveLength(1)
    expect(kids[0]!.roleKey).toBe('researcher')
    expect(conversationRepo.list().map((c) => c.id), '子会话默认不进列表').not.toContain(kids[0]!.id)
    expect(conversationRepo.list().map((c) => c.id)).toContain(conv)

    const childTraces = agentTraceRepo.listByConversation(kids[0]!.id)
    expect(childTraces.length).toBeGreaterThan(0)
    for (const t of childTraces) expect(t.parentRequestId).toBe('req-on-1')
    for (const t of agentTraceRepo.listByConversation(conv)) expect(t.parentRequestId).toBeNull()

    expect(delegateToolMsg(conv)).toContain('子代理结论')
  })

  it('删父会话 ⇒ 子会话一起消失（不留看不见的孤儿）', async () => {
    const conv = freshParent()
    await runParent(conv, 'req-del-1')
    const kid = conversationRepo.list(undefined, undefined, { includeSubSessions: true }).find((c) => c.parentConversationId === conv)!
    expect(kid).toBeDefined()
    expect(messageRepo.listByConversation(kid.id).length).toBeGreaterThan(0)
    conversationRepo.delete(conv)
    expect(conversationRepo.get(kid.id)).toBeNull()
    expect(messageRepo.listByConversation(kid.id)).toHaveLength(0)
  })

  it('子代理调"父级被允许、子清单已摘掉"的 confirm 类工具 ⇒ 闸门拒绝，而不是弹一个不会来的确认框', async () => {
    script.childBlockedCall = true
    script.childToolSteps = 0
    const conv = freshParent()
    await runParent(conv, 'req-blocked-1')
    const kid = conversationRepo.list(undefined, undefined, { includeSubSessions: true }).find((c) => c.parentConversationId === conv)!
    const toolMsgs = messageRepo.listByConversation(kid.id).filter((m) => m.role === 'tool')
    const blocked = toolMsgs.find((m) => String(m.content).includes('calendar_read'))
    expect(blocked, '子清单里没有的工具，调用必须留下一条被拒记录').toBeTruthy()
    expect(String(blocked!.content)).toContain('TOOL_NOT_ALLOWED')
    // 反向对照：这条工具在**父**面是可见的（父有 '*'），被摘掉只发生在子级
    expect(toolRegistry.listAll().find((t) => t.name === 'calendar_read')!.permission).toBe('confirm')
  })

  it('父中止 ⇒ 子 run 一起停（会话落在 aborted，不是留下一个还在占显存的孤儿）', async () => {
    script.holdChild = true
    const conv = freshParent()
    let finished = false
    const p = runParent(conv, 'req-abort-1').then(() => {
      finished = true
    })
    await waitFor(() => reqs.some((r) => r.isChild))
    agentEngine.abort('req-abort-1')
    await p
    await waitFor(() => finished)
    const kid = conversationRepo.list(undefined, undefined, { includeSubSessions: true }).find((c) => c.parentConversationId === conv)
    expect(kid, '中止的父也要清掉子会话这一行（不留 status 悬空）').toBeDefined()
    expect(kid!.status).toBe('aborted')
  })

  it('预算触顶 ⇒ 委派被拒且**一条子请求都不发**（B79）', async () => {
    const conv = freshParent()
    const exhausted = { used: DELEGATION_MAX_LLM_CALLS, max: DELEGATION_MAX_LLM_CALLS, children: 0, maxChildren: DELEGATION_MAX_CHILDREN }
    await agentEngine.run(
      {
        requestId: 'req-budget-1',
        conversationId: conv,
        assistantId,
        content: PARENT_TASK,
        targets: [{ providerId, model: MODEL }],
        agentMode: true
      },
      () => {},
      { budget: exhausted }
    )
    expect(delegateToolMsg(conv)).toContain('DELEGATE_BUDGET_EXHAUSTED')
    expect(reqs.filter((r) => r.isChild)).toHaveLength(0)
    // 第二条证据与请求计数无关，因此不受任何迟到请求的干扰：这一轮**压根没建子会话**
    // （建会话是发请求之前的最后一步，见 engine 的 prepareDelegation）
    expect(
      conversationRepo.list(undefined, undefined, { includeSubSessions: true }).filter((c) => c.parentConversationId === conv)
    ).toHaveLength(0)
  })

  it('子会话数用满 ⇒ 拒绝且一条子会话都不建；子 run 一进门发现触顶就不再烧调用', async () => {
    const conv = freshParent()
    await agentEngine.run(
      {
        requestId: 'req-cap-1',
        conversationId: conv,
        assistantId,
        content: PARENT_TASK,
        targets: [{ providerId, model: MODEL }],
        agentMode: true
      },
      () => {},
      { budget: { used: 0, max: DELEGATION_MAX_LLM_CALLS, children: DELEGATION_MAX_CHILDREN, maxChildren: DELEGATION_MAX_CHILDREN } }
    )
    expect(delegateToolMsg(conv)).toContain('DELEGATE_CHILD_LIMIT')
    expect(conversationRepo.list(undefined, undefined, { includeSubSessions: true }).filter((c) => c.parentConversationId === conv)).toHaveLength(0)

    script.parentDelegations = 0
    const kid = conversationRepo.create({ assistantId, title: '触顶子会话', parentConversationId: conv, roleKey: 'researcher' }).id
    const runKid = (requestId: string, budget: RunBudget): Promise<void> =>
      agentEngine.run(
        {
          requestId,
          conversationId: kid,
          assistantId,
          content: `${CHILD_MARK}\n\n任务：${CHILD_TASK}`,
          targets: [{ providerId, model: MODEL }],
          agentMode: true,
          unattended: true
        },
        () => {},
        { parentRequestId: 'req-cap-1', budget, asChild: true }
      )

    /**
     * 对照组（必须存在，否则"触顶就收敛"那条是空断言）：预算充足时这个子 run **确实会多走几步**
     * ——端点脚本让它连续调 6 次工具，所以 llm 步数一定 > 2。
     * 上一版没有这一组，我把预算闸整段删掉它照样绿（那次子 run 本来就只走 2 步）。
     */
    script.childToolSteps = 6
    await runKid('req-kid-control', { used: 0, max: DELEGATION_MAX_LLM_CALLS, children: 1, maxChildren: 3 })
    const controlLlm = agentTraceRepo.listByRequest('req-kid-control').filter((t) => t.stepType === 'llm').length
    expect(controlLlm, '对照组跑不出多步，下面那条触顶断言就没有意义').toBeGreaterThan(2)

    // 触顶：一进门就发现预算见底 ⇒ 不再往循环里烧调用（只有降级那一次 LLM）
    script.childToolSteps = 6
    await runKid('req-kid-1', { used: DELEGATION_MAX_LLM_CALLS, max: DELEGATION_MAX_LLM_CALLS, children: 1, maxChildren: 3 })
    const kidTraces = agentTraceRepo.listByRequest('req-kid-1')
    expect(
      kidTraces.filter((t) => t.stepType === 'llm').length,
      '触顶就该收敛，不许一路跑到 maxSteps'
    ).toBeLessThanOrEqual(2)
    for (const t of kidTraces) expect(t.parentRequestId).toBe('req-cap-1')
  })

  it('反向对照：没开委派的另一台 provider 运行如常——清单里没有 delegate_task、trace 全 NULL、不多一条子会话', async () => {
    const other = providerRepo.save({
      id: '',
      type: 'openai-compatible',
      name: '未开启端点',
      baseUrl,
      apiKeys: [],
      models: ['other-model'],
      enabled: true,
      createdAt: Date.now()
    }).id
    script.parentDelegations = 0
    const kidsBefore = conversationRepo.list(undefined, undefined, { includeSubSessions: true }).length
    const conv = freshParent()
    await agentEngine.run(
      {
        requestId: 'req-plain-1',
        conversationId: conv,
        assistantId,
        content: PARENT_TASK,
        targets: [{ providerId: other, model: 'other-model' }],
        agentMode: true
      },
      () => {}
    )
    const parentReq = reqs.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.tools).not.toContain('delegate_task')
    expect(reqs.some((r) => r.isChild)).toBe(false)
    // 只数这一棵树的子会话：整个文件共享一个库，全局条数会被别的用例干扰（第一版就是这么假失败的）
    expect(kidsBefore).toBeGreaterThanOrEqual(0)
    expect(conversationRepo.list(undefined, undefined, { includeSubSessions: true }).filter((c) => c.parentConversationId === conv)).toHaveLength(0)
    for (const t of agentTraceRepo.listByRequest('req-plain-1')) expect(t.parentRequestId).toBeNull()
  })
})

/**
 * 148 的角色标签不新增事件字段，是**从 tool_call 的参数 JSON 现读**的。
 * 那这条路的原料必须用真引擎发出来的事件来证：手搓一个 `{role:'writer'}` 的 toolCall 对象
 * 证得了纯函数，证不到"引擎实际发给窗口的那一步里 arguments 是齐的、且只有委派带得出角色"。
 */
describe('角色标签的原料来自真 step 事件（V4-Iter-148 / B84）', () => {
  beforeEach(async () => {
    await resetScript()
    seedVerdict('native_tools_ok')
    expect(setDelegationEnabled(providerId, MODEL, true).ok).toBe(true)
  })

  it('只有 delegate_task 的 tool_call 读得出角色；标签与子会话的 roleKey 同源；结果步读不出', async () => {
    const conv = freshParent()
    await runParent(conv, 'req-label-1')

    const roleOf = (e: AgentStepEvent): string | null =>
      readDelegateRoleForDisplay(e.toolCall?.function.name, e.toolCall?.function.arguments)
    const labelled = stepEvents.filter((e) => roleOf(e) !== null)
    expect(labelled.length, '父的 tool_call 一个角色都读不出 ⇒ 界面上永远不会有标签').toBeGreaterThan(0)
    for (const e of labelled) {
      expect(e.type).toBe('tool_call')
      expect(e.toolCall!.function.name, '非委派的调用读不出角色，读出来了就是认错人').toBe(DELEGATE_TOOL_NAME)
    }
    expect(labelled.map((e) => roleOf(e))).toEqual(['researcher'])

    // 界面写的角色与数据层归因（143 的 roleKey）不能是两套口径
    const kid = conversationRepo
      .list(undefined, undefined, { includeSubSessions: true })
      .find((c) => c.parentConversationId === conv)!
    expect(kid.roleKey).toBe('researcher')

    // 结果步读不出：引擎只在持久化那份 JSON 里补 `arguments`，live 的 ToolResult 没有 ⇒ 标签只打调用步
    const results = stepEvents.filter((e) => e.type === 'tool_result')
    expect(results.length, '这一轮没收到 tool_result 事件 ⇒ 下面那条断言是空的').toBeGreaterThan(0)
    for (const e of results) expect(readDelegateRoleForDisplay(e.toolResult!.name, e.toolResult!.arguments)).toBeNull()
  })

  it('被拒的委派也留得下原料：一次子的请求都没发，标签照样读得出"派的是谁"', async () => {
    expect(setDelegationEnabled(providerId, MODEL, false).ok).toBe(true)
    const conv = freshParent()
    await runParent(conv, 'req-label-refused')
    expect(reqs.filter((r) => r.isChild), '开关关了就不该有子的推理请求').toHaveLength(0)
    expect(delegateToolMsg(conv)).toContain('DELEGATION_DISABLED')
    const call = stepEvents.find((e) => e.type === 'tool_call')!
    expect(call, '被拒前也没 emit tool_call ⇒ 分步明细里看不见这一步').toBeDefined()
    expect(readDelegateRoleForDisplay(call.toolCall!.function.name, call.toolCall!.function.arguments)).toBe('researcher')
  })
})
