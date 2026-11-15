// 本地备份目录清单（首页「最近一次备份」与「有备份才给恢复入口」的唯一来源）
//
// 只认 createLocalBackup / createEncryptedLocalBackup 落下的包名形状：
//   pocketai-backup-<时间戳>.zip / .enc.zip
// 目录不存在＝真的没备份过（返回 []，那是真话）；其他读失败往上抛，由 IPC 层回失败信封，
// 免得把「读不到」演成「一份备份都没有」。
import fs from 'node:fs'
import path from 'node:path'
import type { LocalBackupEntry } from '../../shared/types'

const BACKUP_NAME_RE = /^pocketai-backup-.+\.zip$/

export function listLocalBackups(dir: string): LocalBackupEntry[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: LocalBackupEntry[] = []
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue
    try {
      const st = fs.statSync(path.join(dir, name))
      if (!st.isFile()) continue
      out.push({ name, mtime: st.mtimeMs, size: st.size, encrypted: name.endsWith('.enc.zip') })
    } catch {
      // 单个文件读不到（正被写、刚被删）→ 跳过；不让一份坏文件拖垮整张清单
    }
  }
  // 最新在前：首页只读第一条；时间判不出来的排在后面（与 WebDAV 清单同一取向）
  return out.sort((a, b) => b.mtime - a.mtime)
}
