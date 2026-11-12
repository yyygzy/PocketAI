// 主进程 ↔ 渲染层的版本握手（V4-Iter-475）
//
// 要治的现场：dev 下主进程可能几天没重启，渲染层走 HMR 拿到新界面，于是每个新通道各报一句
// `No handler registered for 'agent:get-tool-surface'`。这类故障的共同点是「界面认识的通道，
// 主进程不认」，所以握手证据不取版本号（dev 下版本号根本不变），而取**两边各自编译进包的通道常量表**：
// 主进程回它这份包里认识的全部通道值，渲染层拿自己这份做差集，缺的通道就是「主进程比界面旧」的直接证据。
//
// 口径：只做诊断，不参与路由与权限。通道清单是 `IPC` 常量表，不是 handler 注册表——
// 它证明的是「主进程这个包有多新」，而不是「某个 handler 一定注册成功了」（那条仍由真实调用暴露）。
import { IPC } from './types'

export interface MainHandshakeReply {
  /** 构建标识：`<应用版本>+<主进程模块加载时刻>`，用来在日志里区分「到底重启过没有」 */
  buildId: string
  /** 主进程模块加载时刻（ms）；重启会变，同一进程内恒定 */
  startedAt: number
  /** 主进程这份包认识的 IPC 通道值（去重、排序；非字符串值一律不收） */
  channels: string[]
}

/** 本进程这份包认识的通道清单（main 与 renderer 各自编译，天然可以互相作证） */
export function handshakeChannelList(): string[] {
  // `IPC` 是 `as const` 的字面量联合：先落到 string[] 再处理，避免类型谓词与字面量类型打架
  const all: readonly string[] = Object.values(IPC)
  return [...new Set(all)].sort()
}

/** 期望清单里有、对方没报的通道（空数组＝两边对齐） */
export function missingChannels(expected: readonly string[], reported: readonly string[]): string[] {
  const have = new Set(reported)
  return expected.filter((c) => !have.has(c))
}
