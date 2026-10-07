import React, { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'

const MAX_OUTPUT = 50000
const KEEP_OUTPUT = 40000

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
  const preRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let unsub: (() => void) | undefined
    let mounted = true

    const start = async () => {
      const r = await window.pocketai.startTerminal()
      if (!mounted) return
      if (!r.ok) {
        setError(r.error ?? t('terminal.startFailed'))
        return
      }
      setRunning(true)
      setError(null)
      unsub = window.pocketai.onTerminalOutput((payload) => {
        if (!mounted) return
        if (payload.stream === 'exit') {
          setRunning(false)
        }
        setOutput((prev) => {
          const next = prev + payload.data
          if (next.length > MAX_OUTPUT) {
            return next.slice(-KEEP_OUTPUT)
          }
          return next
        })
      })
    }

    void start()

    return () => {
      mounted = false
      if (unsub) unsub()
      window.pocketai.killTerminal().catch(() => { /* ignore */ })
    }
  }, [t])

  useEffect(() => {
    const el = preRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [output])

  const sendInput = (data: string) => {
    if (!running) return
    window.pocketai.terminalInput(data).catch(() => { /* ignore */ })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!input) return
      sendInput(input + '\r\n')
      setHistory((prev) => {
        const next = prev.filter((h) => h !== input)
        next.push(input)
        if (next.length > 200) next.shift()
        return next
      })
      setInput('')
      setHistoryIndex(-1)
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
          onClick={() => sendInput('\x03')}
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
