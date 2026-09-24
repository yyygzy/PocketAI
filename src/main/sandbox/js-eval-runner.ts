// js_eval 执行器（V2 批次八）
//
// 隐藏 sandbox BrowserWindow + webContents.executeJavaScript：
//  - sandbox:true 渲染进程无 Node 面（无 require / process / Node globals）
//  - 禁弹窗（setWindowOpenHandler deny）与禁导航（will-navigate preventDefault），
//    并在执行前校验仍处于初始 data: 空白页，防止代码把执行环境偷换到远程页面
//  - 代码经 JSON.stringify 作为纯字符串字面量传给页面内 AsyncFunction 构造器执行
//    （语义与「异步 IIFE 函数体」一致：可用 return / await，且无任何结构逃逸面），
//    结果在页面内先做 JSON 序列化（不可克隆对象不出沙箱）
//  - 5s 超时：超时后 destroy 窗口并重建（防死循环与状态污染），下一次调用自动用新窗口
//  - 支持 AbortSignal（Agent 中止时立即销毁窗口）
//  - 结果截断 2000 字符（后缀计入预算）；并发调用经模块级队列串行执行
import { BrowserWindow } from 'electron'
import { errMsg } from '../error'

const EVAL_TIMEOUT_MS = 5_000
const MAX_RESULT_CHARS = 2000

let win: BrowserWindow | null = null
let ready: Promise<void> | null = null

function ensureWindow(): { w: BrowserWindow; readyPromise: Promise<void> } {
  if (win && !win.isDestroyed() && ready) {
    return { w: win, readyPromise: ready }
  }
  const w = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
      // 无 preload：纯空白沙箱页
    }
  })
  // 执行代码若能 window.open 或把窗口导航到远程页，
  // 后续 executeJavaScript 就会落入远程页主世界——必须双保险封死
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  win = w
  ready = w
    .loadURL('data:text/html;charset=utf-8,%3C!DOCTYPE%20html%3E%3Chtml%3E%3C%2Fhtml%3E')
    .then(
      () => undefined,
      (err) => {
        // loadURL 失败即销毁：避免坏窗口与 rejected promise 被永久缓存，导致 js_eval 从此不可用
        if (win === w) destroyWindow()
        throw err
      }
    )
  return { w, readyPromise: ready }
}

function destroyWindow(): void {
  ready = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

export function cut(s: string, max = MAX_RESULT_CHARS): string {
  if (s.length <= max) return s
  const suffix = `\n…（截断，共 ${s.length} 字符）`
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix
}

async function doRunEval(code: string, signal?: AbortSignal): Promise<string> {
  const src = String(code ?? '')
  if (!src.trim()) throw new Error('code 不能为空')

  // 页面内执行脚本：JSON.stringify(src) 把用户代码嵌入为纯字符串字面量（无结构逃逸面），
  // AsyncFunction 保持「异步函数体」语义；执行 → 序列化 → { ok, text | error }
  const pageScript = `(async () => {
    try {
      const __AsyncFunction = (async function () {}).constructor;
      const __fn = new __AsyncFunction(${JSON.stringify(src)});
      const __result = await __fn();
      const __seen = new WeakSet();
      const __json = JSON.stringify(__result, (_k, v) => {
        if (typeof v === 'function') return '[Function]';
        if (typeof v === 'symbol') return String(v);
        if (typeof v === 'bigint') return v.toString() + 'n';
        if (typeof v === 'object' && v !== null) {
          if (__seen.has(v)) return '[Circular]';
          __seen.add(v);
        }
        return v;
      });
      return { ok: true, text: __json === undefined ? 'undefined' : __json };
    } catch (__err) {
      return { ok: false, error: String((__err && __err.message) || __err) };
    }
  })()`

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true
        cleanup()
        fn()
      }
    }
    const timer = setTimeout(() => {
      // 超时销毁窗口：防死循环占用与状态污染；下次调用重建
      destroyWindow()
      finish(() => reject(new Error(`执行超时（${EVAL_TIMEOUT_MS / 1000}s），沙箱已重置`)))
    }, EVAL_TIMEOUT_MS)
    const onAbort = () => {
      destroyWindow()
      finish(() => reject(new Error('已中止')))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    if (signal?.aborted) {
      finish(() => reject(new Error('已中止')))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const { w, readyPromise } = ensureWindow()
      readyPromise
        .then(() => {
          // 兜底校验：确认仍在初始 data: 空白页（will-navigate 已拦截导航，此处防漏网）
          const url = w.webContents.getURL()
          if (url && !url.startsWith('data:')) {
            destroyWindow()
            throw new Error('沙箱窗口状态异常，已重置')
          }
          return w.webContents.executeJavaScript(pageScript, false)
        })
        .then((r) => {
          const res = r as { ok: boolean; text?: string; error?: string } | null
          if (res && res.ok) {
            finish(() => resolve(cut(String(res.text ?? 'undefined'))))
          } else {
            finish(() => reject(new Error(res?.error || '沙箱执行失败')))
          }
        })
        .catch((err) => {
          // 窗口被超时/中止销毁时 executeJavaScript 会 reject——settle 已被占用则无副作用
          finish(() => reject(new Error(`沙箱执行失败: ${errMsg(err)}`)))
        })
    } catch (err) {
      finish(() => reject(new Error(`沙箱执行失败: ${errMsg(err)}`)))
    }
  })
}

// 模块级互斥队列：并发调用串行执行，
// 避免共享窗口时一次超时/中止连带销毁他人在途执行
let evalQueue: Promise<unknown> = Promise.resolve()

export function runJsEval(code: string, signal?: AbortSignal): Promise<string> {
  const run = evalQueue.then(() => doRunEval(code, signal))
  // 队尾吞错：一次失败不阻塞后续调用
  evalQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
