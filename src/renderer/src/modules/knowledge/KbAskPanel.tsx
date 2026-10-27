// KB 问答面板：知识库详情页内「选库即聊」——自动检索拼上下文，流式回答带编号引用。
// 问答会话落库留痕（渲染端全量 upsert 单写路径），可从历史列表回看与继续追问；
// 模型选择记忆在 localStorage，默认第一个启用 provider。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { pickDefaultProvider } from '../../utils/provider-pick'
import { useToast } from '../../components/ToastProvider'
import { EmptyState } from '../../components/EmptyState'
import { requestSourceJump } from './source-jump'
import { Markdown } from '../chat/Markdown'
import { ExportMenu } from '../chat/ConversationList'
import { sessionTitleFrom } from '../../../../shared/kb-ask-session'
import { buildKbAskSessionHtml } from '../../utils/export-html'
import type {
  KnowledgeBase,
  KbAskMessage,
  KbAskRetention,
  KbAskSessionMeta,
  MessageSource,
  ProviderRecord
} from '../../../../shared/types'
import { errText } from '../../utils/error'
import { hasIpcFailed, isIpcFail, ipcFailText, ipcFailureText, logIpcError, reportIpcError } from '../../utils/ipc'
import { KB_ASK_MAX_HISTORY } from '../../../../shared/types'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { ShowingDefaultsNotice } from '../../components/ShowingDefaultsNotice'

const PROVIDER_KEY = 'kbask.providerId'
const modelKey = (p: string) => `kbask.model.${p}`

/** 会话时间展示：当天只显示时分，跨天显示日期（同年省略年份） */
export const fmtSessionTime = (ts: number): string => {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  const ymd = `${d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()}`
  return `${ymd} ${hm}`
}

