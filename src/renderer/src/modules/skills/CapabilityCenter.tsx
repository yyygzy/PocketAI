// 能力中心（P1-1）：技能市场的升级形态。
//
// 聚合四类、按类型分组不混排：已装技能 / 在线技能 / MCP 已配置服务器 / MCP 模板。
// - 打开本面板**不联网**；在线技能只在用户主动搜关键词或点「联网加载」时才拉 registry。
// - MCP 的「已授权 N 个助手」只来自 getToolPolicy(assistantId) 的返回；渲染端不写权限名单/阈值。
// - MCP 不展示 `enabled`（manager.start() 不读它，画出来就是假状态）；运行与否只看 runtime.status。
// - 第二段的接线：技能就地绑定（saveAssistant 并集写入）、MCP 先启动后授权（授权仍走 AssistantEditor）。
//   四种失败各自独立 inline：绑定失败 / 启动失败（附运行时日志）/ 未暴露工具 / 无自定义助手。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssistantRecord,
  McpServerRecord,
  McpServerRuntime,
  ProviderRecord,
  SkillRecord,
  ToolPolicyEntry,
  ToolPolicySnapshot,
  ToolPolicyState
} from '../../../../shared/types'
import { instantiateMcpTemplate, listMcpTemplates, type McpTemplate } from '../../../../shared/mcp-templates'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { useConfirm } from '../../components/ConfirmDialog'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { assistantDisplayName } from '../chat/assistant-display'
import { AssistantEditor } from '../chat/AssistantEditor'
import { formatMcpLaunch, mcpSecretKeyHint } from '../agent/mcp/mcp-launch'
import {
  buildCapabilityGroups,
  filterCapabilityGroups,
  mcpEntriesOfServer,
  type CapabilityGroupKey,
  type InstalledSkillItem,
  type McpCapabilityState,
  type McpServerItem,
  type McpTemplateItem,
  type OnlineSkill,
  type OnlineSkillItem,
  type SkillCapabilityState
} from './capability-model'

interface Props {
  onClose: () => void
  /** 技能写操作后交回最新清单（与技能页共享一次读；不传则自己重读） */
  onChanged?: () => Promise<SkillRecord[]>
}

/** 默认 registry（与技能市场同一份自建索引） */
const DEFAULT_REGISTRY =
  'https://raw.githubusercontent.com/yygygzy/skill-registry/main/index.json'

type View =
  | { kind: 'installedSkill'; id: string }
  | { kind: 'onlineSkill'; id: string }
  | { kind: 'mcpServer'; id: string }
  | { kind: 'mcpTemplate'; id: string }

