# WorkBuddy 三项做法在 PocketAI 的落地方案

- 状态：只读调研 + 方案，未改任何代码、未提交、未推送、未运行测试
- 日期：2026-11-09
- 输入：`docs/research-workbuddy.md`（已读到，结论以其「可借鉴清单」为准）
- 说明：文中路径与行号为本轮调研时的位置，实施前需按最新代码复核

## 0. 一页结论

| 条目 | 结论 | 与现有设计的冲突 |
| --- | --- | --- |
| A. 每类窗口骨架 + 主题/账号快照首绘 | **部分适用**。PocketAI 没有账号体系，「账号快照」不成立；真正的首绘问题是列表/消息没有加载态、ja/ko 首绘语言闪、浅色主题窗口底色写死深色、切换会话会短暂显示上一个会话的消息。骨架只建议做「主窗口 + 独立窗口」两类，解锁窗与浮窗不建议套。 | 无破坏性冲突；主题需要新增一条 renderer→main 的 KV 镜像链路，主进程才能在建窗时选底色 |
| B. 会话与运行态拆分 | **方向正确，可落地，但不要照搬「删列」**。`conversations.status` 现在只写不读，属于「身份表里塞运行态」的既成事实；但删列会破坏导出/导入与降级兼容，应「停止作为事实来源 + 保留列」。先修 `touch()` 的副作用，再做运行态读模型。 | 「待确认」依赖审批链路补一条 settle 广播；未读口径已由 D3 拍板 |
| C. 审批顺序 | **现有实现已覆盖大半**：硬拒绝优先、`auto-safe` 只放过非危险命令、无人值守拒绝、超时拒绝、MCP 默认询问、破坏性注解强制询问。真正的洞只有 3 个：会话级「总是允许」能放过 danger、MCP 危险工具没有风险等级且仍可勾「总是允许」、策略读取失败落到 `deny(BAD_ARGS)` 而不是「继续询问」。 | PocketAI 没有「计费类工具」，不能硬套；D6 已定只保留 `danger`「不可逆/高副作用」档 |

**必须做的前置**（跨条目）：

1. B-1 `touch()` 语义拆分（否则运行态角标会伴随错误的排序/取消归档）。
2. C-1 风险档 `forceConfirm`（否则 B 的「待确认」角标没有稳定判定依据）。
3. A-1 列表加载态 `listState`（A 与 B 共用同一份 list hook，先落最小改动）。

**可延后**：A-4 锁屏/向导快照、B-4 未读、B-5 停写/删 `status`、C-3 计费档、C-4 MCP 手工试运行审批。

---

## 1. 调研基线（现状事实）

### 1.1 窗口与首屏

| 事实 | 证据 |
| --- | --- |
| 主窗口 `show:false`，等 `ready-to-show` 才显示；底色写死 `#1e1e2e` | `src/main/index.ts:116-134` |
| 12s 兜底强制显示，避免 `ready-to-show` 不触发时永久空桌面 | `src/main/windows/boot-guards.ts:157-178` |
| 解锁窗 420×440、独立窗同样固定底色、浮窗透明 | `src/main/windows/unlock-window.ts:36-54`、`src/main/windows/detached.ts:15-36`、`src/main/popup.ts:213-223` |
| HTML 先执行 `theme-init.js` 再挂 React；无内联 splash/骨架标记 | `src/renderer/index.html:7-11`、`src/renderer/public/theme-init.js` |
| 主题只恢复 `light` class；`<html lang>` 只处理 `en`，ja/ko 不处理 | `theme-init.js:6-9` |
| 语言词典按需异步加载，ja/ko 会先以中文渲染再切换 | `src/renderer/src/i18n/index.tsx:19-33,52-64` |
| `boot()` 前注入偏好是 `void` 调用，不阻塞首绘 | `src/renderer/src/main.tsx:62-65,99-112` |
| 首屏同步渲染外壳，没有全局 skeleton；只有模块级 `Suspense` 的「…」占位 | `src/renderer/src/App.tsx:190-248`、`src/renderer/src/components/Workspace.tsx:7-29` |
| 会话列表初值是 `[]`，hook 没有 `loading` 状态 | `src/renderer/src/modules/chat/useConversationLists.ts:47-62` |
| 首屏列表是串行的：`listAssistants` → `cleanupEmptyConversations` → `reloadConversations` | `src/renderer/src/modules/chat/ChatModule.tsx:421-441` |
| 切换会话只 `setCurrentConvId` + 异步 `loadMessages`，不先清空/标记加载；迟到响应有守卫，但**新响应到达前仍渲染旧会话消息** | `ChatModule.tsx:700-710`、`ChatModule.tsx:244-262`、`ChatModule.tsx:1966-1993` |
| `locked` 初值 `false`，锁状态异步读取；加密态有 `dbEncKnown` 三态，锁状态没有 | `src/renderer/src/store/app-store.ts:160-163`、`App.tsx:100-128` |
| 首次向导完成标记在本地配置里，但读取在挂载后 | `src/main/db/repositories/app-config.repo.ts:57`、`App.tsx:130-140` |
| License/账号不在首屏读取（只在设置/导出路径） | `src/main/ipc/handlers/license.ts`、`app-config.repo.ts` |

