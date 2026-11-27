# PocketAI 模型启用与两级选择方案（定稿）

- 文档状态：定稿，四项决策已确认
- 适用范围：设置页「已缓存模型」、对话主链路、浮窗、助手默认模型、渠道模型
- 本文只描述方案，不包含源码改动；所有文件与行号用于评审定位

## 0. 结论与已确认决策

| 决策点 | 定稿结论 |
|---|---|
| 启用集作用域 | 对话主链路、浮窗、助手默认模型、渠道模型受启用集限制；知识库嵌入/重排/OCR、图像、翻译继续使用全量缓存 |
| 老用户默认 | `enabled_models` 为 `NULL` 视为「全部启用」，升级零感知 |
| 新拉取模型 | 老库未配置（`NULL`）时自动启用；用户已显式配置过启用集时，新模型默认不启用，等用户勾选 |
| 两级选择器一级 | 「模型拉取来源」即服务商（provider）；不做模型系列品牌推导，不设「其他」兜底分组 |

核心设计：

1. `providers.models` 继续表示「拉取到的全部模型」，不改变语义。
2. 新增 `providers.enabled_models` 表示「用户确认要用的模型」，按服务商维度保存。
3. 设置页「已缓存模型」改成左右双栏：左边全量缓存、右边启用白名单；移动只在草稿态生效，点「保存」才落库。
4. 前端对话类选择器统一读启用集，并统一改成「来源（服务商）→ 具体型号」两级菜单。

---

## 1. 现状盘点

### 1.1 数据与状态来源

当前没有「单个模型启用/停用」的任何状态，只有服务商级 `enabled`：

| 层 | 位置 | 事实 |
|---|---|---|
| 类型 | `src/shared/types.ts:85-94` | `ProviderRecord.models: string[]` 是唯一模型清单；`enabled` 是服务商级开关 |
| 表结构 | `src/main/db/database.ts:88-96` | `providers.models TEXT` 存 JSON 数组 |
| 读库 | `src/main/db/repositories/provider.repo.ts:25-46` | `rowToRecord` 把 `models` JSON 还原成数组 |
| 保存 | `src/main/db/repositories/provider.repo.ts:65-125` | 全量覆盖 `models`；已处理「带 id 空数组＝主动清空 / 去重命中空数组＝保留旧值」两种空语义 |
| 拉取模型 | `src/main/providers/manager.ts:38-45` → `src/main/db/repositories/provider.repo.ts:168-173` | 远端结果直接 `UPDATE providers SET models=?`，不经过保存表单 |
| IPC | `src/main/ipc/handlers/providers.ts:19-43` | 只有 `LIST / SAVE / DELETE / FETCH_MODELS / TEST / REVEAL_KEYS`，没有模型级接口 |
| 入参校验 | `src/shared/schemas/providers.ts:19-34` | `models` 上限 500 条 |

### 1.2 前端是怎么把缓存模型暴露成可选列表的

主链路：

1. `src/renderer/src/modules/chat/ChatModule.tsx:459-507` 拉 `listProviders()`，用 `pickDefaultProvider` 选默认服务商，再从 `pick.models` 里挑第一个非 embedding 模型。
2. `src/renderer/src/modules/chat/ModelSelector.tsx:51-54` 把所有启用服务商的所有 `models` 平铺成 `providerId:model` 选项，label 是「服务商 / 模型」。
3. `src/renderer/src/utils/provider-pick.ts:11-46` 的 `hasUsableModel / pickDefaultProvider / isTargetStillValid` 全部以 `p.models` 为准。

当前界面形态与需求描述略有差异，本次统一：

- **主窗口对话顶栏**：一个扁平合并下拉，每个 option 重复「服务商 / 型号」，见 `ModelSelector.tsx:67-83`。
- **浮窗**：两个并列下拉（服务商 + 模型），见 `src/renderer/src/popup/PopupApp.tsx:678-708`。
- **助手编辑器 / 知识库问答**：也是两个并列下拉，见 `src/renderer/src/modules/chat/AssistantEditor.tsx:264-282`、`src/renderer/src/modules/knowledge/KbAskPanel.tsx:543-566`。

