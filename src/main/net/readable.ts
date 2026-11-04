// 网页正文抽取（web_fetch 与 deep 搜索共用一份实现，别再抄第二份）
//
// 只做「去掉明显非正文元素 → 取 main/article 优先 → 压空白 → 截断」，
// 不做正文打分/Readability 算法：目标是把网页变成模型能读的一段文字，够用即可。

export async function extractReadableText(html: string, maxChars: number): Promise<string> {
  // 动态加载 cheerio（dependencies 被 externalize，运行时按需 ESM 加载，不拖慢启动）
  const { load } = await import('cheerio')
  const $ = load(html)
  // 移除明显非正文元素
  $('script,style,noscript,iframe,nav,footer,header,aside,form,button').remove()
  $('[role=banner],[role=navigation],[role=search]').remove()
  // 优先 main / article
  const main = $('main, article, .post, .content, #content').first()
  const root = main.length ? main : $('body')
  const text = root.text().replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return m ? m[1]!.trim() : ''
}
