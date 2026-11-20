// MCP Server IPC + Python 依赖环境（venv/pip）+ 便携 Python 运行时
import fs from 'node:fs'
import { dialog, BrowserWindow } from 'electron'
import { IPC } from '../../../shared/types'
import type { McpServerRecord, PythonPipSource } from '../../../shared/types'
import { mcpServerRepo } from '../../db/repositories/mcp-server.repo'
import { mcpCallLogRepo } from '../../db/repositories/mcp-call-log.repo'
import { createLogger } from '../../logger'
import { mcpManager } from '../../mcp/manager'
import { getMcpSitePolicy, saveMcpSitePolicy } from '../../mcp/outbound-policy'
import { pythonEnvService, getPipSource, setPipSource } from '../../mcp/python-env'
import { listPythonRuntimes, downloadPortablePython } from '../../python-runtime'
import { broadcast } from '../broadcast'
import { safeHandle, errMsg, argsSchema, z } from '../safe-handle'
import { writeFileAtomicSync } from '../../files/atomic-write'
import {
  mcpServerSaveSchema,
  pythonPipSourceSchema,
  mcpCallToolSchema,
  mcpCallLogServerIdSchema,
  mcpCallLogLimitSchema,
  mcpSitePolicySchema
} from '../../../shared/schemas/mcp'
import { idSchema } from '../../../shared/schemas/providers'
import { stringifyMcpResult, mcpResultIsError } from '../../tools/registry'
import { buildMcpExportPayload } from '../../../shared/mcp-export'
import { buildMcpPackageFile, MCP_MAX_IMPORT_BYTES } from '../../mcp/mcp-package'
import { importMcpPackageText } from '../../mcp/mcp-import-service'
import { safeFileName } from '../../../shared/export-markdown'
import { maskSecretMap } from '../../../shared/secret-mask'
import type { McpServerRuntime } from '../../../shared/types'

