// 导入结果审计的纯写入口：不 import dbService/database，避免把 Electron 依赖链带进
// skill-io / mcp-import-service 的纯逻辑测试。真正的仓储在启动时注入。
export type ImportResultKind = 'skill' | 'mcp'
export type ImportResultSource = 'file' | 'folder' | 'url' | 'paste'
export type ImportChecksumState = 'verified' | 'absent' | 'mismatch' | 'unsupported' | ''

export interface ImportResultAuditInput {
  kind: ImportResultKind
  source: ImportResultSource
  sourceDetail?: string
  checksum?: ImportChecksumState
  ok: boolean
  errorCode?: string
  importedCount?: number
  failedCount?: number
  clearedKeyCount?: number
}

export interface ImportResultAuditRecord {
  id: string
  kind: ImportResultKind
  source: ImportResultSource
  sourceDetail: string
  checksum: ImportChecksumState
  ok: boolean
  errorCode: string
  importedCount: number
  failedCount: number
  clearedKeyCount: number
  createdAt: number
}

export interface ImportResultAuditWriter {
  insert(input: ImportResultAuditInput): boolean
}

let writer: ImportResultAuditWriter | null = null

/** 主进程启动时注入真实仓储；未注入时（纯逻辑测试/启动早期）一律 no-op */
export function setImportResultAuditWriter(next: ImportResultAuditWriter | null): void {
  writer = next
}

/** 仅供测试复位 */
export function resetImportResultAuditWriterForTest(): void {
  writer = null
}

/** 审计是旁路：写失败不抛，返回 false 让调用方可以忽略 */
export function recordImportResult(input: ImportResultAuditInput): boolean {
  if (!writer) return false
  try {
    return writer.insert(input)
  } catch {
    return false
  }
}
