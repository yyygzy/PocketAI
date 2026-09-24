// 沙箱（本地 HTML 小应用）IPC：列表/创建/读取/删除/元信息更新
import { IPC } from '../../../shared/types'
import {
  listSandboxFiles,
  createSandboxFile,
  getSandboxFile,
  deleteSandboxFile,
  updateSandboxMeta
} from '../../sandbox/sandbox-service'
import { safeHandle, argsSchema } from '../safe-handle'
import { sandboxCreateSchema, sandboxUpdateMetaSchema } from '../../../shared/schemas/sandbox'
import { idSchema } from '../../../shared/schemas/providers'

export function registerSandboxHandlers(): void {
  safeHandle(IPC.SANDBOX_LIST, () => listSandboxFiles())
  safeHandle(
    IPC.SANDBOX_CREATE,
    (_e, payload: { name?: unknown; html?: unknown; opts?: unknown }) => {
      // 字段类型校验；上限/清洗在 service 内做
      if (typeof payload?.name !== 'string' || typeof payload?.html !== 'string') {
        throw new Error('参数类型错误')
      }
      const opts = payload.opts as
        | { icon?: unknown; description?: unknown; isApp?: unknown }
        | undefined
      const cleanOpts: { icon?: string; description?: string; isApp?: boolean } = {}
      if (opts?.icon !== undefined && typeof opts.icon === 'string') cleanOpts.icon = opts.icon
      if (opts?.description !== undefined && typeof opts.description === 'string')
        cleanOpts.description = opts.description
      if (opts?.isApp !== undefined) cleanOpts.isApp = !!opts.isApp
      return createSandboxFile(payload.name, payload.html, cleanOpts)
    },
    argsSchema(sandboxCreateSchema)
  )
  safeHandle(IPC.SANDBOX_GET, (_e, id: string) => getSandboxFile(String(id ?? '')), argsSchema(idSchema))
  safeHandle(IPC.SANDBOX_DELETE, (_e, id: string) => {
    deleteSandboxFile(String(id ?? ''))
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(
    IPC.SANDBOX_UPDATE_META,
    (_e, payload: { id?: unknown; patch?: unknown }) => {
      if (typeof payload?.id !== 'string' || typeof payload?.patch !== 'object' || payload.patch === null) {
        throw new Error('参数类型错误')
      }
      const p = payload.patch as Record<string, unknown>
      const patch: { name?: string; icon?: string; description?: string; isApp?: boolean } = {}
      // 字段白名单：只允许这四个字段，其余忽略
      if (p.name !== undefined && typeof p.name === 'string') patch.name = p.name
      if (p.icon !== undefined && typeof p.icon === 'string') patch.icon = p.icon
      if (p.description !== undefined && typeof p.description === 'string')
        patch.description = p.description
      if (p.isApp !== undefined) patch.isApp = !!p.isApp
      return updateSandboxMeta(payload.id, patch)
    },
    argsSchema(sandboxUpdateMetaSchema)
  )
}
