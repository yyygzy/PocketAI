// License 授权 IPC 入参 schema
import { z } from 'zod'

/** 激活码 / license 原文：非空字符串 */
export const licenseCodeSchema = z.string().min(1)

/** 文件路径：非空字符串 */
export const filePathSchema = z.string().min(1)

/** 功能门控标识：非空字符串 */
export const featureSchema = z.string().min(1)