export const CapabilityCenter: React.FC<Props> = ({ onClose, onChanged }) => {
  const { t } = useI18n()
  const toast = useToast()
  const { confirm, dialog } = useConfirm()

  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [skillsUnread, setSkillsUnread] = useState<{ error?: string } | null>(null)
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  const [assistantsUnread, setAssistantsUnread] = useState<{ error?: string } | null>(null)
  const [servers, setServers] = useState<McpServerRecord[]>([])
  const [serversUnread, setServersUnread] = useState<{ error?: string } | null>(null)
  const [runtimes, setRuntimes] = useState<McpServerRuntime[]>([])
  const [runtimeUnread, setRuntimeUnread] = useState<{ error?: string } | null>(null)
  /** 每个助手的 policySnapshot（含 granted）；null＝整份没读到 */
  const [snapshots, setSnapshots] = useState<ToolPolicySnapshot[] | null>(null)
  /** 注册表全量视角（工具清单；不含 granted） */
  const [registrySnapshot, setRegistrySnapshot] = useState<ToolPolicySnapshot | null>(null)
  const [policyUnread, setPolicyUnread] = useState<{ error?: string } | null>(null)

  const [onlineSkills, setOnlineSkills] = useState<OnlineSkill[] | null>(null)
  const [onlineLoading, setOnlineLoading] = useState(false)
  const [onlineError, setOnlineError] = useState<string | null>(null)
  const onlineSeqRef = useRef(0)
  /** MCP 清单/授权快照的代次：状态广播会叠着触发重读，只让最后发起那次写屏 */
  const mcpSeqRef = useRef(0)
  const policySeqRef = useRef(0)

  const [keyword, setKeyword] = useState('')
  const [view, setView] = useState<View | null>(null)
  const [urlInput, setUrlInput] = useState('')

  // ---------- 第二段接线状态 ----------
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  /** 打开的助手编辑器；focusMcp=从「去授权」进来，只滚到 MCP 工具组 */
  const [editor, setEditor] = useState<{ initial: Partial<AssistantRecord>; focusMcp: boolean } | null>(null)
  const [bindingSkillId, setBindingSkillId] = useState<string | null>(null)
  /** 绑定失败：按技能 id 记录，失败时不清空已勾/已绑列表（本地 assistants 原样保留） */
  const [bindError, setBindError] = useState<{ skillId: string; msg: string } | null>(null)
  const [startBusyId, setStartBusyId] = useState<string | null>(null)
  const [startError, setStartError] = useState<{ serverId: string; msg: string } | null>(null)
  const [stopBusyId, setStopBusyId] = useState<string | null>(null)
  /** 停止失败：只写 inline，**不动**运行态（失败时服务器仍是上一次读到的状态） */
  const [stopError, setStopError] = useState<{ serverId: string; msg: string } | null>(null)
  const [logsOpenId, setLogsOpenId] = useState<string | null>(null)
  /** serverId → 最近 200 行运行时日志（与 McpPanel 同一个广播源） */
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [tplValues, setTplValues] = useState<Record<string, Record<string, string>>>({})
  const [tplBusyId, setTplBusyId] = useState<string | null>(null)
  const [tplError, setTplError] = useState<{ templateId: string; msg: string } | null>(null)

  const templates = useMemo(() => listMcpTemplates(), [])

  // ---------- 读 ----------
  const loadSkills = useCallback(() => {
    window.pocketai
      .listSkills()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setSkillsUnread({ error: v.error })
          return
        }
        setSkillsUnread(null)
        setSkills(v)
      })
      .catch((e: unknown) => {
        setSkillsUnread({ error: errText(e, '') })
        logIpcError('skills.list', e)
      })
  }, [])

  const loadAssistants = useCallback(() => {
    window.pocketai
      .listAssistants()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setAssistantsUnread({ error: v.error })
          return
        }
        setAssistantsUnread(null)
        setAssistants(v)
      })
      .catch((e: unknown) => {
        setAssistantsUnread({ error: errText(e, '') })
        logIpcError('assistants.list', e)
      })
  }, [])

  const loadMcp = useCallback(() => {
    const seq = ++mcpSeqRef.current
    void Promise.all([window.pocketai.listMcpServers(), window.pocketai.getMcpRuntimes()])
      .then(([recs, runs]) => {
        if (seq !== mcpSeqRef.current) return
        if (hasIpcFailed(recs) || !Array.isArray(recs)) {
          setServersUnread({ error: hasIpcFailed(recs) ? recs.error : undefined })
        } else {
          setServersUnread(null)
          setServers(recs)
        }
        if (hasIpcFailed(runs) || !Array.isArray(runs)) {
          setRuntimeUnread({ error: hasIpcFailed(runs) ? runs.error : undefined })
        } else {
          setRuntimeUnread(null)
          setRuntimes(runs)
        }
      })
      .catch((e: unknown) => {
        if (seq !== mcpSeqRef.current) return
        const msg = errText(e, '')
        setServersUnread({ error: msg })
        setRuntimeUnread({ error: msg })
        logIpcError('mcp.list', e)
      })
  }, [])

  /**
   * 授权摘要：只调现有 getToolPolicy。先取注册表全量（工具清单），再逐个助手的视角（granted）。
   * 任一发失败就整份按「不知道」处理——用半份快照数出来的人数会变成假事实。
   */
  const loadPolicy = useCallback((list: AssistantRecord[]) => {
    const seq = ++policySeqRef.current
    void Promise.all([
      window.pocketai.getToolPolicy(),
      ...list.map((a) => window.pocketai.getToolPolicy(a.id))
    ])
      .then((all) => {
        if (seq !== policySeqRef.current) return
        const registry = all[0]
        if (hasIpcFailed(registry)) {
          setRegistrySnapshot(null)
          setSnapshots(null)
          setPolicyUnread({ error: registry.error })
          return
        }
        const perAssistant = all.slice(1)
        const failed = perAssistant.find((s) => hasIpcFailed(s))
        if (failed && hasIpcFailed(failed)) {
          setRegistrySnapshot(null)
          setSnapshots(null)
          setPolicyUnread({ error: failed.error })
          return
        }
        setPolicyUnread(null)
        setRegistrySnapshot(registry)
        setSnapshots(perAssistant as ToolPolicySnapshot[])
      })
      .catch((e: unknown) => {
        if (seq !== policySeqRef.current) return
        setRegistrySnapshot(null)
        setSnapshots(null)
        setPolicyUnread({ error: errText(e, '') })
        logIpcError('toolPolicy.get', e)
      })
  }, [])

  useEffect(() => {
    loadSkills()
    loadAssistants()
    loadMcp()
    window.pocketai
      .listProviders()
      .then((v) => {
        if (hasIpcFailed(v)) return
        setProviders(v)
      })
      .catch((e: unknown) => logIpcError('providers.list', e))
  }, [loadSkills, loadAssistants, loadMcp])

  /**
   * 面板打开期间的 MCP 启停（本面板点启动、或别处控制台启停）都跟随主进程状态广播刷新：
   * 状态事件只带 serverId/status/tools，没有整条 record，因此统一重读运行态与授权快照。
   */
  useEffect(() => {
    return window.pocketai.onMcpStatus(() => {
      loadMcp()
      loadPolicy(assistants)
    })
  }, [assistants, loadMcp, loadPolicy])

  // MCP 运行时日志：与高级控制台同一个广播源，只为「查看日志」留最近 200 行
  useEffect(() => {
    return window.pocketai.onMcpLog((evt) => {
      const line = `[${evt.stream}] ${evt.line}`
      setLogs((prev) => {
        const next = [...(prev[evt.serverId] ?? []), line].slice(-200)
        return { ...prev, [evt.serverId]: next }
      })
    })
  }, [])

  // 助手清单回来（或刷新）后，授权数才读得到
  useEffect(() => {
    loadPolicy(assistants)
  }, [assistants, loadPolicy])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 编辑器浮层在上面时，Escape 只关它——否则一次按键会把整个能力中心一起收掉
      if (editor) {
        setEditor(null)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, onClose])

  /** 在线清单：只在用户主动触发时联网（首段搜索、或点联网加载/刷新） */
  const loadOnline = useCallback(async () => {
    const seq = ++onlineSeqRef.current
    setOnlineLoading(true)
    setOnlineError(null)
    try {
      const res = await window.pocketai.fetchSkillIndex(DEFAULT_REGISTRY)
      if (seq !== onlineSeqRef.current) return
      setOnlineLoading(false)
      if (res.ok && res.skills) {
        setOnlineSkills(res.skills)
      } else {
        setOnlineSkills(null)
        setOnlineError(res.error ?? t('cap.online.failed'))
      }
    } catch (e) {
      if (seq !== onlineSeqRef.current) return
      setOnlineLoading(false)
      setOnlineSkills(null)
      setOnlineError(errText(e, t('cap.online.failed')))
      logIpcError('skills.fetchIndex', e)
    }
  }, [t])

  useEffect(() => {
    // 打开面板不联网；用户开始搜索（关键词非空）且还没加载过，才拉一次。
    if (keyword.trim() && onlineSkills === null && !onlineLoading && !onlineError) void loadOnline()
  }, [keyword, onlineSkills, onlineLoading, onlineError, loadOnline])

  // ---------- 状态派生 ----------
  const templateDescriptions = useMemo(() => {
    const out: Record<string, string> = {}
    for (const tpl of templates) out[tpl.id] = templateDescText(tpl.id, t)
    return out
  }, [templates, t])

  const groups = useMemo(
    () =>
      buildCapabilityGroups({
        skills,
        assistants,
        onlineSkills: onlineSkills ?? [],
        servers,
        runtimes,
        templates,
        templateDescriptions,
        snapshots
      }),
    [skills, assistants, onlineSkills, servers, runtimes, templates, templateDescriptions, snapshots]
  )

  const filtered = useMemo(() => filterCapabilityGroups(groups, keyword), [groups, keyword])

  // ---------- 标签（字面量表，避免新增动态 t() 调用点） ----------
  const skillStateLabels = {
    disabled: () => t('cap.state.skill.disabled'),
    'enabled-unbound': () => t('cap.state.skill.enabledUnbound'),
    bound: (n: number) => t('cap.state.skill.bound', { n })
  } satisfies Record<SkillCapabilityState, (n: number) => string>

  const mcpStateLabels = {
    stopped: () => t('cap.state.mcp.stopped'),
    starting: () => t('cap.state.mcp.starting'),
    error: () => t('cap.state.mcp.error'),
    running: () => t('cap.state.mcp.running')
  } satisfies Record<McpCapabilityState, () => string>

  const groupTitles = {
    installedSkills: t('cap.group.installedSkills'),
    onlineSkills: t('cap.group.onlineSkills'),
    mcpServers: t('cap.group.mcpServers'),
    mcpTemplates: t('cap.group.mcpTemplates')
  } satisfies Record<CapabilityGroupKey, string>

  // ---------- 技能写操作 ----------
  const refreshSkills = useCallback(async () => {
    if (onChanged) {
      setSkills(await onChanged())
      return
    }
    loadSkills()
  }, [onChanged, loadSkills])

  const handleToggle = useCallback(
    async (s: SkillRecord) => {
      const r = await window.pocketai.saveSkill({ id: s.id, name: s.name, enabled: !s.enabled })
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('common.unknownError')))
        return
      }
      await refreshSkills()
    },
    [refreshSkills, t, toast]
  )

  const handleDuplicate = useCallback(
    async (s: SkillRecord) => {
      const copy = await window.pocketai.saveSkill({
        name: `${s.name} ${t('skill.market.copySuffix')}`,
        description: s.description,
        icon: s.icon,
        content: s.content,
        enabled: true
      })
      if (hasIpcFailed(copy)) {
        toast.error(ipcFailText(copy, t('common.unknownError')))
        return
      }
      await refreshSkills()
      setView({ kind: 'installedSkill', id: copy.id })
      toast.success(t('skill.market.duplicated'))
    },
    [refreshSkills, t, toast]
  )

  const handleExport = useCallback(
    async (s: SkillRecord) => {
      const r = await window.pocketai.exportSkill(s.id)
      if (r.ok && !r.canceled) toast.success(t('skill.market.exportDone'))
      else if (!r.ok) toast.error(r.error ?? t('skill.market.exportFailed'))
    },
    [t, toast]
  )

  const importErrorText = (code: string | undefined): string => {
    switch (code) {
      case 'NOT_SKILL_FILE':
        return t('skill.market.notSkillFile')
      case 'FILE_TOO_LARGE':
        return t('skill.market.fileTooLarge')
      case 'PARSE_FAILED':
        return t('skill.market.parseFailed')
      case 'MISSING_FIELDS':
        return t('skill.market.missingFields')
      default:
        return t('skill.market.importFailed')
    }
  }

  const folderErrorText = (code: string | undefined): string => {
    switch (code) {
      case 'NO_SKILL_MD':
        return t('skill.market.noSkillMd')
      case 'NOT_A_DIRECTORY':
        return t('skill.market.notADirectory')
      case 'ENTRY_TOO_LARGE':
        return t('skill.market.entryTooLarge')
      case 'SKILL_ROW_RESIDUE':
        return t('skill.market.rowResidue')
      default:
        return t('skill.market.importFailed')
    }
  }

  const handleImport = useCallback(async () => {
    const r = await window.pocketai.importSkill()
    if (!r.ok) {
      toast.error(importErrorText(r.error))
      return
    }
    if (r.canceled) return
    if (r.skill) {
      await refreshSkills()
      setView({ kind: 'installedSkill', id: r.skill.id })
      toast.success(r.nameDuplicated ? t('skill.market.importedDupName') : t('skill.market.importDone'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSkills, t, toast])

  const handleImportFolder = useCallback(async () => {
    const r = await window.pocketai.importSkillFolder()
    if (!r.ok) {
      toast.error(folderErrorText(r.error))
      return
    }
    if (r.canceled) return
    if (r.skill) {
      await refreshSkills()
      setView({ kind: 'installedSkill', id: r.skill.id })
      const notes: string[] = [
        r.forcedOnDemand ? t('skill.market.forcedOnDemand') : '',
        (r.ignoredKeys ?? []).length > 0
          ? t('skill.market.ignoredKeys', { keys: r.ignoredKeys!.join('、') })
          : '',
        (r.skipped ?? []).length > 0 ? t('skill.market.skippedFiles', { n: r.skipped!.length }) : ''
      ].filter(Boolean)
      toast.success([t('skill.market.importFolderDone'), ...notes].filter(Boolean).join(' '))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSkills, t, toast])

  const handleDelete = useCallback(
    async (s: SkillRecord) => {
      if (!(await confirm({ message: t('skill.deleteConfirm', { name: s.name }), danger: true }))) return
      const r = await window.pocketai.deleteSkill(s.id)
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('common.unknownError')))
        return
      }
      await refreshSkills()
      setView(null)
    },
    [confirm, refreshSkills, t, toast]
  )

  const handleImportRemote = useCallback(
    async (s: OnlineSkill) => {
      const r = await window.pocketai.importSkillFromUrl(s.url)
      if (r.ok && r.skill) {
        await refreshSkills()
        toast.success(t('skill.market.importDone'))
      } else {
        toast.error(r.error ?? t('skill.market.importFailed'))
      }
    },
    [refreshSkills, t, toast]
  )

  const handleImportFromUrl = useCallback(async () => {
    const url = urlInput.trim()
    if (!url) {
      toast.error(t('skill.market.urlEmpty'))
      return
    }
    const r = await window.pocketai.importSkillFromUrl(url)
    if (r.ok && r.skill) {
      await refreshSkills()
      toast.success(t('skill.market.importDone'))
      setUrlInput('')
    } else {
      toast.error(r.error ?? t('skill.market.importFailed'))
    }
  }, [urlInput, refreshSkills, t, toast])

  // ---------- 第二段：绑定 / 启动 / 授权 ----------
  const reloadAssistants = useCallback(async () => {
    const v = await window.pocketai.listAssistants()
    if (hasIpcFailed(v)) {
      setAssistantsUnread({ error: v.error })
      return
    }
    setAssistantsUnread(null)
    setAssistants(v)
  }, [])

  /**
   * 技能就地绑定：把技能 id 并进 assistant.skillIds（Set 去重），整条记录回写。
   * 失败只写 inline，不动本地 assistants——用户刚看到的已绑定列表不会被清空。
   */
  const handleBind = useCallback(
    async (skill: SkillRecord, assistant: AssistantRecord) => {
      setBindingSkillId(skill.id)
      setBindError(null)
      try {
        const prev = assistant.skillIds ?? []
        const saved = await window.pocketai.saveAssistant({
          ...assistant,
          skillIds: [...new Set([...prev, skill.id])]
        })
        if (hasIpcFailed(saved)) {
          setBindError({
            skillId: skill.id,
            msg: t('skill.market.bindFailed', { msg: ipcFailText(saved, t('common.unknownError')) })
          })
          return
        }
        setAssistants((cur) => cur.map((a) => (a.id === saved.id ? saved : a)))
        toast.success(t('skill.market.bindDone', { name: assistantDisplayName(saved, t) }))
      } catch (e) {
        setBindError({
          skillId: skill.id,
          msg: t('skill.market.bindFailed', { msg: errText(e, t('common.unknownError')) })
        })
      } finally {
        setBindingSkillId(null)
      }
    },
    [t, toast]
  )

  const handleCopyBuiltin = useCallback(async () => {
    const builtin = assistants.find((a) => a.isBuiltin)
    if (!builtin) return
    try {
      const copy = await window.pocketai.duplicateAssistant(builtin.id)
      if (hasIpcFailed(copy)) {
        toast.error(ipcFailText(copy, t('common.unknownError')))
        return
      }
      await reloadAssistants()
      toast.success(t('cap.assistantCopied', { name: assistantDisplayName(copy, t) }))
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
    }
  }, [assistants, reloadAssistants, t, toast])

  const toggleLogs = (serverId: string) =>
    setLogsOpenId((cur) => (cur === serverId ? null : serverId))

  /** 启动 MCP：先确认会执行的命令与要带出去的凭据；成功且暴露工具后才出现「去授权」 */
  const handleStartServer = useCallback(
    async (server: McpServerRecord) => {
      const cmd = formatMcpLaunch(server)
      const keys = mcpSecretKeyHint(server)
      const message = keys
        ? `${t('agent.startConfirm', { cmd })}\n\n${t('agent.startConfirmSecrets', { keys })}`
        : t('agent.startConfirm', { cmd })
      if (!(await confirm({ title: t('cap.mcp.startTitle'), message, danger: true }))) return
      setStartBusyId(server.id)
      setStartError(null)
      try {
        const r = await window.pocketai.startMcpServer(server.id)
        if (!r.ok) {
          // 失败原因优先取运行时 lastError（与高级控制台同一份事实），拿不到再退回 IPC 报错
          let lastError: string | undefined
          try {
            const runs = await window.pocketai.getMcpRuntimes()
            if (Array.isArray(runs)) {
              setRuntimes(runs)
              lastError = runs.find((x) => x.id === server.id)?.lastError ?? undefined
            }
          } catch (e) {
            logIpcError('mcp.runtimesAfterStartFail', e)
          }
          setStartError({
            serverId: server.id,
            msg: lastError || r.error || t('common.unknownError')
          })
          return
        }
        if (r.runtime) {
          setRuntimes((cur) => [...cur.filter((x) => x.id !== r.runtime!.id), r.runtime!])
        }
        // 工具清单与授权数都来自快照，启动成功后重读一次（这就是「局部刷新该条」）
        loadPolicy(assistants)
      } catch (e) {
        setStartError({
          serverId: server.id,
          msg: errText(e, t('common.unknownError'))
        })
      } finally {
        setStartBusyId(null)
      }
    },
    [assistants, confirm, loadPolicy, t]
  )

  /**
   * 停止 MCP：复用现有 stopMcpServer 通道（不新造 IPC），成功也不弹提示——
   * 屏上状态 chip 与工具/授权区的消失本身就是反馈。
   * 成功时立即把该条从 runtimes 里摘掉（缺条目＝stopped，`deriveMcpCapabilityState` 的口径），
   * 工具清单与授权数都随 `running` 条件一起退场，不会留着上一次的快照装成还在跑。
   * 失败只写 inline：运行态一个字都不改。
   */
  const handleStopServer = useCallback(
    async (server: McpServerRecord) => {
      setStopBusyId(server.id)
      setStopError(null)
      try {
        const r = await window.pocketai.stopMcpServer(server.id)
        if (hasIpcFailed(r)) {
          setStopError({
            serverId: server.id,
            msg: ipcFailText(r, t('common.unknownError'))
          })
          return
        }
        setRuntimes((cur) => cur.filter((x) => x.id !== server.id))
        // 启动失败那一行属于上一轮；已经停下来了就不该再把旧原因挂在启动区
        setStartError((cur) => (cur?.serverId === server.id ? null : cur))
        loadPolicy(assistants)
      } catch (e) {
        setStopError({
          serverId: server.id,
          msg: errText(e, t('common.unknownError'))
        })
      } finally {
        setStopBusyId(null)
      }
    },
    [assistants, loadPolicy, t]
  )

  /** 模板创建：校验占位符 → instantiate → saveMcpServer；成功后留在当前详情，可继续启动 */
  const handleCreateTemplate = useCallback(
    async (template: McpTemplate) => {
      setTplError(null)
      for (const p of template.placeholders ?? []) {
        if (!String(tplValues[template.id]?.[p.key] ?? '').trim()) {
          setTplError({ templateId: template.id, msg: t('cap.tpl.missing', { label: placeholderLabelText(p.label, t) }) })
          return
        }
      }
      const inst = instantiateMcpTemplate(template, tplValues[template.id] ?? {})
      if (inst.error || !inst.draft) {
        const key = inst.error?.startsWith('missing:') ? inst.error.slice(8) : ''
        const ph = template.placeholders?.find((p) => p.key === key)
        setTplError({
          templateId: template.id,
          msg: ph
            ? t('cap.tpl.missing', { label: placeholderLabelText(ph.label, t) })
            : t('cap.tpl.createFail', { msg: inst.error ?? t('common.unknownError') })
        })
        return
      }
      setTplBusyId(template.id)
      try {
        const saved = await window.pocketai.saveMcpServer({
          name: inst.draft.name,
          transport: inst.draft.transport,
          runtime: inst.draft.runtime,
          command: inst.draft.command,
          args: inst.draft.args,
          env: inst.draft.env,
          url: inst.draft.url,
          headers: inst.draft.headers,
          enabled: inst.draft.enabled,
          pythonPackages: inst.draft.pythonPackages
        })
        if ('ok' in saved) {
          setTplError({ templateId: template.id, msg: t('cap.tpl.createFail', { msg: saved.error }) })
          return
        }
        setServers((cur) => [...cur.filter((s) => s.id !== saved.id), saved])
        toast.success(t('cap.tpl.created', { name: saved.name }))
      } catch (e) {
        setTplError({ templateId: template.id, msg: t('cap.tpl.createFail', { msg: errText(e, t('common.unknownError')) }) })
      } finally {
        setTplBusyId(null)
      }
    },
    [t, tplValues, toast]
  )

  // ---------- 渲染 ----------
  const chip =
    'text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)] shrink-0'
  const readyChip =
    'text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)] shrink-0'

  const current = view ? findItem(view, groups) : null

  const cardShell =
    'text-left rounded-xl border border-[var(--color-border)] p-3 hover:border-[var(--color-accent)] hover:shadow-sm transition-all bg-[var(--color-bg)]'

  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--color-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[86vh] flex flex-col rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="shrink-0 flex items-center gap-3 px-5 h-14 border-b border-[var(--color-border)]">
          {view && (
            <button
              onClick={() => setView(null)}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg"
              title={t('common.back')}
            >
              ←
            </button>
          )}
          <h2 className="font-semibold shrink-0">{t('cap.title')}</h2>
          {!view && (
            /* `.input` 自带 width:100%，且它写在 @tailwind utilities 之后（未分层）会盖掉 w-72；
               把定宽放在外层，输入框的 100% 就只相对这个 288px 容器生效，不再把右侧按钮挤扁。 */
            <div className="w-72 min-w-[160px]" data-testid="capability-search-wrap">
              <input
                className="input text-xs py-1"
                placeholder={t('cap.searchPh')}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                data-testid="capability-search"
              />
            </div>
          )}
          <div className="ml-auto shrink-0 flex items-center gap-2 whitespace-nowrap">
            {!view && (
              <>
                <button className="btn-primary text-xs" onClick={() => void handleImport()}>
                  {t('skill.market.import')}
                </button>
                <button className="btn-ghost text-xs" data-testid="capability-import-folder" onClick={() => void handleImportFolder()}>
                  {t('skill.market.importFolder')}
                </button>
              </>
            )}
            <button
              onClick={onClose}
              title={t('common.close')}
              className="w-8 h-8 rounded hover:bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)] text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-5">
          {current ? (
            <DetailView
              item={current}
              assistants={assistants}
              assistantsUnread={assistantsUnread}
              mcpServerItems={groups.mcpServers}
              runtimes={runtimes}
              registrySnapshot={registrySnapshot}
              policyUnread={policyUnread}
              chip={chip}
              readyChip={readyChip}
              skillStateLabels={skillStateLabels}
              mcpStateLabels={mcpStateLabels}
              bindError={bindError}
              bindingSkillId={bindingSkillId}
              startBusyId={startBusyId}
              startError={startError}
              stopBusyId={stopBusyId}
              stopError={stopError}
              logsOpenId={logsOpenId}
              logs={logs}
              tplValues={tplValues}
              tplBusyId={tplBusyId}
              tplError={tplError}
              onToggle={handleToggle}
              onDuplicate={handleDuplicate}
              onExport={handleExport}
              onDelete={handleDelete}
              onImportRemote={handleImportRemote}
              onRetryAssistants={loadAssistants}
              onBind={handleBind}
              onCreateAssistant={() => setEditor({ initial: {}, focusMcp: false })}
              onCopyBuiltin={handleCopyBuiltin}
              onAuthorize={(a) => setEditor({ initial: a, focusMcp: true })}
              onStart={(s) => void handleStartServer(s)}
              onStop={(s) => void handleStopServer(s)}
              onToggleLogs={toggleLogs}
              onTplValue={(tplId, key, value) =>
                setTplValues((prev) => ({ ...prev, [tplId]: { ...prev[tplId], [key]: value } }))
              }
              onCreateTemplate={(tpl) => void handleCreateTemplate(tpl)}
            />
          ) : (
            <div className="space-y-6">
              {/* 1. 已装技能 */}
              <Section title={groupTitles.installedSkills} count={filtered.installedSkills.length}>
                {skillsUnread ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <LoadFailNotice what={t('common.skillsList')} msg={ipcFailText(skillsUnread, t('common.unknownError'))} />
                    <button className="text-xs underline text-[var(--color-text-muted)]" data-testid="capability-skills-retry" onClick={loadSkills}>
                      {t('agent.retryRead')}
                    </button>
                  </div>
                ) : filtered.installedSkills.length === 0 ? (
                  <EmptyHint text={keyword.trim() ? t('cap.noMatch') : t('skill.market.empty')} />
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {filtered.installedSkills.map((item) => (
                      <button key={item.skill.id} className={cardShell} onClick={() => setView({ kind: 'installedSkill', id: item.skill.id })}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xl">{item.skill.icon}</span>
                          <span className="text-sm font-medium truncate">{item.skill.name}</span>
                          <span className={`ml-auto ${item.skill.isBuiltin ? readyChip : chip}`}>
                            {item.skill.isBuiltin ? t('skill.builtin') : t('skill.market.mine')}
                          </span>
                        </div>
                        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed line-clamp-2 min-h-[2.4em]">
                          {item.skill.description || '—'}
                        </p>
                        <div className="mt-2">
                          {/* 助手清单没读到过就不画「已绑定 N」——空数组≠0，别把"不知道"说成"没人用" */}
                          <span className={chip}>
                            {assistantsUnread
                              ? item.skill.enabled
                                ? t('skill.on')
                                : t('skill.off')
                              : skillStateLabels[item.state](item.boundAssistants)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </Section>

              {/* 2. 在线技能（未加载时不联网、不装空） */}
              <Section title={groupTitles.onlineSkills} count={filtered.onlineSkills.length}>
                {onlineSkills === null ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <span>{onlineLoading ? t('cap.online.loading') : onlineError ?? t('cap.online.notLoaded')}</span>
                    <button className="btn-ghost text-xs" data-testid="capability-online-load" onClick={() => void loadOnline()}>
                      {t('cap.online.load')}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="mb-2 flex items-center gap-2">
                      <button className="btn-ghost text-xs" onClick={() => void loadOnline()} disabled={onlineLoading}>
                        {onlineLoading ? t('cap.online.loading') : t('cap.online.refresh')}
                      </button>
                      <input
                        className="input text-xs py-1 flex-1"
                        placeholder={t('skill.market.urlImportPh')}
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleImportFromUrl()
                        }}
                      />
                      <button className="btn-primary text-xs shrink-0" onClick={() => void handleImportFromUrl()} disabled={!urlInput.trim()}>
                        {t('skill.market.importUrl')}
                      </button>
                    </div>
                    {filtered.onlineSkills.length === 0 ? (
                      <EmptyHint text={keyword.trim() ? t('cap.noMatch') : t('skill.market.onlineEmpty')} />
                    ) : (
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        {filtered.onlineSkills.map((item) => (
                          <button key={item.skill.id} className={cardShell} onClick={() => setView({ kind: 'onlineSkill', id: item.skill.id })}>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xl">{item.skill.icon ?? '⚡'}</span>
                              <span className="text-sm font-medium truncate">{item.skill.name}</span>
                              <span className={`ml-auto ${readyChip}`}>{t('skill.market.onlineBadge')}</span>
                            </div>
                            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed line-clamp-2 min-h-[2.4em]">
                              {item.skill.description || '—'}
                            </p>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </Section>

              {/* 3. MCP 已配置服务器 */}
              <Section title={groupTitles.mcpServers} count={filtered.mcpServers.length}>
                {serversUnread || runtimeUnread ? (
                  <div className="space-y-1">
                    {serversUnread && (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <LoadFailNotice what={t('agent.mcpServersList')} msg={ipcFailText(serversUnread, t('common.unknownError'))} />
                        <button className="text-xs underline text-[var(--color-text-muted)]" data-testid="capability-mcp-retry" onClick={loadMcp}>
                          {t('agent.retryRead')}
                        </button>
                      </div>
                    )}
                    {runtimeUnread && (
                      <p className="text-xs text-[var(--color-danger)]">
                        {t('agent.runtimeUnread', { msg: ipcFailText(runtimeUnread, t('common.unknownError')) })}
                      </p>
                    )}
                  </div>
                ) : filtered.mcpServers.length === 0 ? (
                  <EmptyHint text={keyword.trim() ? t('cap.noMatch') : t('agent.noServers')} />
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {filtered.mcpServers.map((item) => (
                      <button key={item.server.id} className={cardShell} onClick={() => setView({ kind: 'mcpServer', id: item.server.id })}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium truncate">{item.server.name}</span>
                          <span className={`ml-auto ${item.state === 'running' ? readyChip : chip}`}>
                            {mcpStateLabels[item.state]()}
                          </span>
                        </div>
                        <p className="text-[11px] text-[var(--color-text-muted)] truncate">
                          {formatMcpLaunch(item.server) || '—'}
                        </p>
                        {item.authorizedAssistants !== null && item.authorizedAssistants > 0 && (
                          <div className="mt-2">
                            <span className={chip}>{t('cap.state.mcp.authorized', { n: item.authorizedAssistants })}</span>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </Section>

              {/* 4. MCP 模板 */}
              <Section title={groupTitles.mcpTemplates} count={filtered.mcpTemplates.length}>
                {filtered.mcpTemplates.length === 0 ? (
                  <EmptyHint text={t('cap.noMatch')} />
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {filtered.mcpTemplates.map((item) => (
                      <button key={item.template.id} className={cardShell} onClick={() => setView({ kind: 'mcpTemplate', id: item.template.id })}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-mono text-xs font-semibold truncate">{item.template.draft.name}</span>
                          <span className={`ml-auto ${item.configured ? readyChip : chip}`}>
                            {item.configured ? t('cap.tpl.configured') : t('cap.tpl.unconfigured')}
                          </span>
                        </div>
                        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed line-clamp-2 min-h-[2.4em]">
                          {item.description || '—'}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </Section>
            </div>
          )}
        </div>
      </div>

      {dialog}

      {/* 助手编辑器：授权复用同一份勾选逻辑，这里只负责把记录和 providers 递进去 */}
      {editor && (
        <div
          className="fixed inset-0 z-[60] bg-[var(--color-modal-overlay)] backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto"
          onClick={(e) => {
            // 编辑器浮层虽然叠在最上面，但 DOM 仍嵌在能力中心里；不拦一下会一路冒泡到 onClose
            e.stopPropagation()
            setEditor(null)
          }}
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] p-5 my-6"
            onClick={(e) => e.stopPropagation()}
          >
            <AssistantEditor
              initial={editor.initial}
              providers={providers}
              focusToolGroup={editor.focusMcp ? 'mcp' : undefined}
              onCancel={() => setEditor(null)}
              onSaved={async () => {
                setEditor(null)
                await reloadAssistants()
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- 分组外壳 ----------
const Section: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({
  title,
  count,
  children
}) => (
  <section>
    <h3 className="text-xs font-semibold text-[var(--color-text-muted)] mb-2">
      {title} <span className="opacity-70">({count})</span>
    </h3>
    {children}
  </section>
)

const EmptyHint: React.FC<{ text: string }> = ({ text }) => (
  <p className="text-xs text-[var(--color-text-muted)]">{text}</p>
)

// ---------- 详情 ----------
function findItem(
  view: View,
  groups: ReturnType<typeof buildCapabilityGroups>
):
  | InstalledSkillItem
  | OnlineSkillItem
  | McpServerItem
  | McpTemplateItem
  | null {
  switch (view.kind) {
    case 'installedSkill':
      return groups.installedSkills.find((i) => i.skill.id === view.id) ?? null
    case 'onlineSkill':
      return groups.onlineSkills.find((i) => i.skill.id === view.id) ?? null
    case 'mcpServer':
      return groups.mcpServers.find((i) => i.server.id === view.id) ?? null
    case 'mcpTemplate':
      return groups.mcpTemplates.find((i) => i.template.id === view.id) ?? null
  }
}

const DetailView: React.FC<{
  item: InstalledSkillItem | OnlineSkillItem | McpServerItem | McpTemplateItem
  assistants: AssistantRecord[]
  assistantsUnread: { error?: string } | null
  mcpServerItems: McpServerItem[]
  runtimes: McpServerRuntime[]
  registrySnapshot: ToolPolicySnapshot | null
  policyUnread: { error?: string } | null
  chip: string
  readyChip: string
  skillStateLabels: Record<SkillCapabilityState, (n: number) => string>
  mcpStateLabels: Record<McpCapabilityState, () => string>
  bindError: { skillId: string; msg: string } | null
  bindingSkillId: string | null
  startBusyId: string | null
  startError: { serverId: string; msg: string } | null
  stopBusyId: string | null
  stopError: { serverId: string; msg: string } | null
  logsOpenId: string | null
  logs: Record<string, string[]>
  tplValues: Record<string, Record<string, string>>
  tplBusyId: string | null
  tplError: { templateId: string; msg: string } | null
  onToggle: (s: SkillRecord) => void
  onDuplicate: (s: SkillRecord) => void
  onExport: (s: SkillRecord) => void
  onDelete: (s: SkillRecord) => void
  onImportRemote: (s: OnlineSkill) => void
  onRetryAssistants: () => void
  onBind: (skill: SkillRecord, assistant: AssistantRecord) => void
  onCreateAssistant: () => void
  onCopyBuiltin: () => void
  onAuthorize: (a: AssistantRecord) => void
  onStart: (s: McpServerRecord) => void
  onStop: (s: McpServerRecord) => void
  onToggleLogs: (serverId: string) => void
  onTplValue: (tplId: string, key: string, value: string) => void
  onCreateTemplate: (tpl: McpTemplate) => void
}> = (props) => {
  const { t } = useI18n()
  const { item } = props
  switch (item.kind) {
    case 'installedSkill':
      return <InstalledSkillDetail {...props} item={item} />
    case 'onlineSkill':
      return (
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="flex items-start gap-3">
            <span className="text-3xl">{item.skill.icon ?? '⚡'}</span>
            <div className="min-w-0">
              <div className="font-semibold flex items-center gap-2">
                {item.skill.name}
                <span className={props.readyChip}>{t('skill.market.onlineBadge')}</span>
              </div>
              {item.skill.description && (
                <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{item.skill.description}</div>
              )}
              <div className="text-[10px] text-[var(--color-text-muted)] mt-1 truncate" title={item.skill.url}>
                ↗ {item.skill.url}
              </div>
            </div>
          </div>
          <button className="btn-primary text-xs" onClick={() => props.onImportRemote(item.skill)}>
            {t('skill.market.importRemote')}
          </button>
        </div>
      )
    case 'mcpServer':
      return <McpServerDetail {...props} item={item} />
    case 'mcpTemplate': {
      // 模板创建成功后仍留在当前详情：找同名 Server，直接换成那台的运行/授权面板
      const configuredServer = props.mcpServerItems.find(
        (s) => s.server.name === item.template.draft.name
      )
      if (configuredServer) {
        return (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold">{item.template.draft.name}</span>
                <span className={`ml-auto ${props.readyChip}`}>{t('cap.tpl.configured')}</span>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                {t('cap.tpl.configuredHint')}
              </p>
            </div>
            <McpServerDetail {...props} item={configuredServer} />
          </div>
        )
      }
      return <McpTemplateDetail {...props} item={item} />
    }
  }
}

const InstalledSkillDetail: React.FC<{
  item: InstalledSkillItem
  assistants: AssistantRecord[]
  assistantsUnread: { error?: string } | null
  chip: string
  readyChip: string
  skillStateLabels: Record<SkillCapabilityState, (n: number) => string>
  bindError: { skillId: string; msg: string } | null
  bindingSkillId: string | null
  onToggle: (s: SkillRecord) => void
  onDuplicate: (s: SkillRecord) => void
  onExport: (s: SkillRecord) => void
  onDelete: (s: SkillRecord) => void
  onRetryAssistants: () => void
  onBind: (skill: SkillRecord, assistant: AssistantRecord) => void
  onCreateAssistant: () => void
  onCopyBuiltin: () => void
}> = ({
  item,
  assistants,
  assistantsUnread,
  chip,
  readyChip,
  skillStateLabels,
  bindError,
  bindingSkillId,
  onToggle,
  onDuplicate,
  onExport,
  onDelete,
  onRetryAssistants,
  onBind,
  onCreateAssistant,
  onCopyBuiltin
}) => {
  const { t } = useI18n()
  const skill = item.skill
  const customAssistants = assistants.filter((a) => !a.isBuiltin)
  const builtinAssistants = assistants.filter((a) => a.isBuiltin)
  const binding = bindingSkillId === skill.id
  const errorMsg = bindError?.skillId === skill.id ? bindError.msg : null
  const boundTo = (a: AssistantRecord) => (a.skillIds ?? []).includes(skill.id)
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-3xl">{skill.icon}</span>
        <div className="min-w-0">
          <div className="font-semibold flex items-center gap-2">
            {skill.name}
            <span className={skill.isBuiltin ? readyChip : chip}>
              {skill.isBuiltin ? t('skill.builtin') : t('skill.market.mine')}
            </span>
          </div>
          {skill.description && (
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{skill.description}</div>
          )}
        </div>
        <span className={`ml-auto shrink-0 ${skill.enabled ? readyChip : chip}`}>
          {assistantsUnread
            ? skill.enabled
              ? t('skill.on')
              : t('skill.off')
            : skillStateLabels[item.state](item.boundAssistants)}
        </span>
      </div>

      <pre className="input whitespace-pre-wrap font-mono text-xs leading-relaxed min-h-[160px] max-h-[40vh] overflow-y-auto">
        {skill.content}
      </pre>

      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost text-xs" onClick={() => onToggle(skill)}>
          {skill.enabled ? t('skill.disable') : t('skill.enable')}
        </button>
        <button className="btn-primary text-xs" onClick={() => onDuplicate(skill)}>
          {t('skill.market.duplicate')}
        </button>
        <button className="btn-ghost text-xs" onClick={() => onExport(skill)}>
          {t('skill.market.export')}
        </button>
        {!skill.isBuiltin && (
          <button className="btn-ghost text-xs text-[var(--color-danger)]" onClick={() => onDelete(skill)}>
            {t('common.delete')}
          </button>
        )}
      </div>

      {/* 行为影响：只说运行期会发生什么，不下权限/安全结论 */}
      <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-1.5">
        <div className="text-xs font-semibold">{t('cap.detail.behavior')}</div>
        <Row label={t('cap.behavior.mode')} value={skill.resident ? t('skill.residentOn') : t('skill.residentOff')} />
        <Row label={t('cap.behavior.contentChars')} value={t('cap.behavior.chars', { n: skill.content.length })} />
        <Row
          label={t('cap.behavior.enabled')}
          value={skill.enabled ? t('skill.on') : t('skill.off')}
        />
        {/* 助手清单读不到时这一行没有事实可写，宁可缺席也不写「0 个助手」 */}
        {!assistantsUnread && (
          <Row
            label={t('cap.behavior.bound')}
            value={item.boundAssistants > 0 ? t('skill.market.userCount', { count: item.boundAssistants }) : t('skill.market.userCountNone')}
          />
        )}
      </div>

      {/* 启用 ≠ 在用：启用只让技能可用，还要绑定到助手才会进对话 */}
      <p
        className="text-[11px] text-[var(--color-text-muted)] leading-relaxed -mt-2"
        data-testid="capability-enable-hint"
      >
        {t('skill.market.enableHint')}
      </p>

      {/* 就地绑定：写入仍是 saveAssistant 并集；失败只写 inline，已勾/已绑列表原样保留 */}
      <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
        <div className="text-xs font-semibold">{t('skill.market.bindTitle')}</div>
        {assistantsUnread ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <LoadFailNotice what={t('common.assistantsList')} msg={ipcFailText(assistantsUnread, t('common.unknownError'))} />
            <button
              className="text-xs underline text-[var(--color-text-muted)]"
              data-testid="capability-assistants-retry"
              onClick={onRetryAssistants}
            >
              {t('agent.retryRead')}
            </button>
          </div>
        ) : !skill.enabled ? (
          <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed" data-testid="capability-bind-disabled">
            {t('skill.market.bindDisabledHint')}
          </p>
        ) : customAssistants.length === 0 ? (
          <div className="space-y-2" data-testid="capability-bind-no-custom">
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
              {t('cap.noCustomAssistants')}
            </p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary text-xs" onClick={onCreateAssistant}>
                {t('cap.createAssistant')}
              </button>
              {builtinAssistants.length > 0 && (
                <button className="btn-ghost text-xs" onClick={onCopyBuiltin}>
                  {t('cap.copyBuiltin')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {customAssistants.map((a) =>
                boundTo(a) ? (
                  <span
                    key={a.id}
                    data-skill-bound={a.id}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  >
                    ✓ {assistantDisplayName(a, t)}
                  </span>
                ) : (
                  <button
                    key={a.id}
                    data-skill-bind={a.id}
                    disabled={binding}
                    onClick={() => onBind(skill, a)}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] disabled:opacity-50"
                  >
                    {binding
                      ? t('common.saving')
                      : `${assistantDisplayName(a, t)} · ${t('skill.market.bindButton')}`}
                  </button>
                )
              )}
              {/* 内置助手不可编辑：按钮禁用并给原因（不造一个按下去必失败的入口） */}
              {builtinAssistants.map((a) =>
                boundTo(a) ? (
                  <span
                    key={a.id}
                    data-skill-bound={a.id}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  >
                    ✓ {assistantDisplayName(a, t)}
                  </span>
                ) : (
                  <button
                    key={a.id}
                    data-skill-bind={a.id}
                    data-skill-blocked="true"
                    disabled
                    title={t('skill.market.bindBuiltinHint')}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] opacity-50"
                  >
                    {assistantDisplayName(a, t)} · {t('skill.market.bindButton')}
                  </button>
                )
              )}
            </div>
            {builtinAssistants.some((a) => !boundTo(a)) && (
              <p
                className="text-[10px] text-[var(--color-text-muted)] leading-relaxed"
                data-testid="capability-bind-builtin-hint"
              >
                {t('skill.market.bindBuiltinHint')}
              </p>
            )}
            {assistants.every((a) => !boundTo(a)) && (
              <p
                className="text-[10px] text-[var(--color-text-muted)] leading-relaxed"
                data-testid="capability-bind-none"
              >
                {t('skill.market.bindNone')}
              </p>
            )}
          </>
        )}
        {errorMsg && (
          <p className="text-[11px] text-[var(--color-danger)]" data-testid="capability-bind-error">
            {errorMsg}
          </p>
        )}
      </div>

      {skill.isBuiltin && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{t('skill.market.builtinHint')}</p>
      )}
    </div>
  )
}

const McpServerDetail: React.FC<{
  item: McpServerItem
  assistants: AssistantRecord[]
  assistantsUnread: { error?: string } | null
  runtimes: McpServerRuntime[]
  registrySnapshot: ToolPolicySnapshot | null
  policyUnread: { error?: string } | null
  chip: string
  readyChip: string
  mcpStateLabels: Record<McpCapabilityState, () => string>
  startBusyId: string | null
  startError: { serverId: string; msg: string } | null
  stopBusyId: string | null
  stopError: { serverId: string; msg: string } | null
  logsOpenId: string | null
  logs: Record<string, string[]>
  onStart: (s: McpServerRecord) => void
  onStop: (s: McpServerRecord) => void
  onToggleLogs: (serverId: string) => void
  onRetryAssistants: () => void
  onAuthorize: (a: AssistantRecord) => void
  onCreateAssistant: () => void
  onCopyBuiltin: () => void
}> = ({
  item,
  assistants,
  assistantsUnread,
  runtimes,
  registrySnapshot,
  policyUnread,
  chip,
  readyChip,
  mcpStateLabels,
  startBusyId,
  startError,
  stopBusyId,
  stopError,
  logsOpenId,
  logs,
  onStart,
  onStop,
  onToggleLogs,
  onRetryAssistants,
  onAuthorize,
  onCreateAssistant,
  onCopyBuiltin
}) => {
  const { t } = useI18n()
  const server = item.server
  const tools: ToolPolicyEntry[] = registrySnapshot
    ? mcpEntriesOfServer(registrySnapshot.tools, server.id)
    : []
  const running = item.state === 'running'
  const busy = startBusyId === server.id
  const stopping = stopBusyId === server.id
  const stopFailedMsg = stopError?.serverId === server.id ? stopError.msg : null
  const runtimeError = runtimes.find((r) => r.id === server.id)?.lastError ?? null
  /** 失败原因优先使用本次点击后刷到的 lastError；面板打开前就已是 error 的走运行时快照 */
  const failedMsg = startError?.serverId === server.id ? startError.msg : runtimeError
  const logsOpen = logsOpenId === server.id
  const lines = logs[server.id] ?? []
  const customAssistants = assistants.filter((a) => !a.isBuiltin)
  const builtinAssistants = assistants.filter((a) => a.isBuiltin)
  const canViewLogs = failedMsg !== null || item.state === 'error' || lines.length > 0 || logsOpen
  const logsBlock = logsOpen ? (
    <pre className="input font-mono text-[10px] whitespace-pre-wrap max-h-56 overflow-y-auto p-2">
      {lines.length > 0 ? lines.join('\n') : t('cap.mcp.logEmpty')}
    </pre>
  ) : null
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <div className="font-semibold flex items-center gap-2">{server.name}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 break-all">
            {formatMcpLaunch(server) || '—'}
          </div>
        </div>
        <span className={`ml-auto shrink-0 ${running ? readyChip : chip}`}>
          {mcpStateLabels[item.state]()}
        </span>
      </div>

      {item.authorizedAssistants !== null && item.authorizedAssistants > 0 && (
        <div>
          <span className={chip}>{t('cap.state.mcp.authorized', { n: item.authorizedAssistants })}</span>
        </div>
      )}

      {policyUnread && (
        <LoadFailNotice
          what={t('cap.mcp.policy')}
          msg={ipcFailText(policyUnread, t('common.unknownError'))}
        />
      )}

      {/* 启动：先启动成功，才谈得上授权 */}
      {!running && (
        <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-primary text-xs"
              data-testid="capability-mcp-start"
              disabled={busy || item.state === 'starting'}
              onClick={() => onStart(server)}
            >
              {busy || item.state === 'starting' ? t('cap.state.mcp.starting') : t('cap.mcp.start')}
            </button>
            <span className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
              {t('cap.mcp.needStart')}
            </span>
          </div>
          {failedMsg && (
            <p className="text-[11px] text-[var(--color-danger)]" data-testid="capability-mcp-start-error">
              {t('cap.mcp.startFailed', { msg: failedMsg })}
            </p>
          )}
          {canViewLogs && (
            <button
              className="text-xs underline text-[var(--color-text-muted)]"
              data-testid="capability-mcp-toggle-logs"
              onClick={() => onToggleLogs(server.id)}
            >
              {logsOpen ? t('cap.mcp.hideLogs') : t('cap.mcp.viewLogs')}
            </button>
          )}
          {logsBlock}
        </div>
      )}

      {/* 运行中：工具清单；一台运行中的服务器一个工具都没有，就是「未暴露工具」 */}
      {running && (
        <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">{t('cap.mcp.toolsTitle')}</span>
            <div className="ml-auto shrink-0 flex items-center gap-2">
              <button
                className="btn-ghost text-xs"
                data-testid="capability-mcp-stop"
                disabled={stopping}
                onClick={() => onStop(server)}
              >
                {stopping ? t('cap.mcp.stopping') : t('cap.mcp.stop')}
              </button>
              {canViewLogs && (
                <button
                  className="text-xs underline text-[var(--color-text-muted)]"
                  data-testid="capability-mcp-toggle-logs"
                  onClick={() => onToggleLogs(server.id)}
                >
                  {logsOpen ? t('cap.mcp.hideLogs') : t('cap.mcp.viewLogs')}
                </button>
              )}
            </div>
          </div>
          {/* 停止失败自己一张脸：运行态不跟着改，重试仍是这颗键 */}
          {stopFailedMsg && (
            <p className="text-[11px] text-[var(--color-danger)]" data-testid="capability-mcp-stop-error">
              {t('cap.mcp.stopFailed', { msg: stopFailedMsg })}
            </p>
          )}
          {registrySnapshot === null ? (
            policyUnread ? null : (
              <p className="text-[11px] text-[var(--color-text-muted)]">{t('cap.mcp.toolsPending')}</p>
            )
          ) : tools.length === 0 ? (
            <p className="text-[11px] text-[var(--color-text-muted)]" data-testid="capability-mcp-no-tools">
              {t('cap.mcp.noTools')}
            </p>
          ) : (
            tools.map((tool) => (
              <div key={tool.id} className="flex items-center gap-2 text-[11px]">
                <span className="font-mono truncate" title={tool.name}>
                  {tool.name}
                </span>
                <span className={`ml-auto ${chip}`}>{permissionText(tool, t)}</span>
                <span className={`${chip}`}>{policyStateText(tool.state, t)}</span>
              </div>
            ))
          )}
          {logsBlock}
        </div>
      )}

      {/* 授权：只有运行中且真有工具时才出现；勾选逻辑仍在 AssistantEditor 里 */}
      {running && registrySnapshot !== null && tools.length > 0 && (
        <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
          <div className="text-xs font-semibold">{t('cap.mcp.authorizeTitle')}</div>
          {assistantsUnread ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <LoadFailNotice what={t('common.assistantsList')} msg={ipcFailText(assistantsUnread, t('common.unknownError'))} />
              <button
                className="text-xs underline text-[var(--color-text-muted)]"
                data-testid="capability-assistants-retry"
                onClick={onRetryAssistants}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          ) : customAssistants.length === 0 ? (
            <div className="space-y-2" data-testid="capability-mcp-no-custom">
              <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                {t('cap.noCustomAssistants')}
              </p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary text-xs" onClick={onCreateAssistant}>
                  {t('cap.createAssistant')}
                </button>
                {builtinAssistants.length > 0 && (
                  <button className="btn-ghost text-xs" onClick={onCopyBuiltin}>
                    {t('cap.copyBuiltin')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {customAssistants.map((a) => (
                  <button
                    key={a.id}
                    data-mcp-authorize={a.id}
                    onClick={() => onAuthorize(a)}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
                  >
                    {assistantDisplayName(a, t)} · {t('cap.mcp.authorize')}
                  </button>
                ))}
                {builtinAssistants.map((a) => (
                  <button
                    key={a.id}
                    disabled
                    title={t('cap.authorizeBuiltinReason')}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] opacity-50"
                  >
                    {assistantDisplayName(a, t)} · {t('cap.mcp.authorize')}
                  </button>
                ))}
              </div>
              {builtinAssistants.length > 0 && (
                <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                  {t('cap.authorizeBuiltinReason')}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const McpTemplateDetail: React.FC<{
  item: McpTemplateItem
  chip: string
  readyChip: string
  tplValues: Record<string, Record<string, string>>
  tplBusyId: string | null
  tplError: { templateId: string; msg: string } | null
  onTplValue: (tplId: string, key: string, value: string) => void
  onCreateTemplate: (tpl: McpTemplate) => void
}> = ({ item, chip, readyChip, tplValues, tplBusyId, tplError, onTplValue, onCreateTemplate }) => {
  const { t } = useI18n()
  const template = item.template
  const values = tplValues[template.id] ?? {}
  const busy = tplBusyId === template.id
  const errorMsg = tplError?.templateId === template.id ? tplError.msg : null
  return (
    <div className="max-w-2xl mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold">{template.draft.name}</span>
        <span className={item.configured ? readyChip : chip}>
          {item.configured ? t('cap.tpl.configured') : t('cap.tpl.unconfigured')}
        </span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{item.description}</p>
      <div className="text-xs text-[var(--color-text-muted)]">
        <div className="mb-1">{t('cap.mcp.launch')}</div>
        <pre className="input whitespace-pre-wrap font-mono text-[11px] p-2">
          {formatMcpLaunch(template.draft)}
        </pre>
      </div>

      {(template.placeholders ?? []).map((p) => (
        <div key={p.key} className="space-y-0.5">
          <label className="block text-[10px] font-medium text-[var(--color-text-muted)]">
            {placeholderLabelText(p.label, t)}
          </label>
          <input
            className="input font-mono text-[11px] py-1"
            type={p.secret ? 'password' : 'text'}
            autoComplete="off"
            value={values[p.key] ?? ''}
            onChange={(e) => onTplValue(template.id, p.key, e.target.value)}
            spellCheck={false}
          />
          {p.secret && (
            <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
              {t('agent.tplSecretHint')}
            </p>
          )}
        </div>
      ))}

      <button
        className="btn-primary text-xs"
        data-testid="capability-tpl-create"
        disabled={busy}
        onClick={() => onCreateTemplate(template)}
      >
        {busy ? t('cap.tpl.creating') : t('cap.tpl.create')}
      </button>
      {errorMsg && (
        <p className="text-[11px] text-[var(--color-danger)]" data-testid="capability-tpl-error">
          {errorMsg}
        </p>
      )}
    </div>
  )
}

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center gap-2 text-[11px]">
    <span className="text-[var(--color-text-muted)]">{label}</span>
    <span className="ml-auto text-right">{value}</span>
  </div>
)

/** 权限档直接读快照里的 permission（auto/confirm/deny），不另写名单 */
function permissionText(entry: ToolPolicyEntry, t: (k: string) => string): string {
  switch (entry.permission) {
    case 'confirm':
      return t('tp.permission.confirm')
    case 'deny':
      return t('tp.permission.deny')
    default:
      return t('tp.permission.auto')
  }
}

function policyStateText(state: ToolPolicyState, t: (k: string) => string): string {
  switch (state) {
    case 'disabled':
      return t('tp.state.disabled')
    case 'needs-explicit':
      return t('tp.state.needsExplicit')
    case 'denied':
      return t('tp.state.denied')
    case 'not-granted':
      return t('tp.state.notGranted')
    default:
      return t('tp.state.available')
  }
}

/** 模板占位符 label → 文案（四个固定 key 的字面量 switch；不新增动态 t() 调用点） */
function placeholderLabelText(label: string, t: (k: string) => string): string {
  switch (label) {
    case 'agent.tplPhDir':
      return t('agent.tplPhDir')
    case 'agent.tplPhRepo':
      return t('agent.tplPhRepo')
    case 'agent.tplPhDb':
      return t('agent.tplPhDb')
    case 'agent.tplPhApiKey':
      return t('agent.tplPhApiKey')
    default:
      return label
  }
}

/** 模板 id → 描述文案（每个 id 一条字面量 key；不新增动态 t() 调用点） */
function templateDescText(id: string, t: (k: string) => string): string {
  switch (id) {
    case 'fetch':
      return t('agent.tplDescFetch')
    case 'puppeteer':
      return t('agent.tplDescPuppeteer')
    case 'filesystem':
      return t('agent.tplDescFilesystem')
    case 'git':
      return t('agent.tplDescGit')
    case 'sqlite':
      return t('agent.tplDescSqlite')
    case 'tavily-search':
      return t('agent.tplDescTavily')
    case 'memory':
      return t('agent.tplDescMemory')
    case 'sequential-thinking':
      return t('agent.tplDescSeq')
    case 'time':
      return t('agent.tplDescTime')
    default:
      return ''
  }
}
