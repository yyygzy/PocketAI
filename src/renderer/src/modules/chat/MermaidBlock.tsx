// MermaidBlock：把 ```mermaid 代码块渲染成 SVG 图表
//
// 设计要点：
// - mermaid 体积大（~1MB），仅在消息中首次出现 mermaid 块时动态 import，不拖首屏
// - securityLevel: 'strict'：mermaid 自带转义，禁掉点击脚本等危险能力（CSP 也禁脚本）
// - 渲染失败不炸整条消息：降级显示原始代码 + 错误提示
// - 主题切换（documentElement.light class）后自动重渲染（SVG 颜色固化，不随 CSS 变量变）
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'

// mermaid 11 为 ESM，默认导出
type MermaidLib = typeof import('mermaid')['default']
let mermaidPromise: Promise<MermaidLib> | null = null

function loadMermaid(): Promise<MermaidLib> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

function currentTheme(): 'dark' | 'default' {
  return document.documentElement.classList.contains('light') ? 'default' : 'dark'
}

// 渲染 id 必须全局唯一且合法（不能以数字开头）：mermaid 用它生成 DOM id
let seq = 0
function nextId(): string {
  seq += 1
  return `pai-mmd-${Date.now().toString(36)}-${seq}`
}

export const MermaidBlock: React.FC<{ code: string }> = ({ code }) => {
  const { t } = useI18n()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const mountedRef = useRef(true)
  // 主题版本号：自增即触发重渲染 effect
  const [themeTick, setThemeTick] = useState(0)

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    async function render() {
      setError('')
      try {
        const mermaid = await loadMermaid()
        // initialize 可重复调用：首次完成懒初始化，之后用于热切换主题
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: currentTheme(),
          fontFamily: 'inherit'
        })
        const { svg: out } = await mermaid.render(nextId(), code)
        if (!cancelled && mountedRef.current) setSvg(out)
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          setSvg('')
          setError((e as Error)?.message || 'mermaid render error')
        }
      }
    }

    void render()
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [code, themeTick])

  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick((v) => v + 1))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  if (error) {
    return (
      <div className="my-2">
        <div className="text-[11px] text-[var(--color-warning)] mb-1">
          {t('chat.mermaidError')}
        </div>
        <pre className="rounded-lg p-3 overflow-x-auto text-[13px] bg-[var(--hljs-bg)] text-[var(--hljs-text)]">
          <code className="font-mono">{code}</code>
        </pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-2 rounded-lg p-3 text-[12px] text-[var(--color-text-muted)] bg-[var(--hljs-bg)]">
        {t('chat.mermaidLoading')}
      </div>
    )
  }

  return (
    <div
      className="mermaid-block my-2 overflow-x-auto rounded-lg p-2 bg-[var(--color-bg-secondary)]"
      // mermaid 输出为受信 SVG（strict 模式转义文本、禁脚本）；CSP script-src 仍兜底
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
