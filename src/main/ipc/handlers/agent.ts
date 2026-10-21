// Work Agent IPC：中止 / 工作目录 / shell 与联网搜索与日历策略 / 工具审批应答 / 工具清单
import { BrowserWindow, dialog } from 'electron'
import { IPC } from '../../../shared/types'
import { chatService } from '../../chat/chat-service'
import { agentEngine } from '../../agent/engine'
import { toolRegistry } from '../../tools/registry'
import { getWorkspaceDir, setWorkspaceDir, restoreFileWrite } from '../../tools/fs-tools'
import { getShellConfig, setShellConfig } from '../../tools/shell-config'
import { getWebSearchConfig, setWebSearchConfig } from '../../tools/websearch-config'
import { getCalendarConfig, setCalendarConfig } from '../../tools/calendar-ics'
import { resolveApproval } from '../../agent/tool-approval'
import { agentTraceRepo } from '../../db/repositories/agent-trace.repo'
import { safeHandle, argsSchema } from '../safe-handle'
import { createLogger } from '../../logger'
import {
  shellConfigSchema,
  websearchConfigSchema,
  calendarConfigSchema,
  toolApproveResponseSchema,
  textProtocolToggleSchema,
  modelWindowSetSchema,
  interjectSchema,
  fallbackSetSchema,
  delegateProbeSchema,
  delegateToggleSchema
} from '../../../shared/schemas/agent'
import { listTextProtocolModels, setTextProtocolModel } from '../../agent/text-protocol-prefs'
import {
  listModelContextWindows,
  setModelContextWindow
} from '../../agent/model-window-prefs'
import { listFallbackTargets, setFallbackTarget } from '../../agent/fallback-target-prefs'
import { listDelegateCapabilitiesWithStaleness, probeDelegateCapability, setDelegationEnabled } from '../../agent/delegate-capability'
import { idSchema } from '../../../shared/schemas/providers'

const log = createLogger('agent')

