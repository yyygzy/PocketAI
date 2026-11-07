// 数据健康面板：数据体量明细 + 知识库索引状态 + 知识库完整性 + 备份与维护任务运行情况
// 数据来源：dataHealth:get 聚合（只读探测，见 src/main/steward/data-health.ts）
// 修复动作：dataHealth:kb-clean / kb-dedup / kb-reindex（见 src/main/knowledge/kb-health.ts）
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { DataHealthReport, KbDocStatus, KbDocument, KbDuplicateGroup, KbProviderRole } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { useConfirm } from '../../components/ConfirmDialog'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { StaleValueNotice } from '../../components/StaleValueNotice'
import { reportIpcError, hasIpcFailed, ipcFailText } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { formatBytes } from '../../utils/format'
import { formatVectorIndex } from '../../utils/vector-index'
import { formatTraceLedger } from '../../utils/trace-ledger'

const STATUSES: KbDocStatus[] = ['pending', 'parsing', 'indexing', 'ready', 'error']

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

  /**
   * 清空审批审计账本（P0-2c-1）：显式动作，与「清理 HTTP 缓存」同款确认框。
   * 失败必须弹 toast（不许把"没清掉"画成「已清空」）；成功把实际删除条数报出来。
   */
  const onClearApprovals = async () => {
    if (!report) return
    if (!(await confirm({ message: t('dh.approvals.clearConfirm', { rows: report.approvals?.rows ?? 0 }), danger: true }))) return
    setBusy(true)
    try {
      const r = await window.pocketai.clearApprovalRecords()
      if (hasIpcFailed(r)) {
        toast.error(t('common.opFailed', { msg: ipcFailText(r, t('common.unknownError')) }))
      } else {
        toast.success(t('dh.approvals.clearDone', { count: r.cleared }))
      }
      load()
    } catch (e) {
      reportIpcError('dataHealth.clearApprovals')(e)
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

  const { sizes, traces, approvals, coldFailures, kb, backup, tasks, boot, recentPerf, perfHistory } = report
  // §436：冷数据段（P0-5）与审批段（P0-2c）是后加字段，旧夹具/旧报告可能没有。
  // 缺字段时降级成 0 并在顶部挂一句「数据不可读」，不许整屏白（:342 的 TypeError 就是这么炸的）。
  const coldOk =
    typeof sizes.coldOffloadBytes === 'number' &&
    typeof sizes.coldOffloadFiles === 'number' &&
    typeof sizes.coldSnapshotBytes === 'number' &&
    typeof sizes.coldSnapshotFiles === 'number'
  const coldFailuresOk =
    coldFailures !== null &&
    coldFailures !== undefined &&
    typeof coldFailures.purge === 'number' &&
    typeof coldFailures.offloadPrune === 'number' &&
    typeof coldFailures.snapshotPrune === 'number'
  const approvalsOk =
    approvals !== null &&
    approvals !== undefined &&
    typeof approvals.rows === 'number' &&
    typeof approvals.writeFailures === 'number'
  const reportIncomplete = !coldOk || !coldFailuresOk || !approvalsOk
  const coldOffloadBytes = coldOk ? sizes.coldOffloadBytes : 0
  const coldOffloadFiles = coldOk ? sizes.coldOffloadFiles : 0
  const coldSnapshotBytes = coldOk ? sizes.coldSnapshotBytes : 0
  const coldSnapshotFiles = coldOk ? sizes.coldSnapshotFiles : 0
  const coldPurge = coldFailuresOk ? coldFailures.purge : 0
  const coldOffloadPrune = coldFailuresOk ? coldFailures.offloadPrune : 0
  const coldSnapshotPrune = coldFailuresOk ? coldFailures.snapshotPrune : 0
  const approvalsRows = approvalsOk ? approvals.rows : 0
  const approvalsFailures = approvalsOk ? approvals.writeFailures : 0
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
      {/* 体积汇总卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
        <StatCard label={t('dh.total')} value={formatBytes(sizes.userDataBytes)} />
        <StatCard label={t('dh.db')} value={formatBytes(sizes.dbBytes)} />
        <StatCard label={t('dh.vectorIndex')} value={formatVectorIndex(kb.vectorIndex, t)} />
        <StatCard label={t('dh.attachments')} value={formatBytes(sizes.attachmentsBytes)} />
      </div>

      {/* 体积明细行 */}
      <div className="mb-4 space-y-1">
        <BarRow label={t('dh.extensions')} ratio={sizes.userDataBytes > 0 ? sizes.extensionsBytes / sizes.userDataBytes : 0} value={formatBytes(sizes.extensionsBytes)} />
        <BarRow label={t('dh.logs')} ratio={sizes.userDataBytes > 0 ? sizes.logsBytes / sizes.userDataBytes : 0} value={formatBytes(sizes.logsBytes)} />
        <BarRow label={t('dh.other')} ratio={sizes.userDataBytes > 0 ? sizes.otherBytes / sizes.userDataBytes : 0} value={formatBytes(sizes.otherBytes)} />
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

      {/* 冷数据（P0-5 第三批）：以前混在「其他」里，用户既看不见也判断不了该不该在意。
          这里只读列出体积与条数 + 三路清理失败计数；**不放一键清空**——那会和引用关系、
          还原入口打架，留给以后专门设计。 */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.coldData')}</div>
      <div className="mb-4 space-y-1">
        <BarRow
          label={t('dh.coldOffload')}
          ratio={sizes.userDataBytes > 0 ? coldOffloadBytes / sizes.userDataBytes : 0}
          value={t('dh.coldOffloadValue', {
            bytes: formatBytes(coldOffloadBytes),
            count: coldOffloadFiles.toLocaleString('en-US')
          })}
        />
        <BarRow
          label={t('dh.coldSnapshots')}
          ratio={sizes.userDataBytes > 0 ? coldSnapshotBytes / sizes.userDataBytes : 0}
          value={t('dh.coldSnapshotValue', {
            bytes: formatBytes(coldSnapshotBytes),
            count: coldSnapshotFiles.toLocaleString('en-US')
          })}
        />
        <Row
          label={t('dh.coldFailures')}
          value={t('dh.coldFailuresValue', {
            purge: coldPurge,
            prune: coldOffloadPrune,
            snapshot: coldSnapshotPrune
          })}
          warn={coldPurge + coldOffloadPrune + coldSnapshotPrune > 0}
        />
        <div className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{t('dh.coldFailuresHint')}</div>
      </div>

      {/* Agent 运行账本的规模（探测见 agent-trace.repo.countForHealth；为什么报这两个数见台账 V4-Iter-173） */}
      <div className="mb-4 space-y-1">
        <Row label={t('dh.traces')} value={formatTraceLedger(traces, t)} />
      </div>

      {/* 审批审计账本（approval_events，P0-2c-1）：行数 + 本次进程写失败次数。
          口径是「会话存在期间可回溯」，删会话会级联删除；不写成永久可查。 */}
      <div className="mb-4 space-y-1">
        <Row
          label={t('dh.approvals')}
          value={
            approvalsRows === 0
              ? t('dh.approvals.empty')
              : t('dh.approvals.value', { rows: approvalsRows.toLocaleString('en-US'), failures: approvalsFailures })
          }
          warn={approvalsFailures > 0}
        />
        <div className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{t('dh.approvals.hint')}</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={onClearApprovals} disabled={busy || approvalsRows === 0} className="chip">
            {t('dh.approvals.clear')}
          </button>
        </div>
      </div>

      {/* 知识库索引状态 */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.kbStatus')}</div>
      {kb.total === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-4">{t('dh.noKbDocs')}</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-2">
            <span className="chip">{t('dh.kbTotal', { count: kb.total })}</span>
            {STATUSES.map((st) =>
              kb.byStatus[st] > 0 ? (
                <span key={st} className={`chip ${st === 'error' ? 'chip-danger' : st === 'ready' ? 'chip-accent' : ''}`}>
                  {t(`kb.st.${st}`)} {kb.byStatus[st]}
                </span>
              ) : null
            )}
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

      {/* 本次启动耗时（USB 冷启动可视化；埋点见 src/main/steward/boot-perf.ts） */}
      <div className="mt-4 mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.boot.title')}</div>
      <div className="space-y-1">
        {boot.stages.map((s) => (
          <BarRow
            key={s.id}
            label={t(`dh.boot.${s.id}`)}
            ratio={boot.totalMs > 0 ? s.ms / boot.totalMs : 0}
            value={`${s.ms}ms`}
          />
        ))}
      </div>
      <div className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
        {t('dh.boot.total', { ms: boot.totalMs })} · {t('dh.boot.hint')}
      </div>

      {/* 最近慢操作（运行期埋点环形缓冲，见 src/main/steward/perf-probe.ts） */}
      <div className="mt-4 mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.perf.title')}</div>
      {recentPerf.length === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('dh.perf.empty')}</div>
      ) : (
        <div className="space-y-1 mb-2">
          {recentPerf.slice(-10).reverse().map((p, i) => {
            const lk = `dh.perf.label.${p.label}`
            const ll = t(lk)
            return (
              <div key={`${p.at}-${i}`} title={p.detail ?? ''}>
                <Row
                  label={ll === lk ? p.label : ll}
                  value={`${p.ms}ms · ${new Date(p.at).toLocaleTimeString()}`}
                  warn={p.ms >= 3000 || p.label === 'kb.degrade'}
                />
              </div>
            )
          })}
        </div>
      )}

      {/* 跨会话慢事件统计（读日志尾部聚合，见 src/main/steward/perf-history.ts） */}
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('dh.perf.histTitle')}</div>
      {perfHistory.length === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('dh.perf.histEmpty')}</div>
      ) : (
        <div className="space-y-1 mb-2">
          {perfHistory.map((h) => {
            const lk = `dh.perf.label.${h.label}`
            const ll = t(lk)
            const last = h.lastAt > 0 ? new Date(h.lastAt).toLocaleString() : '-'
            return (
              <div key={h.label}>
                <Row
                  label={ll === lk ? h.label : ll}
                  value={t('dh.perf.histRow', {
                    count: h.count,
                    p50: h.p50Ms,
                    max: h.maxMs,
                    last
                  })}
                  warn={h.maxMs >= 3000 || h.label === 'kb.degrade'}
                />
                {/* 同一标签按模型拆开才答得出「哪个模型慢」——混在一起的峰值归因不到具体模型 */}
                {h.byModel.map((m) => (
                  <Row
                    key={m.model}
                    mono
                    label={'· ' + m.model}
                    value={t('dh.perf.histModel', { count: m.count, p50: m.p50Ms, max: m.maxMs })}
                    warn={m.maxMs >= 3000}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => load(true)} className="chip">{t('dh.refresh')}</button>
      </div>
      {dialog}
    </div>
  )
}

const StatCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
    <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
    <div className="text-base font-semibold font-mono text-[var(--color-text)] mt-0.5">{value}</div>
  </div>
)

/** 占比条行：名称 + 比例条 + 右侧值（体积明细 / 启动耗时共用） */
const BarRow: React.FC<{ label: string; ratio: number; value: string }> = ({ label, ratio, value }) => (
  <div className="flex items-center gap-2 text-[11px]">
    <span className="text-[var(--color-text-muted)] w-28 shrink-0 truncate" title={label}>{label}</span>
    <div className="h-1.5 rounded bg-[var(--color-sidebar)] overflow-hidden flex-1">
      <div
        className="h-full rounded bg-[var(--color-accent)] opacity-70"
        style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 1 : 0)}%` }}
      />
    </div>
    <span className="font-mono text-[var(--color-text)] w-20 text-right shrink-0">{value}</span>
  </div>
)

const Row: React.FC<{ label: string; value: string; warn?: boolean; mono?: boolean }> = ({ label, value, warn, mono }) => (
  <div className="flex justify-between gap-4 text-sm">
    <span className={'text-[var(--color-text-muted)] truncate ' + (mono ? 'font-mono' : '')}>{label}</span>
    <span className={`text-right text-xs truncate ${warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-text)]'}`} title={value}>
      {value}
    </span>
  </div>
)