三种形态统一到两级选择器，避免只改主窗口、浮窗仍暴露未启用模型。

### 1.3 所有 `.models` 消费点与口径

| 位置 | 现在读什么 | 定稿口径 | 说明 |
|---|---|---|---|
| `ModelSelector.tsx:51-54` | `p.models` | 启用集 | 主改造点 |
| `ChatModule.tsx:492-497` | `pick.models` | 启用集 | 默认模型仍排除 embedding |
| `ChatModule.tsx:616-625` | `prov.models` | 启用集 + 失效提示 | 历史会话回填 |
| `ChatView.tsx:755-760` | `hasUsableModel` | 启用集 | 空态要拆三种 |
| `Composer.tsx:39-40 / 1062` | `noModels` | 新增 `noEnabledModels` | 文案区分「没拉取」与「没启用」 |
| `PopupApp.tsx:44 / 232 / 678-708` | `models` | 启用集 | 两个下拉改一个两级菜单 |
| `AssistantEditor.tsx:264-282` | `provider.models` | 启用集 | 助手默认模型 |
| `ComposerPlusMenu.tsx:166-173` | `p.models` | 启用集 | 备用模型候选 |
| `useAgentModelExtras.ts:161-169` | `p.models.includes` | 启用集 | 备用模型失效判定 |
| `ChannelsPanel.tsx:491-497` | `p.models` | 启用集 | 渠道运行模型 |
| `KnowledgeModule.tsx:354-365` | `models` | 保持全量 | 嵌入/重排/OCR 专用 |
| `ImageModule.tsx:83-102` | `models` | 保持全量 | 图像模型常不在 `/models` |
| `TranslateModule.tsx:104-122` | `models` | 保持全量 | 翻译模型独立配置 |

新增共享读取函数后，所有「启用集」消费点只走它，禁止再直接读 `p.models`。

---

## 2. 数据层设计

### 2.1 存储选型：新增列，不建新表、不放配置项

| 方案 | 结论 | 理由 |
|---|---|---|
| `providers.enabled_models TEXT` | 采用 | 与 `models` 同一行、同一次保存、同一次备份；无第二数据源 |
| 新表 `provider_models(provider_id, model_id, enabled)` | 不采用 | `models` 已是 JSON；新表要处理拉取、保存、去重、备份、密钥轮换全链路同步，收益只是未来可能的模型级元数据 |
| `app_config` KV 配置项 | 不采用 | 启用状态必须跟着 provider 删改走；KV 会出现「provider 已删、KV 残留」和两套写路径 |

### 2.2 类型与 IPC 合同

```ts
// shared/types.ts —— ProviderRecord
models: string[]            // 拉取到的全部模型（不变）
/**
 * 已启用模型白名单：
 *  - null / undefined：未配置，全部 models 视为启用（老库兼容）
 *  - []：明确全部停用
 *  - string[]：只启用这些
 */
enabledModels?: string[] | null
```

- 使用可选字段，避免首启向导、翻译历史补位等处所有 `ProviderRecord` 字面量被迫改签名，见 `FirstRunWizard.tsx:295-325`、`TranslateModule.tsx:350-365`。
- 入参 schema 增加可选、可空字段，长度上限沿用 `PROVIDER_MAX_MODELS = 500`，见 `src/shared/schemas/providers.ts:13-34`。
- `PROVIDER_LIST` 原样返回该字段（不是密钥，不需要掩码）；`maskProvider` 的展开写法自动带出，见 `src/main/ipc/handlers/providers.ts:14-26`。

### 2.3 迁移 v76：仅加列、不回填

