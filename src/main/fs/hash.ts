// sha256 单一实现：备份/变更清单等共用。
// 独立成模是为了让引擎侧（变更清单）能用哈希而不必顺着 backup-service 把
// archiver/unzipper/DB/密钥管理整条依赖链拉进主进程启动路径。
import { createHash } from 'node:crypto'

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
