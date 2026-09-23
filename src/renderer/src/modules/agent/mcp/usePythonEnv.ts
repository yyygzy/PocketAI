// MCP 表单的 Python venv 环境状态：检测/安装事件订阅 + 实时日志
// install() 返回错误文案（空串表示成功），由表单统一展示在错误条中
import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpRuntime, PythonEnvInstallEvent, PythonEnvState } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { errText } from '../../../utils/error'

export function usePythonEnv(serverId: string | undefined, runtime: McpRuntime) {
  const { t } = useI18n()
  const [envState, setEnvState] = useState<PythonEnvState | null>(null)
  const [envEvents, setEnvEvents] = useState<PythonEnvInstallEvent[]>([])
  const [installing, setInstalling] = useState(false)
  const envLogRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<string> => {
    if (!serverId) return ''
    try {
      const r = await window.pocketai.getPythonEnvStatus(serverId)
      if (r.ok && r.state) {
        setEnvState(r.state)
        if (r.recentEvents) setEnvEvents(r.recentEvents)
      } else if (r.error) {
        // 存量脏数据等场景：由表单错误条展示，避免静默停在旧状态
        return r.error
      }
    } catch (e) {
      // 非 Error 抛出时无有效文本可展示，按「无错误」处理避免错误条显示 undefined
      return errText(e, '')
    }
    return ''
  }, [serverId])

  // 已保存的 python server：拉取环境状态 + 回填最近安装日志
  useEffect(() => {
    if (serverId && runtime === 'python') void refresh()
  }, [serverId, runtime, refresh])

  // 订阅该 server 的安装实时事件（广播是全局的，按 id 过滤）
  useEffect(() => {
    if (!serverId) return
    const off = window.pocketai.onPythonEnvEvent((evt) => {
      if (evt.serverId !== serverId) return
      if (evt.stage === 'venv' || evt.stage === 'pip') setInstalling(true)
      if (evt.stage === 'done' || evt.stage === 'error') setInstalling(false)
      setEnvEvents((prev) => [...prev.slice(-199), evt])
    })
    return off
  }, [serverId])

  // 日志自动滚到底
  useEffect(() => {
    envLogRef.current?.scrollTo({ top: envLogRef.current.scrollHeight })
  }, [envEvents])

  const install = useCallback(async (packages: string[], dirty: boolean): Promise<string> => {
    if (!serverId) return t('agent.f.pythonInstallNeedSave')
    if (packages.length === 0) return t('agent.f.pythonPackagesEmpty')
    if (dirty) return t('agent.f.pythonInstallSaveFirst')
    setInstalling(true)
    setEnvEvents((prev) => [
      ...prev,
      { serverId, stage: 'venv', timestamp: Date.now(), message: t('agent.f.pythonInstallStart') }
    ])
    const r = await window.pocketai.installPythonEnv(serverId)
    setInstalling(false)
    if (r.ok && r.state) {
      setEnvState(r.state)
      return ''
    }
    await refresh()
    return t('agent.f.pythonInstallFailed', { e: r.error ?? t('common.unknownError') })
  }, [serverId, refresh, t])

  return { envState, envEvents, installing, envLogRef, refresh, install }
}