本文写作时迁移数组末尾是 v75（见当时的 `src/main/db/database.ts:1396-1410`）；当前 `LATEST_SCHEMA_VERSION` 已到 v82，`MIGRATIONS` 末项见 `src/main/db/database.ts` 尾部，但本方案描述的 v76 加列与不回填口径未变。当时计划新增：

```ts
{
  // v76：模型级启用白名单。NULL=未配置（全部启用），[]=明确全部停用。
  // 不回填：老库升级后保持 NULL，行为与升级前完全一致；
  // 一旦用户在设置页动过，就写成显式数组。
  version: 76,
  name: 'provider_enabled_models',
  up: (db) => {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>)
        .map((c) => c.name)
    )
    if (!cols.has('enabled_models')) {
      db.exec('ALTER TABLE providers ADD COLUMN enabled_models TEXT;')
    }
  }
}
```

- 幂等写法沿用 v61/v62/v63 的 `PRAGMA` 先查后加，见 `src/main/db/database.ts:1044-1050`。
- `LATEST_SCHEMA_VERSION` 由数组末项自动更新，无需另改。
- 不做 SQL 回填。回填会让老用户重新拉取后新模型默认变成「未启用」，与决策 3 不符。

### 2.4 三态语义

```ts
// 建议作为共享单一出口
export function enabledModelsOf(p: ProviderRecord): string[] {
  if (p.enabledModels == null) return p.models
  const set = new Set(p.enabledModels)
  return p.models.filter((m) => set.has(m)) // 顺序永远跟 models 走，且自动裁剪失效项
}
```

| 库中值 | 语义 | 前端可选列表 |
|---|---|---|
| `NULL` | 未配置（老库 / 新服务商） | `models` 全部 |
| `[]` | 用户明确全部停用 | 空 |
| `["a","b"]` | 白名单 | `models ∩ 白名单` |

两个关键细节：

1. **反序列化失败必须降级为 `NULL`，不能降级为 `[]`**。现有 `safeJsonArray` 对坏 JSON 返回 `[]`，见 `provider.repo.ts:38-46`。如果 `enabled_models` 也沿用这个函数，一次损坏就会变成「一个模型都不可选」。需要单独的 `safeJsonArrayOrNull`：坏数据 → `null` → 全部可用。
2. **所有启用集读取都必须与 `models` 求交集**。这样即使库里残留了已被远端删除的模型，也不会出现在前端。

### 2.5 写入语义

`providerRepo.save` 需要新增三条规则，避免老调用方误清空：

| 输入 `enabledModels` | 行为 |
|---|---|
| `undefined` | 保留 `existing.enabledModels`；新建则写 `NULL` |
| `null` | 写 `NULL`（未配置） |
| `string[]`（含 `[]`） | 去重后与最终 models 求交集，写 JSON |

还要复用现有 `foundByDedupe` 规则：不带 id 的保存若按 `(type, baseUrl)` 命中了旧行，调用方只是「以为自己在新建」，此时传 `[]` 不得清空旧启用集；只有带 id 的保存才允许显式清空。这与现有 `models` 的空语义完全同构，见 `provider.repo.ts:103-111`。

伪代码：

```ts
const nextModels =
  foundByDedupe && input.models.length === 0 ? existing!.models : input.models

let nextEnabled: string[] | null
if (input.enabledModels === undefined) {
  nextEnabled = existing?.enabledModels ?? null
} else if (input.enabledModels === null) {
  nextEnabled = null
} else if (
  foundByDedupe &&
  input.enabledModels.length === 0 &&
  existing?.enabledModels != null
) {
  nextEnabled = existing.enabledModels
} else {
  const set = new Set(input.enabledModels)
  nextEnabled = nextModels.filter((m) => set.has(m))
}
```

### 2.6 拉取、删除、去重、服务商删除

