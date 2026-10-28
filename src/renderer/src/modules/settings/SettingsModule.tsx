import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppPaths,
  EncryptionStatus,
  BackupScheduleStatus,
  ChatFontSize,
  LicenseStatus,
  PopupConfig,
  UpdateInfo,
  UpdateEvent,
  WebDAVConfig,
  WebDAVBackupFile
} from '../../../../shared/types'
import { ProviderSettings, Notice } from './ProviderSettings'
import { UserMemoryPanel } from './UserMemoryPanel'
import { UsagePanel } from './UsagePanel'
import { DataHealthPanel } from './DataHealthPanel'
import { OllamaPanel } from '../../components/OllamaPanel'
import { LocalJudgementPanel } from './LocalJudgementPanel'
import { useI18n } from '../../i18n'
import { injectCustomCss } from '../../custom-css'
import { applyChatFontSize, normalizeFontSize } from '../../chat-font'
import { MAX_CODE_COLLAPSE_LINES, normalizeCodeCollapseLines, setCodeCollapseLines } from '../../code-collapse'
import { CODE_COLLAPSE_THRESHOLD } from '../../utils/code-block'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { useTransientNotice } from '../../hooks/useTransientNotice'
import { hasIpcFailed, ipcFailText, logIpcError, reportIpcError } from '../../utils/ipc'
import { createEncryptionStatusSyncer } from '../../utils/lock-flags'
import { createLicenseStatusSyncer } from '../../utils/license-copy'
import { errText } from '../../utils/error'
import { safeHttpHref } from '../../utils/external-url'
import { EmptyState } from '../../components/EmptyState'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { StaleValueNotice } from '../../components/StaleValueNotice'
import { ShowingDefaultsNotice } from '../../components/ShowingDefaultsNotice'
import { useConfirm } from '../../components/ConfirmDialog'
import { useToast } from '../../components/ToastProvider'
import { modLabel } from '../../utils/shortcuts'
import { NEW_MASTER_PASSWORD_MIN } from '../../../../shared/schemas/encryption'
import { isWebdavPasswordUsable } from '../../../../shared/schemas/backup'
import { pickLatestBackup } from '../../../../shared/backup-latest'

// ─── 键盘快捷键速查（只读，应用内固定快捷键） ────────────────────────────
const ShortcutHelpPanel: React.FC = () => {
  const { t } = useI18n()
  const mod = modLabel()
  const rows: Array<[string, string]> = [
    [t('set.shortcuts.module'), `${mod}+1 … ${mod}+9`],
    [t('set.shortcuts.settings'), `${mod}+,`],
    [t('set.shortcuts.lock'), `${mod}+L`],
    [t('set.shortcuts.newConv'), `${mod}+N`],
    [t('set.shortcuts.search'), `${mod}+K`],
    [t('set.shortcuts.composer'), `${mod}+/`],
    [t('set.shortcuts.abort'), 'Esc']
  ]
  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
        {rows.map(([label, keys], i) => (
          <div
            key={label}
            className={`flex items-center justify-between px-3 py-2 text-xs ${i % 2 ? 'bg-[var(--color-surface)]' : ''}`}
          >
            <span className="text-[var(--color-text)]">{label}</span>
            <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-muted)]">
              {keys}
            </kbd>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">{t('set.shortcuts.hint')}</p>
    </div>
  )
}

/** 对话设置：智能标题开关（首条消息后用模型生成短标题） */
// §354：为了那颗「重试」的判据能真挂载演一遍而导出（原来只有本页挂载点，整页夹具要预置十几条通道）
export const ConversationSettingsPanel: React.FC = () => {
  const { t } = useI18n()
  // null=尚未加载，避免开关初始闪烁
  const [enabled, setEnabled] = useState<boolean | null>(null)
  // §251：这一读失败时开关只是 disabled（屏上像"还在加载"），所以原因要落到界面上（闸门第四面的判据）
  const [titleErr, setTitleErr] = useState<string | null>(null)

  // §354：这一发从挂载 effect 体内联抽成具名 loader——「读不到」那张脸要出口，而按下去必须真再发一发
  // （§350 第二档的口径：先抽 loader 再配键，否则键点了等于没按）。行为逐字不变，effect 只是改成调它。
  const loadEnabled = useCallback(() => {
    window.pocketai
      .getSmartTitleEnabled()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setTitleErr(ipcFailText(v, t('common.unknownError')))
          return
        }
        setTitleErr(null)
        setEnabled(v)
      })
      .catch((e: unknown) => {
        setTitleErr(errText(e, t('common.unknownError')))
        logIpcError('settings.getSmartTitle', e)
      })
  }, [t])

  useEffect(() => {
    loadEnabled()
  }, [loadEnabled])

  const toggle = async () => {
    const next = !enabled
    setEnabled(next) // 乐观更新
    try {
      await window.pocketai.setSmartTitleEnabled(next)
    } catch (e) {
      setEnabled(!next)
      reportIpcError('settings.setSmartTitle')(e)
    }
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="py-1">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[var(--color-text)]">{t('set.smartTitle')}</div>
            <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{t('set.smartTitleHint')}</div>
          </div>
          <button
            role="switch"
            aria-checked={!!enabled}
            disabled={enabled === null}
            onClick={() => void toggle()}
            className={`relative shrink-0 w-9 h-5 rounded-full transition-colors disabled:opacity-50 ${
              enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-4' : ''
              }`}
            />
          </button>
        </div>
        {/* §354：这一支同屏什么都没有（那颗开关在 `enabled === null` 时是 disabled，而 toggle 只写不读）⇒ 一句一键 */}
        {titleErr && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <LoadFailNotice msg={titleErr} />
            <button data-testid="smart-title-read-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={() => void loadEnabled()}>
              {t('agent.retryRead')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// §344：设置页那一份「主进程加密态」副本（EncryptionPanel 与 BackupPanel 都要读整块，不只 dbEncrypted）。
// 它有三个读点：挂载首发、锁屏事件重读、面板动作后刷新（启用／改口令／关闭／锁定都调 onChange）。
// 三处各写各的时，谁先落地没有保证——那颗「关掉加密」的写点就在面板动作里，若锁屏事件那一发（改前的值）
// 迟到，面板会被画回「已加密＋已解锁」，那一格上还挂着改口令／关闭加密两颗键，用户照着点就去动一个已经变明文的库。
// 所以三发共用一份带代次守卫的同步器（口径同 §342：只有最新那一发能写回）。
// 抽成 hook 是为了让"三发共用同一个代次计数器"这件事能被真挂载用例演出来：
// 同步器若写成每次 render 都重建（守卫立刻没牙），源码判据看不出来，重挂载一次就能红。
export function useEncryptionCopy(): { enc: EncryptionStatus | null; err: string | null; refresh: () => void } {
  const { t } = useI18n()
  const [enc, setEnc] = useState<EncryptionStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const tRef = useRef(t)
  tRef.current = t
  const syncRef = useRef<(() => Promise<void>) | null>(null)
  if (!syncRef.current) {
    syncRef.current = createEncryptionStatusSyncer({ setStatus: setEnc, setErr, t: (k) => tRef.current(k) })
  }
  const syncEnc = syncRef.current
  useEffect(() => {
    void syncEnc()
    // 锁屏遮罩不卸载本模块：解锁后 masterPasswordVerified 会变化，需重新拉取
    return window.pocketai.onLockStateChange(() => {
      void syncEnc()
    })
  }, [])
  return { enc, err, refresh: () => { void syncEnc() } }
}

// §346：许可证那份副本同样有两个读者（挂载那一发＋面板四个动作与 §345 那颗重试键共用的重取），
// 并发窗口与危害都写在 utils/license-copy.ts 的头部——一句话版：`busy` 只挡动作本身，
// 动作成功后那一发重读在飞时键已经能再点，于是"换一份许可证再激活"会让迟到的旧读数
// 把面板画回**已被覆盖的那份**（plan／持有人／到期日都是旧的）。
// 所以两发共用一份带代次守卫的同步器；形状照 §344：同步器挂 ref（每帧重造＝守卫没牙），
// `t` 走 ref 现读（换语言后失败话术跟界面走），失败侧只报原因、不动旧值。
export function useLicenseCopy(): { lic: LicenseStatus | null; err: string | null; refresh: () => void } {
  const { t } = useI18n()
  const [lic, setLic] = useState<LicenseStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const tRef = useRef(t)
  tRef.current = t
  const syncRef = useRef<(() => Promise<void>) | null>(null)
  if (!syncRef.current) {
    syncRef.current = createLicenseStatusSyncer({ setStatus: setLic, setErr, t: (k) => tRef.current(k) })
  }
  const syncLic = syncRef.current
  useEffect(() => {
    void syncLic()
  }, [])
  return { lic, err, refresh: () => { void syncLic() } }
}

export const SettingsModule: React.FC = () => {
  const { t } = useI18n()
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const encCopy = useEncryptionCopy()
  const licCopy = useLicenseCopy()
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateEvent>({ status: 'idle' })
  // §225：加密／许可证／更新这三块面板的数据都在本页挂载时一次拉走，读失败的原因得跟着数据一起交下去。
  // 不交的话，面板自己的门是 `if (!x) return 加载中…`，于是"这次没读到"被长期说成"还在加载"（§222 立的那一面）。
  // §346：许可证那一份（数据＋原因）搬进 licCopy——它有两个读者，不能再摆成两处各写各的 state。
  const [pathsErr, setPathsErr] = useState<string | null>(null)
  const [updErr, setUpdErr] = useState<string | null>(null)

  // §354：这两发从挂载 effect 体内联抽成具名 loader，好让两张「读不到」的脸各有一颗按下去真再发一发的键。
  // 依赖**照旧写死 `[]`**（原文就是这样，`t` 只捕获挂载那一刻那份）——改成 `[t]` 会让 effect 在换语言时
  // 重跑一次、连带重订一遍 `onUpdateEvent`，那是本批不该带来的行为变化。
  const loadPaths = useCallback(() => {
    window.pocketai
      .getPaths()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setPathsErr(ipcFailText(v, t('common.unknownError')))
          return
        }
        setPathsErr(null)
        setPaths(v)
      })
      .catch((e: unknown) => {
        setPathsErr(errText(e, t('common.unknownError')))
        logIpcError('settings.getPaths', e)
      })
  }, [])

  const loadUpdateInfo = useCallback(() => {
    window.pocketai.getUpdateInfo().then((v) => {
      if (hasIpcFailed(v)) { setUpdErr(ipcFailText(v, t('common.unknownError'))); return }
      setUpdateInfo(v)
    }).catch((e) => { setUpdErr(errText(e, t('common.unknownError'))); logIpcError('settings.getUpdateInfo', e) })
  }, [])

  useEffect(() => {
    loadPaths()
    // §346：许可证那一发挪进 useLicenseCopy()——挂在挂载那一发与面板动作那一发是同一个计数器，
    // 写在这里就又多了一个没有守卫的读者
    loadUpdateInfo()
    // 监听主进程推送的更新状态事件
    const unsub = window.pocketai.onUpdateEvent((data) => {
      setUpdateStatus(data)
    })
    return unsub
  }, [loadPaths, loadUpdateInfo])

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto">
        <ProviderSettings />

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.usage')}</h3>
          <UsagePanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.dataHealth')}</h3>
          <DataHealthPanel />
        </div>

        <div className="mt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.localModel')}</h3>
          <OllamaPanel />
        </div>

        {/* 本机判据（V4-Iter-146）：紧跟「本地模型」——这块屏解释的正是"这台机器被允许怎么跑"，
            放在服务商那屏旁边会被读成"某台模型的属性"，而它一半是硬件、一半是助手级事实 */}
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.localJudgement')}</h3>
          <LocalJudgementPanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.encryption')}</h3>
          <EncryptionPanel enc={encCopy.enc} err={encCopy.err} onChange={encCopy.refresh} />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.backup')}</h3>
          <BackupPanel enc={encCopy.enc} />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.update')}</h3>
          <UpdatePanel info={updateInfo} err={updErr} status={updateStatus} onReloadInfo={loadUpdateInfo} />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.network')}</h3>
          <NetworkPanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.popup')}</h3>
          <PopupPanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.shortcuts.title')}</h3>
          <ShortcutHelpPanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.chat')}</h3>
          <ConversationSettingsPanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.appearance')}</h3>
          <AppearancePanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.memory')}</h3>
          <UserMemoryPanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.license')}</h3>
          {/* §346：面板那四颗动作键与 §345 那颗「重试」都调 onChange＝同一个 refresh，
              与挂载那一发共用同一份代次计数器（原来这里是第二处自己 `.then(落值)` 的裸读） */}
          <LicensePanel lic={licCopy.lic} err={licCopy.err} onChange={licCopy.refresh} />
        </div>
      </div>

      {!paths && pathsErr && (
        <div className="shrink-0 border-t border-[var(--color-border)] pt-3 mt-3">
          <h3 className="text-xs font-semibold text-[var(--color-text-muted)] mb-2">{t('set.paths')}</h3>
          {/* §354：这一支整块只剩这一句（那四行路径要在 `paths` 到手后才画）⇒ 同级给一颗重读这一发的键 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <LoadFailNotice msg={pathsErr} />
            <button data-testid="paths-read-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={() => void loadPaths()}>
              {t('agent.retryRead')}
            </button>
          </div>
        </div>
      )}
      {paths && (
        <div className="shrink-0 border-t border-[var(--color-border)] pt-3 mt-3">
          <h3 className="text-xs font-semibold text-[var(--color-text-muted)] mb-2">{t('set.paths')}</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
            <PathRow label={t('set.dataDir')} value={paths.dataDir} />
            <PathRow label={t('set.dbPath')} value={paths.dbPath} />
            <PathRow label={t('set.attachments')} value={paths.attachmentsDir} />
            <PathRow label={t('set.extensions')} value={paths.extensionsDir} />
          </div>
        </div>
      )}
    </div>
  )
}

const PathRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-2">
    <span className="text-[var(--color-text-muted)] shrink-0">{label}</span>
    <span className="font-mono truncate" title={value}>
      {value}
    </span>
  </div>
)

// ─── Modal 弹层（统一弹层）─────────────────────────────────────

const Modal: React.FC<{ open: boolean; title: string; onClose: () => void; children: React.ReactNode; width?: number }> = ({ open, title, onClose, children, width = 360 }) => {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm" onClick={onClose}>
      <div
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl p-5"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold">{title}</h4>
          <button className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg leading-none" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ─── 加密面板 ───────────────────────────────────────────────────

export const EncryptionPanel: React.FC<{ enc: EncryptionStatus | null; err: string | null; onChange: () => void }> = ({ enc, err, onChange }) => {
  const { t } = useI18n()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  if (!enc) {
    // §225：读失败与还没读到是两件事（§222 那一面在这里的落点）
    // §352：早退 return＝整块面板（含改口令／关闭加密那几颗键）换成这一句，同屏没有出口；
    //         `onChange` 就是父级那份 `useEncryptionCopy` 的 refresh（与 §351 许可证那处同形）
    if (err)
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice msg={err} />
          <button
            data-testid="encryption-read-retry"
            className="text-xs underline text-[var(--color-text-muted)]"
            onClick={onChange}
          >
            {t('agent.retryRead')}
          </button>
        </div>
      )
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const encrypted = enc.dbEncrypted
  const unlocked = enc.unlocked

  return (
    <div className="space-y-3">
      {/* §345：这份副本有三个读者（挂载／锁屏事件／面板动作后刷新），重读失败时旧值留着是对的，
          但原因得有出口——否则屏上继续画「已加密＋已解锁」，那一格上还挂着改口令／关闭加密两颗键 */}
      {err && <StaleValueNotice what={t('enc.dbEnc')} msg={err} onRetry={onChange} testid="enc-stale-retry" />}
      <StatusRow label={t('enc.dbEnc')} value={encrypted ? t('enc.enabled') : t('enc.disabled')} ok={encrypted} />
      <StatusRow label={t('enc.status')} value={unlocked ? t('enc.unlocked') : t('enc.locked')} ok={unlocked} />
      <StatusRow label={t('enc.field')} value={encrypted ? t('enc.fieldValue') : t('enc.fieldValueNone')} ok={encrypted} />
      {encrypted && enc.kdfN != null && (
        <StatusRow label={t('enc.kdf')} value={t('enc.kdfValue', { tier: Math.log2(enc.kdfN) })} ok={enc.kdfAtCurrentTier} />
      )}
      {encrypted && !enc.kdfAtCurrentTier && (
        <p className="unlock-recovery-warn">{t('enc.kdfUpgradeHint')}</p>
      )}

      {!encrypted && <p className="unlock-recovery-warn mb-2">{t('enc.noneWarn')}</p>}
      <AutoLockRow encrypted={encrypted} />

      <div className="flex flex-wrap gap-2 pt-1">
        {!encrypted && <EnableEncryptionBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && unlocked && <ChangePasswordBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && unlocked && <DisableEncryptionBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && !unlocked && <LockBtn onDone={onChange} />}
      </div>

      {encrypted && unlocked && <RecoveryKeyCard setNotice={setNotice} />}

      {notice && <Notice ok={notice.ok} text={notice.text} />}

      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-1">
        {encrypted ? t('enc.hint') : t('enc.hintNone')}
      </p>
    </div>
  )
}

const StatusRow: React.FC<{ label: string; value: string; ok?: boolean }> = ({ label, value, ok }) => (
  <div className="flex items-center gap-2 text-xs">
    <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]'}`} />
    <span className="text-[var(--color-text-muted)] w-32 shrink-0 whitespace-nowrap">{label}</span>
    <span className={ok ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}>{value}</span>
  </div>
)

