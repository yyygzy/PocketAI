// 对话导出：自包含 HTML 生成（渲染端）
//
// 内容渲染复用应用内 Markdown 组件（GFM/代码高亮管线一致，且未挂 rehype-raw，
// 消息中的裸 HTML/脚本会被 remark 解析层过滤——XSS 安全）；
// 组件依赖的 tailwind/CSS 变量在导出文件里不存在，故排版全部由内联 CSS 对
// .markdown-body 下的原生标签重新收口，浅色固定主题，双击即可在浏览器阅读。
//
// 已知限制：katex/mermaid 为懒加载，导出瞬间未就绪时公式/图表保留源码文本。
import React from 'react'
import type { MessageRecord } from '../../../shared/types'
import type { ExportConversationMeta } from '../../../shared/export-markdown'
import { formatSources, formatAttachments, roleLabel } from '../../../shared/export-markdown'
import { Markdown } from '../modules/chat/Markdown'
// react-dom/server 体积可观，动态 import 拆为独立 chunk——仅导出 HTML 时加载，不回退主包瘦身成果

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin:0; padding:32px 16px; background:#f5f6f8; color:#1f2329;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  font-size:15px; line-height:1.7; }
.doc { max-width:820px; margin:0 auto; background:#fff; border:1px solid #e3e6ea;
  border-radius:10px; padding:40px 48px; }
.doc h1 { font-size:24px; margin:0 0 12px; }
.meta { color:#6b7280; font-size:13px; background:#f8fafc; border:1px solid #eef0f3;
  border-radius:8px; padding:10px 14px; margin-bottom:8px; }
