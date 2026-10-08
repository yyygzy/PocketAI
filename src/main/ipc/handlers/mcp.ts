// MCP Server IPC + Python 依赖环境（venv/pip）+ 便携 Python 运行时
import { dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import { IPC } from '../../../shared/types'
import type { McpServerRecord, PythonPipSource } from '../../../shared/types'
import { mcpServerRepo } from '../../db/repositories/mcp-server.repo'
import { mcpManager } from '../../mcp/manager'
import { pythonEnvService, getPipSource, setPipSource } from '../../mcp/python-env'
import { listPythonRuntimes, downloadPortablePython } from '../../python-runtime'
import { broadcast } from '../broadcast'
import { safeHandle, errMsg, argsSchema } from '../safe-handle'
import { mcpServerSaveSchema, pythonPipSourceSchema, mcpCallToolSchema } from '../../../shared/schemas/mcp'
import { idSchema } from '../../../shared/schemas/providers'
import { stringifyMcpResult, mcpResultIsError } from '../../tools/registry'
import { buildMcpExportPayload, REDACTED_KEYS_NOTE } from '../../../shared/mcp-export'
import { safeFileName } from '../../../shared/export-markdown'
import { maskSecretMap } from '../../../shared/secret-mask'
import type { McpServerRuntime } from '../../../shared/types'

// 凭据收口：env/headers 出 IPC 一律掩码（列表/表单/运行时状态都带完整 record）。
// 需要查看或编辑真实值时由用户显式走 MCP_SERVER_REVEAL_SECRETS；
// 保存时掩码占位按原值回填，见 mcp-server.repo.save。
function maskMcpRecord(r: McpServerRecord): McpServerRecord {
  return { ...r, env: maskSecretMap(r.env), headers: maskSecretMap(r.headers) }
}

function maskRuntime(rt: McpServerRuntime): McpServerRuntime {
  return { ...rt, env: maskSecretMap(rt.env), headers: maskSecretMap(rt.headers) }
}

export function registerMcpHandlers(): void {
  safeHandle(IPC.MCP_SERVER_LIST, () => mcpServerRepo.list().map(maskMcpRecord))

  // 导出全部配置为标准 mcpServers JSON：默认脱敏 env/headers 中的密钥（U 盘易丢场景）
  safeHandle(IPC.MCP_SERVER_EXPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false as const, error: '窗口不可用' }
    const records = mcpServerRepo.list()
    if (records.length === 0) return { ok: false as const, error: '没有可导出的 MCP 配置' }
    const payload = buildMcpExportPayload(records)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName('pocketai-mcp-servers')}.json`,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true as const, canceled: true as const }
    // 文件只写标准 mcpServers + 脱敏清单扩展键（redactedCount 等统计量不入文件）
    const file: Record<string, unknown> = { mcpServers: payload.mcpServers }
    if (payload.redactedEntries.length > 0) file[REDACTED_KEYS_NOTE] = payload.redactedEntries
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8')
    return {
      ok: true as const,
      path: filePath,
      count: records.length,
      redactedCount: payload.redactedCount
    }
  })

  safeHandle(IPC.MCP_SERVER_GET, (_e, id: string) => {
    const rec = mcpServerRepo.get(id)
    return rec ? maskMcpRecord(rec) : null
  }, argsSchema(idSchema))
  // 显式揭示真实 env/headers（编辑/复制场景按需调用，单条查询）
  safeHandle(IPC.MCP_SERVER_REVEAL_SECRETS, (_e, id: string) => {
    const rec = mcpServerRepo.get(id)
    if (!rec) return { ok: false as const, error: 'MCP Server 不存在' }
    return { ok: true as const, env: rec.env, headers: rec.headers }
  }, argsSchema(idSchema))
  safeHandle(IPC.MCP_SERVER_SAVE, (_e, record: Partial<McpServerRecord> & { name: string }) =>
    maskMcpRecord(mcpServerRepo.save(record)),
  argsSchema(mcpServerSaveSchema))
  safeHandle(IPC.MCP_SERVER_DELETE, async (_e, id: string) =>
    // 与安装整段（含前置 stop）共用 per-server 操作锁：安装/重装进行中删除一律拒绝，
    // 避免 pip 进程树占用 venv 造成孤儿目录或静默重建
    pythonEnvService.withServerOp(id, async () => {
      await mcpManager.stop(id)
      // 清理该 Server 的独立 venv 与工作目录；清理失败不阻断 DB 删除（条目没了环境即为孤儿，
      // 下次启动不会再引用），但把警告带回 UI 提示用户可手动删除目录
      let warning: string | undefined
      try {
        await pythonEnvService.removeServerEnv(id)
      } catch (e) {
        warning = `配置已删除，但虚拟环境目录清理失败：${errMsg(e)}`
      }
      mcpServerRepo.delete(id)
      return { ok: true as const, warning }
    }),
  argsSchema(idSchema))
  safeHandle(IPC.MCP_SERVER_START, async (_e, id: string) => ({
    ok: true as const,
    runtime: maskRuntime(await mcpManager.start(id))
  }), argsSchema(idSchema))
  safeHandle(IPC.MCP_SERVER_STOP, async (_e, id: string) => {
    await mcpManager.stop(id)
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.MCP_SERVER_RESTART, async (_e, id: string) => ({
    ok: true as const,
    runtime: maskRuntime(await mcpManager.restart(id))
  }), argsSchema(idSchema))
  safeHandle(IPC.MCP_SERVER_LIST_TOOLS, async (_e, id: string) => ({
    ok: true as const,
    tools: await mcpManager.listTools(id)
  }), argsSchema(idSchema))
  // 面板手动试运行：用户显式点击的调试动作，不走 assistant 权限链路。
  // argsJson 解析失败/非对象视为用户输入问题，返回结构化错误供行内展示；
  // callTool 抛错（未运行/传输失败）由 safeHandle 兜底转 { ok:false,error }。
  safeHandle(IPC.MCP_SERVER_CALL_TOOL, async (_e, args: { serverId: string; toolName: string; argsJson: string }) => {
    let parsed: unknown = {}
    const text = args.argsJson.trim()
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        return { ok: false as const, error: `参数 JSON 解析失败：${errMsg(e)}` }
      }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false as const, error: '参数必须是 JSON 对象' }
    }
    const raw = await mcpManager.callTool(args.serverId, args.toolName, parsed as Record<string, unknown>)
    // 复用 agent 链路同一套扁平化（含 256KB 截断），避免超大结果撑爆 IPC
    return { ok: true as const, content: stringifyMcpResult(raw), isError: mcpResultIsError(raw) }
  }, argsSchema(mcpCallToolSchema))
  safeHandle(IPC.MCP_SERVER_GET_RUNTIMES, () => mcpManager.listRuntimes().map(maskRuntime))

  // ---------- Python MCP 依赖环境（venv / pip） ----------
  // 安装：仅显式按钮触发；过程经 PYTHON_ENV_EVENT 广播推送，最终状态在 invoke 返回
  safeHandle(IPC.PYTHON_ENV_INSTALL, async (_e, serverId: string) =>
    // 整段（含前置 stop）持 per-server 操作锁，与删除互斥；并发操作立即失败而非排队
    pythonEnvService.withServerOp(serverId, async () => {
      const record = mcpServerRepo.get(serverId)
      if (!record) return { ok: false as const, error: 'MCP Server 不存在或已被删除' }
      // 重装会重写/删除 venv，运行中的进程会锁住其中的文件（Windows EBUSY）：先停再装，
      // 安装完成后用户需自行重新启动（UI 状态会反映 stopped）。
      await mcpManager.stop(serverId)
      const state = await pythonEnvService.installForServer(record)
      return { ok: true as const, state }
    }),
  argsSchema(idSchema))
  safeHandle(IPC.PYTHON_ENV_STATUS, async (_e, serverId: string) => {
    // 整体包 try/catch：存量脏数据（如历史保存的非法包行）不应炸成未处理 rejection，
    // 向 UI 返回结构化错误，由表单行内展示
    try {
      const record = mcpServerRepo.get(serverId)
      if (!record) return { ok: false as const, error: 'MCP Server 不存在或已被删除' }
      // 必须 await：getEnvState 是 async（要探测解释器版本），嵌套 Promise 无法被 IPC 结构化克隆
      const state = await pythonEnvService.getEnvState(record)
      return {
        ok: true as const,
        state,
        recentEvents: pythonEnvService.recentEvents(serverId)
      }
    } catch (e) {
      return { ok: false as const, error: `环境状态读取失败：${errMsg(e)}` }
    }
  }, argsSchema(idSchema))
  safeHandle(IPC.PYTHON_PIP_SOURCE_GET, () => ({ ok: true, source: getPipSource() }))
  safeHandle(IPC.PYTHON_PIP_SOURCE_SET, (_e, source: PythonPipSource) => {
    setPipSource(source)
    return { ok: true as const, source: getPipSource() }
  }, argsSchema(pythonPipSourceSchema))

  // Python 运行时
  safeHandle(IPC.PYTHON_RUNTIME_LIST, () => listPythonRuntimes())
  safeHandle(IPC.PYTHON_RUNTIME_DOWNLOAD, async () => downloadPortablePython())

  // MCP 状态变化 / 日志事件 → 广播给所有窗口
  mcpManager.onStatus((evt) => broadcast(IPC.MCP_SERVER_STATUS_EVENT, evt))
  mcpManager.onLog((evt) => broadcast(IPC.MCP_SERVER_LOG_EVENT, evt))
  // Python 依赖安装（venv/pip 实时输出）→ 广播；渲染端按 serverId 自行过滤
  pythonEnvService.onInstall((evt) => broadcast(IPC.PYTHON_ENV_EVENT, evt))
}
