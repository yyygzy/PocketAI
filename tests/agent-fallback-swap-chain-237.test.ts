// @vitest-environment node
// V4-Iter-237 的接线证据：**重试耗尽那一档真的会换到备用那台，而且换得可归因**。
//
// 形状复用 §234／§232：真 SQLite ＋ 真引擎循环 ＋ 真本地 SSE 端点。
// 判据不取"界面看起来对"，取三处互相独立的落点：
//  · 每个端点被打了**几次**（换没换、换了几次，这个数不会说谎）；
//  · `agent_traces` 里各行的 `model` 列（失败那行必须还挂着旧模型——这就是 plan 里那句
//    "不许让用户以为还是那台模型在答"的 DB 侧凭据）；
//  · messages 表里那句"换到哪台"落在**哪一条** assistant 行上（它的 provider/model 仍是旧的，
//    因为那次失败确实属于旧那台）。
//
// 反向对照是本批的主角：没设备用／400（不可重试）／子 run／备用那台被禁用／备用自己也 500／
// 备用属于别的模型 —— 六种情况都必须**不换**。放宽很容易，钉住"什么时候不许换"才是这条链的价值。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-237-chain'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.data + '/mcp',
  isPortable: () => false,
  portableDataDir: () => P.data
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentEngine } from '../src/main/agent/engine'
import { providerManager } from '../src/main/providers/manager'
import { setFallbackTarget, fallbackTargetKey } from '../src/main/agent/fallback-target-prefs'
import { setModelContextWindow } from '../src/main/agent/model-window-prefs'
import { IPC, type AgentDoneEvent, type AgentErrorEvent } from '../src/shared/types'

// 模型名决定端点的行为（三个 provider 各自挂在一段路径下，但同一台端点也要能演"答好"）
const BAD_MODEL = 'm-always-500' // 恒 500：可重试 ⇒ 三次跑完 ⇒ 允许换备用
const FLAKY_MODEL = 'm-400-no-retry' // 400：不可重试 ⇒ 一发就 break ⇒ 不许换
const GOOD_MODEL = 'm-answers' // 答好（备用那台）
const BAD2_MODEL = 'm-also-500' // 也 500：验"只换一次"
const GOOD_IN_A_MODEL = 'm-answers-in-a' // 挂在第一台端点上、但会答好：单独验溢出提示不进换台那条链

let server: http.Server
let port = 0
let badProvider = ''
let goodProvider = ''
let bad2Provider = ''
/** 每一发请求的 `路径标签|模型名`，判据里的"打了几次"就数它 */
let hits: string[] = []

