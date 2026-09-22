// MCP 面板的 pip 下载源设置（全局，影响所有 Python MCP 依赖安装）
import { useEffect, useState } from 'react'
import type { PythonPipSource } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'

export function usePipSource(notify: (msg: string) => void) {
  const { t } = useI18n()
  const [pipSource, setPipSourceState] = useState<PythonPipSource>('official')
  const [pipCustomOpen, setPipCustomOpen] = useState(false)
  const [pipCustomUrl, setPipCustomUrl] = useState('')
  const [pipCustomError, setPipCustomError] = useState('')

  useEffect(() => {
    window.pocketai.getPythonPipSource().then((r) => {
      if (r.ok && r.source) {
        setPipSourceState(r.source)
        if (r.source !== 'official' && r.source !== 'tuna') {
          setPipCustomOpen(true)
          setPipCustomUrl(r.source)
        }
      }
    })
  }, [])

  const choosePipSource = async (next: PythonPipSource) => {
    if (next === 'custom') {
      setPipCustomOpen(true)
      return
    }
    setPipCustomOpen(false)
    setPipCustomError('')
    const r = await window.pocketai.setPythonPipSource(next)
    if (r.ok && r.source) setPipSourceState(r.source)
    else if (r.error) notify(r.error)
  }

  const saveCustomPipSource = async () => {
    const url = pipCustomUrl.trim()
    let u: URL | null = null
    try {
      u = new URL(url)
    } catch {
      u = null
    }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !url) {
      setPipCustomError(t('agent.f.pipCustomInvalid'))
      return
    }
    const r = await window.pocketai.setPythonPipSource(url)
    if (r.ok && r.source) {
      setPipSourceState(r.source)
      setPipCustomError('')
    } else if (r.error) {
      setPipCustomError(r.error)
    }
  }

  return {
    pipSource,
    pipCustomOpen,
    pipCustomUrl,
    setPipCustomUrl,
    pipCustomError,
    choosePipSource,
    saveCustomPipSource
  }
}
