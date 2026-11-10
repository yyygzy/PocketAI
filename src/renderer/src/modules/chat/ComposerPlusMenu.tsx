// 输入区「+」菜单（分组式）：输入 / 助手上下文 / 模型 / 执行设置。
//
// 口径：
// · 这是输入框旁**唯一**的能力入口——附件、提示词片段、知识库、技能、模型窗口/备用/文本协议、
//   工具配置都收在这里，旧入口（📎／📝／⚙ 上下文／顶栏三颗徽标／🛠 一行）不再留第二份；
// · 二级项右侧带 ›，点开在本浮层内换页（不用第二层定位，窄窗口下不会压住父菜单）；
// · 「读不到」的句子**不进本浮层**：浮层一关句子就没了＝替这次失败闭嘴（§222／§268）。
//   技能／知识库／工具那几发的失败句由 Composer 渲染在输入框上方；这里只负责让"再点那一格"就是重发。
import React, { useEffect, useState } from 'react'
import type {
  ChatAttachment,
  ChatTarget,
  KnowledgeBase,
  PromptSnippetRecord,
  ProviderRecord,
  SkillRecord
} from '../../../../shared/types'
import {
  DEFAULT_MESSAGES_WHEN_WINDOW_UNSET,
  MODEL_WINDOW_MAX_TOKENS,
  MODEL_WINDOW_MIN_TOKENS
} from '../../../../shared/model-window'
import { useI18n } from '../../i18n'
import { FloatingPanel } from '../../components/FloatingPanel'
import { AgentToolBars, agentToolSummary } from './AgentToolBars'
import type { AgentToolConfigs } from './useAgentToolConfigs'
import type { AgentModelExtras } from './useAgentModelExtras'

type View = 'main' | 'snippets' | 'recent' | 'kb' | 'skills' | 'window' | 'fallback' | 'tools'

interface Props {
  open: boolean
  anchorRef: React.RefObject<HTMLElement>
  onClose: () => void
  /** 上传图片或文档：点完就关菜单，由宿主拉起隐藏的 file input */
  onPickFile: () => void
  snippets: PromptSnippetRecord[]
  /** 片段清单那一发没读到：二级页只说"…"，失败句在浮层外（不在浮层里把故障演成"没有片段"） */
  snippetsUnread: boolean
  onPickSnippet: (s: PromptSnippetRecord) => void
  /** 当前会话历史里出现过的附件（最近文件二级页） */
  recentFiles: ChatAttachment[]
  onPickRecent: (att: ChatAttachment) => void
  /** 助手上下文：null＝还没读（进来才拉），[]＝读到了但没有 */
  skills: SkillRecord[] | null
  kbs: KnowledgeBase[] | null
  onLoadSkills: () => void
  onLoadKbs: () => void
  assistantSkillIds: string[]
  assistantKbIds: string[]
  onToggleSkill: (id: string) => void
  onToggleKb: (id: string) => void
  /** 内置助手不可改绑定 */
  builtinAssistant?: boolean
  providers: ProviderRecord[]
  primary?: ChatTarget
  modelExtras?: AgentModelExtras
  /** 执行设置只在「允许调用工具」时出现 */
  agentMode: boolean
  tools: AgentToolConfigs
}

const ROW = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors'
const META = 'shrink-0 max-w-[132px] truncate text-[10px] text-[var(--color-text-muted)]'
const CHEVRON = 'shrink-0 text-[var(--color-text-muted)]'

const Group: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
      {label}
    </div>
    {children}
  </div>
)

const Divider: React.FC = () => <div className="my-1 border-t border-[var(--color-border)]" />

