// License 授权 IPC 入参 schema
// licenseCode 进签名校验流程（CPU 面），filePath 进文件读取，带宽松上限。
import { z } from 'zod'

/** 激活码 / license 原文：非空字符串，最长 4096（签名校验输入） */
export const licenseCodeSchema = z.string().min(1).max(4096, '激活码过长')

/** 文件路径：非空字符串，最长 1024 */
export const filePathSchema = z.string().min(1).max(1024, '路径过长')

/** 功能门控标识：非空字符串，最长 100 */
export const featureSchema = z.string().min(1).max(100)