结论：正常路径不会「白屏」（窗口在首帧后显示），但存在四类可观察的首绘缺陷：空状态闪、语言闪、浅色主题底色闪、跨会话旧消息闪。WorkBuddy 的「账号快照」在 PocketAI **没有对应物**。

### 1.2 会话与运行态

| 事实 | 证据 |
| --- | --- |
| `conversations` 初始列：`id/assistant_id/title/model/params/status/created_at/updated_at` | `src/main/db/database.ts:51-60` |
| 后续迁移新增 `pinned/archived/archived_at/title_default/group_id/note/system_prompt_override/parent_conversation_id/role_key`；`agent_mode` 在 v57 | `database.ts:570-600`、`ChatModule.tsx:78-85` |
| 当前最新 schema 版本 v59 | `database.ts:985-1013` |
| `agent_traces` 是**步级日志**：`request_id/parent_request_id/step_index/step_type/token_usage/status/created_at` | `database.ts:74-86`、`src/main/db/repositories/agent-trace.repo.ts:28-54` |
| `listRuns` 从 traces 反推每次 run 的起止/步数/token/错误步 | `agent-trace.repo.ts:293-367` |
| `conversations.status` 在聊天与 Agent 两条链路都会被写（`streaming/done/error/aborted`） | `src/main/chat/chat-service.ts:338,393,411,469,486`、`src/main/agent/engine.ts:1367-1373,1601,1627,1654` |
| **渲染层完全不读 `conversations.status`**；列表只显示置顶/草稿/Agent 三个角标 | `src/shared/types.ts:155-170`、`src/renderer/src/modules/chat/ConversationList.tsx:997-1012` |
| `touch()` 每次写状态都会 `updated_at=now` 且**强制取消归档** | `conversation.repo.ts:295-316` |
| 运行态只在渲染进程内存：`agentRunning/agentStream/liveSteps/isStreaming`，且按 `requestId` 过滤 | `src/renderer/src/modules/chat/useStreamSession.ts:98-110,126-231` |
| `busyModules` 只做「繁忙模块免于 LRU 淘汰 + 快捷键守卫」，**不是可见角标**；由 ChatModule 的流式态驱动 | `src/renderer/src/store/app-store.ts:63,101-115,132-140`、`ChatModule.tsx:367`、`useGlobalShortcuts.ts:28` |
| 主进程已有 Agent 专用的内存并发表（每会话一个活跃 run） | `src/main/agent/engine.ts:1146-1217` |
| 崩溃恢复只清理 `messages.status='streaming'`，**不清理 `conversations.status`** | `database.ts:1153-1156`、`src/main/index.ts:93,272` |
| `approval_events` 只在决策后落库，`pending` 无法从库里恢复 | `database.ts:870-895` |
| 没有「消息未读」实现；现有 `unread` 标识是**列表读取失败**标记（`ListUnread`），不是未读消息 | `useConversationLists.ts:18,37-52`、`ConversationList.tsx:651-655,707,796` |

### 1.3 审批与工具策略

| 事实 | 证据 |
| --- | --- |
| 审批弹窗：允许/拒绝/本次会话总是允许；5 分钟无应答按拒绝 | `src/renderer/src/components/ToolApprovalDialog.tsx:1-6,64-83,171-215` |
| 危险工具也提供「本次会话总是允许」勾选 | `ToolApprovalDialog.tsx:176-188` |
| 主进程审批：先查会话白名单，命中直接放行；否则广播等待 | `src/main/agent/tool-approval.ts:98-181`（白名单检查在 129-133） |
| 超时/中止均按拒绝并审计 | `tool-approval.ts:160-171` |
| 工具判定 = 基线权限 + 动态判定取更严；`deny > confirm > allow` | `src/main/tools/registry.ts:297-330,413-416` |
| 动态判定抛异常时统一 `deny(BAD_ARGS)` | `registry.ts:324-326` |
| shell 硬拒绝规则（系统目录删除、根目录递归删除等）优先于策略 | `src/main/tools/shell-tools.ts:97-120` |
| shell 确认规则（删除、覆盖、提权、注册表、发布、下载执行等） | `shell-tools.ts:132-173` |
| shell 策略只有 `confirm` / `auto-safe`；`auto-safe` 仍对危险命令确认 | `src/main/tools/shell-config.ts:16-21` |
| 策略读取依赖 `appConfigRepo.get`，后者可能抛错（未捕获） | `shell-config.ts:16-21`、`app-config.repo.ts:274-283` |
| MCP 工具：`destructiveHint/openWorldHint`/危险关键词强制 `confirm`；只读前缀 + `trustReadOnly` 才可能 `auto` | `src/main/mcp/manager.ts:116-130,647` |
| `trustReadOnly` 是 MCP 服务器表单里的显式开关 | `src/renderer/src/modules/agent/mcp/McpPanel.tsx:146` |
| 审批展示里 `risk='danger'` **只对 shell DANGEROUS_ 生效**；MCP 破坏性工具仍是 `custom` | `src/main/agent/engine.ts:934-983` |
| 无人值守（渠道/远程）遇到 confirm 一律拒绝，不弹窗 | `engine.ts:2260-2284` |
| 「MCP 授权中心」实际在技能页能力中心 + 助手编辑器的 MCP 组，不在设置页 | `src/renderer/src/modules/skills/CapabilityCenter.tsx:1-8`、`registry.ts:123-177` |
| 无「计费类工具」；只有全局用量预算 | `src/main/ipc/handlers/usage.ts`、`app-config.repo.ts:61-64` |