const log = createLogger('mcp')

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

  // 站点级出网约束（全局一条，存 app_config）：只管 MCP HTTP 传输能不能连某个 host。
  // 不参与工具授权（那是逐工具 confirm / trustReadOnly 的事），也不另造域名清单。
  safeHandle(IPC.MCP_SITE_POLICY_GET, () => getMcpSitePolicy())
  safeHandle(
    IPC.MCP_SITE_POLICY_SET,
    (_e, policy: unknown) => saveMcpSitePolicy(policy),
    argsSchema(mcpSitePolicySchema)
  )

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
    // 标准 mcpServers + 包级 sha256 + 脱敏清单扩展键（统计量不入文件）
    const file = buildMcpPackageFile(payload.mcpServers, payload.redactedEntries)
    writeFileAtomicSync(filePath, JSON.stringify(file, null, 2))
    return {
      ok: true as const,
      path: filePath,
      count: records.length,
      redactedCount: payload.redactedCount
    }
  })

  // 导入 MCP 配置包：校验和一致才落库；同名并存；凭据一律清空（口径见 mcp-import-service）
  safeHandle(IPC.MCP_SERVER_IMPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false as const, error: '窗口不可用' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'MCP 配置（JSON）', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return { ok: true as const, canceled: true as const }

    const file = filePaths[0]!
    if (fs.statSync(file).size > MCP_MAX_IMPORT_BYTES) {
      return { ok: false as const, error: 'FILE_TOO_LARGE' }
    }
    return importMcpPackageText(fs.readFileSync(file, 'utf8'))
  })

  // 粘贴导入：没有文件包 ⇒ 校验和按 absent；解析、同名并存、凭据清空与文件通道走同一条路径
  safeHandle(IPC.MCP_SERVER_IMPORT_TEXT, async (_e, text: string) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false as const, error: 'IMPORT_EMPTY' }
    return importMcpPackageText(text, { verifyChecksum: false })
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
      // §314：删除要的是 forget（停＋把运行时 entry 摘掉），不是只 stop——
      // 只 stop 的话那条 entry 会带着已解密的 env/headers 与输出缓冲活到进程退出，
      // 而垂死子进程后到的日志还会推给一个界面上已经不存在的 serverId
      await mcpManager.forget(id)
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
  // 显式启动成功 ⇒ 记住「这个连接器是启用过的」，应用重启时据此自动恢复（v77）。
  // 自动重启/内部 restart 不经过这里，不会把用户已停用的连接器重新标成启用。
  safeHandle(IPC.MCP_SERVER_START, async (_e, id: string) => {
    const runtime = await mcpManager.start(id)
    mcpServerRepo.setAutoConnect(id, true)
    return { ok: true as const, runtime: maskRuntime(runtime) }
  }, argsSchema(idSchema))
  // 显式停止 ⇒ 取消自动恢复（用户看到的是「关掉了」，重启后不应该又自己连上）
  safeHandle(IPC.MCP_SERVER_STOP, async (_e, id: string) => {
    await mcpManager.stop(id)
    mcpServerRepo.setAutoConnect(id, false)
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.MCP_SERVER_RESTART, async (_e, id: string) => {
    const runtime = await mcpManager.restart(id)
    mcpServerRepo.setAutoConnect(id, true)
    return { ok: true as const, runtime: maskRuntime(runtime) }
  }, argsSchema(idSchema))
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
    const raw = await mcpManager.callTool(
      args.serverId,
      args.toolName,
      parsed as Record<string, unknown>,
      'manual'
    )
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

  // 调用记录查询/清空（跨重启可查；serverId 省略或 null = 全部）
  safeHandle(
    IPC.MCP_CALL_LOG_LIST,
    (_e, serverId?: string | null, limit?: number | null) => ({
      ok: true as const,
      logs: mcpCallLogRepo.list(serverId ?? null, limit ?? undefined)
    }),
    argsSchema(mcpCallLogServerIdSchema, mcpCallLogLimitSchema)
  )
  safeHandle(
    IPC.MCP_CALL_LOG_CLEAR,
    (_e, serverId?: string | null) => ({ ok: true as const, removed: mcpCallLogRepo.clear(serverId ?? null) }),
    argsSchema(mcpCallLogServerIdSchema)
  )

  // ---------- 连接器目录 ----------
  // 默认只返回本地内置清单；远程索引仅在用户显式刷新时拉取，且逐条过安全闸门。
  // 目录服务按需加载：它依赖 app_config，不应让只测删除/启动桥接的单测被迫起整条 DB 链
  safeHandle(IPC.MCP_CATALOG_LIST, async () => {
    const { listMcpCatalog } = await import('../../mcp/catalog')
    return listMcpCatalog()
  })
  safeHandle(
    IPC.MCP_CATALOG_REFRESH,
    async (_e, url?: string | null) => {
      const { refreshMcpCatalog } = await import('../../mcp/catalog')
      return { ok: true as const, catalog: await refreshMcpCatalog(url) }
    },
    argsSchema(z.string().max(2048).nullish())
  )
  safeHandle(IPC.MCP_CATALOG_RESET, async () => {
    const { resetMcpCatalog } = await import('../../mcp/catalog')
    return { ok: true as const, catalog: resetMcpCatalog() }
  })

  // Python 运行时
  safeHandle(IPC.PYTHON_RUNTIME_LIST, () => listPythonRuntimes())
  safeHandle(IPC.PYTHON_RUNTIME_DOWNLOAD, async () => downloadPortablePython())

  // 工具调用记录落库：写失败（锁屏关库等）只 warn，绝不影响调用本身
  mcpManager.onCall((evt) => {
    try {
      mcpCallLogRepo.append(evt)
    } catch (e) {
      log.warn(`MCP 调用记录写入失败: ${errMsg(e)}`)
    }
  })

  // MCP 状态变化 / 日志事件 → 广播给所有窗口
  mcpManager.onStatus((evt) => broadcast(IPC.MCP_SERVER_STATUS_EVENT, evt))
  mcpManager.onLog((evt) => broadcast(IPC.MCP_SERVER_LOG_EVENT, evt))
  // Python 依赖安装（venv/pip 实时输出）→ 广播；渲染端按 serverId 自行过滤
  pythonEnvService.onInstall((evt) => broadcast(IPC.PYTHON_ENV_EVENT, evt))
}