| 操作 | 启用状态如何处理 |
|---|---|
| 重新拉取模型 | `provider.repo.ts:168-173` 只改 `models`，不动 `enabled_models`。显式白名单下：新模型默认不启用；老库 `NULL` 下：新模型自动全部启用。 |
| 单个模型 ✕ 从缓存删除 | 同时从 `models` 与显式 `enabledModels` 中移除；`NULL` 保持 `NULL`。 |
| 服务商删除 | 整行删除，启用集自然消失。 |
| 历史重复服务商去重 | `provider.repo.ts:136-166` 目前只合并 `models`；需同时合并启用集：双方 `NULL` → `NULL`；任一方显式 → 合并各自的有效启用集（`NULL` 方按全部 models 计）。 |
| 密钥轮换 / 备份 | 只碰 `api_key_encrypted` 或整库复制，不涉及该列；若存在显式列清单的 JSON 导出，需要补列。 |

失效启用项策略：重新拉取后，显式白名单里可能有 id 已不在 `models` 中。

- 库里保留这些 id（将来模型恢复时启用状态也恢复）。
- 设置页右栏只展示交集，并显示「另有 X 个已启用模型不在当前缓存中」。
- 用户点保存时按 §2.5 与最终 models 求交集，自动清理。
- 不在拉取时立即删除，避免一次接口抖动永久丢掉用户的选择。

---

## 3. 设置页双栏布局

### 3.1 双栏布局

当前「已缓存模型」在表单 `max-w-xl` 容器内，见 `ProviderSettings.tsx:447 / 516-597`。两栏放不下，调整：

- 表单容器 `max-w-xl` → `max-w-3xl`；窄窗口降级为上下堆叠。
- 该字段改为全宽双栏 `grid grid-cols-2 gap-3`，每栏高约 16rem，独立滚动。

```
已缓存模型
┌ 全部模型（37） [搜索…] [启用筛选结果 N] ┐  ┌ 已启用（5）        [全部停用] ┐
│ ☑ Qwen/Qwen3-8B        ✕             │  │ Qwen/Qwen3-8B          ←     │
│   [探测能否派活] [会调工具 4/4] [测一下] │  │ Qwen/Qwen3-VL-8B       ←     │
│ ☐ Qwen/Qwen3.5-9B      ✕             │  │ THUDM/GLM-4-32B-0414   ←     │
│ …                                     │  │ …                            │
└ 未启用 32 个 ─────────────────────────┘  └ 移动在「保存」后生效 ─────────┘
```

分工：

- **左栏 = 缓存全集**：显示全部 `models`，带现有能力探测徽标；✕ 仍是「从缓存删除」，沿用 `provider.removeModel`（`zh.ts:2157`）。
- **右栏 = 启用白名单**：只显示交集；「←」表示停用但保留缓存，与删除区分开。
- 右栏不重复放探测徽标，避免两处状态不同步；探测仍在左栏做。

### 3.2 如何移动

- 主交互：左栏复选框 / 点击行切换；右栏「←」移除。
- 必须 `stopPropagation`：点「测一下 / 探测能否派活」不能顺带把模型切换启用状态。
- 批量：
  - 左栏有搜索时：「启用筛选结果（N）」，避免误以为启用了全部 37 个。
  - 右栏：「全部停用」。
- 拖拽作为后续增强，不作为首版必需；37～500 条模型下复选框更可控。
- 两个方向都保留 `models` 原始顺序，便于对照。
- 是否有未保存变更：在右栏标题旁加一个轻量「未保存」标记；保存/重新选中服务商后清除。

### 3.3 空状态与数量

| 场景 | 左栏 | 右栏 |
|---|---|---|
| 没有缓存模型 | 「暂无，点『拉取模型』」 | 「先拉取模型」 |
| 有模型、全部启用 | 全部勾选 | 正常列表 + 「全部停用」 |
| 有模型、全部停用 | 全部未勾选 | 「还没有启用任何模型；对话页将没有可选模型」 |
| 有模型、部分启用 | 勾选态 | 列表 + 「已启用 5 / 共 37」 |
| 搜索无结果 | 「没有匹配的模型」 | 保持当前选中项；若全空显示提示 |
| 有失效启用项 | — | 「另有 X 个已启用模型不在当前缓存中，保存时清理」 |

