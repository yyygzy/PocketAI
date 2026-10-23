// MCP 面板的 pip 下载源设置（全局，影响所有 Python MCP 依赖安装）
import { useCallback, useEffect, useState } from 'react'
import type { PythonPipSource } from '../../../../../shared/types'
import { isAllowedPipSourceUrl } from '../../../../../shared/schemas/mcp'
import type { ConfirmOptions } from '../../../components/ConfirmDialog'
import { useI18n } from '../../../i18n'
import { errText } from '../../../utils/error'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../../utils/ipc'

export function usePipSource(
  notify: (msg: string) => void,
  confirm: (opts: ConfirmOptions) => Promise<boolean>
) {
  const { t } = useI18n()
  const [pipSource, setPipSourceState] = useState<PythonPipSource>('official')
  const [pipCustomOpen, setPipCustomOpen] = useState(false)
  const [pipCustomUrl, setPipCustomUrl] = useState('')
  const [pipCustomError, setPipCustomError] = useState('')
  // §274：pip 源那一读失败时，这一格停在字面量默认值「官方」⇒ 把通道故障演成"你选的就是官方"。
  // 出路只有"关掉面板再开一次"，而 MCP 面板里可能正在配别的东西 ⇒ 按 §268 判据算"代价大到等于没出口"⇒ 配一颗重试键。
  const [pipSourceUnread, setPipSourceUnread] = useState<{ error: string } | null>(null)

  const loadPipSource = useCallback(() => {
    window.pocketai.getPythonPipSource().then((r) => {
      if (hasIpcFailed(r)) {
        setPipSourceUnread({ error: ipcFailText(r, t('common.unknownError')) })
        return
      }
      setPipSourceUnread(null)
      // §274：hasIpcFailed 已判过失败，这里 r.ok 必真 ⇒ 只判 source 是否非空（扫掉 `.ok` 裸真值，免得闸门把这条读成静默点）
      if (r.source) {
        setPipSourceState(r.source)
        if (r.source !== 'official' && r.source !== 'tuna') {
          setPipCustomOpen(true)
          setPipCustomUrl(r.source)
        }
      }
    }).catch((e) => {
      setPipSourceUnread({ error: errText(e, t('common.unknownError')) })
      logIpcError('mcp.getPythonPipSource', e)
    })
  }, [t])

  const reloadPipSource = useCallback(() => {
    setPipSourceUnread(null)
    loadPipSource()
  }, [loadPipSource])

  useEffect(() => {
    loadPipSource()
  }, [loadPipSource])

  const choosePipSource = async (next: PythonPipSource) => {
    if (next === 'custom') {
      setPipCustomOpen(true)
      return
    }
    setPipCustomOpen(false)
    setPipCustomError('')
    try {
      const r = await window.pocketai.setPythonPipSource(next)
      if (r.ok && r.source) setPipSourceState(r.source)
      else if (r.error) notify(r.error)
    } catch (e) {
      notify(errText(e, t('agent.mcp.setPipSourceFailed')))
    }
  }

  const saveCustomPipSource = async () => {
    const url = pipCustomUrl.trim()
    // 校验与主进程同一把尺（https，仅本机回环可 http）：SEC-20
    if (!url || !isAllowedPipSourceUrl(url)) {
      setPipCustomError(t('agent.f.pipCustomInvalid'))
      return
    }
    // 换源等于替换将落进 venv 的 wheel 来源，而 MCP server 就用这个 venv 启动 —— 必须二次确认
    const ok = await confirm({
      title: t('agent.f.pipSource'),
      message: t('agent.pipSourceConfirm', { url }),
      danger: true
    })
    if (!ok) return
    try {
      const r = await window.pocketai.setPythonPipSource(url)
      if (r.ok && r.source) {
        setPipSourceState(r.source)
        setPipCustomError('')
      } else if (r.error) {
        setPipCustomError(r.error)
      }
    } catch (e) {
      setPipCustomError(errText(e, t('agent.mcp.setPipSourceFailed')))
    }
  }

  return {
    pipSource,
    pipSourceUnread,
    pipCustomOpen,
    pipCustomUrl,
    setPipCustomUrl,
    pipCustomError,
    choosePipSource,
    saveCustomPipSource,
    reloadPipSource
  }
}
