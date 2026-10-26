// 终端 session 登记表按身份删除测试（V4-Iter-306）＋ 每一轮 shell 的轮次号（V4-Iter-320）
//
// 缺陷：terminal-service 的 proc.on('exit') 回调写死 `sessions.delete(ownerId)`——按 key 删、不认是哪个 proc。
// startTerminal 重开同一窗口时顺序是：killTerminal(旧)→sessions.set(新) 先就位，旧 proc 的 'exit' 是异步、
// 通常在新 session 登记之后才到 ⇒ 旧回调把**新** session 的登记连带删掉 ⇒ 新 shell 进程成孤儿，
// killTerminal/killAllTerminals 都循不到它 ⇒ 退出应用仍留一个活的交互 shell。
// 修法：exit 回调只在 `sessions.get(ownerId)?.proc === proc`（本 proc 仍是当前登记的那个）时才删。
// 仓里 chat-service.ts:169 的 withConversationLock 正是同款身份守卫，这里此前漏了。
//
// 观测：不读私有 sessions，用公开 API 的下游后果判——修前新 session 被误删 ⇒ killAllTerminals 收不到它（B.kill 不被调）；
// 修后仍在表里 ⇒ killAllTerminals 杀得到（B.kill 被调）。假 spawn 返回可控 EventEmitter，手动 emit('exit') 定时序。
//
// §320 在同一套假 spawn 上加的是**生产者那一半**：重开同一窗口时每一轮 shell 要有一个自己的轮次号，
// 而且"回复给渲染端的那个号"与"这一轮的每一帧带的那个号"必须出自同一个数——渲染端那一圈
// `if (p.epoch !== epoch) return` 只对得上号才有牙（消费面在 tests/terminal-frame-epoch-320.test.tsx）。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { destroyed: boolean; write: (d: string) => void }
  kill: ReturnType<typeof vi.fn>
}

const procs: FakeProc[] = []

vi.mock('node:child_process', () => ({
  spawn: () => {
    const p = new EventEmitter() as FakeProc
    p.stdout = new EventEmitter()
    p.stderr = new EventEmitter()
    p.stdin = { destroyed: false, write: () => {} }
    p.kill = vi.fn()
    procs.push(p)
    return p
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

// 隔离终端工具的分类器依赖链（本用例不走 inputTerminal，仅为让模块能加载）
vi.mock('../src/main/tools/shell-tools', () => ({
  classifyDenyOnly: () => null
}))

import { startTerminal, killAllTerminals } from '../src/main/terminal/terminal-service'

const mkWc = (id: number): WebContents =>
  ({
    id,
    isDestroyed: () => false,
    send: () => {}
  }) as unknown as WebContents

beforeEach(() => {
  procs.length = 0
})

describe('§306 终端 exit 回调按身份删，重开同窗口不误删新 session', () => {
  it('重开同窗口：旧 shell 迟到的 exit 不该把新 session 从登记表删掉（否则新 shell 成孤儿、killAll 收不到）', () => {
    const wc = mkWc(7)
    startTerminal(wc) // A
    const A = procs[0]!
    startTerminal(wc) // 重开 ⇒ killTerminal(A)＋set(B)
    const B = procs[1]!
    expect(A.kill, '重开确实先杀了旧 A').toHaveBeenCalledTimes(1)
    // B 已就位，此时旧 A 的 exit 才迟到
    A.emit('exit', 0)
    // 修前：这一句会删掉 B 的登记；修后：身份守卫 ⇒ 不动 B
    killAllTerminals()
    expect(B.kill, 'B 必须仍被登记、能被 reap（修前成孤儿、不会被 kill）').toHaveBeenCalledTimes(1)
  })

  it('正向对照：一次正常退出（没有重开）⇒ 自己那条确实被摘，killAll 不该再杀', () => {
    const wc = mkWc(9)
    startTerminal(wc) // 只有一个 A
    const A = procs[0]!
    A.emit('exit', 0)
    killAllTerminals()
    // 身份匹配 ⇒ exit 回调已删登记 ⇒ killAll 无从再杀
    expect(A.kill, '正常退出后登记已摘，killAll 不该重复杀一个已摘的').not.toHaveBeenCalled()
  })
})

interface Frame { sessionId: number; epoch: number; stream: string; data: string }

/** 记下每一帧的假窗口（真 Electron 里这一步就是 webContents.send） */
const mkRecordingWc = (id: number): { wc: WebContents; frames: Frame[] } => {
  const frames: Frame[] = []
  const wc = {
    id,
    isDestroyed: () => false,
    send: (_channel: string, payload: Frame) => { frames.push(payload) }
  }
  return { wc: wc as unknown as WebContents, frames }
}

const epochOf = (r: ReturnType<typeof startTerminal>): number => {
  if (!r.ok) throw new Error('PROBE：这一轮该起得来')
  return r.epoch
}

describe('§320 每一轮 shell 有自己的轮次号，且回复与推送同源', () => {
  it('重开同一窗口：旧 shell 迟到的 exit 带旧号、新 shell 的输出带新号（渲染端据此滤掉跨轮帧）', () => {
    const { wc, frames } = mkRecordingWc(11)
    const e1 = epochOf(startTerminal(wc)) // A
    const A = procs[0]!
    const e2 = epochOf(startTerminal(wc)) // 重开 ⇒ killTerminal(A)＋新 B
    const B = procs[1]!
    expect(e2, '两轮之间号要往前走').not.toBe(e1)

    A.emit('exit', 3) // 旧那台这时才退（§306 的那个迟到时序）
    B.stdout.emit('data', Buffer.from('PROBE-OUT'))

    const exitFrame = frames.find((f) => f.stream === 'exit')
    const outFrame = frames.find((f) => f.stream === 'stdout')
    expect(exitFrame?.epoch, '旧 shell 的退出帧要带旧轮号，不能借新号蒙进新屏').toBe(e1)
    expect(outFrame?.epoch, '新 shell 的输出帧要带新轮号').toBe(e2)
    expect(exitFrame?.sessionId, 'sessionId 仍是那一扇窗（本轮号与它是两件事）').toBe(11)
  })

  it('反向钉：startTerminal 回复里的号＝这一轮帧里的号（不是各数一遍）', () => {
    const { wc, frames } = mkRecordingWc(12)
    const replied = epochOf(startTerminal(wc))
    procs[0]!.stderr.emit('data', Buffer.from('PROBE-ERR'))
    expect(frames.find((f) => f.stream === 'stderr')?.epoch).toBe(replied)
  })
})
