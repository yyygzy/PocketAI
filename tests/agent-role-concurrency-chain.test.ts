// 角色落点与角色并发真链（V4-Iter-145 / B80）——真引擎循环 + **两台**计数假端点 + 真临时库
//
// B80 的验收口径是"判据 false 时**物理上发不出**第二个模型请求，用请求计数器断言，
// 不许只断 UI 置灰"。所以这里的断言全部落在**端点收到了什么**上：
//  · 被拦的那一侧 ⇒ 第二台端点的请求条数是 0（不是"结果是错误"这种同义反复）；
//  · 放行那一侧必须有对照 ⇒ 没有它，"删掉闸门也全绿"（144 的 M5 就是这个形状）；
//  · 并行/串行不靠时间猜 ⇒ 端点把子请求**挂住等第二条**，只有真的同时在飞才会解开，
//    串行时超时自放，并发峰值停在 1。
//
// 两台端点都跑在本机 loopback 上：一台绑 127.0.0.1、一台绑 127.0.0.2。
// 后者被共享谓辞 `isLocalInferenceBaseUrl` 判成"非回环"（那张表只有 localhost/127.0.0.1/::1），
// 所以它代表的是**判据眼里的云**——用例钉的是判据驱动的调度形状，不是 127.0.0.2 真的在云上。
// 若哪天回环表补全了 127/8，这条会**变红**而不是静默失效（并行峰值掉到 1）。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-role-concurrency'
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
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { delegateTaskTool } from '../src/main/tools/delegate-tool'
import { agentEngine } from '../src/main/agent/engine'
import { setDelegationEnabled } from '../src/main/agent/delegate-capability'
import { listRoleModelOptions, resolveChildTarget } from '../src/main/agent/delegation'
import {
  mayAssignDistinctModelRole,
  planLocalCapacity,
  planRoleConcurrency
} from '../src/main/agent/local-capacity'
import {
  DELEGATE_MODEL_ENUM_MAX_ITEMS,
  DELEGATE_MODEL_MAX_CHARS,
  DELEGATE_ROLES,
  DELEGATION_MAX_CHILDREN,
  DELEGATION_MAX_LLM_CALLS,
  parseDelegateArgs,
  ROLE_BRIEF,
  withDelegateModelParam
} from '../src/shared/delegation-rules'
import { isLocalInferenceBaseUrl, resetLocalSlotsForTest, setSlotDecisionForTest } from '../src/main/providers/local-slot'
import { IPC, type AgentDoneEvent, type ChatTarget } from '../src/shared/types'

const CHILD_BRIEFS = Object.values(ROLE_BRIEF).map((b) => b.slice(0, 11))
const PARENT_TASK = '父任务-写汇报'
const CHILD_TASK = '子任务-取证'

// ---------- 判据表（纯函数，链外先钉住口径） ----------

describe('跨模型角色的两条合取（mayAssignDistinctModelRole）', () => {
  it('今天真硬件到不了放行档：≤4GiB / >4GiB / 采不到，三条都判"不跨模型"', () => {
    for (const vram of [4096, 8192, null]) {
      const d = planLocalCapacity({ totalVramMiB: vram })
      expect(d.rolesMayUseDistinctModels, `显存 ${vram} 不该放行跨模型`).toBe(false)
      expect(mayAssignDistinctModelRole(d, { childUsesRetrieval: false }).allowed).toBe(false)
    }
  })

  it('①可以被子推上去（应用显式设小 ctx 那一档实测过同驻），但 ②单独就能否掉', () => {
    const withSmallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })
    expect(withSmallCtx.rolesMayUseDistinctModels, '小 ctx 那一档是实测过同驻的（3b+coder 3149MiB）').toBe(true)
    // 反向对照：只写 ① 时这一格会错判成"可以开"——低配的真实硬约束是"一个 embed 把对话模型顶出去"
    const blocked = mayAssignDistinctModelRole(withSmallCtx, { childUsesRetrieval: true })
    expect(blocked.allowed).toBe(false)
    expect(blocked.reasons).toEqual(['retrieval-chain-exclusive'])
    expect(mayAssignDistinctModelRole(withSmallCtx, { childUsesRetrieval: false })).toEqual({
      allowed: true,
      reasons: ['distinct-roles-allowed']
    })
  })

  it('两条都不过 ⇒ 两个码都说出来（界面按码出文案，不许只报第一条）', () => {
    const v = mayAssignDistinctModelRole(planLocalCapacity({ totalVramMiB: 4096 }), { childUsesRetrieval: true })
    expect(v.allowed).toBe(false)
    expect(v.reasons).toEqual(['distinct-roles-not-measured', 'retrieval-chain-exclusive'])
  })
})