export function registerAgentHandlers(): void {
  // ---------- 工具 ----------
  safeHandle(IPC.TOOL_LIST_AVAILABLE, () => toolRegistry.listAll())

  // ---------- Work Agent ----------
  // AGENT_* 事件通过 chat:send 的 emit 推送到对应 sender
  // 这里仅注册一个 abort 通道
  safeHandle(IPC.AGENT_ABORT, (_e, requestId: string) => {
    chatService.abort(requestId)
    return { ok: true }
  }, argsSchema(idSchema))

  // 运行中插队（V4-Iter-238）：把一句话交给正在跑的主干 run，由它在**步与步之间**收下。
  // 这不是 abort 的轻量版：两者互不相干，插队不会中止、也不会打断当前那一步。
  // 收不下（运行已结束／不是主干 run）就抛 RUN_NOT_FOUND，由 safeHandle 转成 {ok:false,error}——
  // 与上面「还原到写入前」同一条规矩：拒绝原因只在一处产出，这里不自己包 try/catch。
  // 渲染层接住它把消息退回队列等正常发送；这里不许"看起来成功"，否则用户那句话在两处都不存在。
  safeHandle(
    IPC.AGENT_INTERJECT,
    (_e, payload: { requestId: string; clientRef: string; text: string }) => {
      if (!agentEngine.interject(payload.requestId, payload.clientRef, payload.text)) {
        throw new Error('RUN_NOT_FOUND:这轮运行已经结束，消息会回到队列等自动发送')
      }
      return { ok: true as const }
    },
    argsSchema(interjectSchema)
  )

  // Agent 工作目录（fs_list/fs_read/fs_write 的安全边界）
  safeHandle(IPC.AGENT_GET_WORKSPACE_DIR, () => getWorkspaceDir())
  safeHandle(IPC.AGENT_PICK_WORKSPACE_DIR, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: '选择 Agent 工作目录 / Select Agent Workspace',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return getWorkspaceDir()
    setWorkspaceDir(result.filePaths[0]!)
    log.info('工作目录已设置:', result.filePaths[0])
    return getWorkspaceDir()
  })

  // 终端命令（shell_exec）策略配置
  safeHandle(IPC.AGENT_GET_SHELL_CONFIG, () => getShellConfig())
  safeHandle(
    IPC.AGENT_SET_SHELL_CONFIG,
    (_e, input: { enabled?: unknown; policy?: unknown }) => {
      // 字段白名单 + 值域校验（setShellConfig 内部还会再校验一次）
      const patch: { enabled?: boolean; policy?: 'confirm' | 'auto-safe' } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (input?.policy === 'confirm' || input?.policy === 'auto-safe') patch.policy = input.policy
      return setShellConfig(patch)
    },
    argsSchema(shellConfigSchema)
  )

  // 联网搜索配置（web.search 工具；Key 明文不出主进程，渲染端只拿 hasKey）
  safeHandle(IPC.AGENT_GET_WEBSEARCH_CONFIG, () => getWebSearchConfig())
  safeHandle(
    IPC.AGENT_SET_WEBSEARCH_CONFIG,
    (_e, input: { enabled?: unknown; provider?: unknown; apiKey?: unknown }) => {
      const patch: { enabled?: boolean; provider?: 'tavily' | 'bocha'; apiKey?: string } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (input?.provider === 'tavily' || input?.provider === 'bocha') patch.provider = input.provider
      if (typeof input?.apiKey === 'string') patch.apiKey = input.apiKey
      return setWebSearchConfig(patch)
    },
    argsSchema(websearchConfigSchema)
  )

  // 本地日历配置（calendar.read 工具）：启停 + .ics 路径列表
  safeHandle(IPC.AGENT_GET_CALENDAR_CONFIG, () => getCalendarConfig())
  safeHandle(
    IPC.AGENT_SET_CALENDAR_CONFIG,
    (_e, input: { enabled?: unknown; paths?: unknown }) => {
      const patch: { enabled?: boolean; paths?: string[] } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (Array.isArray(input?.paths)) {
        patch.paths = input.paths.filter((p): p is string => typeof p === 'string')
      }
      return setCalendarConfig(patch)
    },
    argsSchema(calendarConfigSchema)
  )
  // 文件选择对话框挑 .ics 文件（渲染端拿到路径后走 set-config 保存）
  safeHandle(IPC.AGENT_PICK_ICS_FILE, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { canceled: true }
    const result = await dialog.showOpenDialog(win, {
      title: '选择日历文件',
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })

  // 会话最近一次 Agent 运行的汇总统计（步数/耗时/token，来自 agent_traces 聚合）
  safeHandle(IPC.AGENT_GET_LATEST_RUN_STATS, (_e, conversationId: string) =>
    agentTraceRepo.latestStatsByConversation(conversationId),
  argsSchema(idSchema))

  // 会话最近一次 Agent 运行的分步明细（按 step_index 升序）
  safeHandle(IPC.AGENT_GET_LATEST_RUN_TRACES, (_e, conversationId: string) =>
    agentTraceRepo.latestTracesByConversation(conversationId),
  argsSchema(idSchema))

  // 会话级累计统计（跨该会话全部运行：运行次数/总耗时/总 token）
  safeHandle(IPC.AGENT_GET_SESSION_STATS, (_e, conversationId: string) =>
    agentTraceRepo.sessionStatsByConversation(conversationId),
  argsSchema(idSchema))

  // ---------- 模型级「走文本协议」显式开关（§4.4-⑦） ----------
  safeHandle(IPC.AGENT_GET_TEXT_PROTOCOL, () => listTextProtocolModels())
  safeHandle(
    IPC.AGENT_SET_TEXT_PROTOCOL,
    (_e, payload: { providerId: string; model: string; on: boolean }) =>
      setTextProtocolModel(payload.providerId, payload.model, payload.on),
    argsSchema(textProtocolToggleSchema)
  )

  // ---------- 每台模型可选的上下文窗口（V4-Iter-234）----------
  // 只存「这台模型能装多少」这一个输入；每轮带多少历史由引擎按它算，见 planHistoryWindow。
  safeHandle(IPC.AGENT_GET_MODEL_WINDOWS, () => listModelContextWindows())
  safeHandle(
    IPC.AGENT_SET_MODEL_WINDOW,
    (_e, payload: { providerId: string; model: string; tokens: number | null }) =>
      setModelContextWindow(payload.providerId, payload.model, payload.tokens),
    argsSchema(modelWindowSetSchema)
  )

  // ---------- 每台模型可选的「备用 target」（V4-Iter-237）----------
  // 只有一个输入：这台模型重试耗尽后换哪一台。**引擎只在主干 run 换一次**（见 engine.ts 那一处注释），
  // 服务层拒绝时同样只回码，句子由界面按语言拼（口径同上面那颗窗口开关）。
  safeHandle(IPC.AGENT_GET_FALLBACKS, () => listFallbackTargets())
  safeHandle(
    IPC.AGENT_SET_FALLBACK,
    (_e, payload: { providerId: string; model: string; target: { providerId: string; model: string } | null }) =>
      setFallbackTarget(payload.providerId, payload.model, payload.target),
    argsSchema(fallbackSetSchema)
  )

  // ---------- 委派能力探针（V4-Iter-142）----------
  // 清单只读；探测会发真请求（默认 3 发），所以只允许用户在设置页点名触发
  safeHandle(IPC.AGENT_LIST_DELEGATE_CAPS, () => listDelegateCapabilitiesWithStaleness())
  safeHandle(
    IPC.AGENT_PROBE_DELEGATE_CAP,
    (_e, payload: { providerId: string; model: string }) =>
      probeDelegateCapability(payload.providerId, payload.model),
    argsSchema(delegateProbeSchema)
  )
  // 决策③（2026-10-15 用户选定：一律不开、手动控制）：开/关某台模型的顺序委派。
  // 前置条件（判定必须是"可当管控者"且未过期、不得同时开着文本协议）只在主进程这一处判，
  // 渲染层拿到拒绝原因就照实说——不许界面先点亮开关再让引擎偷偷不认。
  safeHandle(
    IPC.AGENT_SET_DELEGATE_ENABLED,
    (_e, payload: { providerId: string; model: string; on: boolean }) =>
      setDelegationEnabled(payload.providerId, payload.model, payload.on),
    argsSchema(delegateToggleSchema)
  )

  // §231「还原到写入前」：一条写操作一次还原机会（快照用过即废）。
  // 拒绝原因全部从 restoreFileWrite 抛出，由 safeHandle 转成 {ok:false,error}——
  // 这里不自己包 try/catch：把错误咽掉就等于让"没还原"长得像"还原成功了"。
  safeHandle(
    IPC.AGENT_RESTORE_FILE_WRITE,
    (_e, snapshotId: string) => ({ ok: true as const, ...restoreFileWrite(snapshotId) }),
    argsSchema(idSchema)
  )

  // 渲染端对工具审批弹窗的应答
  safeHandle(
    IPC.AGENT_TOOL_APPROVE_RESPONSE,
    (_e, payload: { approvalId?: unknown; approved?: unknown; alwaysAllow?: unknown }) => {
      const approvalId = String(payload?.approvalId ?? '')
      const approved = payload?.approved === true
      const alwaysAllow = payload?.alwaysAllow === true
      const matched = resolveApproval(approvalId, approved, alwaysAllow)
      return { ok: matched }
    },
    argsSchema(toolApproveResponseSchema)
  )
}
