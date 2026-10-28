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
