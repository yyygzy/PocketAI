// 剪贴板写入的统一收口
//
// 背景：打包后渲染页走 file:// 加载，navigator.clipboard 在无焦点/非安全上下文
// 场景会抛错；历史上多个模块各自手写降级，行为不一致（有的静默失败、有的不降级）。
// 所有复制需求统一走本函数。

/**
 * 把文本写入剪贴板。
 * 优先异步 Clipboard API；失败时降级到隐藏 textarea + execCommand('copy')。
 * @returns 是否复制成功（调用方可据此决定是否展示失败反馈）
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 降级：execCommand 已废弃但仍是 file:// 场景最可靠的兜底
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        return document.execCommand('copy')
      } finally {
        document.body.removeChild(ta)
      }
    } catch {
      return false
    }
  }
}
