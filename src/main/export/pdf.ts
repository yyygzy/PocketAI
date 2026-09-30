// 会话导出 PDF（V4-Iter-26）
//
// 隐藏 sandbox BrowserWindow 加载自包含 HTML 临时文件 → webContents.printToPDF：
//  - 窗口模板与生命周期对齐 js-eval-runner（show:false、sandbox、deny 弹窗/导航、
//    加载失败销毁重建、模块级单例）
//  - HTML 经临时文件 file:// 加载而非 data URL（export-html 产物可达数 MB，
//    data URL 有 ~2MB 上限风险）
//  - 模块级串行队列：单窗口不能并发 loadFile，单条/批量调用统一入队，
//    队尾吞错保证一次失败不阻塞后续导出
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { errMsg } from '../error'

// 单文件转换兜底超时：正常会话 <3s，超时即认定窗口状态异常，销毁重建防队列卡死
const PDF_TIMEOUT_MS = 60_000

let win: BrowserWindow | null = null
let ready: Promise<void> | null = null

function destroyWindow(): void {
  ready = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed() && ready) return win
  const w = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
      // 无 preload：纯静态 HTML 渲染面
    }
  })
  // 禁弹窗与页面内导航：export-html 产物为纯展示文档，无合法导航场景
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  win = w
  return w
}

/** 单个 HTML → PDF（调用方需经 runPdfJob 串行队列） */
async function doHtmlToPdf(html: string): Promise<Uint8Array> {
  const src = String(html ?? '')
  if (!src.trim()) throw new Error('html 不能为空')

  const tmpPath = path.join(
    app.getPath('temp'),
    `pocketai-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.html`
  )
  fs.writeFileSync(tmpPath, src, 'utf8')

  try {
    const w = ensureWindow()
    if (!ready) {
      // 首建窗口先加载空白页就绪；后续复用时 loadFile 自身即就绪信号
      ready = w.loadURL('data:text/html;charset=utf-8,%3C!DOCTYPE%20html%3E%3Chtml%3E%3C%2Fhtml%3E').then(
        () => undefined,
        (err) => {
          // 加载失败即销毁：避免坏窗口与 rejected promise 被永久缓存
          if (win === w) destroyWindow()
          throw err
        }
      )
    }
    const pdf = await Promise.race([
      ready.then(() => w.loadFile(tmpPath)).then(() => w.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: ' ', // 显式置空：否则出现默认「日期+标题」页眉
        footerTemplate:
          '<div style="font-size:8px;width:100%;text-align:center;color:#667085;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        margins: { top: 0.4, bottom: 0.5, left: 0.4, right: 0.4 }
      })),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          // 超时销毁窗口：防 printToPDF 挂死卡死整个队列；下次调用重建
          destroyWindow()
          reject(new Error(`PDF 转换超时（${PDF_TIMEOUT_MS / 1000}s）`))
        }, PDF_TIMEOUT_MS)
      )
    ])
    return pdf
  } catch (err) {
    // loadFile/printToPDF 失败多伴随窗口状态异常：销毁重建，防坏窗口被复用
    destroyWindow()
    throw new Error(`PDF 转换失败: ${errMsg(err)}`)
  } finally {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* 临时文件清理失败可忽略 */
    }
  }
}

// 模块级互斥队列（同 js-eval-runner）：共享单窗口，串行执行
let pdfQueue: Promise<unknown> = Promise.resolve()

export function htmlToPdf(html: string): Promise<Uint8Array> {
  const run = pdfQueue.then(() => doHtmlToPdf(html))
  // 队尾吞错：一次失败不阻塞后续调用
  pdfQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
