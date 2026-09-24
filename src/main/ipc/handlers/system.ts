// 系统级 IPC：硬件信息 / 路径 / 菜单语言 / DB 维护 / 独立窗口
import { IPC } from '../../../shared/types'
import { getPaths } from '../../portable'
import { getHardwareInfo, refreshHardwareInfo } from '../../steward/hardware'
import { buildAppMenu } from '../../menu'
import { dbService } from '../../db/database'
import { createDetachedWindow, DETACHED_MODULES } from '../../windows/detached'
import { safeHandle, argsSchema, z } from '../safe-handle'

export function registerSystemHandlers(): void {
  // force=true 时重新采集（用户手动「重新检测」）；否则返回启动时缓存的快照
  safeHandle(IPC.SYSTEM_HARDWARE_INFO, (_e, force?: boolean) =>
    force ? refreshHardwareInfo() : getHardwareInfo(),
  argsSchema(z.boolean().optional()))
  safeHandle(IPC.APP_GET_PATHS, () => getPaths())
  safeHandle(IPC.MENU_SET_LANGUAGE, (_e, lang: string) => {
    buildAppMenu(lang === 'en' ? 'en' : 'zh')
    return { ok: true }
  }, argsSchema(z.string()))
  safeHandle(IPC.DB_RUN_MIGRATIONS, () => {
    dbService.runMigrations()
    return { ok: true }
  })
  safeHandle(IPC.DB_INTEGRITY_CHECK, () => dbService.integrityCheck())

  // ---------- 独立窗口（标签弹出） ----------
  safeHandle(IPC.APP_OPEN_DETACHED, (_e, moduleId: unknown) => {
    if (typeof moduleId !== 'string' || !DETACHED_MODULES.has(moduleId)) {
      return { ok: false, error: '不支持的模块' }
    }
    createDetachedWindow(moduleId)
    return { ok: true }
  }, argsSchema(z.string()))
}
