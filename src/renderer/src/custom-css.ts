// 自定义 CSS 注入助手
//
// 启动时由入口拉取偏好并注入 <style id="pocketai-custom-css">；
// 设置页保存后立即重新注入，无需重启。CSS 只作用于本应用渲染进程。

const STYLE_ID = 'pocketai-custom-css'

/** 用给定 CSS 覆盖注入的样式；空字符串则移除节点 */
export function injectCustomCss(css: string): void {
  const existing = document.getElementById(STYLE_ID)
  if (!css) {
    existing?.remove()
    return
  }
  if (existing) {
    existing.textContent = css
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  document.head.appendChild(style)
}

/** 启动时拉取并注入（失败静默，不影响正常启动） */
export async function loadAndInjectCustomCss(): Promise<void> {
  try {
    const r = await window.pocketai.getUiPrefs()
    if (r.ok && r.data) injectCustomCss(r.data.customCss)
  } catch {
    /* 忽略：偏好读取失败不应阻断启动 */
  }
}
