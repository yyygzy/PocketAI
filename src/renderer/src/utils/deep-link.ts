// 深链解析（P4 批次 0）：主窗口的 `?module=agent` / `#/...?module=agent` → 对话页 +
// 最近一条工具会话。
//
// 落在渲染入口这一层，而不是主进程：
//  · 主窗口的 URL 由 `main/index.ts` 的 loadURL/loadFile 决定，主进程只负责「装什么」，
//    没有 OS 协议或 second-instance 的深链来源；
//  · 分体窗口与浮窗本来就在 `main.tsx` 用 hash 分流，把主窗口这条也放在同一处，
//    三者的优先级一眼看得清（popup / detached 先命中，之后才是主窗口深链）。
//
// 判定口径（「最近一条工具会话」）：
//  · 候选 = `agent_mode = 1` 且未归档、非子会话（`listConversations` 默认排除子会话）；
//  · 排序 = `updatedAt` 降序（最近有活动），同刻再按 `createdAt` 降序；
//  · **不**沿用列表的置顶优先——深链要的是「最近用过的那一条」，把三个月前置顶的会话
//    顶到最前会让"最近"变成假话；
//  · 找不到候选 → 不写任何 pending，落到对话页的默认选中（上次会话/最近一条普通会话）。
import type { ConversationRecord } from '../../../shared/types'
import type { OpenConversationDetail } from './palette-nav'
import { hasIpcFailed } from './ipc'

export interface ModuleDeepLink {
  module: 'agent'
}

/**
 * 解析主窗口深链：同时认 query 与 hash 里的 query（`?module=agent` / `#/chat?module=agent`）。
 * 非法/未知模块一律返回 null（不抛、不猜：`module=foo` 就按普通启动走）。
 */
export function parseModuleDeepLink(search: string, hash: string): ModuleDeepLink | null {
  let module: string | null = null
  try {
    module = new URLSearchParams(search).get('module')
  } catch {
    module = null
  }
  if (!module && hash.includes('?')) {
    try {
      module = new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('module')
    } catch {
      module = null
    }
  }
  return module === 'agent' ? { module: 'agent' } : null
}

/**
 * 分体窗口路由：`#/detached?module=xxx`。
 * 模块在白名单里就按它开；不在（含参数缺失/非法/批次 2 摘掉 agent 之后）回退成对话窗口，
 * 而不是把「整窗主界面」塞进一个分体窗口（旧行为）。
 */
export function resolveDetachedModuleId(
  hash: string,
  allowed: readonly string[]
): string | null {
  if (!hash.startsWith('#/detached')) return null
  const m = new URLSearchParams(hash.split('?')[1] ?? '').get('module')
  if (m && allowed.includes(m)) return m
  return allowed.includes('chat') ? 'chat' : null
}

/** 最近一条工具会话（口径见文件头）；没有候选返回 null */
export function pickLatestToolConversation(list: ConversationRecord[]): ConversationRecord | null {
  let best: ConversationRecord | null = null
  for (const c of list) {
    if (!c.agentMode || c.archived) continue
    if (
      !best ||
      c.updatedAt > best.updatedAt ||
      (c.updatedAt === best.updatedAt && c.createdAt > best.createdAt)
    ) {
      best = c
    }
  }
  return best
}

/**
 * 把「最近一条工具会话」解析成一次导航目标。
 * `load` 由入口注入（生产是 `listConversations(undefined, true)`），失败/异常一律返回 null——
 * 深链是启动期的锦上添花，读不到就按普通启动落到对话页，绝不因为一发读失败而白屏。
 */
export async function resolveAgentDeepLinkTarget(
  load: () => Promise<unknown>
): Promise<OpenConversationDetail | null> {
  try {
    const list = await load()
    if (hasIpcFailed(list) || !Array.isArray(list)) return null
    const pick = pickLatestToolConversation(list as ConversationRecord[])
    if (!pick) return null
    return {
      conversationId: pick.id,
      assistantId: pick.assistantId ?? undefined,
      toolsEnabled: true
    }
  } catch {
    return null
  }
}

// 入口在渲染前解析好，App 在挂载后取走一次：此时对话壳的事件订阅已就位，
// 交给既有的 requestOpenConversation 走（切助手/开会话/消费 pending 全是现成路径）。
let bootTarget: OpenConversationDetail | null = null

export function setBootDeepLinkTarget(target: OpenConversationDetail): void {
  bootTarget = target
}

export function consumeBootDeepLinkTarget(): OpenConversationDetail | null {
  const target = bootTarget
  bootTarget = null
  return target
}
