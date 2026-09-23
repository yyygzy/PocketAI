// 用户与界面偏好 IPC：首启向导、界面偏好（透明度/CSS）、侧栏模块顺序
import { IPC } from '../../../shared/types'
import type { UiPreferences, SidebarModuleId, WizardState } from '../../../shared/types'
import { DEFAULT_SIDEBAR_ORDER } from '../../../shared/types'
import { isPortableRuntime } from '../../portable'
import { getMachineId } from '../../steward/machine'
import { appConfigRepo } from '../../db/repositories/app-config.repo'
import { getUiPreferences, setUiPreferences } from '../../ui-preferences'
import { safeHandle } from '../safe-handle'

const K_SIDEBAR_ORDER = 'sidebar.order'
const K_LAST_PROVIDER = 'wizard.last_provider_id'

/** 读取侧栏顺序；配置缺失或非法时回退默认值 */
function readSidebarOrder(): SidebarModuleId[] {
  const raw = appConfigRepo.get(K_SIDEBAR_ORDER)
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (
        Array.isArray(arr) &&
        arr.length === DEFAULT_SIDEBAR_ORDER.length &&
        new Set(arr).size === DEFAULT_SIDEBAR_ORDER.length &&
        DEFAULT_SIDEBAR_ORDER.every((m) => arr.includes(m))
      ) {
        return arr as SidebarModuleId[]
      }
    } catch {
      /* 解析失败 → 回退默认 */
    }
  }
  return [...DEFAULT_SIDEBAR_ORDER]
}

export function registerPreferenceHandlers(): void {
  // ---------- 首启向导 ----------
  safeHandle(IPC.WIZARD_GET_STATE, async () => {
    // 便携判定：Windows portable exe / Linux AppImage；U 盘直跑安装版由向导硬件页展示 removable 细节
    const isPortable = isPortableRuntime()
    const wizardDone = appConfigRepo.isFirstRunWizardDone()
    const storedId = appConfigRepo.getMachineId()
    // 从未记录过指纹 = 首次安装，由 wizardDone 驱动，不算「换电脑」
    const machineChanged = storedId !== null && storedId !== (await getMachineId())
    return { ok: true as const, data: { wizardDone, machineChanged, isPortable } satisfies WizardState }
  })
  safeHandle(IPC.WIZARD_COMPLETE, async () => {
    appConfigRepo.setFirstRunWizardDone(true)
    appConfigRepo.setMachineId(await getMachineId())
    return { ok: true as const }
  })

  // ---------- 界面偏好（透明度 / 自定义 CSS） ----------
  safeHandle(IPC.UI_GET_PREFS, () => ({ ok: true as const, data: getUiPreferences() }))
  safeHandle(IPC.UI_SET_PREFS, (_e, patch: Partial<UiPreferences>) => ({
    ok: true as const,
    data: setUiPreferences(patch ?? {})
  }))

  // ---------- 侧栏模块顺序 ----------
  safeHandle(IPC.SIDEBAR_GET_ORDER, () => ({ ok: true as const, data: readSidebarOrder() }))
  safeHandle(IPC.SIDEBAR_SET_ORDER, (_e, order: SidebarModuleId[]) => {
    // 必须是全部模块的一个排列，否则拒绝
    const valid =
      Array.isArray(order) &&
      order.length === DEFAULT_SIDEBAR_ORDER.length &&
      new Set(order).size === DEFAULT_SIDEBAR_ORDER.length &&
      DEFAULT_SIDEBAR_ORDER.every((m) => order.includes(m))
    if (!valid) return { ok: false as const, error: 'invalid order' }
    appConfigRepo.set(K_SIDEBAR_ORDER, JSON.stringify(order))
    return { ok: true as const, data: order }
  })

  // ---------- 向导上次保存的 provider（对话默认回填用） ----------
  safeHandle(IPC.WIZARD_GET_LAST_PROVIDER, () => ({
    ok: true as const,
    data: appConfigRepo.get(K_LAST_PROVIDER) ?? ''
  }))
  safeHandle(IPC.WIZARD_SET_LAST_PROVIDER, (_e, providerId: string) => {
    appConfigRepo.set(K_LAST_PROVIDER, providerId)
    return { ok: true as const }
  })
}
