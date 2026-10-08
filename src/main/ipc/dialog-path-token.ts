// 主进程文件对话框选中路径的一次性令牌
//
// 为什么需要（SEC-6）：跨阶段复用「用户刚选的文件」时，若让渲染端回传**绝对路径**，
// 该通道就变成「渲染端可指定任意路径让主进程读并写进应用状态」——注入脚本一次调用
// 即可用旧备份整库替换。令牌把「路径」换成主进程自己签发、渲染端无法伪造引用的句柄：
// 只有走过本进程对话框选中的路径才存在对应令牌，且带 TTL 与容量上限。
//
// peek 不消费（密码重试可能连续失败多次仍需同一份文件），成功/放弃时显式 drop。
import { randomUUID } from 'node:crypto'

const TOKEN_TTL_MS = 10 * 60 * 1000
/** 同时存活的令牌上限（正常用量远小于此，只为防被滥用成无限缓存） */
const MAX_TOKENS = 20

const store = new Map<string, { path: string; at: number }>()

function pruneExpired(now: number): void {
  for (const [token, entry] of store) {
    if (now - entry.at > TOKEN_TTL_MS) store.delete(token)
  }
}

/** 签发令牌：返回随机句柄，路径只留在主进程内存 */
export function issuePathToken(path: string): string {
  const now = Date.now()
  pruneExpired(now)
  // 容量兜底：Map 迭代按插入序，超限时淘汰最旧
  while (store.size >= MAX_TOKENS) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
  const token = randomUUID()
  store.set(token, { path, at: now })
  return token
}

/** 取回令牌对应的路径；未知/过期返回 null（不消费，供重试复用） */
export function peekPathToken(token: string | null | undefined): string | null {
  if (!token) return null
  const entry = store.get(token)
  if (!entry) return null
  if (Date.now() - entry.at > TOKEN_TTL_MS) {
    store.delete(token)
    return null
  }
  return entry.path
}

/** 流程走完（成功或用户放弃）后撤销令牌 */
export function dropPathToken(token: string | null | undefined): void {
  if (token) store.delete(token)
}

/** 测试用：清空全部令牌 */
export function resetPathTokensForTest(): void {
  store.clear()
}
