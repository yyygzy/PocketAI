// channel-service 编排层测试
//
// 覆盖 src/main/channels/channel-service.ts 核心路径：
// - loadConvMap / saveConvMap：KV 中会话映射的读取与持久化（null/非法 JSON/数组/合法对象）
// - ChannelService 公开方法：onStatus 监听器增删、init 注册各网关状态回调、
//   autoStart 跳过 disabled 网关并吞启动错误、start 校验 enabled、stop 转发
// - handleMessage 路由：sanitizeIncoming 复查 → 白名单 fail-closed → busyChats 串行锁
// - processMessage 分支：模型未配置走助手默认 → 会话映射复用/重建 → runChat 结果分流
// - runChat 事件收集器：AGENT_DONE / CHAT_DONE / AGENT_ERROR / CHAT_ERROR 与
//   chatService.send reject 的统一收口；chunk/step 事件忽略
//
// 策略（参考 diagnose.test.ts / merge-service.test.ts）：
// - vi.hoisted 集中 mocks 状态对象，每用例 beforeEach(() => mocks.reset()) 后注入场景
// - 5 个 gateway 模块各自 mock 为同一份 stub IGateway（onStatus/start/stop/sendText/isRunning）
// - start() 时捕获 onMessage 回调，测试用其驱动私有 handleMessage → processMessage → runChat
// - chatService.send 同样捕获 emit 回调，可手动注入各类 IPC 事件验证 runChat 收集器
// - dbService/appConfigRepo 用 KV Map 实现，让真实 channel-config 的 convMapKey/prefixFor 跑通
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC, CHANNEL_TYPES } from '../src/shared/types'
import type {
  ChannelType,
  ChannelStatusEvent,
  ConversationRecord,
  AssistantRecord
} from '../src/shared/types'
import type { IncomingMessage } from '../src/main/channels/gateway-base'

// ---------- mock 工厂 ----------

