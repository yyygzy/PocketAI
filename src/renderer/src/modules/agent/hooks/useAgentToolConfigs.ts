// Agent 工具开关配置：工作目录 / shell 策略 / 联网搜索 / 本地日历
// 所有变更立即持久化，以后端回写为准（含值域兜底）
import { useEffect, useState } from 'react'
import type { CalendarConfig, ShellConfig, WebSearchConfig } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { useToast } from '../../../components/ToastProvider'
import { reportIpcError, hasIpcFailed, ipcFailText } from '../../../utils/ipc'
import { useConfirm } from '../../../components/ConfirmDialog'
import { isUnprotectedMode } from '../../../utils/secret-consent'
import { errText } from '../../../utils/error'

export function useAgentToolConfigs() {
  const { t } = useI18n()
  const toast = useToast()
  // B3：联网搜索 Key 不拦写入，但明文模式下保存新值要用户显式承认
  const { confirm: confirmSecret, dialog: secretDialog } = useConfirm()
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [shellConfig, setShellConfigState] = useState<ShellConfig>({ enabled: false, policy: 'confirm' })
  const [calConfig, setCalConfigState] = useState<CalendarConfig>({ enabled: false, paths: [] })
  const [wsConfig, setWsConfigState] = useState<WebSearchConfig>({
    enabled: false,
    provider: 'tavily',
    apiKey: '',
    hasKey: false
  })
  /** 联网搜索 Key 输入框（不回显已存 Key，仅新输入时生效） */
  const [wsKeyDraft, setWsKeyDraft] = useState('')

  useEffect(() => {
    window.pocketai.getAgentWorkspaceDir().then(setWorkspaceDir).catch(reportIpcError('agent.getWorkspaceDir'))
    window.pocketai.getShellConfig().then(setShellConfigState).catch(reportIpcError('agent.getShellConfig'))
    window.pocketai.getWebSearchConfig().then(setWsConfigState).catch(reportIpcError('agent.getWebSearchConfig'))
    window.pocketai.getCalendarConfig().then(setCalConfigState).catch(reportIpcError('agent.getCalendarConfig'))
  }, [])

  const pickWorkspace = async () => {
    const dir = await window.pocketai.pickAgentWorkspaceDir()
    // preload 声明的是 string，但 safeHandle 的失败是 **resolve 的 {ok:false}**（§205 记过这层类型撒谎）；
    // 不判就把失败对象塞进 workspaceDir，消费方 `AgentModelBar.tsx:102` 对它做 .split ⇒ 整屏崩
    if (hasIpcFailed(dir)) {
      toast.error(ipcFailText(dir, t('common.unknownError')))
      return
    }
    setWorkspaceDir(dir)
  }

  const patchShellConfig = async (patch: Partial<ShellConfig>) => {
    try {
      const next = await window.pocketai.setShellConfig(patch)
      if (hasIpcFailed(next)) {
        toast.error(ipcFailText(next, t('common.unknownError')))
        return
      }
      setShellConfigState(next)
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
    }
  }

  const patchWsConfig = async (
    patch: Partial<Pick<WebSearchConfig, 'enabled' | 'provider' | 'apiKey'>>
  ) => {
    // 超长预检：避免主进程拒绝后草稿被误清（后端仍有同样校验，双保险）
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim().length > 256) {
      toast.error(t('agent.websearch.keyTooLong'))
      return
    }
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '' && (await isUnprotectedMode())) {
      if (!(await confirmSecret({ message: t('secret.unprotectedWarn'), danger: true }))) return
    }
    try {
      const next = await window.pocketai.setWebSearchConfig(patch)
      // 失败时**先 return**：既不能把 {ok:false} 当配置写进 state，也不能清掉用户刚粘贴的 Key 草稿
      if (hasIpcFailed(next)) {
        toast.error(ipcFailText(next, t('common.unknownError')))
        return
      }
      setWsConfigState(next)
      if (patch.apiKey !== undefined) setWsKeyDraft('')
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
    }
  }

  const patchCalConfig = async (patch: Partial<Pick<CalendarConfig, 'enabled' | 'paths'>>) => {
    try {
      const next = await window.pocketai.setCalendarConfig(patch)
      if (hasIpcFailed(next)) {
        toast.error(ipcFailText(next, t('common.unknownError')))
        return
      }
      setCalConfigState(next)
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
    }
  }

  /** 添加 .ics 日历文件（文件选择对话框） */
  const addIcs = async () => {
    try {
      const res = await window.pocketai.pickIcsFile()
      if (res.canceled || !res.path) return
      if (calConfig.paths.includes(res.path)) return
      await patchCalConfig({ paths: [...calConfig.paths, res.path], enabled: true })
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
    }
  }

  return {
    workspaceDir,
    shellConfig,
    calConfig,
    wsConfig,
    wsKeyDraft,
    setWsKeyDraft,
    pickWorkspace,
    patchShellConfig,
    patchWsConfig,
    secretDialog,
    patchCalConfig,
    addIcs
  }
}

export type AgentToolConfigs = ReturnType<typeof useAgentToolConfigs>