标题从 `已缓存模型（37）` 改为 `已缓存模型`，两栏各自带数量，避免两个「37」歧义。

### 3.4 保存与空启用确认

- 移动只在 `editing` 草稿里生效，点保存才落库；与现有表单一致，见 `ProviderSettings.tsx:313-344`。
- 若 `models.length > 0 && 有效启用集.length === 0`，保存前用现有 `useConfirm` 二次确认：「保存后对话页将没有可选模型」。`useConfirm` 已在同文件引入，见 `ProviderSettings.tsx:60 / 321`。
- `handleFetchModels` 只替换 `editing.models`，保留 `editing.enabledModels`；拉取成功后提示「新增 N 个未启用模型」（仅显式白名单时）。
- `emptyProvider()` 增加 `enabledModels: null`，见 `ProviderSettings.tsx:39-50`。

---

## 4. 两级选择器形态

### 4.1 组件形态

新增：

- `src/renderer/src/components/ModelPicker.tsx`：通用两级选择器。

`ModelSelector` 保留现有 props（`providers / targets / onChange / disabled`），只把内部原生 `<select>` 换成 `ModelPicker`，从而不牵动 `ChatView.tsx:964-973` 的调用方。

```
[ 硅基流动 SiliconFlow ▾ ] Qwen/Qwen3-8B        ← 触发器
┌ 搜索型号… ────────────────────────────────┐
│ 模型来源              │ 型号                  │
│ 硅基流动（37）         │ Qwen/Qwen3-8B         │
│ 火山方舟（12）         │ Qwen/Qwen3-VL-8B      │
│ DeepSeek（4）          │ …                     │
│ …                    │                       │
└──────────────────────────────────────────┘
```

- 触发器是按钮，`aria-haspopup="listbox"`；面板 `role="listbox"`，行 `role="option"`。
- 左栏为模型拉取来源（服务商），右栏为该来源下的具体型号。
- 选中值仍是 `providerId:model`，与现有 `ChatTarget` 完全兼容，见 `src/shared/types.ts:1761-1764`。

### 4.2 一级：模型拉取来源（服务商）

- 一级项直接来自 `ProviderRecord`，显示 `p.name` 与启用模型数量，例如「硅基流动（37）」。
- 只列出 `p.enabled === true` 的服务商；停用的来源不出现在选择器里。
- 不再做模型系列品牌推导，不设「其他」兜底分组，不需要品牌规则表或 `model-brand.ts`。
- 来源下没有任何启用模型时，一级项仍显示但置灰，并标注「暂无已启用模型」；选中后右栏给出去设置启用的指引，而不是空白。
- 两个服务商名称完全相同时，在一级项旁补充 `baseUrl` 的主机名（例如 `api.siliconflow.cn`）以示区分；不要求用户先改名。

### 4.3 二级：该来源下的具体型号

- 二级只列当前来源的 `enabledModelsOf(p)`，按 `models` 原始顺序展示。
- 行内展示完整模型 id；若 id 过长，中间截断、保留尾部版本号，完整值放 `title`。
- 正常情况下二级都在同一来源内，来源信息不重复展示。
- 当搜索跨来源展示结果、或同名模型出现在多个来源时，二级行内以灰度后缀标注来源名，例如：
  - `Qwen/Qwen3-8B    硅基流动`
  - `Qwen/Qwen3-8B    火山方舟`
  两者值分别为 `siliconflow-id:Qwen/Qwen3-8B` 与 `ark-id:Qwen/Qwen3-8B`，不会互相覆盖。
- 同一来源内模型 id 唯一，天然去重；跨来源同名靠 `providerId:model` 区分。

### 4.4 选中后的回显

