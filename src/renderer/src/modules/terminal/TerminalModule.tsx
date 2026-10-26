import React, { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { hasIpcFailed, ipcFailText, ipcFailureText, reportIpcError } from '../../utils/ipc'

const MAX_OUTPUT = 50000
const KEEP_OUTPUT = 40000

/** 输出一帧（与 preload 的 TERMINAL_OUTPUT 载荷同形；epoch＝写这帧的那台 shell 的轮次号） */
interface TerminalFrame {
  sessionId: number
  epoch: number
  stream: 'stdout' | 'stderr' | 'exit'
  data: string
}

/**
 * 本轮轮次号还没落地时暂存的帧数上限（§320）。
 * 这段时间正常情况下只有一两行（shell 的首字节实测十几毫秒，比 IPC 往返晚得多），
 * 上限纯粹是「startTerminal 一直不回来」时的兜底；越界丢最旧的，与屏上自己的 MAX_OUTPUT 同口径。
 */
const PENDING_MAX = 100

/**
 * 终端缓冲追加：超过 MAX_OUTPUT 就丢最旧的一段，并回报 clipped。
 * 回报是必须的——不告诉用户"上面被裁掉了"，屏上看着就像全量。
 */
export function appendOutput(prev: string, chunk: string): { text: string; clipped: boolean } {
  const next = prev + chunk
  if (next.length <= MAX_OUTPUT) return { text: next, clipped: false }
  return { text: next.slice(-KEEP_OUTPUT), clipped: true }
}

export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

export const TerminalModule: React.FC = () => {
  const { t } = useI18n()
  const [output, setOutput] = useState('')
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clipped, setClipped] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let unsub: (() => void) | undefined
    let mounted = true
    // §320：听众挂在发起**之前**（挂在 await 之后时，主进程一起 shell 就在往这扇窗口推帧，
    // 十几毫秒内开口的首屏会没人听）；而本轮的轮次号要等 startTerminal 的回复才知道，
    // 所以这中间到达的帧先暂存——它们分不清是刚起那台 shell 的首屏，还是上一台被杀掉的迟到退出。
    // 轮次号落地后只回放属于本轮的那些，其余丢掉：丢掉的那一帧若是旧 shell 的 exit，
    // 收下它会把 running 误置成 false，输入框从此失灵。
    let epoch: number | null = null
    const pending: TerminalFrame[] = []

    const apply = (p: TerminalFrame): void => {
      if (p.stream === 'exit') {
        setRunning(false)
      }
      setOutput((prev) => {
        const r = appendOutput(prev, p.data)
        if (r.clipped) {
          // 只在第一次置位：更新函数可能被重复调用，state 幂等设 true 没有副作用
          setClipped(true)
        }
        return r.text
      })
    }

    unsub = window.pocketai.onTerminalOutput((p) => {
      if (!mounted) return
      if (epoch === null) {
        if (pending.length >= PENDING_MAX) pending.shift()
        pending.push(p)
        return
      }
      if (p.epoch !== epoch) return
      apply(p)
    })

    void (async () => {
      const r = await window.pocketai.startTerminal()
      if (!mounted) return
      if (hasIpcFailed(r)) {
        setError(ipcFailText(r, t('terminal.startFailed')))
        return
      }
      setRunning(true)
      setError(null)
      epoch = r.epoch
      for (const p of pending) {
        if (p.epoch === epoch) apply(p)
      }
      pending.length = 0
    })()

    return () => {
      mounted = false
      if (unsub) unsub()
      window.pocketai.killTerminal().catch(reportIpcError('terminal.killTerminal'))
    }
  }, [t])

  useEffect(() => {
    const el = preRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [output])

  /**
   * 写一行给 shell，并回答「这条真的送出去了没」（§320）。
   *
   * 主进程那两种拒绝——管道不可用、deny 名单拦下——都是 `safeHandle` 转成的 **resolve 值**
   * （`{ok:false}`），过去这里只挂 `.catch`，于是两种拒绝都演成"命令发出去了"：
   * 输入框被清空、命令还进了历史，屏上零反应。reject（通道没注册那种）仍只留 console 痕，与 §224 一致。
   */
  const sendInput = async (data: string): Promise<boolean> => {
    const r = await window.pocketai.terminalInput(data)
    if (hasIpcFailed(r)) {
      setError(t('terminal.sendFailed', { msg: ipcFailureText(r, t) }))
      return false
    }
    setError(null)
    return true
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = input
      if (!cmd) return
      void sendInput(cmd + '\r\n')
        .then((sent) => {
          // 没送出去就不清空、不进历史：用户能改、能重试，而不是对着一句被吞掉的拒绝重新打字
          if (!sent) return
          setInput('')
          setHistory((prev) => {
            const next = prev.filter((h) => h !== cmd)
            next.push(cmd)
            if (next.length > 200) next.shift()
            return next
          })
          setHistoryIndex(-1)
        })
        .catch(reportIpcError('terminal.terminalInput'))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const idx = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(idx)
      setInput(history[history.length - 1 - idx] ?? '')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const idx = Math.max(historyIndex - 1, -1)
      setHistoryIndex(idx)
      setInput(idx === -1 ? '' : history[history.length - 1 - idx] ?? '')
      return
    }
  }

  return (
    <div className="flex flex-col h-full gap-2">
      <pre
        ref={preRef}
        className="flex-1 min-h-0 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs font-mono whitespace-pre-wrap break-all"
      >
        {stripAnsi(output)}
        {clipped && <p className="text-[var(--color-text-muted)] italic">{t('terminal.outputTruncated')}</p>}
        {error && (
          <span className="text-red-400">{error}</span>
        )}
      </pre>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-[var(--color-text-muted)] font-mono shrink-0">
          {running ? '>' : '×'}
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!running}
          placeholder={running ? t('terminal.inputPlaceholder') : t('terminal.notRunning')}
          className="flex-1 bg-transparent outline-none text-sm font-mono text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
        />
        <button
          type="button"
          onClick={() => void sendInput('\x03').catch(reportIpcError('terminal.terminalInput'))}
          disabled={!running}
          title={t('terminal.sendCtrlC')}
          className="px-2 py-1 text-[10px] rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Ctrl+C
        </button>
      </div>
    </div>
  )
}