describe('角色并发（云并行、本地串行）', () => {
  it('有一条子 run 在本地端点 ⇒ 整批按串行走，并给出理由码', () => {
    const p = planRoleConcurrency({ endpointsLocal: [false, true], requested: 2 })
    expect(p.parallel).toBe(false)
    expect(p.maxParallel).toBe(1)
    expect(p.reasons).toEqual(['local-serial-measured'])
  })

  it('全在云 ⇒ 按请求条数并行；只有一条时谈不上并行', () => {
    expect(planRoleConcurrency({ endpointsLocal: [false, false], requested: 2 })).toMatchObject({ parallel: true, maxParallel: 2 })
    expect(planRoleConcurrency({ endpointsLocal: [false], requested: 1 }).parallel).toBe(false)
    expect(planRoleConcurrency({ endpointsLocal: [], requested: 0 }).maxParallel).toBe(1)
  })
})

// ---------- delegate_task 的 model 参数（纯规则） ----------

describe('parseDelegateArgs 的 model 形状', () => {
  it('省略 / 空串 / null 都等于"沿用当前模型"', () => {
    for (const model of [undefined, '', null]) {
      expect(parseDelegateArgs({ role: 'researcher', task: '取证', model })).toMatchObject({ ok: true, model: null })
    }
  })

  it('给了就用，去空白；超长与非字符串直接拒（不静默截断）', () => {
    expect(parseDelegateArgs({ role: 'writer', task: '写', model: '  qwen2.5:3b  ' })).toMatchObject({
      ok: true,
      model: 'qwen2.5:3b'
    })
    expect(parseDelegateArgs({ role: 'writer', task: '写', model: 'x'.repeat(DELEGATE_MODEL_MAX_CHARS + 1) }).ok).toBe(false)
    expect(parseDelegateArgs({ role: 'writer', task: '写', model: 42 }).ok).toBe(false)
  })
})

describe('withDelegateModelParam（schema 交换）', () => {
  it('加上 model 且不动别的键；**注册表那一份必须原样**（原地改会污染所有会话）', () => {
    const before = JSON.stringify(delegateTaskTool.schema)
    const swapped = withDelegateModelParam(delegateTaskTool.schema, ['m-a', 'm-b'])
    const props = swapped.parameters.properties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(['model', 'role', 'task'])
    expect((props.model as { enum?: string[] }).enum).toEqual(['m-a', 'm-b'])
    expect(swapped.parameters.additionalProperties).toBe(false)
    expect(swapped.description).not.toBe(delegateTaskTool.schema.description)
    expect(JSON.stringify(delegateTaskTool.schema), '交换不许写回注册表').toBe(before)
    // 反向对照：静态注册形状仍然不含 model（保守默认，B75 那条"清单里没有"的口径没被撬动）
    expect(Object.keys((delegateTaskTool.schema.parameters.properties ?? {}) as Record<string, unknown>)).toEqual(['role', 'task'])
  })

  it('候选超上限只截断清单，不截断放行（放行由 provider 表判）', () => {
    const many = Array.from({ length: DELEGATE_MODEL_ENUM_MAX_ITEMS + 5 }, (_, i) => `m${i}`)
    const props = withDelegateModelParam(delegateTaskTool.schema, many).parameters.properties as Record<string, { enum?: string[] } | undefined>
    const listed = props.model?.enum ?? []
    expect(listed).toHaveLength(DELEGATE_MODEL_ENUM_MAX_ITEMS)
    expect(listed[0]).toBe('m0')
  })
})

// ---------- 两台计数假端点 ----------

