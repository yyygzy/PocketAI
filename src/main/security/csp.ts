// 渲染层 Content-Security-Policy（生产环境）
//
// 背景：渲染层会展示模型回复、网页抓取内容、工具输出等不可信内容。
// 虽然 react-markdown 默认转义原始 HTML、搜索片段也经过转义，
// CSP 仍是最后一道纵深防线 —— 任何遗漏的注入点都无法执行脚本/外发数据。
//
// 开发环境（ELECTRON_RENDERER_URL 存在）不安装：Vite HMR 需要 unsafe-eval、
// WebSocket(ws://localhost) 等，开发机不是安全边界。
import { session } from 'electron'

const PROD_CSP = [
  "default-src 'self'",
  // React 不做模板编译，无 eval 需求；内联脚本被禁止（启动脚本已外置）
  "script-src 'self'",
  // React style={{}} 属性与动态注入的 <style>（自定义外观）需要 inline style
  "style-src 'self' 'unsafe-inline'",
  // 附件经 IPC 以 data:/blob: 展示；Markdown 远程图片允许 https:
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: https:",
  // 一切网络请求都经主进程（provider/搜索/抓取），渲染层不直接联网
  "connect-src 'self'",
  "object-src 'none'",
  // 沙盒预览 iframe 用 srcDoc + sandbox="allow-scripts"（不透明源，自带预览 CSP）；
  // 'self' 放行 srcdoc，远程框架/嵌套页面仍被禁止
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

export function installContentSecurityPolicy(): void {
  if (process.env['ELECTRON_RENDERER_URL']) return
  // defaultSession 覆盖主窗口、解锁窗（含 IPC 动态创建的）与浮窗
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [PROD_CSP]
      }
    })
  })
}
