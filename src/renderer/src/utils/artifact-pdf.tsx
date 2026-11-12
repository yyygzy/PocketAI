// 产物（md）→ 自包含 HTML：给主进程 printToPDF 用
//
// 为什么在渲染端拼：主进程没有与预览一致的 md 渲染器（`react-markdown`/`remark-gfm` 都在渲染端），
// 另写一套必然和应用内所见不一致。这里复用对话导出的 `EXPORT_STYLE`，只叠一层**打印补丁**：
//  · `pre` 不能用 `overflow-x:auto`——打印时横向溢出会被直接裁掉（长代码行丢字），改 `pre-wrap`；
//  · 宽表格 `table-layout:fixed` + `word-break:break-word`，避免列宽按内容撑破页宽；
//  · 纸张/页边距由主进程 printToPDF 的 options 决定（未开 preferCSSPageSize，@page 无效），
//    所以这里把 body/.doc 的屏幕留白清零，避免"边距叠边距"。
import { EXPORT_STYLE } from './export-html'

const PRINT_PATCH = `
body { background:#fff; padding:0; }
.doc { max-width:none; border:0; border-radius:0; padding:0; background:#fff; }
.markdown-body pre { white-space:pre-wrap; overflow-wrap:anywhere; overflow-x:visible; }
.markdown-body table { table-layout:fixed; width:100%; }
.markdown-body th, .markdown-body td { word-break:break-word; overflow-wrap:anywhere; }
.markdown-body img { max-width:100%; height:auto; }
.markdown-body h1, .markdown-body h2, .markdown-body h3 { break-after:avoid-page; }
.markdown-body tr, .markdown-body blockquote { break-inside:avoid-page; }
`

/** md 正文 → 自包含 HTML（内联 CSS、无脚本、无外部资源） */
export async function buildArtifactPdfHtml(input: {
  title: string
  markdown: string
}): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  // Markdown 管线（含高亮）体积可观，动态 import：只有点「导出 PDF」时才加载，不拖慢卡片
  const { Markdown } = await import('../modules/chat/Markdown')
  const markup = renderToStaticMarkup(
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <title>{input.title}</title>
        <style>{EXPORT_STYLE + PRINT_PATCH}</style>
      </head>
      <body>
        <div className="doc">
          <Markdown content={input.markdown} codeCopy={false} />
        </div>
      </body>
    </html>
  )
  return '<!doctype html>\n' + markup
}
