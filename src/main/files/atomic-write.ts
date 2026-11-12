// 原子写 + 失败归一（主进程落盘统一入口）
//
// 为什么要它：
//  · 直接 `fs.writeFileSync(用户选的路径)` 在磁盘满/权限不足/进程崩溃时会在目标位置留下**半份文件**，
//    用户拿到的是一个"看起来正常、打不开或内容被截断"的文件（§476/§477）；
//  · 原始 `ENOSPC`/`EACCES`/`EBUSY` 冒到界面等于没说人话，但**不能吞**——失败必须让用户看见。
//
// 口径：
//  · 同目录临时文件 + `rename`：rename 是原子替换，且必须同盘/同目录（跨盘 rename 会 EXDEV）；
//  · 失败时清掉临时文件，再把错误归一成一句可读文案**抛出**（由上层 safeHandle / 自己的 catch 转成 ok:false）；
//  · 临时文件后缀固定 `.pocketai-tmp`，一眼能认出是本应用留下的，便于排障与清理。
import fs from 'node:fs'
import path from 'node:path'
import { errMsg } from '../error'

/** 把落盘失败归一成一句人话（保留原始信息，不吞错误） */
export function describeWriteFailure(err: unknown, target?: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  const where = target ? `到「${path.basename(target)}」` : ''
  switch (code) {
    case 'ENOSPC':
      return `磁盘空间不足，没能写入${where}。请清理空间后重试。`
    case 'EACCES':
    case 'EPERM':
      return `没有权限写入${where}（目标可能被占用或受保护）。请换一个位置，或先关闭占用它的程序。`
    case 'EROFS':
      return `目标位置是只读的，没能写入${where}。`
    case 'EBUSY':
      return `文件正被其他程序占用，没能写入${where}。请关闭后重试。`
    case 'ENOENT':
      return `目标目录不存在，没能写入${where}。`
    case 'ENAMETOOLONG':
      return `目标路径过长，没能写入${where}。`
    case 'EEXIST':
      return `目标文件已存在且不可覆盖，没能写入${where}。`
    default:
      return `写入${where}失败：${errMsg(err)}`
  }
}

/**
 * 原子写：先写 `<target>.pocketai-tmp`，再 rename 覆盖目标。
 * 任何一步失败都不会动到原目标文件，且会清掉临时文件；错误已归一，直接往上层抛。
 */
export function writeFileAtomicSync(
  target: string,
  data: string | Buffer,
  opts?: { mode?: number }
): void {
  const tmp = `${target}.pocketai-tmp`
  try {
    if (opts?.mode !== undefined) {
      fs.writeFileSync(tmp, data, { mode: opts.mode })
    } else {
      fs.writeFileSync(tmp, data)
    }
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败可忽略：不覆盖原始错误 */
    }
    throw new Error(describeWriteFailure(err, target))
  }
}