interface Req {
  server: string
  tools: string[]
  delegateParams: string[]
  isChild: boolean
  isMeta: boolean
}

const log: Req[] = []
/** 只数"子的非元数据请求"：并发峰值要的是真在飞的第二台模型请求，标题/规划那类不算 */
const inflight: Record<string, number> = { local: 0, remote: 0 }
const peaks: Record<string, number> = { local: 0, remote: 0 }
const parked: Array<{ server: string; open: () => void }> = []

/** 在飞计数只覆盖"子的最终回答请求"：并发峰值要证的就是这一条有没有真的一起飞出去 */
function beginChild(name: string): void {
  inflight[name] = (inflight[name] ?? 0) + 1
  peaks[name] = Math.max(peaks[name] ?? 0, inflight[name])
}

function endChild(name: string): void {
  inflight[name] = Math.max(0, (inflight[name] ?? 0) - 1)
}

const script = {
  /** 父下一次回复要发出的委派调用（一条=144 形态，两条=要并行的那一批） */
  parentDelegates: [] as Record<string, unknown>[],
  childToolSteps: 0,
  /** 挂住子请求直到凑够 need 条同时在飞（凑不够就按时自放） */
  hold: null as { need: number; ms: number } | null
}

/**
 * 清账前先等"不再有新请求到达"（连续 3 拍 20ms 静默，上限 1.5s）。
 * 这个文件里被拦的用例断言的是**云端点请求数 = 0**，而上一个用例的子 run 会 fire-and-forget 发一条
 * 后台标题升级（`title-gen.ts` 的 `void upgradeTitleWithLlm`，自带 controller、父中止也拦不住）——
 * 它在自己的用例里发出、在下一个用例归零之后才落到服务端，就会被数成"越界的那一条"（144 的同一条坑，本轮撞到才写的）。
 * `beforeEach(resetScript)` 直接把 async 函数交给 vitest，会被 await；若在包装箭头函数里调它，**必须自己 await**。
 */
async function resetScript(): Promise<void> {
  const t0 = Date.now()
  let last = log.length
  let quiet = 0
  while (quiet < 3 && Date.now() - t0 < 1500) {
    await new Promise((r) => setTimeout(r, 20))
    if (log.length === last) quiet++
    else {
      quiet = 0
      last = log.length
    }
  }
  flushParked('local')
  flushParked('remote')
  log.length = 0
  inflight.local = 0
  inflight.remote = 0
  peaks.local = 0
  peaks.remote = 0
  script.parentDelegates = []
  script.childToolSteps = 1
  script.hold = null
}

function classify(server: string, body: Record<string, unknown>): Req {
  const tools = (body.tools ?? []) as { function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }[]
  const msgs = (body.messages ?? []) as { role?: string; content?: unknown }[]
  const text = JSON.stringify(msgs)
  const names = tools.map((t) => t.function?.name ?? '').filter(Boolean)
  const delegate = tools.find((t) => t.function?.name === 'delegate_task')
  return {
    server,
    tools: names,
    delegateParams: Object.keys(delegate?.function?.parameters?.properties ?? {}),
    isChild: CHILD_BRIEFS.some((b) => text.includes(b)),
    isMeta: names.length === 0
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

function replyToolCalls(res: http.ServerResponse, calls: Array<{ name: string; args: Record<string, unknown>; id: string }>): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  // index 必须逐条递增：全填 0 会让客户端把多条调用**合并成一条**（实测拼出
  // name="delegate_taskdelegate_task"、arguments 两段 JSON 相连 ⇒ 变成 UNKNOWN_TOOL，
  // 于是"同一步里的两条委派"这个前提静默地不存在了）
  ssePart(res, {
    tool_calls: calls.map((c, i) => ({
      index: i,
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) }
    }))
  })
  ssePart(res, { finish_reason: 'tool_calls' })
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * 一台假端点。挂住的子响应由 `flushParked` 放行（凑齐 / 超时 / 用例收尾三条路都会走），
 * 所以回答必须幂等：同一个响应写两次数据会直接把 SSE 弄坏。
 */
