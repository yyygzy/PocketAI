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
import { kbRepo } from '../src/main/db/repositories/kb.repo'
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
import {
  configureLocalSlot,
  isLocalInferenceBaseUrl,
  resetLocalSlotsForTest,
  setSlotDecisionForTest
} from '../src/main/providers/local-slot'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { IPC, BUILTIN_EMBED_PROVIDER_ID, type AgentDoneEvent, type ChatTarget } from '../src/shared/types'

const CHILD_BRIEFS = Object.values(ROLE_BRIEF).map((b) => b.slice(0, 11))
const PARENT_TASK = '父任务-写汇报'
const CHILD_TASK = '子任务-取证'

// ---------- 判据表（纯函数，链外先钉住口径） ----------

describe('跨模型角色的两条合取（mayAssignDistinctModelRole，150 起按"子的实际占用"判）', () => {
  /** 默认 = 本地子、不碰检索（= 145 那套里最严的一格），各用例只改自己要的那一条 */
  const facts = (over: Partial<{ childEndpointLocal: boolean; childUsesRetrieval: boolean; retrievalHitsLocalEndpoint: boolean }> = {}) => ({
    childEndpointLocal: true,
    childUsesRetrieval: false,
    retrievalHitsLocalEndpoint: false,
    ...over
  })

  it('今天真硬件到不了"本地落点放行"档：≤4GiB / >4GiB / 采不到，本地子一律不放', () => {
    for (const vram of [4096, 8192, null]) {
      const d = planLocalCapacity({ totalVramMiB: vram })
      expect(d.rolesMayUseDistinctModels, `显存 ${vram} 不该放行跨模型`).toBe(false)
      expect(mayAssignDistinctModelRole(d, facts()).allowed).toBe(false)
    }
  })

  /**
   * 150 用户选定（A2）的那条口径：容量判据说的是"两个本地模型能否同驻"，
   * 子落在云端时这张卡上什么都没有 ⇒ 拿它拦"本地父 + 云的子"是判据找错了对象。
   */
  it('云子不受容量档管：同一份 4GiB 判定，childEndpointLocal=false ⇒ 放行', () => {
    const d = planLocalCapacity({ totalVramMiB: 4096 })
    const v = mayAssignDistinctModelRole(d, facts({ childEndpointLocal: false }))
    expect(v.allowed, '云子不占本机显存，①对它没有对象').toBe(true)
    expect(v.reasons).toEqual(['distinct-roles-allowed'])
    // 反向对照：把这条前提写坏（云子也照判）时，上面那格会红——所以两格都得在
    expect(mayAssignDistinctModelRole(d, facts({ childEndpointLocal: true })).allowed).toBe(false)
  })

  it('①可以被子推上去（应用显式设小 ctx 那一档实测过同驻），但 ②单独就能否掉', () => {
    const withSmallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })
    expect(withSmallCtx.rolesMayUseDistinctModels, '小 ctx 那一档是实测过同驻的（3b+coder 3149MiB）').toBe(true)
    // 反向对照：只写 ① 时这一格会错判成"可以开"——低配的真实硬约束是"一个 embed 把对话模型顶出去"
    const blocked = mayAssignDistinctModelRole(withSmallCtx, facts({ childUsesRetrieval: true, retrievalHitsLocalEndpoint: true }))
    expect(blocked.allowed).toBe(false)
    expect(blocked.reasons).toEqual(['retrieval-chain-exclusive'])
    expect(mayAssignDistinctModelRole(withSmallCtx, facts())).toEqual({
      allowed: true,
      reasons: ['distinct-roles-allowed']
    })
  })

  /**
   * 150 用户选定的"一起细化"：拦的理由是 M10（本机 GPU 被 embed 顶掉），
   * 内置那路 embedding 走 onnxruntime 的 CPU、云端 embedding 不碰这张卡 ⇒ 不能再拿它当理由。
   */
  it('走检索链但 embedding 不落本机端点 ⇒ 第二条不再拦', () => {
    const withSmallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })
    const v = mayAssignDistinctModelRole(withSmallCtx, facts({ childUsesRetrieval: true, retrievalHitsLocalEndpoint: false }))
    expect(v.allowed, 'kb_search 检索的是内置 CPU 那路（或压根没绑库）时，M10 不适用').toBe(true)
    // 反向对照：同一份事实只把落点改成本地 ⇒ 立刻拦
    expect(mayAssignDistinctModelRole(withSmallCtx, facts({ childUsesRetrieval: true, retrievalHitsLocalEndpoint: true })).allowed).toBe(false)
  })

  it('两条都不过 ⇒ 两个码都说出来（界面按码出文案，不许只报第一条）', () => {
    const v = mayAssignDistinctModelRole(planLocalCapacity({ totalVramMiB: 4096 }), facts({ childUsesRetrieval: true, retrievalHitsLocalEndpoint: true }))
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
  /** 150：`model` 参数里给的候选清单（A2 的口径是"只列放得开的落点"，所以这份枚举本身就是要断言的东西） */
  delegateModelEnum: string[]
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
    delegateModelEnum: (() => {
      const m = (delegate?.function?.parameters?.properties ?? {}).model as { enum?: unknown } | undefined
      return Array.isArray(m?.enum) ? m.enum.map((x) => String(x)) : []
    })(),
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
/** 第二台**本地**落点：150 之后"清单只剩云端候选"要有它才证得到（填另一台本地模型仍该被拒） */
let local2ProviderId = ''
let assistantId = ''
let assistantNoKbId = ''
let assistantLocalEmbedKbId = ''
let assistantCpuEmbedKbId = ''
const LOCAL_MODEL = 'local-model'
const REMOTE_MODEL = 'remote-model'
const LOCAL2_MODEL = 'local-other-model'

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
  /**
   * 第二台**本地**落点（不用起服务：它只该在闸门处被拒掉，一次请求都不该发出去）。
   * 150 之后"清单里只剩云端候选"这句话要有反面对象才证得到。
   */
  local2ProviderId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '链测-第二台本地端点',
    baseUrl: 'http://localhost:1/v1',
    apiKeys: [],
    models: [LOCAL2_MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id
  /**
   * 150 细化的第二条合取要两种 embedding 落点各一个真库：
   *  · 指向本地端点的 ⇒ 真的会吃这张卡 ⇒ 该拦；
   *  · 内置那路（onnxruntime CPU）的 ⇒ 不碰这张卡 ⇒ 不该再拿 M10 当理由。
   */
  const kbLocalEmbed = kbRepo.save({
    name: '本地 embedding 库',
    embeddingProviderId: localProviderId,
    embeddingModel: 'embed-x'
  }).id
  const kbCpuEmbed = kbRepo.save({
    name: '内置 CPU embedding 库',
    embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID,
    embeddingModel: 'bge-small-zh-v1.5'
  }).id
  assistantLocalEmbedKbId = assistantRepo.save({
    name: '链测助手（绑本地 embedding 库）',
    systemPrompt: '你是主控代理，按任务需要调用工具。',
    toolPermissions: ['agent.delegate', 'time.now'],
    knowledgeBaseIds: [kbLocalEmbed],
    skillIds: []
  }).id
  assistantCpuEmbedKbId = assistantRepo.save({
    name: '链测助手（绑内置 CPU 库）',
    systemPrompt: '你是主控代理，按任务需要调用工具。',
    toolPermissions: ['agent.delegate', 'time.now'],
    knowledgeBaseIds: [kbCpuEmbed],
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
    // 档名要给：147 起 `bucket` 决定编排上限。这里刻意用未实测档（⇒ 逐字等于全局默认 3/15），
    // 让这个文件继续只测 145 的跨模型路由；上限本身由 B83 那两条用例管。
    bucket: 'main-6g',
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
    const opts = listRoleModelOptions(localProviderId, () => true)
    expect(opts[0]).toBe(LOCAL_MODEL)
    expect(opts).toContain(REMOTE_MODEL)
    expect(opts).toContain(`${otherId}::shared-model`)
    expect(opts, '歧义裸名不许出现在清单里').not.toContain('shared-model')
    expect(opts, '停用 provider 的模型不该进清单').not.toContain('gone-model')
  })

  /**
   * 150（用户选定 A2）：清单 = 当时放得开的落点。今天父在本地时 ① 恒不过 ⇒ 只剩云端候选，
   * 而"model 参数进不进 schema"看的就是这张清单空不空——所以这一格钉的是"清单本身会筛"，
   * 不是"引擎会不会筛"（后者由真链那两组用例钉）。
   */
  it('150：清单按落点筛；全放不开时交回空清单', () => {
    const onlyCloud = listRoleModelOptions(localProviderId, (c) => !c.endpointLocal)
    expect(onlyCloud).toContain(REMOTE_MODEL)
    expect(onlyCloud, '本地候选过不了容量档时不该出现在清单里').not.toContain(LOCAL_MODEL)
    expect(listRoleModelOptions(localProviderId, () => false)).toEqual([])
  })
})

// ---------- 真链 ----------

/**
 * 150 把这条 describe 的前提换掉了：① 没过**不再等于整条路关死**——它管的是"两个本地模型能否同驻"，
 * 子落在云端时这张卡上什么都没有。所以这里两组各证一头：该拦的仍然一次请求都不发，该放的真的发出去了。
 */
describe('150 真链：①没过 ⇒ 清单只剩云端候选；落云端放行、落本地仍拒', () => {
  beforeEach(resetScript)

  it('父在本地、①没过：model 参数照给，但枚举里只有云端候选（本地那台的名字不在里面）', async () => {
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[0], task: CHILD_TASK, model: REMOTE_MODEL }]
    const conv = freshParent(assistantNoKbId)
    await runParent({ conversationId: conv, requestId: 'req-150-enum', assistant: assistantNoKbId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    const parentReq = log.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.tools).toContain('delegate_task')
    expect(parentReq.delegateParams, '有云端候选可派 ⇒ model 参数该给').toContain('model')
    expect(parentReq.delegateModelEnum).toContain(REMOTE_MODEL)
    expect(parentReq.delegateModelEnum, '本地候选过不了①，不该出现在清单里让模型去填').not.toContain(LOCAL2_MODEL)
    expect(parentReq.delegateModelEnum, '裸名与 providerId::全名两种写法都不该给').not.toContain(`${local2ProviderId}::${LOCAL2_MODEL}`)
    expect(parentReq.delegateModelEnum).not.toContain(LOCAL_MODEL)
  })

  it('填了另一台**本地**模型 ⇒ 仍然拒，且一次请求都不发、不建子会话（闸门还在发请求之前）', async () => {
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[0], task: CHILD_TASK, model: LOCAL2_MODEL }]
    const conv = freshParent(assistantNoKbId)
    await runParent({ conversationId: conv, requestId: 'req-150-local2', assistant: assistantNoKbId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    expect(delegateToolMsg(conv)).toContain('DELEGATE_DISTINCT_BLOCKED')
    expect(delegateToolMsg(conv)).toContain('distinct-roles-not-measured')
    expect(kidsOf(conv), '被拦在备妥阶段 ⇒ 一条子会话都不该有').toHaveLength(0)
    expect(remoteReqs()).toHaveLength(0)
  })

  it('填的是**云端**模型 ⇒ 放行：云端点真的收到子的推理请求，子会话记的就是那台模型', async () => {
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[0], task: CHILD_TASK, model: REMOTE_MODEL }]
    const conv = freshParent(assistantNoKbId)
    await runParent({ conversationId: conv, requestId: 'req-150-cloud-ok', assistant: assistantNoKbId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    expect(remoteReqs(), '这条就是本批改动的正脸：云子不占本机显存 ⇒ 该发出去').not.toHaveLength(0)
    const kids = kidsOf(conv)
    expect(kids).toHaveLength(1)
    expect(kids[0]!.modelLabel).toContain(REMOTE_MODEL)
    expect(kids[0]!.roleKey).toBe(DELEGATE_ROLES[0])
  })
})