const mocks = vi.hoisted(() => {
  // appConfigRepo KV 后端（按 channel.tg_* / channel.feishu_* 等 key 存原始字符串）
  const kv = new Map<string, string>()
  // gateway stub 状态：onMessage 回调、状态监听器、sendText 调用记录、isRunning 标记
  const gatewayStub = {
    onMessageCb: null as ((msg: IncomingMessage) => void | Promise<void>) | null,
    listeners: new Set<(evt: ChannelStatusEvent) => void>(),
    start: vi.fn<(cb: (msg: IncomingMessage) => void | Promise<void>) => Promise<void>>(),
    stop: vi.fn<() => void>(),
    sendText: vi.fn<(targetId: string, text: string) => Promise<void>>().mockResolvedValue(undefined),
    isRunning: vi.fn<() => boolean>().mockReturnValue(false),
    onStatus: vi.fn<(l: (evt: ChannelStatusEvent) => void) => () => void>(),
    type: 'telegram' as ChannelType
  }
  // chatService.send 状态：onSend 用例注入回调（同步调用 emit 触发 runChat 收集器，或抛错走 reject 路径）
  const chatSend = {
    calls: [] as unknown[],
    onSend: null as
      | ((payload: unknown, emit: (channel: string, data: unknown) => void) => void | Promise<void>)
      | null
  }
  // assistant / conversation repo
  const assistantDb = new Map<string, AssistantRecord>()
  const conversationDb = new Map<string, ConversationRecord>()
  const conversationRepo = {
    get: vi.fn<(id: string) => ConversationRecord | null>(),
    create: vi.fn<(input: { assistantId?: string | null; title?: string; modelLabel?: string }) => ConversationRecord>(),
    touch: vi.fn<(id: string, patch: { modelLabel?: string; status?: string }) => void>(),
    rename: vi.fn<(id: string, title: string) => void>()
  }
  const assistantRepo = {
    get: vi.fn<(id: string) => AssistantRecord | null>()
  }
  // 可控 sanitizeIncoming：默认走真实逻辑（用 import 的真函数注入），用例可改写返回 null
  let sanitizeIncomingImpl: ((raw: { chatId?: unknown; userId?: unknown; text?: unknown; firstName?: unknown }) => IncomingMessage | null) = () => null

  return {
    kv,
    gatewayStub,
    chatSend,
    assistantDb,
    conversationDb,
    conversationRepo,
    assistantRepo,
    convSeq: 0,
    sanitizeIncomingImpl,
    reset() {
      kv.clear()
      this.gatewayStub.onMessageCb = null
      this.gatewayStub.listeners.clear()
      this.gatewayStub.start.mockReset()
      this.gatewayStub.stop.mockReset()
      this.gatewayStub.sendText.mockReset().mockResolvedValue(undefined)
      this.gatewayStub.isRunning.mockReset().mockReturnValue(false)
      this.gatewayStub.onStatus.mockReset().mockImplementation((l) => {
        this.gatewayStub.listeners.add(l)
        return () => this.gatewayStub.listeners.delete(l)
      })
      this.gatewayStub.start.mockImplementation(async (cb) => {
        this.gatewayStub.onMessageCb = cb
      })
      this.chatSend.calls = []
      this.chatSend.onSend = null
      this.assistantDb.clear()
      this.conversationDb.clear()
      this.convSeq = 0
      this.conversationRepo.get.mockReset().mockImplementation((id) => this.conversationDb.get(id) ?? null)
      this.conversationRepo.create.mockReset().mockImplementation((input) => {
        const id = `conv-${++this.convSeq}`
        const rec: ConversationRecord = {
          id,
          assistantId: input.assistantId ?? null,
          title: input.title ?? '新对话',
          modelLabel: input.modelLabel ?? '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'done'
        }
        this.conversationDb.set(id, rec)
        return rec
      })
      this.conversationRepo.touch.mockReset()
      this.conversationRepo.rename.mockReset()
      this.assistantRepo.get.mockReset().mockImplementation((id) => this.assistantDb.get(id) ?? null)
      // 默认 sanitizeIncoming 走「合法收口」分支：原样返回
      this.sanitizeIncomingImpl = (raw) => {
        const chatId = typeof raw.chatId === 'string' ? raw.chatId : null
        const userId = typeof raw.userId === 'string' ? raw.userId : null
        if (!chatId || !userId) return null
        if (typeof raw.text !== 'string' || !raw.text.trim()) return null
        return {
          chatId,
          userId,
          text: raw.text.trim(),
          firstName: typeof raw.firstName === 'string' ? raw.firstName : ''
        }
      }
    }
  }
})

// gateway-base 提供 sanitizeIncoming stub（其他导出由真实模块满足；类型已擦除）
vi.mock('../src/main/channels/gateway-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/channels/gateway-base')>()
  return {
    ...actual,
    sanitizeIncoming: (raw: { chatId?: unknown; userId?: unknown; text?: unknown; firstName?: unknown }) =>
      mocks.sanitizeIncomingImpl(raw)
  }
})

// 5 个 gateway 模块全部返回同一份 stub IGateway
vi.mock('../src/main/channels/telegram-gateway', () => ({ telegramGateway: mocks.gatewayStub }))
vi.mock('../src/main/channels/discord-gateway', () => ({ discordGateway: mocks.gatewayStub }))
vi.mock('../src/main/channels/slack-gateway', () => ({ slackGateway: mocks.gatewayStub }))
vi.mock('../src/main/channels/feishu-gateway', () => ({ feishuGateway: mocks.gatewayStub }))
vi.mock('../src/main/channels/dingtalk-gateway', () => ({ dingtalkGateway: mocks.gatewayStub }))

// chatService.send 捕获 payload 并把 emit 交给用例注入的 onSend 回调
vi.mock('../src/main/chat/chat-service', () => ({
  chatService: {
    send: async (payload: unknown, emit: (channel: string, data: unknown) => void): Promise<void> => {
      mocks.chatSend.calls.push(payload)
      const impl = mocks.chatSend.onSend
      if (impl) await impl(payload, emit)
    }
  }
}))

// assistantRepo / conversationRepo / appConfigRepo / secret-store / logger 全部 stub
vi.mock('../src/main/db/repositories/assistant.repo', () => ({ assistantRepo: mocks.assistantRepo }))
vi.mock('../src/main/db/repositories/conversation.repo', () => ({ conversationRepo: mocks.conversationRepo }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => mocks.kv.get(key) ?? null,
    set: (key: string, val: string) => { mocks.kv.set(key, val) }
  }
}))
vi.mock('../src/main/crypto/secret-store', () => ({
  getSecret: () => '',
  setSecret: () => {},
  hasSecret: () => false,
  SECRET_KV_KEYS: {}
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  })
}))