function makeServer(name: string): http.Server {
  return http.createServer((incoming, res) => {
    const chunks: Buffer[] = []
    incoming.on('data', (c: Buffer) => chunks.push(c))
    incoming.on('end', () => {
      const body = (JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') || {}) as Record<string, unknown>
      const r = classify(name, body)
      log.push(r)
      // 元数据类请求（首轮标题 / 规划）**不带 tools**：先摘出去，否则它会吃掉委派脚本（144 的同款坑）
      if (r.isMeta) return replyContent(res, '无需计划')

      if (!r.isChild) {
        if (script.parentDelegates.length > 0) {
          const calls = script.parentDelegates
          script.parentDelegates = []
          return replyToolCalls(
            res,
            calls.map((args, i) => ({ name: 'delegate_task', args, id: `call_parent_delegate_${i}` }))
          )
        }
        return replyContent(res, '综合完成')
      }

      if (script.childToolSteps > 0) {
        // 子代理的工具步不挂住：立刻放，让"最终回答"那一步成为被计数的在飞请求
        script.childToolSteps--
        return replyToolCalls(res, [{ name: 'time_now', args: {}, id: 'call_child_tool' }])
      }

      beginChild(name)
      let answered = false
      const answer = (): void => {
        if (answered) return
        answered = true
        endChild(name)
        replyContent(res, `子代理结论：来自 ${name}`)
      }
      if (script.hold) {
        parked.push({ server: name, open: answer })
        const mine = parked.filter((p) => p.server === name).length
        if (mine >= script.hold.need) flushParked(name)
        else setTimeout(() => flushParked(name), script.hold.ms)
        return
      }
      return answer()
    })
  })
}

function flushParked(name: string): void {
  const mine = parked.filter((p) => p.server === name)
  for (const p of mine) {
    const i = parked.indexOf(p)
    if (i >= 0) parked.splice(i, 1)
    p.open()
  }
}

let localHttp: http.Server
let remoteHttp: http.Server
let localBaseUrl = ''
let remoteBaseUrl = ''
/** 父（本地）与子（云）两台落点；'remote-model' 这个名字全局唯一，所以候选清单里它是裸名 */
let localProviderId = ''
let remoteProviderId = ''
let assistantId = ''
let assistantNoKbId = ''
const LOCAL_MODEL = 'local-model'
const REMOTE_MODEL = 'remote-model'

async function waitFor(predicate: () => boolean, ms = 12000): Promise<void> {
  const t0 = Date.now()
  while (!predicate() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25))
  if (!predicate()) throw new Error(`等不到条件成立（已记录 ${log.length} 次请求）`)
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  localHttp = makeServer('local')
  remoteHttp = makeServer('remote')
  await new Promise<void>((r) => localHttp.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => remoteHttp.listen(0, '127.0.0.2', r))
  localBaseUrl = `http://127.0.0.1:${(localHttp.address() as AddressInfo).port}/v1`
  remoteBaseUrl = `http://127.0.0.2:${(remoteHttp.address() as AddressInfo).port}/v1`
  if (isLocalInferenceBaseUrl(localBaseUrl) !== true || isLocalInferenceBaseUrl(remoteBaseUrl) !== false) {
    throw new Error('假端点的"本地/云"分类与共享谓辞不一致，用例的前提没了')
  }

  localProviderId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '链测-本地端点',
    baseUrl: localBaseUrl,
    apiKeys: [],
    models: [LOCAL_MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id
  remoteProviderId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '链测-云端点',
    baseUrl: remoteBaseUrl,
    apiKeys: [],
    models: [REMOTE_MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id
  assistantId = assistantRepo.save({
    name: '链测助手（全授权）',
    systemPrompt: '你是主控代理，按任务需要调用工具。',
    toolPermissions: ['*'],
    knowledgeBaseIds: [],
    skillIds: []
  }).id
  // 工具面里**没有** kb_search 的助手：145 的第二条合取（不走检索链）要能成立，只能靠这一格
  assistantNoKbId = assistantRepo.save({
    name: '链测助手（不碰知识库）',
    systemPrompt: '你是主控代理，按任务需要调用工具。',
    toolPermissions: ['agent.delegate', 'time.now'],
    knowledgeBaseIds: [],
    skillIds: []
  }).id
})

afterAll(async () => {
  flushParked('local')
  flushParked('remote')
  setSlotDecisionForTest(null)
  resetLocalSlotsForTest()
  await new Promise<void>((r) => localHttp.close(() => r()))
  await new Promise<void>((r) => remoteHttp.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

afterEach(() => {
  flushParked('local')
  flushParked('remote')
  setSlotDecisionForTest(null)
})

function seedVerdict(providerId: string, model: string): void {
  const entry = {
    key: `${providerId}::${model}`,
    providerId,
    model,
    capability: 'native_tools_ok',
    samples: 3,
    nativeHits: 3,
    digest: '',
    checkedAt: Date.now()
  }
  appConfigRepo.set('agent.delegate_capability', JSON.stringify([entry]))
}

/** 放行跨模型角色①：今天真硬件给不出这一档（应用从不设 num_ctx），所以只能注入。measured=false ⇒ 141 的闸门照旧不套槽 */
function allowDistinctRoles(): void {
  setSlotDecisionForTest(() => ({
    maxConcurrentChatSlots: 1,
    allowChatEmbedOverlap: false,
    rolesMayUseDistinctModels: true,
    measured: false,
    reasons: []
  }))
}

function enableDelegation(providerId: string, model: string): void {
  seedVerdict(providerId, model)
  expect(setDelegationEnabled(providerId, model, true).ok).toBe(true)
}

function freshParent(assistant: string): string {
  return conversationRepo.create({ assistantId: assistant, title: '父会话' }).id
}

function runParent(input: {
  conversationId: string
  requestId: string
  assistant: string
  target: ChatTarget
}): Promise<AgentDoneEvent | null> {
  let done: AgentDoneEvent | null = null
  const emit = (channel: string, data: unknown): void => {
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
  }
  return agentEngine
    .run(
      {
        requestId: input.requestId,
        conversationId: input.conversationId,
        assistantId: input.assistant,
        content: PARENT_TASK,
        targets: [input.target],
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

function kidsOf(convId: string) {
  return conversationRepo.list(undefined, undefined, { includeSubSessions: true }).filter((c) => c.parentConversationId === convId)
}

const remoteReqs = (): Req[] => log.filter((r) => r.server === 'remote' && !r.isMeta)
const childReqs = (server: string): Req[] => log.filter((r) => r.server === server && r.isChild && !r.isMeta)

// ---------- 落点解析（对着真 provider 表） ----------

describe('resolveChildTarget：控制器点名的模型要能在 provider 表里落地', () => {
  const parent: ChatTarget = { providerId: localProviderId, model: LOCAL_MODEL }
  let otherId = ''
  let other2Id = ''
  let disabledId = ''

  beforeAll(() => {
    // 三台只为解析用例存在：共享一个库里"同名模型挂在多家"这件事只有真表能证
    otherId = providerRepo.save({
      id: '', type: 'openai-compatible', name: '解析-云 A', baseUrl: 'http://127.0.0.3:9/v1',
      apiKeys: [], models: ['gpt-x', 'shared-model'], enabled: true, createdAt: Date.now()
    }).id
    other2Id = providerRepo.save({
      id: '', type: 'openai-compatible', name: '解析-云 B', baseUrl: 'http://127.0.0.4:9/v1',
      apiKeys: [], models: ['shared-model'], enabled: true, createdAt: Date.now()
    }).id
    disabledId = providerRepo.save({
      id: '', type: 'openai-compatible', name: '解析-停用', baseUrl: 'http://127.0.0.5:9/v1',
      apiKeys: [], models: ['gone-model'], enabled: false, createdAt: Date.now()
    }).id
  })
  afterAll(() => {
    for (const id of [otherId, other2Id, disabledId]) providerRepo.delete(id)
  })

  it('省略 model ⇒ 沿用父的落点，distinct=false', () => {
    expect(resolveChildTarget(parent, null)).toEqual({ ok: true, target: parent, distinct: false, endpointLocal: true })
  })

  it('换到另一台 ⇒ distinct=true，并按那家 baseUrl 判本地/云', () => {
    const r = resolveChildTarget(parent, REMOTE_MODEL)
    expect(r).toEqual({
      ok: true,
      target: { providerId: remoteProviderId, model: REMOTE_MODEL },
      distinct: true,
      endpointLocal: false
    })
  })

  it('精确匹配，不做家族匹配（3b 不等于 3b-instruct，同 142 的 digest 教训）', () => {
    const r = resolveChildTarget(parent, 'local-model-instruct')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('拉取模型')
  })

  it('未缓存的名字 ⇒ 拒，并把"先拉取模型"写在同句里（不发一次注定失败的推理）', () => {
    const r = resolveChildTarget(parent, 'not-a-model')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('设置 → 模型服务商')
  })

  it('同名挂在多家 ⇒ 裸名拒掉并要求 providerId::model；全名可解析', () => {
    const bare = resolveChildTarget(parent, 'shared-model')
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.error).toContain(`providerId::shared-model`)
    const full = resolveChildTarget(parent, `${other2Id}::shared-model`)
    expect(full.ok).toBe(true)
    if (full.ok) expect(full.target).toEqual({ providerId: other2Id, model: 'shared-model' })
  })

  it('provider 停用 ⇒ 明确说停用，不去请求它', () => {
    const r = resolveChildTarget(parent, `${disabledId}::gone-model`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('已停用')
  })

  it('候选清单：父的模型排最前，歧义名用全名（每一项都能直接填进 model）', () => {
    const opts = listRoleModelOptions(localProviderId)
    expect(opts[0]).toBe(LOCAL_MODEL)
    expect(opts).toContain(REMOTE_MODEL)
    expect(opts).toContain(`${otherId}::shared-model`)
    expect(opts, '歧义裸名不许出现在清单里').not.toContain('shared-model')
    expect(opts, '停用 provider 的模型不该进清单').not.toContain('gone-model')
  })
})

// ---------- 真链 ----------

describe('145 真链：判据没过 ⇒ 第二台端点收到 0 次请求', () => {
  beforeEach(resetScript)

  it('①没过（今天真硬件的常态）⇒ 清单里没有 model 参数，云端点一次请求都没收到，也不建子会话', async () => {
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[0], task: CHILD_TASK, model: REMOTE_MODEL }]
    const conv = freshParent(assistantNoKbId)
    await runParent({ conversationId: conv, requestId: 'req-145-blocked', assistant: assistantNoKbId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    const parentReq = log.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.tools).toContain('delegate_task')
    expect(parentReq.delegateParams, '判据没过 ⇒ model 这个参数压根不该发出去').not.toContain('model')
    expect(delegateToolMsg(conv)).toContain('DELEGATE_DISTINCT_BLOCKED')
    expect(delegateToolMsg(conv)).toContain('distinct-roles-not-measured')
    expect(remoteReqs(), 'B80：被拦在发请求之前，云端点的计数必须是 0').toHaveLength(0)
    expect(kidsOf(conv)).toHaveLength(0)
  })

  it('①放行但这条编排走检索链 ⇒ 仍然拦住（第二条合取不是装饰）', async () => {
    allowDistinctRoles()
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[0], task: CHILD_TASK, model: REMOTE_MODEL }]
    const conv = freshParent(assistantId) // '*' 面里有 kb_search ⇒ 检索链成立
    await runParent({ conversationId: conv, requestId: 'req-145-kb', assistant: assistantId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    const parentReq = log.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.tools, '全授权面应当含 kb_search，否则这条用例在空转').toContain('kb_search')
    expect(parentReq.delegateParams).not.toContain('model')
    expect(delegateToolMsg(conv)).toContain('retrieval-chain-exclusive')
    expect(remoteReqs()).toHaveLength(0)
    expect(kidsOf(conv)).toHaveLength(0)
  })
})

describe('145 真链：判据放行 ⇒ 角色真的落在另一台模型上', () => {
  beforeEach(resetScript)

  it('两条合取都过 ⇒ schema 带 model、子 run 打到云端点、子会话记的是那台模型的落点', async () => {
    allowDistinctRoles()
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[1], task: CHILD_TASK, model: REMOTE_MODEL }]
    const conv = freshParent(assistantNoKbId)
    await runParent({ conversationId: conv, requestId: 'req-145-allowed', assistant: assistantNoKbId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    const parentReq = log.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.delegateParams, '放行才加参数：与上面那条被拒的用例正好互为对照').toContain('model')
    await waitFor(() => remoteReqs().length > 0)
    const kid = kidsOf(conv)[0]
    expect(kid, '跨模型角色要建新子会话').toBeDefined()
    expect(kid!.roleKey).toBe('writer')
    expect(kid!.modelLabel).toBe(`agent:${remoteProviderId}:${REMOTE_MODEL}`)
    expect(childReqs('remote').length).toBeGreaterThan(0)
    expect(delegateToolMsg(conv)).toContain('子代理结论：来自 remote')
  })
})

describe('145 真链：云并行、本地串行（并发峰值由端点数出来）', () => {
  beforeEach(resetScript)

  /** 两条委派调用在同一步里发出；端点把子请求挂住等第二条，只有真并行才会凑齐 ⇒ 峰值 2 */
  async function runTwoChildren(targetProviderId: string, model: string, requestId: string): Promise<string> {
    enableDelegation(targetProviderId, model)
    script.childToolSteps = 0
    script.hold = { need: 2, ms: 1500 }
    script.parentDelegates = [
      { role: DELEGATE_ROLES[0], task: `${CHILD_TASK}-A` },
      { role: DELEGATE_ROLES[2], task: `${CHILD_TASK}-B` }
    ]
    const conv = freshParent(assistantNoKbId)
    await runParent({ conversationId: conv, requestId, assistant: assistantNoKbId, target: { providerId: targetProviderId, model } })
    return conv
  }

  it('云端点：两条子 run 同时在飞（峰值 2），两条都拿到结果', async () => {
    const conv = await runTwoChildren(remoteProviderId, REMOTE_MODEL, 'req-145-parallel')
    expect(peaks.remote, '并行判据该发两条却在飞一条').toBe(2)
    expect(kidsOf(conv)).toHaveLength(2)
    const msg = delegateToolMsg(conv)
    expect(msg).toContain('子代理结论：来自 remote')
    expect(childReqs('remote').length).toBeGreaterThanOrEqual(2)
  }, 30000)

  it('本地端点：同一批只允许一条在飞（峰值 1），但两条子会话都跑完', async () => {
    const conv = await runTwoChildren(localProviderId, LOCAL_MODEL, 'req-145-serial')
    expect(peaks.local, '本地并行买不到东西（M6），而且会和 141 的槽位排队打架').toBe(1)
    // 反向对照：串行不是"派发坏了所以只有一条"——两条子会话与两份结果都得在
    expect(kidsOf(conv)).toHaveLength(2)
    expect(childReqs('local').length).toBeGreaterThanOrEqual(2)
  }, 30000)

  it('并行那一批也躲不过子会话数上限：3 条已满 ⇒ 两条都被拒、云端点 0 次子请求', async () => {
    enableDelegation(remoteProviderId, REMOTE_MODEL)
    script.childToolSteps = 0
    script.hold = null
    script.parentDelegates = [
      { role: DELEGATE_ROLES[0], task: `${CHILD_TASK}-A` },
      { role: DELEGATE_ROLES[1], task: `${CHILD_TASK}-B` }
    ]
    const conv = freshParent(assistantNoKbId)
    await agentEngine.run(
      {
        requestId: 'req-145-full',
        conversationId: conv,
        assistantId: assistantNoKbId,
        content: PARENT_TASK,
        targets: [{ providerId: remoteProviderId, model: REMOTE_MODEL }],
        agentMode: true
      },
      () => {},
      { budget: { used: 0, max: DELEGATION_MAX_LLM_CALLS, children: DELEGATION_MAX_CHILDREN, maxChildren: DELEGATION_MAX_CHILDREN } }
    )
    // 备妥阶段就把每条都判掉：既没建会话，也没往第二台端点发一次推理
    expect(delegateToolMsg(conv)).toContain('DELEGATE_CHILD_LIMIT')
    expect(kidsOf(conv)).toHaveLength(0)
    expect(childReqs('remote'), '被拒的一批不该有任何子在飞').toHaveLength(0)
  })
})