// 自动锁屏超时选项（ms）；0=永不
const AUTO_LOCK_OPTIONS = [0, 60_000, 300_000, 900_000, 1_800_000, 3_600_000]

const AutoLockRow: React.FC<{ encrypted: boolean }> = ({ encrypted }) => {
  const { t } = useI18n()
  const [value, setValue] = useState<number | null>(null)
  // §227：读失败时 select 显示的是 AUTO_LOCK_OPTIONS 的第一档「永不」，而那正是未配置时的默认值
  //（app-config.repo.ts:265 是 `v ? Number(v) : 0`）⇒ 这句"显示的是默认值"说得出，但必须说出来
  const [readErr, setReadErr] = useState<string | null>(null)
  // §228：这颗下拉是"先乐观拨状态再写库"的形状，而这一发现在真的要落库（过去只改内存）
  // ⇒ 留住上一次读到的真值好回滚；写失败必须说话（§224 那一族的第三形状）
  const lastKnown = useRef(0)
  const [writeErr, setWriteErr] = useState<string | null>(null)
  const { notice: saved, show: markSaved, clear: clearSaved } = useTransientNotice<boolean>(1500)

  useEffect(() => {
    window.pocketai
      .getLockStatus()
      .then((s) => {
        if (hasIpcFailed(s)) {
          setReadErr(ipcFailText(s, t('common.unknownError')))
          return
        }
        lastKnown.current = s.autoLockTimeout ?? 0
        setValue(lastKnown.current)
      })
      .catch((e: unknown) => {
        // §227：原来这一支直接把 0 写回 state——那是把"没读到"演成"读到的是永不"，还顺手解除了 disabled
        setReadErr(errText(e, t('common.unknownError')))
        logIpcError('settings.getLockStatus', e)
      })
  }, [])

  const label = (ms: number) =>
    ms === 0 ? t('enc.autoLockNever') : ms === 3_600_000 ? t('enc.autoLockHour') : t('enc.autoLockMin', { n: Math.round(ms / 60_000) })

  async function change(ms: number) {
    setValue(ms)
    clearSaved()
    setWriteErr(null)
    try {
      const r = await window.pocketai.setAutoLockTimeout(ms)
      // §228：这一发现在要落库（过去只改内存 ⇒ 设了 5 分钟、重启回到「永不」）。落库会真失败：
      // 这条通道在锁屏白名单里，而 db 模式锁屏时库是关着的。失败就回滚到上一次读到的真值——
      // 屏上留着新值就是"看着已生效、重启才发现没存上"，比不告诉用户更糟
      if (hasIpcFailed(r)) {
        const msg = ipcFailText(r, t('common.unknownError'))
        setWriteErr(msg)
        setValue(lastKnown.current)
        logIpcError('settings.setAutoLockTimeout', new Error(msg))
        return
      }
      if (r?.ok) {
        lastKnown.current = ms
        markSaved(true)
      }
    } catch (e) {
      setWriteErr(errText(e, t('common.unknownError')))
      setValue(lastKnown.current)
      logIpcError('settings.setAutoLockTimeout', e)
    }
  }

  return (
    <div className="space-y-1">
      {readErr && <ShowingDefaultsNotice what={t('enc.autoLock')} msg={readErr} />}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[var(--color-text-muted)] w-16">{t('enc.autoLock')}</span>
        <select
          className="input py-1 text-xs w-32"
          value={value ?? 0}
          disabled={value === null}
          onChange={(e) => change(Number(e.target.value))}
        >
          {AUTO_LOCK_OPTIONS.map((ms) => (
            <option key={ms} value={ms}>
              {label(ms)}
            </option>
          ))}
        </select>
        {saved && <span className="text-[11px] text-[var(--color-success)]">{t('enc.autoLockSaved')}</span>}
      </div>
      {writeErr && <Notice ok={false} text={t('common.opFailed', { msg: writeErr })} />}
      <div className="text-[11px] text-[var(--color-text-muted)] pl-[4.5rem]">{encrypted ? t('enc.autoLockDesc') : t('enc.autoLockDescNone')}</div>
    </div>
  )
}

type NoticeFn = (n: { ok: boolean; text: string } | null) => void

// ─── 加密操作按钮 ───────────────────────────────────────────────