.meta div { margin:2px 0; }
.rule { border:0; border-top:1px solid #e5e7eb; margin:24px 0; }
.msg { margin:24px 0; }
.msg > h2 { font-size:15px; color:#374151; margin:0 0 8px; font-weight:600; }
.user-msg { background:#f0f7ff; border-left:3px solid #3b82f6; border-radius:0 8px 8px 0;
  padding:10px 16px; }
.att { color:#6b7280; font-size:13px; margin:4px 0; }
.att pre { white-space:pre-wrap; margin:4px 0 0; font-size:12px; color:#4b5563; }
.tools { background:#fafafa; border:1px solid #eee; border-radius:6px; padding:8px 12px;
  font-size:13px; margin:6px 0; }
.tools code { font-family:ui-monospace,Consolas,monospace; color:#9333ea; }
.sources { margin:8px 0 0; padding-left:22px; color:#4b5563; font-size:13px; }
.sources li { margin:2px 0; }
.usage { color:#9ca3af; font-size:12px; font-style:italic; margin:4px 0; }
.markdown-body { word-break:break-word; }
.markdown-body h1,.markdown-body h2,.markdown-body h3 { margin:18px 0 8px; line-height:1.35; }
.markdown-body h1 { font-size:20px; } .markdown-body h2 { font-size:18px; } .markdown-body h3 { font-size:16px; }
.markdown-body p { margin:8px 0; }
.markdown-body ul,.markdown-body ol { padding-left:24px; margin:8px 0; }
.markdown-body li { margin:3px 0; }
.markdown-body blockquote { margin:8px 0; padding:2px 14px; border-left:4px solid #d1d5db;
  color:#4b5563; background:#fafafa; border-radius:0 6px 6px 0; }
.markdown-body a { color:#2563eb; text-decoration:underline; }
.markdown-body table { border-collapse:collapse; width:100%; margin:10px 0; font-size:13px; display:table; }
.markdown-body th,.markdown-body td { border:1px solid #d1d5db !important; padding:6px 10px !important;
  background:#fff !important; }
.markdown-body th { background:#f3f4f6 !important; }
.markdown-body pre { background:#f6f8fa !important; color:#1f2329 !important; border:1px solid #e5e7eb;
  border-radius:8px; padding:12px 14px; overflow-x:auto; font-size:13px; line-height:1.5;
  margin:10px 0; }
.markdown-body code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  background:rgba(135,131,120,.15); border-radius:4px; padding:1px 5px; font-size:.9em; }
.markdown-body pre code { background:transparent; padding:0; font-size:13px; }
.markdown-body img { max-width:100%; }
.markdown-body hr { border:0; border-top:1px solid #e5e7eb; margin:16px 0; }
.footer { color:#9ca3af; font-size:12px; text-align:center; margin-top:20px; }
`

function ToolCalls({ raw }: { raw: string }): React.ReactElement | null {
  let calls: Array<{ name?: string; args?: unknown }> = []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) calls = parsed
  } catch {
    return (
      <div className="tools">
        <code>{raw}</code>
      </div>
    )
  }
  if (calls.length === 0) return null
  return (
    <div className="tools">
      <div><strong>Tool Calls</strong></div>
      <ul>
        {calls.map((c, i) => (
          <li key={i}>
            <code>{String(c.name ?? 'unknown')}</code>
            {c.args != null && <span> → {String(typeof c.args === 'string' ? c.args : JSON.stringify(c.args))}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function MessageView({ msg }: { msg: MessageRecord }): React.ReactElement {
  const time = new Date(msg.createdAt).toLocaleString()
  const sources = formatSources(msg.sources)
  const attachments = formatAttachments(msg.attachments)
  return (
    <section className="msg">
      <h2>{roleLabel(msg.role)} — {time}</h2>
      {attachments.length > 0 && attachments.map((line, i) => {
        // 文本附件预览行以 > 开头（与 Markdown builder 的 formatAttachments 约定一致）
        const isPreview = line.startsWith('> ')
        return isPreview
          ? <div className="att" key={i}><pre>{line.slice(2)}</pre></div>
          : <div className="att" key={i}>{line}</div>
      })}
      {msg.toolCalls && <ToolCalls raw={msg.toolCalls} />}
      {msg.content && (
        msg.role === 'user'
          ? <div className="user-msg"><Markdown content={msg.content} codeCopy={false} /></div>
          : <Markdown content={msg.content} codeCopy={false} />
      )}
      {sources.length > 0 && (
        <>
          <div className="sources"><strong>参考来源：</strong></div>
          <ol className="sources">
            {sources.map((s, i) => <li key={i}>{s.replace(/^\[\d+\]\s*/, '')}</li>)}
          </ol>
        </>
      )}
      {msg.usage && (
        <div className="usage">
          tokens：输入 {msg.usage.promptTokens} / 输出 {msg.usage.completionTokens} / 合计 {msg.usage.totalTokens}
        </div>
      )}
      <hr className="rule" />
    </section>
  )
}

/**
 * 构建单会话自包含 HTML（<!doctype> 起，内联样式，无外部资源依赖）。
 * @param assistantName 助手名称（调用方查询注入）
 */
export async function buildConversationHtml(
  conv: ExportConversationMeta,
  messages: MessageRecord[],
  assistantName?: string | null
): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const markup = renderToStaticMarkup(
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{conv.title}</title>
        <style>{STYLE}</style>
      </head>
      <body>
        <div className="doc">
          <h1>{conv.title}</h1>
          <div className="meta">
            <div><strong>模型</strong>：{conv.modelLabel ?? '未知'}</div>
            {assistantName && <div><strong>助手</strong>：{assistantName}</div>}
            <div><strong>创建时间</strong>：{new Date(conv.createdAt).toLocaleString()}</div>
            <div><strong>最后更新</strong>：{new Date(conv.updatedAt).toLocaleString()}</div>
            <div><strong>消息数</strong>：{messages.length}</div>
          </div>
          <hr className="rule" />
          {messages.map((m) => <MessageView key={m.id} msg={m} />)}
          <div className="footer">由 PocketAI 导出</div>
        </div>
      </body>
    </html>
  )
  return '<!doctype html>\n' + markup
}
