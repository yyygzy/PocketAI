// 系统级 IPC：硬件信息 / 路径 / 菜单语言 / DB 维护 / 独立窗口
import { app } from 'electron'
import { IPC } from '../../../shared/types'
import { handshakeChannelList } from '../../../shared/ipc-handshake'
import { getPaths } from '../../portable'
import { getHardwareInfo, refreshHardwareInfo } from '../../steward/hardware'
import { buildAppMenu } from '../../menu'
import { dbService } from '../../db/database'
import { createDetachedWindow, DETACHED_MODULES } from '../../windows/detached'
import { safeHandle, argsSchema, z } from '../safe-handle'

/** 主进程模块加载时刻：与通道清单一起构成「这个主进程是不是旧的」的证据（重启即变） */
const MAIN_STARTED_AT = Date.now()

export function registerSystemHandlers(): void {
  // V4-Iter-475：版本握手。主进程不回「我支持什么」，只回「我这份包里编译进了哪些通道常量」，
  // 由渲染层做差集——这样证据是两边各自独立编译出来的表，而不是主进程自说自话。
  // 旧主进程根本没有这个 handler，渲染层那一发会 reject，失败面在界面上另有一条提示。
  safeHandle(IPC.APP_HANDSHAKE, () => ({
    buildId: `${app.getVersion()}+${MAIN_STARTED_AT}`,
    startedAt: MAIN_STARTED_AT,
    channels: handshakeChannelList()
  }))

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