/**
 * 第二条合取的细化（150 用户选定"一起细化"）：拦的理由是 M10"一个 embed 把对话模型顶出去"，
 * 那是本机 GPU 的事 ⇒ 只有 embedding 真落在本地端点时才成立。两种落点各一个真库，两格都不许省。
 */
describe('150 真链：第二条合取按 embedding 落点判', () => {
  beforeEach(resetScript)

  it('面里有 kb_search 但**没绑库** ⇒ 第二条不拦（kb_search 检索不到东西，压根不会加载 embedding）', async () => {
    // 这一格守的是"工具面 ≠ 会吃显存"：把②写成"面里有 kb_search 就拦"的旧口径，它会红
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[0], task: CHILD_TASK, model: REMOTE_MODEL }]
    const conv = freshParent(assistantId)
    await runParent({ conversationId: conv, requestId: 'req-150-kbsearch-no-kb', assistant: assistantId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    const parentReq = log.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.tools, '全授权面应当含 kb_search，否则这条用例在空转').toContain('kb_search')
    expect(parentReq.delegateParams).toContain('model')
    expect(delegateToolMsg(conv)).not.toContain('DELEGATE_DISTINCT_BLOCKED')
    expect(kidsOf(conv)).toHaveLength(1)
  })

  it('①放行 + 助手绑的是**本地端点 embedding** 的库 ⇒ 两种落点都拦：model 参数压根不进清单', async () => {
    allowDistinctRoles()
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[0], task: CHILD_TASK, model: REMOTE_MODEL }]
    const conv = freshParent(assistantLocalEmbedKbId)
    await runParent({ conversationId: conv, requestId: 'req-150-kb-local', assistant: assistantLocalEmbedKbId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    const parentReq = log.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.delegateParams, '②对两种落点都成立 ⇒ 清单该整个撤掉').not.toContain('model')
    expect(delegateToolMsg(conv)).toContain('retrieval-chain-exclusive')
    expect(remoteReqs()).toHaveLength(0)
    expect(kidsOf(conv)).toHaveLength(0)
  })

  it('①没过 + 助手绑的是**内置 CPU embedding** 的库 ⇒ 第二条不再拦，云子照发（细化不是装饰）', async () => {
    enableDelegation(localProviderId, LOCAL_MODEL)
    script.parentDelegates = [{ role: DELEGATE_ROLES[0], task: CHILD_TASK, model: REMOTE_MODEL }]
    const conv = freshParent(assistantCpuEmbedKbId)
    await runParent({ conversationId: conv, requestId: 'req-150-kb-cpu', assistant: assistantCpuEmbedKbId, target: { providerId: localProviderId, model: LOCAL_MODEL } })

    const parentReq = log.find((r) => !r.isChild && !r.isMeta)!
    expect(parentReq.delegateParams, '绑了库≠吃显存；内置那路是 onnxruntime CPU').toContain('model')
    expect(delegateToolMsg(conv)).not.toContain('DELEGATE_DISTINCT_BLOCKED')
    expect(kidsOf(conv)).toHaveLength(1)
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

// ---------- V4-Iter-147：这一档的编排上限真的进到这一轮（B83 的另一半） ----------

/**
 * 上面那些用例注入的是**决策本身**（`setSlotDecisionForTest`），走的是 `local-slot.ts:224` 的
 * `decisionOverride` 那条短路——它连"显存数 → 认档"这一步都跳过了，所以拿来测 147 的表等于只测表。
 * 这一组改从**输入端**接：`configureLocalSlot({ readVramMiB })` ⇒ 让 `capacitySnapshot()` 现算，
 * 于是「总量 → `capacityBucketOf` → `delegationLimitsOf` → `newRunBudget` → 闸门」整条线都被踩到。
 *
 * 一个必须注意的副作用：`entry-4g` 是 `measured:true` ⇒ 141 的槽位闸门这回**真的会套槽**，
 * 所以这一组的 `script.hold` 一律为空（挂住等第二条在飞的那些用例留在上面那组里，它们注入的是
 * `measured:false` 的决策，本来就不排队）。
 */
describe('147 真链：显存档 → 本轮编排上限（子会话条数与 LLM 调用数）', () => {
  beforeEach(resetScript)
  afterEach(() => {
    // deps 也要清：`configureLocalSlot` 改的是模块级 deps，不清会漏给下一个用例
    resetLocalSlotsForTest()
  })

  const threeDelegates = () =>
    [DELEGATE_ROLES[0], DELEGATE_ROLES[1], DELEGATE_ROLES[2]].map((role, i) => ({
      role,
      task: `${CHILD_TASK}-${String.fromCharCode(65 + i)}`
    }))

  /** 跑一趟父在 `providerId` 上的委派，显存档由 vramMiB 决定（null = 采不到） */
  async function runWithVram(input: {
    vramMiB: number | null
    providerId: string
    model: string
    requestId: string
    delegates: Array<{ role: (typeof DELEGATE_ROLES)[number]; task: string }>
    childToolSteps?: number
  }): Promise<string> {
    configureLocalSlot({ readVramMiB: () => input.vramMiB })
    enableDelegation(input.providerId, input.model)
    script.childToolSteps = input.childToolSteps ?? 0
    script.hold = null
    script.parentDelegates = input.delegates
    const conv = freshParent(assistantNoKbId)
    await runParent({
      conversationId: conv,
      requestId: input.requestId,
      assistant: assistantNoKbId,
      target: { providerId: input.providerId, model: input.model }
    })
    return conv
  }

  /** 整棵编排树烧掉的 LLM 步数（父 + 每个子会话的 llm trace） */
  function llmStepsOf(conv: string): number {
    const kids = kidsOf(conv)
    return [conv, ...kids.map((k) => k.id)].reduce(
      (n, cid) => n + agentTraceRepo.listByConversation(cid).filter((t) => t.stepType === 'llm').length,
      0
    )
  }

  /**
   * 三条委派 = 三条工具消息，`delegateToolMsg` 只回**第一条**（那是成功的那条），
   * 被上限拒掉的是第三条 ⇒ 这里必须看全量，否则用例会因为"取错了消息"而假绿。
   */
  function allToolMsgs(conv: string): string {
    return messageRepo
      .listByConversation(conv)
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content))
      .join('\n')
  }

  it('4096MiB（实测档）⇒ 第三条子会话被拒，且话术说的是"这台机器所在档的默认上限"', async () => {
    const conv = await runWithVram({
      vramMiB: 4096,
      providerId: localProviderId,
      model: LOCAL_MODEL,
      requestId: 'req-147-entry-3',
      delegates: threeDelegates()
    })
    const msg = allToolMsgs(conv)
    expect(msg).toContain('DELEGATE_CHILD_LIMIT')
    // 数字与出处都在话术里：界面不许写死 3，也不许把这条上限说成"编排规则"
    expect(msg).toContain('最多开 2 条')
    expect(msg).toContain('这台机器所在档的默认上限')
    expect(kidsOf(conv), '上限 2 ⇒ 只建两条子会话').toHaveLength(2)
  })

  /**
   * 反证（144 的 M5 那条教训：没有对照组，"上限生效"就只是"注入了个小数字"）。
   * 同一份脚本、同一台端点，只差 6144 这个数 ⇒ 三条都建得出来。
   */
  it('6144MiB（未实测档）⇒ 同一批三条委派全部落地，没有一条被上限挡掉', async () => {
    const conv = await runWithVram({
      vramMiB: 6144,
      providerId: localProviderId,
      model: LOCAL_MODEL,
      requestId: 'req-147-main-3',
      delegates: threeDelegates()
    })
    expect(delegateToolMsg(conv)).not.toContain('DELEGATE_CHILD_LIMIT')
    expect(kidsOf(conv)).toHaveLength(3)
  })

  /**
   * 147 唯一一条"放宽"方向的前提：`delegationLimitsOf(bucket, false)` 恒给全局默认。
   * 判据找错对象是 150 那轮记过的老错——本机那张卡上什么都没那么轻，凭什么限云端编排的长度。
   */
  it('父在云端点时 4096MiB 不管用：三条照建（上限只对本机落点生效）', async () => {
    const conv = await runWithVram({
      vramMiB: 4096,
      providerId: remoteProviderId,
      model: REMOTE_MODEL,
      requestId: 'req-147-cloud-3',
      delegates: threeDelegates()
    })
    expect(delegateToolMsg(conv)).not.toContain('DELEGATE_CHILD_LIMIT')
    expect(kidsOf(conv)).toHaveLength(3)
  })

  it('采不到显存 ⇒ unknown 档 = 全局默认（不猜一个"低配"，也不猜"高配"）', async () => {
    const conv = await runWithVram({
      vramMiB: null,
      providerId: localProviderId,
      model: LOCAL_MODEL,
      requestId: 'req-147-unknown-3',
      delegates: threeDelegates()
    })
    expect(kidsOf(conv)).toHaveLength(3)
  })

  /**
   * `maxLlmCalls` 那一半只能从**子 run 的入口收敛**观（`engine.ts:1070`）：
   * 父侧那句 `DELEGATE_BUDGET_EXHAUSTED`（`:1991`）排在子会话数闸门（`:1988`）之后，
   * 低配档下 2 条先响 ⇒ 在 147 的这一档里根本印不出「（N/10）」，拿它当证据就是空断言。
   * 所以这里断的是"整棵树烧到 10 就停"，对照组同一脚本在 6144 下明显烧得更多。
   */
  it('4096MiB ⇒ LLM 调用数封顶在 10；6144MiB ⇒ 同一脚本烧得更多', async () => {
    const low = await runWithVram({
      vramMiB: 4096,
      providerId: localProviderId,
      model: LOCAL_MODEL,
      requestId: 'req-147-entry-budget',
      delegates: [
        { role: DELEGATE_ROLES[0], task: `${CHILD_TASK}-A` },
        { role: DELEGATE_ROLES[1], task: `${CHILD_TASK}-B` }
      ],
      // 端点脚本本身"永远还有下一步可做"，好让封顶只可能来自预算而不是脚本耗尽
      childToolSteps: 40
    })
    const lowSteps = llmStepsOf(low)
    // 实测恰为 10 = 这一档的 maxLlmCalls（`engine.ts:1155` 记在 LLM 步入口 ⇒ 触顶那一轮不再发出去）
    expect(lowSteps, '实测档该在 10 这一档收住').toBeLessThanOrEqual(10)

    const high = await runWithVram({
      vramMiB: 6144,
      providerId: localProviderId,
      model: LOCAL_MODEL,
      requestId: 'req-147-main-budget',
      delegates: [
        { role: DELEGATE_ROLES[0], task: `${CHILD_TASK}-A` },
        { role: DELEGATE_ROLES[1], task: `${CHILD_TASK}-B` }
      ],
      childToolSteps: 40
    })
    const highSteps = llmStepsOf(high)
    expect(highSteps, '同一份脚本在未实测档（=全局 15）下必须烧得更多，否则上面那条封顶是空断言').toBeGreaterThan(
      lowSteps
    )
    // 实测 15 = 全局默认（同一份脚本、同一台端点，差别只来自那个显存数）
    expect(highSteps).toBeLessThanOrEqual(15)
  }, 30000)
})