const EnableEncryptionBtn: React.FC<{ onDone: () => void; setNotice: NoticeFn }> = ({ onDone, setNotice }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pwd, setPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [localErr, setLocalErr] = useState('')

  async function submit() {
    setLocalErr('')
    if (pwd.length < NEW_MASTER_PASSWORD_MIN) return setLocalErr(t('enc.pwdShort'))
    if (pwd !== confirm) return setLocalErr(t('enc.pwdMismatch'))
    setBusy(true)
    try {
      const r = await window.pocketai.enableEncryption(pwd)
      if (!r.ok) { setLocalErr(r.error ?? t('enc.enableFail')); return }
      setOpen(false); setPwd(''); setConfirm('')
      setNotice({ ok: true, text: t('enc.enabledOk') })
      onDone()
    } catch (e) {
      setLocalErr(errText(e, t('enc.fail')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="btn-primary" onClick={() => setOpen(true)}>{t('enc.enableBtn')}</button>
      <Modal open={open} title={t('enc.setPwdTitle')} onClose={() => !busy && setOpen(false)}>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          {t('enc.setPwdDesc')}<br />
          <span className="text-[var(--color-warning)]">{t('enc.setPwdWarn')}</span>
        </p>
        <Field label={t('enc.pwd')}>
          <input className="input" type="password" placeholder={t('enc.pwdPh')} value={pwd} onChange={e => setPwd(e.target.value)} autoFocus />
        </Field>
        <Field label={t('enc.confirm')}>
          <input className="input" type="password" placeholder={t('enc.confirmPh')} value={confirm} onChange={e => setConfirm(e.target.value)} />
        </Field>
        {localErr && <div className="text-xs text-[var(--color-danger)] mb-2">{localErr}</div>}
        <div className="flex gap-2 justify-end pt-2">
          <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? t('common.processing') : t('common.confirm')}</button>
        </div>
      </Modal>
    </>
  )
}

const ChangePasswordBtn: React.FC<{ onDone: () => void; setNotice: NoticeFn }> = ({ onDone, setNotice }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [localErr, setLocalErr] = useState('')
  const [rotatedCode, setRotatedCode] = useState('')

  async function submit() {
    setLocalErr('')
    if (newPwd.length < NEW_MASTER_PASSWORD_MIN) return setLocalErr(t('enc.newShort'))
    if (newPwd !== confirm) return setLocalErr(t('enc.pwdMismatch'))
    if (oldPwd === newPwd) return setLocalErr(t('enc.oldNewSame'))
    setBusy(true)
    try {
      const r = await window.pocketai.changePassword(oldPwd, newPwd)
      if (!r.ok) { setLocalErr(r.error ?? t('enc.oldWrong')); return }
      setOpen(false); setOldPwd(''); setNewPwd(''); setConfirm('')
      setNotice({ ok: true, text: t('enc.pwdUpdated') })
      onDone()  // ✅ 刷新加密状态
      // 之前生成过恢复码：rekey 后旧码失效，必须让用户保存新码
      if (r.recoveryCode) setRotatedCode(r.recoveryCode)
    } catch (e) {
      setLocalErr(errText(e, t('enc.fail')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="btn-ghost" onClick={() => setOpen(true)}>{t('enc.changePwd')}</button>
      <Modal open={open} title={t('enc.changeTitle')} onClose={() => !busy && setOpen(false)}>
        <Field label={t('enc.currentPwd')}>
          <input className="input" type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} autoFocus />
        </Field>
        <Field label={t('enc.newPwd')}>
          <input className="input" type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} />
        </Field>
        <Field label={t('enc.confirmNew')}>
          <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} />
        </Field>
        {localErr && <div className="text-xs text-[var(--color-danger)] mb-2">{localErr}</div>}
        <div className="flex gap-2 justify-end pt-2">
          <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? t('common.processing') : t('common.confirm')}</button>
        </div>
      </Modal>
      {rotatedCode && (
        <RecoveryCodeModal
          code={rotatedCode}
          title={t('enc.recoveryRotatedTitle')}
          onClose={() => setRotatedCode('')}
        />
      )}
    </>
  )
}

const DisableEncryptionBtn: React.FC<{ onDone: () => void; setNotice: NoticeFn }> = ({ onDone, setNotice }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [localErr, setLocalErr] = useState('')

  async function submit() {
    setLocalErr('')
    if (!pwd) return setLocalErr(t('enc.enterCurrent'))
    setBusy(true)
    try {
      const r = await window.pocketai.disableEncryption(pwd)
      if (!r.ok) { setLocalErr(r.error ?? t('enc.pwdWrong')); return }
      setOpen(false); setPwd('')
      setNotice({ ok: true, text: t('enc.disabledOk') })
      onDone()
    } catch (e) {
      setLocalErr(errText(e, t('enc.fail')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="btn-ghost text-[var(--color-danger)] hover:opacity-80" onClick={() => setOpen(true)}>{t('enc.disable')}</button>
      <Modal open={open} title={t('enc.disableTitle')} onClose={() => !busy && setOpen(false)}>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          {t('enc.disableDesc')}
        </p>
        <Field label={t('enc.currentPwd')}>
          <input className="input" type="password" value={pwd} onChange={e => setPwd(e.target.value)} autoFocus />
        </Field>
        {localErr && <div className="text-xs text-[var(--color-danger)] mb-2">{localErr}</div>}
        <div className="flex gap-2 justify-end pt-2">
          <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          <button className="btn-primary bg-[var(--color-danger)] hover:opacity-90" disabled={busy} onClick={submit}>
            {busy ? t('common.processing') : t('enc.confirmDisable')}
          </button>
        </div>
      </Modal>
    </>
  )
}

const LockBtn: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { t } = useI18n()
  const toast = useToast()
  async function lock() {
    try {
      await window.pocketai.lockEncryption()
      onDone()
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }
  return <button className="btn-ghost" onClick={lock}>{t('enc.lock')}</button>
}

// ─── 恢复密钥 ───────────────────────────────────────────────────

/** 恢复码一次性展示弹窗：复制 / 另存文件 / 确认已保存 */
const RecoveryCodeModal: React.FC<{ code: string; title: string; onClose: () => void }> = ({
  code,
  title,
  onClose
}) => {
  const { t } = useI18n()
  // 恢复码走主进程敏感剪贴板（30s 自动过期），反馈态 2s 后自动复位
  const sensitiveWriter = useCallback(async (text: string) => {
    const r = await window.pocketai.copySensitiveToClipboard(text)
    return r.ok
  }, [])
  const { copied, copy } = useCopyFeedback(2000, sensitiveWriter)
  const { notice: copyFailed, show: showCopyFailed } = useTransientNotice<boolean>(3000)
  const { notice: saveFailed, show: showSaveFailed } = useTransientNotice<boolean>(3000)
  return (
    <Modal open title={title} onClose={onClose}>
      <p className="text-xs text-[var(--color-warning)] mb-2">{t('enc.recoveryShowOnce')}</p>
      <textarea
        readOnly
        rows={3}
        value={code}
        onFocus={(e) => e.currentTarget.select()}
        className="input font-mono text-sm tracking-wider resize-none"
      />
      <div className="flex gap-2 my-3">
        <button
          className="btn-ghost"
          onClick={async () => {
            try {
              if (!(await copy(code))) showCopyFailed(true)
            } catch {
              // 恢复码复制失败必须提示：误以为已复制会导致无法找回数据
              showCopyFailed(true)
            }
          }}
        >
          {t('enc.recoveryCopy')}
        </button>
        <button
          className="btn-ghost"
          onClick={async () => {
            try {
              const r = await window.pocketai.saveRecoveryFile(code)
              // canceled＝用户在选择器里取消，不是失败；只有 ok:false 且非 canceled 才报错
              if (r.ok === false && !r.canceled) showSaveFailed(true)
            } catch {
              showSaveFailed(true)
            }
          }}
        >
          {t('enc.recoverySaveFile')}
        </button>
      </div>
      {copied && (
        <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
          {t('enc.clipboardAutoClear', { s: 30 })}
        </p>
      )}
      {copyFailed && (
        <p className="text-[11px] text-[var(--color-danger)] mb-2">{t('common.copyFailed')}</p>
      )}
      {saveFailed && (
        <p className="text-[11px] text-[var(--color-danger)] mb-2">{t('common.saveFailed')}</p>
      )}
      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mb-3">
        {t('enc.recoveryModalWarn')}
      </p>
      <div className="flex justify-end">
        <button className="btn-primary" onClick={onClose}>{t('enc.recoverySaved')}</button>
      </div>
    </Modal>
  )
}

const RecoveryKeyCard: React.FC<{ setNotice: NoticeFn }> = ({ setNotice }) => {
  const { t } = useI18n()
  const { confirm, dialog } = useConfirm()
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [shownCode, setShownCode] = useState('')

  const refresh = useCallback(
    () =>
      window.pocketai
        .hasRecoveryKey()
        .then((v) => {
          if (hasIpcFailed(v)) {
            setNotice({ ok: false, text: ipcFailText(v, t('common.unknownError')) })
            return
          }
          setHasKey(v)
        })
        .catch(reportIpcError('settings.hasRecoveryKey')),
    [t]
  )
  useEffect(() => {
    void refresh()
  }, [refresh])

  async function generate() {
    // 已有恢复码时重新生成会作废旧码，二次确认
    if (hasKey && !(await confirm({ message: t('enc.recoveryRegenConfirm'), danger: true }))) return
    setBusy(true)
    try {
      const r = await window.pocketai.generateRecoveryKey()
      if (!r.ok || !r.code) {
        setNotice({ ok: false, text: r.error ?? t('enc.recoveryGenFail') })
        return
      }
      setShownCode(r.code)
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!(await confirm({ message: t('enc.recoveryRemoveConfirm'), danger: true }))) return
    const r = await window.pocketai.disableRecoveryKey()
    // 不判就会 setNotice({ok:true,...})：说「恢复密钥已删除」而码还在库里（§216）
    if (hasIpcFailed(r)) {
      setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
      return
    }
    void refresh()
    setNotice({ ok: true, text: t('enc.recoveryRemoved') })
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3 mt-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-[var(--color-text)]">{t('enc.recoveryTitle')}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
            {hasKey ? t('enc.recoverySet') : t('enc.recoveryNotSet')}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button className="btn-ghost" disabled={busy} onClick={generate}>
            {hasKey ? t('enc.recoveryRegen') : t('enc.recoveryGenerate')}
          </button>
          {hasKey && (
            <button
              className="btn-ghost text-[var(--color-danger)] hover:opacity-80"
              disabled={busy}
              onClick={remove}
            >
              {t('enc.recoveryRemove')}
            </button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mt-2">
        {t('enc.recoveryDesc')}
      </p>
      {shownCode && (
        <RecoveryCodeModal
          code={shownCode}
          title={t('enc.recoveryModalTitle')}
          onClose={() => setShownCode('')}
        />
      )}

      {dialog}
    </div>
  )
}

// ─── 备份面板 ────────────────────────────────────────────────────

const INTERVAL_OPTIONS = [6, 12, 24, 48, 72, 168]
/** 全量备份保留份数选项：0=不自动清理 */
const RETENTION_OPTIONS = [0, 3, 5, 10, 20, 30]

/** 导出只为给用例真挂载（§262 起 WebDAV 配置那一读的行为判据）；运行期仍只由 SettingsModule 渲染 */
/**
 * §327：这一屏有三处要用「云端最新那一份」（状态格的时间、「哪边更新」那句、那颗「恢复最新一份」的键）。
 * 判据实现自 §338 起在 shared（主进程那条备份校验任务读同一份派生，不再各算一遍）；
 * 剔掉 NaN 的原因与探针读数记在 shared/backup-latest.ts。
 */
export const latestCloudBackup = pickLatestBackup

/** 读不出的时间／体积宁可空着，也不贴 0 或 Invalid Date（§217 那句「已打包 NaN MB」的同族） */
export function fmtCloudCellTime(ts: number): string {
  return Number.isFinite(ts) ? new Date(ts).toLocaleString() : '—'
}

export function fmtCloudCellSize(bytes: number): string {
  return Number.isFinite(bytes) ? `${(bytes / 1024).toFixed(1)} KB` : '—'
}
export const BackupPanel: React.FC<{ enc: EncryptionStatus | null }> = ({ enc }) => {
  const { t, lang } = useI18n()
  const { confirm, dialog } = useConfirm()
  // 加密备份唯一闸门是主进程 masterKeyManager.getDbKey()：
  // 仅 db 模式且已解锁（主密码已验证）时可用；none 模式与锁屏期间禁用
  const encrypted = !!enc?.dbEncrypted && !!enc?.masterPasswordVerified
  const [cfg, setCfg] = useState<WebDAVConfig | null>(null)
  /** 配置文件那一读失败的原因（§262）：`error` 为空＝拿到了但形状不对 */
  const [wdCfgUnread, setWdCfgUnread] = useState<{ error?: string } | null>(null)
  const [schedule, setSchedule] = useState<BackupScheduleStatus | null>(null)
  const [webdavList, setWebdavList] = useState<WebDAVBackupFile[]>([])
  const [listLoading, setListLoading] = useState(false)
  /** §324：列表读的代次——迟到那发不许把旧一次（或改地址前那台服务器）的清单画回当前屏 */
  const listSeqRef = useRef(0)
  const [wdUrl, setWdUrl] = useState('')
  const [wdUser, setWdUser] = useState('')
  const [wdPwd, setWdPwd] = useState('')
  const [wdDir, setWdDir] = useState('')
  /** §325：测试连接那发的代次——改了地址连测两次，先回的那条不许把结论盖到当前表单上 */
  const wdTestSeqRef = useRef(0)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  // 合并恢复状态
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeFilename, setMergeFilename] = useState('')
  const [mergeReport, setMergeReport] = useState<import('../../../../shared/types').MergeConflictReport | null>(null)
  const [mergeScanning, setMergeScanning] = useState(false)
  const [mergeExecuting, setMergeExecuting] = useState(false)
  // 异机合并：备份密码（扫描成功后沿用到执行阶段）
  const [mergePwd, setMergePwd] = useState('')
  /** §324：扫描的代次——只有最新发起那一发允许写冲突表、记住的密码与「还在扫描」 */
  const mergeScanSeqRef = useRef(0)

  // §354：这一发抽成具名 loader（原来整段写在挂载 effect 体内联）——`!cfg` 时那一屏只剩这一句，
  // 「保存」会把这份没人认领的空表单写回去（假出口），「测试连接」测的是连通性、不重读配置。
  const reloadCfg = useCallback(() => {
    window.pocketai.loadWebDAVConfig().then((c) => {
      // §262：这一发有三种到货——配置、null（真的还没配过）、失败对象（safeHandle 的 resolve，§196）。
      // 旧写法 `if (c)` 把第三种当第一种：cfg 是 `{ok:false}` 也是真值 ⇒ 「同步状态卡＋上传/增量/刷新」
      // 那一整块照常摆出来（探针实测屏上有「⬆️ 上传备份」「同步状态」「已同步」），四个输入框从 controlled
      // 变 uncontrolled（React 当场警告，URL 框成空串）——把"配置文件读不到"演成"你配过了，只是还没备份"。
      if (hasIpcFailed(c)) {
        setWdCfgUnread({ error: c.error })
        return
      }
      setWdCfgUnread(null)
      if (!c) return
      setCfg(c)
      setWdUrl(c.url); setWdUser(c.username); setWdDir(c.directory || '')
    }).catch((e: unknown) => {
      // reject 面（配置那台机器真抛了）：同一句，不让它只进 console
      setWdCfgUnread({ error: errText(e, '') })
      logIpcError('settings.loadWebDAVConfig', e)
    })
  }, [])

  useEffect(() => {
    reloadCfg()
    void loadSchedule()
  }, [reloadCfg])

  // §251：三处 getBackupSchedule（进面板、上传后、保存后）共用同一条接管——失败时那一块整块消失，
  // 用户会以为"没有定时备份这回事"，所以把原因落在备份计划区上方
  const [schedErr, setSchedErr] = useState<string | null>(null)
  /** §325：保存定时计划那发的代次——连点两颗开关时，先回的那条不许把面板回弹成旧一次的结果 */
  const schedSeqRef = useRef(0)
  const loadSchedule = useCallback(
    () =>
      window.pocketai
        .getBackupSchedule()
        .then((v) => {
          if (hasIpcFailed(v)) {
            setSchedErr(ipcFailText(v, t('common.unknownError')))
            return
          }
          setSchedErr(null)
          setSchedule(v)
        })
        .catch((e: unknown) => {
          setSchedErr(errText(e, t('common.unknownError')))
          logIpcError('settings.getBackupSchedule', e)
        }),
    [t]
  )

  const intervalLabel = (h: number): string => {
    if (lang === 'en') {
      return h === 24 ? 'Daily' : h === 48 ? 'Every 2 days' : h === 72 ? 'Every 3 days' : h === 168 ? 'Weekly' : `Every ${h} hours`
    }
    return h === 24 ? '每天' : h === 48 ? '每 2 天' : h === 72 ? '每 3 天' : h === 168 ? '每周' : `每 ${h} 小时`
  }

  async function saveSchedule(patch: { enabled?: boolean; intervalHours?: number; retentionCount?: number }) {
    const seq = ++schedSeqRef.current
    const next = await window.pocketai.setBackupSchedule(patch)
    // §325：连点两颗开关时两发写在飞，先回的那条既不许把计划回弹成旧值、也不许多说一句失败
    if (seq !== schedSeqRef.current) return
    // §217：失败对象没有 enabled/intervalHours ⇒ 面板把「定时备份」显示成一个不存在的计划
    if (hasIpcFailed(next)) {
      showNotice(false, ipcFailText(next, t('common.unknownError')))
      return
    }
    setSchedule(next)
  }

  const showNotice = (ok: boolean, text: string) => setNotice({ ok, text })

  async function saveWD() {
    if (!wdUrl || !wdUser) return showNotice(false, t('bk.urlUserRequired'))
    // 只校验用户真正输入过的口令：留空表示沿用已存值，主进程侧用同一把尺（shared 里那一个函数）
    if (wdPwd && !isWebdavPasswordUsable(wdPwd)) return showNotice(false, t('bk.pwdLatin1'))
    const c: WebDAVConfig = { url: wdUrl, username: wdUser, passwordCipher: wdPwd || cfg?.passwordCipher || '', directory: wdDir }
    const r = await window.pocketai.saveWebDAVConfig(c)
    if (r.ok === false) return showNotice(false, r.error || t('common.unknownError'))
    setCfg(c); showNotice(true, t('bk.cfgSaved'))
  }

  async function testWD() {
    if (wdPwd && !isWebdavPasswordUsable(wdPwd)) return showNotice(false, t('bk.pwdLatin1'))
    const c: WebDAVConfig = { url: wdUrl, username: wdUser, passwordCipher: wdPwd || cfg?.passwordCipher || '', directory: wdDir }
    const seq = ++wdTestSeqRef.current
    showNotice(true, t('bk.connecting'))
    const r = await window.pocketai.testWebDAV(c)
    // §325：这句结论必须来自最新那次输入的那台服务器，先回的旧一发不许替它说话
    if (seq !== wdTestSeqRef.current) return
    showNotice(r.ok, r.ok ? t('bk.connOk') : t('bk.connFail', { e: r.message ?? t('common.unknownError') }))
  }

  async function doLocalBackup() {
    showNotice(true, t('bk.packing'))
    const r = await window.pocketai.createLocalBackup()
    // §217：r.size 是 undefined ⇒ 绿色提示逐字说「已打包 NaN MB」，而一个字节都没写
    if (hasIpcFailed(r)) {
      showNotice(false, ipcFailText(r, t('common.unknownError')))
      return
    }
    showNotice(true, t('bk.localDone', { size: (r.size / 1024).toFixed(1) }))
  }
  async function doEncBackup() {
    if (!encrypted) return // 未启用主密码时按钮禁用，双保险
    showNotice(true, t('bk.encDoing'))
    const r = await window.pocketai.createEncryptedLocalBackup()
    if (r.ok === false) {
      showNotice(false, r.error || t('common.unknownError'))
      return
    }
    showNotice(true, t('bk.encDone', { size: (r.size / 1024).toFixed(1) }))
  }

  async function doUpload() {
    showNotice(true, t('bk.uploading'))
    const r = await window.pocketai.uploadWebDAVBackup()
    if (r.ok === false) { showNotice(false, t('bk.uploadFail', { e: r.error ?? t('common.unknownError') })); return }
    showNotice(true, t('bk.uploaded', { name: r.filename ?? '' }))
    await refreshList()
    await loadSchedule()
  }

  async function doIncrementalUpload() {
    showNotice(true, t('bk.uploading'))
    const r = await window.pocketai.uploadIncrementalBackup()
    if (r.ok === false) {
      showNotice(false, t('bk.uploadFail', { e: r.error ?? t('common.unknownError') }))
      return
    }
    showNotice(
      true,
      t('bk.incDone', {
        total: r.attachmentsTotal,
        uploaded: r.blobsUploaded,
        skipped: r.blobsSkipped,
        kb: (r.bytesUploaded / 1024).toFixed(1)
      })
    )
    await refreshList()
    await loadSchedule()
  }

  const refreshList = useCallback(async () => {
    const seq = ++listSeqRef.current
    setListLoading(true)
    try {
      const items = await window.pocketai.listWebDAVBackups()
      // §324：存完新地址后 effect 会再拉一次；旧地址那份迟到不许把清单盖回当前屏（内容来自另一台服务器）
      if (seq !== listSeqRef.current) return
      // 196：失败是 {ok:false} 返回值 ⇒ 判返回值才走得到那句「获取远程备份列表失败」
      if (hasIpcFailed(items)) {
        setNotice({ ok: false, text: t('bk.listFail') })
        return
      }
      setWebdavList(items)
    } catch {
      if (seq !== listSeqRef.current) return
      setNotice({ ok: false, text: t('bk.listFail') })
    } finally {
      if (seq === listSeqRef.current) setListLoading(false)
    }
  }, [t])

  // 时间格式化：null/undefined → 从未；否则按语言本地化
  // §327：三处共用同一份「云端最新」（时间格、「哪边更新」、恢复那颗键），各自重算就会各算各的错
  const cloudLatestFile = latestCloudBackup(webdavList)
  const cloudTs: number | null = cloudLatestFile ? cloudLatestFile.mtime : null
  const formatSyncTime = useCallback((ts: number | null | undefined): string => {
    if (!ts) return t('bk.never')
    return new Date(ts).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN')
  }, [t, lang])

  // 配置加载完成后自动拉取云端备份列表，供同步状态卡片展示云端最新时间
  useEffect(() => {
    if (cfg) refreshList()
  }, [cfg, refreshList])

  // 恢复密码弹窗：当前主密码解不开备份时，输入制作备份时的主密码重试（WebDAV/本地共用）
  type RestoreTarget =
    | { kind: 'webdav'; name: string }
    | { kind: 'local'; name: string; restoreToken: string }
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null)
  const [restorePwdValue, setRestorePwdValue] = useState('')
  const [restorePwdError, setRestorePwdError] = useState('')
  const [restorePwdBusy, setRestorePwdBusy] = useState(false)
  /** §324：恢复那一发的代次——迟到回执不许改弹窗目标，也不许清掉用户正在输入的密码 */
  const restoreSeqRef = useRef(0)

  /** 收口恢复结果：成功提示；密码三态打开/更新密码弹窗；其他失败走 notice */
  function handleRestoreResult(
    r: import('../../../../shared/types').BackupRestoreResult,
    target: RestoreTarget | null,
    seq: number
  ): void {
    // §324：迟到那发不许把弹窗目标改回它那一份（用户此刻正在为另一份输密码），
    // 也不许把人家的密码输入清掉、再多报一句「恢复成功」
    if (seq !== restoreSeqRef.current) return
    if (r.ok) {
      setRestoreTarget(null)
      setRestorePwdValue('')
      showNotice(true, r.passwordChanged ? t('bk.restoreOkPasswordChanged') : t('bk.restoreOk'))
      return
    }
    if (r.code === 'needBackupPassword' || r.code === 'badPassword' || r.code === 'legacyNoCross') {
      // 本地恢复首次返回时携带主进程签发的令牌与文件名，据此构造密码重试目标（路径不进渲染层）
      const next: RestoreTarget | null =
        target ?? (r.restoreToken ? { kind: 'local', name: r.fileName ?? r.restoreToken, restoreToken: r.restoreToken } : null)
      if (next) setRestoreTarget(next)
      setRestorePwdError(
        r.code === 'badPassword' ? t('bk.restoreBadPwd')
          : r.code === 'legacyNoCross' ? t('bk.restoreLegacy')
            : ''
      )
      return
    }
    setRestoreTarget(null)
    showNotice(false, t('bk.restoreFail', { e: r.error ?? t('common.unknownError') }))
  }

  async function doRestore(filename: string) {
    if (!(await confirm({ message: t('bk.restoreConfirm', { name: filename }), danger: true }))) return
    showNotice(true, t('bk.downloadingRestore'))
    const seq = ++restoreSeqRef.current
    const r = await window.pocketai.restoreWebDAVBackup(filename)
    handleRestoreResult(r, { kind: 'webdav', name: filename }, seq)
  }

  /** 本地恢复：首次主进程弹文件选择器；取消静默；需要密码时记住文件路径供框内重试 */
  async function doLocalRestorePick() {
    if (!(await confirm({ message: t('bk.localRestoreConfirm'), danger: true }))) return
    // §325（真机撞出）：原来这里摆的是「正在下载恢复…」，而那一会儿主进程只是在等用户挑文件，
    // 挑完才真下载；取消的那发又直接 return ⇒ 那句永远挂在屏上。换成一句对两段都成立的话术，并在取消时收回。
    const seq = ++restoreSeqRef.current
    showNotice(true, t('bk.localRestoring'))
    const r = await window.pocketai.restoreLocalBackup()
    if (r.canceled) {
      setNotice(null)
      return
    }
    handleRestoreResult(r, null, seq)
  }

  async function doRestoreWithPassword() {
    if (!restoreTarget) return
    const pwd = restorePwdValue.trim()
    if (!pwd) {
      setRestorePwdError(t('bk.restoreBadPwd'))
      return
    }
    setRestorePwdBusy(true)
    const seq = ++restoreSeqRef.current
    try {
      const r = restoreTarget.kind === 'webdav'
        ? await window.pocketai.restoreWebDAVBackup(restoreTarget.name, pwd)
        : await window.pocketai.restoreLocalBackup({ restoreToken: restoreTarget.restoreToken, backupPassword: pwd })
      handleRestoreResult(r, restoreTarget, seq)
    } finally {
      // 「重试中」不挂代次判据：busy 为真时重试键与密码框都禁用 ⇒ 不可能有两发重试同时在飞，
      // 加了就是走不到的分支（变异实测存活，遂删）；但这句复位本身必须有，否则弹窗永久卡死
      setRestorePwdBusy(false)
    }
  }

  async function doDelete(filename: string) {
    if (!(await confirm({ message: t('bk.deleteConfirm', { name: filename }), danger: true }))) return
    const r = await window.pocketai.deleteWebDAVBackup(filename)
    // §217：失败也照常刷新＋弹「已删除」，远程那个备份还在
    if (hasIpcFailed(r)) {
      showNotice(false, ipcFailText(r, t('common.unknownError')))
      return
    }
    await refreshList()
    showNotice(true, t('bk.deleted'))
  }

  // 合并恢复：先扫描冲突，再弹窗让用户选策略；异机备份按三态错误在弹窗内输密码重扫
  async function doMergeScan(filename: string, pwd?: string) {
    const seq = ++mergeScanSeqRef.current
    setMergeFilename(filename)
    setMergeReport(null)
    setMergeOpen(true)
    setMergeScanning(true)
    if (pwd === undefined) setMergePwd('') // 首次扫描清空旧密码；密码重试保留输入
    try {
      const r = await window.pocketai.mergeScanWebDAVBackup(filename, pwd)
      // §324：这一发已经不是最新那次（用户关掉弹层去点了另一份）⇒ 一个字都不写屏。
      // 只写报告不判的话，屏上是 A 的冲突表而 mergeFilename 已是 B，执行那发就拿着 B 的文件名＋A 的密码去合并。
      if (seq !== mergeScanSeqRef.current) return
      setMergeReport(r)
      // 扫描成功后记住密码，执行阶段沿用（合并不改本机主密码）
      if (r.ok) setMergePwd(pwd ?? '')
    } catch (e) {
      if (seq !== mergeScanSeqRef.current) return
      setMergeReport({ ok: false, error: errText(e, t('bk.mergeFail')), tables: [], attachmentsToAdd: 0 })
    } finally {
      // 「还在扫描」也归最新那发管：先回的那条不许把它翻掉（§322 同一张脸）
      if (seq === mergeScanSeqRef.current) setMergeScanning(false)
    }
  }

  /** 密码弹窗内「重新扫描」 */
  async function doMergeRescanWithPwd() {
    const pwd = mergePwd.trim()
    if (!pwd || !mergeFilename) return
    await doMergeScan(mergeFilename, pwd)
  }

  async function doMergeExecute(strategy: import('../../../../shared/types').MergeStrategy) {
    if (!mergeFilename) return
    setMergeExecuting(true)
    try {
      const r = await window.pocketai.mergeExecuteWebDAVBackup(mergeFilename, strategy, mergePwd || undefined)
      if (r.ok) {
        // §315：合并会把「记录已被云端取代或删除」的那几台 MCP Server 从运行时里摘掉（原先在跑的就停了）。
        // 这句必须上屏——悄悄停机＝屏上什么都没变，用户只会发现工具突然不能用了。
        const parts = [t('bk.mergeOk')]
        if (r.reconcileFailed) parts.push(t('bk.mergeReconcileFail'))
        else if (typeof r.mcpStopped === 'number' && r.mcpStopped > 0) {
          parts.push(t('bk.mergeMcpStopped', { n: r.mcpStopped }))
        }
        parts.push(t('bk.mergeCredNote'))
        showNotice(true, parts.join(' · '))
        setMergeOpen(false)
        await refreshList()
      } else if (r.code === 'badPassword' || r.code === 'legacyNoCross') {
        // 理论上扫描成功后不会再出现；优雅降级为行内提示并回到密码态
        setMergeReport({
          ok: false,
          code: r.code,
          error: r.error,
          tables: [],
          attachmentsToAdd: 0
        })
      } else {
        showNotice(false, t('bk.mergeFail', { e: r.error ?? t('common.unknownError') }))
      }
    } catch (e) {
      showNotice(false, t('bk.mergeFail', { e: errText(e) }))
    } finally {
      setMergeExecuting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* WebDAV 配置 */}
      <div>
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('bk.webdavTitle')}</div>
        {/* §262：读不到时表单是空的，但那不是"还没配"——这一句把两种空分开头（§222 那张脸）。
            cfg 一旦到手（用户存了新的）这句就退场，不留陈旧谎报。 */}
        {!cfg && wdCfgUnread && (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <LoadFailNotice msg={ipcFailText(wdCfgUnread, t('common.unknownError'))} />
            <button data-testid="webdav-cfg-read-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={reloadCfg}>
              {t('agent.retryRead')}
            </button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="URL"><input className="input" placeholder="https://dav.example.com/..." value={wdUrl} onChange={e => setWdUrl(e.target.value)} /></Field>
          <Field label={t('bk.user')}><input className="input" value={wdUser} onChange={e => setWdUser(e.target.value)} /></Field>
          <Field label={t('bk.password')}><input className="input" type="password" value={wdPwd} onChange={e => setWdPwd(e.target.value)} /></Field>
          <Field label={t('bk.dir')}><input className="input" placeholder="/backups" value={wdDir} onChange={e => setWdDir(e.target.value)} /></Field>
        </div>
        <div className="flex gap-2 mt-2">
          <button className="btn-ghost" onClick={saveWD}>{t('bk.saveCfg')}</button>
          <button className="btn-ghost" onClick={testWD}>{t('bk.testConn')}</button>
        </div>
      </div>

      {/* 同步状态卡片：本地/云端时间对比 + 一键同步入口 */}
      {cfg && (
        <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
          <div className="text-xs text-[var(--color-text-muted)]">{t('bk.syncCard')}</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[var(--color-text-muted)] mb-0.5">{t('bk.localLatest')}</div>
              <div>{formatSyncTime(schedule?.lastRunAt)}</div>
            </div>
            <div>
              <div className="text-[var(--color-text-muted)] mb-0.5">{t('bk.cloudLatest')}</div>
              <div>
                {listLoading
                  ? t('bk.listLoading')
                  : webdavList.length
                    ? cloudTs === null ? t('bk.cloudTimeUnknown') : formatSyncTime(cloudTs)
                    : t('bk.cloudNotFetched')}
              </div>
            </div>
          </div>
          {(() => {
            const localTs = schedule?.lastRunAt ?? 0
            // 时间一份都判不出来时不猜哪边新（改前 NaN 让三句比较全落空 ⇒ 演成「两边一致」）
            if (webdavList.length && cloudTs === null) return <div className="text-[11px] text-[var(--color-text-muted)]">{t('bk.cloudTimeUnknown')}</div>
            const cloudNum = cloudTs ?? 0
            let hint = t('bk.inSyncHint')
            if (localTs && !cloudNum) hint = t('bk.localNewerHint')
            else if (!localTs && cloudNum) hint = t('bk.cloudNewerHint')
            else if (localTs > cloudNum) hint = t('bk.localNewerHint')
            else if (cloudNum > localTs) hint = t('bk.cloudNewerHint')
            return <div className="text-[11px] text-[var(--color-text-muted)]">{hint}</div>
          })()}
          <div className="flex gap-2">
            <button className="btn-primary" onClick={doIncrementalUpload} disabled={listLoading}>
              {t('bk.syncNow')}
            </button>
            {webdavList.length > 0 &&
              (() => {
                const latest = cloudLatestFile
                return latest ? (
                  <>
                    <button
                      className="btn-ghost"
                      onClick={() => doRestore(latest.name)}
                      disabled={listLoading}
                    >
                      {t('bk.restoreFromCloud')}
                    </button>
                    <button
                      className="btn-ghost"
                      onClick={() => doMergeScan(latest.name)}
                      disabled={listLoading}
                    >
                      {t('bk.mergeFromCloud')}
                    </button>
                  </>
                ) : null
              })()}
          </div>
        </div>
      )}

      {/* 定时备份（需先保存 WebDAV 配置）
          §352：`!schedule` 时下面那一整块（含开关与周期下拉）都不出现⇒ 这一支同屏没有出口；
          兄弟支"有旧值"那一支（§345）用的就是同一个 `loadSchedule`，两支护同一口径 */}
      {!schedule && schedErr && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice msg={schedErr} />
          <button
            data-testid="backup-schedule-read-retry"
            className="text-xs underline text-[var(--color-text-muted)]"
            onClick={() => void loadSchedule()}
          >
            {t('agent.retryRead')}
          </button>
        </div>
      )}
      {/* §345：loadSchedule 有三个 caller（进面板／上传后／保存后）——后两发失败时旧计划还画在屏上，
          而开关是按那份旧值摆的（保存会照它写回）⇒ 这一句要说清"没刷成最新"，并给一条重读路径 */}
      {schedule && schedErr && (
        <div className="mb-2">
          <StaleValueNotice what={t('dh.backupState')} msg={schedErr} onRetry={() => void loadSchedule()} testid="schedule-stale-retry" />
        </div>
      )}
      {cfg && schedule && (
        <div className="rounded-lg border border-[var(--color-border)] p-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--color-accent)]"
              checked={schedule.enabled}
              onChange={(e) => saveSchedule({ enabled: e.target.checked })}
            />
            <span className="text-sm">{t('bk.scheduleEnable')}</span>
          </label>
          {schedule.enabled && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--color-text-muted)]">{t('bk.scheduleInterval')}</span>
                <select
                  className="input py-1 text-xs w-32"
                  value={schedule.intervalHours}
                  onChange={(e) => saveSchedule({ intervalHours: Number(e.target.value) })}
                >
                  {INTERVAL_OPTIONS.map((h) => (
                    <option key={h} value={h}>{intervalLabel(h)}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--color-text-muted)]">{t('bk.retention')}</span>
                <select
                  className="input py-1 text-xs w-32"
                  value={schedule.retentionCount}
                  onChange={(e) => saveSchedule({ retentionCount: Number(e.target.value) })}
                >
                  {RETENTION_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n === 0 ? t('bk.retentionNever') : String(n)}</option>
                  ))}
                </select>
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {schedule.lastResult?.ok
                  ? t('bk.scheduleLastOk', { time: new Date(schedule.lastResult.at).toLocaleString() }) +
                    (schedule.lastResult.pruned ? t('bk.schedulePruned', { count: schedule.lastResult.pruned }) : '')
                  : schedule.lastResult
                    ? t('bk.scheduleLastFail', { time: new Date(schedule.lastResult.at).toLocaleString(), e: schedule.lastResult.error ?? '' })
                    : t('bk.scheduleNever')}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">{t('bk.scheduleHint')}</div>
              {schedule.retentionCount > 0 && (
                <div className="text-[11px] text-[var(--color-text-muted)]">{t('bk.retentionHint')}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 本地备份 */}
      <div>
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('bk.localTitle')}</div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary" onClick={doLocalBackup}>{t('bk.localBtn')}</button>
          <button
            className="btn-ghost"
            onClick={doEncBackup}
            disabled={!encrypted}
            title={encrypted ? undefined : t('bk.encNeedMaster')}
          >{t('bk.encBtn')}</button>
          <button className="btn-ghost" onClick={doLocalRestorePick}>{t('bk.localRestoreBtn')}</button>
        </div>
        {!encrypted && (
          <div className="text-[10px] text-[var(--color-text-muted)] mt-1.5">{t('bk.encNeedMaster')}</div>
        )}
      </div>

      {/* WebDAV 操作 */}
      {cfg && (
        <div>
          <div className="flex gap-2 mb-2">
            <button className="btn-primary" onClick={doUpload}>{t('bk.uploadBtn')}</button>
            <button className="btn-ghost" onClick={doIncrementalUpload}>{t('bk.incBtn')}</button>
            <button className="btn-ghost" onClick={refreshList} disabled={listLoading}>
              {listLoading ? `⏳ ${t('common.loading')}` : t('bk.refresh')}
            </button>
          </div>
          <p className="text-[10px] text-[var(--color-text-muted)] mb-2">{t('bk.incHint')}</p>

          {listLoading ? (
            <div className="text-xs text-[var(--color-text-muted)]">{t('bk.listLoading')}</div>
          ) : webdavList.length === 0 ? (
            <div className="text-xs text-[var(--color-text-muted)]">{t('bk.listEmpty')}</div>
          ) : (
            <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)]">
                    <th className="text-left px-3 py-2 font-medium">{t('bk.fileName')}</th>
                    <th className="px-3 py-2 font-medium w-20">{t('bk.size')}</th>
                    <th className="px-3 py-2 font-medium w-36">{t('bk.time')}</th>
                    <th className="px-3 py-2 font-medium w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {webdavList.map((f) => (
                    <tr key={f.name} className="border-t border-[var(--color-border)]/40 hover:bg-[var(--color-hover-overlay)]">
                      <td className="px-3 py-1.5 font-mono truncate max-w-[240px]" title={f.name}>
                        {f.encrypted && <span className="text-[var(--color-warning)] mr-1">🔒</span>}
                        {f.kind === 'incremental' && (
                          <span
                            className="mr-1 px-1 py-0.5 text-[9px] rounded border border-[var(--color-accent)] text-[var(--color-accent)] align-middle"
                            title={t('bk.incBadgeTip')}
                          >
                            {t('bk.incBadge')}
                          </span>
                        )}
                        {f.name}
                      </td>
                      <td className="px-3 py-1.5 text-[var(--color-text-muted)]">{fmtCloudCellSize(f.size)}</td>
                      <td className="px-3 py-1.5 text-[var(--color-text-muted)]">{fmtCloudCellTime(f.mtime)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button className="btn-ghost text-xs px-2 py-0.5 mr-1" onClick={() => doRestore(f.name)}>{t('bk.restore')}</button>
                        <button className="btn-ghost text-xs px-2 py-0.5 mr-1" onClick={() => doMergeScan(f.name)}>{t('bk.merge')}</button>
                        <button className="btn-ghost text-[var(--color-danger)] hover:opacity-80 text-xs px-2 py-0.5" onClick={() => doDelete(f.name)}>{t('common.delete')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {notice && <Notice ok={notice.ok} text={notice.text} />}

      {/* 合并冲突选择对话框 */}
      {mergeOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm p-4"
          onClick={() => !mergeExecuting && setMergeOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold mb-3">{t('bk.mergeTitle')}</h3>

            {mergeScanning ? (
              <div className="text-sm text-[var(--color-text-muted)] py-4 text-center">
                {t('bk.mergeScanning')}
              </div>
            ) : !mergeReport || !mergeReport.ok ? (
              mergeReport?.code === 'needBackupPassword' || mergeReport?.code === 'badPassword' ? (
                <div className="py-1">
                  <p className="text-xs text-[var(--color-text-muted)] mb-2">{t('bk.mergePwdHint')}</p>
                  <input
                    type="password"
                    className="input w-full text-sm"
                    placeholder={t('bk.restorePwdPlaceholder')}
                    value={mergePwd}
                    autoFocus
                    disabled={mergeExecuting}
                    onChange={(e) => setMergePwd(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void doMergeRescanWithPwd() }}
                  />
                  {mergeReport.code === 'badPassword' && (
                    <div className="text-xs text-[var(--color-danger)] mt-2">{t('bk.restoreBadPwd')}</div>
                  )}
                  <div className="flex justify-end mt-3">
                    <button
                      className="px-3 py-1.5 rounded text-sm bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-40"
                      disabled={mergeExecuting || !mergePwd.trim()}
                      onClick={() => void doMergeRescanWithPwd()}
                    >
                      {t('bk.mergeRescan')}
                    </button>
                  </div>
                </div>
              ) : mergeReport?.code === 'legacyNoCross' ? (
                <div className="text-sm text-[var(--color-danger)] py-2">{t('bk.restoreLegacy')}</div>
              ) : (
                <div className="text-sm text-[var(--color-danger)] py-2">
                  {mergeReport?.error || t('common.unknownError')}
                </div>
              )
            ) : (
              <>
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  {t('bk.mergeDesc')}
                  <span className="block mt-2 text-[var(--color-warning)]">{t('bk.mergeCredNote')}</span>
                </p>
                <div className="space-y-1.5 max-h-48 overflow-y-auto mb-3">
                  {mergeReport.tables.filter((tb) => tb.cloudOnly + tb.localOnly + tb.both > 0).map((tb) => (
                    <div key={tb.table} className="flex justify-between text-xs">
                      <span className="font-mono text-[var(--color-text)]">{tb.table}</span>
                      <span className="text-[var(--color-text-muted)]">
                        {tb.cloudOnly > 0 && <span className="text-[var(--color-accent)]">+{tb.cloudOnly} </span>}
                        {tb.localOnly > 0 && <span className="text-[var(--color-text-muted)]">本地+{tb.localOnly} </span>}
                        {tb.both > 0 && <span className="text-[var(--color-warning)]">冲突{tb.both}</span>}
                      </span>
                    </div>
                  ))}
                  {mergeReport.attachmentsToAdd > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="font-mono text-[var(--color-text)]">attachments</span>
                      <span className="text-[var(--color-accent)]">+{mergeReport.attachmentsToAdd}</span>
                    </div>
                  )}
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)] mb-4">
                  {t('bk.mergeStrategyHint')}
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    className="btn-ghost text-left text-xs px-3 py-2"
                    onClick={() => doMergeExecute('cloud')}
                    disabled={mergeExecuting}
                  >
                    <div className="font-medium">{t('bk.mergeStrategyCloud')}</div>
                    <div className="text-[var(--color-text-muted)] mt-0.5">{t('bk.mergeStrategyCloudDesc')}</div>
                  </button>
                  <button
                    className="btn-ghost text-left text-xs px-3 py-2"
                    onClick={() => doMergeExecute('local')}
                    disabled={mergeExecuting}
                  >
                    <div className="font-medium">{t('bk.mergeStrategyLocal')}</div>
                    <div className="text-[var(--color-text-muted)] mt-0.5">{t('bk.mergeStrategyLocalDesc')}</div>
                  </button>
                  <button
                    className="btn-ghost text-left text-xs px-3 py-2"
                    onClick={() => doMergeExecute('newer')}
                    disabled={mergeExecuting}
                  >
                    <div className="font-medium">{t('bk.mergeStrategyNewer')}</div>
                    <div className="text-[var(--color-text-muted)] mt-0.5">{t('bk.mergeStrategyNewerDesc')}</div>
                  </button>
                </div>
              </>
            )}

            <div className="flex justify-end mt-4">
              <button
                onClick={() => setMergeOpen(false)}
                disabled={mergeExecuting}
                className="px-3 py-1.5 rounded text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
              >
                {mergeExecuting ? t('common.loading') : t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 异机恢复：输入备份密码（WebDAV/本地共用） */}
      {restoreTarget && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm p-4"
          onClick={() => !restorePwdBusy && setRestoreTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold mb-2">{t('bk.restorePwdTitle')}</h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-3 break-all">
              {t('bk.restorePwdHint', { name: restoreTarget.name })}
            </p>
            <input
              type="password"
              className="input w-full text-sm"
              placeholder={t('bk.restorePwdPlaceholder')}
              value={restorePwdValue}
              autoFocus
              disabled={restorePwdBusy}
              onChange={(e) => { setRestorePwdValue(e.target.value); setRestorePwdError('') }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void doRestoreWithPassword() }}
            />
            {restorePwdError && (
              <div className="text-xs text-[var(--color-danger)] mt-2">{restorePwdError}</div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setRestoreTarget(null)}
                disabled={restorePwdBusy}
                className="px-3 py-1.5 rounded text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => void doRestoreWithPassword()}
                disabled={restorePwdBusy}
                className="px-3 py-1.5 rounded text-sm bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-40"
              >
                {restorePwdBusy ? t('common.loading') : t('bk.restorePwdConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog}
    </div>
  )
}

// ─── Field 组件（和 ProviderSettings 共用）──────────────────────

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-xs text-[var(--color-text-muted)] mb-1">{label}</label>
    {children}
  </div>
)

// ─── License 面板 ────────────────────────────────────────────────

export const LicensePanel: React.FC<{ lic: LicenseStatus | null; err: string | null; onChange: () => void }> = ({ lic, err, onChange }) => {
  const { t, lang } = useI18n()
  const { confirm, dialog } = useConfirm()
  const locale = lang === 'en' ? 'en-US' : 'zh-CN'
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 粘贴激活码模式（license.lic JSON 文本）：文件选择之外的另一激活入口
  const [pasteOpen, setPasteOpen] = useState(false)
  const [codeText, setCodeText] = useState('')
  // 卡密在线激活：卡密 + 服务器校验后下发绑定本机硬盘的 license
  const [onlineCode, setOnlineCode] = useState('')
  // 本机硬盘指纹：在线激活自动附带；离线激活时发给卖家签发绑定 license
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  // §278：指纹那一读失败时不许把"读不到"演成"没有指纹"——单独挂一句
  const [fingerprintUnread, setFingerprintUnread] = useState<string | null>(null)
  // 指纹复制反馈（2s；含剪贴板降级与定时器清理）
  const { copied: fpCopied, copy: copyFingerprint } = useCopyFeedback(2000)
  // 离线激活折叠区
  const [offlineOpen, setOfflineOpen] = useState(false)

  useEffect(() => {
    window.pocketai.getLicenseFingerprint().then((v) => {
      if (hasIpcFailed(v)) {
        setFingerprintUnread(ipcFailText(v, t('common.unknownError')))
        return
      }
      setFingerprintUnread(null)
      setFingerprint(v)
    }).catch((e) => {
      logIpcError('license.getFingerprint', e)
      setFingerprintUnread(ipcFailText({ error: String(e) }, t('common.unknownError')))
      setFingerprint(null)
    })
  }, [t])

  if (!lic) {
    // §225：许可证读不到时不许一直报"加载中"——激活状态、到期日、指纹全都建在这份数据上
    // §351：这一支原来同屏没有出口——四颗动作键与 §345 那颗「重试」都长在 `lic` 已到的本体里，
    // 而这里连本体都没渲染。补同级一颗，走的正是那四颗键共用的 `onChange`（＝`licCopy.refresh`，键在 alert 盒子外，§268）
    if (err) {
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice msg={err} />
          <button
            data-testid="license-read-retry"
            className="text-xs underline text-[var(--color-text-muted)]"
            onClick={onChange}
          >
            {t('agent.retryRead')}
          </button>
        </div>
      )
    }
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const handleActivate = () => fileRef.current?.click()

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow same file re-select
    if (!file) return
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.loadLicenseString(await file.text())
      if (!r.valid) { setNotice({ ok: false, text: r.error ?? t('lic.activateFail') }); return }
      setNotice({ ok: true, text: t('lic.activated', { owner: r.payload?.owner ?? '', plan: r.payload?.plan ?? '' }) })
      onChange()
    } catch (e) {
      setNotice({ ok: false, text: errText(e, t('lic.activateFail')) })
    } finally { setBusy(false) }
  }

  const handleClear = async () => {
    if (!(await confirm({ message: t('lic.clearConfirm'), danger: true }))) return
    const r = await window.pocketai.clearLicense()
    if (hasIpcFailed(r)) {
      setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
      return
    }
    setNotice({ ok: true, text: t('lic.cleared') })
    onChange()
  }

  const handlePasteActivate = async () => {
    if (!codeText.trim()) return
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.loadLicenseString(codeText)
      if (!r.valid) { setNotice({ ok: false, text: r.error ?? t('lic.activateFail') }); return }
      setNotice({ ok: true, text: t('lic.activated', { owner: r.payload?.owner ?? '', plan: r.payload?.plan ?? '' }) })
      setPasteOpen(false); setCodeText('')
      onChange()
    } catch (e) {
      setNotice({ ok: false, text: errText(e, t('lic.activateFail')) })
    } finally { setBusy(false) }
  }

  const handleOnlineActivate = async () => {
    if (!onlineCode.trim()) return
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.onlineActivateLicense(onlineCode)
      if (!r.ok) {
        // 按稳定错误码展示差异化提示（网络/卡密/服务端问题各有自助指引）
        setNotice({ ok: false, text: t(`lic.err.${r.code}`) })
        return
      }
      const { payload } = r.status
      setNotice({ ok: true, text: t('lic.activated', { owner: payload?.owner ?? '', plan: payload?.plan ?? '' }) })
      setOnlineCode('')
      onChange()
    } catch {
      // IPC 本身异常（非业务错误）的兜底
      setNotice({ ok: false, text: t('lic.activateFail') })
    } finally { setBusy(false) }
  }

  const handleCopyFingerprint = () => {
    if (fingerprint) void copyFingerprint(fingerprint)
  }

  const payload = lic.payload

  return (
    <div className="space-y-2 text-xs">
      {/* §345：许可证有两发读（挂载＋LicensePanel 动作后的 onChange，如激活成功后重拉）；
          第二发失败时旧许可证照常在屏上，那一句"授权状态"就得说出它没能刷新 */}
      {err && <StaleValueNotice what={t('lic.status')} msg={err} onRetry={onChange} testid="lic-stale-retry" />}
      {lic.valid && payload ? (
        <>
          <StatusRow label={t('lic.status')} value={t('lic.validValue', { plan: payload.plan.toUpperCase() })} ok />
          <StatusRow label={t('lic.holder')} value={payload.owner} ok />
          <StatusRow label={t('lic.expires')} value={new Date(payload.expires_at).toLocaleDateString(locale)} ok />
          {payload.features.length > 0 && (
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {t('lic.features')}{payload.features.map((f) => `✅${f}`).join(' ')}
            </div>
          )}
        </>
      ) : lic.expired && payload ? (
        <>
          <StatusRow label={t('lic.status')} value={t('lic.expired', { date: new Date(payload.expires_at).toLocaleDateString(locale) })} ok={false} />
          <StatusRow label={t('lic.holder')} value={payload.owner} ok={false} />
        </>
      ) : (
        <StatusRow label={t('lic.status')} value={t('lic.free')} ok={false} />
      )}

      {!lic.valid && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
          {t('lic.liteLimits', { assistants: 3, kbs: 1 })}
        </p>
      )}

      {lic.valid && (
        <div className="flex gap-2 pt-1">
          <button className="btn-ghost text-[var(--color-danger)]" onClick={handleClear}>{t('lic.clear')}</button>
        </div>
      )}

      {!lic.valid && (
        <>
          {/* 卡密在线激活（主入口） */}
          <div className="space-y-1.5 pt-1">
            <div className="text-[11px] font-medium">{t('lic.onlineTitle')}</div>
            <div className="flex gap-2">
              <input
                className="input font-mono flex-1"
                value={onlineCode}
                onChange={(e) => setOnlineCode(e.target.value)}
                placeholder={t('lic.codePlaceholder')}
                disabled={busy}
              />
              <button className="btn-primary shrink-0" disabled={busy || !onlineCode.trim()} onClick={handleOnlineActivate}>
                {busy ? t('common.processing') : t('lic.onlineActivate')}
              </button>
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{t('lic.onlineHint')}</p>
          </div>

          {/* 本机硬盘指纹：离线激活时发给卖家 */}
          <div className="space-y-1.5">
            {fingerprintUnread && <ShowingDefaultsNotice what={t('lic.fpLabel')} msg={fingerprintUnread} />}
            <StatusRow
              label={t('lic.fpLabel')}
              value={fingerprint ?? t('lic.fpUnavailable')}
              ok={!!fingerprint}
            />
            {fingerprint && (
              <button className="btn-ghost" onClick={handleCopyFingerprint}>
                {fpCopied ? t('lic.copied') : t('lic.copyFingerprint')}
              </button>
            )}
          </div>

          {/* 离线激活（折叠） */}
          <div className="space-y-1.5">
            <button className="btn-ghost" onClick={() => setOfflineOpen((v) => !v)}>
              {offlineOpen ? '▾' : '▸'} {t('lic.offlineTitle')}
            </button>
            {offlineOpen && (
              <div className="space-y-2">
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{t('lic.offlineHint')}</p>
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={busy} onClick={handleActivate}>
                    {busy ? t('common.processing') : t('lic.activate')}
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => setPasteOpen((v) => !v)}>
                    {t('lic.pasteCode')}
                  </button>
                  <input ref={fileRef} type="file" accept=".lic,.json" className="hidden" onChange={handleFile} />
                </div>
                {pasteOpen && (
                  <div className="space-y-2">
                    <textarea
                      rows={5}
                      value={codeText}
                      onChange={(e) => setCodeText(e.target.value)}
                      placeholder={t('lic.pastePlaceholder')}
                      className="input font-mono text-[11px] resize-none"
                    />
                    <button className="btn-primary" disabled={busy || !codeText.trim()} onClick={handlePasteActivate}>
                      {t('lic.pasteActivate')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {notice && <Notice ok={notice.ok} text={notice.text} />}

      {dialog}
    </div>
  )
}

// ─── 快捷浮窗面板 ─────────────────────────────────────────────────

// 修饰键集合：按下纯修饰键时不构成快捷键，继续等待组合
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift'])

// KeyboardEvent → Electron accelerator
// 返回：null=仍是纯修饰键（继续捕获）；''=无效按键；否则为 accelerator 字符串
function eventToAccelerator(e: React.KeyboardEvent): string | null {
  const k = e.key
  if (MODIFIER_KEYS.has(k)) return null
  // 必须包含 Ctrl/⌘ 或 Alt（仅 Shift 的组合全局快捷键在多数平台无法注册）
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return ''

  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  let key = ''
  if (/^[a-zA-Z0-9]$/.test(k)) {
    key = k.toUpperCase()
  } else {
    const SPECIAL: Record<string, string> = {
      ' ': 'Space',
      Enter: 'Return',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      ',': 'Comma',
      '.': 'Period',
      '/': 'Slash',
      '\\': 'Backslash',
      '-': 'Minus',
      '=': 'Equal',
      ';': 'Semicolon',
      "'": 'Quote',
      '`': 'Backquote',
      '[': 'BracketLeft',
      ']': 'BracketRight'
    }
    key = SPECIAL[k] ?? (/^F([1-9]|1[0-9]|2[0-4])$/.test(k) ? k : '')
  }
  return key ? [...mods, key].join('+') : ''
}

export const PopupPanel: React.FC = () => {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<PopupConfig | null>(null)
  // §225：读失败的原因。以前 reject 面降级成「全关 + 空快捷键」当配置显示——那是把默认值当已保存的事实
  //（§196 那一族），而且这时候拨一颗开关就会把整份配置按默认值写回去
  const [cfgErr, setCfgErr] = useState<string | null>(null)
  // 正在捕获哪一个快捷键；candidate 为已捕获到的组合
  const [capturing, setCapturing] = useState<'quick' | 'selection' | null>(null)
  const [candidate, setCandidate] = useState('')
  const [captureErr, setCaptureErr] = useState('')
  const [saveErr, setSaveErr] = useState('')

  // §354：抽成具名 loader ⇒ 早退那一支的「读不到」有出口（那块面板的捕获／保存两颗键都不在屏上）。
  // 依赖照旧 `[]`（原文如此，`t` 只捕获挂载那一刻那份），换成 `[t]` 会让换语言时多发一发读，属行为变化。
  const loadPopupCfg = useCallback(() => {
    // §225：两条失败面都要落到那句「读不到」上——resolve 的 `{ok:false}` 走 then，真抛错走 catch
    window.pocketai.getPopupConfig().then((v) => {
      if (hasIpcFailed(v)) { setCfgErr(ipcFailText(v, t('common.unknownError'))); return }
      setCfg(v)
    }).catch((e) => {
      setCfgErr(errText(e, t('common.unknownError')))
      logIpcError('settings.getPopupConfig', e)
    })
  }, [])

  useEffect(() => {
    loadPopupCfg()
  }, [loadPopupCfg])

  if (!cfg) {
    if (cfgErr)
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice msg={cfgErr} />
          <button data-testid="popup-cfg-read-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={loadPopupCfg}>
            {t('agent.retryRead')}
          </button>
        </div>
      )
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const fmtAccel = (a: string) =>
    a.replace('CommandOrControl', /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl').replace(/\+/g, ' + ')

  // 主进程返回的错误码映射为本地化文案
  const mapResultError = (r: { error?: string; accel?: string }): string => {
    if (r.error === 'same') return t('popup.accelSame')
    if (r.error === 'occupied') {
      const display = r.accel ? fmtAccel(r.accel) : ''
      return t('popup.accelOccupied', { accel: display })
    }
    return t('common.unknownError')
  }

  const toggle = async (key: 'quickEnabled' | 'selectionEnabled') => {
    const prev = cfg
    setCfg({ ...cfg, [key]: !cfg[key] }) // 乐观更新
    const r = await window.pocketai.setPopupConfig({ [key]: !cfg[key] })
    if (r.ok && r.config) {
      setCfg(r.config)
    } else {
      setCfg(prev)
      setSaveErr(mapResultError(r))
    }
  }

  const startCapture = (which: 'quick' | 'selection') => {
    setCapturing(which)
    setCandidate('')
    setCaptureErr('')
    setSaveErr('')
  }

  const onCaptureKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setCapturing(null)
      return
    }
    const accel = eventToAccelerator(e)
    if (accel === null) return // 仍只按了修饰键
    if (accel === '') {
      setCaptureErr(t('popup.accelNeedModifier'))
      return
    }
    setCandidate(accel)
    setCaptureErr('')
  }

  const confirmCapture = async () => {
    if (!capturing || !candidate) return
    const patch =
      capturing === 'quick' ? { quickAccelerator: candidate } : { selectionAccelerator: candidate }
    const r = await window.pocketai.setPopupConfig(patch)
    if (r.ok && r.config) {
      setCfg(r.config)
      setCapturing(null)
      setCandidate('')
    } else {
      setSaveErr(mapResultError(r))
    }
  }

  const rows: Array<{
    which: 'quick' | 'selection'
    key: 'quickEnabled' | 'selectionEnabled'
    title: string
    hint: string
    accel: string
  }> = [
    {
      which: 'quick',
      key: 'quickEnabled',
      title: t('popup.quickTitle'),
      hint: t('popup.quickHint'),
      accel: cfg.quickAccelerator
    },
    {
      which: 'selection',
      key: 'selectionEnabled',
      title: t('popup.selectionTitle'),
      hint: t('popup.selectionHint'),
      accel: cfg.selectionAccelerator
    }
  ]

  return (
    <div className="space-y-2 text-xs">
      {rows.map((r) => (
        <div key={r.key} className="py-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[var(--color-text)]">{r.title}</div>
              <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{r.hint}</div>
            </div>
            <button
              role="switch"
              aria-checked={cfg[r.key]}
              onClick={() => toggle(r.key)}
              className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
                cfg[r.key] ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  cfg[r.key] ? 'translate-x-4' : ''
                }`}
              />
            </button>
          </div>

          {/* 快捷键展示 / 捕获 */}
          <div className="flex items-center gap-2 mt-1 ml-0.5">
            {capturing === r.which ? (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  autoFocus
                  onKeyDown={onCaptureKeyDown}
                  onBlur={() => {
                    /* 不在 blur 取消：允许点击保存按钮 */
                  }}
                  className="px-2 py-0.5 text-[10px] rounded font-mono border border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-sidebar)] outline-none"
                >
                  {candidate ? fmtAccel(candidate) : t('popup.accelCapturing')}
                </button>
                <button
                  onClick={confirmCapture}
                  disabled={!candidate}
                  className="px-2 py-0.5 text-[10px] rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] disabled:opacity-40"
                >
                  {t('ui.save')}
                </button>
                <button
                  onClick={() => setCapturing(null)}
                  className="px-2 py-0.5 text-[10px] rounded border border-[var(--color-border)]"
                >
                  {t('common.cancel')}
                </button>
                {captureErr && (
                  <span className="text-[10px] text-[var(--color-danger)]">{captureErr}</span>
                )}
              </div>
            ) : (
              <>
                <span className="px-1.5 py-0.5 text-[10px] rounded font-mono bg-[var(--color-sidebar)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
                  {fmtAccel(r.accel)}
                </span>
                <button
                  onClick={() => startCapture(r.which)}
                  className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline underline-offset-2"
                >
                  {t('popup.editAccel')}
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {saveErr && <div className="text-[10px] text-[var(--color-danger)] pt-0.5">{saveErr}</div>}
      <div className="text-[10px] text-[var(--color-text-muted)] pt-1">{t('popup.settingsNote')}</div>
    </div>
  )
}

// ─── 外观面板（窗口透明度 / 自定义 CSS）────────────────────────

// 网络面板：主进程 API 流量代理（http/https）。留空=直连；保存后立即应用，
// 回环地址（localhost/127.0.0.1）始终直连。非法地址主进程返回错误且不写库。
export const NetworkPanel: React.FC = () => {
  const { t } = useI18n()
  const [proxyUrl, setProxyUrl] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [readErr, setReadErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    window.pocketai.getProxyUrl()
      .then((v) => {
        // §221：两个半边都要——把失败对象填进输入框是谎报，整条早退又会让面板永远停在「加载中」
        //（下面那个 .catch 本来就是"记一句然后照样 loaded"）
        // §226：门照样解除是对的，但空输入框会被读成"你没配代理"——那恰好是失败时要显示的默认值，得说出来
        if (hasIpcFailed(v)) {
          const msg = ipcFailText(v, t('common.unknownError'))
          setReadErr(msg)
          logIpcError('settings.getProxyUrl', new Error(msg))
        } else setProxyUrl(v)
        setLoaded(true)
      })
      .catch((e) => {
        setReadErr(errText(e, t('common.unknownError')))
        logIpcError('settings.getProxyUrl', e)
        setLoaded(true)
      })
  }, [])

  const save = async () => {
    // §340：那颗「保存」有 disabled={saving}，但输入框不设防⇒Enter 这条路由绕过它，
    // 连按 Enter 就是并发多发 setProxyUrl、回来的回执互相盖（守卫写在体内，两条路共用同一道）
    if (saving) return
    setSaving(true)
    setNotice(null)
    try {
      const r = await window.pocketai.setProxyUrl(proxyUrl.trim())
      if (typeof r === 'string') {
        setProxyUrl(r)
        setNotice({ ok: true, text: t('set.proxySaved') })
      } else {
        setNotice({ ok: false, text: r.error || t('set.proxyInvalid') })
      }
    } catch (e) {
      setNotice({ ok: false, text: errText(e, t('common.unknownError')) })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-2 text-xs">
      {readErr && <ShowingDefaultsNotice what={t('set.proxyUrlLabel')} msg={readErr} />}
      <div className="flex gap-2">
        <input
          type="text"
          value={proxyUrl}
          onChange={(e) => setProxyUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save() }}
          placeholder="http://127.0.0.1:7890"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
        <button type="button" className="btn-primary shrink-0" disabled={saving} onClick={() => void save()}>
          {t('set.proxySave')}
        </button>
      </div>
      <p className="text-[10px] leading-relaxed text-[var(--color-text-muted)]">{t('set.proxyHint')}</p>
      {notice && (
        <p className={`text-[11px] ${notice.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
          {notice.text}
        </p>
      )}
    </div>
  )
}

// 导出给用例直接挂载：它只依赖 useI18n + 本地 state，7 个 IPC 通道就能跑满，
// 不必为了测外观控件把整个 SettingsModule 的依赖图都拉起来（V4-Iter-96）
export const AppearancePanel: React.FC = () => {
  const { t } = useI18n()
  const [opacity, setOpacity] = useState(1)
  // §333：commitOpacity 失败时回滚到「最后一次真正存住的值」，不是拖动中的本地值
  const savedOpacityRef = useRef(1)
  const [css, setCss] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  // 窗口行为：开机自启 / 关窗最小化到托盘
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [closeToTray, setCloseToTray] = useState(false)
  // 聊天字号三档；回复完成系统通知开关
  const [chatFontSize, setChatFontSize] = useState<ChatFontSize>('medium')
  // 长代码块折叠阈值（行；0 = 永不折叠）。input 用字符串，允许中途清空/半截数字
  const [collapseLines, setCollapseLines] = useState(CODE_COLLAPSE_THRESHOLD)
  const [collapseInput, setCollapseInput] = useState(String(CODE_COLLAPSE_THRESHOLD))
  const [replyNotify, setReplyNotify] = useState(true)
  // §226：这一页是**三发彼此独立的读**（界面偏好／窗口行为／回复通知）；谁没读到就只有谁那几项是默认值，
  // 混成一句会把成功读到的那几项也说成默认值 ⇒ 三个原因各说各的
  const [uiErr, setUiErr] = useState<string | null>(null)
  const [behaviorErr, setBehaviorErr] = useState<string | null>(null)
  const [notifyErr, setNotifyErr] = useState<string | null>(null)

  useEffect(() => {
    window.pocketai.getUiPrefs().then((r) => {
      if (!r.ok || !r.data) {
        setUiErr(ipcFailText(r, t('common.unknownError')))
      } else {
        setOpacity(r.data.opacity)
        savedOpacityRef.current = r.data.opacity
        setCss(r.data.customCss)
        setChatFontSize(normalizeFontSize(r.data.chatFontSize))
        const lines = normalizeCodeCollapseLines(r.data.codeCollapseLines)
        setCollapseLines(lines)
        setCollapseInput(String(lines))
      }
      setLoaded(true)
    }).catch((e) => {
      // 失败也要解除 loading 门，否则面板永远转圈；解除之后屏上是初始值，所以要配一句「显示的是默认值」（§226）
      setUiErr(errText(e, t('common.unknownError')))
      logIpcError('settings.getUiPrefs', e)
      setLoaded(true)
    })
    window.pocketai.getWindowBehavior().then((r) => {
      if (hasIpcFailed(r)) {
        setBehaviorErr(ipcFailText(r, t('common.unknownError')))
        return
      }
      setLaunchAtLogin(r.launchAtLogin)
      setCloseToTray(r.closeToTray)
    }).catch((e) => {
      setBehaviorErr(errText(e, t('common.unknownError')))
      logIpcError('settings.getWindowBehavior', e)
    })
    // §219：`.then(setReplyNotify)` 会把 `{ok:false}` 这个真值直接当成已开启显示；读不到时宁可保持默认开，与旁边那个 .catch 同一个口径
    window.pocketai
      .getReplyNotifyEnabled()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setNotifyErr(ipcFailText(v, t('common.unknownError')))
          return
        }
        setReplyNotify(v)
      })
      .catch((e) => {
        // 读不到就保持默认「开」（不擅自关掉用户可能开着的通知），但这件事得说出来：那一发 `.catch(() => setReplyNotify(true))`
        // 本来就是无操作，初值已经是 true ⇒ 它唯一的实质作用是别把这次失败当成"已读到"（§226）
        setNotifyErr(errText(e, t('common.unknownError')))
        logIpcError('settings.getReplyNotifyEnabled', e)
      })
  }, [])

  const toggleLaunchAtLogin = async (next: boolean) => {
    setLaunchAtLogin(next)
    try {
      const r = await window.pocketai.setLaunchAtLogin(next)
      // §219：失败是 resolve ⇒ 走不到那个 catch；`r.launchAtLogin` 是 undefined，开关被抹成没值且没有任何提示
      if (hasIpcFailed(r)) {
        setLaunchAtLogin(!next)
        setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
        return
      }
      setLaunchAtLogin(r.launchAtLogin)
    } catch (e) {
      setLaunchAtLogin(!next)
      setNotice({ ok: false, text: errText(e, t('common.unknownError')) })
    }
  }

  const toggleCloseToTray = async (next: boolean) => {
    setCloseToTray(next)
    try {
      const r = await window.pocketai.setCloseToTray(next)
      if (hasIpcFailed(r)) {
        setCloseToTray(!next)
        setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
        return
      }
      setCloseToTray(r.closeToTray)
    } catch (e) {
      setCloseToTray(!next)
      setNotice({ ok: false, text: errText(e, t('common.unknownError')) })
    }
  }

  // 字号切换：即时生效（CSS 变量）+ 持久化；失败回退档位
  const changeChatFontSize = async (next: ChatFontSize) => {
    const prev = chatFontSize
    setChatFontSize(next)
    applyChatFontSize(next)
    try {
      const r = await window.pocketai.setUiPrefs({ chatFontSize: next })
      if (r.ok && r.data) setChatFontSize(normalizeFontSize(r.data.chatFontSize))
      else throw new Error(r.error ?? 'failed')
    } catch (e) {
      setChatFontSize(prev)
      applyChatFontSize(prev)
      setNotice({ ok: false, text: errText(e, t('common.unknownError')) })
    }
  }

  // 折叠阈值：失焦/回车提交（输入中途不清 dirty 值）。本地先生效 -> 持久化，失败回滚
  const commitCodeCollapse = async (raw: string): Promise<void> => {
    const parsed = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      setCollapseInput(String(collapseLines))
      return
    }
    const next = Math.min(MAX_CODE_COLLAPSE_LINES, Math.max(0, Math.floor(parsed)))
    const prev = collapseLines
    setCollapseLines(next)
    setCollapseInput(String(next))
    setCodeCollapseLines(next)
    try {
      const r = await window.pocketai.setUiPrefs({ codeCollapseLines: next })
      if (!r.ok) throw new Error(r.error ?? 'failed')
      const saved = normalizeCodeCollapseLines(r.data?.codeCollapseLines)
      setCollapseLines(saved)
      setCollapseInput(String(saved))
      setCodeCollapseLines(saved)
    } catch (e) {
      setCollapseLines(prev)
      setCollapseInput(String(prev))
      setCodeCollapseLines(prev)
      setNotice({ ok: false, text: errText(e, t('common.unknownError')) })
    }
  }

  const toggleReplyNotify = async (next: boolean) => {
    setReplyNotify(next)
    try {
      const enabled = await window.pocketai.setReplyNotifyEnabled(next)
      if (hasIpcFailed(enabled)) {
        setReplyNotify(!next)
        setNotice({ ok: false, text: ipcFailText(enabled, t('common.unknownError')) })
        return
      }
      setReplyNotify(enabled)
    } catch (e) {
      setReplyNotify(!next)
      setNotice({ ok: false, text: errText(e, t('common.unknownError')) })
    }
  }

  // 滑块拖动结束后提交（拖动中只更新本地，避免频繁 IPC）
  // §333：改前这一发失败只说一句，滑块仍停在没落库的那一档（同屏其余五发都回滚）；
  // 回滚的锚点是「最后一次真正存住的那个值」，不是拖动过程中的本地值。
  const commitOpacity = async (value: number) => {
    const r = await window.pocketai.setUiPrefs({ opacity: value })
    if (r.ok && r.data) {
      setOpacity(r.data.opacity)
      savedOpacityRef.current = r.data.opacity
    } else {
      setOpacity(savedOpacityRef.current)
      setNotice({ ok: false, text: r.error ?? t('common.unknownError') })
    }
  }

  const saveCss = async () => {
    const r = await window.pocketai.setUiPrefs({ customCss: css })
    if (r.ok && r.data) {
      setCss(r.data.customCss)
      injectCustomCss(r.data.customCss) // 立即在当前窗口生效
      setNotice({ ok: true, text: t('ui.saved') })
    } else {
      setNotice({ ok: false, text: r.error ?? t('common.unknownError') })
    }
  }

  const resetCss = async () => {
    const prevCss = css
    const r = await window.pocketai.setUiPrefs({ customCss: '' })
    // 改前是先清 CSS、再静默失败：输入框空了而旧样式还在生效，也没有任何提示（§216）
    if (!r.ok || !r.data) {
      setCss(prevCss)
      setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
      return
    }
    setCss('')
    injectCustomCss('')
    setNotice({ ok: true, text: t('ui.saved') })
  }

  if (!loaded) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-4 text-xs">
      {uiErr && (
        <ShowingDefaultsNotice what={[t('ui.opacity'), t('ui.fontSize'), t('ui.codeCollapse'), t('ui.customCss')].join(' / ')} msg={uiErr} />
      )}
      {/* 窗口透明度 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[var(--color-text)]">{t('ui.opacity')}</span>
          <span className="font-mono text-[var(--color-text-muted)]">{Math.round(opacity * 100)}%</span>
        </div>
        <input
          type="range"
          min={0.6}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          onPointerUp={() => commitOpacity(opacity)}
          onKeyUp={() => commitOpacity(opacity)}
          className="w-full"
        />
        <p className="text-[10px] text-[var(--color-text-muted)] mt-1">{t('ui.opacityHint')}</p>
      </div>

      {/* 窗口行为：开机自启 / 关窗最小化到托盘 */}
      <div className="space-y-2">
        {behaviorErr && <ShowingDefaultsNotice what={[t('ui.launchAtLogin'), t('ui.closeToTray')].join(' / ')} msg={behaviorErr} />}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--color-accent)]"
              checked={launchAtLogin}
              onChange={(e) => void toggleLaunchAtLogin(e.target.checked)}
            />
            <span className="text-[var(--color-text)]">{t('ui.launchAtLogin')}</span>
          </label>
          <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5 ml-6">{t('ui.launchAtLoginHint')}</p>
        </div>
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--color-accent)]"
              checked={closeToTray}
              onChange={(e) => void toggleCloseToTray(e.target.checked)}
            />
            <span className="text-[var(--color-text)]">{t('ui.closeToTray')}</span>
          </label>
          <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5 ml-6">{t('ui.closeToTrayHint')}</p>
        </div>
      </div>

      {/* 聊天字号三档 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[var(--color-text)]">{t('ui.fontSize')}</span>
          <div className="flex gap-1">
            {(['small', 'medium', 'large'] as const).map((s) => (
              <button
                key={s}
                onClick={() => void changeChatFontSize(s)}
                className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
                  chatFontSize === s
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)]'
                }`}
              >
                {t(`ui.font${s === 'small' ? 'Small' : s === 'medium' ? 'Mid' : 'Large'}`)}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[10px] text-[var(--color-text-muted)] mt-1">{t('ui.fontSizeHint')}</p>
      </div>

      {/* 长代码块折叠阈值 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="ui-code-collapse-lines" className="text-[var(--color-text)]">
            {t('ui.codeCollapse')}
          </label>
          <input
            id="ui-code-collapse-lines"
            type="number"
            min={0}
            max={MAX_CODE_COLLAPSE_LINES}
            step={1}
            value={collapseInput}
            onChange={(e) => setCollapseInput(e.target.value)}
            onBlur={(e) => void commitCodeCollapse(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commitCodeCollapse(e.currentTarget.value)
            }}
            className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-sidebar)] px-1.5 py-0.5 text-[11px] text-[var(--color-text)]"
          />
        </div>
        <p className="text-[10px] text-[var(--color-text-muted)] mt-1">{t('ui.codeCollapseHint')}</p>
      </div>

      {/* 回复完成系统通知 */}
      <div>
        {notifyErr && <ShowingDefaultsNotice what={t('set.replyNotify')} msg={notifyErr} />}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="w-4 h-4 accent-[var(--color-accent)]"
            checked={replyNotify}
            onChange={(e) => void toggleReplyNotify(e.target.checked)}
          />
          <span className="text-[var(--color-text)]">{t('set.replyNotify')}</span>
        </label>
        <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5 ml-6">{t('set.replyNotifyHint')}</p>
      </div>

      {/* 自定义 CSS */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[var(--color-text)]">{t('ui.customCss')}</span>
          <div className="flex gap-2">
            <button
              onClick={resetCss}
              className="px-2 py-1 text-[11px] rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]"
            >
              {t('ui.clear')}
            </button>
            <button
              onClick={saveCss}
              className="px-2 py-1 text-[11px] rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
            >
              {t('ui.save')}
            </button>
          </div>
        </div>
        <textarea
          value={css}
          onChange={(e) => setCss(e.target.value)}
          spellCheck={false}
          rows={8}
          placeholder={'body { /* ... */ }'}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] p-2 font-mono text-[11px] resize-y outline-none focus:border-[var(--color-accent)]"
        />
        <p className="text-[10px] text-[var(--color-text-muted)] mt-1">{t('ui.cssHint')}</p>
      </div>

      {notice && (
        <div className={`text-[11px] ${notice.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
          {notice.text}
        </div>
      )}
    </div>
  )
}

// ─── 更新面板 ────────────────────────────────────────────────────

export const UpdatePanel: React.FC<{ info: UpdateInfo | null; err: string | null; status: UpdateEvent; onReloadInfo: () => void }> = ({ info, err, status, onReloadInfo }) => {
  const { t } = useI18n()
  const { confirm, dialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [autoUpdate, setAutoUpdate] = useState<boolean>(info?.autoUpdateEnabled ?? false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelogLoading, setChangelogLoading] = useState(false)
  const [changelogError, setChangelogError] = useState<string | null>(null)
  const [releases, setReleases] = useState<Array<{ tag: string; name: string; date: string; body: string; url: string; prerelease: boolean }>>([])

  // §333：autoUpdate 初值定死在 mount 那一刻 ⇒ info 迟到或刷新后状态不跟 ⇒ 加一道同步
  useEffect(() => {
    if (info?.autoUpdateEnabled !== undefined) setAutoUpdate(info.autoUpdateEnabled)
  }, [info?.autoUpdateEnabled])

  const handleOpenChangelog = async () => {
    setChangelogOpen(true)
    setChangelogLoading(true)
    setChangelogError(null)
    try {
      const r = await window.pocketai.fetchChangelog()
      if (r.ok && r.releases) {
        setReleases(r.releases)
      } else {
        setChangelogError(r.error ?? t('upd.changelogEmpty'))
      }
    } catch (e) {
      setChangelogError(errText(e, t('upd.changelogEmpty')))
    } finally {
      setChangelogLoading(false)
    }
  }

  const handleToggleAutoUpdate = async () => {
    const next = !autoUpdate
    setAutoUpdate(next)
    const r = await window.pocketai.setAutoUpdate(next)
    if (!r.ok) {
      setAutoUpdate(!next)
      setNotice({ ok: false, text: r.error ?? t('common.unknownError') })
    }
  }

  if (!info) {
    // §225：更新信息读不到 ⇒ 说清"读不到"，而不是一直"加载中"（这一块的"当前版本／检查更新"全建在 info 上）
    // §354：早退 return 把整块面板（含「检查更新」）换成这一句 ⇒ 这一支的同级键由父页递下来的 onReloadInfo 重读那一发
    if (err)
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice msg={err} />
          <button data-testid="update-info-read-retry" className="text-xs underline text-[var(--color-text-muted)]" onClick={onReloadInfo}>
            {t('agent.retryRead')}
          </button>
        </div>
      )
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const s = status?.status ?? 'idle'
  const isPackaged = info.isPackaged
  const currentVer = info.currentVersion
  const newVer = status?.newVersion
  const progress = status?.progress ?? 0

  const handleCheck = async () => {
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.checkUpdate()
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t('upd.checkFail') })
    } catch (e) {
      setNotice({ ok: false, text: errText(e, t('upd.checkFail')) })
    } finally { setBusy(false) }
  }

  const handleDownload = async () => {
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.downloadUpdate()
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t('upd.downloadFail') })
    } catch (e) {
      setNotice({ ok: false, text: errText(e, t('upd.downloadFail')) })
    } finally { setBusy(false) }
  }

  const handleRestart = async () => {
    if (!(await confirm({ message: t('upd.restartConfirm') }))) return
    try {
      const r = await window.pocketai.quitAndInstall()
      // §312：这条支路的失败是 resolve 出来的 {ok:false}（补丁过期／NSIS 抛错）——不判它就是"按了没动静"
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t('upd.installFail') })
    } catch (e) {
      setNotice({ ok: false, text: errText(e, t('upd.installFail')) })
    }
  }

  const statusInfoOf = (): { text: string; color: string } => {
    switch (s) {
      case 'checking':
        return { text: t('upd.checking'), color: 'text-[var(--color-info)]' }
      case 'available':
        return { text: t('upd.available', { v: newVer ?? '' }), color: 'text-[var(--color-warning)]' }
      case 'unavailable':
        return { text: t('upd.unavailable'), color: 'text-[var(--color-success)]' }
      case 'downloading':
        return { text: t('upd.downloading', { p: progress }), color: 'text-[var(--color-info)]' }
      case 'downloaded':
        return { text: t('upd.downloaded', { v: newVer ?? '' }), color: 'text-[var(--color-success)]' }
      case 'error':
        return { text: t('upd.error', { e: status?.error ?? '' }), color: 'text-[var(--color-danger)]' }
      default:
        return { text: t('upd.idle'), color: 'text-[var(--color-text-muted)]' }
    }
  }
  const label = statusInfoOf()

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-3">
        <span className="text-[var(--color-text-muted)]">{t('upd.currentVersion')}</span>
        <span className="font-mono text-[var(--color-text)]">{currentVer}</span>
        {info.isPortable && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-info-bg)] text-[var(--color-info)]">Portable</span>
        )}
        {!isPackaged && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-warning-bg)] text-[var(--color-warning)]">Dev</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 py-1">
        <div className="min-w-0">
          <div className="text-[var(--color-text)]">{t('upd.autoUpdate')}</div>
          <div className="text-[10px] text-[var(--color-text-muted)] truncate">{t('upd.autoUpdateHint')}</div>
        </div>
        <button
          role="switch"
          aria-checked={autoUpdate}
          onClick={handleToggleAutoUpdate}
          className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
            autoUpdate ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              autoUpdate ? 'translate-x-4' : ''
            }`}
          />
        </button>
      </div>

      <div className={label.color}>{label.text}</div>

      {s === 'downloading' && (
        <div className="w-full h-2 bg-[var(--color-border)] rounded overflow-hidden">
          <div
            className="h-full bg-[var(--color-info)] transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <div className="flex gap-2 pt-1 flex-wrap">
        <button className="btn-ghost" disabled={busy || s === 'checking' || s === 'downloading'} onClick={handleCheck}>
          {t('upd.checkBtn')}
        </button>
        {s === 'available' && (
          <button className="btn-primary" disabled={busy} onClick={handleDownload}>
            {t('upd.downloadBtn', { v: newVer ?? '' })}
          </button>
        )}
        {s === 'downloaded' && (
          <button className="btn-primary" onClick={handleRestart}>
            {t('upd.installBtn')}
          </button>
        )}
        <button className="btn-ghost" onClick={handleOpenChangelog}>
          {t('upd.changelogBtn')}
        </button>
      </div>

      {notice && <Notice ok={notice.ok} text={notice.text} />}

      {!isPackaged && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-1">
          {t('upd.devHint')}
        </p>
      )}

      {isPackaged && info.isPortable && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-1">
          {t('upd.portableHint')}
        </p>
      )}

      <Modal open={changelogOpen} title={t('upd.changelogTitle')} onClose={() => setChangelogOpen(false)} width={520}>
        {changelogLoading ? (
          <EmptyState className="text-xs text-[var(--color-text-muted)] text-center py-8" message={t('upd.changelogLoading')} />
        ) : changelogError ? (
          <div className="text-xs text-[var(--color-danger)] text-center py-8">{t('upd.changelogFail', { e: changelogError })}</div>
        ) : releases.length === 0 ? (
          <EmptyState className="text-xs text-[var(--color-text-muted)] text-center py-8" message={t('upd.changelogEmpty')} />
        ) : (
          <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-4">
            {releases.map((r) => {
              const d = r.date ? new Date(r.date) : null
              const dateStr = d && !isNaN(d.getTime())
                ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                : ''
              return (
                <div key={r.tag} className="border-b border-[var(--color-border)]/50 pb-3 last:border-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[13px] font-semibold text-[var(--color-text)]">{r.tag}</span>
                    {r.prerelease && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-warning-bg)] text-[var(--color-warning)]">{t('upd.changelogPrerelease')}</span>
                    )}
                    {dateStr && <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">{dateStr}</span>}
                  </div>
                  {r.name && r.name !== r.tag && (
                    <div className="text-[12px] text-[var(--color-text)] mb-1">{r.name}</div>
                  )}
                  {r.body ? (
                    <pre className="text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed font-sans">{r.body}</pre>
                  ) : null}
                  {safeHttpHref(r.url) && (
                    <a
                      href={safeHttpHref(r.url)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-1 text-[11px] text-[var(--color-accent)] hover:underline"
                    >
                      {t('upd.changelogViewOnGitHub')} →
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Modal>

      {dialog}
    </div>
  )
}
