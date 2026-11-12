// 数据健康面板：数据体量明细 + 知识库索引状态 + 知识库完整性 + 备份与维护任务运行情况
// 数据来源：dataHealth:get 聚合（只读探测，见 src/main/steward/data-health.ts）
// 修复动作：dataHealth:kb-clean / kb-dedup / kb-reindex（见 src/main/knowledge/kb-health.ts）
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { DataHealthReport, KbDocument, KbDuplicateGroup, KbProviderRole } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { useConfirm } from '../../components/ConfirmDialog'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { StaleValueNotice } from '../../components/StaleValueNotice'
import { reportIpcError, hasIpcFailed, ipcFailText } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { formatBytes } from '../../utils/format'
import { formatVectorIndex } from '../../utils/vector-index'

function fmtTime(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toLocaleString()
}

export const DataHealthPanel: React.FC = () => {
  const { t } = useI18n()
  // 5 个 provider 角色 ↔ i18n 的 dh.integrity.role.*：字面量表钉住完整性（不再运行时拼 key）
  const providerRoleText = {
    embedding: t('dh.integrity.role.embedding'),
    rerank: t('dh.integrity.role.rerank'),
    hyde: t('dh.integrity.role.hyde'),
    multiquery: t('dh.integrity.role.multiquery'),
    ocr: t('dh.integrity.role.ocr')
  } satisfies Record<KbProviderRole, string>
  const toast = useToast()
  const { confirm, dialog } = useConfirm()
  const [report, setReport] = useState<DataHealthReport | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const reindexTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reindexToken = useRef(0)

  /** safeHandle 的失败是 resolve 的 `{ok:false}`：弹错并告诉调用方"这次没做成"（返回 true＝失败已处理） */
  const failAction = (r: unknown): boolean => {
    if (!hasIpcFailed(r)) return false
    toast.error(ipcFailText(r, t('common.unknownError')))
    return true
  }

  /** @param refresh 只有面板那颗「刷新」按钮会传 true：连浏览器缓存那一格也重算（V4-Iter-177） */
  const load = useCallback((refresh = false) => {
    // §221：失败对象写进 report ⇒ 下面那句 `if (!report)` 拦不住，紧跟着解构 report.sizes 当场崩。
    // §222：光弹一条 toast 不够——本体从此停在「加载中…」，把"这次没读到"说成"还在加载"，
    // 所以原因同时落到常驻那句（LoadFailNotice）上
    window.pocketai
      .getDataHealth(refresh)
      .then((r) => {
        if (hasIpcFailed(r)) {
          const msg = ipcFailText(r, t('common.unknownError'))
          toast.error(msg)
          setLoadErr(msg)
          return
        }
        setLoadErr(null)
        setReport(r)
      })
      // §345：reject 面只进 console ⇒ 旧报告照摆着却没人说；与本批其余各处同口径写进同一份 err
      .catch((e: unknown) => {
        setLoadErr(errText(e, t('common.unknownError')))
        reportIpcError('dataHealth.get')(e)
      })
  }, [t, toast])

  useEffect(() => {
    load()
  }, [load])

  // 卸载时停掉重建完成轮询，避免定时器继续碰已卸载组件的 state
  useEffect(
    () => () => {
      reindexToken.current += 1
      if (reindexTimer.current) clearTimeout(reindexTimer.current)
    },
    []
  )

  /**
   * 重建入队后等到目标文档真正跑完再重扫健康度。
   * 入队即 load() 会让用户看到"点了重建，提示还在"，误以为没生效；这里只轮询轻量的文档状态，
   * 目标文档全部离开 pending/parsing/indexing（或达到兜底次数）后，再重算完整报告。
   */
  const pollReindexDone = useCallback(
    (targets: Array<{ kbId: string; docId: string }>) => {
      const token = ++reindexToken.current
      if (reindexTimer.current) clearTimeout(reindexTimer.current)
      const maxAttempts = 150 // 2s × 150 ≈ 5 分钟兜底，避免队列卡住时无限轮询
      let attempts = 0
      setReindexing(true)

      const tick = async (): Promise<void> => {
        if (token !== reindexToken.current) return
        attempts += 1
        try {
          const kbIds = [...new Set(targets.map((t) => t.kbId))]
          const lists = await Promise.all(kbIds.map((id) => window.pocketai.listKbDocuments(id)))
          const failed = lists.find((l) => hasIpcFailed(l))
          if (failed) {
            load()
            setReindexing(false)
            return
          }
          const docsById = new Map<string, KbDocument>()
          for (const list of lists) for (const d of list) docsById.set(d.id, d)
          const stillRunning = targets.some((t) => {
            const d = docsById.get(t.docId)
            return d !== undefined && (d.status === 'pending' || d.status === 'parsing' || d.status === 'indexing')
          })
          if (!stillRunning || attempts >= maxAttempts) {
            load()
            setReindexing(false)
            return
          }
        } catch (e) {
          reportIpcError('dataHealth.kbReindexPoll')(e)
          load()
          setReindexing(false)
          return
        }
        reindexTimer.current = setTimeout(() => {
          void tick()
        }, 2000)
      }
      reindexTimer.current = setTimeout(() => {
        void tick()
      }, 2000)
    },
    [load]
  )

  /** 修复动作统一包装：执行 → 成功提示 → 刷新报告；fn 返回 null 表示"这次没做成"（失败提示由 fn 自己弹） */
  const runAction = useCallback(
    async (tag: string, fn: () => Promise<string | null>, reload = true) => {
      setBusy(true)
      try {
        // 原先是无条件 `toast.success(await fn())`：safeHandle 的失败是 resolve 的 `{ok:false}`，
        // 于是绿色提示会说「已清理 undefined 条孤儿向量、undefined 条孤儿分块」，而实际一条都没动（§216）
        const text = await fn()
        if (text !== null) toast.success(text)
        if (reload) load()
      } catch (e) {
        reportIpcError(tag)(e)
      } finally {
        setBusy(false)
      }
    },
    [toast, load]
  )

  const onClean = () =>
    runAction('dataHealth.kbClean', async () => {
      const r = await window.pocketai.cleanKbOrphans()
      if (failAction(r)) return null
      return t('dh.integrity.cleanDone', { vectors: r.removedVectors, chunks: r.removedChunks })
    })

  const onReindex = () => {
    const targets = report!.kb.integrity.brokenDocs.map((d) => ({ kbId: d.kbId, docId: d.id }))
    return runAction(
      'dataHealth.kbReindex',
      async () => {
        const r = await window.pocketai.reindexKbDocs(targets.map((d) => d.docId))
        if (failAction(r)) return null
        // 入队后不立刻重扫：等这些文档真正跑完再刷新，才能看到「不匹配」消失；空队列才直接刷新
        if (r.enqueued > 0) pollReindexDone(targets)
        else load()
        return t('dh.integrity.reindexDone', { count: r.enqueued })
      },
      false
    )
  }

  const onDedup = async (group: KbDuplicateGroup) => {
    const removeCount = group.docs.length - 1
    if (removeCount < 1) return
    if (!(await confirm({ message: t('dh.integrity.dedupConfirm', { count: removeCount }), danger: true }))) return
    runAction('dataHealth.kbDedup', async () => {
      const r = await window.pocketai.deduplicateKbDocs(group.docs[0]!.id)
      if (failAction(r)) return null
      return t('dh.integrity.dedupDone', { count: r.removed })
    })
  }

  /**
   * 「浏览器缓存」那一格旁的只读跳转（打开数据目录本身，不接收任何路径入参）。
   * 这是用户主动点的操作 ⇒ 失败必须弹 toast，不许用 reportIpcError 咽成"点了没反应"（utils/ipc 的边界注释）。
   */
  const onOpenDir = async () => {
    setBusy(true)
    try {
      const r = await window.pocketai.openDataFolder()
      if (hasIpcFailed(r)) toast.error(t('common.opFailed', { msg: ipcFailText(r, t('common.unknownError')) }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 清 HTTP 缓存（V4-Iter-189）：落点是"用户按下这颗按钮才动"，不自动、也不在退出时顺手做——
   * 台账 V4-Iter-182 给的理由是一条产品口径：缓存对 USB 冷启动与离线场景是资产不是垃圾。
   * 失败必须弹 toast 且不许显示「已清理」；成功要把前后两个数一起给出来，让人看得见它到底清掉了多少。
   */
  const onClearCache = async () => {
    // §378：这一发原先写 `report ? formatBytes(...) : formatBytes(0)`，借"0 字节"当"没有报告"的哨兵——
    // 而那颗「清理」键只在上面 `if (!report)` 那道门之后才存在（那个分支根本走不到），
    // 加上 0 现在老实说「0 B」，这句留着就是把"没读到"演成"读到 0"，所以改成早退而不是三元。
    if (!report) return
    const shown = formatBytes(report.sizes.browserCacheBytes)
    if (!(await confirm({ message: t('dh.browserCache.clearConfirm', { bytes: shown }), danger: true }))) return
    setBusy(true)
    try {
      const r = await window.pocketai.clearBrowserCache()
      if (hasIpcFailed(r)) {
        toast.error(t('common.opFailed', { msg: ipcFailText(r, t('common.unknownError')) }))
      } else {
        toast.success(t('dh.browserCache.clearDone', { before: formatBytes(r.beforeBytes), after: formatBytes(r.afterBytes) }))
      }
      load()
    } catch (e) {
      reportIpcError('dataHealth.clearBrowserCache')(e)
      load()
    } finally {
      setBusy(false)
    }
  }

  if (!report) {
    // §222：读失败与还没读到是两件事——前者要把原因留在界面上（toast 会消失，而这块一直挂着「加载中…」）
    // §350：这一支以前同屏没有出口——本体那颗「刷新」长在 report 到了之后的那块里，首读失败时它根本不在屏上
    //（真机 §349 也是这条：数据恢复后这句不会自己变）。补同级一颗，走的正是本体那颗的同一个入口 `load(true)`。
    if (loadErr) {
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <LoadFailNotice msg={loadErr} />
          <button
            data-testid="data-health-read-retry"
            className="text-xs underline text-[var(--color-text-muted)]"
            onClick={() => load(true)}
          >
            {t('agent.retryRead')}
          </button>
        </div>
      )
    }
    return <div className="text-xs text-[var(--color-text-muted)] py-3">{t('common.loading')}</div>
  }

  const { sizes, approvals, kb, backup, tasks } = report
  // §436：审批段是后加字段，旧夹具/旧报告可能没有。
  // 缺字段时降级成 0 并在顶部挂一句「数据不可读」，不许整屏白（:342 的 TypeError 就是这么炸的）。
  //
  // 冷数据/快照/审批条数已并入平台管家「数据健康」卡：这里不再渲染计数，
  // 但报告仍由同一次 `getDataHealth` 读回来（管家另读一发），所以 `sizes` 的冷字段继续留在类型里。
  const approvalsOk =
    approvals !== null &&
    approvals !== undefined &&
    typeof approvals.rows === 'number'
  const reportIncomplete = !approvalsOk
  const integrity = kb.integrity
  const hasDimMismatch = integrity.brokenDocs.some((d) => d.reason === 'dim-mismatch')
  const integrityOk =
    integrity.orphanVectors === 0 &&
    integrity.orphanChunks === 0 &&
    integrity.brokenDocs.length === 0 &&
    integrity.duplicates.length === 0 &&
    integrity.providerIssues.length === 0

  // §395：维护任务那一格的时间戳来自 `last_run_at`，它在成功与失败两种收尾里都写
  //        ⇒ 单摆时间等于把「跑过但失败」画成「跑过且成功」。这里按三档说话：
  //        true 说「未报错」（跳过校验的一跑也算跑完没抛，所以不说"成功"）、false 说「失败」并染色、
  //        null（这一版之前跑过的旧数据）只报时间，不替它编一档。
  const taskResult = (lastRunAt: number | null, lastOk: boolean | null): string => {
    if (lastRunAt === null) return t('dh.never')
    const at = fmtTime(lastRunAt)
    return lastOk === true
      ? `${at} · ${t('dh.task.lastOk')}`
      : lastOk === false
        ? `${at} · ${t('dh.task.lastFailed')}`
        : at
  }

  return (
    <div>
      {/* §345：`load(true)`（那颗「刷新」键）与各修复动作后的重扫都会再读一发；失败侧旧报告留着是对的，
          但得说出"下面这份是上一次读到的"——否则刚点过修复的屏看着像"数字没变＝修复没效" */}
      {loadErr && (
        <div className="mb-2">
          <StaleValueNotice what={t('set.dataHealth')} msg={loadErr} onRetry={() => load(true)} testid="data-health-stale-retry" />
        </div>
      )}
      {reportIncomplete && (
        <div role="status" className="mb-2 text-[11px] text-[var(--color-text-muted)]">
          {t('dh.reportIncomplete')}
        </div>
      )}
      {/* 磁盘占用摘要：体积明细（主库/附件/扩展/日志/其他）与冷数据计数已并入平台管家
          「数据健康」卡；设置侧只留合计一行，免得同一批数字在两处各算一次、各显示一次。 */}
      <div className="mb-4 space-y-1">
        <Row label={t('dh.total')} value={formatBytes(sizes.userDataBytes)} />
        {/* 浏览器缓存：Electron 自己的档案树，不进上面那颗「合计」，按「刷新」才重算（V4-Iter-177） */}
        <Row
          label={t('dh.browserCache')}
          value={t('dh.browserCacheValue', {
            bytes: formatBytes(sizes.browserCacheBytes),
            count: sizes.browserCacheFiles.toLocaleString('en-US')
          })}
        />
        <div className="flex flex-wrap gap-2">
          <button onClick={onOpenDir} disabled={busy} className="chip">{t('dh.browserCache.open')}</button>
          <button onClick={onClearCache} disabled={busy} className="chip">{t('dh.browserCache.clear')}</button>
        </div>
      </div>

      {/* 知识库索引状态 */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.kbStatus')}</div>
      <div className="mb-2">
        <Row label={t('dh.vectorIndex')} value={formatVectorIndex(kb.vectorIndex, t)} />
      </div>
      {kb.total === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-4">{t('dh.noKbDocs')}</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-2">
            <span className="chip">{t('dh.kbTotal', { count: kb.total })}</span>
          </div>
          {kb.errorDocs.length > 0 && (
            <table className="w-full text-xs mb-4">
              <thead>
                <tr className="text-left text-[var(--color-text-muted)]">
                  <th className="py-1 pr-2 font-normal">{t('dh.errorDocs')}</th>
                  <th className="py-1 pr-2 font-normal">{t('dh.reason')}</th>
                  <th className="py-1 font-normal text-right">{t('dh.date')}</th>
                </tr>
              </thead>
              <tbody>
                {kb.errorDocs.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-2 truncate max-w-0">
                      <span className="text-[var(--color-text)]">{d.title}</span>
                      <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">{d.kbName}</span>
                    </td>
                    <td className="py-1.5 pr-2 truncate max-w-0 text-[var(--color-warning)]" title={d.error ?? ''}>
                      {d.error ?? '-'}
                    </td>
                    <td className="py-1.5 text-right text-[var(--color-text-muted)] whitespace-nowrap">
                      {new Date(d.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {kb.total > 0 && kb.errorDocs.length === 0 && <div className="mb-4" />}

      {/* 知识库完整性（孤儿数据 / 需重建索引 / 重复文档 / 失效模型配置，探测见 kb-health.ts） */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.integrity.title')}</div>
      {integrityOk ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-4">{t('dh.integrity.ok')}</div>
      ) : (
        <div className="space-y-2 mb-4">
          {(integrity.orphanVectors > 0 || integrity.orphanChunks > 0) && (
            <div>
              <div className="space-y-1 mb-1.5">
                {integrity.orphanVectors > 0 && (
                  <Row label={t('dh.integrity.orphanVectors')} value={String(integrity.orphanVectors)} warn />
                )}
                {integrity.orphanChunks > 0 && (
                  <Row label={t('dh.integrity.orphanChunks')} value={String(integrity.orphanChunks)} warn />
                )}
              </div>
              <button onClick={onClean} disabled={busy} className="chip">{t('dh.integrity.clean')}</button>
            </div>
          )}

          {integrity.brokenDocs.length > 0 && (
            <div>
              <table className="w-full text-xs mb-1.5">
                <tbody>
                  {integrity.brokenDocs.slice(0, 10).map((d) => (
                    <tr key={d.id} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5 pr-2 truncate max-w-0">
                        <span className="text-[var(--color-text)]">{d.title}</span>
                        <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">{d.kbName}</span>
                      </td>
                      <td className="py-1.5 text-right text-[var(--color-warning)] whitespace-nowrap">
                        {t(`dh.integrity.reason.${d.reason}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hasDimMismatch && (
                <div className="text-[11px] text-[var(--color-text-muted)] mb-1.5 leading-relaxed">
                  {t('dh.integrity.dimMismatchHint')}
                </div>
              )}
              <button onClick={onReindex} disabled={busy || reindexing} className="chip">{t('dh.integrity.reindex')}</button>
            </div>
          )}

          {integrity.duplicates.length > 0 && (
            <div>
              {integrity.duplicates.slice(0, 10).map((g) => (
                <div key={`${g.kbId}-${g.hash.slice(0, 8)}`} className="flex items-center gap-2 text-xs border-t border-[var(--color-border)] py-1.5">
                  <span className="text-[var(--color-warning)] shrink-0">{t('dh.integrity.dupCount', { count: g.docs.length })}</span>
                  <span className="truncate flex-1 text-[var(--color-text)]" title={g.docs.map((d) => d.title).join(' / ')}>
                    <span className="text-[10px] text-[var(--color-text-muted)] mr-1.5">{g.kbName}</span>
                    {g.docs.map((d) => d.title).join(' / ')}
                  </span>
                  <button onClick={() => onDedup(g)} disabled={busy} className="chip shrink-0">
                    {t('dh.integrity.dedup')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {integrity.providerIssues.length > 0 && (
            <table className="w-full text-xs">
              <tbody>
                {integrity.providerIssues.map((p, i) => (
                  <tr key={`${p.kbId}-${p.role}-${i}`} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-2 truncate max-w-0">
                      <span className="text-[10px] text-[var(--color-text-muted)] mr-1.5">{p.kbName}</span>
                      <span className="text-[var(--color-text)]">{providerRoleText[p.role]}</span>
                    </td>
                    <td className="py-1.5 text-right text-[var(--color-warning)] whitespace-nowrap">
                      {t(`dh.integrity.issue.${p.issue}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 备份与维护任务 */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.backup')}</div>
      <div className="space-y-1 mb-2">
        <Row
          label={t('dh.backupState')}
          value={
            // §386：「那一行读不出来」排在最前——它也让 configured 落成 false，
            // 但说"未配置"会把用户支去填一份新配置，而点保存正好覆盖掉那份坏行（unknown 不许演成"没有"＝§377 同一把尺子）
            backup.configUnreadable
              ? t('dh.backupCfgBroken')
              : !backup.configured
                ? t('dh.backupNotConfigured')
                : backup.passwordUndecryptable
                  ? t('dh.backupPwdBroken')
                  : backup.enabled
                    ? t('dh.backupOn', { hours: backup.intervalHours })
                    : t('dh.backupOff')
          }
          warn={backup.configUnreadable || !backup.configured || backup.passwordUndecryptable || !backup.enabled}
        />
        <Row
          label={t('dh.lastOk')}
          value={backup.lastOkAt === null ? t('dh.never') : fmtTime(backup.lastOkAt)}
          warn={backup.lastOkAt === null}
        />
        {backup.lastError && <Row label={t('dh.lastError')} value={backup.lastError} warn />}
      </div>

      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.tasks')}</div>
      {/* §415：这一栏只报了"上次什么时候跑的"，没说它什么时候不跑——判据是 last_run_at 的间隔，
          所以应用没开着时到点的任务会在下次启动后补跑（不是丢掉），这句得写在屏上 */}
      <div className="mb-1.5 text-[11px] text-[var(--color-text-muted)] leading-relaxed" data-testid="dh-tasks-run-hint">
        {t('dh.tasksRunHint')}
      </div>
      <div className="space-y-1">
        <Row
          label={t('dh.task.kbHealthCheck')}
          value={taskResult(tasks.kbHealthCheckLastRunAt, tasks.kbHealthCheckLastOk)}
          warn={tasks.kbHealthCheckLastOk === false}
        />
        <Row
          label={t('dh.task.backupVerify')}
          value={taskResult(tasks.backupVerifyLastRunAt, tasks.backupVerifyLastOk)}
          warn={tasks.backupVerifyLastOk === false}
        />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => load(true)} className="chip">{t('dh.refresh')}</button>
      </div>
      {dialog}
    </div>
  )
}

const Row: React.FC<{ label: string; value: string; warn?: boolean }> = ({ label, value, warn }) => (
  <div className="flex justify-between gap-4 text-sm">
    <span className="text-[var(--color-text-muted)] truncate">{label}</span>
    <span className={`text-right text-xs truncate ${warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-text)]'}`} title={value}>
      {value}
    </span>
  </div>
)
