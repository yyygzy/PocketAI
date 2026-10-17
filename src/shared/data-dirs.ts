// Electron 运行时写进便携数据目录（DATA_DIR）里的两棵 Chromium 档案树的名字。
//
// 只有一个出处：`src/main/index.ts` 拿它拼 `app.setPath('userData'|'sessionData')`，
// 数据健康探测拿它判"这块盘上的缓存在哪儿、有多大"。写第二份字符串就是等着哪天改名时两边不一致。
//
// 为什么数据健康要把它们单列：实测本机这两棵树 21,103 个文件 / 801 MB（`Cache/`、`Code Cache/`、
// `DawnGraphiteCache/`、`blob_storage/`、`DIPS`……），而真正算"用户数据资产"的部分只有几 MB。
// 它们既不该进「数据合计」，也不该每次打开面板都递归一遍（台账 V4-Iter-177）。
export const USER_DATA_DIR_NAME = 'userdata'
export const SESSION_DATA_DIR_NAME = 'session'

export const BROWSER_PROFILE_DIR_NAMES: readonly string[] = [USER_DATA_DIR_NAME, SESSION_DATA_DIR_NAME]

/** DATA_DIR 相对路径（\ 或 / 都接受）是否落在浏览器档案树里 */
export function isBrowserProfilePath(rel: string): boolean {
  const top = rel.replaceAll('\\', '/').split('/')[0] ?? ''
  return BROWSER_PROFILE_DIR_NAMES.includes(top)
}
