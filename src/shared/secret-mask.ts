// 密钥掩码与回填（纯函数，不依赖 electron）
//
// 背景：列表类 IPC 不应把凭据明文交给渲染层（渲染层一旦被注入即可批量导出）。
// 约定：
// - 出 IPC 的值统一掩码为 `••••` + 末 4 位；
// - 保存时输入值若等于掩码形态，主进程按「未修改」处理，回填原值（数组按下标、映射按 key）。
// 因此渲染层可以：删行/删键（真正删除）、新增真实值、改写真值，而无需先拿到明文。
//
// 取舍：以 `••••` 开头的真实密钥会被当作占位符丢弃。API Key / Token 均为 ASCII，
// 实际不可能出现该前缀；若将来支持非 ASCII 密钥需改为不透明句柄方案。

/** 掩码前缀：同时是「未修改」哨兵 */
export const SECRET_MASK_PREFIX = '••••'
/** 掩码后仍展示的尾部字符数（便于在多个 Key 间辨认，不足以被利用） */
const VISIBLE_TAIL = 4

/** 掩码单个值：空串原样返回（不产生伪占位，避免回填歧义） */
export function maskSecret(value: string): string {
  const v = String(value ?? '')
  if (!v) return ''
  const tail = v.length > VISIBLE_TAIL ? v.slice(-VISIBLE_TAIL) : ''
  return `${SECRET_MASK_PREFIX}${tail}`
}

/** 是否为掩码占位值（保存侧据此判断「用户未改动该项」） */
export function isMaskedSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.startsWith(SECRET_MASK_PREFIX) && value.length <= SECRET_MASK_PREFIX.length + VISIBLE_TAIL
}

/** 映射整体掩码（env / headers） */
export function maskSecretMap(map: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map ?? {})) out[k] = maskSecret(v)
  return out
}

/**
 * 保存回填（映射）：占位值取原值；原值不存在（新增键却被填了占位符）时丢弃该键。
 * 键的删除语义保持不变——输入里没有的键即视为删除。
 */
export function restoreMaskedMap(
  incoming: Record<string, string> | null | undefined,
  existing: Record<string, string> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(incoming ?? {})) {
    if (isMaskedSecret(v)) {
      const prev = (existing ?? {})[k]
      if (prev) out[k] = prev
    } else {
      out[k] = v
    }
  }
  return out
}

/** 数组整体掩码（Provider apiKeys） */
export function maskSecretList(values: string[] | null | undefined): string[] {
  return (values ?? []).map((v) => maskSecret(v))
}

/**
 * 保存回填（数组）：按下标把占位值还原为原值；越界的占位值（无对应原值）丢弃。
 * 顺序调整在掩码视图下不可辨认，视为用户主动重排，按下标还原即可。
 */
export function restoreMaskedList(
  incoming: string[] | null | undefined,
  existing: string[] | null | undefined
): string[] {
  const prev = existing ?? []
  return (incoming ?? [])
    .map((v, i) => (isMaskedSecret(v) ? prev[i] ?? '' : v))
    .filter((v) => v.length > 0)
}
