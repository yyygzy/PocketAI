// 最终回答里的 ```html 代码块操作：存沙箱临时文件 / 安装为迷你应用
import React, { useState } from 'react'
import { useI18n } from '../../../i18n'
import { SANDBOX_MAX_DESC_CHARS, SANDBOX_MAX_NAME_CHARS } from '../../../../../shared/schemas/sandbox'
import { useToast } from '../../../components/ToastProvider'
import { requestSandboxOpenApps } from '../../sandbox/SandboxModule'
import { errText } from '../../../utils/error'
import { hasIpcFailed, ipcFailText } from '../../../utils/ipc'

export const HtmlBlockActions: React.FC<{ htmlBlock: string }> = ({ htmlBlock }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [savedToSandbox, setSavedToSandbox] = useState(false)
  const [installingApp, setInstallingApp] = useState(false)
  // 安装请求进行中（防连点重复创建同名应用）
  const [installBusy, setInstallBusy] = useState(false)
  const [appName, setAppName] = useState('')
  const [appIcon, setAppIcon] = useState('📦')
  const [appDesc, setAppDesc] = useState('')

  const saveToSandbox = async () => {
    try {
      const saved = await window.pocketai.createSandboxFile(t('sandbox.agentDefaultName'), htmlBlock)
      // 失败不判就把按钮置成「✓ 已存入沙箱」并 disabled ⇒ 既没存成也再也点不动（§216）
      if (hasIpcFailed(saved)) {
        toast.error(ipcFailText(saved, t('common.unknownError')))
        return
      }
      setSavedToSandbox(true)
    } catch (err) {
      toast.error(errText(err))
    }
  }

  const openInstall = () => {
    setAppName(t('sandbox.agentDefaultName'))
    setAppIcon('📦')
    setAppDesc('')
    setInstallingApp(true)
  }

  const installAsApp = async () => {
    if (installBusy) return
    setInstallBusy(true)
    try {
      const installed = await window.pocketai.createSandboxFile(appName, htmlBlock, {
        icon: appIcon,
        description: appDesc,
        isApp: true
      })
      // 失败不判就是"安装表单关掉、按钮打勾、跳过去的应用库是空的"（§216）
      if (hasIpcFailed(installed)) {
        toast.error(ipcFailText(installed, t('common.unknownError')))
        return
      }
      setInstallingApp(false)
      setSavedToSandbox(true)
      // 跳转沙箱模块并直接落到应用库视图
      requestSandboxOpenApps()
      window.dispatchEvent(
        new CustomEvent('pocketai:switch-module', { detail: { moduleId: 'sandbox' } })
      )
    } catch (err) {
      toast.error(errText(err))
    } finally {
      setInstallBusy(false)
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <button
        className="btn-ghost text-[11px]"
        disabled={savedToSandbox}
        onClick={() => void saveToSandbox()}
        title={t('sandbox.runInSandboxTip')}
      >
        {savedToSandbox ? `✓ ${t('sandbox.savedToSandbox')}` : `▶ ${t('sandbox.runInSandbox')}`}
      </button>
      <button
        className="btn-ghost text-[11px]"
        disabled={savedToSandbox}
        onClick={openInstall}
        title={t('miniapp.installTip')}
      >
        📦 {t('miniapp.install')}
      </button>

      {installingApp && (
        <div className="w-full mt-1 p-2 rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] space-y-1.5">
          <div className="flex items-center gap-1.5">
            <input
              className="input-mini w-10 text-center"
              value={appIcon}
              maxLength={4}
              onChange={(e) => setAppIcon(e.target.value)}
            />
            <input
              className="input-mini flex-1"
              value={appName}
              maxLength={SANDBOX_MAX_NAME_CHARS}
              onChange={(e) => setAppName(e.target.value)}
              placeholder={t('sandbox.namePlaceholder')}
            />
          </div>
          <textarea
            className="input-mini w-full h-12 resize-none text-[11px]"
            placeholder={t('miniapp.descPlaceholder')}
            value={appDesc}
            maxLength={SANDBOX_MAX_DESC_CHARS}
            onChange={(e) => setAppDesc(e.target.value)}
          />
          <div className="flex justify-end gap-1">
            <button className="btn-ghost text-[11px]" onClick={() => setInstallingApp(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="text-[11px] px-2 py-0.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-50"
              disabled={installBusy}
              onClick={() => void installAsApp()}
            >
              {installBusy ? t('common.saving') : t('miniapp.installConfirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