export const ComposerPlusMenu: React.FC<Props> = ({
  open,
  anchorRef,
  onClose,
  onPickFile,
  snippets,
  snippetsUnread,
  onPickSnippet,
  recentFiles,
  onPickRecent,
  skills,
  kbs,
  onLoadSkills,
  onLoadKbs,
  assistantSkillIds,
  assistantKbIds,
  onToggleSkill,
  onToggleKb,
  builtinAssistant,
  providers,
  primary,
  modelExtras,
  agentMode,
  tools
}) => {
  const { t } = useI18n()
  const [view, setView] = useState<View>('main')
  // 窗口/备用两页的草稿（打开那一页时灌当前值；不打开就不建）
  const [windowDraft, setWindowDraft] = useState('')
  const [fallbackDraftProvider, setFallbackDraftProvider] = useState('')
  const [fallbackDraftModel, setFallbackDraftModel] = useState('')

  // 关闭即回到首层：再点「+」不该停在上一轮的二级页（也就不会跳过"点那一格＝重发"）
  useEffect(() => {
    if (!open) setView('main')
  }, [open])

  if (!open) return null

  const close = (): void => {
    setView('main')
    onClose()
  }

  const go = (v: View): void => {
    setView(v)
    if (v === 'skills') onLoadSkills()
    if (v === 'kb') onLoadKbs()
  }

  const currentFns = modelExtras
  const providerId = primary?.providerId ?? ''
  const model = primary?.model ?? ''
  const hasModelTarget = !!providerId && !!model
  const windowText = !currentFns
    ? ''
    : currentFns.contextWindowUnread
      ? t('agent.windowReadFail')
      : currentFns.contextWindowTokens == null
        ? t('agent.windowUnset')
        : t('agent.windowValue', { n: currentFns.contextWindowTokens })
  const fallbackProviderName = currentFns?.fallbackTarget
    ? providers.find((p) => p.id === currentFns.fallbackTarget?.providerId)?.name ??
      currentFns.fallbackTarget.providerId
    : ''
  const fallbackText = !currentFns
    ? ''
    : currentFns.fallbackUnread
      ? t('agent.fallbackReadFail')
      : !currentFns.fallbackTarget
        ? t('agent.fallbackUnset')
        : currentFns.fallbackMissing
          ? t('agent.fallbackMissing', { model: currentFns.fallbackTarget.model })
          : t('agent.fallbackValue', {
              name: fallbackProviderName,
              model: currentFns.fallbackTarget.model
            })
  const textProtocolText = !currentFns
    ? ''
    : currentFns.textProtocolUnread
      ? t('agent.textProtocolReadFail')
      : currentFns.textProtocolForced
        ? t('agent.textProtocolOn')
        : t('agent.textProtocolOff')

  const windowNumber = windowDraft.trim() === '' ? Number.NaN : Number(windowDraft)
  const windowValid = Number.isInteger(windowNumber)
  const draftFallbackValid = !!fallbackDraftProvider && !!fallbackDraftModel
  const fallbackOptions = providers
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models.filter((m) => !(p.id === providerId && m === model))
    }))
    .filter((p) => p.models.length > 0)

  const chipCls = (on: boolean): string =>
    `text-[11px] px-2 py-1 rounded border ${
      on
        ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
    }`

  const back = (title: string): React.ReactNode => (
    <button
      type="button"
      onClick={() => setView('main')}
      className="flex w-full items-center gap-1 border-b border-[var(--color-border)] px-3 py-1.5 text-left text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]"
    >
      <span aria-hidden className={CHEVRON}>‹</span>
      <span>{title}</span>
    </button>
  )

  return (
    <FloatingPanel
      anchorRef={anchorRef}
      width={300}
      onClose={close}
      data-testid="composer-plus-menu"
    >
      {view === 'main' && (
        <div>
          <Group label={t('composer.plus.group.input')}>
            <button
              type="button"
              role="menuitem"
              data-testid="composer-plus-upload"
              className={ROW}
              onClick={() => {
                close()
                onPickFile()
              }}
            >
              <span aria-hidden>📎</span>
              <span className="flex-1 min-w-0">{t('common.attachFile')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="composer-plus-snippets"
              className={ROW}
              onClick={() => go('snippets')}
            >
              <span aria-hidden>📝</span>
              <span className="flex-1 min-w-0">{t('snippet.button')}</span>
              <span className={META}>({snippets.length})</span>
              <span aria-hidden className={CHEVRON}>›</span>
            </button>
            {recentFiles.length > 0 && (
              <button
                type="button"
                role="menuitem"
                data-testid="composer-plus-recent"
                className={ROW}
                onClick={() => go('recent')}
              >
                <span aria-hidden>📄</span>
                <span className="flex-1 min-w-0">{t('mention.recentFiles')}</span>
                <span className={META}>({recentFiles.length})</span>
                <span aria-hidden className={CHEVRON}>›</span>
              </button>
            )}
          </Group>

          <Divider />

          <Group label={t('composer.plus.group.context')}>
            <button
              type="button"
              role="menuitem"
              data-testid="composer-plus-kb"
              className={ROW}
              onClick={() => go('kb')}
            >
              <span aria-hidden>📚</span>
              <span className="flex-1 min-w-0">{t('ccb.kb')}</span>
              <span className={META}>({assistantKbIds.length})</span>
              <span aria-hidden className={CHEVRON}>›</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="composer-plus-skills"
              className={ROW}
              onClick={() => go('skills')}
            >
              <span aria-hidden>⚡</span>
              <span className="flex-1 min-w-0">{t('ccb.skills')}</span>
              <span className={META}>({assistantSkillIds.length})</span>
              <span aria-hidden className={CHEVRON}>›</span>
            </button>
          </Group>

          {modelExtras && hasModelTarget && (
            <>
              <Divider />
              <Group label={t('composer.plus.group.model')}>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="composer-plus-window"
                  className={ROW}
                  title={
                    modelExtras.contextWindowUnread
                      ? `${t('agent.windowUnread')} — ${modelExtras.contextWindowUnread}`
                      : t('agent.windowHint')
                  }
                  onClick={() => {
                    setWindowDraft(
                      modelExtras.contextWindowTokens == null ? '' : String(modelExtras.contextWindowTokens)
                    )
                    go('window')
                  }}
                >
                  <span aria-hidden>🪟</span>
                  <span className="flex-1 min-w-0">{t('agent.window')}</span>
                  <span className={META} title={windowText}>{windowText}</span>
                  <span aria-hidden className={CHEVRON}>›</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="composer-plus-fallback"
                  className={ROW}
                  title={
                    modelExtras.fallbackUnread
                      ? `${t('agent.fallbackUnread')} — ${modelExtras.fallbackUnread}`
                      : t('agent.fallbackHint')
                  }
                  onClick={() => {
                    setFallbackDraftProvider(
                      modelExtras.fallbackTarget &&
                        providers.some((p) => p.id === modelExtras.fallbackTarget?.providerId)
                        ? modelExtras.fallbackTarget.providerId
                        : ''
                    )
                    setFallbackDraftModel(modelExtras.fallbackTarget?.model ?? '')
                    go('fallback')
                  }}
                >
                  <span aria-hidden>🔁</span>
                  <span className="flex-1 min-w-0">{t('agent.fallback')}</span>
                  <span className={META} title={fallbackText}>{fallbackText}</span>
                  <span aria-hidden className={CHEVRON}>›</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="composer-plus-text-protocol"
                  className={ROW}
                  title={
                    modelExtras.textProtocolUnread
                      ? `${t('agent.textProtocolUnread')} — ${modelExtras.textProtocolUnread}`
                      : modelExtras.textProtocolForced
                        ? t('agent.textProtocolOnHint')
                        : t('agent.textProtocolHint')
                  }
                  onClick={() => {
                    if (modelExtras.textProtocolUnread) modelExtras.retryTextProtocol()
                    else modelExtras.setTextProtocol(!modelExtras.textProtocolForced)
                  }}
                >
                  <span aria-hidden>⚖</span>
                  <span className="flex-1 min-w-0">{t('agent.textProtocol')}</span>
                  <span className={META} title={textProtocolText}>{textProtocolText}</span>
                </button>
              </Group>
            </>
          )}

          {agentMode && (
            <>
              <Divider />
              <Group label={t('composer.plus.group.execution')}>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="composer-plus-tools"
                  className={ROW}
                  onClick={() => go('tools')}
                >
                  <span aria-hidden>🛠</span>
                  <span className="flex-1 min-w-0">{t('agent.toolConfig')}</span>
                  <span className={META}>{agentToolSummary(tools)}</span>
                  <span aria-hidden className={CHEVRON}>›</span>
                </button>
              </Group>
            </>
          )}
        </div>
      )}

      {view === 'snippets' && (
        <div>
          {back(t('snippet.button'))}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {snippetsUnread ? (
              <p className="px-3 py-3 text-center text-xs text-[var(--color-text-muted)]">…</p>
            ) : snippets.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-[var(--color-text-muted)]">
                {t('snippet.empty')}
              </p>
            ) : (
              snippets.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  title={s.content}
                  className={ROW}
                  onClick={() => {
                    close()
                    onPickSnippet(s)
                  }}
                >
                  <span aria-hidden>📝</span>
                  <span className="flex-1 min-w-0 truncate">{s.title}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {view === 'recent' && (
        <div>
          {back(t('mention.recentFiles'))}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {recentFiles.map((att) => (
              <button
                key={`${att.name}-${att.size}`}
                type="button"
                role="menuitem"
                className={ROW}
                onClick={() => {
                  close()
                  onPickRecent(att)
                }}
              >
                <span aria-hidden>{att.type === 'image' ? '🖼' : att.type === 'kb' ? '📚' : '📄'}</span>
                <span className="flex-1 min-w-0 truncate">{att.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {view === 'kb' && (
        <div>
          {back(t('ccb.kb'))}
          <div className="p-3">
            {builtinAssistant ? (
              <p className="text-xs text-[var(--color-text-muted)]">{t('ccb.builtinHint')}</p>
            ) : kbs === null ? (
              <p className="text-xs text-[var(--color-text-muted)]">…</p>
            ) : kbs.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">{t('ccb.none')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {kbs.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    className={chipCls(assistantKbIds.includes(k.id))}
                    title={k.description}
                    onClick={() => onToggleKb(k.id)}
                  >
                    📚 {k.name}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">{t('ccb.kbHint')}</p>
          </div>
        </div>
      )}

      {view === 'skills' && (
        <div>
          {back(t('ccb.skills'))}
          <div className="max-h-[300px] overflow-y-auto p-3">
            {builtinAssistant ? (
              <p className="text-xs text-[var(--color-text-muted)]">{t('ccb.builtinHint')}</p>
            ) : skills === null ? (
              <p className="text-xs text-[var(--color-text-muted)]">…</p>
            ) : skills.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">{t('ccb.none')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {skills.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={chipCls(assistantSkillIds.includes(s.id))}
                    title={s.description}
                    onClick={() => onToggleSkill(s.id)}
                  >
                    {s.icon} {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'window' && modelExtras && (
        <div>
          {back(t('agent.window'))}
          <div className="flex flex-wrap items-center gap-2 p-3" data-testid="agent-window-editor">
            <input
              type="number"
              className="select-mini w-[130px]"
              aria-label={t('agent.window')}
              min={MODEL_WINDOW_MIN_TOKENS}
              max={MODEL_WINDOW_MAX_TOKENS}
              step={1024}
              placeholder={`${MODEL_WINDOW_MIN_TOKENS}–${MODEL_WINDOW_MAX_TOKENS}`}
              value={windowDraft}
              onChange={(e) => setWindowDraft(e.target.value)}
            />
            {/* 草稿不是整数就不让保存：这一脸不发垃圾去主进程，也不假装"已保存" */}
            <button
              type="button"
              className="btn-ghost text-xs shrink-0"
              disabled={!windowValid}
              onClick={() => {
                if (!windowValid) return
                modelExtras.setContextWindow(windowNumber)
                setView('main')
              }}
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              className="btn-ghost text-xs shrink-0"
              onClick={() => {
                modelExtras.setContextWindow(null)
                setView('main')
              }}
            >
              {t('agent.windowClear')}
            </button>
            <span className="text-[10px] leading-snug text-[var(--color-text-muted)]">
              {t('agent.windowEditorTip', {
                default: DEFAULT_MESSAGES_WHEN_WINDOW_UNSET,
                min: MODEL_WINDOW_MIN_TOKENS,
                max: MODEL_WINDOW_MAX_TOKENS
              })}
            </span>
            <span className="basis-full text-[10px] leading-snug text-[var(--color-text-muted)]">
              {t('agent.windowNotNumCtx')}
            </span>
          </div>
        </div>
      )}

      {view === 'fallback' && modelExtras && (
        <div>
          {back(t('agent.fallback'))}
          <div className="flex flex-wrap items-center gap-2 p-3" data-testid="agent-fallback-editor">
            <select
              className="select-mini w-[130px]"
              aria-label={t('agent.fallbackProvider')}
              value={fallbackDraftProvider}
              onChange={(e) => {
                setFallbackDraftProvider(e.target.value)
                setFallbackDraftModel('')
              }}
            >
              <option value="">{t('agent.selectProvider')}</option>
              {fallbackOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              className="select-mini w-[145px]"
              aria-label={t('agent.fallbackModel')}
              value={fallbackDraftModel}
              disabled={!fallbackDraftProvider}
              onChange={(e) => setFallbackDraftModel(e.target.value)}
            >
              <option value="">{t('agent.selectModel')}</option>
              {(fallbackOptions.find((p) => p.id === fallbackDraftProvider)?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {/* 两个都没选就不让保存：宁可让按钮灰着，也不要发一次"清除"或一条空备用出去 */}
            <button
              type="button"
              className="btn-ghost text-xs shrink-0"
              disabled={!draftFallbackValid}
              data-testid="agent-fallback-save"
              onClick={() => {
                if (!draftFallbackValid) return
                modelExtras.setFallback({ providerId: fallbackDraftProvider, model: fallbackDraftModel })
                setView('main')
              }}
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              className="btn-ghost text-xs shrink-0"
              data-testid="agent-fallback-clear"
              onClick={() => {
                modelExtras.setFallback(null)
                setView('main')
              }}
            >
              {t('agent.fallbackClear')}
            </button>
            <span className="basis-full text-[10px] leading-snug text-[var(--color-text-muted)]">
              {t('agent.fallbackEditorTip')}
            </span>
          </div>
        </div>
      )}

      {view === 'tools' && (
        <div>
          {back(t('agent.toolConfig'))}
          {/* 工作目录已移到输入区的「允许调用工具」同一行（快捷入口），这里只留终端/搜索/日历 */}
          {/* 布局约束照旧：说明行不 truncate、改 flex-wrap（298px 窄浮层会把安全限定语的尾巴裁掉） */}
          <div className="max-h-[52vh] overflow-y-auto">
            <AgentToolBars tools={tools} />
          </div>
        </div>
      )}
    </FloatingPanel>
  )
}
