// 系统级 IPC：硬件信息 / 路径 / 菜单语言 / DB 维护 / 独立窗口
import { IPC } from '../../../shared/types'
import { getPaths } from '../../portable'
import { getHardwareInfo, refreshHardwareInfo } from '../../steward/hardware'
import { buildAppMenu } from '../../menu'
import { dbService } from '../../db/database'
import { createDetachedWindow, DETACHED_MODULES } from '../../windows/detached'
import { safeHandle, argsSchema, z } from '../safe-handle'

export function registerSystemHandlers(): void {
  // §258：这两发过去把裸值当返回值，而 safeHandle 的失败是一个**解析出来的** `{ok:false,error}`
  // （`../safe-handle.ts:181`）⇒ 失败对象 truthy、preload 的类型又是 `Promise<HardwareInfo>` ⇒ tsc 不红，
  // 渲染端 `if (hw) setHardware(hw)` 就把失败对象当硬件快照用了（管家页那一屏当场 render TypeError／
  // 「integrity_check ❌ undefined」）。改成信封后调用点必须判，编译期就挡。
  // 注意 `integrityCheck()` 自己的形状就是 `{ok,details}`（库确实损坏时它返回 ok:false），
  // 所以它现在嵌在 `data` 里：信封的 `ok` 说"读到了吗"，`data.ok` 才说"库是否完整"。
  safeHandle(IPC.SYSTEM_HARDWARE_INFO, (_e, force?: boolean) => ({
    ok: true as const,
    data: force ? refreshHardwareInfo() : getHardwareInfo()
  }), argsSchema(z.boolean().optional()))
  safeHandle(IPC.APP_GET_PATHS, () => getPaths())
  safeHandle(IPC.MENU_SET_LANGUAGE, (_e, lang: string) => {
    buildAppMenu(lang === 'en' ? 'en' : 'zh')
    return { ok: true }
  }, argsSchema(z.string()))
  safeHandle(IPC.DB_RUN_MIGRATIONS, () => {
    dbService.runMigrations()
    return { ok: true }
  })
  safeHandle(IPC.DB_INTEGRITY_CHECK, () => ({ ok: true as const, data: dbService.integrityCheck() }))

  // ---------- 独立窗口（标签弹出） ----------
  safeHandle(IPC.APP_OPEN_DETACHED, (_e, moduleId: unknown) => {
    if (typeof moduleId !== 'string' || !DETACHED_MODULES.has(moduleId)) {
      return { ok: false, error: '不支持的模块' }
    }
    createDetachedWindow(moduleId)
    return { ok: true }
  }, argsSchema(z.string()))
}
