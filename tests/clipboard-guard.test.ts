// clipboard-guard 剪贴板敏感内容守卫测试
//
// 覆盖复制敏感文本（恢复码等）后的定时清除逻辑：
// - copySensitive 立即写剪贴板并安排 TTL 清除
// - TTL 到期：内容未变才 clear，被用户顶掉则不动剪贴板
// - readText 失败（Linux 权限受限）保守跳过，不误覆盖
// - 锁屏/隐藏联动的 purge() 立即清除与状态复位
// - 连续复制只跟踪最近一次、TTL 下限 1000ms
//
// 策略：vi.mock electron clipboard + vi fake timers；clipboardGuard 是单例，
// 每个用例结束在 afterEach 中 purge 复位内部 timer/pending 状态。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  readText: vi.fn(),
  clear: vi.fn()
}))

vi.mock('electron', () => ({
  clipboard: {
    writeText: mocks.writeText,
    readText: mocks.readText,
    clear: mocks.clear
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { clipboardGuard, SENSITIVE_CLIPBOARD_TTL_MS } from '../src/main/crypto/clipboard-guard'

beforeEach(() => {
  vi.useFakeTimers()
  mocks.writeText.mockResolvedValue(undefined)
  mocks.readText.mockResolvedValue('')
  mocks.clear.mockReturnValue(undefined)
})

afterEach(async () => {
  // 复位单例内部状态（清 timer + 清 pending），避免用例间串扰
  await clipboardGuard.purge()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('clipboard-guard — 复制与 TTL 清除', () => {
  it('copySensitive 立即写入剪贴板', () => {
    clipboardGuard.copySensitive('recovery-code-123')
    expect(mocks.writeText).toHaveBeenCalledWith('recovery-code-123')
  })

  it(`默认 TTL 为 ${SENSITIVE_CLIPBOARD_TTL_MS}ms（30 秒）`, () => {
    expect(SENSITIVE_CLIPBOARD_TTL_MS).toBe(30_000)
  })

  it('TTL 到期且内容未变 → clear() 清空剪贴板', async () => {
    mocks.readText.mockResolvedValue('recovery-code-123')
    clipboardGuard.copySensitive('recovery-code-123')
    expect(mocks.clear).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_TTL_MS)
    expect(mocks.clear).toHaveBeenCalledTimes(1)
  })

  it('TTL 到期但用户已复制其他内容 → 不 clear（不覆盖用户剪贴板）', async () => {
    clipboardGuard.copySensitive('recovery-code-123')
    mocks.readText.mockResolvedValue('user-copied-something-else')
    await vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_TTL_MS)
    expect(mocks.readText).toHaveBeenCalledTimes(1)
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('readText 抛错（Linux 权限受限）→ 保守跳过、不 clear、不抛', async () => {
    clipboardGuard.copySensitive('recovery-code-123')
    mocks.readText.mockRejectedValue(new Error('permission denied'))
    // 定时回调内部吞掉读取失败，advance 不应向外抛错
    await expect(vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_TTL_MS)).resolves.toBeDefined()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('TTL 到期清除后 pending 复位 → 再 purge 为 no-op', async () => {
    mocks.readText.mockResolvedValue('secret')
    clipboardGuard.copySensitive('secret')
    await vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_TTL_MS)
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    await clipboardGuard.purge()
    expect(mocks.clear).toHaveBeenCalledTimes(1)
  })
})

describe('clipboard-guard — purge 联动与状态跟踪', () => {
  it('purge() 立即清除等待期内的敏感内容（锁屏/隐藏联动）', async () => {
    mocks.readText.mockResolvedValue('secret')
    clipboardGuard.copySensitive('secret')
    await clipboardGuard.purge()
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    // 定时器已被清掉，TTL 到期不再触发第二次清除
    await vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_TTL_MS)
    expect(mocks.clear).toHaveBeenCalledTimes(1)
  })

  it('无 pending 时 purge → no-op', async () => {
    await expect(clipboardGuard.purge()).resolves.toBeUndefined()
    expect(mocks.readText).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('连续两次 copySensitive → 只跟踪最近一次', async () => {
    mocks.readText.mockResolvedValue('second')
    clipboardGuard.copySensitive('first')
    await vi.advanceTimersByTimeAsync(1000)
    clipboardGuard.copySensitive('second')
    await vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_TTL_MS)
    // 只在第二次 TTL 到期时读取并清除一次；first 永不被清除
    expect(mocks.readText).toHaveBeenCalledTimes(1)
    expect(mocks.clear).toHaveBeenCalledTimes(1)
  })

  it('ttl 下限 1000ms：传入更小值按 1000ms 生效', async () => {
    mocks.readText.mockResolvedValue('secret')
    clipboardGuard.copySensitive('secret', 100)
    await vi.advanceTimersByTimeAsync(999)
    expect(mocks.clear).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.clear).toHaveBeenCalledTimes(1)
  })

  it('writeText 失败不阻断清除安排（pending 仍设置）', async () => {
    mocks.writeText.mockRejectedValue(new Error('clipboard busy'))
    mocks.readText.mockResolvedValue('secret')
    expect(() => clipboardGuard.copySensitive('secret')).not.toThrow()
    await vi.advanceTimersByTimeAsync(SENSITIVE_CLIPBOARD_TTL_MS)
    expect(mocks.clear).toHaveBeenCalledTimes(1)
  })
})
