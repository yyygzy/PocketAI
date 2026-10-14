// 重复入库拦在入口：同一个库里，同一路径或同一内容指纹的文件不再建第二份文档。
//
// 为什么拦在这里而不是入库途中：那时文档行已经 insert、解析已经开始，撞出重复要么留一个
// 「用户刚加进去却凭空消失」的孤儿行，要么给 kb_documents 加一个界面不认识的新状态。
// 拦在入口则能当场给用户一句「导入 N 篇，跳过 M 篇重复」，而且解析与 embedding 一次都不花。
//
// 手工录入的文本（sourceType='txt'）不走这里：它的 source 存的是标题，
// 「同标题」远不等于「同内容」，而它既没有文件 IO 也没有解析成本，误拦的代价比漏拦大。
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { hashFile } from './sync-check'

export interface FileIngestPlan {
  /** 允许入库的路径（保持用户选择的顺序） */
  accepted: string[]
  /** 同库已有同一路径，或本次选择里自身就重复 */
  skippedSameSource: number
  /** 路径不同但内容与库里已索引过的（或本批内前面的）某篇完全一致 */
  skippedSameContent: number
}

/**
 * 计划一次文件导入：去掉重复来源与重复内容。
 *
 * 内容指纹靠 `hashFile` 逐个算（流式读盘，不并发：一次文件夹导入最多 500 个文件，
 * 并发会把文件句柄与主进程 CPU 一起顶上去）。**算不出指纹的文件直接放行**——
 * 读不到文件是权限/已删除的问题，该由入库那步报真错，不该被冒充成「重复」。
 */
export async function planFileIngest(kbId: string, paths: string[]): Promise<FileIngestPlan> {
  const seenSource = new Set<string>()
  const bySource: string[] = []
  let skippedSameSource = 0
  for (const p of paths) {
    if (seenSource.has(p)) {
      skippedSameSource++
      continue
    }
    seenSource.add(p)
    bySource.push(p)
  }
  const existingSources = kbDocRepo.existingSources(kbId, bySource)
  const candidates = bySource.filter((p) => {
    if (existingSources.has(p)) {
      skippedSameSource++
      return false
    }
    return true
  })

  const hashes = new Map<string, string>()
  for (const p of candidates) {
    try {
      hashes.set(p, await hashFile(p))
    } catch {
      // 读不到内容：不拦，交给入库去报错
    }
  }
  const existingHashes = kbDocRepo.existingHashes(kbId, [...hashes.values()])
  const seenHash = new Set<string>()
  const accepted: string[] = []
  let skippedSameContent = 0
  for (const p of candidates) {
    const h = hashes.get(p)
    if (h && (existingHashes.has(h) || seenHash.has(h))) {
      skippedSameContent++
      continue
    }
    if (h) seenHash.add(h)
    accepted.push(p)
  }

  return { accepted, skippedSameSource, skippedSameContent }
}
