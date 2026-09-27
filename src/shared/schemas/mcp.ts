// MCP Server 配置 IPC 入参 schema
// MCP_SERVER_SAVE 入参为 Partial<McpServerRecord> & { name: string }；
// transport/runtime 等枚举字段需校验，防止非法值进入 manager（涉及进程启动）。
// 资源上限：command/args/env 会原样进入 spawn，pythonPackages 进入 pip 安装，
// 无界字段可造成 DB 膨胀、spawn E2BIG 与超长命令行；id 与文件系统 serverDir 同源，
// 字符集/长度必须与 python-env.serverDir 保持一致，非法配置在入口即拒。
import { z } from 'zod'

const mcpTransportSchema = z.enum(['stdio', 'http'])
const mcpRuntimeSchema = z.enum(['node', 'python', 'binary'])

// ─── 资源上限 ────────────────────────────────────────────────────
/** 配置名（UI 显示） */
const MCP_MAX_NAME_CHARS = 100
/** 可执行路径（Windows MAX_PATH 上界内留余量） */
const MCP_MAX_COMMAND_CHARS = 1024
/** spawn 参数数量与单项长度 */
const MCP_MAX_ARGS = 32
const MCP_MAX_ARG_CHARS = 4096
/** 环境变量键值对数量与长度 */
const MCP_MAX_ENV_ENTRIES = 64
const MCP_MAX_ENV_KEY_CHARS = 256
const MCP_MAX_ENV_VALUE_CHARS = 32_768
/** pip 依赖数量/单项长度——与 python-env 服务层 MAX_REQ_COUNT/MAX_REQ_LINE_LEN 对齐 */
export const MCP_MAX_PACKAGES = 50
export const MCP_MAX_PACKAGE_CHARS = 200
/** URL 字段长度（兜底，协议另由 refine 校验） */
const MCP_MAX_URL_CHARS = 2048

/**
 * Server ID：必须与 src/main/mcp/python-env.ts serverDir 的目录名白名单完全一致
 * （^[a-zA-Z0-9_-]{1,64}$）。新记录 id 由渲染层 randomUUID 生成，此处为入口拦截，
 * 防止存库后 start/install 才在 serverDir 抛错。
 */
const mcpServerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'MCP Server ID 仅允许字母/数字/下划线/短横线且不超过 64 字符')

/** http transport 的 URL：仅允许 http(s)（v1 未启用 http，此为 v2 启用前的前置免疫） */
const mcpHttpUrlSchema = z
  .string()
  .max(MCP_MAX_URL_CHARS)
  .url('URL 不合法')
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }, 'MCP Server URL 仅支持 http(s) 协议')

const mcpServerRecordFull = z.object({
  id: mcpServerIdSchema,
  name: z.string().min(1).max(MCP_MAX_NAME_CHARS),
  transport: mcpTransportSchema,
  runtime: mcpRuntimeSchema,
  command: z.string().max(MCP_MAX_COMMAND_CHARS).nullable(),
  args: z.array(z.string().max(MCP_MAX_ARG_CHARS)).max(MCP_MAX_ARGS),
  env: z
    .record(z.string().max(MCP_MAX_ENV_KEY_CHARS), z.string().max(MCP_MAX_ENV_VALUE_CHARS))
    .superRefine((env, ctx) => {
      if (Object.keys(env).length > MCP_MAX_ENV_ENTRIES) {
        ctx.addIssue({
          code: 'custom',
          message: `环境变量不能超过 ${MCP_MAX_ENV_ENTRIES} 项`
        })
      }
    }),
  url: mcpHttpUrlSchema.nullable(),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  pythonPackages: z
    .array(z.string().max(MCP_MAX_PACKAGE_CHARS))
    .max(MCP_MAX_PACKAGES)
})

/** MCP_SERVER_SAVE 入参 */
export const mcpServerSaveSchema = mcpServerRecordFull
  .partial()
  .extend({ name: z.string().min(1).max(MCP_MAX_NAME_CHARS) })

/**
 * PYTHON_PIP_SOURCE_SET 入参：'official' | 'tuna' | 自定义 http(s) 镜像 URL。
 * 单一来源：python-env 服务层 pipSourceSchema 必须复用本 schema，禁止双侧各写一份。
 */
export const pythonPipSourceSchema = z.union([
  z.enum(['official', 'tuna']),
  z
    .string()
    .max(MCP_MAX_URL_CHARS)
    .url()
    .refine((v) => {
      try {
        const u = new URL(v)
        return u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        return false
      }
    }, '自定义 pip 源仅支持 http(s) 协议')
])
