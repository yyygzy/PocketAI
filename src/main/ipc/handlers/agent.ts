// Work Agent IPC：中止 / 工作目录 / shell 与联网搜索与日历策略 / 工具审批应答 / 工具清单
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { IPC } from '../../../shared/types'
import { chatService } from '../../chat/chat-service'
import { toolRegistry } from '../../tools/registry'
import { getWorkspaceDir, setWorkspaceDir } from '../../tools/fs-tools'
import { getShellConfig, setShellConfig } from '../../tools/shell-config'
import { getWebSearchConfig, setWebSearchConfig } from '../../tools/websearch-config'
import { getCalendarConfig, setCalendarConfig } from '../../tools/calendar-ics'
import { resolveApproval } from '../../agent/tool-approval'
import { createLogger } from '../../logger'

const log = createLogger('agent')

export function registerAgentHandlers(): void {
  // ---------- 工具 ----------
  ipcMain.handle(IPC.TOOL_LIST_AVAILABLE, () => toolRegistry.listAll())

  // ---------- Work Agent ----------
  // AGENT_* 事件通过 chat:send 的 emit 推送到对应 sender
  // 这里仅注册一个 abort 通道
  ipcMain.handle(IPC.AGENT_ABORT, (_e, requestId: string) => {
    chatService.abort(requestId)
    return { ok: true }
  })

  // Agent 工作目录（fs_list/fs_read/fs_write 的安全边界）
  ipcMain.handle(IPC.AGENT_GET_WORKSPACE_DIR, () => getWorkspaceDir())
  ipcMain.handle(IPC.AGENT_PICK_WORKSPACE_DIR, async (e) => {
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
  ipcMain.handle(IPC.AGENT_GET_SHELL_CONFIG, () => getShellConfig())
  ipcMain.handle(
    IPC.AGENT_SET_SHELL_CONFIG,
    (_e, input: { enabled?: unknown; policy?: unknown }) => {
      // 字段白名单 + 值域校验（setShellConfig 内部还会再校验一次）
      const patch: { enabled?: boolean; policy?: 'confirm' | 'auto-safe' } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (input?.policy === 'confirm' || input?.policy === 'auto-safe') patch.policy = input.policy
      return setShellConfig(patch)
    }
  )

  // 联网搜索配置（web.search 工具；Key 明文不出主进程，渲染端只拿 hasKey）
  ipcMain.handle(IPC.AGENT_GET_WEBSEARCH_CONFIG, () => getWebSearchConfig())
  ipcMain.handle(
    IPC.AGENT_SET_WEBSEARCH_CONFIG,
    (_e, input: { enabled?: unknown; provider?: unknown; apiKey?: unknown }) => {
      const patch: { enabled?: boolean; provider?: 'tavily' | 'bocha'; apiKey?: string } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (input?.provider === 'tavily' || input?.provider === 'bocha') patch.provider = input.provider
      if (typeof input?.apiKey === 'string') patch.apiKey = input.apiKey
      return setWebSearchConfig(patch)
    }
  )

  // 本地日历配置（calendar.read 工具）：启停 + .ics 路径列表
  ipcMain.handle(IPC.AGENT_GET_CALENDAR_CONFIG, () => getCalendarConfig())
  ipcMain.handle(
    IPC.AGENT_SET_CALENDAR_CONFIG,
    (_e, input: { enabled?: unknown; paths?: unknown }) => {
      const patch: { enabled?: boolean; paths?: string[] } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (Array.isArray(input?.paths)) {
        patch.paths = input.paths.filter((p): p is string => typeof p === 'string')
      }
      return setCalendarConfig(patch)
    }
  )
  // 文件选择对话框挑 .ics 文件（渲染端拿到路径后走 set-config 保存）
  ipcMain.handle(IPC.AGENT_PICK_ICS_FILE, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { canceled: true }
    const result = await dialog.showOpenDialog(win, {
      title: '选择日历文件',
      properties: ['openFile'],
      filters: [{ name: 'iCalendar', extensions: ['ics'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })

  // 渲染端对工具审批弹窗的应答
  ipcMain.handle(
    IPC.AGENT_TOOL_APPROVE_RESPONSE,
    (_e, payload: { approvalId?: unknown; approved?: unknown }) => {
      const approvalId = String(payload?.approvalId ?? '')
      const approved = payload?.approved === true
      const matched = resolveApproval(approvalId, approved)
      return { ok: matched }
    }
  )
}