### 1.4 闸门与测试基线

- 闸门：`npm run typecheck`、`npm run test`、`npm run build`（`package.json` scripts）。
- 用例基线：上次统计 117 文件 / 1746 用例，以本轮执行结果为准。
- 与本次相关的既有用例（需按条目核对）：
  - 审批：`tests/tool-approval.test.ts`、`tests/tool-approval-session.test.ts`、`tests/approval-events-engine-e2e.test.ts`、`tests/mcp-annotations-236.test.ts`、`tests/agent-fs-write-approval-chain-231.test.ts`、`tests/renderer-tool-approval-hint.test.tsx`、`tests/tool-policy-screen-417.test.tsx`、`tests/tool-policy-i18n-parity-417.test.ts`
  - 会话：`tests/conversation-repo.test.ts`、`tests/conversation-agent-mode-real-db-439.test.ts`、`tests/conversation-agent-label-v59-encrypted-upgrade-real-db.test.ts`、`tests/agent-conversation-guard-459.test.ts`、`tests/agent-list-runs-real-db-459.test.ts`
  - 首屏/列表：`tests/ipc-chat-list-read-260.test.tsx`、`tests/i18n-term-registry.test.ts`

---

## 2. 条目 A：每类窗口骨架屏 + 主题/状态快照首绘

### A.0 与 WorkBuddy 的映射差异（先对齐口径）

| WorkBuddy 做法 | PocketAI 对应物 | 是否照搬 |
| --- | --- | --- |
| 主进程在 HTML 解析阶段注入 `windowTheme`/`windowBackgroundLight/Dark` | 主题只存 renderer `localStorage`，主进程不知道 | **做**：主进程需要 KV 镜像才能选窗口底色 |
| `?accountSnapshot=` 注入 `window.__initialAccount`，跳过 `getAccount` | 无账号体系；License 不在首屏；等价状态是「锁屏/加密/首启向导」 | **不照搬账号**；锁屏/向导快照列为可延后 |
| 每类窗口独立骨架、与最终布局同构 | 4 类窗口：主窗、解锁窗、独立窗、浮窗 | **只做主窗 + 独立窗**；解锁窗是固定表单、浮窗透明，套骨架收益低 |
| 侧栏骨架条目 24/28px 级同构 | 侧栏行高由 conv row 决定 | **做**：骨架行复用同一行高与内边距 |

### A.1 改动清单

**A-1（必须，A/B 共用前置）列表与消息加载态**

- `useConversationLists.ts`：新增 `listState: 'idle'|'loading'|'ready'|'error'`，在 `reloadConversations` 开始/结束/失败时更新；保留现有数据，切换助手时不要把旧列表当新列表展示。
- `ChatModule.tsx`：新增 `messagesConvId` 与 `messagesState`。`loadMessages` 开始时若 `messagesConvId !== convId`，先清空可见消息并进入 loading；渲染层只在 `messagesConvId === currentConvId && messagesState==='ready'` 时把 `messages` 传给 `ChatView`。
- `ConversationList.tsx`：`loading && conversations.length===0` 时渲染 6–8 行骨架（形状与真实行一致），**不要**渲染「暂无会话」空态。现有空态条件已经排除「读取失败」（`ConversationList.tsx:707,796` 的 `!conversationsUnread`），加载态要加进同一个条件，避免 loading 时误判为空。
- 新增 `src/renderer/src/components/Skeleton.tsx`：纯形状组件，不带文案（避免新增 i18n key），支持 `prefers-reduced-motion`。
- 骨架延迟 120ms 出现：数据在 120ms 内返回则直接渲染，避免快机器上的闪烁。

**A-2（必须）主题首绘**

- 新增 `app_config` KV：`ui.theme`（`'light'|'dark'`）。`app_config` 是 KV 表，**无需 schema 迁移**。
- `ThemeLangControls.tsx`：切换主题时同时写 `localStorage` 与 `window.pocketai.setUiTheme(theme)`（新增 IPC；preload、shared 类型、handler 三处同步加）。
- 主进程新增 `windowBackground(theme)` 帮助函数，建窗前读取 `ui.theme`（有进程内缓存），替换 `src/main/index.ts:123`、`unlock-window.ts:46`、`detached.ts:21` 的固定 `#1e1e2e`；`popup.ts` 保持透明。
- 保留 `theme-init.js` 作为兜底；主进程读不到时退回当前深色，不阻塞建窗。

**A-3（必须）语言首绘**

- `theme-init.js`：`lang` 映射补 `ja`、`ko`（与 `i18n/index.tsx` 的 `readInitialLang` 保持一致）。
- `main.tsx boot()`：非中文语言先 `await ensureLang(lang)` 再 `renderApp()`，上限 150ms；超时按中文兜底并继续渲染，避免拖慢启动。`ensureLang` 目前在 `i18n/index.tsx:27-33` 未导出，需导出或新增 `preloadLang(lang)`，避免把内部实现暴露给调用方。
- `theme-init.js` 由 `index.html` 与 `unlock.html` 共用（`theme-init.js:1-4`），改动对两个窗口同时生效。
- 只预加载「当前语言」一个词典，不预热全部语言。

