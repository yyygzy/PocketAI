// 「云端最新那一份」的唯一派生入口（§327 的渲染层三处 + §338 的主进程校验任务）
//
// mtime 允许是 NaN，两条路都能走到：WebDAV 的 GetLastModified 有「空元素」「带属性元素」两种合法
// 形状（§327 探针），而兜底的包名时间戳也可能读不出来（手放的 `pocketai-backup.zip` 没有日期，
// 越界的月／日一律拒）。一条 NaN 参与 sort 比较会被折成 +0（＝与谁都相等），整表顺序就交给服务器
// 返回顺序——探针实测 NaN 那份既能排到第 0 位，也能把真正的最新那份挤下去。
// 所以这里既不用排序也不用 Math.max：先剔掉判不出时间的一份，再 reduce 取最大。

/** 剔掉「时间判不出来」的一份后取 mtime 最大的那份；一份都判不出来时回 null（不返回「随便一份」） */
export function pickLatestBackup<T extends { mtime: number }>(files: T[]): T | null {
  const known = files.filter((f) => Number.isFinite(f.mtime))
  if (known.length === 0) return null
  return known.reduce((a, b) => (b.mtime > a.mtime ? b : a))
}

/**
 * 「从新到旧」的同一份顺序口径（§353）：与上面那条同源，但服务对象不同——`pickLatestBackup` 管"哪一份是最新"，
 * 这一条管**整张列表怎么排**。判不出时间的那一份一律沉底（它没有资格占"最新在上"那一行），
 * 两份都判不出时保持进来那一序（V8 的 sort 稳定，所以这不是"看起来随机"，而是"不假装知道先后"）。
 * 判不出的那份不许参与减法：`b.mtime - a.mtime` 一遇到 NaN 就返回 NaN ⇒ 引擎按"相等"处理，
 * 整表顺序悄悄交给服务器返回顺序——§353 现测（`data/tmp/probe-353-nan.mjs`）同一批四份、两种返回顺序排出**两种**脸：
 * A 序把最旧那份摆上"最新在上"那一行，B 序让判不出那份夹在中间。
 */
export function sortBackupsNewestFirst<T extends { mtime: number }>(files: T[]): T[] {
  return files
    .slice()
    .sort((a, b) => {
      const ka = Number.isFinite(a.mtime)
      const kb = Number.isFinite(b.mtime)
      if (ka !== kb) return ka ? -1 : 1
      return ka && kb ? b.mtime - a.mtime : 0
    })
}
