// MCP Server 新增/编辑表单（stdio: binary/node/python + http），含 Python 依赖安装向导
import React, { useEffect, useState } from 'react'
import type {
  McpServerRecord,
  McpRuntime,
  PythonRuntime
} from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { usePythonEnv } from './usePythonEnv'

const ARGS_PLACEHOLDER = '["-y","@modelcontextprotocol/server-filesystem","/tmp"]'
const ENV_PLACEHOLDER = '{"API_KEY":"xxx"}'

interface Props {
  initial: Partial<McpServerRecord>
  onCancel: () => void
  onSaved: (rec: McpServerRecord) => void
}

export const McpForm: React.FC<Props> = ({ initial, onCancel, onSaved }) => {
  const { t } = useI18n()
  const [name, setName] = useState(initial.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'http'>(initial.transport ?? 'stdio')
  const [runtime, setRuntime] = useState<McpRuntime>(initial.runtime ?? 'binary')
  const [command, setCommand] = useState(initial.command ?? 'node')
  const [argsText, setArgsText] = useState(JSON.stringify(initial.args ?? [], null, 2))
  const [envText, setEnvText] = useState(JSON.stringify(initial.env ?? {}, null, 2))
  const [url, setUrl] = useState(initial.url ?? '')
  const [enabled, setEnabled] = useState(initial.enabled !== false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Python 运行时列表（仅 runtime=python 时使用）
  const [pyRuntimes, setPyRuntimes] = useState<PythonRuntime[]>([])
  const [pyLoading, setPyLoading] = useState(false)
  const [pyDownloading, setPyDownloading] = useState(false)

  // Python 依赖（venv 安装向导）
  const [packagesText, setPackagesText] = useState((initial.pythonPackages ?? []).join('\n'))
  const pyEnv = usePythonEnv(initial.id, initial.runtime ?? 'binary')

  /** 当前输入框里的依赖行（去空行，不去注释——交给后端统一校验） */
  const packageLines = packagesText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  /** 已保存到 DB 的依赖行 */
  const savedPackageLines = initial.pythonPackages ?? []
  const packagesDirty =
    packageLines.join('\n') !== savedPackageLines.join('\n')

  const handleInstall = async () => {
    setError('')
    const errMsg = await pyEnv.install(packageLines, packagesDirty)
    if (errMsg) setError(errMsg)
  }

  const loadPyRuntimes = async () => {
    setPyLoading(true)
    try {
      setPyRuntimes(await window.pocketai.listPythonRuntimes())
    } catch {
      setPyRuntimes([])
    } finally {
      setPyLoading(false)
    }
  }

  useEffect(() => {
    if (runtime === 'python') void loadPyRuntimes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime])

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('agent.nameRequired'))
      return
    }
    let args: string[] = []
    let env: Record<string, string> = {}
    try {
      const parsed = JSON.parse(argsText)
      if (Array.isArray(parsed)) args = parsed.map(String)
      else throw new Error(t('agent.argsArray'))
    } catch (e) {
      setError(t('agent.argsFail', { e: (e as Error).message }))
      return
    }
    try {
      const parsed = JSON.parse(envText)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        env = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
      } else throw new Error(t('agent.envObject'))
    } catch (e) {
      setError(t('agent.envFail', { e: (e as Error).message }))
      return
    }

    setSaving(true)
    try {
      const saved = await window.pocketai.saveMcpServer({
        ...(initial.id ? { id: initial.id } : {}),
        name: name.trim(),
        transport,
        runtime: transport === 'stdio' ? runtime : 'binary',
        command: transport === 'stdio' ? command.trim() : null,
        args: transport === 'stdio' ? args : [],
        env: transport === 'stdio' ? env : {},
        url: transport === 'http' ? url.trim() || null : null,
        // 仅 stdio+python 保留依赖列表；repo 层也会兜底归一化
        pythonPackages:
          transport === 'stdio' && runtime === 'python' ? packageLines : [],
        enabled
      } as any)
      onSaved(saved)
      // 已存在的 server 保存后表单不会重挂（key 不变），依赖列表变化时必须主动重查，
      // 否则状态行仍显示旧的 ready，用户看不到 stale 提示
      if (saved.id && saved.runtime === 'python') {
        const errMsg = await pyEnv.refresh()
        if (errMsg) setError(errMsg)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const { envState, envEvents, installing, envLogRef } = pyEnv

  return (
    <div className="space-y-3 max-w-xl">
      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.name')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.transport')}</label>
        <select className="select-mini w-full" value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}>
          <option value="stdio">{t('agent.f.stdio')}</option>
          <option value="http">{t('agent.f.http')}</option>
        </select>
      </div>
      {transport === 'stdio' ? (
        <>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.runtime')}</label>
            <select
              className="select-mini w-full"
              value={runtime}
              onChange={(e) => {
                const r = e.target.value as McpRuntime
                setRuntime(r)
                // 切换运行时给一个合理的默认 command
                if (r === 'node') setCommand('node')
                else if (r === 'binary' && !command) setCommand('')
              }}
            >
              <option value="binary">{t('agent.f.runtimeBinary')}</option>
              <option value="node">{t('agent.f.runtimeNode')}</option>
              <option value="python">{t('agent.f.runtimePython')}</option>
            </select>
          </div>

          {runtime === 'python' && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{t('agent.f.pythonRuntimes')}</span>
                <div className="flex gap-1">
                  <button className="btn-ghost text-[11px] py-0.5 px-2" onClick={() => void loadPyRuntimes()} disabled={pyLoading}>
                    {pyLoading ? t('common.loading') : t('agent.f.pythonDetect')}
                  </button>
                  <button
                    className="btn-ghost text-[11px] py-0.5 px-2"
                    onClick={async () => {
                      setPyDownloading(true)
                      try {
                        const rt = await window.pocketai.downloadPortablePython()
                        setPyRuntimes((prev) => [rt, ...prev])
                        setCommand(rt.path)
                      } catch (e) {
                        setError(t('agent.f.pythonDownloadFail', { e: (e as Error).message }))
                      } finally {
                        setPyDownloading(false)
                      }
                    }}
                    disabled={pyDownloading}
                  >
                    {pyDownloading ? t('agent.f.pythonDownloading') : t('agent.f.pythonDownload')}
                  </button>
                </div>
              </div>
              {pyRuntimes.length === 0 ? (
                <p className="text-[11px] text-[var(--color-text-muted)]">{t('agent.f.pythonEmpty')}</p>
              ) : (
                <select
                  className="select-mini w-full"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                >
                  <option value="">{t('agent.f.pythonSelect')}</option>
                  {pyRuntimes.map((r) => (
                    <option key={r.path} value={r.path}>
                      {r.name} — {r.path}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {runtime === 'python' && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-2">
              <div>
                <label className="block text-xs font-medium mb-1">{t('agent.f.pythonPackages')}</label>
                <textarea
                  className="input font-mono text-xs min-h-[64px]"
                  value={packagesText}
                  onChange={(e) => setPackagesText(e.target.value)}
                  placeholder={t('agent.f.pythonPackagesPh')}
                  spellCheck={false}
                />
                <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{t('agent.f.pythonPackagesHint')}</p>
              </div>

              {/* 环境状态行 */}
              <div className="flex items-center gap-2 text-[11px] flex-wrap">
                <span className="text-[var(--color-text-muted)]">{t('agent.f.pythonEnvStatus')}</span>
                {(() => {
                  const st = envState?.status
                  const map = {
                    none: { text: t('agent.f.pythonEnvNone'), cls: 'text-[var(--color-text-muted)]' },
                    installing: { text: t('agent.f.pythonEnvInstalling'), cls: 'text-[var(--color-warning)]' },
                    ready: {
                      text: t('agent.f.pythonEnvReady', {
                        version: envState?.pythonVersion || '?',
                        n: envState?.installedPackages.length ?? 0
                      }),
                      cls: 'text-[var(--color-success)]'
                    },
                    stale: { text: t('agent.f.pythonEnvStale'), cls: 'text-[var(--color-danger)]' }
                  } as const
                  const cur = (st ?? 'none') as keyof typeof map
                  return <span className={`font-medium ${map[cur].cls}`}>● {map[cur].text}</span>
                })()}
              </div>

              {packagesDirty && initial.id && (
                <p className="text-[11px] text-[var(--color-warning)]">{t('agent.f.pythonInstallSaveFirst')}</p>
              )}

              <div>
                <button
                  className="btn-ghost text-[11px] py-1 px-2"
                  onClick={() => void handleInstall()}
                  disabled={
                    installing ||
                    envState?.status === 'installing' ||
                    !initial.id ||
                    packageLines.length === 0 ||
                    packagesDirty
                  }
                  title={!initial.id ? t('agent.f.pythonInstallNeedSave') : undefined}
                >
                  {installing
                    ? t('agent.f.pythonInstalling')
                    : envState?.status === 'ready' || envState?.status === 'stale'
                      ? t('agent.f.pythonReinstall')
                      : t('agent.f.pythonInstall')}
                </button>
                {!initial.id && (
                  <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">
                    {t('agent.f.pythonInstallNeedSave')}
                  </span>
                )}
              </div>

              {envEvents.length > 0 && (
                <div>
                  <div className="text-[11px] text-[var(--color-text-muted)] mb-1">
                    {t('agent.f.pythonEnvLogTitle')}
                  </div>
                  <div
                    ref={envLogRef}
                    className="max-h-40 overflow-y-auto bg-[var(--color-input-bg)] rounded p-2 font-mono text-[10px] leading-relaxed space-y-0.5"
                  >
                    {envEvents.map((ev, i) => {
                      const stageText =
                        ev.stage === 'venv'
                          ? t('agent.f.pythonStageVenv')
                          : ev.stage === 'pip'
                            ? t('agent.f.pythonStagePip')
                            : ev.stage === 'done'
                              ? t('agent.f.pythonStageDone')
                              : t('agent.f.pythonStageError')
                      const line = ev.line ?? ev.message ?? ''
                      return (
                        <div
                          key={i}
                          className={
                            ev.stage === 'error'
                              ? 'text-[var(--color-danger)]'
                              : ev.stage === 'done'
                                ? 'text-[var(--color-success)]'
                                : ''
                          }
                        >
                          <span className="text-[var(--color-text-muted)]">[{stageText}]</span>{' '}
                          {line}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.command')}</label>
            <input className="input font-mono text-xs" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('agent.f.commandPh')} />
            {runtime === 'python' && (
              <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{t('agent.f.pythonCommandHint')}</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.args')}</label>
            <textarea
              className="input font-mono text-xs min-h-[80px]"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={ARGS_PLACEHOLDER}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('agent.f.env')}</label>
            <textarea
              className="input font-mono text-xs min-h-[80px]"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={ENV_PLACEHOLDER}
            />
          </div>
        </>
      ) : (
        <div>
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">URL</label>
          <input className="input font-mono text-xs" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
          <p className="text-[11px] text-[var(--color-warning)] mt-1">{t('agent.f.httpWarn')}</p>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('common.enable')}
      </label>
      {error && <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 rounded">{error}</div>}
      <div className="flex gap-2 pt-1">
        <button className="btn-primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}