import { ChannelService, loadConvMap, saveConvMap } from '../src/main/channels/channel-service'
import { convMapKey } from '../src/main/channels/channel-config'

// ---------- 测试用助手 ----------

/** 按 channel-config 字段约定写入 KV（type → 前缀由真实 prefixFor 决定） */
function setChannelKv(type: ChannelType, fields: Record<string, string>): void {
  const prefix = type === 'telegram' ? 'channel.tg_' : `channel.${type}_`
  for (const [k, v] of Object.entries(fields)) mocks.kv.set(`${prefix}${k}`, v)
}

/** 启动指定 type 网关并取回 start() 注入的 onMessage 回调 */
async function startAndCapture(svc: ChannelService, type: ChannelType): Promise<(msg: IncomingMessage) => Promise<void>> {
  await svc.start(type)
  const cb = mocks.gatewayStub.onMessageCb
  if (!cb) throw new Error('gateway.start 未捕获 onMessage 回调')
  return cb as (msg: IncomingMessage) => Promise<void>
}

/** 等待 microtask 队列排空（runChat 的 chatService.send 回调链需要它落地） */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

// ---------- loadConvMap / saveConvMap ----------

describe('loadConvMap / saveConvMap — KV 会话映射收口', () => {
  beforeEach(() => mocks.reset())

  it('KV 为 null → 返回空对象', () => {
    expect(loadConvMap('telegram')).toEqual({})
  })

  it('KV 为合法对象 JSON → 原样返回', () => {
    mocks.kv.set(convMapKey('feishu'), '{"chat1":"conv-a"}')
    expect(loadConvMap('feishu')).toEqual({ chat1: 'conv-a' })
  })

  it('KV 为非法 JSON → 返回空对象（吞错）', () => {
    mocks.kv.set(convMapKey('dingtalk'), '{bad json')
    expect(loadConvMap('dingtalk')).toEqual({})
  })

  it('KV 为数组 → 返回空对象（拒绝非对象）', () => {
    mocks.kv.set(convMapKey('slack'), '[1,2,3]')
    expect(loadConvMap('slack')).toEqual({})
  })

  it('KV 为 null 字面量字符串 → 返回空对象', () => {
    mocks.kv.set(convMapKey('telegram'), 'null')
    expect(loadConvMap('telegram')).toEqual({})
  })

  it('saveConvMap 写入 JSON.stringify 结果', () => {
    saveConvMap('telegram', { chat1: 'conv-x', chat2: 'conv-y' })
    expect(mocks.kv.get(convMapKey('telegram'))).toBe('{"chat1":"conv-x","chat2":"conv-y"}')
  })

  it('saveConvMap 覆盖旧值', () => {
    saveConvMap('telegram', { a: '1' })
    saveConvMap('telegram', { b: '2' })
    expect(loadConvMap('telegram')).toEqual({ b: '2' })
  })
})

// ---------- 公开方法 ----------