function sseText(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

const tagOf = (tag: string): string[] => hits.filter((h) => h.startsWith(`${tag}|`)).map((h) => h.split('|')[1]!)
const countOf = (tag: string, model?: string): number =>
  tagOf(tag).filter((m) => !model || m === model).length

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    if (!url.includes('/chat/completions')) {
      res.writeHead(404).end('{}')
      return
    }
    // baseUrl 形如 http://127.0.0.1:PORT/<tag>/v1 ⇒ 第一段路径就是"哪个 provider"
    const tag = '/' + (url.split('/')[1] ?? '')
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const model = String((JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { model?: string }).model ?? '')
      hits.push(`${tag}|${model}`)
      if (model === GOOD_MODEL || model === GOOD_IN_A_MODEL) sseText(res, '备用答上来的')
      else if (model === FLAKY_MODEL) res.writeHead(400).end('{"error":{"message":"bad request"}}')
      else res.writeHead(500).end('{"error":{"message":"upstream down"}}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  const mk = (tag: string, name: string, models: string[]): string =>
    providerRepo.save({
      id: '',
      type: 'openai-compatible',
      name,
      baseUrl: `${origin}/${tag}/v1`,
      apiKeys: [],
      models,
      enabled: true,
      createdAt: Date.now()
    }).id
  badProvider = mk('a', '恒 500', [BAD_MODEL, FLAKY_MODEL, GOOD_IN_A_MODEL])
  goodProvider = mk('b', '答好', [GOOD_MODEL])
  bad2Provider = mk('c', '也 500', [BAD2_MODEL])
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

interface RunOut {
  requestId: string
  conversationId: string
  done: AgentDoneEvent | null
  error: AgentErrorEvent | null
  /** agent_traces 里这一发的行（按写入顺序），归因判据就在 model 列上 */
  traces: Array<{ step_index: number; step_type: string; status: string; error: string | null; model: string | null }>
}

/** 跑一发：默认发往那台恒 500 的；`tokens` 是给那台模型声明的窗口（null＝清除） */
async function runOne(
  opts: { model?: string; provider?: string; asChild?: boolean; content?: string; tokens?: number | null } = {}
): Promise<RunOut> {
  hits = []
  const provider = opts.provider ?? badProvider
  const model = opts.model ?? BAD_MODEL
  const asst = assistantRepo.save({ name: `助手-${Date.now()}`, toolPermissions: [] })
  const conversationId = conversationRepo.create({ assistantId: asst.id, title: '备用', titleDefault: false }).id
  const requestId = `req-237-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  if (opts.tokens !== undefined) setModelContextWindow(provider, model, opts.tokens)
  let done: AgentDoneEvent | null = null
  let error: AgentErrorEvent | null = null
  const emit = (channel: string, data: unknown): void => {
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
    else if (channel === IPC.AGENT_ERROR_EVENT) error = data as AgentErrorEvent
  }
  await agentEngine.run(
    {
      requestId,
      conversationId,
      assistantId: asst.id,
      content: opts.content ?? '跑一件事',
      agentMode: true,
      targets: [{ providerId: provider, model }]
    },
    emit,
    opts.asChild ? { asChild: true } : undefined
  )
  const traces = dbService
    .getHandle()
    .prepare(
      'SELECT step_index, step_type, status, error, model FROM agent_traces WHERE request_id = ? ORDER BY id ASC'
    )
    .all(requestId) as RunOut['traces']
  return { requestId, conversationId, done, error, traces }
}

/**
 * 备用表按用例改；每条用例起手清干净，别把上一台设的带进下一条。
 * 写成**函数**而不是模块级常量：provider 的 id 要 beforeAll 之后才有值，
 * 常量数组会在拿到 id 之前就求成 `['', 'm-…']`，于是"清除"变成空操作——
 * 表现是后面几条用例继承上一条的备用，看起来像引擎乱换台（第一次跑就是这么红的）。
 */
const knownPairs = (): Array<[string, string]> => [
  [badProvider, BAD_MODEL],
  [badProvider, FLAKY_MODEL],
  [badProvider, GOOD_IN_A_MODEL],
  [goodProvider, GOOD_MODEL],
  [bad2Provider, BAD2_MODEL]
]

beforeEach(() => {
  for (const [p, m] of knownPairs()) setFallbackTarget(p, m, null)
  setProviderEnabled(goodProvider, true)
})

/**
 * 直接改 enabled 列：测"禁用那台"只要一个 UPDATE，别绕去 save 那条按 (type,baseUrl) 去重的路。
 * 还要 `invalidate` —— manager 缓存着 adapter，前面某发已经把那台取出来过，
 * 不清缓存这条用例测的就不是"禁用"而是"缓存"（第一次跑就是这么假绿的）。
 */
function setProviderEnabled(id: string, enabled: boolean): void {
  dbService.getHandle().prepare('UPDATE providers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  providerManager.invalidate(id)
}

describe('① 换一次：真换到了那台，并且归因留在旧那台上', () => {
  it(
    '恒 500 的这台跑完三次重试 ⇒ 换备用、备用一发答完；失败那行 trace 仍挂着旧模型，答完那行是新模型',
    async () => {
      setFallbackTarget(badProvider, BAD_MODEL, { providerId: goodProvider, model: GOOD_MODEL })
      const out = await runOne()
      // 请求次数：旧那台 1＋2 次重试＝3 发，备用只 1 发（换**一次**，不是链）
      expect(countOf('/a', BAD_MODEL)).toBe(3)
      expect(countOf('/b')).toBe(1)
      expect(out.error, '这一轮该由备用答完，不该以失败收尾').toBeNull()
      expect(out.done?.fullContent).toBe('备用答上来的')

      const failed = out.traces.filter((r) => r.status === 'error')
      expect(failed, '失败那一步没留下 trace 行').toHaveLength(1)
      expect(failed[0]!.model, '失败那一行必须还挂在旧模型上').toBe(BAD_MODEL)
      expect(failed[0]!.error).toContain('fallback_swap')
      const llmRows = out.traces.filter((r) => r.step_type === 'final')
      expect(llmRows.at(-1)!.model, '答完那一行必须归到备用那台，不能还写着旧模型').toBe(GOOD_MODEL)

      // 说明句落在**旧那台**的那条 assistant 行上：那次失败确实属于它，不是新那台的正文
      const msgs = messageRepo.listByConversation(out.conversationId)
      const notice = msgs.find((m) => m.content.includes('已换到'))
      expect(notice, '库里没有那句"换到哪台"').toBeTruthy()
      expect(notice!.model).toBe(BAD_MODEL)
      expect(notice!.provider).toBe(badProvider)
      expect(notice!.status).toBe('done')
      expect(notice!.content).toContain(GOOD_MODEL)
      // 会话那行"最近使用"跟着实际作答的那台走：切走再回来不该还显示那台失败的
      expect(conversationRepo.get(out.conversationId)!.modelLabel).toBe(`agent:${goodProvider}:${GOOD_MODEL}`)
    },
    30_000
  )

  it('反向对照：没设备用 ⇒ 一发都不发给那台好的，并且照原样以失败收尾', async () => {
    const out = await runOne()
    expect(countOf('/a', BAD_MODEL)).toBe(3)
    expect(countOf('/b'), '没设备用却换台了').toBe(0)
    expect(out.error).toBeTruthy()
    expect(out.done, '失败了不许演成 DONE').toBeNull()
    expect(out.traces.every((r) => r.model === BAD_MODEL)).toBe(true)
    expect(messageRepo.listByConversation(out.conversationId).some((m) => m.content.includes('已换到'))).toBe(false)
    // 会话那行"最近使用"仍是原来那台：没换就不许改
    expect(conversationRepo.get(out.conversationId)!.modelLabel).toBe(`agent:${badProvider}:${BAD_MODEL}`)
  }, 30_000)

  it('备用设在**别的模型**上不影响这一发（表是按 provider＋模型取的，不是一台全局兜底）', async () => {
    setFallbackTarget(goodProvider, GOOD_MODEL, { providerId: bad2Provider, model: BAD2_MODEL })
    const out = await runOne()
    expect(countOf('/c'), '用了别的模型的备用').toBe(0)
    expect(out.error).toBeTruthy()
  }, 30_000)
})

describe('② 六种"不许换"：放宽很容易，这里逐条钉住', () => {
  it('400 这类不可重试的失败：一发就 break，换台修不好根因（也不许多等那 3 秒退避）', async () => {
    setFallbackTarget(badProvider, FLAKY_MODEL, { providerId: goodProvider, model: GOOD_MODEL })
    const out = await runOne({ model: FLAKY_MODEL })
    expect(countOf('/a', FLAKY_MODEL)).toBe(1)
    expect(countOf('/b'), '不可重试的错也换了台').toBe(0)
    expect(out.error).toBeTruthy()
    expect(out.traces.filter((r) => (r.error ?? '').includes('fallback_swap'))).toHaveLength(0)
  }, 30_000)

  it('子 run（委派出去的那一趟）不换：模型是角色归因的一部分，容量算术也按它算', async () => {
    setFallbackTarget(badProvider, BAD_MODEL, { providerId: goodProvider, model: GOOD_MODEL })
    const out = await runOne({ asChild: true })
    expect(countOf('/b'), '子 run 竟然换了台').toBe(0)
    expect(out.error).toBeTruthy()
  }, 30_000)

  it('备用那台被禁用 ⇒ 不换、也一发都不发给它（不许把一次可诊断的失败换成另一台上的陌生报错）', async () => {
    setFallbackTarget(badProvider, BAD_MODEL, { providerId: goodProvider, model: GOOD_MODEL })
    setProviderEnabled(goodProvider, false)
    const out = await runOne()
    expect(countOf('/b')).toBe(0)
    expect(out.error).toBeTruthy()
    expect(out.traces.filter((r) => (r.error ?? '').includes('fallback_swap'))).toHaveLength(0)
  }, 30_000)

  it('备用那台的模型清单里没那个名字（§151 那类清单漂移）⇒ 不换', async () => {
    setFallbackTarget(badProvider, BAD_MODEL, { providerId: goodProvider, model: 'm-gone-away' })
    const out = await runOne()
    expect(countOf('/b')).toBe(0)
    expect(out.error).toBeTruthy()
  }, 30_000)

  it('备用自己也 500 ⇒ **只换一次**：不会再换第三台，链不是本批要的形状', async () => {
    setFallbackTarget(badProvider, BAD_MODEL, { providerId: bad2Provider, model: BAD2_MODEL })
    setFallbackTarget(bad2Provider, BAD2_MODEL, { providerId: goodProvider, model: GOOD_MODEL })
    const out = await runOne()
    expect(countOf('/a', BAD_MODEL)).toBe(3)
    expect(countOf('/c', BAD2_MODEL)).toBe(3)
    expect(countOf('/b'), '换了两跳＝链').toBe(0)
    expect(out.error).toBeTruthy()
    expect(out.done).toBeNull()
  }, 60_000)

  it('备用指向自己：服务层就拒（换成自己等于没换，比"没有备用"更误导），库里也没多一条', () => {
    const r = setFallbackTarget(badProvider, BAD_MODEL, { providerId: badProvider, model: BAD_MODEL })
    expect(r.rejected).toBe('FALLBACK_IS_SELF')
    expect(r.targets[fallbackTargetKey(badProvider, BAD_MODEL)]).toBeUndefined()
    expect(Object.keys(r.targets)).toHaveLength(0)
  })
})

describe('③ 溢出提示：只把我们自己那把尺子量出来的那一档说上屏', () => {
  it('声明一个装不下的窗口 ⇒ DONE 带 historyTight（这句只在真的算得出来时才说）', async () => {
    const out = await runOne({ model: GOOD_IN_A_MODEL, tokens: 512 })
    expect(out.error, `这轮失败了：${out.error?.error}`).toBeNull()
    expect(out.done?.historyTight).toBe(true)
    // 反向对照在下一条：没声明窗口的同一台模型**不带**这个标记
  }, 30_000)

  it('同一台模型把声明清掉 ⇒ 不带这个标记（未声明就量不了，不猜一句给用户）', async () => {
    const out = await runOne({ model: GOOD_IN_A_MODEL, tokens: null })
    expect(out.done, `这轮失败了：${out.error?.error}`).not.toBeNull()
    expect(out.done!.historyTight).toBeUndefined()
  }, 30_000)
})