**A-4（可延后）锁屏/向导状态快照**

- `app-store.ts` 增加 `lockKnown` 三态：未知时主内容渲染骨架且 `inert`，已知且未锁才渲染内容；读取失败时按「未锁」继续（保持现有可用性优先）。
- 首启向导：在 `boot()` 前从 `localStorage` 镜像读一次 `wizardDone`，避免首帧先渲染主界面再弹向导；镜像缺失时保持现状。
- 说明：主窗在解锁完成后才创建（`src/main/index.ts` 启动序列），因此该问题只在「运行中锁屏事件晚于内容挂载」的边界场景可观察，优先级低于 A-1/A-2/A-3。

**A-5（可延后）独立窗口模块骨架**

- `Workspace.tsx` 的 `ModuleFallback` 目前是一个 `animate-pulse` 的「…」。可改为每模块的头部 + 内容两段骨架，但需要每个模块给尺寸；建议等主窗骨架稳定后再做。

### A.2 数据与迁移

- 无 schema 迁移；只新增 `app_config` 的 `ui.theme` KV。
- `localStorage` 仍是主题/语言的第一事实来源；`ui.theme` 只是主进程建窗用的镜像，丢失不影响功能。

### A.3 用例与闸门影响

- 新增 renderer 用例：
  - `listState='loading'` 时不渲染空态、渲染骨架行数正确。
  - `listState='ready'` 时骨架消失且行高与真实行一致（可用 `getBoundingClientRect` 或快照类名断言）。
  - 切换会话时 `messagesConvId !== currentConvId` 不渲染旧消息。
  - 主题 IPC 写入失败时 UI 主题仍切换（降级不断功能）。
- 新增主进程用例：`ui.theme=light` 时建窗底色为浅色 token；KV 缺失时为深色。
- i18n：骨架不新增文案；若给骨架加 `aria-label`，必须四语言同步并通过 `i18n-term-registry`/parity 测试。
- 闸门：`typecheck` / `vitest` / `build` 全绿；preload IPC 白名单若有快照测试需同步更新。

### A.4 可观测验收标准

1. 在 dev 环境给 `chat.listConversations` / `chat.listAssistants` 注入 2s 延迟：首帧出现骨架行与消息骨架，**不出现**「暂无会话」；数据到达后无跳变（真实行与骨架行高差 ≤2px）。
2. 持久化 `ui.theme=light` 后冷启动：主窗 `BrowserWindow.getBackgroundColor()` 为浅色 token；录屏首 3 帧无深色底。
3. 语言设为 ja/ko 冷启动：加载完成时 `document.documentElement.lang` 正确；词典在 150ms 内加载成功时不出现中文闪烁，超时则按设计回退中文（日志可见 `langFallback`）。
4. 会话 A 消息很多时切到 B，并给 `chat.listMessages` 注入 1s 延迟：B 面板任何时刻都不显示 A 的消息，显示骨架。
5. 上述行为在解锁窗、浮窗不引入新骨架、不改变现有布局。

### A.5 风险与回滚

- 风险 1：快机器骨架闪烁 → 120ms 延迟阈值；可在常量里关掉。
- 风险 2：语言预加载拖慢启动 → 150ms 上限；超时即渲染。
- 风险 3：新增 IPC 扩大攻击面 → 只允许 renderer 写 `'light'|'dark'` 枚举；handler 侧校验，不接受任意 key。
- 风险 4：主进程读 KV 失败 → 退回固定深色，不影响启动。
- 回滚：A-1/A-2/A-3 各自独立提交，均无数据迁移；回退代码即可。`ui.theme` 残留 KV 对旧版本无影响。

---

## 3. 条目 B：会话与运行态拆分

### B.0 先说不冲突的部分与冲突点

- `conversations.status` 确实违反「会话表只存身份与配置」，但**现在不能删**：
  - 导出/导入会读写该列（`conversation.repo.ts:436-450`）；
  - 旧版本遇到更高 `schema_migrations` 不报错，但删列会让旧版本的导出/插入失败；
  - 现有多条 real-db 用例围绕 v57/v59 升级编写。
  - 结论：**保留列，停止把它当事实来源**；删列留到下一个大版本。
- `agent_traces` 已经是「运行日志」，`listRuns` 能反推 run 统计；但它**不能回答「现在是否在跑」**，也不覆盖普通聊天 run。因此运行态需要一个单独的读模型，而不是再拼 traces。
- 主进程已有 Agent 专用的活跃 run 表（`engine.ts:1146-1217`），可作为运行态注册表的起点，但需要扩展到聊天 run 与审批态。
- 渲染层已有 `busyModules`（`app-store.ts:63,101-115,132-140`），但它只用于「繁忙模块不被 LRU 淘汰 + 快捷键守卫」，既不跨窗口也不可见；不能当作侧栏状态角标。
- 「待确认」不能从 `approval_events` 恢复（只记决策后），因此它天然是**活态**：App 重启后不应显示「待确认」，应把未完成的 run 标为「已中断」。

### B.1（必须）先拆 `touch()` 的副作用

