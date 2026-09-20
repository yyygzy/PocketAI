// 会话搜索高亮标记：用 Unicode 私用区字符代替 <b></b>，
// 让搜索片段始终以「纯文本 + 标记」的形式跨 IPC 传输，
// 渲染层拆分为 React 文本节点，彻底排除 HTML 注入面（不依赖转义正确性）。
// 取自私用区 U+E000/E001：正常聊天内容几乎不会出现；
// 即便出现，渲染效果仅为错误加粗，无安全影响。
export const SNIPPET_MARK_OPEN = ''
export const SNIPPET_MARK_CLOSE = ''
