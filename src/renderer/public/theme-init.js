// 防闪烁：React 挂载前恢复主题/语言偏好。
// 必须保持为外部文件（而非内联 <script>）：生产环境 CSP 为 script-src 'self'，
// 不允许内联脚本。index.html 与 unlock.html 共用本文件。
(function () {
  try {
    var theme = localStorage.getItem('pocketai.theme')
    if (theme === 'light') document.documentElement.classList.add('light')
    var lang = localStorage.getItem('pocketai.lang')
    // 语言只写 <html lang>：首帧据此选对 CJK 字形，不加载任何字典（整份字典仍由 i18n 按需拉取）。
    // 取值口径与 i18n readInitialLang 一致：存储值优先，其次浏览器语言 ja/ko，其余保持 zh-CN。
    if (!lang) {
      var nav = (navigator.language || '').toLowerCase()
      if (nav.indexOf('ja') === 0) lang = 'ja'
      else if (nav.indexOf('ko') === 0) lang = 'ko'
    }
    if (lang === 'en' || lang === 'ja' || lang === 'ko') document.documentElement.lang = lang
  } catch (e) {
    // localStorage 被禁用/隐私模式时静默降级默认主题，此阶段无日志通道
  }
})()
