// 响应体流式有界读取（M4）：先查 Content-Length，再逐块累计，超限立即取消流。
// 与 safeFetch 内部的 readBody 同口径，供仍使用全局/fetchImpl 的调用点复用。

/** 流式读取 Response 文本，超过 maxBytes 立即取消并抛错（不把巨串读进内存） */
export async function readTextLimited(
  res: Response,
  maxBytes: number,
  label = '响应体'
): Promise<string> {
  const declared = Number(res.headers?.get('content-length') ?? 0)
  const limitText = `${label}超过上限（${Math.round(maxBytes / 1024)}KB），已拒绝`
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(limitText)
  const reader = res.body?.getReader?.()
  // 某些 fetch 桩/环境只实现 text() 没有 body 流；退回 text()，真实 Response 仍走上面的流式闸
  if (!reader) return typeof res.text === 'function' ? res.text() : ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(limitText)
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch { /* 已 cancel 时释放失败无害 */ }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}
