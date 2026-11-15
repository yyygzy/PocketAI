// 版本号比较（便携版「有没有新版本」只用这一条口径）
//
// 只比数字段：`v1.10.0` > `1.9.9`，缺省段按 0 补；预发布后缀（-beta.1）不参与比较
// （便携版走的是 GitHub Releases 的正式版，比较够用，也不为此引 semver 依赖）。
export function compareVersionStrings(a: string, b: string): number {
  const parse = (raw: string): number[] => {
    const core = raw.trim().replace(/^v/i, '').split('-')[0] ?? ''
    return core.split('.').map((seg) => {
      const n = Number.parseInt(seg, 10)
      return Number.isFinite(n) ? n : 0
    })
  }
  const left = parse(a)
  const right = parse(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}
