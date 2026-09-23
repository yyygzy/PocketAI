// catch 异常文本收窄（渲染层 errText 与主进程 errMsg 同型契约）
// 锁定：Error 取 message；非空字符串直用；空串/非 Error 值走 fallback（默认「未知错误」）
import { describe, it, expect } from 'vitest'
import { errText } from '../src/renderer/src/utils/error'
import { errMsg, isAbortError } from '../src/main/error'

// safe-handle 的 re-export 必须保持可用（既有 handler 从 ipc 层导入）
import { errMsg as errMsgFromSafeHandle } from '../src/main/ipc/safe-handle'

const cases: Array<[unknown, string, string]> = [
  // [抛出值, 自定义 fallback, 期望]
  [new Error('boom'), '兜底', 'boom'],
  ['字符串错误', '兜底', '字符串错误'],
  ['', '兜底', '兜底'],
  [42, '兜底', '兜底'],
  [{ code: 1 }, '兜底', '兜底'],
  [null, '兜底', '兜底'],
  [undefined, '兜底', '兜底']
]

describe('renderer errText', () => {
  it.each(cases)('收窄 %p → %s', (e, fallback, expected) => {
    expect(errText(e, fallback)).toBe(expected)
  })

  it('默认 fallback 为「未知错误」', () => {
    expect(errText(undefined)).toBe('未知错误')
    expect(errText(null)).toBe('未知错误')
    expect(errText('')).toBe('未知错误')
  })

  it('Error 子类（含自定义属性）同样取 message', () => {
    class HttpError extends Error {
      status = 500
      constructor() {
        super('server error')
      }
    }
    expect(errText(new HttpError())).toBe('server error')
  })
})

describe('main errMsg', () => {
  it.each(cases)('收窄 %p → %s', (e, fallback, expected) => {
    expect(errMsg(e, fallback)).toBe(expected)
  })

  it('默认 fallback 为「未知错误」', () => {
    expect(errMsg(0)).toBe('未知错误')
    expect(errMsg(new Error('x'))).toBe('x')
  })

  it('safe-handle 继续 re-export errMsg（handler 导入路径兼容）', () => {
    expect(errMsgFromSafeHandle).toBe(errMsg)
  })
})

describe('main isAbortError', () => {
  it('AbortError / TimeoutError 名称的 Error 判定为中止', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isAbortError(abort)).toBe(true)
    const timeout = new Error('timeout')
    timeout.name = 'TimeoutError'
    expect(isAbortError(timeout)).toBe(true)
  })

  it('普通 Error 与非 Error 值不算中止', () => {
    expect(isAbortError(new Error('boom'))).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
  })
})
