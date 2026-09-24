// 文件模块 IPC 入参 schema
// 核心风险是路径穿越：渲染进程传入的相对路径必须被限制在工作区内，
// 禁止 .. 回退、绝对路径、以及 Windows 盘符前缀。
import { z } from 'zod'

/**
 * 安全相对路径（文件/子目录）：
 * - 非空字符串
 * - 不含 ".." 段
 * - 不是绝对路径（不以 / \ 或盘符开头）
 */
export const safeRelPath = z
  .string()
  .min(1, '路径不能为空')
  .refine((p) => !p.includes('..'), '路径不合法：禁止 .. 回退')
  .refine(
    (p) => !/^([A-Za-z]:|[\\/])/.test(p),
    '路径不合法：必须是相对路径'
  )

/**
 * 安全相对目录：允许空字符串（代表数据根目录），其余规则同 safeRelPath。
 * 用于 listFiles / mkdir / upload 等以目录为目标的接口。
 */
export const safeRelDir = z
  .string()
  .refine((p) => !p.includes('..'), '路径不合法：禁止 .. 回退')
  .refine(
    (p) => !/^([A-Za-z]:|[\\/])/.test(p),
    '路径不合法：必须是相对路径'
  )

/** 文件名：非空，不含路径分隔符 */
export const safeFileName = z
  .string()
  .min(1, '文件名不能为空')
  .refine((n) => !/[\\/]/.test(n), '文件名不合法：不能包含路径分隔符')

/** base64 内容：非空字符串 */
export const base64Content = z.string().min(1, '内容不能为空')
