// 知识库模块：KB 列表 / 创建编辑 / 文档管理 / 分块预览 / 检索测试
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  KnowledgeBase,
  KbDocument,
  KbChunk,
  RetrievedChunk,
  ProviderRecord
} from '../../../../shared/types'
import { BUILTIN_EMBED_PROVIDER_ID, BUILTIN_EMBED_MODEL } from '../../../../shared/types'
import KbAskPanel from './KbAskPanel'
import { consumePendingSourceJump, KB_SOURCE_JUMP_EVENT } from './source-jump'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { useConfirm } from '../../components/ConfirmDialog'

export const KnowledgeModule: React.FC = () => {
  const { t } = useI18n()
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'detail' | 'create'>('detail')
  /** 来源跳转待定位目标（聊天/KB 问答来源块 → 本模块定位分块） */
  const [jumpFocus, setJumpFocus] = useState<{ docId: string; seq: number } | null>(null)

  const load = useCallback(() => window.pocketai.listKnowledgeBases().then(setKbs).catch(reportIpcError('kb.list')), [])
  useEffect(() => {
    load()
  }, [load])

  // 来源跳转：已挂载时即时消费事件；未挂载场景由 App 切模块后从 pending 消费
  useEffect(() => {
    const consume = (d: { kbId: string; docId: string; seq: number }) => {
      setMode('detail')
      setSelectedId(d.kbId)
      setJumpFocus({ docId: d.docId, seq: d.seq })
    }
    const handler = () => {
      const d = consumePendingSourceJump()
      if (d) consume(d)
    }
    window.addEventListener(KB_SOURCE_JUMP_EVENT, handler)
    const pending = consumePendingSourceJump()
    if (pending) consume(pending)
    return () => window.removeEventListener(KB_SOURCE_JUMP_EVENT, handler)
  }, [])

  const selected = kbs.find((k) => k.id === selectedId) ?? null

  return (
    <div className="flex gap-4 h-full">
      {/* 左侧：知识库列表 */}
      <div className="w-60 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">{t('kb.title')}</h3>
          <button
            onClick={() => {
              setMode('create')
              setSelectedId(null)
            }}
            className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
          >
            {t('kb.new')}
          </button>
        </div>
        <div className="space-y-1 overflow-y-auto">
          {kbs.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">{t('kb.empty')}</p>
          )}
          {kbs.map((k) => (
            <button
              key={k.id}
              onClick={() => {
                setMode('detail')
                setSelectedId(k.id)
              }}
              className={`w-full text-left px-3 py-2 rounded text-sm ${
                mode === 'detail' && selectedId === k.id
                  ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-hover-overlay)]'
              }`}
            >
              <div className="truncate">{k.name}</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                {t('kb.counts', { n: k.documentCount, m: k.chunkCount })}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 右侧 */}
      <div className="flex-1 overflow-y-auto">
        {mode === 'create' ? (
          <KbForm
            onSaved={(kb) => {
              setMode('detail')
              setSelectedId(kb.id)
              load()
            }}
            onCancel={() => setMode('detail')}
          />
        ) : selected ? (
          <KbDetail
            kb={selected}
            onChanged={load}
            jumpFocus={jumpFocus}
            onJumpHandled={() => setJumpFocus(null)}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--color-text-muted)]">
            {t('kb.selectPrompt')}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- 知识库创建/编辑表单 ----------
const KbForm: React.FC<{
  kb?: KnowledgeBase
  onSaved: (kb: KnowledgeBase) => void
  onCancel: () => void
}> = ({ kb, onSaved, onCancel }) => {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [name, setName] = useState(kb?.name ?? '')
  const [description, setDescription] = useState(kb?.description ?? '')
  const [providerId, setProviderId] = useState(kb?.embeddingProviderId ?? '')
  const [model, setModel] = useState(kb?.embeddingModel ?? '')
  const [chunkSize, setChunkSize] = useState(kb?.chunkSize ?? 800)
  const [chunkOverlap, setChunkOverlap] = useState(kb?.chunkOverlap ?? 200)
  const [topK, setTopK] = useState(kb?.topK ?? 20)
  const [topN, setTopN] = useState(kb?.topN ?? 5)
  const [rerankProviderId, setRerankProviderId] = useState(kb?.rerankProviderId ?? '')
  const [rerankModel, setRerankModel] = useState(kb?.rerankModel ?? '')
  const [hydeProviderId, setHydeProviderId] = useState(kb?.hydeProviderId ?? '')
  const [hydeModel, setHydeModel] = useState(kb?.hydeModel ?? '')
  const [multiQueryProviderId, setMultiQueryProviderId] = useState(kb?.multiQueryProviderId ?? '')
  const [multiQueryModel, setMultiQueryModel] = useState(kb?.multiQueryModel ?? '')
  const [ocrProviderId, setOcrProviderId] = useState(kb?.ocrProviderId ?? '')
  const [ocrModel, setOcrModel] = useState(kb?.ocrModel ?? '')
  const [error, setError] = useState('')

  useEffect(() => {
    window.pocketai.listProviders().then((ps) => setProviders(ps.filter((p) => p.enabled))).catch(reportIpcError('kb.listProviders'))
  }, [])

  const selectedProvider = providers.find((p) => p.id === providerId)
  const selectedRerankProvider = providers.find((p) => p.id === rerankProviderId)
  const selectedHydeProvider = providers.find((p) => p.id === hydeProviderId)
  const selectedMultiQueryProvider = providers.find((p) => p.id === multiQueryProviderId)
  const selectedOcrProvider = providers.find((p) => p.id === ocrProviderId)

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('kb.nameRequired'))
      return
    }
    if (!providerId || !model.trim()) {
      setError(t('kb.embRequired'))
      return
    }
    try {
      const saved = await window.pocketai.saveKnowledgeBase({
        id: kb?.id,
        name,
        description,
        embeddingProviderId: providerId,
        embeddingModel: model,
        chunkSize,
        chunkOverlap,
        topK,
        topN,
        rerankProviderId: rerankProviderId || null,
        rerankModel: rerankModel || null,
        hydeProviderId: hydeProviderId || null,
        hydeModel: hydeModel || null,
        multiQueryProviderId: multiQueryProviderId || null,
        multiQueryModel: multiQueryModel || null,
        ocrProviderId: ocrProviderId || null,
        ocrModel: ocrModel || null
      })
      onSaved(saved)
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h3 className="text-sm font-semibold">{kb ? t('kb.edit') : t('kb.create')}</h3>

      <Field label={t('kb.name')}>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('kb.namePh')}
        />
      </Field>

      <Field label={t('kb.description')}>
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('kb.descPh')}
        />
      </Field>

      <Field label={t('kb.embProvider')}>
        <select
          className="input"
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value)
            setModel(e.target.value === BUILTIN_EMBED_PROVIDER_ID ? BUILTIN_EMBED_MODEL : '')
          }}
        >
          <option value="">{t('kb.pleaseSelect')}</option>
          <option value={BUILTIN_EMBED_PROVIDER_ID}>{t('kb.builtinProvider')}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('kb.embModel')}>
        {providerId === BUILTIN_EMBED_PROVIDER_ID ? (
          <input className="input font-mono text-xs" value={BUILTIN_EMBED_MODEL} disabled readOnly />
        ) : selectedProvider && selectedProvider.models.length > 0 ? (
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t('kb.pleaseSelect')}</option>
            {selectedProvider.models
              .filter((m) => /embed|e5|bge|gte/i.test(m))
              .map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            {!selectedProvider.models.some((m) => /embed|e5|bge|gte/i.test(m)) &&
              selectedProvider.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
          </select>
        ) : (
          <input
            className="input font-mono text-xs"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="text-embedding-3-small"
          />
        )}
      </Field>

      {/* 重排序（可选）：用 LLM 对检索候选重排，提升精度 */}
      <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
        <div className="text-xs text-[var(--color-text-muted)]">{t('kb.rerankHint')}</div>
        <Field label={t('kb.rerankProvider')}>
          <select
            className="input"
            value={rerankProviderId}
            onChange={(e) => {
              setRerankProviderId(e.target.value)
              setRerankModel('')
            }}
          >
            <option value="">{t('kb.rerankDisabled')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {rerankProviderId && (
          <Field label={t('kb.rerankModel')}>
            {selectedRerankProvider && selectedRerankProvider.models.length > 0 ? (
              <select className="input" value={rerankModel} onChange={(e) => setRerankModel(e.target.value)}>
                <option value="">{t('kb.pleaseSelect')}</option>
                {selectedRerankProvider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input font-mono text-xs"
                value={rerankModel}
                onChange={(e) => setRerankModel(e.target.value)}
                placeholder="gpt-4o-mini"
              />
            )}
          </Field>
        )}
      </div>

      {/* HyDE 查询重写（可选）：用 LLM 生成假设文档做向量检索 */}
      <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
        <div className="text-xs text-[var(--color-text-muted)]">{t('kb.hydeHint')}</div>
        <Field label={t('kb.hydeProvider')}>
          <select
            className="input"
            value={hydeProviderId}
            onChange={(e) => {
              setHydeProviderId(e.target.value)
              setHydeModel('')
            }}
          >
            <option value="">{t('kb.hydeDisabled')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {hydeProviderId && (
          <Field label={t('kb.hydeModel')}>
            {selectedHydeProvider && selectedHydeProvider.models.length > 0 ? (
              <select className="input" value={hydeModel} onChange={(e) => setHydeModel(e.target.value)}>
                <option value="">{t('kb.pleaseSelect')}</option>
                {selectedHydeProvider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input font-mono text-xs"
                value={hydeModel}
                onChange={(e) => setHydeModel(e.target.value)}
                placeholder="gpt-4o-mini"
              />
            )}
          </Field>
        )}
      </div>

      {/* Multi-Query 多查询扩展（可选）：LLM 把问题改写成多个视角查询分别检索后融合 */}
      <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
        <div className="text-xs text-[var(--color-text-muted)]">{t('kb.multiQueryHint')}</div>
        <Field label={t('kb.multiQueryProvider')}>
          <select
            className="input"
            value={multiQueryProviderId}
            onChange={(e) => {
              setMultiQueryProviderId(e.target.value)
              setMultiQueryModel('')
            }}
          >
            <option value="">{t('kb.multiQueryDisabled')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {multiQueryProviderId && (
          <Field label={t('kb.multiQueryModel')}>
            {selectedMultiQueryProvider && selectedMultiQueryProvider.models.length > 0 ? (
              <select className="input" value={multiQueryModel} onChange={(e) => setMultiQueryModel(e.target.value)}>
                <option value="">{t('kb.pleaseSelect')}</option>
                {selectedMultiQueryProvider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input font-mono text-xs"
                value={multiQueryModel}
                onChange={(e) => setMultiQueryModel(e.target.value)}
                placeholder="gpt-4o-mini"
              />
            )}
          </Field>
        )}
      </div>

      {/* OCR 文字识别（可选）：图片文档入库时用视觉模型识别文字后走常规索引 */}
      <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
        <div className="text-xs text-[var(--color-text-muted)]">{t('kb.ocrHint')}</div>
        <Field label={t('kb.ocrProvider')}>
          <select
            className="input"
            value={ocrProviderId}
            onChange={(e) => {
              setOcrProviderId(e.target.value)
              setOcrModel('')
            }}
          >
            <option value="">{t('kb.ocrDisabled')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {ocrProviderId && (
          <Field label={t('kb.ocrModel')}>
            {selectedOcrProvider && selectedOcrProvider.models.length > 0 ? (
              <select className="input" value={ocrModel} onChange={(e) => setOcrModel(e.target.value)}>
                <option value="">{t('kb.pleaseSelect')}</option>
                {selectedOcrProvider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input font-mono text-xs"
                value={ocrModel}
                onChange={(e) => setOcrModel(e.target.value)}
                placeholder="gpt-4o-mini"
              />
            )}
          </Field>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('kb.chunkSize')}>
          <input
            type="number"
            className="input"
            value={chunkSize}
            onChange={(e) => setChunkSize(Number(e.target.value))}
          />
        </Field>
        <Field label={t('kb.chunkOverlap')}>
          <input
            type="number"
            className="input"
            value={chunkOverlap}
            onChange={(e) => setChunkOverlap(Number(e.target.value))}
          />
        </Field>
        <Field label={t('kb.topK')}>
          <input
            type="number"
            className="input"
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
          />
        </Field>
        <Field label={t('kb.topN')}>
          <input
            type="number"
            className="input"
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
          />
        </Field>
      </div>

      {kb?.embeddingDim !== undefined && kb?.embeddingDim !== null && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('kb.dim', { n: kb.embeddingDim })}
        </p>
      )}

      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button onClick={handleSave} className="btn-primary">
          {t('common.save')}
        </button>
        <button onClick={onCancel} className="btn-ghost">
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

// ---------- 知识库详情：文档 + 检索测试 ----------
const KbDetail: React.FC<{
  kb: KnowledgeBase
  onChanged: () => void
  jumpFocus?: { docId: string; seq: number } | null
  onJumpHandled?: () => void
}> = ({ kb, onChanged, jumpFocus, onJumpHandled }) => {
  const { t } = useI18n()
  const toast = useToast()
  const { confirm, dialog } = useConfirm()
  const [docs, setDocs] = useState<KbDocument[]>([])
  const [editing, setEditing] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<KbDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [askMode, setAskMode] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadDocs = useCallback(() => window.pocketai.listKbDocuments(kb.id).then(setDocs).catch(reportIpcError('kb.listDocuments')), [kb.id])
  useEffect(() => {
    loadDocs()
    return () => stopPolling()
  }, [loadDocs])

  // 来源跳转消费：目标文档加载到后打开分块预览（含问答 tab 时先切回文档 tab）；
  // 文档不存在（已删除/不属于本库）则悬空不消费，无副作用
  useEffect(() => {
    if (!jumpFocus) return
    const doc = docs.find((d) => d.id === jumpFocus.docId)
    if (!doc) return
    setAskMode(false)
    setPreviewDoc(doc)
    onJumpHandled?.()
  }, [jumpFocus, docs, onJumpHandled])

  const refresh = async () => {
    await loadDocs()
    onChanged()
  }

  /** 启动轮询：每 2s 刷新文档列表，直到没有 pending/parsing/indexing 状态的文档 */
  const startPolling = () => {
    stopPolling()
    pollingRef.current = setInterval(async () => {
      const list = await window.pocketai.listKbDocuments(kb.id).catch(() => null)
      if (list) setDocs(list)
      const hasIndexing = list?.some((d) => d.status === 'pending' || d.status === 'parsing' || d.status === 'indexing')
      if (!hasIndexing) {
        stopPolling()
        onChanged()
      }
    }, 2000)
  }

  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }

  const handleAddFiles = async () => {
    setBusy(true)
    try {
      await window.pocketai.addKbFiles(kb.id)
      await refresh()
      startPolling()
    } finally {
      setBusy(false)
    }
  }

  /** 批量导入文件夹：递归扫描支持的文档入队；无命中/被截断时给出提示 */
  const handleAddFolder = async () => {
    setBusy(true)
    try {
      const r = await window.pocketai.addKbFolder(kb.id)
      if (r.docs.length === 0) {
        toast.warning(t('kb.folderNoMatch'))
      } else if (r.truncated) {
        toast.warning(t('kb.folderTruncated', { n: r.docs.length }))
      }
      await refresh()
      startPolling()
    } finally {
      setBusy(false)
    }
  }

  // Electron 未实现 window.prompt（调用直接返回 null，不弹窗），
  // 添加 URL / 录入文本改用应用内弹窗 AddSourceDialog
  const [addSource, setAddSource] = useState<null | 'url' | 'text'>(null)

  const handleDeleteDoc = async (docId: string) => {
    if (!(await confirm({ message: t('kb.delDocConfirm'), danger: true }))) return
    await window.pocketai.deleteKbDocument(docId)
    await refresh()
  }

  const handleReindex = async (docId: string) => {
    setBusy(true)
    try {
      await window.pocketai.reindexKbDocument(kb.id, docId)
      await refresh()
      startPolling()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteKb = async () => {
    if (!(await confirm({ message: t('kb.delKbConfirm', { name: kb.name }), danger: true }))) return
    await window.pocketai.deleteKnowledgeBase(kb.id)
    onChanged()
  }

  /** 文档级检索开关：停用后临时排除出检索范围（不删除、不重索引） */
  const handleToggleDoc = async (docId: string, enabled: boolean) => {
    try {
      await window.pocketai.setKbDocEnabled(kb.id, docId, enabled)
      await refresh()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  /** 增量同步：检测 file 文档源文件变更，变更的重索引、丢失的移除（经确认） */
  const handleSyncCheck = async () => {
    setBusy(true)
    try {
      const r = await window.pocketai.checkKbUpdates(kb.id)
      const changed = r.issues.filter((i) => i.kind === 'changed')
      const missing = r.issues.filter((i) => i.kind === 'missing')
      if (r.issues.length === 0) {
        toast.info(t('kb.syncUpToDate', { n: r.checked }))
        return
      }
      const ok = await confirm({
        message: t('kb.syncConfirm', { n: changed.length, m: missing.length }),
        danger: missing.length > 0
      })
      if (!ok) return
      for (const doc of changed) {
        await window.pocketai.reindexKbDocument(kb.id, doc.docId)
      }
      for (const doc of missing) {
        await window.pocketai.deleteKbDocument(doc.docId)
      }
      await refresh()
      if (changed.length > 0) startPolling()
      toast.success(t('kb.syncDone', { n: changed.length, m: missing.length }))
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return <KbForm kb={kb} onSaved={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* 头部 */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-bold">{kb.name}</h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            {kb.description || t('kb.noDesc')}
          </p>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
            {t('kb.counts', { n: kb.documentCount, m: kb.chunkCount })}
            {kb.embeddingModel && ` · ${kb.embeddingModel}`}
            {kb.embeddingDim && ` · ${kb.embeddingDim}d`}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing(true)} className="btn-ghost text-xs">
            {t('kb.settings')}
          </button>
          <button onClick={handleDeleteKb} className="btn-ghost text-xs text-[var(--color-danger)]">
            {t('kb.deleteKb')}
          </button>
        </div>
      </div>

      {/* 视图切换：文档管理 / 问答（hidden 保挂载，问答对话不丢） */}
      <div className="flex gap-1">
        <button onClick={() => setAskMode(false)} className={askMode ? 'chip' : 'chip chip-accent'}>
          {t('kb.docsTab')}
        </button>
        <button onClick={() => setAskMode(true)} className={askMode ? 'chip chip-accent' : 'chip'}>
          {t('kb.askTab')}
        </button>
      </div>

      {/* 文档管理 + 检索测试（文档 tab） */}
      <div hidden={askMode}>
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold">{t('kb.documents')}</h4>
          <div className="flex gap-1.5">
            <button onClick={handleAddFiles} disabled={busy} className="btn-primary text-xs disabled:opacity-50">
              {t('kb.upload')}
            </button>
            <button onClick={handleAddFolder} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">
              {t('kb.importFolder')}
            </button>
            <button onClick={() => setAddSource('url')} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">
              {t('kb.addUrl')}
            </button>
            <button onClick={() => setAddSource('text')} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">
              {t('kb.addText')}
            </button>
            <button onClick={handleSyncCheck} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">
              {t('kb.checkUpdates')}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          {docs.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] py-4 text-center">
              {t('kb.noDocs')}
            </p>
          )}
          {docs.map((d) => (
            <div
              key={d.id}
              className={`flex items-center gap-3 px-3 py-2 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)]${d.enabled ? '' : ' opacity-60'}`}
            >
              <input
                type="checkbox"
                checked={d.enabled}
                onChange={() => void handleToggleDoc(d.id, !d.enabled)}
                disabled={busy}
                className="shrink-0 cursor-pointer"
                title={d.enabled ? t('kb.docEnabled') : t('kb.docDisabled')}
                aria-label={d.enabled ? t('kb.docEnabled') : t('kb.docDisabled')}
              />
              <StatusBadge status={d.status} />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{d.title || d.source}</div>
                <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                  {d.sourceType} · {d.chunkCount} {t('kb.chunks')}
                  {d.error && <span className="text-[var(--color-danger)]"> · {d.error}</span>}
                </div>
              </div>
              <button
                onClick={() => setPreviewDoc(d)}
                className="btn-ghost text-[11px]"
                title={t('kb.preview')}
              >
                {t('kb.chunks')}
              </button>
              <button
                onClick={() => handleReindex(d.id)}
                disabled={busy}
                className="btn-ghost text-[11px] disabled:opacity-50"
              >
                {t('kb.reindex')}
              </button>
              <button
                onClick={() => handleDeleteDoc(d.id)}
                className="btn-ghost text-[11px] text-[var(--color-danger)]"
              >
                {t('common.delete')}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 检索测试 */}
      <RetrievalTest kbId={kb.id} topN={kb.topN} />
      </div>

      {/* KB 问答（问答 tab；key 保证切库重挂载，会话状态不跨库串数据） */}
      <div hidden={!askMode}>
        <h4 className="text-sm font-semibold mb-1">{t('kb.askTitle')}</h4>
        <p className="text-[11px] text-[var(--color-text-muted)] mb-3">{t('kb.askHint')}</p>
        <KbAskPanel key={kb.id} kb={kb} />
      </div>

      {/* 分块预览弹层 */}
      {previewDoc && (
        <ChunkPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} focusSeq={jumpFocus?.seq ?? null} />
      )}

      {/* 添加 URL / 录入文本弹窗 */}
      {addSource && (
        <AddSourceDialog
          kbId={kb.id}
          mode={addSource}
          onClose={() => setAddSource(null)}
          onDone={async () => { await refresh(); startPolling() }}
        />
      )}

      {dialog}
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'text-[var(--color-text-muted)] bg-[var(--color-hover-overlay)]',
  parsing: 'text-[var(--color-info)] bg-[var(--color-info-bg)]',
  indexing: 'text-[var(--color-warning)] bg-[var(--color-warning-bg)]',
  ready: 'text-[var(--color-success)] bg-[var(--color-success-bg)]',
  error: 'text-[var(--color-danger)] bg-[var(--color-danger-bg)]'
}

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const { t } = useI18n()
  const label = t(`kb.st.${status}`)
  const cls = STATUS_STYLES[status] ?? STATUS_STYLES.pending
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${cls}`}>{label}</span>
  )
}

// ---------- 检索测试 ----------
const RetrievalTest: React.FC<{ kbId: string; topN: number }> = ({ kbId, topN }) => {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RetrievedChunk[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSearch = async () => {
    if (!query.trim()) return
    setLoading(true)
    setError('')
    setResults(null)
    try {
      const r = await window.pocketai.retrieveKb([kbId], query)
      setResults(r.chunks)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h4 className="text-sm font-semibold mb-2">{t('kb.retrievalTest')}</h4>
      <div className="flex gap-2">
        <input
          className="input flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder={t('kb.searchPh')}
        />
        <button onClick={handleSearch} disabled={loading} className="btn-primary text-xs disabled:opacity-50">
          {loading ? t('kb.searching') : t('kb.search')}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--color-danger)] mt-2">{error}</p>}
      {results && (
        <div className="mt-2 space-y-2">
          {results.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">{t('kb.noMatch')}</p>
          )}
          {results.map((c, i) => (
            <div
              key={c.chunkId}
              className="p-2 rounded bg-[var(--color-input-bg)] border border-[var(--color-border)]"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-[var(--color-accent)] truncate">
                  #{i + 1} {c.docTitle}
                </span>
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  score {c.score.toFixed(4)}
                </span>
              </div>
              <p className="text-xs text-[var(--color-text)] line-clamp-3 whitespace-pre-wrap">
                {c.content}
              </p>
            </div>
          ))}
          <p className="text-[10px] text-[var(--color-text-muted)]">
            {t('kb.injectHint', { n: topN })}
          </p>
        </div>
      )}
    </div>
  )
}

// ---------- 分块预览 ----------
const ChunkPreview: React.FC<{ doc: KbDocument; onClose: () => void; focusSeq?: number | null }> = ({
  doc,
  onClose,
  focusSeq
}) => {
  const { t } = useI18n()
  const [chunks, setChunks] = useState<KbChunk[]>([])
  const [loading, setLoading] = useState(true)
  /** 来源跳转命中的分块高亮（短暂闪烁后恢复） */
  const [hlSeq, setHlSeq] = useState<number | null>(null)

  useEffect(() => {
    window.pocketai
      .listKbChunks(doc.id)
      .then(setChunks)
      .catch(reportIpcError('kb.listChunks'))
      .finally(() => setLoading(false))
  }, [doc.id])

  // 来源跳转定位：滚动到目标分块并高亮闪烁
  useEffect(() => {
    if (focusSeq == null || loading || chunks.length === 0) return
    const el = document.getElementById(`kb-chunk-${focusSeq}`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    setHlSeq(focusSeq)
    const timer = setTimeout(() => setHlSeq(null), 1800)
    return () => clearTimeout(timer)
  }, [focusSeq, loading, chunks])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-overlay)]"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-h-[80vh] bg-[var(--color-sidebar)] rounded-lg border border-[var(--color-border)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h3 className="text-sm font-semibold truncate">{t('kb.chunkPreview', { title: doc.title })}</h3>
          <button onClick={onClose} className="btn-ghost text-xs">
            {t('common.close')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading && <p className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</p>}
          {!loading && chunks.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">{t('kb.noChunks')}</p>
          )}
          {chunks.map((c) => (
            <div
              key={c.id}
              id={`kb-chunk-${c.sequence}`}
              className={`p-2 rounded bg-[var(--color-input-bg)] border transition-colors ${
                hlSeq === c.sequence
                  ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
                  : 'border-[var(--color-border)]'
              }`}
            >
              <div className="text-[10px] text-[var(--color-text-muted)] mb-1">
                #{c.sequence}
              </div>
              <p className="text-xs whitespace-pre-wrap">{c.content}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- 添加 URL / 录入文本（替代 Electron 不支持的 window.prompt） ----------
const AddSourceDialog: React.FC<{
  kbId: string
  mode: 'url' | 'text'
  onClose: () => void
  onDone: () => Promise<void> | void
}> = ({ kbId, mode, onClose, onDone }) => {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const valid = mode === 'url' ? !!url.trim() : !!title.trim() && !!text.trim()

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'url') {
        await window.pocketai.addKbUrl(kbId, url.trim())
      } else {
        await window.pocketai.addKbText(kbId, text, title.trim())
      }
      await onDone()
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-overlay)]"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[80vh] bg-[var(--color-sidebar)] rounded-lg border border-[var(--color-border)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h3 className="text-sm font-semibold">
            {mode === 'url' ? t('kb.addUrl') : t('kb.addText')}
          </h3>
          <button onClick={onClose} className="btn-ghost text-xs">
            {t('common.close')}
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          {mode === 'url' ? (
            <Field label={t('kb.promptUrl')}>
              <input
                className="input w-full"
                value={url}
                autoFocus
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="https://example.com/article"
              />
            </Field>
          ) : (
            <>
              <Field label={t('kb.promptTitle')}>
                <input
                  className="input w-full"
                  value={title}
                  autoFocus
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label={t('kb.promptText')}>
                <textarea
                  className="input w-full h-56 resize-y"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </Field>
            </>
          )}
          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--color-border)]">
          <button onClick={onClose} className="btn-ghost text-xs" disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={!valid || busy}
            className="btn-primary text-xs disabled:opacity-50"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-xs text-[var(--color-text-muted)] mb-1">{label}</label>
    {children}
  </div>
)