describe('ChannelService 公开方法', () => {
  let svc: ChannelService

  beforeEach(() => {
    mocks.reset()
    svc = new ChannelService()
  })

  it('onStatus 返回取消订阅函数；监听器增删正确', () => {
    const seen: ChannelStatusEvent[] = []
    const off = svc.onStatus((e) => seen.push(e))
    // 触发各 gateway 状态广播（init 后 gateway.onStatus 注册到 service.emitStatus）
    svc.init()
    const listener = [...mocks.gatewayStub.listeners][0]!
    listener({ type: 'telegram', status: 'running', lastError: null })
    listener({ type: 'telegram', status: 'error', lastError: 'oops' })
    expect(seen).toHaveLength(2)
    off()
    listener({ type: 'telegram', status: 'stopped', lastError: null })
    expect(seen).toHaveLength(2) // 取消后不再接收
  })

  it('init 给所有 CHANNEL_TYPES 的 gateway 都注册 onStatus 回调', () => {
    svc.init()
    // CHANNEL_TYPES = telegram / feishu / dingtalk / slack / discord（5 个）
    // 由于 5 个 gateway 模块都 mock 为同一份 stub，onStatus 仅注册 5 次（但 stub.listeners 去重）
    expect(mocks.gatewayStub.onStatus).toHaveBeenCalledTimes(CHANNEL_TYPES.length)
  })

  it('start 网关未启用 → 抛错', async () => {
    setChannelKv('telegram', { enabled: '0' })
    await expect(svc.start('telegram')).rejects.toThrow(/未启用/)
  })

  it('start 网关已启用 → 调用 gateway.start 并注入 onMessage 回调', async () => {
    setChannelKv('telegram', { enabled: '1' })
    const cb = await startAndCapture(svc, 'telegram')
    expect(typeof cb).toBe('function')
    expect(mocks.gatewayStub.start).toHaveBeenCalledTimes(1)
  })

  it('stop 转发到 gateway.stop', () => {
    svc.stop('discord')
    expect(mocks.gatewayStub.stop).toHaveBeenCalledTimes(1)
  })

  it('autoStart 跳过 disabled 网关并启动 enabled 网关', async () => {
    setChannelKv('telegram', { enabled: '0' })
    setChannelKv('feishu', { enabled: '1' })
    setChannelKv('dingtalk', { enabled: '1' })
    setChannelKv('slack', { enabled: '0' })
    setChannelKv('discord', { enabled: '0' })
    await svc.autoStart()
    // 仅 feishu / dingtalk 启动（stub 共用，故 start 调用次数 = 2）
    expect(mocks.gatewayStub.start).toHaveBeenCalledTimes(2)
  })

  it('autoStart 吞掉单个网关启动错误，继续后续网关', async () => {
    setChannelKv('telegram', { enabled: '1' })
    setChannelKv('feishu', { enabled: '1' })
    // 第一次（telegram）抛错，第二次（feishu）正常
    let calls = 0
    mocks.gatewayStub.start.mockImplementation(async () => {
      calls++
      if (calls === 1) throw new Error('启动失败')
    })
    await svc.autoStart()
    expect(mocks.gatewayStub.start).toHaveBeenCalledTimes(2)
  })

  it('autoStart 全部 disabled → 不调用任何 start', async () => {
    for (const t of CHANNEL_TYPES) setChannelKv(t, { enabled: '0' })
    await svc.autoStart()
    expect(mocks.gatewayStub.start).not.toHaveBeenCalled()
  })
})

// ---------- handleMessage 路由 ----------

describe('handleMessage 路由（白名单 / 串行锁 / 收口复查）', () => {
  let svc: ChannelService
  let onMessage: (msg: IncomingMessage) => Promise<void>

  beforeEach(async () => {
    mocks.reset()
    svc = new ChannelService()
    // 默认 telegram 启用、白名单含 u1、模型已配置
    setChannelKv('telegram', {
      enabled: '1',
      whitelist: 'u1,u2',
      provider_id: 'openai',
      model: 'gpt-4'
    })
    onMessage = await startAndCapture(svc, 'telegram')
  })

  it('sanitizeIncoming 返回 null → 丢弃，不进入白名单/不调用 sendText', async () => {
    mocks.sanitizeIncomingImpl = () => null
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'hi', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).not.toHaveBeenCalled()
    expect(mocks.chatSend.calls).toHaveLength(0)
  })

  it('白名单为空 → fail-closed，静默丢弃', async () => {
    setChannelKv('telegram', { whitelist: '' })
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'hi', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).not.toHaveBeenCalled()
    expect(mocks.chatSend.calls).toHaveLength(0)
  })

  it('userId 不在白名单 → 静默丢弃', async () => {
    await onMessage({ chatId: 'c1', userId: 'stranger', text: 'hi', firstName: 'X' })
    expect(mocks.gatewayStub.sendText).not.toHaveBeenCalled()
    expect(mocks.chatSend.calls).toHaveLength(0)
  })

  it('同一 busyKey 已在处理 → 提示「正在处理上一条」', async () => {
    // onSend 不调 emit → runChat 挂起 → busyChats 保持占用
    mocks.chatSend.onSend = () => {}
    void onMessage({ chatId: 'c1', userId: 'u1', text: 'one', firstName: 'A' })
    await flush()
    // 第二条进来时 busyKey 还被占
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'two', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith('c1', expect.stringContaining('正在处理上一条'))
  })

  it('正常路径走完 → busyChats 在 finally 清理（下一条不会触发 busy 提示）', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'one-reply' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'one', firstName: 'A' })
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'two-reply' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'two', firstName: 'A' })
    // 第二条不应触发「正在处理」提示（busyChats 已清理）
    expect(mocks.gatewayStub.sendText).not.toHaveBeenCalledWith('c1', expect.stringContaining('正在处理上一条'))
  })

  it('处理过程中抛错 → busyChats 仍在 finally 清理', async () => {
    mocks.chatSend.onSend = () => {
      throw new Error('boom')
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'one', firstName: 'A' })
    // busyChats 应已清理；下一条不应再触发 busy 提示
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'two-reply' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'two', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).not.toHaveBeenCalledWith('c1', expect.stringContaining('正在处理上一条'))
  })
})

