// 防闪烁：React 挂载前恢复主题/语言偏好。
// 必须保持为外部文件（而非内联 <script>）：生产环境 CSP 为 script-src 'self'，
// 不允许内联脚本。index.html 与 unlock.html 共用本文件。
(function () {
  try {
    var theme = localStorage.getItem('pocketai.theme')
    if (theme === 'light') document.documentElement.classList.add('light')
    var lang = localStorage.getItem('pocketai.lang')
    if (lang === 'en') document.documentElement.lang = 'en'
  } catch (e) {
    // localStorage 被禁用/隐私模式时静默降级默认主题，此阶段无日志通道
  }
})()
