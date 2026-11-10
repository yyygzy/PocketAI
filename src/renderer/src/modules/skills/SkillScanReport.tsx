// 技能装前静态扫描的结果视图
//
// 只做三件事：按分级列出扫描器给出的候选与事实、把白名单外字段说清「本应用不执行」、给一个关闭键。
// 不写「安全 / 不安全」，不写「暂无风险」，也不把 attention 折进 <details>——它要在导入后直接看见。
// none 时整个组件返回 null：没有事实可写，就不制造空块。
import React from 'react'
import type { SkillFinding, SkillFindingLevel, SkillScanResult } from '../../../../shared/skill-scan'
import { useI18n } from '../../i18n'

type Translate = (key: string, params?: Record<string, string | number>) => string

interface Props {
  /** 刚导入的技能名；只作为结果上下文，不参与判定 */
  skillName?: string
  scan: SkillScanResult
  onClose: () => void
}

const LEVEL_LABEL: Record<SkillFindingLevel, (t: Translate) => string> = {
  attention: (t) => t('skill.scan.level.attention'),
  notice: (t) => t('skill.scan.level.notice'),
  info: (t) => t('skill.scan.level.info')
}

const LEVEL_CHIP: Record<SkillFindingLevel, string> = {
  attention: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  notice: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  info: 'bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]'
}

/** 稳定码 → 文案。全部用字面量 key，避免动态 t()；新增码时这里必须同步。 */
const FINDING_LABEL: Record<string, (t: Translate) => string> = {
  PROMPT_OVERRIDE_PHRASE: (t) => t('skill.scan.code.PROMPT_OVERRIDE_PHRASE'),
  CREDENTIAL_ACCESS_PHRASE: (t) => t('skill.scan.code.CREDENTIAL_ACCESS_PHRASE'),
  PIPE_EXECUTION: (t) => t('skill.scan.code.PIPE_EXECUTION'),
  RECURSIVE_DELETE: (t) => t('skill.scan.code.RECURSIVE_DELETE'),
  EXTERNAL_EGRESS: (t) => t('skill.scan.code.EXTERNAL_EGRESS'),
  URL_REFERENCE: (t) => t('skill.scan.code.URL_REFERENCE'),
  ABSOLUTE_PATH: (t) => t('skill.scan.code.ABSOLUTE_PATH'),
  SCRIPT_RESOURCE: (t) => t('skill.scan.code.SCRIPT_RESOURCE'),
  BINARY_RESOURCE: (t) => t('skill.scan.code.BINARY_RESOURCE'),
  IGNORED_DECLARATION: (t) => t('skill.scan.code.IGNORED_DECLARATION')
}

function labelOf(finding: SkillFinding, t: Translate): string {
  // 未知码只在本进程与渲染层版本错位时出现；回退到主进程给出的事实描述，不猜结论
  return FINDING_LABEL[finding.code]?.(t) ?? finding.detail
}

export const SkillScanReport: React.FC<Props> = ({ skillName, scan, onClose }) => {
  const { t } = useI18n()
  if (scan.level === 'none') return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="skill-scan-report"
      data-scan-level={scan.level}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('skill.scan.title')}
        className="w-full max-w-lg rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t('skill.scan.title')}</h3>
            {skillName && (
              <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5 truncate" title={skillName}>
                {skillName}
              </p>
            )}
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mt-2">
              {t('skill.scan.subtitle')}
            </p>
          </div>
          <button
            className="ml-auto shrink-0 w-7 h-7 rounded hover:bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)] leading-none"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* attention 与 notice / info 一样直接平铺，不折叠 */}
        <ul className="mt-4 space-y-3 max-h-[55vh] overflow-y-auto pr-1">
          {scan.findings.map((f, i) => (
            <li
              key={`${f.code}-${i}`}
              className="rounded-lg border border-[var(--color-border)] p-3"
              data-finding-code={f.code}
              data-finding-level={f.level}
            >
              <div className="flex items-center gap-2">
                <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${LEVEL_CHIP[f.level]}`}>
                  {LEVEL_LABEL[f.level](t)}
                </span>
                <p className="text-xs leading-relaxed">{labelOf(f, t)}</p>
              </div>
              {f.code === 'IGNORED_DECLARATION' ? (
                f.examples.length > 0 && (
                  <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mt-1.5">
                    {t('skill.market.ignoredKeys', { keys: f.examples.join(', ') })}
                  </p>
                )
              ) : (
                f.examples.length > 0 && (
                  <div className="mt-1.5">
                    <span className="text-[10px] text-[var(--color-text-muted)]">{t('skill.scan.examples')}</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {f.examples.map((ex) => (
                        <code
                          key={ex}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)] break-all"
                        >
                          {ex}
                        </code>
                      ))}
                    </div>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>

        <div className="flex justify-end mt-4">
          <button className="btn-primary text-xs" onClick={onClose}>
            {t('skill.scan.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