// ---------- processMessage 分支 ----------

describe('processMessage 分支（模型配置 / 会话映射 / 结果分流）', () => {
  let svc: ChannelService
  let onMessage: (msg: IncomingMessage) => Promise<void>

  beforeEach(async () => {
    mocks.reset()
    svc = new ChannelService()
    setChannelKv('telegram', {
      enabled: '1',
      whitelist: 'u1',
      provider_id: 'openai',
      model: 'gpt-4'
    })
    onMessage = await startAndCapture(svc, 'telegram')
  })

  it('providerId / model 均未配置 → 提示「尚未配置目标模型」', async () => {
    setChannelKv('telegram', { provider_id: '', model: '' })
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'hi', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('尚未配置目标模型')
    )
  })

  it('cfg.providerId 空但助手有 defaultProviderId/defaultModel → 走助手默认', async () => {
    setChannelKv('telegram', {
      enabled: '1',
      whitelist: 'u1',
      provider_id: '',
      model: '',
      assistant_id: 'asst-1'
    })
    mocks.assistantDb.set('asst-1', {
      id: 'asst-1',
      name: 'A',
      description: '',
      avatar: '',
      systemPrompt: '',
      knowledgeBaseIds: [],
      skillIds: [],
      defaultProviderId: 'anthropic',
      defaultModel: 'claude',
      defaultParams: null,
      toolPermissions: [],
      welcomeMessage: '',
      isBuiltin: false,
      isPinned: false,
      createdAt: 0
    })
    // 让 send 立即 done 并带内容
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'ok' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'hi', firstName: 'A' })
    // 第二条调用应使用助手默认模型（payload.targets 由 chatService.send 捕获）
    const payload = mocks.chatSend.calls[0] as { targets: { providerId: string; model: string }[] }
    expect(payload.targets[0]!.providerId).toBe('anthropic')
    expect(payload.targets[0]!.model).toBe('claude')
  })

  it('会话映射缺失 → 创建新会话并写回 KV', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'reply' })
    }
    await onMessage({ chatId: 'chatX', userId: 'u1', text: 'hi', firstName: 'Alice' })
    // 写回的 KV 应是 { "chatX": "conv-1" }
    expect(loadConvMap('telegram')).toEqual({ chatX: 'conv-1' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith('chatX', 'reply')
  })

  it('会话映射存在且 conv 仍存在 → 复用旧 conversationId', async () => {
    mocks.kv.set(convMapKey('telegram'), '{"chatX":"conv-old"}')
    mocks.conversationDb.set('conv-old', {
      id: 'conv-old',
      assistantId: null,
      title: '旧',
      modelLabel: '',
      createdAt: 1,
      updatedAt: 1,
      status: 'done'
    })
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'r' })
    }
    await onMessage({ chatId: 'chatX', userId: 'u1', text: 'hi', firstName: 'A' })
    const payload = mocks.chatSend.calls[0] as { conversationId: string }
    expect(payload.conversationId).toBe('conv-old')
    // 不应再创建新会话
    expect(mocks.conversationRepo.create).not.toHaveBeenCalled()
  })

  it('会话映射存在但 conv 已删 → 重建并覆盖 KV', async () => {
    mocks.kv.set(convMapKey('telegram'), '{"chatX":"conv-stale"}')
    // conversationDb 没有 conv-stale → conversationRepo.get 返回 null
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'r' })
    }
    await onMessage({ chatId: 'chatX', userId: 'u1', text: 'hi', firstName: 'A' })
    expect(mocks.conversationRepo.create).toHaveBeenCalledTimes(1)
    // KV 应被新 id 覆盖
    expect(loadConvMap('telegram')).toEqual({ chatX: 'conv-1' })
  })

  it('结果 ok 且 content 非空 → 发送 content', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'hello world' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith('c1', 'hello world')
  })

  it('结果 ok 但 content 仅空白 → 发送「处理失败：无回复内容」', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: '   ' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('处理失败：无回复内容')
    )
  })

  it('结果 ok 但 content 缺省 → 发送「处理失败：无回复内容」', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: undefined })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('处理失败：无回复内容')
    )
  })

  it('结果 !ok → 发送「处理失败：error」', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_ERROR_EVENT, { error: 'rate limit' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('处理失败：rate limit')
    )
  })
})

