// 工具面分组与「运行级按需暴露」（V4 工具面治理，候选 A）
//
// 要解决的问题是实测出来的：19 个内置工具的 wire JSON 合计 7,755 字符 ≈ 3,039 token，
// 而一次 8k 窗口的运行里，工具清单就吃掉 38%。这一层按**能力域**把内置工具分组，
// 每轮只把「常驻组 + 按用户消息命中最多 2 个组」交给模型。
//
// 三条硬边界（都有用例钉着）：
//  · **只裁 `'*'` 宽授权**：显式逐条授权是用户点名要用的工具，一枚都不裁（`'*'` 之外的
//    permissions 一律原样返回）。MCP 工具同理——它们本来就只能逐条授权，因此不参与分组裁剪。
//  · **不认识的内置工具一律保留**（fail-open）：新增工具忘了登记分组时，宁可不省上下文，
//    也不能让它静默消失。覆盖断言在 `tests/tool-groups.test.ts` 里兜住名单。
//  · **不碰权限判定**：这里只决定"发不发 schema"，`isToolAllowedBy`／`classify`／
//    `forceConfirm`／deny > confirm > allow 全在别处，本文件不 import 它们。

import type { ToolSchema } from './types'

export type ToolGroupId = 'core' | 'net' | 'file' | 'shell' | 'schedule' | 'skill' | 'delegate'

/** 工具面装载模式：grouped=按需；full=与治理前完全一致 */
export type ToolSurfaceMode = 'grouped' | 'full'

/**
 * 实际装载模式：**用户配过就听用户的**；没配过按端点位置分默认。
 *
 * 为什么不给"没配过"也留 grouped：分组裁剪是靠关键词开合的，线上大模型恰恰是
 * "该调不调"的重灾区——问「100 美元等于多少人民币」不含"汇率"二字，exchange_rate
 * 就不在请求里，模型不是不想调，是根本看不见。云端窗口（128k）付得起全量 schema
 * （实测 19 枚 ≈3k token），本地小窗口才是必须省的那一侧。
 */
export function resolveToolSurfaceMode(
  pref: ToolSurfaceMode | null,
  endpointLocal: boolean
): ToolSurfaceMode {
  if (pref) return pref
  return endpointLocal ? 'grouped' : 'full'
}

/**
 * 从模型名识别参数量（单位 B）。只做**名字里写明了**的那一类：
 *  · `qwen3:8b` / `Qwen3-8B` / `llama-3.1-70b` / `Qwen3-235B-A22B` → 8 / 70 / 235；
 *  · 名字里没有数字+B（`gpt-4o`、`deepseek-v3`、`kimi-k2`）→ null，交给端点位置规则，不猜。
 * 注意 `8x7b` 这类 MoE 写法只取第一个数字（7），归入小模型侧——按"激活参数"口径可以接受。
 */