- 新增 `conversationRepo.setRunStatus(id, status)`：只更新 `status`，**不**改 `updated_at`、**不**清 `archived`。
- 新增 `conversationRepo.setRunMeta(id, {modelLabel?, agentMode?})` 或在现有 `touch()` 上加 `bumpUpdatedAt/unarchive` 开关（推荐显式方法，避免调用点误用）。
- 替换写入点：`engine.ts:1367-1373,1601,1627,1654`、`chat-service.ts:338,393,411,469,486`。
- 保留 `touch()` 给「用户可见消息写入」使用。
- 行为变化：run 开始/结束不再改变侧栏排序、不再把归档会话顶回列表。这正是 WorkBuddy 侧栏角标成立的前提。

### B.2（必须）主进程运行态读模型

- 新增 `src/main/chat/runtime-registry.ts`（新文件）：
  - `Map<conversationId, { requestId, mode:'chat'|'agent', state:'running'|'pending_approval'|'failed', startedAt, errorCode? }>`
  - 由 chat-service/engine 的状态迁移驱动；审批请求/决策驱动 `pending_approval`。
  - 并发约束沿用现有「每会话一个活跃 run」（`agent-conversation-guard-459`）。
- 新增 IPC：
  - `chat.getRuntimeStates()`：窗口挂载时取快照（独立窗后开也能对齐）。
  - `CHAT_RUNTIME_STATE_EVENT`：状态变化广播到所有主渲染窗口。
  - 事件需要带 `conversationId`、`requestId`、`state`、`at`；不携带任何消息内容。
- 渲染层新增 `conversation-runtime-store.ts`（zustand）：合并快照与事件；窗口 focus 时重新拉一次快照兜底。
- `ConversationList.tsx` 在现有角标位（`997-1012`）增加：进行中（转圈/脉冲点）、待确认（高亮 + 数字）、失败（红色点）。未读留到 B-4。
- 「失败」清除策略：打开该会话或用户点掉角标后清除；不设自动过期，避免静默丢失。

### B.3（必须，D4 已定持久化）可恢复的 run 头

- 迁移 v60：新增 `conversation_runs`：

```sql
CREATE TABLE IF NOT EXISTS conversation_runs (
  request_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('chat','agent')),
  status          TEXT NOT NULL CHECK (status IN ('running','pending_approval','done','failed','aborted','interrupted')),
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  error_code      TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversation_runs_conv ON conversation_runs(conversation_id, started_at DESC);
```

- 写入时机：run 开始插入 `running`；审批挂起更新 `pending_approval`；结束更新终态。
- 启动恢复：在 `sweepStaleStreamingMessages` 之后（`src/main/index.ts:93,272`）执行 `reconcileInterruptedRuns()`，把 `running/pending_approval` 改为 `interrupted` 并写 `ended_at=now`。
- 不做历史回填：旧 run 只在 `agent_traces` 里，保留现状并在文档注明。
- 删除会话时级联删除（`conversationRepo.delete` 内加一条 DELETE）；保留最近 N 条可按需处理。

### B.4（可延后）未读

- 需要先定口径（D3）：只算助手消息还是所有消息、打开即已读还是窗口聚焦才已读、锁屏时是否算已读。
- 方案一（推荐，符合「身份表干净」）：迁移 v61 新增 `conversation_read_state(conversation_id TEXT PRIMARY KEY, last_read_at INTEGER NOT NULL)`；列表查询 `LEFT JOIN`，用「最后一条助手消息时间 > last_read_at」判定。
- 方案二：`conversations.last_read_at` 单列，简单但把用户态塞回身份表，与条目目标相悖。
- 标记已读：会话被选中且窗口可见时更新；锁屏/窗口不可见不更新。
- 命名避开现有 `ListUnread`（那是「列表读取失败」），建议用 `messageUnread`/`unreadCount`，并在 `ConversationRecord` 里加 `unreadCount?: number`（仅 list 查询带出）。
- 登录/多设备不在范围内（PocketAI 无账号）。

### B.5（可延后）`status` 退役

- 阶段 1：停止读取（本条目已达成）。
- 阶段 2：停止写入（B-1 完成后可选，需先确认导出/导入与降级策略）。
- 阶段 3：删列/迁移（下一个大版本再议）。
- 本批**不删列**。

### B.6 数据与迁移

- v60（必须，D4 已定持久化）：`conversation_runs` + 索引。
- v61（可选）：`conversation_read_state`。
- 无回填；回退时新表可留在库中，旧版本会忽略（迁移器不校验更高版本）。
- 必须补 real-db 升级用例：v59 → v60（明文 + 加密变体），参照 `conversation-agent-label-v59-encrypted-upgrade-real-db.test.ts`；索引存在性参照 `agent-traces-indexes-real-db.test.ts`。

### B.7 用例与闸门影响

- `tests/conversation-repo.test.ts`：`touch()` 语义变化会影响「状态写入是否更新时间/取消归档」断言，需拆分用例覆盖新方法。
- `tests/conversation-agent-mode-real-db-439.test.ts`：确认 Agent 开始时 `agent_mode/model_label` 仍写入，且不再由 `setRunStatus` 承担。
- `tests/agent-conversation-guard-459.test.ts`：并发约束不变。
- 新增：`runtime-registry` 单测（状态迁移、审批挂起、终态清理）、`conversation-runs` real-db（含加密）、渲染层角标（fake timers）。
- 闸门：`typecheck` / `vitest` / `build`；新增迁移必须有过期库升级用例。