const KbAskPanel: React.FC<{
  kb: KnowledgeBase
  /** 跨库漫游跳转目标会话 id（非空时展开历史并回放；消费后父级清空） */
  openSessionId?: string | null
  onSessionOpened?: () => void
}> = ({ kb, openSessionId = null, onSessionOpened }) => {
  const { t } = useI18n()
  const toast = useToast()

  const [providers, setProviders] = useState<ProviderRecord[]>([])
  /** 服务商清单那一读失败的原因（§263 第五面） */
  const [providersUnread, setProvidersUnread] = useState<{ error?: string } | null>(null)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [msgs, setMsgs] = useState<KbAskMessage[]>([])
  const [streamText, setStreamText] = useState('')
  const [streamSources, setStreamSources] = useState<MessageSource[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const requestRef = useRef<string | null>(null)
  // §311：**最后一次点开的那条会话**（不是当前 sessionId state——那正是这一发要写的东西）。
  // `loadSession(A)` 的响应迟到时用户可能已经点了 B 或按了「新对话」，那一句 `setSessionId(A)`
  // 不只是画错屏：`ask()` 拿的是 state `sessionId`（:308）与 `msgsRef` 的历史 ⇒
  // 下一句追问会**落进 A 那条会话**（:326 persist），比显示谎报更重一档。判据同 §309／§264。
  const openedSessionRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // msgs 镜像：一次性挂载的流式订阅与持久化需要拿到最新全量消息
  const msgsRef = useRef<KbAskMessage[]>([])
  // 会话留痕：当前会话 id / 创建时间；历史列表与展开态
  const [sessionId, setSessionId] = useState<string | null>(null)
  // §331：当前会话的标题。改前 `persistSession` 每次 upsert 都用首句重算标题 ⇒ 用户在历史里改好的
  // 会话名会被下一句追问静默还原成「首问截断」。这里留一份用户那一侧的标题（null＝还没定过，按首问算）。
  const sessionTitleRef = useRef<string | null>(null)
  const [sessionCreatedAt, setSessionCreatedAt] = useState(0)
  const [sessionList, setSessionList] = useState<KbAskSessionMeta[]>([])
  const [showHistory, setShowHistory] = useState(false)
  // 重命名内联编辑：正在编辑的会话 id 与草稿标题
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // 导出进行中（防重入）
  const [exportingId, setExportingId] = useState<string | null>(null)
  // 历史搜索关键词 + 防抖 timer
  const [searchKeyword, setSearchKeyword] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 自动清理保留策略（双 0 = 关闭）；展开配置行
  const [retention, setRetention] = useState<KbAskRetention>({ keepCount: 0, keepDays: 0 })
  const [showRetention, setShowRetention] = useState(false)
  /**
   * §272：这一族的两个失败面。改前都只有一句 `if (!hasIpcFailed(v)) 写 state`＝什么都不做——
   *  · 历史清单：面板摆「暂无历史会话」，而那颗按钮上的 `（{n}）` 跟着报 0；
   *  · 保留策略：`retention` 停在字面量 `{0,0}`（＝"关闭"），那两个下拉照旧可编辑，
   *    用户在这份假基线上改一下就把它存进库——这正是 §226 那一族「读不到，这里显示的是默认值」，
   *    所以那句用 `ShowingDefaultsNotice`，不用 §222 的 `LoadFailNotice`（那是整块没内容时才用）。
   * 历史那一发的出路在 :467（再点「历史」那一格就重拉）⇒ 不造键；策略那一发全文件只有挂载一处读⇒配一颗键。
   */
  const [sessionsUnread, setSessionsUnread] = useState<{ error?: string } | null>(null)
  const [retentionUnread, setRetentionUnread] = useState<{ error?: string } | null>(null)

  /** 拉取本库历史会话列表（仅元数据，更新时间倒序）；有关键词时走搜索 */
  const refreshSessions = (kw = searchKeyword) => {
    const k = kw.trim()
    const p = k
      ? window.pocketai.searchKbAskSessions(kb.id, k)
      : window.pocketai.listKbAskSessions(kb.id)
    p
      .then((r) => {
        // §223 那条老坑还在：`p` 是绑到变量的 Promise，把 `{ok:false}` 写进列表 state ⇒ 点进去 `.map` 崩。
        // §272 补的是另一半：改前失败侧只有一句"什么都不写"⇒「暂无历史会话」替通道故障说话，
        // 而那颗按钮上的 `（{n}）` 会跟着报 0。这一发的出路是现成的——按钮 onClick 里
        // `if (!showHistory) refreshSessions()`：再点那一格就是重拉 ⇒ 按 §268 口径**不造重试键**。
        if (hasIpcFailed(r)) {
          setSessionsUnread({ error: r.error })
          return
        }
        setSessionsUnread(null)
        setSessionList(r)
      })
      .catch((e: unknown) => {
        // reject 面同一张脸（旧写法是一条会消失的 toast，而 toast 看不见就等于没说）
        setSessionsUnread({ error: errText(e, '') })
        logIpcError('kb.searchKbAskSessions', e)
      })
  }

  /** 搜索输入：200ms 防抖后查询 */
  const onSearchInput = (kw: string) => {
    setSearchKeyword(kw)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => refreshSessions(kw), 200)
  }

  // 卸载时清理防抖 timer
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [])

  // 挂载即拉取历史（「历史」按钮上展示数量）与保留策略
  useEffect(() => {
    refreshSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb.id])

  const loadRetention = useCallback(() => {
    window.pocketai
      .getKbAskRetention()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setRetentionUnread({ error: v.error })
          return
        }
        setRetentionUnread(null)
        setRetention(v)
      })
      .catch((e: unknown) => {
        setRetentionUnread({ error: errText(e, '') })
        logIpcError('kb.getKbAskRetention', e)
      })
  }, [])

  useEffect(() => {
    loadRetention()
  }, [loadRetention])

  /** 保存保留策略：切换即生效，下次保存会话时顺手清理 */
  const saveRetention = (next: KbAskRetention) => {
    const prev = retention
    setRetention(next)
    window.pocketai
      .setKbAskRetention(next)
      .then((r) => {
        // §221：开关已经本地拨过去了，失败不判就是"界面说已保存、库里没变"（196 那一族的同形）
        if (hasIpcFailed(r)) {
          setRetention(prev)
          toast.error(ipcFailText(r, t('common.unknownError')))
          return
        }
        toast.success(t('kb.askRetentionSaved'))
        refreshSessions()
      })
      .catch((e) => {
        setRetention(prev)
        toast.error(errText(e))
      })
  }

  // 加载启用的 provider + 记忆的模型选择；默认第一个 provider 的第一个模型（小白零配置）
  useEffect(() => {
    let alive = true
    window.pocketai
      .listProviders()
      .then((ps) => {
        // §263 第五面：过去这一支只有一句 `return`，`providers` 停在 `[]` ⇒ 下拉里只剩「请选择」，
        // 把"读不到"演成"你自己还没选"。
        if (hasIpcFailed(ps)) {
          setProvidersUnread({ error: ps.error })
          return
        }
        if (!alive) return
        setProvidersUnread(null)
        const enabled = ps.filter((p) => p.enabled)
        setProviders(enabled)
        // 与对话页同规则：记住的那家与回退项都要求「有模型」，否则自动挑一家能用的
        const first = pickDefaultProvider(ps, localStorage.getItem(PROVIDER_KEY))
        if (first) {
          setProviderId(first.id)
          setModel(localStorage.getItem(modelKey(first.id)) || first.models[0] || '')
        }
      })
      .catch((e: unknown) => {
        // reject 面同一张脸（旧写法是一条会消失的 toast）
        setProvidersUnread({ error: errText(e, '') })
        logIpcError('kbAsk.listProviders', e)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectProvider = (id: string) => {
    setProviderId(id)
    localStorage.setItem(PROVIDER_KEY, id)
    const p = providers.find((x) => x.id === id)
    const nextModel = (p && localStorage.getItem(modelKey(id))) || p?.models[0] || ''
    setModel(nextModel)
  }

  const selectModel = (m: string) => {
    setModel(m)
    if (providerId) localStorage.setItem(modelKey(providerId), m)
  }

  /** 会话落库：全量 msgs upsert 单写路径；留痕失败静默（不打断问答） */
  const persistSession = (
    next: KbAskMessage[],
    sid: string | null = sessionId,
    createdAt = sessionCreatedAt
  ) => {
    if (!sid || next.length === 0) return
    const firstUser = next.find((m) => m.role === 'user')
    window.pocketai
      .saveKbAskSession({
        id: sid,
        kbId: kb.id,
        // §331：用户改过名字就沿用那份，不再用首句重算把改名冲掉（null＝本会话还没定过标题）
        title: sessionTitleRef.current ?? sessionTitleFrom(firstUser?.content ?? ''),
        messages: next,
        providerId,
        model,
        createdAt: createdAt || Date.now(),
        updatedAt: Date.now()
      })
      .then((r) => {
        // §221：留痕失败仍按上面那句注释保持静默（不打断问答），但不能替它确认"存好了"——不刷新历史清单
        if (hasIpcFailed(r)) return
        refreshSessions()
      })
      .catch(reportIpcError('kb.saveKbAskSession'))
  }
  // 经 ref 转发：一次性挂载的流式订阅闭包始终调用最新实现（拿到最新 provider/model/sessionId）
  const persistRef = useRef(persistSession)
  persistRef.current = persistSession

  // 流式事件订阅（一次挂载；requestId 校验防串扰）
  useEffect(() => {
    const offChunk = window.pocketai.onKbAskChunk((e) => {
      if (e.requestId !== requestRef.current) return
      setStreamText((prev) => prev + e.delta)
    })
    const offDone = window.pocketai.onKbAskDone((e) => {
      if (e.requestId !== requestRef.current) return
      requestRef.current = null
      // 追加回答并落库（含引用来源）；发送时已存过提问，此处为第二次 upsert
      const next: KbAskMessage[] = [
        ...msgsRef.current,
        { role: 'assistant', content: e.fullContent, sources: e.sources }
      ]
      msgsRef.current = next
      setMsgs(next)
      persistRef.current(next)
      setStreamText('')
      setStreamSources([])
      setPending(false)
    })
    const offError = window.pocketai.onKbAskError((e) => {
      if (e.requestId !== requestRef.current) return
      requestRef.current = null
      setStreamText('')
      setStreamSources([])
      setPending(false)
      toast.error(e.error)
    })
    return () => {
      offChunk()
      offDone()
      offError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 消息变化自动滚底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, streamText])

  const send = async () => {
    const q = input.trim()
    if (!q || pending) return
    if (!providerId || !model) {
      toast.warning(t('kb.askModelRequired'))
      return
    }
    setInput('')
    // 首轮发问生成会话 id；先落「含提问」，回答完成后再落「含回答」
    let sid = sessionId
    let createdAt = sessionCreatedAt
    if (!sid) {
      sid = crypto.randomUUID()
      createdAt = Date.now()
      setSessionId(sid)
      setSessionCreatedAt(createdAt)
    }
    // §318：发之前先裁到上限。主进程拼消息时本来就只取最近 KB_ASK_MAX_HISTORY 条（ask-service），
    // 入参 schema 现在也用它——原来是「schema 卡 50、主进程裁到 10」两个数，
    // 于是第 11 条以后的历史让整句发不出去，而那 11 条以后主进程反正也用不上。
    const history: { role: 'user' | 'assistant'; content: string }[] = msgsRef.current
      .slice(-KB_ASK_MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content }))
    const next: KbAskMessage[] = [...msgsRef.current, { role: 'user', content: q }]
    msgsRef.current = next
    setMsgs(next)
    setStreamText('')
    setStreamSources([])
    setPending(true)
    persistRef.current(next, sid, createdAt)
    try {
      const r = await window.pocketai.kbAsk({
        kbIds: [kb.id],
        providerId,
        model,
        question: q,
        history
      })
      // §318：safeHandle 把入参校验失败与抛出都转成**已 resolve** 的 `{ ok:false, error }`，
      // 而这一发原来是「解构即数据」⇒ requestId 是 undefined：转圈不消失、停止按钮按下去空转，
      // 而那句提问已经落库。同文件其余七发都判了信封，只有发起这一发漏了。
      // 已经落库的提问不回滚：那与"生成中途失败"留下的形状一致，回滚是另一件事。
      if (hasIpcFailed(r)) {
        setPending(false)
        toast.error(ipcFailureText(r, t))
        return
      }
      requestRef.current = r.requestId
    } catch (e) {
      setPending(false)
      toast.error(errText(e))
    }
  }

  const stop = () => {
    if (requestRef.current) void window.pocketai.kbAskAbort(requestRef.current)
  }

  /** 开始新会话：中止进行中的请求并清空当前对话 */
  const startNewSession = () => {
    if (requestRef.current) {
      void window.pocketai.kbAskAbort(requestRef.current)
      requestRef.current = null
      setPending(false)
    }
    // §311：按了「新对话」＝不再等任何一发历史回放（否则迟到的 A 会把新对话屏变成 A，
    // 而下一句追问会直接落进 A 那条会话）
    openedSessionRef.current = null
    setSessionId(null)
    setSessionCreatedAt(0)
    sessionTitleRef.current = null
    msgsRef.current = []
    setMsgs([])
    setStreamText('')
    setStreamSources([])
    setShowHistory(false)
  }

  /** 加载历史会话：中止进行中的请求，回放全部消息，可继续追问 */
  const loadSession = (id: string) => {
    if (requestRef.current) {
      void window.pocketai.kbAskAbort(requestRef.current)
      requestRef.current = null
      setPending(false)
    }
    openedSessionRef.current = id
    window.pocketai
      .getKbAskSession(id)
      .then((rec) => {
        // §311：切走了就不许把 A 的会话 id／历史写进当前屏（写了它，下一句追问会落进 A）
        if (openedSessionRef.current !== id) return
        // §330：这一发成功时是记录、失败时是 `{ok:false}`（safeHandle 不 reject）——
        // 只判 `!rec` 的话失败对象是真值，undefined 的 id／messages 会直接进 state，渲染那行 msgs.map 当场抛
        if (isIpcFail(rec)) {
          toast.error(ipcFailText(rec, t('common.unknownError')))
          return
        }
        if (!rec) {
          refreshSessions()
          return
        }
        setSessionId(rec.id)
        setSessionCreatedAt(rec.createdAt)
        sessionTitleRef.current = rec.title
        msgsRef.current = rec.messages
        setMsgs(rec.messages)
        setStreamText('')
        setStreamSources([])
        setShowHistory(false)
      })
      .catch((e) => {
        if (openedSessionRef.current !== id) return
        toast.error(errText(e))
      })
  }

  // 跨库漫游跳转：外部传入会话 id → 展开历史面板并回放，随后通知父级清空
  useEffect(() => {
    if (!openSessionId) return
    setShowHistory(true)
    loadSession(openSessionId)
    onSessionOpened?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionId])

  /** 删除历史会话；删的是当前会话则回到新对话态 */
  const removeSession = (id: string) => {
    window.pocketai
      .deleteKbAskSession(id)
      .then((r) => {
        // §221：删除是用户点的那一下——失败要说话，而且不能刷新／回新对话态（那等于替他确认「已删除」）
        if (hasIpcFailed(r)) {
          toast.error(ipcFailText(r, t('common.unknownError')))
          return
        }
        refreshSessions()
        if (id === sessionId) startNewSession()
      })
      .catch((e) => toast.error(errText(e)))
  }

  /** 发起重命名：进入内联编辑态，草稿初始化为当前标题 */
  const beginRename = (id: string, currentTitle: string) => {
    setRenamingId(id)
    setRenameDraft(currentTitle)
  }

  /** 提交重命名（空串不提交），成功后刷新列表 */
  const commitRename = (id: string) => {
    const title = renameDraft.trim()
    setRenamingId(null)
    if (!title) return
    window.pocketai
      .renameKbAskSession(id, title)
      .then((r) => {
        // §221：失败要说话——不判就什么也不发生，用户以为标题改上了
        if (hasIpcFailed(r)) {
          toast.error(ipcFailText(r, t('common.unknownError')))
          return
        }
        // §331：改的正是当前开着的那条 ⇒ 追问落库用的标题也换成新名（否则 persistSession 把旧名写回去）
        if (id === sessionId) sessionTitleRef.current = title
        refreshSessions()
      })
      .catch((e) => toast.error(errText(e)))
  }

  /** 导出会话：MD 走主进程构建；HTML 渲染端构建后传主进程存盘 */
  const exportSession = async (id: string, format: 'md' | 'html') => {
    if (exportingId) return
    setExportingId(id)
    try {
      if (format === 'md') {
        const r = await window.pocketai.exportKbAskSessionMd(id)
        if (r.ok && !r.canceled && r.path) toast.success(t('kb.askExported', { path: r.path }))
        else if (!r.ok && r.error) toast.error(r.error)
      } else {
        const rec = await window.pocketai.getKbAskSession(id)
        // §330：同一条通道的第二种到货分开说——读不到（失败对象）与真不在了是两件事
        if (isIpcFail(rec)) {
          toast.error(ipcFailText(rec, t('common.unknownError')))
          return
        }
        if (!rec) {
          toast.error(t('kb.askSessionNotFound'))
          refreshSessions()
          return
        }
        const html = await buildKbAskSessionHtml(
          { title: rec.title, model: rec.model, createdAt: rec.createdAt, updatedAt: rec.updatedAt },
          rec.messages
        )
        const r = await window.pocketai.exportKbAskSessionHtml(id, html)
        if (r.ok && !r.canceled && r.path) toast.success(t('kb.askExported', { path: r.path }))
        else if (!r.ok && r.error) toast.error(r.error)
      }
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setExportingId(null)
    }
  }

  const jumpToSource = (msgIndex: number, n: number) => {
    document.getElementById(`kbask-src-${msgIndex}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  return (
    <div className="flex flex-col h-[520px]">
      {/* 模型选择：provider + model，记忆上次选择 */}
      {providersUnread && (
        <LoadFailNotice what={t('common.providersList')} msg={ipcFailText(providersUnread, t('common.unknownError'))} />
      )}
      <div className="flex gap-2 mb-3">
        <select className="input text-xs flex-1" value={providerId} onChange={(e) => selectProvider(e.target.value)}>
          <option value="">{t('kb.pleaseSelect')}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {providers.find((p) => p.id === providerId)?.models.length ? (
          <select className="input text-xs flex-1" value={model} onChange={(e) => selectModel(e.target.value)}>
            {providers
              .find((p) => p.id === providerId)!
              .models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
          </select>
        ) : (
          <input
            className="input text-xs flex-1"
            value={model}
            onChange={(e) => selectModel(e.target.value)}
            placeholder={t('kb.embModel')}
          />
        )}
      </div>

      {/* 会话工具行：历史切换 + 新对话 + 当前会话重命名/导出 */}
      <div className="flex items-center gap-1.5 mb-2">
        <button
          onClick={() => {
            if (!showHistory) refreshSessions()
            else {
              // 关闭历史面板时清空搜索态
              setSearchKeyword('')
              if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
            }
            setShowHistory(!showHistory)
          }}
          className={`text-xs px-2 py-1 rounded border transition-colors${
            showHistory
              ? ' border-[var(--color-accent)] text-[var(--color-accent)]'
              : ' border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]'
          }`}
        >
          {/* §272：读不到就**不报条数**（§269 同一条：挂着"历史（0）"就是把通道故障演成"你一条都没有"） */}
          {sessionsUnread ? t('kb.askHistory') : `${t('kb.askHistory')}（${sessionList.length}）`}
        </button>
        <button onClick={startNewSession} className="btn-ghost text-xs">
          {t('kb.askNewSession')}
        </button>
        {sessionId && !pending && (
          <>
            <button
              onClick={() => {
                const cur = sessionList.find((s) => s.id === sessionId)
                beginRename(sessionId, cur?.title ?? '')
              }}
              className="btn-ghost text-xs"
              title={t('chat.rename')}
            >
              {t('chat.rename')}
            </button>
            <ExportMenu
              triggerTitle={t('chat.exportMenu')}
              triggerContent="↓"
              triggerClassName="btn-ghost text-xs"
              items={[
                { key: 'md', label: t('chat.exportMd') },
                { key: 'html', label: t('chat.exportHtml') }
              ]}
              onPick={(k) => void exportSession(sessionId!, k as 'md' | 'html')}
            />
          </>
        )}
      </div>

      {/* 历史会话列表（含搜索） */}
      {showHistory && (
        <div className="mb-3 space-y-1 max-h-40 overflow-y-auto pr-1">
          <input
            className="input text-xs w-full mb-1"
            value={searchKeyword}
            onChange={(e) => onSearchInput(e.target.value)}
            placeholder={t('kb.askSearchPlaceholder')}
          />
          {/* 自动清理保留策略：切换即保存，下次写入会话时顺手清理 */}
          <button
            onClick={() => setShowRetention(!showRetention)}
            className={`btn-ghost text-xs mb-1${
              retention.keepCount > 0 || retention.keepDays > 0 ? ' text-[var(--color-accent)]' : ''
            }`}
          >
            {t('kb.askRetention')}
          </button>
          {/* §272：这一发读不到时那两个下拉照旧摆着字面量 `{0,0}`（＝自动清理关闭）且可编辑——
              说的是"这里显示的是默认值"（§226 那一族），不是"没东西可显示"，所以用 ShowingDefaultsNotice。
              这一发全文件只有挂载一处读（那颗「自动清理」按钮只展开行，不重读）⇒ 配一颗重试键；键在 alert 盒子外面（§268）。 */}
          {retentionUnread && (
            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <ShowingDefaultsNotice
                what={t('kb.askRetention')}
                msg={ipcFailText(retentionUnread, t('common.unknownError'))}
              />
              <button
                data-testid="kb-ask-retention-retry"
                className="text-xs underline text-[var(--color-text-muted)]"
                onClick={loadRetention}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
          {showRetention && (
            <div className="flex items-center gap-2 mb-1 text-xs text-[var(--color-text-muted)]">
              <span>{t('kb.askRetentionCount')}</span>
              <select
                className="input text-xs"
                value={retention.keepCount}
                onChange={(e) => saveRetention({ ...retention, keepCount: Number(e.target.value) })}
              >
                {[0, 50, 100, 200, 500].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? t('kb.askRetentionUnlimited') : n}
                  </option>
                ))}
              </select>
              <span>{t('kb.askRetentionDays')}</span>
              <select
                className="input text-xs"
                value={retention.keepDays}
                onChange={(e) => saveRetention({ ...retention, keepDays: Number(e.target.value) })}
              >
                {[0, 7, 30, 90, 180].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? t('kb.askRetentionUnlimited') : n}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* §272：这一发不造重试键——那颗「历史」按钮的 onClick 里就有 `if (!showHistory) refreshSessions()`，
              再点那一格就是重拉（§268 口径）。但那张「暂无历史会话」的脸得让位，同一时刻只说一件事。 */}
          {sessionsUnread && (
            <LoadFailNotice what={t('kb.askHistory')} msg={ipcFailText(sessionsUnread, t('common.unknownError'))} />
          )}
          {sessionList.length === 0 && !sessionsUnread && (
            <p className="text-xs text-[var(--color-text-muted)] py-3 text-center">
              {searchKeyword.trim() ? t('kb.askSearchEmpty') : t('kb.askNoSessions')}
            </p>
          )}
          {sessionList.map((s) => (
            <div
              key={s.id}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded bg-[var(--color-sidebar)] border transition-colors${
                renamingId === s.id ? '' : ' cursor-pointer'
              }${
                s.id === sessionId
                  ? ' border-[var(--color-accent)]'
                  : ' border-[var(--color-border)] hover:border-[var(--color-accent)]'
              }`}
              onClick={() => renamingId !== s.id && loadSession(s.id)}
            >
              <div className="flex-1 min-w-0">
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(s.id)
                      else if (e.key === 'Escape') setRenamingId(null)
                    }}
                    onBlur={() => commitRename(s.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="input text-[13px] w-full py-0"
                  />
                ) : (
                  <div className="text-[13px] truncate">{s.title}</div>
                )}
                <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                  {fmtSessionTime(s.updatedAt)} · {t('kb.askMsgCount', { n: s.messageCount })}
                  {s.model ? ` · ${s.model}` : ''}
                </div>
              </div>
              {renamingId !== s.id && (
                <>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation()
                      beginRename(s.id, s.title)
                    }}
                    className="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                    title={t('chat.rename')}
                    aria-label={t('chat.rename')}
                  >
                    ✎
                  </button>
                  <ExportMenu
                    triggerTitle={t('chat.exportMenu')}
                    triggerContent="↓"
                    triggerClassName="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                    items={[
                      { key: 'md', label: t('chat.exportMd') },
                      { key: 'html', label: t('chat.exportHtml') }
                    ]}
                    onPick={(k) => void exportSession(s.id, k as 'md' | 'html')}
                  />
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation()
                      removeSession(s.id)
                    }}
                    className="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
                    title={t('common.delete')}
                    aria-label={t('common.delete')}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 消息列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {msgs.length === 0 && !pending && (
          <EmptyState message={t('kb.askEmpty')} />
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] px-3 py-2 rounded-lg bg-[var(--color-accent)] text-white text-[13px] leading-relaxed whitespace-pre-wrap select-text">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="max-w-[85%] px-3 py-2 rounded-lg bg-[var(--color-sidebar)] border border-[var(--color-border)] select-text">
                {m.content ? (
                  <Markdown
                    content={m.content}
                    citationCount={m.sources?.length ?? 0}
                    onCitation={(n) => jumpToSource(i, n)}
                  />
                ) : (
                  <span className="text-xs text-[var(--color-text-muted)]">{t('kb.askNoAnswer')}</span>
                )}
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {m.sources.map((s, si) => (
                      <div
                        key={s.chunkId}
                        id={`kbask-src-${i}-${si + 1}`}
                        className="px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] scroll-mt-2"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1 rounded border border-[var(--color-border)] text-[var(--color-accent)] font-medium">
                            [{si + 1}]
                          </span>
                          <span className="text-[11px] text-[var(--color-accent)] font-medium truncate">
                            {s.docTitle}
                          </span>
                          {s.kbId && s.seq !== undefined && (
                            <button
                              onClick={() =>
                                requestSourceJump({ kbId: s.kbId!, docId: s.docId, seq: s.seq! })
                              }
                              title={t('chatview.viewSource')}
                              aria-label={t('chatview.viewSource')}
                              className="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                            >
                              ↗
                            </button>
                          )}
                        </div>
                        <div className="text-[12px] text-[var(--color-text-muted)] mt-0.5 line-clamp-2">
                          {s.content.slice(0, 120)}
                          {s.content.length > 120 ? '…' : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}
        {pending && (
          <div className="flex justify-start">
            <div className="max-w-[85%] px-3 py-2 rounded-lg bg-[var(--color-sidebar)] border border-[var(--color-border)] select-text">
              {streamText ? (
                <Markdown
                  content={streamText}
                  citationCount={streamSources.length}
                />
              ) : (
                <span className="inline-block w-2 h-4 bg-[var(--color-accent)] animate-pulse align-middle" />
              )}
            </div>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="flex gap-2 mt-3 items-end">
        <textarea
          className="input text-xs flex-1 resize-none"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={t('kb.askPlaceholder')}
        />
        {pending ? (
          <button onClick={stop} className="btn-ghost text-xs">
            {t('kb.askStop')}
          </button>
        ) : (
          <button onClick={() => void send()} disabled={!input.trim()} className="btn-primary text-xs disabled:opacity-50">
            {t('kb.askSend')}
          </button>
        )}
      </div>
    </div>
  )
}

export default KbAskPanel
