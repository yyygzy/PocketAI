// §342：加密态在渲染层是一份副本，副本必须在「用到它的那一刻」重取。
//
// 为什么不能只在挂载时读一次（实测过的后果）：向导里设完主密码、或设置页关掉加密，
// 主进程的 mode 当场就变了，而 App.tsx／DetachedApp.tsx 各自的 dbEncrypted 还停在挂载那次的值
// ⇒ 锁屏遮罩按旧值渲染：数据已加密却写「未设主密码：数据仍是明文…不需要任何凭据即可放行」，
// 那颗「继续（无需密码）」点下去主进程回「密码错误」，而且 lock.ts 对空口令同样记一次失败
// ⇒ 用户在"照屏上说的做"的同时把自己的 SEC-10 解锁额度点光。
//
// 这份文件是"主进程加密态的读者"唯一的落值处：
// - createEncryptionFlagSyncer＝两个窗口各自那份布尔旗标（遮罩只看 dbEncrypted）；
// - createEncryptionStatusSyncer＝设置页那一整块 EncryptionStatus（§344，面板要 kdf／unlocked 等字段）。
// 两边都判代次：晚到的旧响应不许顶掉新一次读的结果。
import { hasIpcFailed, ipcFailText, logIpcError } from './ipc'
import { errText } from './error'
import type { EncryptionStatus } from '../../../shared/types'

export interface EncryptionFlagDeps {
  setDbEncrypted: (v: boolean) => void
  setEncReadErr: (v: string | null) => void
  /** §343：副本的"知不知道"与"在不在飞"——遮罩要靠这两个值区分「正在确认」与「确实没加密」 */
  setEncKnown: (v: boolean) => void
  setEncPending: (v: boolean) => void
  t: (k: string) => string
}

/**
 * 读一次主进程的加密态并写回本窗口的副本。
 * 失败侧**只报错、不动旧值**：旧值可能是 false，把它写成 false 等于替用户宣布"数据是明文"，
 * 但把 known 打成 false 是诚实的——屏上不知道，就该说"正在确认／读不到"。
 */
export function createEncryptionFlagSyncer(deps: EncryptionFlagDeps): () => Promise<void> {
  let gen = 0
  return async () => {
    const my = ++gen
    deps.setEncPending(true)
    const s = await window.pocketai.getEncryptionStatus()
    // 期间又按了一次锁屏事件 ⇒ 这一发是旧读数，pending 由最新那发自己收尾
    if (my !== gen) return
    deps.setEncPending(false)
    if (hasIpcFailed(s)) {
      deps.setEncKnown(false)
      deps.setEncReadErr(ipcFailText(s, deps.t('common.unknownError')))
      return
    }
    deps.setEncKnown(true)
    deps.setEncReadErr(null)
    deps.setDbEncrypted(s.dbEncrypted)
  }
}

export interface EncryptionStatusSyncDeps {
  setStatus: (v: EncryptionStatus) => void
  setErr: (v: string | null) => void
  t: (k: string) => string
}

/**
 * §344：同一份「主进程加密态」在设置页是**整块** `EncryptionStatus`，而且有三个读者——
 * 挂载首发、锁屏事件重读、面板动作（启用／改口令／关闭／锁定）后刷新。
 * 各写各的时，谁先落地没有保证：锁屏事件那一发若在「关掉加密」之后才回来，
 * 就把已经变明文的面板画回「已加密＋已解锁」，那格上还会给出改口令／关闭加密两颗键。
 * 所以三发共用一份带代次守卫的同步器（口径同 §342：只有最新那一发能写回）。
 * 失败侧依旧**只报错、不动旧值**——读不到不等于"没加密"。
 */
export function createEncryptionStatusSyncer(deps: EncryptionStatusSyncDeps): () => Promise<void> {
  let gen = 0
  return async () => {
    const my = ++gen
    try {
      const s = await window.pocketai.getEncryptionStatus()
      if (my !== gen) return
      if (hasIpcFailed(s)) {
        deps.setErr(ipcFailText(s, deps.t('common.unknownError')))
        return
      }
      deps.setErr(null)
      deps.setStatus(s)
    } catch (e) {
      if (my !== gen) return
      deps.setErr(errText(e, deps.t('common.unknownError')))
      logIpcError('lock-flags.getEncryptionStatus', e)
    }
  }
}
