// @vitest-environment jsdom
// V4-Iter-342：加密态副本的同步器（App.tsx 与 DetachedApp.tsx 共用这一份）
//
// 三条判据都要有牙：
// ① 读成功 ⇒ 写回主进程那份 dbEncrypted，并把「读不到」那句收回；
// ② 读失败（信封 {ok:false}）⇒ 只报错、**不动旧值**——把旧值刷成 false 等于替用户宣布"数据是明文"；
// ③ 迟到对照 ⇒ 连点两次锁屏事件时，先出发后回来的那一发不许顶掉后出发那发的结果。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { stubPocketai } from './helpers/renderer'
import { createEncryptionFlagSyncer } from '../src/renderer/src/utils/lock-flags'

const t = (k: string): string => `t:${k}`

describe('createEncryptionFlagSyncer', () => {
  let setDbEncrypted: ReturnType<typeof vi.fn>
  let setEncReadErr: ReturnType<typeof vi.fn>
  let deps: { setDbEncrypted: any; setEncReadErr: any; t: typeof t }

  beforeEach(() => {
    setDbEncrypted = vi.fn()
    setEncReadErr = vi.fn()
    deps = { setDbEncrypted, setEncReadErr, t }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('读成功：写回 true 并收回「读不到」', async () => {
    stubPocketai({ getEncryptionStatus: () => ({ dbEncrypted: true }) })
    await createEncryptionFlagSyncer(deps)()
    expect(setDbEncrypted).toHaveBeenCalledWith(true)
    expect(setEncReadErr).toHaveBeenCalledWith(null)
  })

  it('读失败：只报错，旧值一个字都不许被刷掉', async () => {
    stubPocketai({ getEncryptionStatus: () => ({ ok: false, error: 'boom' }) })
    await createEncryptionFlagSyncer(deps)()
    expect(setEncReadErr).toHaveBeenCalledWith('boom')
    expect(setDbEncrypted, '失败侧不许把副本写成 false（那等于宣布"数据是明文"）').not.toHaveBeenCalled()
  })

  it('迟到对照：先出发后回来的那一发不许顶掉新读数', async () => {
    const resolvers: Array<(v: unknown) => void> = []
    stubPocketai({
      getEncryptionStatus: () => new Promise((resolve) => { resolvers.push(resolve) })
    })
    const sync = createEncryptionFlagSyncer(deps)
    const first = sync()
    const second = sync()
    // 后发先至：第二发回来 ⇒ 写 true
    const secondResolve = resolvers[1]!
    secondResolve({ dbEncrypted: true })
    await second
    expect(setDbEncrypted).toHaveBeenLastCalledWith(true)
    // 第一发现在才回来 ⇒ 它是旧读数，必须被丢掉
    const firstResolve = resolvers[0]!
    firstResolve({ dbEncrypted: false })
    await first
    expect(setDbEncrypted, '旧那一发不许再写回').not.toHaveBeenCalledWith(false)
    expect(setDbEncrypted).toHaveBeenCalledTimes(1)
  })
})