- 触发器显示 `来源 · 型号短名`，例如 `硅基流动 SiliconFlow · Qwen/Qwen3-8B`；`title` 给完整 `服务商 / 模型`。
- 型号过长时中间截断，保留尾部版本号；不把完整 service 前缀塞进触发器。
- 若当前模型已不在启用集：触发器仍显示原值，并标「不可用」，不静默换成别的模型。正常情况下 ChatModule 会先重挑（见 §5.3）。
- 对照模式每个 target 各自一个触发器，互不影响；「+」新增时取第一个未被占用的启用模型，保持现有 `addTarget` 行为（`ModelSelector.tsx:32-40`）。
- 重新打开面板时，一级默认定位到当前 target 的 `providerId`，二级滚动到当前 model；没有当前值时定位到第一个有启用模型的来源。

### 4.5 搜索与跨来源同名

- 打开面板自动聚焦搜索框；搜索匹配「型号 + 来源名」。
- 空查询：标准两级（左来源、右型号）。
- 有查询：左栏只留命中的来源并显示计数；右栏展示该来源下命中项。若当前来源无命中，自动切到第一个有命中的来源，避免右栏空白。
- 同时提供「全部来源（N）」虚拟项：展示跨来源命中结果，按来源分组，每行标注来源；这是跨来源同名模型的主要出现场景。
- 无命中：显示「没有匹配的模型」，保留搜索词。
- `Esc`：有搜索词先清空，再按一次关闭；关闭后焦点回到触发器。
- 搜索状态只存在于当前 picker 实例，对照模式下各 target 独立。
- 选中搜索结果时同时写入 `providerId` 与 `model`，下次打开面板定位到对应来源与型号。

### 4.6 接入点

| 位置 | 改造 |
|---|---|
| 主窗口 `ModelSelector.tsx:56-121` | 内部换成 `ModelPicker`，空态文案三分 |
| 浮窗 `PopupApp.tsx:678-708` | 两个下拉换成一个 `ModelPicker`，面板向上展开 |
| 助手编辑器 `AssistantEditor.tsx:264-282` | 「跟随当前」保留为独立选项，具体模型走两级 |
| 渠道模型 `ChannelsPanel.tsx:491-497` | 走两级或至少只读启用集，按 §1.3 口径 |
| 知识库问答 `KbAskPanel.tsx:543-566` | 本期不改，继续全量缓存 + 手输兜底 |

### 4.7 可访问性与回归

- 键盘：`↑/↓` 在型号列表移动，`←/→` 切来源，`Enter` 选中，`Esc` 关闭/清搜索。
- 点击外部关闭；面板在浮窗内要处理 `z-index` 与向上展开。
- 现有测试按原生 `combobox` 断言，见 `tests/renderer-model-selector-empty.test.tsx:27-70`，需同步改为按钮 + listbox 查询。

---

## 5. 联动与空态

### 5.1 启用集直接决定前端可选范围

统一入口：

```ts
hasUsableModel(p)      // 改为 enabledModelsOf(p).length > 0
isTargetStillValid(t)  // 改为 enabledModelsOf(p).includes(t.model)
ModelSelector options  // enabledModelsOf(p)
```

`provider-pick.ts` 是默认选择规则的唯一出口，见 `src/renderer/src/utils/provider-pick.ts:11-46`。只改这一处，聊天主链路、浮窗、助手编辑器就能共享同一口径。

### 5.2 切换或清空时的行为

- 设置页保存后，对话模块下次 `reactivate` 会重新拉取 provider 清单，见 `ChatModule.tsx:459-507`。当前选择仍有效（模型仍在启用集）就不动；失效则按 `pickDefaultProvider` 重挑。
- 当前服务商还有其它启用模型：保留服务商，挑第一个非 embedding 的启用模型。
- 当前服务商一个启用模型都没有：切换到其它有启用模型的服务商。
- 全部服务商都没有启用模型：`targets = []`，输入框禁用，顶栏保留一个「未启用任何模型」的触发器/提示，而不是整条栏消失。
- 不静默帮用户重新启用模型；只给出「去设置启用」的指引。
- 目前没有 provider 变更广播事件；同一窗口内模块切换会触发 `reactivate`，浮窗按需创建，因此首版不需要新增广播。