// ---------- runChat 事件收集器 ----------

describe('runChat 事件收集器（IM 场景聚合后回复）', () => {
  let svc: ChannelService
  let onMessage: (msg: IncomingMessage) => Promise<void>

  beforeEach(async () => {
    mocks.reset()
    svc = new ChannelService()
    setChannelKv('telegram', {
      enabled: '1',
      whitelist: 'u1',
      provider_id: 'openai',
      model: 'gpt-4'
    })
    onMessage = await startAndCapture(svc, 'telegram')
  })

  it('CHAT_DONE_EVENT → ok + content', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'done-content' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith('c1', 'done-content')
  })

  it('AGENT_DONE_EVENT → ok + content（agentMode 路径）', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.AGENT_DONE_EVENT, { fullContent: 'agent-content' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith('c1', 'agent-content')
  })

  it('CHAT_ERROR_EVENT → !ok + error', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_ERROR_EVENT, { error: '模型超时' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('处理失败：模型超时')
    )
  })

  it('AGENT_ERROR_EVENT → !ok + error', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.AGENT_ERROR_EVENT, { error: 'tool denied' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('处理失败：tool denied')
    )
  })

  it('chunk / step 事件被忽略，不 settle；后续 done 事件仍可正常 settle', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_CHUNK_EVENT, { delta: 'partial' })
      emit(IPC.AGENT_DONE_EVENT, { fullContent: 'final' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    // 只有最终 done 的 content 被发送
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith('c1', 'final')
    expect(mocks.gatewayStub.sendText).not.toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('partial')
    )
  })

  it('chatService.send reject → errMsg 包装为 处理失败', async () => {
    mocks.chatSend.onSend = () => {
      throw new Error('网络断了')
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('处理失败：网络断了')
    )
  })

  it('chatService.send reject 非 Error 实例 → errMsg 用 String 兜底', async () => {
    mocks.chatSend.onSend = () => {
      throw 'string error' // eslint-disable-line no-throw-non-error
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    expect(mocks.gatewayStub.sendText).toHaveBeenCalledWith(
      'c1',
      expect.stringContaining('处理失败：')
    )
  })

  it('unattended=true 写入 payload（IM 通道无人值守语义）', async () => {
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.CHAT_DONE_EVENT, { fullContent: 'r' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    const payload = mocks.chatSend.calls[0] as { unattended: boolean }
    expect(payload.unattended).toBe(true)
  })

  it('agentMode 由 cfg.agentMode 决定', async () => {
    setChannelKv('telegram', { agent_mode: '1' })
    mocks.chatSend.onSend = (_p, emit) => {
      emit(IPC.AGENT_DONE_EVENT, { fullContent: 'r' })
    }
    await onMessage({ chatId: 'c1', userId: 'u1', text: 'q', firstName: 'A' })
    const payload = mocks.chatSend.calls[0] as { agentMode: boolean }
    expect(payload.agentMode).toBe(true)
  })
})
