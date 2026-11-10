// 防闪烁：React 挂载前恢复主题/语言偏好。
// 必须保持为外部文件（而非内联 <script>）：生产环境 CSP 为 script-src 'self'，
// 不允许内联脚本。index.html 与 unlock.html 共用本文件。
(function () {
  try {
    // 主题 id → <html> class（空串 = 基础态深色）。这份映射必须与 shared/themes.ts 的 UI_THEMES 一致：
    // tests/theme-registry 会比对两边，谁改了没同步就红。未知/脏值一律按默认深色（不加 class）。
    var THEME_CLASSES = { dark: '', light: 'light', ocean: 'ocean', sand: 'sand', sage: 'sage' }
    var storedTheme = localStorage.getItem('pocketai.theme')
    var theme = Object.prototype.hasOwnProperty.call(THEME_CLASSES, storedTheme) ? storedTheme : 'dark'
    var themeClass = THEME_CLASSES[theme]
    if (themeClass) document.documentElement.classList.add(themeClass)
    // 首帧主题上报：首次启动时主进程 KV 里还没有主题，建窗底色只是默认深色。
    // 在页面绘制前把当前生效主题报上去，主进程先把窗口底色改对再显示，避免闪一帧深色。
    // 只上报、不写 KV；桥不可用或调用失败都静默（最多退回默认底色，不影响主题本身）。
    try {
      if (typeof window !== 'undefined' && window.pocketai && window.pocketai.reportWindowTheme) {
        var p = window.pocketai.reportWindowTheme(theme)
        if (p && p.catch) p.catch(function () {})
      }
    } catch (e2) {
      /* ignore */
    }
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