### 5.3 历史会话与助手默认模型

- `ChatModule.tsx:616-625` 现在用 `prov.models.includes` 校验历史模型；改为启用集。
- 若历史模型已被停用：保留当前默认选择，并给一条可见提示「该会话上次使用的模型已停用，已保留当前选择」，避免用户以为模型被静默换掉。
- 助手默认模型同理：旧助手可能配置了已停用模型，应用默认时回退到当前全局选择，并给出同一条提示，见 `ChatModule.tsx:607-611`。
- 不把「已停用模型」自动重新启用；用户的选择优先。

### 5.4 空态三分

`hasUsableModel` 改为启用集后，`ChatView.tsx:755-760` 的 `noModelsAtAll` 会同时覆盖「没缓存」和「没启用」，必须拆成两个布尔值，并让 `Composer.tsx:1062` 选对文案。

| 状态 | 文案 key |
|---|---|
| 没有启用的服务商 | `ms.notConfigured` |
| 有服务商但没有任何缓存模型 | `ms.noModels` |
| 有缓存模型但一个都没启用 | 新增 `ms.noEnabledModels` |
| 输入框占位（有缓存但未启用） | 新增 `composer.noEnabledModels` |

极端情况允许存在：用户在设置里把所有模型都停用是合法意图，不应被强制阻止。防护：

1. 保存前二次确认（§3.4）。
2. 对话页显示明确空态，而不是「未配置服务商」或空白。
3. 发送按钮禁用，不出现空 `model` 请求。
4. 顶栏保留一个可见入口，方便用户知道去哪里恢复。

### 5.5 多窗口刷新

- 设置页与对话页同一窗口内通过模块切换触发 `reactivate`，首版足够。
- 若后续支持设置与对话分属两个窗口，再补 provider 变更广播；本期不引入新事件通道。

---

## 6. 兼容与回退

### 6.1 老用户打开后是什么状态

- 升级后 `enabled_models` 为 `NULL` → 左栏全部模型、右栏也全部模型（全部启用）。
- 对话页可选列表与升级前完全一致，不会出现「升级后模型没了」。
- 用户第一次移动时，才把 `NULL` 物化成显式数组。

### 6.2 降级兼容

- 旧版本代码不读 `enabled_models`，其 `UPDATE providers SET ... models=?, enabled=?` 是显式列清单，不会覆盖新列，见 `provider.repo.ts:114-117`。
- 旧版本新建 provider 的 INSERT 不包含该列 → 新行为 `NULL`，语义正确。
- 降级后重新拉取模型只改 `models`，启用集仍保留。

### 6.3 一个模型都没有可选

会出现，且按 §5.4 允许。关键是三件事同时成立：

- 保存时有确认，不让人误操作后完全无感知。
- 对话页明确区分「没配置」「没拉取」「没启用」。
- 不崩溃、不发送空 model 请求、不把责任推给「未配置服务商」。

### 6.4 备份与恢复

- 整库备份会自动带上新列。
- 恢复旧备份到新版本：旧库没有该列，迁移补 `NULL`，行为回到「全部启用」。
- 若存在按列导出的 JSON 备份/迁移逻辑，需确认并补列。

