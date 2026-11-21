// License 授权 IPC 入参 schema
// licenseCode 进签名校验流程（CPU 面）；文件读取只允许主进程对话框签发的令牌，不再接受路径。
import { z } from 'zod'

/** 激活码 / license 原文：非空字符串，最长 4096（签名校验输入） */
export const licenseCodeSchema = z.string().min(1).max(4096, '激活码过长')

/**
 * 授权文件路径令牌（M5）：只接受主进程 `showOpenDialog` 后的 UUID 句柄。
 * 渲染层传来的绝对路径（含 UNC / Windows 路径）一律在 IPC 入口就被拒。
 */
export const licensePathTokenSchema = z.string().uuid('文件令牌无效')

/** 功能门控标识：非空字符串，最长 100 */
export const featureSchema = z.string().min(1).max(100)