### B.8 可观测验收标准

1. 会话 A 发起 Agent run，切到 B：A 在 200ms 内出现「进行中」角标；run 结束后 500ms 内消失；侧栏顺序不变。
2. A 触发审批后切到 B：A 显示「待确认」；允许/拒绝/5 分钟超时后 1s 内消失；`approval_events` 有对应决策记录。
3. 从渠道/远程发起 run（ChatModule 未参与）：侧栏仍能显示「进行中」，结束后清除（验证不再被 `requestId` 过滤丢弃）。
4. 运行中强杀进程后重启：无「进行中」；A 显示一次「已中断/失败」；`conversation_runs` 中该行 `status='interrupted'`；`messages` 无残留 streaming。
5. 归档会话收到后台 run：仍保持归档，不被顶回列表，不改变 `updated_at`。
6. 独立窗口打开时：`getRuntimeStates()` 快照与主窗一致。

### B.9 风险与回滚

- 风险 1：状态事件丢失导致角标不消失 → 快照 + focus 重拉兜底；终态同时写库，可在下次启动纠正。
- 风险 2：`touch()` 拆分漏改调用点 → 全仓 grep `touch(` 与 `status:` 复核；补一条「状态写入不影响 updated_at/archived」的单测。
- 风险 3：迁移失败 → 用 `table_info` 守卫（沿用 v58 的做法），real-db 用例覆盖 v59→v60。
- 风险 4：行为变化（归档不再自动恢复）可能不符合部分用户预期 → D5 已定「不再自动取消归档」，按拍板执行；回退只需恢复 `touch()` 调用。
- 回滚：B-1 可单独回退；B-2 纯内存无数据痕迹；B-3 回退代码后新表残留但被旧版本忽略；B-4 回退后角标消失但已读数据不影响主流程。

---

## 4. 条目 C：审批顺序（高风险强制询问）

### C.0 已覆盖与真实缺口

已覆盖（不要重复造）：

- 硬拒绝优先于任何策略（`shell-tools.ts:97-120`）。
- 动态判定与基线取更严（`registry.ts:413-416`），`auto-safe` 只放过非危险命令（`shell-config.ts:16-21`）。
- 无人值守遇到 confirm 一律拒绝（`engine.ts:2260-2284`）。
- 审批超时/中止按拒绝并审计（`tool-approval.ts:160-171`）。
- MCP 默认 `confirm`，破坏性/开放世界注解禁止 `auto`（`manager.ts:116-130`）。

真实缺口：

1. **会话级「总是允许」在询问之前生效**（`tool-approval.ts:129-133`），且危险工具也提供勾选（`ToolApprovalDialog.tsx:176-188`）→ 高风险可以被一次性授权永久跳过。
2. **风险等级只覆盖 shell**：MCP 破坏性工具在 `buildApprovalDisplay` 里仍是 `custom`（`engine.ts:934-983`），没有危险样式，也不阻止「总是允许」。
3. **策略读取失败落到 `deny(BAD_ARGS)`**（`registry.ts:324-326`）：与「参数不合法」混为一谈，且行为是拒绝而非「继续询问」。
4. **「计费类工具」在 PocketAI 不存在**：不能照搬 `high-credit-gate`，需要重新定义档位（D6）。

### C.1（必须）新增 `forceConfirm` 档，并放在会话白名单之前

- 扩展 `ToolClassification`：`risk?: 'danger'`（D6 已定本阶段不引入 `costly`）、`forceConfirm?: boolean`。
- 置位规则（建议）：
  - shell：`reason` 以 `DANGEROUS_` 开头（`shell-tools.ts:132-173` 的命中项）。
  - MCP：`destructiveHint === true || openWorldHint === true` 或命中危险关键词（`manager.ts:116-130`）。
  - `fs_write`：保持 `confirm` 基线，不升级为 `forceConfirm`（D6 已定本阶段只保留 `danger`）。
- 审批有效顺序：**硬拒绝（classification=deny）→ 无人值守拒绝 → 会话白名单 → 询问/放行**；`forceConfirm` 不改变 `decision`（仍是 `confirm`），只做两件事：跳过白名单、禁用「总是允许」。
- `createApproval`：`forceConfirm` 时跳过白名单查询；`resolveApproval` 收到 `alwaysAllow` 时若 `forceConfirm`，忽略并记录 `ignored_always_allow`（不允许静默扩权）。
- UI：`forceConfirm` 不渲染「本次会话总是允许」；MCP 危险工具复用现有 danger 样式（`ToolApprovalDialog.tsx:87-120`）。
- 审计：`auto_allow` 只允许出现在非 force 场景；新增或复用 reason code 便于筛选。

### C.2（必须）策略读取失败按「继续询问」，而不是 `BAD_ARGS`

- `shell-config.ts:getShellConfig` 捕获配置读取异常，抛类型化 `PolicyUnavailableError`（保留原始 cause 到日志，不进 UI）。
- `registry.classify` 的 catch 分两类：
  - `PolicyUnavailableError` → `{ decision:'confirm', reason:'POLICY_UNAVAILABLE' }`（有人值守时弹窗）。
  - 其他异常（参数解析/校验失败）→ 维持 `deny(BAD_ARGS)`。