---

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `NULL` 与 `[]` 混淆 | 老用户升级后突然无可选模型 | 三态严格区分；坏 JSON 降级 `NULL`；单测覆盖 |
| `save` 的 `undefined` 语义 | 首启向导等调用方误清空白名单 | `undefined` 保留旧值；只有设置页显式发送数组 |
| 去重路径清空白名单 | 同 baseUrl 重复保存导致启用集丢失 | 复用 `foundByDedupe` 空数组保护 |
| 全局过滤范围过大 | 知识库嵌入/图像/翻译无可选模型 | 按 §0 作用域执行；共享 helper + 消费点清单 |
| 重新拉取丢掉选择 | 远端抖动导致用户启用项永久消失 | 拉取不删启用集；只展示交集；保存时清理 |
| 两级选择器替换原生 select | 键盘/读屏/浮窗层级回归 | 统一组件、焦点管理、更新现有测试 |
| 同名服务商 | 一级难以区分 | 一级补充 `baseUrl` 主机名 |
| 来源下没有启用模型 | 右栏空白，用户以为坏了 | 一级置灰 + 右栏引导文案 |
| 跨来源同名模型 | 两个选项看起来一样 | 二级行内标注来源；值用 `providerId:model` |
| 500 条模型渲染 | 面板卡顿 | 分组 memo；列表限高滚动；无需虚拟列表 |
| 历史会话模型被停用 | 用户以为模型被静默替换 | 保留当前选择并提示；不静默切换 |
| 四语文案遗漏 | 新状态显示 key | zh/en/ja/ko 同步，跑 i18n key 一致性测试 |

---

## 8. 实施顺序 P1–P6

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 迁移 v76、`ProviderRecord.enabledModels`、schema、repo 读写规则、共享 `enabledModelsOf` | 老库打开行为不变；repo 单测覆盖 NULL/[]/undefined/去重/坏 JSON |
| P2 | 设置页双栏 UI、搜索、批量、空态、保存前零启用确认 | 移动/保存/重新拉取/删除缓存行为正确；未保存标记可见 |
| P3 | 对话链路切到启用集：`provider-pick`、`ChatModule` 默认挑选、`ModelSelector` 选项、空态三态 | 停用一个模型后切回对话页，该模型不再出现；全部停用有明确空态 |
| P4 | 新增 `ModelPicker`，以「来源 → 型号」两级替换主窗口 `ModelSelector` 内部 | 来源分组、跨来源同名标注、搜索、回显、对照模式通过 |
| P5 | 浮窗、助手编辑器、Composer 备用模型、渠道模型接入 | 所有对话类入口只出现启用模型 |
| P6 | 历史会话失效提示、失效启用项提示、四语文案、回归测试 | typecheck / vitest / build 三件套通过 |

先做 P1 再做 P2，可以确保数据层可回退；P3 是行为切换点，但默认 `NULL`＝全部启用，未动过设置的用户无感知。

---

## 9. 验收清单

### 数据层

- 老库升级后 `enabled_models IS NULL`，`enabledModelsOf` 返回全部 `models`。
- 显式 `[]` 返回空；显式数组按 `models` 顺序返回交集。
- 损坏 JSON 降级为 `NULL`，不是 `[]`。
- `save` 省略字段保留旧值；显式空数组在去重命中时保留旧值；带 id 时允许清空。
- `fetchModels` 不改变启用集；`deduplicate` 正确合并。
- 迁移重复执行幂等。

### 设置页

- 37 个模型的左右移动、搜索、批量启用/停用。
- 点探测徽标不会误切换启用状态。
- 全部停用保存有确认；保存后重新打开状态保持。
- 重新拉取后新增模型出现在左栏；显式白名单下默认不启用。
- 删除缓存模型同时从启用集移除。

### 前端

- 三种空态文案正确：未配置 / 无缓存 / 无启用。
- 停用当前选中模型 → 切回对话页自动重挑或明确提示。
- 两级菜单：一级为来源（服务商），二级为该来源型号；无品牌推导、无「其他」分组。
- 跨来源同名模型在二级行内标注来源，两者可分别选中。
- 搜索、键盘、浮窗向上展开正常。
- 对照模式新增/移除 target 正常。
- 历史会话使用已停用模型时的回退与提示。

### 工程

- `typecheck`、`vitest`（现有基线 117 文件 1746 用例）、`build`。
- 更新 `tests/renderer-model-selector-empty.test.tsx:27-70`、`tests/renderer-provider-settings.test.tsx:57-77`。
- zh / en / ja / ko 四语 key 对齐。
