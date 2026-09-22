// Agent 工具开关配置：工作目录 / shell 策略 / 联网搜索 / 本地日历
// 所有变更立即持久化，以后端回写为准（含值域兜底）
import { useEffect, useState } from 'react'
import type { CalendarConfig, ShellConfig, WebSearchConfig } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { useToast } from '../../../components/ToastProvider'

export function useAgentToolConfigs() {
  const { t } = useI18n()
  const toast = useToast()
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
    window.pocketai.getAgentWorkspaceDir().then(setWorkspaceDir)
    window.pocketai.getShellConfig().then(setShellConfigState)
    window.pocketai.getWebSearchConfig().then(setWsConfigState)
    window.pocketai.getCalendarConfig().then(setCalConfigState)
  }, [])

  const pickWorkspace = async () => {
    const dir = await window.pocketai.pickAgentWorkspaceDir()
    setWorkspaceDir(dir)
  }

  const patchShellConfig = async (patch: Partial<ShellConfig>) => {
    setShellConfigState(await window.pocketai.setShellConfig(patch))
  }

  const patchWsConfig = async (
    patch: Partial<Pick<WebSearchConfig, 'enabled' | 'provider' | 'apiKey'>>
  ) => {
    // 超长预检：避免主进程拒绝后草稿被误清（后端仍有同样校验，双保险）
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim().length > 256) {
      toast.error(t('agent.websearch.keyTooLong'))
      return
    }
    try {
      const next = await window.pocketai.setWebSearchConfig(patch)
      setWsConfigState(next)
      if (patch.apiKey !== undefined) setWsKeyDraft('')
    } catch (e) {
      toast.error((e as Error).message || t('common.unknownError'))
    }
  }

  const patchCalConfig = async (patch: Partial<Pick<CalendarConfig, 'enabled' | 'paths'>>) => {
    try {
      setCalConfigState(await window.pocketai.setCalendarConfig(patch))
    } catch (e) {
      toast.error((e as Error).message || t('common.unknownError'))
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
      toast.error((e as Error).message || t('common.unknownError'))
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
    patchCalConfig,
    addIcs
  }
}

export type AgentToolConfigs = ReturnType<typeof useAgentToolConfigs>
