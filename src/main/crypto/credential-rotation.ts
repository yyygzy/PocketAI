// 字段级凭据的密钥轮换伴生工具
//
// 主密码启用（none→db）、禁用（db→none）、改密（db→db）会改变字段密钥
// （master-key.ts：db 模式=主密码派生密钥，none 模式=固定混淆密钥）。
// 所有字段级密文（KV 密钥类配置、Provider apiKeys、MCP env/headers）必须在「旧密钥仍可用时」
// 导出明文、在「新密钥生效且 DB 重开后」重新加密，否则凭据会静默失效。
//
// 用法（四个切换点同构）：
//   const snapshot = exportFieldCredentials()  // 旧 key 下
//   ... setKey/rekey/重开 DB ...
//   restoreFieldCredentials(snapshot)          // 新 key 下
//
// 注意：WebDAV 备份密码另有独立存储（backup-service 配置文件），
// 由各 IPC 流程自行捕获/恢复，不在本模块范围。

import { providerRepo } from '../db/repositories/provider.repo'
import { mcpServerRepo } from '../db/repositories/mcp-server.repo'
import { exportSecrets, restoreSecrets } from './secret-store'
import { createLogger } from '../logger'

const log = createLogger('crypto')

export interface McpSecretSnapshot {
  env: Record<string, string>
  headers: Record<string, string>
}

export interface FieldCredentialSnapshot {
  kv: Record<string, string>
  providers: Record<string, string[]>
  /** MCP Server 的 env/headers（stdio 环境变量与 http 鉴权头，同为字段级密文） */
  mcp: Record<string, McpSecretSnapshot>
  /** §375：有密文但旧字段密钥解不开的条目 id/键（不进快照＝保持原密文不动，交给调用方如实上报，绝不当「没配过」悄悄丢） */
  undecryptable: string[]
}

/** 旧字段密钥仍可用时调用：导出全部字段级凭据明文（仅进程内存，不落盘） */
export function exportFieldCredentials(): FieldCredentialSnapshot {
  const kv = exportSecrets()
  const providers = providerRepo.exportAllApiKeys()
  const mcp = mcpServerRepo.exportAllSecrets()
  return {
    kv: kv.snapshot,
    providers: providers.snapshot,
    mcp: mcp.snapshot,
    undecryptable: [...kv.undecryptable, ...providers.undecryptable, ...mcp.undecryptable]
  }
}

/** 新字段密钥已生效、DB 已重开后调用：用新密钥重加密并落盘；解不开的条目只留痕不重写（其旧钥密文原地保留） */
export function restoreFieldCredentials(snapshot: FieldCredentialSnapshot): void {
  restoreSecrets(snapshot.kv)
  providerRepo.restoreAllApiKeys(snapshot.providers)
  mcpServerRepo.restoreAllSecrets(snapshot.mcp ?? {})
  if (snapshot.undecryptable?.length) {
    log.warn(
      `凭据轮换：${snapshot.undecryptable.length} 项凭据有密文但旧字段密钥解不开（不匹配或损坏），已跳过未重写、需手动重填：${snapshot.undecryptable.join(', ')}`
    )
  }
}