export function detectModelParamsB(model: string): number | null {
  const m = String(model ?? '').toLowerCase()
  const hit = m.match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/)
  if (!hit) return null
  const n = Number(hit[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 工具面的完整计划：模式 + 是否允许"空集/模型称无工具"时兜底到全量 */
export interface ToolSurfacePlan {
  mode: ToolSurfaceMode
  /** 仅 grouped 侧需要：收窄后允许一次全量兜底 */
  fallbackToFull: boolean
  /** 名字里识别到的参数量（null=认不出，走端点规则） */
  paramsB: number | null
}

/**
 * v79 第二批：按模型档位自动选面。
 *
 *  · 用户配过 → 一律听用户的（手动 full/grouped 优先级最高，不被自动规则覆盖）；
 *  · 名字认得出参数量：≥14B 走全量；≤13B（含 8B 及以下、9-13B）走收窄+兜底；
 *  · 认不出 → 沿用现有"云端全量 / 本地收窄"规则（不瞎猜档位）。
 *
 * 手动 grouped 也保留兜底：兜底是运行期的一次性安全网，不是对偏好本身的改写；
 * 手动 full 不需要兜底（面已经是全量）。
 */
export function resolveToolSurfacePlan(
  pref: ToolSurfaceMode | null,
  endpointLocal: boolean,
  model: string
): ToolSurfacePlan {
  const paramsB = detectModelParamsB(model)
  if (pref === 'full') return { mode: 'full', fallbackToFull: false, paramsB }
  if (pref === 'grouped') return { mode: 'grouped', fallbackToFull: true, paramsB }
  if (paramsB !== null) {
    return paramsB >= 14
      ? { mode: 'full', fallbackToFull: false, paramsB }
      : { mode: 'grouped', fallbackToFull: true, paramsB }
  }
  const fallbackMode = resolveToolSurfaceMode(null, endpointLocal)
  return { mode: fallbackMode, fallbackToFull: fallbackMode === 'grouped', paramsB: null }
}

/**
 * 内置工具 id → 组。**新增内置工具必须在这里登记**，否则 `tests/tool-groups.test.ts` 的
 * 覆盖断言会失败（真机上则由 `selectToolSurface` 的 fail-open 兜底，不会静默丢工具）。
 */
export const TOOL_GROUP_OF: Readonly<Record<string, ToolGroupId>> = {
  // 核心：任何对话都可能用到，且体量小
  'time.now': 'core',
  calculator: 'core',
  'js.eval': 'core',
  'kb.search': 'core',
  'todo.write': 'core',
  'memory.save': 'core',
  'code.symbol': 'core',
  'mcp.symbol': 'core',
  // 常用工具：天气查询按用户要求常驻，不依赖消息是否命中 net 关键词。
  // 仍受助手 toolPermissions 与本轮 toolGrant 约束，只是不再被分组裁剪。
  'weather.query': 'core',
  // 按需
  'web.fetch': 'net',
  'web.search': 'net',
  // 免费公共 API 工具（v77 批次）：全部走固定域名 safeFetch，归 net 组
  'exchange.rate': 'net',
  'ip.lookup': 'net',
  'crypto.price': 'net',
  'holiday.public': 'net',
  'wiki.summary': 'net',
  'air.quality': 'net',
  'dict.en': 'net',
  'translate.mymemory': 'net',
  // 免费公共 API 工具（v79 第一批梯队）：世界银行/链上费率/金银/地震/日出日落
  'worldbank.indicator': 'net',
  'btc.fees': 'net',
  'metal.price': 'net',
  'earthquake.feed': 'net',
  'sun.times': 'net',
  'fs.list': 'file',
  'fs.read': 'file',
  'fs.write': 'file',
  'fs.apply_patch': 'file',
  'run_tests': 'shell',
  'artifact.create': 'file',
  'project.create': 'file',
  'calendar.read': 'schedule',
  'reminder.set': 'schedule',
  'reminder.list': 'schedule',
  'reminder.cancel': 'schedule',
  // 常驻但不参与裁剪：这几组的存在本身就是用户显式开过的能力，
  // 因为一条消息里没提到"命令/技能/子代理"就把它们藏起来，等于悄悄关掉用户的开关。
  'shell.exec': 'shell',
  'skill.load': 'skill',
  'agent.delegate': 'delegate'
}

/** 永远暴露的组：core 是高频，其余三项是"用户显式开启的能力"（见上面的注释） */
export const ALWAYS_ON_GROUPS: ReadonlySet<ToolGroupId> = new Set<ToolGroupId>([
  'core',
  'shell',
  'skill',
  'delegate'
])

/** 可裁剪的组（用于断言与界面文案，不参与判定顺序） */
export const PRUNABLE_GROUPS: ReadonlyArray<ToolGroupId> = ['net', 'file', 'schedule']

/** 一轮最多再额外装载几个可裁剪组 */
export const MAX_EXPOSED_GROUPS = 2

/**
 * 组命中词表。确定性、无模型参与：它只影响"多带一两个组"，
 * 漏判的代价是少带一个域（用户下一轮换个说法就能进），不会误裁常驻组。
 */
const GROUP_KEYWORDS: Readonly<Record<'net' | 'file' | 'schedule', readonly string[]>> = {
  net: [
    '联网', '搜索', '搜一下', '查一下', '网页', '链接', '网址', '天气', '温度', '新闻',
    '汇率', '币价', '加密货币', '比特币', '翻译', '节假日', '放假', '空气质量', '词典', '百科',
    // 盲区补全（v78）：这些说法不出现"汇率/搜索/查一下"也会落在 net 组，
    // 漏判的代价是工具被裁掉 → 模型只能凭记忆编（正是"该调不调"的成因之一）
    '股票', '股价', '大盘', '指数', '比分', '赛果', '赛事', '赛程', '竞猜',
    '美元', '人民币', '港币', '日元', '欧元', '英镑', '韩元', '币种', '兑换', '换算',
    '冷吗', '热吗', '下雨', '降雨', '降雪', '刮风', '气温', '摄氏度', '天气预报', '台风',
    'ip', '归属', '运营商', '域名', '时区', '汇率换算',
    // v79：世界银行 / 链上费率 / 金银 / 地震 / 日出日落
    '世界银行', 'gdp', '人均', '经济指标', '通胀', '失业率',
    '金价', '黄金', '白银', '银价', '贵金属',
    '地震', '震级', '余震',
    '日出', '日落', '紫外线', 'uv',
    '手续费', '矿工费', '链上', 'sat/vb',
    'search', 'google', 'web', 'http', 'url', 'weather', 'forecast',
    'stock', 'price', 'match', 'score', 'exchange', 'currency', 'usd', 'cny', 'ip'
  ],
  file: [
    '文件', '目录', '文件夹', '读取', '读一下', '写入', '保存到', '路径', '文档', '附件',
    '生成', '做一份', 'ppt', 'pptx', '幻灯片', '演示文稿', '演示', 'word', 'docx', 'excel',
    'xlsx', '表格', '报告', '导出',
    'file', 'folder', 'directory', 'save', 'path', 'txt', 'csv', 'markdown'
  ],
  schedule: [
    '日程', '日历', '提醒', '闹钟', '会议', '排期', 'calendar', 'reminder', 'remind', 'schedule', 'ics'
  ]
}

export interface ToolSurfaceResult {
  /** 本轮真正进入请求的工具（顺序与入参一致） */
  tools: ToolSchema[]
  /** 本轮额外装载的可裁剪组（不含常驻组）；用于 trace 与排查 */
  groups: ToolGroupId[]
  /** 因分组裁剪而未进入请求的内置工具数（**不是** mcpHeldBack 那个数字） */
  heldBackTools: number
}

/**
 * 按用户消息给可裁剪组打分（命中词出现次数求和）。
 * 导出是为了让"同一句话选到同一组"这件事能被单独钉住。
 */
export function scoreToolGroups(message: string): Array<{ group: ToolGroupId; score: number }> {
  const text = String(message ?? '').toLowerCase()
  const out: Array<{ group: ToolGroupId; score: number }> = []
  for (const group of PRUNABLE_GROUPS) {
    const words = GROUP_KEYWORDS[group as 'net' | 'file' | 'schedule']
    let score = 0
    for (const w of words) {
      if (!w) continue
      let from = 0
      for (;;) {
        const at = text.indexOf(w, from)
        if (at < 0) break
        score++
        from = at + w.length
      }
    }
    out.push({ group, score })
  }
  // 分数降序；同分按 PRUNABLE_GROUPS 的固定顺序（确定性，不依赖 locale）
  return out.sort((a, b) => b.score - a.score)
}

/** 本轮要额外装载的组（最多 MAX_EXPOSED_GROUPS，0 分的不要） */
export function pickToolGroups(message: string): ToolGroupId[] {
  return scoreToolGroups(message)
    .filter((x) => x.score > 0)
    .slice(0, MAX_EXPOSED_GROUPS)
    .map((x) => x.group)
}

/**
 * 运行级工具面选择。纯函数：同一组入参恒得同一结果（trace 与用例都靠这个）。
 *
 * 不裁剪的三种情况要原样返回：`mode==='full'`（用户关掉治理）、`permissions` 不含 `'*'`
 * （显式逐条授权）、以及每枚 MCP 工具（只能逐条授权，等价于显式）。
 */
export function selectToolSurface(input: {
  tools: ToolSchema[]
  permissions: string[]
  message: string
  mode: ToolSurfaceMode
}): ToolSurfaceResult {
  const { tools, permissions, message, mode } = input
  if (mode !== 'grouped' || !permissions.includes('*')) {
    return { tools, groups: [], heldBackTools: 0 }
  }
  const picked = pickToolGroups(message)
  const pickedSet = new Set<ToolGroupId>(picked)
  const kept: ToolSchema[] = []
  let heldBackTools = 0
  for (const tool of tools) {
    if (tool.source !== 'builtin') {
      kept.push(tool)
      continue
    }
    const group = TOOL_GROUP_OF[tool.id]
    // 未登记的 id：fail-open（见文件头第 2 条）
    if (!group || ALWAYS_ON_GROUPS.has(group) || pickedSet.has(group)) {
      kept.push(tool)
      continue
    }
    heldBackTools++
  }
  return { tools: kept, groups: picked, heldBackTools }
}
