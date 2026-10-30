// scripts/ui-verify-launch.mjs 的类型面（.mjs 不参与 tsc 检查，但用例要 import 它，
// 所以手写一份 .d.mts 让类型对得上——这份只声明判据函数，不声明 CLI 那半）。
export interface PreflightResult {
  ok: boolean
  errors: string[]
  abs?: string
  dataDir?: string
}

export function preflight(root: string | undefined, port: string | number | undefined): PreflightResult

/** 读 `DevToolsActivePort`：`port` 非空＝读到了；否则 `error` 留着最后一次失败原因（V4-Iter-366） */
export interface CdpPortResult {
  port: string | null
  error: string | null
}

export function readCdpPort(fsLike: { readFileSync: (p: string, enc: string) => unknown }, portFile: string): CdpPortResult