- 无人值守路径不需要额外分支：`confirm` 在 `engine.ts:2260-2284` 会变成拒绝，保持 fail-closed。
- i18n：新增 `agent.approval.reason.POLICY_UNAVAILABLE`，四语言同步（parity 用例会兜底）。
- 边界：`getFsTools()` 读取工作区目录失败发生在「列工具」阶段，不是工具判定阶段，会直接让本轮失败；这属于失败关闭，不需要改，但要在文档里说明它和 `POLICY_UNAVAILABLE` 不是一类。

### C.3（可延后，D6 已定不引入）计费/高成本档

- 现状只有全局用量预算（`app-config.repo.ts:61-64`、`usage` 模块），没有按工具计费。
- D6 已定：不造「计费」概念，只保留「不可逆/高副作用」的 `danger` 档；未来若引入外部付费调用，再映射为 `costly` 并同样 forceConfirm。
- 因此本批不需要给 web_search / 图像生成打 `costly` 标记，也不新增相关闸门。

### C.4（可延后）MCP 手工试运行

- `registry.execute` 的测试/试运行路径绕过审批（`registry.ts:332-337` 注释已注明）。这是有意的调试能力，本次不动；若要收紧，需单独设「仅设置页可见 + 二次确认」。

### C.5 数据与迁移

- 无迁移。`approval_events.decision` 的 CHECK 已覆盖允许/拒绝/自动允许（`database.ts:870-895`），`reason_code` 是自由文本。
- 会话白名单是内存态（`tool-approval.ts`），不需要持久化，也没有历史数据清洗。

### C.6 用例与闸门影响

- 需要改期望的用例：
  - `tests/tool-approval-session.test.ts`：danger 不再被会话白名单放过。
  - `tests/mcp-annotations-236.test.ts`：破坏性注解 + `trustReadOnly` 仍必须询问。
  - `tests/renderer-tool-approval-hint.test.tsx` / `tests/tool-policy-screen-417.test.tsx`：danger 样式与按钮可见性。
  - `tests/tool-policy-i18n-parity-417.test.ts`：新增 reason 文案四语言。
- 新增：`POLICY_UNAVAILABLE` 单测（mock `appConfigRepo.get` 抛错）、无人值守下 `POLICY_UNAVAILABLE` 变拒绝、`forceConfirm` 跳过白名单的审计断言。
- 闸门：`typecheck` / `vitest` / `build`。

### C.7 可观测验收标准

1. 先对某条 `rm -rf` 危险命令点「总是允许」，再次发起同样命令：**仍然弹窗**；`approval_events` 不出现 `auto_allow`。
2. MCP 工具带 `destructiveHint=true` 且服务器开了 `trustReadOnly`：仍然弹窗，无「总是允许」控件，弹窗使用危险样式。
3. `auto-safe` 策略下执行 `git push`：仍然弹窗（现有行为，回归验证）。
4. mock 配置读取失败后调用 `shell_exec`：弹窗 reason 显示 `POLICY_UNAVAILABLE`，命令未执行；同一场景在无人值守渠道落 `policy_deny(UNATTENDED)`，命令未执行。
5. 全仓 grep：`auto_allow` 只可能出现在非 force 路径；`alwaysAllow` 的写入点在 force 场景被短路。
6. 现有审批用例全部通过，新增用例覆盖上述 5 条。

### C.8 风险与回滚

- 风险 1：去掉 danger 的「总是允许」会让高频危险操作更烦 → 这是产品取舍，建议保留「本次允许」但去掉「会话总是允许」；回退只需恢复按钮与白名单查询。
- 风险 2：MCP 注解由服务器自报，恶意服务器可把危险工具写成只读；本方案只能保证「注解正确的工具」不绕过，**不能替代**默认 confirm 与出网治理。
- 风险 3：把配置失败从 deny 改 confirm 会多一次弹窗 → 无人值守仍拒绝，安全边界不变。
- 回滚：C-1/C-2 均为纯逻辑改动，无数据迁移；按提交粒度回退即可。

---

## 5. 依赖关系与排期建议

### 5.1 依赖图（文字）

```
C-2（策略失败→询问） ──┐
C-1（forceConfirm + 风险档） ──> B-2 的「待确认」角标（需要稳定判定与 settle 广播）
B-1（touch 语义拆分） ──> B-2（否则角标伴随错误排序/取消归档）
B-2（运行态读模型） ──> A-1 的侧栏骨架可预留状态位（可选）
A-1（listState） ── 独立，A/B 共用
A-2（ui.theme 镜像） ── 独立
A-3（语言预加载） ── 独立
B-3（conversation_runs） ── 依赖 B-2 的状态机；可随后落地
B-4（未读） ── 依赖 D3 口径；与 B-2/B-3 解耦
```

### 5.2 必须做的前置（按顺序）

1. A-1 `listState` + `messagesConvId`（小改动，A 与 B 共用）。
2. B-1 `touch()` 拆分（B 一切角标的前提）。
3. C-1 `forceConfirm` + C-2 `POLICY_UNAVAILABLE`（安全收益最高，且解锁 B-2 的「待确认」语义）。
4. A-2 / A-3（独立的体验修复，可与 B 并行）。
5. B-2 运行态读模型 + 侧栏角标。
6. B-3 `conversation_runs` 与启动中断恢复。

