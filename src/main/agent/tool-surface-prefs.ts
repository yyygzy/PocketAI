// 工具面装载模式的全局开关（工具面治理，候选 A）
//
// 存储：app_config 单键 `agent.tool_surface_mode`，值为 `grouped` / `full`。
// 不建表、不加迁移——这和「文本协议」「委派开关」是同一个 KV 形状。
//
// 为什么是全局而不是 per-assistant：要省的是**模型请求里的固定开销**，同一个助手换模型
// 面对的窗口大小不同，把开关挂在助手上反而要在"这个助手 × 这台模型"上再解释一遍。
// 默认 `grouped`；凡是读不懂的值（老库没有这个键、脏值）都按 `grouped` 处理，
// 与治理前的差异只在"发多少 schema"，执行授权完全不走这里。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import type { ToolSurfaceMode } from '../../shared/tool-groups'

const K_TOOL_SURFACE_MODE = 'agent.tool_surface_mode'

/**
 * 读配置**原值**：未配置（老库没有这个键）返回 null。
 *
 * 为什么需要与原实现分开：`getToolSurfaceMode` 把"没配过"与"用户显式选了 grouped"
 * 压成同一个值，于是线上模型没法默认全量——两条事实必须能区分。引擎按
 * `resolveToolSurfaceMode(原值, 端点是否本地)` 决定：没配过时云端=full、本地=grouped；
 * 配过就一律听用户的。
 */
export function readToolSurfaceModePref(): ToolSurfaceMode | null {
  try {
    const v = appConfigRepo.get(K_TOOL_SURFACE_MODE)
    return v === 'full' || v === 'grouped' ? v : null
  } catch {
    return null
  }
}

/** 引擎每轮开始读一次；读库失败时按默认值（grouped）——它不影响任何授权判定 */
export function getToolSurfaceMode(): ToolSurfaceMode {
  return readToolSurfaceModePref() ?? 'grouped'
}

/** 写开关并回读（以库里为准，调用方不做乐观更新） */
export function setToolSurfaceMode(mode: ToolSurfaceMode): ToolSurfaceMode {
  appConfigRepo.set(K_TOOL_SURFACE_MODE, mode === 'full' ? 'full' : 'grouped')
  return getToolSurfaceMode()
}
