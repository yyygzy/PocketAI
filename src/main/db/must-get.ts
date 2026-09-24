/**
 * 断言 getter 返回非空，否则抛错。
 * 用于 INSERT/UPDATE 后立即读取刚写入记录的场景：刚写入却读不到属于内部错误，
 * 用明确错误替代 `this.get(id)!` 的隐式崩溃。
 */
export function mustGet<T>(getter: () => T | undefined | null, label: string): T {
  const v = getter()
  if (v === undefined || v === null) {
    throw new Error(`${label} 不存在或已被删除`)
  }
  return v
}
