// 更新期高水位（本机记录）
//
// 目的：许可证被清除、license.lic 丢失或重装应用后，更新门控不能退回免费态。
// 把「这台机器上曾经获得过的最晚更新期」单独记在应用数据目录里，
// 与 license.lic 相互独立：清除许可证只删 license.lic，不动这份记录。
//
// 口径：
// - 有效更新期 = max(许可证自带的更新期, 本机高水位)；两者都没有 = 无更新期限制（免费版）。
// - 只在许可证验签通过（且设备绑定匹配）时抬高；免费用户没有许可证，不写、不提示。
// - 只抬不降：后续换到更新期更早的许可证，不能把水位拉回去。
// - 写入的是签名里的绝对时间戳，不参与本地时钟运算；因此时钟回拨不会把水位改小或改大。
// - 记录是本地状态，用户删掉应用数据就会重置——文案按这个实际能力描述，不宣称「无法绕过」。
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/** 记录文件名（落在 app.getPath('userData') 下，与 DATA_DIR/license.lic 分离） */
const WATERMARK_FILE = 'license-updates.json'

// 合理时间范围：早于 2000 年或晚于 2100 年的时间戳视为坏值。
// 2100 的上界覆盖「永久买断（2099-12-31）」，又能挡住文件损坏/被改成 1e15 之类的永久放行。
const MIN_VALID_TS = Date.UTC(2000, 0, 1)
const MAX_VALID_TS = Date.UTC(2100, 0, 1)

/** 是否为可信的更新时间戳（有限数且在合理区间内） */
export function isValidUpdatesUntil(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_VALID_TS &&
    value <= MAX_VALID_TS
  )
}

/** 默认记录路径；拿不到 userData（测试/异常环境）时返回 null = 不落盘 */
export function resolveUpdatesWatermarkPath(): string | null {
  try {
    const dir = app.getPath('userData')
    return dir ? path.join(dir, WATERMARK_FILE) : null
  } catch {
    return null
  }
}

/**
 * 读取高水位。
 * 文件不存在 / JSON 损坏 / 字段类型不对 / 超出合理区间 → 一律当作「没有记录」，
 * 不因为一个坏值永久拦更新，也不让 Infinity、超大数永久放行。
 */
export function readUpdatesWatermark(filePath: string | null = resolveUpdatesWatermarkPath()): number | null {
  if (!filePath) return null
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { updates_until?: unknown }
    return isValidUpdatesUntil(raw?.updates_until) ? raw.updates_until : null
  } catch {
    return null
  }
}

/**
 * 抬高水位（只增不减）。value 非法时原样返回现有水位，不覆盖、不清空。
 * 返回抬高后的水位；没有可信值时返回 null。
 */
export function raiseUpdatesWatermark(
  value: unknown,
  filePath: string | null = resolveUpdatesWatermarkPath()
): number | null {
  const current = readUpdatesWatermark(filePath)
  if (!isValidUpdatesUntil(value)) return current
  if (current !== null && current >= value) return current
  if (!filePath) return value // 无法落盘时至少让本次运行按新水位判定
  try {
    const tmp = filePath + '.tmp'
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updates_until: value }, null, 2), 'utf8')
    fs.renameSync(tmp, filePath)
  } catch {
    // 写入失败（磁盘满/无权限）不阻塞授权流程：本次运行仍按 value 返回，下次启动再尝试
  }
  return value
}

/**
 * 有效更新期 = max(许可证更新期, 本机高水位)。
 * - 都没有 → undefined（免费版，不限制更新）
 * - 许可证值必须是有限数；record 侧已做区间校验
 */
export function effectiveUpdatesUntil(
  licenseUpdatesUntil: number | undefined,
  filePath: string | null = resolveUpdatesWatermarkPath()
): number | undefined {
  const watermark = readUpdatesWatermark(filePath)
  const licensed =
    typeof licenseUpdatesUntil === 'number' && Number.isFinite(licenseUpdatesUntil)
      ? licenseUpdatesUntil
      : undefined
  if (watermark === null) return licensed
  if (licensed === undefined) return watermark
  return Math.max(watermark, licensed)
}
