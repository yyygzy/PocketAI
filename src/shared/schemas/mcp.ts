// MCP Server 配置 IPC 入参 schema
// MCP_SERVER_SAVE 入参为 Partial<McpServerRecord> & { name: string }；
// transport/runtime 等枚举字段需校验，防止非法值进入 manager（涉及进程启动）。
import { z } from 'zod'

const mcpTransportSchema = z.enum(['stdio', 'http'])
const mcpRuntimeSchema = z.enum(['node', 'python', 'binary'])

const mcpServerRecordFull = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: mcpTransportSchema,
  runtime: mcpRuntimeSchema,
  command: z.string().nullable(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  url: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  pythonPackages: z.array(z.string())
})

/** MCP_SERVER_SAVE 入参 */
export const mcpServerSaveSchema = mcpServerRecordFull
  .partial()
  .extend({ name: z.string().min(1) })

/** PYTHON_PIP_SOURCE_SET 入参：'official' | 'tuna' | 任意自定义镜像 URL */
export const pythonPipSourceSchema = z.string().min(1)