### 5.3 可延后

- A-4 锁屏/向导快照、A-5 独立窗模块骨架。
- B-4 未读、B-5 `status` 退役。
- C-3 计费/高成本档（D6 已定不引入）、C-4 MCP 手工试运行审批。

### 5.4 可独立排期性

三条均可独立成批：A 无 DB 迁移；C 无 DB 迁移；B 的 B-1/B-2 无迁移，B-3 一条 v60 迁移。任何一条单独合入都不会阻塞另外两条（仅 B-2 的「待确认」依赖 C-1/C-2，可用占位实现先合并）。

---

## 6. 已定口径（D1–D9，2026-11-09 拍板）

以下为**已定**结论，实施按此执行，不再作为待定项。

| 编号 | 问题 | 已定结论 | 影响 |
| --- | --- | --- | --- |
| D1 | 「账号快照」在 PocketAI 没有账号体系，是否接受映射为「主题/语言 + 锁屏 + 首启向导」 | **已定：接受映射；账号部分不做** | A 的范围 |
| D2 | 主题镜像是否新增 `ui.theme` KV 与 IPC | **已定：做** | A-2 成立 |
| D3 | 未读的定义 | **已定：只算助手消息；打开且窗口聚焦才算读；锁屏不算读** | B-4 |
| D4 | 运行态是否持久化 `conversation_runs` | **已定：持久化（v60）** | B-3 |
| D5 | 归档会话收到后台 run 时，是否允许自动取消归档 | **已定：不再自动取消归档** | B-1 的行为变化 |
| D6 | 「计费类工具」档位 | **已定：不引入 `costly`；本阶段只保留 `danger`（不可逆/高副作用）** | C 的范围 |
| D7 | `conversations.status` 是否本批停写 | **已定：只停读，继续写** | B-5 |
| D8 | 首屏串行链是否并行/后置清理 | **已定：保持现有顺序，靠骨架遮住等待** | A-1 的实现 |
| D9 | 解锁窗/浮窗是否做骨架 | **已定：接受不做骨架** | A 的范围 |

---

## 7. 附：涉及文件与新增文件清单

### 7.1 修改（按条目）

- A：`src/renderer/public/theme-init.js`、`src/renderer/src/main.tsx`、`src/renderer/src/i18n/index.tsx`、`src/renderer/src/modules/chat/useConversationLists.ts`、`src/renderer/src/modules/chat/ChatModule.tsx`、`src/renderer/src/modules/chat/ConversationList.tsx`、`src/renderer/src/components/ThemeLangControls.tsx`、`src/main/index.ts`、`src/main/windows/unlock-window.ts`、`src/main/windows/detached.ts`、`src/preload/index.ts`、`src/shared/types.ts`（IPC 常量与类型都在这里）、新增 `src/main/ipc/handlers/ui.ts`
- B：`src/main/db/database.ts`（v60/v61）、`src/main/db/repositories/conversation.repo.ts`、`src/main/chat/chat-service.ts`、`src/main/agent/engine.ts`、`src/main/agent/tool-approval.ts`（仅 settle 广播）、`src/main/index.ts`（启动对账）、`src/renderer/src/modules/chat/useConversationLists.ts`、`ConversationList.tsx`、`src/renderer/src/store/`（新 store）、`src/shared/types.ts`、`src/preload/index.ts`、新增 `src/main/chat/runtime-registry.ts`、新增 `src/main/db/repositories/conversation-run.repo.ts`
- C：`src/main/tools/registry.ts`、`src/main/tools/shell-config.ts`、`src/main/tools/shell-tools.ts`（reason/risk 常量）、`src/main/mcp/manager.ts`、`src/main/agent/tool-approval.ts`、`src/main/agent/engine.ts`（`buildApprovalDisplay`）、`src/renderer/src/components/ToolApprovalDialog.tsx`、`src/renderer/src/i18n/dictionaries/*`

### 7.2 新增测试建议

- A：`tests/renderer-chat-first-paint-*.test.tsx`、`tests/window-theme-background-*.test.ts`、`tests/i18n-boot-lang-*.test.ts`
- B：`tests/runtime-registry-*.test.ts`、`tests/conversation-runs-real-db-*.test.ts`、`tests/conversation-runs-encrypted-upgrade-real-db-*.test.ts`、`tests/renderer-conversation-badges-*.test.tsx`
- C：`tests/approval-force-confirm-*.test.ts`、`tests/approval-policy-unavailable-*.test.ts`、`tests/renderer-approval-force-ui-*.test.tsx`

### 7.3 与现有设计明确不照搬的部分

- 不引入 WorkBuddy 的 `permission_mode`/`bypassPermissions` 概念：PocketAI 的策略模型是「基线 + 动态判定取更严」，再加一个「forceConfirm」即可，不需要再造一套权限模式。
- 不把审批记忆升级为持久化「按分组记忆」：PocketAI 的会话白名单已足够，且持久化会扩大误授权面。
- 不引入账号快照：PocketAI 无账号；License 不参与首屏。
- 不把运行态放进 `conversations` 表：与条目目标相反，也会破坏导出/降级兼容。
