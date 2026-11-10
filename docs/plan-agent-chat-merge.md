# 对话与 Agent 模块合并方案（v2）

版本：v2
日期：2026-11-08
状态：待评审（本轮只改文档，未动产品代码）
依据：2026-11-08 源码回读（两套壳 + 主进程共用链路）+ 2026 年主流产品公开文档调研

**相对 v1 的变更摘要**

1. 取消「会话类型」：只有一种会话；是否可调用工具是会话级能力开关，不是身份。`modelLabel` 恢复为纯展示字段。
2. 新增 P0 迁移（v59）：剥离历史 `agent:` 前缀并置 `agent_mode=1`；写入口径与库过滤同步改为 `agent_mode`。
3. 成本口径改为「按一次运行分层」，并明确提示落在 Composer 与轮次摘要，不按模块收费/分层。
4. 运行观测从「独立调试台」改为「挂在轮次上」：每轮摘要常驻，检查器按需展开。
5. MCP / Channels 只搬去设置，不改变功能；P3 只做加法，旧入口保留到 P4。
6. 用户可见文案从「Agent 模式」改为「允许调用工具」，四语同步；代码内部 `agent_mode` / `agentMode` 字段名保留，避免全仓重命名。
7. 逐条修正评审 M1–M12；P5 整期拆出本方案。

---

## 0. 核心结论

1. **现状是「一套后端 + 两套聊天壳」**：`chat:send` 已按 `payload.agentMode` 分叉到 `AgentEngine.run`；`ChatView` 已能渲染 Agent 卡片，`useStreamSession` 已消费 Agent 流式事件，`Composer` 已有模式开关。重复的是会话列表、输入区、运行观测与入口导航，不是协议层。
2. **现状范式接近「分栏并存 + 共享会话」**，但 PocketAI 没有 IDE 那种「编辑器 vs 编排台」的真实密度差；继续维护两个聊天壳的收益低于成本。
3. **目标形态：单一对话入口 + 会话级「允许调用工具」开关 + 轮次级运行记录。** 不存在第二种会话；Agent 模块只是过渡期的第二个壳，最终移除。
4. **历史数据必须迁移一次**：`agent:` 前缀是把展示字段当类型标签，正是「跑一轮就从对话列表消失」的根因。迁移版本 v59，只改一张表的一列值，不新增表/列。
5. **后端不是零改动**：P0 改 `AgentEngine` 的 `modelLabel` 写入与库过滤；P2 新增一个只读 run 索引 IPC 和同会话运行互斥守卫；均不改表结构、不改流式协议。
6. **分四期 + 一个迁移前置**：P0 迁移与写入口径 → P1 展示与入口口径 → P2 轮次记录 → P3 能力台外移 → P4 移除独立 Agent 顶级模块。P5（内部 hook 收口）拆出本方案，另立技术债任务。

---

## 1. 现状判断

### 1.1 已经共享的底座

| 层 | 事实 | 证据 |
|---|---|---|
| 数据表 | 共用 `conversations` / `messages`；Agent 步骤记录在 `agent_traces` | `src/main/db/database.ts`、`src/main/db/repositories/agent-trace.repo.ts` |
| IPC | 两侧都走 `CHAT_SEND`；主进程按 `payload.agentMode` 分叉 | `src/shared/types.ts`、`src/main/chat/chat-service.ts:185-190` |
| 审批 | `ToolApprovalDialog` 挂在全局 `App.tsx`，两侧同源 | `src/renderer/src/components/ToolApprovalDialog.tsx` |
| todo 卡片 | 同一个 `AgentMessageCard` 渲染 | `src/renderer/src/modules/agent/components/AgentMessageCard.tsx` |
| Agent 事件 | `useStreamSession` 已订阅 `onAgentStep/Chunk/Done/Error`，用同一个 `messagesReducer` 归并 | `src/renderer/src/modules/chat/useStreamSession.ts` |
| Agent 卡片复原 | `ChatView` 用 `toAgentMessages` 把持久化多步记录还原成卡片 | `src/renderer/src/modules/chat/ChatView.tsx` |
| 能力开关持久化 | `conversations.agent_mode`（迁移 v57）+ `resolveAgentMode` + `setConversationAgentMode` | `src/main/db/database.ts`、`src/renderer/src/modules/chat/agent-mode.ts` |

### 1.2 两套壳的真实差异

| 能力 | 对话壳（`ChatModule` / `ChatView`） | Agent 壳（`AgentPanel` / `useAgentChat`） |
|---|---|---|
| 列表与助手 | `AssistantRail` + `ConversationList`：文件夹、归档、置顶、批量、外部导入、消息搜索、预览行 | `SessionRail`：助手切换、搜索、导入/加密导入、置顶/归档；无文件夹、无批量、无预览行 |
| 输入区 | `Composer`：多模型目标、引用、草稿、附件、片段、`@`、斜杠、能力开关 | `AgentComposer`：单目标、附件、片段、队列/插队、停止重试 |
| 消息流 | `ChatView`：多模型并行/分支、收藏、置顶、转发、导出、提醒、TTS | `VirtualMessageList`：虚拟化、实时步骤 chip、runStats、trace、变更清单、replay、子会话 |
| 运行观测 | 只有实时 Agent 卡片 + 停止失败提示；无统计/trace/变更清单/子会话/队列 | 全套 |
| 非聊天配置 | 无 | MCP Server 管理、Channels（IM 网关） |
| 首屏加载 | **`ChatModule` 是静态 import，首屏直出** | **只有 `AgentModule` 是 lazy**（`Workspace.tsx` 的懒加载分支） |
| 代码量（2026-11-08） | `ChatModule` 1921 行 / `ChatView` 1283 行 / `useStreamSession` 350 行 | `AgentPanel` 1159 行 / `useAgentChat` 1388 行 / `AgentComposer` 约 900 行 |

### 1.3 现状范式判定

- 入口层：`Workspace.tsx` 只挂 `chat` 一个聊天模块，Agent 顶级模块已于 P4 批次 2 删除（`AgentModule.tsx` / `AgentPanel.tsx` 等壳文件不再存在）；`src/renderer/src/modules/agent/` 现只余 `ui.tsx` 展示件与 `mcp/`、`channels/` 两个配置面板，后者经 `settings/EmbeddedAgentPanels.tsx` 挂在设置页。
- 数据层：同一张表、同一套事件；Agent 会话在对话侧栏可见。
- 因此现状是**「分栏并存 + 共享会话」**，且对话壳里已经长出「单一入口 + 模式开关」的雏形。

### 1.4 身份写错的真实链路（M2 的事实基础）

- `chat-service` 普通发送每次无条件写 `modelLabel` 为 `provider:model`（`src/main/chat/chat-service.ts:276-279`）。所以 v1 写的「P1 不覆盖 modelLabel（当前逻辑已满足）」是事实错误。
- `AgentEngine` 每次运行把 `modelLabel` 写成 `agent:${providerId}:${model}`（`src/main/agent/engine.ts:1342-1345`）。
- 对话列表的 Agent 过滤在库里仍是 `model LIKE 'agent:%'`；Agent 侧 `SessionRail` 因此把「展示字段」当成列表过滤器。
- 结果：Agent 跑一轮 → `modelLabel` 变成 `agent:...` → 对话列表按普通会话过滤时把它排除；普通发一条 → `modelLabel` 被无条件写回 `provider:model` → 它又从 Agent 列表消失。**这不是列表 bug，是身份建模错误。**

---

## 2. 外部范式对照（2026）

### 2.1 样本事实（按 M12 修正归因）

| 产品 | 组织方式 | 关键事实 | 出处 |
|---|---|---|---|
| OpenAI ChatGPT | 同一应用内 **Chat / Work** 两种体验；Codex 独立入口且历史分开 | Chat 面向快问快答；Work 面向长任务与交付物；Projects 把相关 chats / files / instructions 收在一起 | [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)、[Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) |
| Anthropic Claude | **Projects 作容器**；新版 Projects beta：一个 project = 一个 conversation，云端并行 threads，Library 收集产出 | **beta 先从 Claude Code 开放**，chat / Cowork / Team / Enterprise 后续跟进；Artifacts 是会话之外可分享、可迭代的产出 | [What are projects?](https://support.claude.com/en/articles/9517075-what-are-projects)、[Claude Artifacts](https://claude.com/features/artifacts)、[Artifacts in Claude Code](https://claude.com/resources/articles/artifacts-in-claude-code) |
| Cursor 3 | **Agent-first 的 Agents Window + 编辑器窗口并存** | 文档只说可在两者间切换、也可同时打开；**未承诺共享 settings / keybindings**（该表述来自 VS Code）；有 side chat、queue / steer、checkpoint、Changes 视图 | [Cursor Agent](https://cursor.com/docs/agent/overview)、[Agents Window](https://cursor.com/docs/agent/agents-window)、[Cursor 3.0](https://cursor.com/changelog/3-0) |
| Windsurf Cascade | **单一界面 + 模式开关** Code / Plan / Ask | 模式在输入框下方切换；Plan 产出外部 Markdown，点 Implement 转 Code；Ask 只读 | [Cascade Modes](https://docs.windsurf.com/windsurf/cascade/modes)、[Cascade](https://docs.windsurf.com/windsurf/cascade/cascade) |
| GitHub Copilot（VS Code） | **Ask / Plan / Agent 三模式**；Agents Window 与编辑器窗口 | Agents Window 以 chat + sessions list 为主界面；**两窗口共享 sessions、settings、keybindings**；Changes 面板独立 | [Use the Agents window](https://code.visualstudio.com/docs/copilot/agents/agents-window)、[Introduction to agent-first development](https://code.visualstudio.com/learn/foundations/introduction-to-agent-first-development) |
| Manus 2.0 / Devin | **项目/任务即会话单元**，执行台优先 | Manus 以 project 串起简报/页面/视频/自动化，配 Cloud Computer / Automations / Studio；Devin 一个 ticket 一个 session，带 event timeline、并行 session、memory | [Manus 2.0](https://manus.im/zh-tw/blog/introducing-manus-2-0)、[Manus 2.0 帮助中心](https://help.manus.im/en/articles/17190150-what-is-new-in-manus-2-0)、[Devin Sessions](https://docs.devin.ai/work-with-devin/advanced-capabilities) |

### 2.2 三种范式及代价

| 范式 | 代表 | 适合的产品形态 | 代价 |
|---|---|---|---|
| **A. 单一入口 + 能力/模式开关** | ChatGPT Chat/Work、Windsurf Code/Plan/Ask、Copilot Ask/Plan/Agent | 主要工作发生在同一个对话上下文；用户不想先选「房间」再说话 | 聊天壳要能承载运行视图；重配置必须外移；切换语义要清晰（是否延续上下文、成本如何提示） |
| **B. 分栏并存 + 共享会话** | Cursor Agents Window + 编辑器、VS Code Agents Window + 编辑器 | 两种工作密度确实不同：一边代码编辑/调试，一边多任务编排 | 两套 UI 的一致性成本高；需要 session/settings/keybindings 共享，否则出现「同一会话两个状态」 |
| **C. 执行台 / 任务会话分离** | Claude 新版 Projects、Manus、Devin | 长任务、产出物、云端执行、需要事件时间线与交付物管理 | 聊天退为次要入口；后端与沙箱成本最高；不适合本地轻量问答为主的产品 |

**归因修正（M12）**：ChatGPT Projects 与 Claude Projects 确实在容器层统一上下文；Cursor 的 Project 是「协调 agent 的工程单位」，不是同一种容器；不能把「容器层统一上下文」写成行业共识。

### 2.3 对本项目的适用性

- **不适合 C**：PocketAI 是本地优先、便携、非技术用户为主的桌面工作台；没有云端执行台、远程 VM、多用户协作。
- **B 的收益不成立**：Agent 不是 IDE 编辑器，两个壳的差异主要是功能覆盖，不是工作形态。
- **A 最省力**：后端已统一，对话壳已消费 Agent 事件，`agent_mode` 已按会话持久化；把「对话」做成唯一入口，等于把已有雏形补完。

---

## 3. 目标形态

### 3.1 信息架构

```
侧栏
└─ 对话（唯一聊天入口）
   ├─ 左：助手栏 + 会话列表（统一的 ConversationList）
   │    ├─ 行内「工具」徽标 = 该会话当前允许调用工具
   │    └─ 筛选：全部 / 允许工具 / 普通对话
   ├─ 中：消息流（ChatView）
   │    ├─ 普通轮次：多模型并行 / 分支对比
   │    └─ 工具轮次：AgentMessageCard + 本轮记录摘要
   │         └─ 展开 → 运行检查器（步骤流 / 每步 token / 变更清单 / replay / 子会话）
   └─ 下：Composer（统一输入区）
        ├─ 「允许调用工具」开关（按会话持久化）
        ├─ 开启时：单目标模型、实时步骤 chip、队列 / 插队
        └─ 关闭时：多目标、引用、草稿、片段、@、斜杠

设置
├─ 能力 → MCP Server 管理（原 McpPanel）
└─ 连接 → IM 网关（原 ChannelsPanel）
```

**移除独立 Agent 顶级模块，其余模块与侧栏顺序不变。**

### 3.2 术语与数据口径

- 用户可见：中文「允许调用工具」；英文 `Allow tools`；日文「ツール使用を許可」；韩文 `도구 사용 허용`。徽标统一为「工具」，不再出现「Agent 模式」。
- 代码内部保留 `agent_mode` 列名与 `agentMode` 字段名（避免全仓重命名带来的回归面）；只改**读写语义**与用户文案。
- 唯一事实源：`conversations.agent_mode`。`agent_mode=1` = 该会话允许调用工具；`0` = 普通对话。
- `resolveAgentMode` 不再用 `modelLabel` 前缀兜底；持久化的 `0` 必须压过任何历史前缀（M1）。
- `modelLabel` 只存 `provider:model`（多目标时用 ` | ` 连接），不承载能力身份。
- 能力开关是**会话级**的；未建会话前，开关值暂存在 `PENDING_AGENT_MODE_KEY`，首条发送建会话时落库。
- 历史 `agent:` 前缀在 P0 一次性回填后消失；`applyLastModelOf` 对旧导入/归档数据的剥离逻辑保留，仅作展示容错，不参与身份判定。

### 3.3 成本口径：按一次运行分层

- **默认普通对话**：按 token 计费（多目标 = 多份 token），不触发工具审批。
- **允许调用工具**：一次运行会带来工具审批、更多往返、更长耗时、更多 token。提示落在三个位置：
  1. **Composer 开关处**：首次在某会话开启时，输入框上方出现一次性确认卡，三条短句「可能触发工具审批 / 耗时更长 / 消耗更多 token」，按钮「开启工具能力」/「取消」。确认后才写 `agent_mode=1`。
  2. **每次运行前**：输入框上方常驻一条轻提示「本轮可调用工具 · 可能触发审批 · 按 token 计费」，不弹窗、不阻断。
  3. **每轮结束后**：轮次摘要显示本轮 token、耗时、步数、变更数。
- **没有配额系统时怎么留口径**：不新增配额/计费逻辑。`agent_traces` 已有 `input_tokens` / `output_tokens`；P2 的 run 索引按 `request_id` 汇总每轮 token 与耗时，`sessionStats` 汇总会话。后续要加配额，可在这两个聚合上扩展，不改表。
- **不按模块分层**：不存在「对话套餐 / Agent 套餐」；同一个会话随时切换能力。

### 3.4 观测挂在轮次上

```
[用户轮次]
[助手轮次]
  AgentMessageCard
  └─ 本轮记录：3 步 · 42s · 1.2k tokens · 2 文件变更 · 1 子会话
      └─ 展开：运行检查器
           - 步骤流（工具名 / 入参 / 返回）
           - 每步 token
           - 变更清单 diff
           - replay 状态
           - 子会话入口
```

- **摘要常驻、检查器按需展开**：摘要和消息同属一条时间线；检查器默认折叠，展开才读库。
- **不做独立调试台**：trace 的解释依赖「这一轮问了什么」，离开轮次就没有上下文；独立调试台会再次制造「同一会话两个入口」。
- **子会话**：点击进入只读视图 + 顶部返回条；不新开模块。`subSessionReadonly` 的归属见 P2。

### 3.5 MCP / Channels 归属

- **MCP Server 管理 → 设置 → 能力**：全局/助手级配置，生命周期跨会话。
- **Channels（IM 网关）→ 设置 → 连接**：入站消息源与凭据配置；入站后创建的会话仍进入统一会话列表。
- **P3 只做加法**：设置里新增入口，Agent 壳里的旧标签页保留到 P4。这样 P3 可独立回滚，P4 回滚也能恢复完整旧壳（M9）。

### 3.6 当前真实可达入口（M6）

现状只有三处：

1. 侧栏 Agent 模块 → MCP Server 标签页。
2. 侧栏 Agent 模块 → IM 网关标签页。
3. MCP 面板内的能力中心「去授权」跳到助手编辑器（**不是服务器配置页**）。

不存在 `module=agent&tab=servers` 深链，也不存在 MCP 快捷键。P3 若要「设置滚动到分区 + 高亮」，属于**新增实现**，本方案不把它列为既有能力。

---

## 4. 迁移方案（P0）

### 4.1 版本与 SQL

当前最新迁移是 **v58**；新增 **v59**：

```sql
UPDATE conversations
SET model = substr(model, 7),
    agent_mode = 1
WHERE model LIKE 'agent:%'
  AND length(model) > 6;
```

- `agent:` 长度为 6，`substr(model, 7)` 剥离前缀。
- `length(model) > 6` 防止把空模型写成空串异常。
- 幂等：再次执行只会命中仍带前缀的行（正常升级后为 0 行）。
- 不新增表/列；`agent_traces` 不动。

### 4.2 写入口径（必须与迁移同批）

| 位置 | 现状 | v2 |
|---|---|---|
| `AgentEngine` | 写 `agent:${provider}:${model}` | 写 `${provider}:${model}`，并确保 `agent_mode=1`（`conversationRepo.setAgentMode` / `touch` 扩展） |
| `chat-service` 普通发送 | 无条件写 `provider:model` | 保持（这是 A 的期望行为，不是 bug）；不碰 `agent_mode` |
| 库过滤 | Agent 列表 `model LIKE 'agent:%'` | 改为 `agent_mode = 1` |
| `resolveAgentMode` | 记录 + 前缀兜底 | 只认 `record.agentMode`；本地乐观值 + pending 保留（P0 不删） |

### 4.3 M1 判定矩阵（P0 测试钉死）

| 用例 | 输入 | 期望 |
|---|---|---|
| 显式开启 | `agentMode=true`，无前缀 | `true` |
| 显式关闭 | `agentMode=false`，无前缀 | `false` |
| **关闭压过前缀** | `agentMode=false`，`modelLabel='agent:x:y'` | **`false`**（M1 回归点） |
| 开启 + 残留前缀 | `agentMode=true`，`modelLabel='agent:x:y'` | `true` |
| 关闭后重启 | 落库 `agent_mode=0`，重新读取 | `false`（「关模式 → 重启仍关」） |
| 未建会话 pending | 空会话键，pending=true | `true`；建会话后迁到真实 id |
| 无记录 | `null` | `false` |

### 4.4 历史数据迁移的取舍

- **选择迁移，不选读时兼容**：读时兼容会永久保留 `agent:` 脏约定，并且与「显式关闭压过前缀」冲突——必须有第三个状态才能同时表达「关闭」和「旧前缀=开启」，那等价于再加一列。一次性回填更干净。
- **风险可控**：只改 `conversations.model` 与 `agent_mode` 两列值；行数有限；先备份。
- **旧版本打开新库会怎样**：
  - 老版本迁移表里多一条 v59 记录，但老代码只跑自己已知的迁移，**能正常开库**（`schema_migrations` 是增量集合）。
  - 老版本的 Agent 列表按 `model LIKE 'agent:%'` 过滤 → **旧 Agent 列表变空**；这些会话仍能在对话列表看到，并因 `agent_mode=1` 被老版本的 `resolveAgentMode` 认为可调用工具（v57 已支持该列）。
  - 老版本再跑一次 Agent → 又会写回 `agent:` 前缀。回到新版本后，启动时执行**幂等修复**（同一段 UPDATE），再次剥掉；不依赖第二次迁移。
  - 老版本若在降级期间新建带前缀的会话，新版本启动修复会将其置为 `agent_mode=1`。这是唯一可接受的降级残留，且可自愈。
- **回退影响**：迁移本身不回滚数据。回退需恢复升级前备份，或手工执行降级 SQL：

```sql
UPDATE conversations
SET model = 'agent:' || model
WHERE agent_mode = 1
  AND model NOT LIKE 'agent:%';
```

  该 SQL 会让旧版本 Agent 列表重新可见；但会把所有「允许工具」的会话都标成旧前缀，属于**有损降级**，只用于紧急回退。

### 4.5 P0 回滚定义

- 代码：`git revert` P0 提交（恢复引擎前缀写入、库过滤、`resolveAgentMode` 兜底）。
- 数据：迁移不可逆；回滚前必须备份数据库。若已迁移，执行 4.4 的降级 SQL。
- 不做：不自动删除 `schema_migrations` 的 v59 记录（删除会导致升级后重复执行数据更新，虽幂等但无必要）。

---

## 5. 分期计划

| 期 | 目标 | 用户可见变化 | 依赖 | 回滚 |
|---|---|---|---|---|
| P0 | 身份剥离 + 迁移 v59 + 写入口径 | 会话不再因跑一轮而消失；重启后能力开关状态正确 | 无 | 备份 + 降级 SQL + revert |
| P1 | 展示与入口口径（渲染层） | 会话列表出现「工具」徽标/筛选；命令面板不再重复 | P0 | revert |
| P2 | 运行记录挂到轮次 | 每轮摘要 + 检查器 + 队列守卫 | P1 | revert |
| P3 | 能力台外移（只做加法） | 设置里出现「能力 / 连接」 | 无（可与 P2 并行） | revert |
| P4 | 移除独立 Agent 顶级模块 | 侧栏只剩一个聊天入口，其余模块不变 | P1 + P2 + P3 | revert（侧栏顺序可能重置一次） |

> v1 的 P0「conversationKind 单一事实源」取消：不存在会话类型，也就不需要类型函数。展示口径并入 P1；P0 只做「身份剥离 + 迁移 + 写入口径」。

---

### P0：身份剥离与迁移（前置，独立交付）

**目标**：`agent_mode` 成为唯一能力口径；`modelLabel` 回到纯展示；历史 `agent:` 前缀一次性清除。

**改动面**
- `src/main/db/database.ts`：新增迁移 v59（SQL 见 4.1）；`LATEST_SCHEMA_VERSION` 随之为 59。
- 启动路径：新增幂等 `repairLegacyAgentLabels()`（与 v59 同一条 UPDATE），仅在开库/解锁后调用，处理降级期间产生的残留前缀；不挂进会话加载路径。
- `src/main/agent/engine.ts:1342-1345`（主运行 setup）与 `:1850`（备用模型换台）、`src/main/agent/delegation.ts:36`（子会话创建）：`modelLabel` 一律改为 `${providerId}:${model}`；运行开始确保 `agent_mode=1`（子会话创建即置位）。
- `src/main/db/repositories/conversation.repo.ts`：
  - `list(... isAgent)` 的过滤由 `model LIKE 'agent:%'` 改为 `agent_mode = 1`（`isAgent=true`）；`isAgent=false`/`undefined` **不做类型过滤**（保持对话侧「所有会话」口径，绝不能按 `agent_mode = 0` 反选，否则重演 440 的"跑一轮就消失"）。
  - `touch` 扩展可选 `agentMode` 或在引擎里单独 `setAgentMode`。
- `src/renderer/src/modules/chat/agent-mode.ts`：`resolveAgentMode` 删除 `modelLabel` 前缀兜底；保留本地乐观值 + `PENDING_AGENT_MODE_KEY`。
- `src/renderer/src/modules/agent/**`：`applyLastModelOf` 等**展示**逻辑可继续剥前缀，但不参与开关判定。

**风险与规避**
- 迁移把普通会话误改：`WHERE model LIKE 'agent:%'` 已限定；迁移测试覆盖正常行、空模型、已迁移行。
- 旧版本写入残留：启动幂等修复自愈；文档写明降级限制。
- `agent_mode` 缺省 0 把历史工具会话判成普通：v59 必须先于 P1 上线；测试覆盖「前缀行 → 1」。
- 关闭仍被判开启：M1 矩阵钉死「显式 false 压过前缀」。

**验收**
1. 迁移夹具（普通库 + 加密库各一组，含前缀行、混合 `agent_mode`、空模型、`agent:` 空行）：前缀行变 `provider:model` + `agent_mode=1`；非前缀行（含 `agent_mode=1` 的普通行）逐字节不变；`integrity_check` 通过；重复打开不抛。
2. 引擎集成：Agent 运行（含备用换台、子会话创建）后 `conversations.model` 不含 `agent:`，`agent_mode=1`。
3. `resolveAgentMode` 七条矩阵全绿，含「关闭 + 前缀 = 关闭」。
4. 「关模式 → 重启仍关」：写 0、重读为 false。
5. `npm run typecheck` 0 错；相关 vitest 全绿。

**迁移/兼容**：v59 只改数据；旧版本可开库但 Agent 列表变空；降级 SQL 见 4.4。

**回滚**：备份 + 降级 SQL + `git revert`。

---

### P1：展示与入口口径（渲染层，无库改动）

**目标**：用户看到的「工具」只是徽标与筛选，不是会话类型；命令面板与消息跳转不再出现同一会话两个入口。

**改动面**
- `src/renderer/src/modules/chat/ConversationList.tsx`
  - 行内「工具」徽标：`conversation.agentMode === true`。
  - 筛选 `toolsFilter: 'all' | 'tools' | 'plain'`；与标题搜索是 **AND**。
  - `groupedMode` 门槛加 `&& toolsFilter === 'all'`（筛选态不分组）。
  - `allSelected` / 全选 / 批量操作基于**筛选后的列表**，不是全量。
  - 归档区跟随筛选；归档计数同样按筛选后计算；搜索态维持现有「平铺」逻辑。
  - 空态区分「无会话」与「无匹配会话」。
- `src/renderer/src/modules/chat/ChatModule.tsx`
  - 删除 `handlePaletteOpen` 里「`isAgent` 直接 return」的分支；两种 detail 都接受。
  - `handleSelectMessage`：先查 `conversations` / `archived` / 跨助手搜索结果；目标会话属于其他助手则先切助手再跳；查不到则 toast「请先切换助手」，不静默。
  - `onChatSendFailed` 等现有路径不变。
  - 保留 `setAgentModeByConv` 的本地乐观值 + 失败回滚 toast；保留 pending 迁移。
- `src/renderer/src/components/CommandPalette.tsx`
  - 删除 `conv-chat` / `conv-agent` 两组重复结果；合并为一组「会话」，每个 conversation id 只出现一次，按 `updatedAt` 排序。
  - detail 结构从 `{ isAgent: boolean }` 改为 `{ conversationId, assistantId, toolsEnabled: boolean }`（P4 前保留对旧 `isAgent` 的读取兼容）。
  - 路由：一律 `switchModule('chat')`，不再 `moduleId:'agent'`。
- `src/renderer/src/utils/palette-nav.ts`
  - 移除 `isAgent` 分支；`navigateToConversation` 只走对话。
  - `pocketai-pending-conv` 写入新结构；读取旧 `isAgent:true` 时翻译为 `toolsEnabled:true`。
- `src/renderer/src/modules/agent/components/SessionRail.tsx`
  - **组件代码不改**；但其数据源随 P0 变为 `agent_mode=1` 过滤，成为过渡期的「工具会话」列表。普通会话不出现在这里，工具被关闭的会话会从这里消失——这是过渡期的预期行为，P4 随壳移除。
- `src/renderer/src/i18n/{zh,en,ja,ko}.ts`
  - 新增 `chat.tools.badge`、`chat.tools.filter.all/tools/plain`、`composer.tools.*`；复用现有 `agent.*` 检查器文案。
  - 四语 key 集合、非空值、占位符集合一致；跑 `tests/i18n-parity.test.ts`、`tests/i18n-dead-keys.test.ts`。

**M2 / M3 对应的正文口径**
- **M2**：普通发送**会**无条件写 `modelLabel`（`chat-service.ts:276-279`）。按 A 定稿：关掉工具后发普通消息 = 普通对话，`model` 被覆盖为 `provider:model`、不再有工具徽标。这是期望，不是要修掉的行为。
- **M3**：Agent 侧库过滤已在 P0 改为 `agent_mode`；`SessionRail` 只改数据语义、不改组件；命令面板去重与路由收敛在本期完成；`ChatModule` 不再拒绝 `isAgent` 的打开请求。

**风险与规避**
- 筛选与分组/全选/归档互相踩：明确「筛选态不分组、全选基于筛选集、归档跟随筛选」，并补交互测试。
- 跨助手消息跳转：`handlePaletteOpen` 会切助手、`handleSelectMessage` 原来不会；本期统一为「先切后跳」，查不到则提示。
- 导出/导入：聊天导出 payload 不含 trace/change_set；加密导入 meta 不含能力开关。**导入后默认普通对话**，需手动开启。这是已知限制，不在 P1 补。
- 命令面板旧 pending 结构：读取兼容 + 新写入；P4 再删旧字段。
- i18n：先补 key 再改 UI，避免「键点了等于没按」；parity/dead-key 两个测试必须绿。

**验收**
1. Agent 侧建会话并跑一轮 → 对话列表出现该会话，带「工具」徽标；跑完后不消失。
2. 收到该会话后关闭工具并发普通消息 → `model` 为 `provider:model`，徽标消失，会话仍在列表（M2 的 A 口径）。
3. 命令面板搜索该会话 → **只出现一条**；回车落到对话页并选中；不再出现 `conv-agent` 第二组。
4. 旧 `pocketai-pending-conv`（`isAgent:true`）→ 打开对话页并选中，不落到 Agent 模块。
5. 筛选「允许工具」只显示徽标会话；筛选「普通对话」反之；与标题搜索同时生效为 AND；全选只选中筛选结果。
6. 从助手 A 的消息搜索结果跳到助手 B 的会话 → 先切助手再跳；查不到时提示，不静默失败。
7. 归档区跟随筛选；搜索态行为与改动前一致。
8. `tests/i18n-parity.test.ts`、`tests/i18n-dead-keys.test.ts` 全绿。

**迁移/兼容**：无库改动；旧 `isAgent` 字段在 P4 前保留读取兼容。

**回滚**：`git revert` P1 提交。数据不受影响；命令面板重复项与 Agent 路由会恢复，属可接受降级。

---

### P2：运行记录挂到轮次（新增只读 IPC + 互斥守卫）

**目标**：每轮工具运行都有摘要与检查器；队列由持有队列的 hook 自行订阅 Done/Error 并在纯函数里幂等结算；同一会话不会从两个壳各起一个 run。

**改动面**

1. **run 索引（只读 IPC）**——修正 v1「每轮摘要没有数据接口」的问题：
   - `src/main/db/repositories/agent-trace.repo.ts` 新增 `listRuns(conversationId, limit=50)`：
     - `SELECT request_id, MIN(created_at), MAX(created_at), COUNT(*), SUM(token_usage), GROUP_CONCAT(DISTINCT message_id), SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) ... GROUP BY request_id ORDER BY MIN(created_at) DESC`
     - `agent_traces` 只有 `token_usage`（每步总 token），**没有 input/output 分列**；摘要展示总 token，不伪造拆分。
     - 子 run 通过 `parent_request_id` 归到父 run，或单独返回（按现有语义）。
   - `src/main/ipc/handlers/agent.ts` + `src/shared/types.ts`：新增 `AGENT_LIST_RUNS`（`agent:list-runs`），只读，不写库。
   - `messages` 表**没有 requestId 列**；映射轮次以 `agent_traces.message_id` 为准：run 的 `messageIds` 命中该轮助手消息；缺失时回退 `created_at` 区间（用户消息时间 ≤ run 开始 < 下一条用户消息）。
   - 现有只读接口保留：`getAgentRunStats`（按 requestId）、`getAgentSessionStats`、`getLatestAgentTraces`（100 行上限）。**不把「列出全部 run」塞进这些接口。**

2. **轮次 UI**：
   - `src/renderer/src/modules/agent/hooks/useAgentRunInsights.ts`（从 `useAgentChat` 抽出；P5 批次 1 已搬到 `chat/useAgentRunInsights.ts`）：`runsByTurn`、`runStats`、`sessionStats`、展开态 trace、子会话。
   - `src/renderer/src/modules/agent/components/AgentRunSummary.tsx`：步数/耗时/token/变更数/子会话/降级标记，挂在对应轮次内。
   - `src/renderer/src/modules/agent/components/AgentRunInspector.tsx`：步骤流、每步 token、工具入参/返回、变更清单、`TraceReplayStatus`、子会话入口；默认折叠，展开才读库。
   - `src/renderer/src/modules/agent/components/AgentLiveStepStrip.tsx`：运行中 chip 流，结束后收起；**与 Agent 调试台共用同一份渲染**，挂在对话页实时 Agent 卡片（`chat-agent-live`）内、持久化卡片之上。零步骤（还没收到 step 事件）或非运行态整条不渲染。
   - `src/renderer/src/modules/chat/ChatView.tsx`：
     - 给现有虚拟化补 `getItemKey`（当前 ChatView 的 `useVirtualizer` **没有** `getItemKey`；只有 `VirtualMessageList` 有）。键用轮次首条消息 id；摘要作为轮次内元素，不新增顶层虚拟项。
     - 摘要挂在工具轮次；`onStreamsSettled` 后主动刷新该会话 run 索引。
   - `src/renderer/src/modules/chat/ChatModule.tsx`：接 `useAgentRunInsights`；仅在工具有效会话启用。

3. **队列与运行归属**——**不建 `run-controller` 单例**：
   - 两个壳各自持有自己的队列（`useAgentChat` 现状），结算规则抽到 `modules/agent/queue-settlement.ts` 纯函数；队列 hook **自己订阅** `onAgentDone` / `onAgentError` 来 drain，不依赖观测 hook 的 `onStreamsSettled`（观测 hook 不订阅也能结算）。
   - 幂等账本按 `(requestId, clientRef)`：`settledRuns` 保证同一个 Done 只驱动一次 drain，`sent` 拦住同一项被旧快照重复发出；插队事件按 `clientRef` 去重。
   - 不做「发送前 `begin` 失败 toast」，也不让 `ChatModule` 与 `AgentPanel` 共用同一控制器——双壳同会话发送本来就由 `chat:send` 的**按会话串行锁**排队，不为此改发送前状态机。
   - **主进程互斥守卫（兜底，不是常态）**：`AgentEngine` 的 `activeConversations: Map<conversationId, requestId>` 在首处登记之前检查，同一 `conversationId` 已有活动 run 时第二个 `agentMode` 请求抛 `AGENT_RUN_BUSY`，不写用户消息；`finally` 释放。正常经 `chat:send` 的并发会被串行锁排队，轮不到这条守卫——它只在直接调 `run()`／将来绕开串行锁的入口生效。
   - `subSessionReadonly` 已移到 `src/renderer/src/modules/agent/sub-session.ts`；`ChatView` 与 `AgentPanel` 共用，P4 删除 `useAgentChat` 后仍保留。

**风险与规避**
- 两套订阅重复：step/chunk 在 `useStreamSession` 与 `useAgentChat` 各自归并；Done/Error 由持有队列的 hook 订阅，靠 `(requestId, clientRef)` 账本幂等，用例钉住「双订阅只发一条」。
- 队列 drain 依赖 Done/Error：结算订阅放在持有队列的 hook 内，观测 hook 不订阅也照样 drain。
- 同会话双 run：`chat:send` 串行锁是常态防线；主进程 `AGENT_RUN_BUSY` 守卫是绕锁入口的兜底。
- 轮次映射错位：以 `message_id` 优先、时间区间兜底；run 索引按 `request_id` 去重。
- 长 trace 卡顿：检查器懒加载 + 分页/虚拟化；摘要不读明细。
- 虚拟列表 key：先补 `getItemKey` 再塞摘要，避免滚动跳动。
- 刷新时机：只在 `onStreamsSettled` 和展开检查器时刷新；不在滚动/渲染中读库。

**验收**
1. 工具会话跑 3 步任务：该轮出现摘要，步数/耗时/token/变更数与 `agent_traces` 查询一致。
2. 展开检查器：能看到该 run 的步骤流、每步 token、工具入参/返回；折叠时 0 次读库，展开只多 1 次 `getRunTraces`（不再发 `agent:list-runs`）。
3. 打开 1000 条消息的会话：普通会话 `agent:list-runs` **0 次**；Agent 会话打开时 **1 次**（摘要常驻的必要一次）；滚动 **0 次**；展开某一轮只多 **1 次** `getRunTraces`（用 IPC spy 断言）。
4. 切到另一会话再切回：摘要与 trace 恢复，不串会话。
5. 子代理：摘要显示子会话数；进入只读子会话，输入区不可发送；返回父会话正常。
6. 队列：运行中入队 2 条，FIFO；Done/Error 后 drain；插队在工具调用边界生效；上限 20。
7. 同会话并发：双壳同时发送时由 `chat:send` 的按会话串行锁**排队**；只有绕过串行锁直接调引擎（或将来某个绕锁入口）时，第二个请求才收到 `AGENT_RUN_BUSY`，且不产生第二条用户消息——守卫是兜底而非常态。
8. `onStreamsSettled` 后摘要在 1 次刷新内出现，不需要手动重开会话。
9. 运行中的实时卡片顶部出现步骤条：随 step 事件推进（旧 chip 保留、新 chip 追加）；零步骤不显示；Done/Error 后随卡片收起。

**迁移/兼容**：无 schema 变更；新增 IPC 只读；`agent_traces` 既有数据直接可读。

**回滚**：`git revert` P2 提交。新增 IPC 不再被调用即无行为；队列回到 `AgentComposer` 的本地实现；`sub-session.ts` 保留但无引用时删随提交即可；无数据变化。

---

### P3：能力台外移（只做加法）

**目标**：设置里出现 MCP 与 Channels 的正式入口；不改功能、不改路由、不删旧入口。

**改动面**
- `src/renderer/src/modules/settings/SettingsModule.tsx`
  - 新增「能力（MCP）」分区，渲染 `McpPanel`；新增「连接（IM 网关）」分区，渲染 `ChannelsPanel`。
  - 两个面板组件本身不改逻辑，只改挂载位置。
  - **不新增**「滚动到分区/高亮」；若以后要，作为独立实现。
- `src/renderer/src/modules/agent/AgentModule.tsx`
  - **保留** `AgentPanel` / `McpPanel` / `ChannelsPanel` 三个标签页，P3 不删任何入口；可在 MCP/Channels 标签内加一条「已可在设置中找到」的说明（可选）。
- i18n：四语新增设置分区标题与说明；不删除旧 key（P4 再清）。

**M7 修正**：`McpPanel` 的真实依赖是 `usePipSource`、`CapabilityCenter`、`McpForm`、`McpImportModal`、`McpTemplatesModal`，不是 `useProviderData` / `usePythonEnv`。它们都是面板内部依赖，挂到设置页时不需要聊天上下文；若发现某个依赖假设聊天态，抽成 props，不在设置页假设。

**风险与规避**
- 设置页未挂载时网关状态停更：网关服务在主进程常驻；设置页只做配置与状态展示。
- 面板依赖聊天上下文：先做挂载冒烟测试（`renderer-mcp-import-templates-mount.test.tsx` 既有夹具可复用）。
- 入口找不到：P3 不删旧入口，旧路径仍可用；设置入口是新增第二条路。
- 用户以为迁移完成：文案写「也可在设置中管理」，不写「已迁移」。

**验收**
1. 设置 → 能力：MCP 面板完整可用（增删改、导入、模板、试运行）。
2. 设置 → 连接：Channels 面板完整可用（配置/启停/状态）。
3. Agent 模块旧 MCP/Channels 标签仍可用，行为与改动前一致。
4. 两个入口看到的是同一份配置（改一处，另一处刷新后一致）。
5. 网关入站消息仍创建会话并进入对话列表。
6. 四语新增 key 通过 parity/dead-key 测试。

**迁移/兼容**：无数据变更；MCP 配置、Channel 密钥存储位置不变。

**回滚**：`git revert` P3 提交；设置分区消失，Agent 旧标签仍在，无功能损失。

---

### P4：移除独立 Agent 顶级模块

**目标**：侧栏只保留一个聊天入口；其余模块、顺序与能力不变。

**前置**：P1（入口口径）+ P2（轮次观测/队列）+ P3（能力台新家）验收通过。

**改动面**

**入口与路由**
- `src/renderer/src/components/Sidebar.tsx`：`MODULE_ICONS` 移除 `agent`；模块标签/标题移除。
- `src/shared/types.ts`：`ModuleId` / `DEFAULT_SIDEBAR_ORDER` / `DETACHABLE_MODULE_IDS` 移除 `agent`；`LazyModuleId`（若含）同步。
- `src/renderer/src/components/Workspace.tsx`：删除 `AgentModule` 的 lazy 分支与 `moduleId:'agent'` 渲染；`chat` 仍静态 import。
- `src/renderer/src/components/CommandPalette.tsx`：移除 `agent` 模块命令、`MODULE_TITLE_KEY.agent`、`conv-agent` 分组（P1 已去重，本期删残留）。
- `src/renderer/src/detached/DetachedApp.tsx`：移除 `agent` 标题/路由；旧 `#/detached?module=agent` 回退为「对话」窗口（或聚焦主窗口，二选一，推荐前者）。
- `src/renderer/src/utils/palette-nav.ts`：删除旧 `isAgent` 兼容；`pocketai-pending-conv` 只读写新结构。
- 深链 `module=agent`：重定向到对话 + 最近一条工具会话；**保留至 v1.4.0**（自 v1.3.0 起算一个 minor），之后可移除。

**侧栏顺序与固定项（M8）**
- `src/renderer/src/store/app-store.ts` 的 `normalizeSidebarOrder` 目前要求 `raw.length === DEFAULT_SIDEBAR_ORDER.length`。删掉 `agent` 后，旧的 12 项会被整体判无效并**回默认**。
- 修正：先按当前 `DEFAULT_SIDEBAR_ORDER` 过滤，再要求「过滤后长度 === 当前默认长度且无重复」。这样旧 12 项会保留用户相对顺序、只去掉 `agent`，不再整体重置。
- `normalizePinnedModules` 已按 `DEFAULT_SIDEBAR_ORDER` 过滤，`agent` 会从固定列表消失；固定数量减少是**无法避免的用户可见变化**。
- 启动加载 `sidebar.order` 时，若发生过滤，回写一次清洗后的数组，避免每次加载重复过滤。
- **用户可见行为**：自定义侧栏顺序保留（去掉 Agent 项）；固定列表中的 Agent 项被移除；其余模块不变。

**删除与迁移清单（M8 补充）**

| 文件/能力 | 现状用途 | 处置 |
|---|---|---|
| `modules/agent/AgentModule.tsx` | Agent 三标签壳 | 删除 |
| `modules/agent/chat/AgentPanel.tsx` | Agent 聊天页 | 删除 |
| `modules/agent/components/SessionRail.tsx` | Agent 会话列表 | 删除（P1 已把它降为过渡期工具会话列表） |
| `modules/agent/components/AgentComposer.tsx` | Agent 输入区 | 删除；队列/工具策略已迁入统一 Composer |
| `modules/agent/components/AgentModelBar.tsx` | Agent 模型条 | 删除；单目标模型选择已在 Composer |
| `modules/agent/components/AgentToolBars.tsx` | Agent 工具栏 | P5 批次 2 已搬到 `chat/AgentToolBars.tsx`；工具配置入口在设置/Composer |
| `modules/agent/components/AgentSearchBar.tsx` | Agent 消息搜索条 | 删除；对话侧已有消息搜索 |
| `modules/agent/components/ZeroToolCallNotice.tsx` | 零工具调用提示 | **迁移**到 `ChatView` 工具轮次（不是删除） |
| `modules/agent/components/ToolPolicyDialog.tsx` | 工具策略弹窗 | **迁移**到统一 Composer/工具设置（不是删除） |
| `modules/agent/components/FsWriteActions.tsx` | 写文件卡片动作 | **保留**；`AgentMessageCard` 仍使用 |
| `modules/agent/components/HtmlBlockActions.tsx` | HTML 卡片动作 | **保留**；`AgentMessageCard` 仍使用 |
| `modules/agent/hooks/useAgentChat.ts` | Agent 聊天 1388 行 | 删除；观测/队列/子会话已拆到 P2 的独立模块 |
| `modules/agent/components/AgentMessageCard.tsx` | 共享卡片 | 保留 |
| `modules/agent/components/VirtualMessageList.tsx` | Agent 虚拟列表 | 删除；`getItemKey` 思路移到 ChatView 的 virtualizer（ChatView 已有自己的 per-turn 虚拟化） |
| `modules/agent/components/TraceReplayStatus.tsx` | replay 徽标 | 保留 |
| `modules/agent/hooks/useAgentToolConfigs.ts` / `agent-shared.ts` | 共享 | `agent-shared.ts` 保留；`useAgentToolConfigs.ts` 已于 P5 批次 2 搬到 `chat/`；`messages-reducer.ts` 已于 P5 批次 1 搬到 `chat/`；`useAttachments.ts` 已于 P4 批次 2 删除 |
| `modules/agent/mcp/McpPanel.tsx` / `channels/ChannelsPanel.tsx` | 配置面板 | 保留，仅挂设置 |
| `modules/agent/queue-settlement.ts` / `sub-session.ts` | P2 新增 | 保留（不建 `run-controller`） |

**快捷键**：不存在专用 Agent 快捷键。`Ctrl/Cmd+1…9` 按侧栏位置切换模块，删掉 Agent 后序号顺延；这是预期变化，需在帮助文案说明。

**通知跳转**：`reply-notify` 只聚焦主窗口，不需要处理 Agent 路由。

**风险与规避**
- 能力回归：P4 前按上表逐项确认「删除 / 迁移 / 保留」；没有等价实现的不进 P4。
- 侧栏顺序重置：修 `normalizeSidebarOrder` + 启动清洗回写；测试旧 12 项顺序。
- 分体窗口：`DETACHABLE_MODULE_IDS` 移除 + 旧 `#/detached?module=agent` 回退。
- 命令面板残留：`conv-agent` 在 P1 已删，P4 再 grep 复核零残留。
- 旧深链：`module=agent` 重定向至 v1.4.0。
- LRU 保活：单一对话实例，快捷键只注册一处；保留 `isActiveModuleInstance` 自检。

**验收**
1. 侧栏无 Agent 项；其余模块数量/顺序与用户旧自定义顺序一致（去掉 Agent 后相对顺序不变）。
2. 旧 `sidebar.order`（12 项、Agent 在任意位置）→ 去掉 Agent 后为 11 项且相对顺序保留；不回默认。
3. `sidebar.pinned` 含 Agent → 加载后 Agent 消失，其余固定项保留。
4. 命令面板不再出现 Agent 模块命令或 `conv-agent` 结果。
5. `#/detached?module=agent` 落到对话窗口；`DETACHABLE_MODULE_IDS` 不含 Agent。
6. `module=agent` 深链落到对话页并选中最近一条工具会话（保留至 v1.4.0）。
7. 普通对话与工具会话全量回归：多模型、分支、文件夹、归档、置顶、草稿、提醒、导出、外部导入、加密导入；工具审批、todo、队列、停止、子会话、trace、变更清单。
8. `ReplyNotify` 等通知跳转只聚焦主窗口，不因删模块报错。
9. 三件套全绿（见 §8）。

**迁移/兼容**：无数据库迁移；侧栏 `sidebar.order` / `sidebar.pinned` 做启动清洗；会话/trace/MCP/Channel 全部沿用。

**回滚**：`git revert` P4 提交。Agent 壳及其 MCP/Channels 标签恢复（P3 未删旧标签）；**侧栏顺序可能回默认一次**（恢复 Agent 后旧 11 项不等于 12 项默认排列），固定项需重设；会话数据无损。

---

## 6. 风险清单

| # | 风险 | 影响 | 概率 | 规避 | 兜底 |
|---|---|---|---|---|---|
| R1 | 队列/运行归属两套实现，Done/Error 不结算 | 高 | 中 | 各壳自队列；`queue-settlement.ts` 纯函数 + `(requestId, clientRef)` 账本幂等；队列 hook 自订阅 Done/Error | revert P2 |
| R2 | 同会话两个壳各起一个 run | 高 | 中 | `chat:send` 按会话串行锁排队（常态）；主进程 `activeConversations` 互斥兜底 | 绕锁入口返回 `AGENT_RUN_BUSY` |
| R3 | 历史前缀/关闭状态判定回弹（M1） | 高 | 中 | v59 迁移 + `resolveAgentMode` 只认列；七条矩阵测试 | 回退 P0 + 备份 |
| R4 | `modelLabel` 被普通发送覆盖，误判为 bug（M2） | 中 | 高 | 文档/验收明确 A 口径；测试断言 `provider:model` + 徽标消失 | 不改行为 |
| R5 | Agent 多目标只跑第一个 | 中 | 高 | 工具开启时收起多目标，只留单目标；文案说明 | 显示「仅使用首个目标」 |
| R6 | 子会话只读边界被绕过 | 高 | 低 | `sub-session.ts` 统管；输入区不渲染可发送形态 | 隐藏输入区 |
| R7 | 设置页 MCP 依赖聊天态 | 中 | 中 | 挂载冒烟；必要时 props 解耦 | 保留旧标签 |
| R8 | 命令面板仍重复/路由到 Agent | 中 | 中 | P1 合并去重 + P4 grep 零残留 | revert P1 |
| R9 | 侧栏顺序整体回默认 / 固定项丢失 | 中 | 高 | 修 `normalizeSidebarOrder`；启动清洗回写；测试旧 12 项 | 用户重设 |
| R10 | 删除 Agent 壳造成能力回归 | 高 | 中 | 删除/迁移/保留表 + 全量回归 | revert P4 |
| R11 | 长 trace 卡顿 | 中 | 中 | 默认折叠 + 懒加载 + 分页/虚拟化 | 只显示摘要 |
| R12 | 虚拟列表摘要导致滚动跳动 | 中 | 中 | 先补 `getItemKey`（ChatView 当前没有）；摘要放轮次内 | 回退摘要 |
| R13 | 迁移后旧版本 Agent 列表变空 | 中 | 高 | 文档说明 + 降级 SQL；保留至 v1.4.0 | 备份恢复 |
| R14 | 旧版本降级期间写回前缀 | 中 | 中 | 启动幂等 repair | 再次升级自愈 |
| R15 | i18n 四语不同步 | 低 | 中 | parity + dead-key 测试；先补 key 再改 UI | revert 文案 |
| R16 | 早期 LRU 隐藏实例快捷键误触 | 中 | 中 | 单一对话实例；`isActiveModuleInstance` 自检 | 卸载隐藏监听 |

---

## 7. 评审问题落点（M1–M12）

| 编号 | v1 问题 | v2 落点 |
|---|---|---|
| M1 | 判定顺序把「关闭」判回「开启」 | §3.2 唯一事实源；§4.3 判定矩阵（显式 false 压过前缀）；P0 验收 3/4 |
| M2 | 「P1 不覆盖 modelLabel」事实错误 | §1.4；P1「M2 正文口径」；验收 P1-2；R4 |
| M3 | 库过滤/命令面板/`ChatModule` 早退未覆盖 | P0 库过滤；P1 命令面板去重、`ChatModule` 接收、`SessionRail` 过渡；验收 P1-3/4 |
| M4 | 每轮摘要缺数据接口 | §P2「run 索引」新增只读 IPC；messages 无 requestId，用 trace `message_id` 映射；删掉「后端零改动」 |
| M5 | 队列与观测订阅矛盾；双 run；子会话归属 | §P2「单一运行控制器」+ 主进程互斥；`sub-session.ts` 归属；R1/R2/R6 |
| M6 | 深链/快捷键不存在 | §3.6 真实三入口；P3 只做加法；滚动高亮列为新增 |
| M7 | MCP 依赖写错 | P3「M7 修正」：`usePipSource` / `CapabilityCenter` / `McpForm` / `McpImportModal` / `McpTemplatesModal` |
| M8 | P4 路径/清单/侧栏行为漏项 | P4 路径 `store/app-store.ts`；删除/迁移/保留表；`DETACHABLE_MODULE_IDS`、DetachedApp、CommandPalette、`pocketai-pending-conv`；`normalizeSidebarOrder` 修正 + 顺序保留 |
| M9 | 回滚链不成立 | P3 只做加法；P4 回滚恢复旧标签；各期回滚写「revert + 数据影响」 |
| M10 | 验收不可执行 | §8 全部二选一/可观测；IPC 调用次数；`npm run build` exit 0 |
| M11 | 「chat/agent 各自懒加载」错误 | §1.2 首屏加载行：Chat 静态、Agent lazy |
| M12 | 引用归因错误 | §2.1 表内标注；§2.2 归因修正 |

---

## 8. 验收口径

### 8.1 功能验收（逐条可执行）

**数据与开关**
1. 迁移夹具：`agent:p:m` → `p:m` + `agent_mode=1`；`p2:m2` 不变；空模型不变。
2. 关闭工具 → 重启 → 仍为关闭（`agent_mode=0`，`resolveAgentMode=false`）。
3. 关闭工具后发普通消息 → `conversations.model` 为 `provider:model`，无工具徽标，会话仍在列表（**A 口径，唯一答案**）。
4. 开启工具后跑一轮 → `model` 仍为 `provider:model`，`agent_mode=1`，徽标保留。

**入口与列表**
5. Agent 侧建会话并跑一轮 → 对话列表可见，徽标正确；跑完不消失。
6. 命令面板搜索同一会话 → 只出现一条，路由到对话页；无 `conv-agent` 第二组。
7. 旧 `pocketai-pending-conv`（`isAgent:true`）→ 落到对话页并选中。
8. 筛选「全部/允许工具/普通对话」与标题搜索 AND；`groupedMode` 仅在「全部」且非搜索时分组；全选只作用于筛选结果；归档区跟随筛选。
9. 跨助手消息跳转：先切助手再跳；查不到时 toast，不静默。

**运行记录**
10. 3 步工具任务：该轮摘要的步数/耗时/token/变更数与 `agent_traces` 一致；展开可看每步入参/返回。
11. 打开 1000 条消息会话：普通会话 `agent:list-runs` **0 次**；Agent 会话打开 1 次；滚动 **0 次**；展开一轮只多 **1 次** `getRunTraces`（IPC spy）。
12. 切会话再切回：摘要与 trace 正确恢复，不串会话。
13. 子会话：摘要显示数量；只读视图不可发送；返回正常。
14. 队列 FIFO、Done/Error 后 drain、插队边界生效、上限 20。
15. 同会话并发（主窗口 + 分体窗口）：正常发送被串行锁**排队**；绕锁直接调引擎时第二个请求 `AGENT_RUN_BUSY`，无第二条用户消息（兜底而非常态）。

**设置与退役**
16. 设置 → 能力 / 连接：MCP 与 Channels 完整可用；与 Agent 旧标签读同一配置。
17. 侧栏无 Agent；其余模块不变；旧 12 项顺序去掉 Agent 后保留相对顺序，不回默认。
18. `sidebar.pinned` 含 Agent → Agent 消失，其余固定项保留。
19. 命令面板无 Agent 模块命令；`#/detached?module=agent` 落到对话；`module=agent` 落到对话并选中最近工具会话（保留至 v1.4.0）。
20. 全量回归：普通对话（多模型、分支、文件夹、归档、置顶、草稿、提醒、导出、外部/加密导入）+ 工具会话（审批、todo、队列、停止、子会话、trace、变更清单）。
21. 通知跳转（`ReplyNotify`）只聚焦主窗口，不因删模块报错。

### 8.2 回滚演练

- P0：备份库 → 迁移 → 执行降级 SQL → 旧版本 Agent 列表恢复；代码 revert 后应用可用。
- P1：`git revert`；命令面板重复项恢复，无数据变化。
- P2：`git revert`；队列回到 `AgentComposer` 本地实现；新增 IPC 不再调用；无数据变化。
- P3：`git revert`；设置分区消失，Agent 旧标签仍在。
- P4：`git revert`；Agent 壳与旧标签恢复；侧栏顺序可能回默认一次，固定项需重设；会话数据无损。

### 8.3 非功能验收

- `npm run typecheck`：0 错误。
- `npx vitest run`：全绿；改动前记录文件/用例数，改动后不得减少；新增覆盖 P0 矩阵、P1 筛选/命令面板、P2 run 映射/队列/守卫。
- `npm run build`：当前平台 exit 0；发版另跑 `npm run dist`（Windows）与 `npm run dist:linux`。
- **性能（可观测）**：打开 1000 条消息会话，普通会话 `agent:list-runs` 调用次数为 **0**，Agent 会话为 **1**（摘要常驻的必要一次）；滚动为 **0**；展开一轮只多 **1 次** `getRunTraces`；摘要渲染不触发第二次读库。
- **数据**：P0 前后 `conversations` / `messages` / `agent_traces` 行数不变；仅 `conversations.model` 与 `agent_mode` 按迁移规则变化；无新增表/列。
- **i18n**：`tests/i18n-parity.test.ts`、`tests/i18n-dead-keys.test.ts` 全绿。

---

## 9. 这次不做的事

- **不做 P5 内部 hook 收口**：拆为独立技术债任务；若做，验收看「替换用例」而不是单纯减少用例数。
- **不引入任何会话类型**：不加 `conversationKind`、不加 `agent:` 身份、不做读时兼容脏约定。
- **不做配额/计费系统**：只暴露每轮 token 与耗时；不写「剩余额度」。
- **不做自动路由**：不让模型/规则判断该不该调用工具；开关由用户按会话决定。
- **不新建 Project / Workspace 容器**：不引入 Claude/Cursor 那种上层实体。
- **不做云端执行台**：无远程 VM、Cloud Computer、多设备同步。
- **不重做 Artifacts / 交付物中心**：导出、保存为笔记、HTML 导出保持原状。
- **不合并审批与 todo**：已共享，不动。
- **不改 Channels 入站会话语义**：入站如何建会话、归属哪个助手，保持现状。
- **不做导出/导入的 trace 迁移**：聊天导出不含 trace/change_set；加密导入 meta 不含能力开关，导入后默认普通对话。
- **不做 MCP/Channels 的深链/快捷键**：现状没有；P3 只加设置入口，「滚动到分区 + 高亮」若要另立实现。
- **不改 `ReplyNotify` 跳转**：只聚焦主窗口。
- **不做移动端/响应式重排**。
- **不引入长期 feature flag 体系**：每期用独立 commit + revert 实现可回滚。
- **不在 P4 前删除任何 Agent 能力**：删除集中在 P4，且有「删除/迁移/保留」闸门。

---

## 10. 附录：关键文件索引

| 角色 | 文件 |
|---|---|
| 入口与模块挂载 | `src/renderer/src/components/Sidebar.tsx`、`src/renderer/src/components/Workspace.tsx` |
| 对话壳 | `src/renderer/src/modules/chat/ChatModule.tsx`、`ChatView.tsx`、`Composer.tsx`、`ConversationList.tsx`、`useStreamSession.ts`、`messages-reducer.ts`、`useAgentRunInsights.ts`、`agent-mode.ts`、`send-payload.ts` |
| Agent 壳（已删除） | 已于 P4 批次 2 删除（`dbfd248`，81 文件／−11414 行）：`modules/agent/AgentModule.tsx`、`chat/AgentPanel.tsx`、`hooks/useAgentChat.ts`、`components/SessionRail.tsx`、`components/AgentComposer.tsx`；能力已并入对话壳，`modules/agent/` 现只余 `ui.tsx` 展示件与「配置面板」行的两个面板（经 `settings/EmbeddedAgentPanels.tsx` 挂到设置页） |
| 共享运行组件 | `src/renderer/src/components/agent/AgentMessageCard.tsx`、`TraceReplayStatus.tsx`、`agent-shared.ts` |
| 配置面板 | `src/renderer/src/modules/agent/mcp/McpPanel.tsx`、`src/renderer/src/modules/agent/channels/ChannelsPanel.tsx` |
| 设置入口 | `src/renderer/src/modules/settings/SettingsModule.tsx` |
| 主进程链路 | `src/main/chat/chat-service.ts`、`src/main/agent/engine.ts`、`src/main/db/repositories/conversation.repo.ts`、`src/main/db/repositories/agent-trace.repo.ts`、`src/main/db/database.ts` |
| 共享契约 | `src/shared/types.ts`、`src/shared/schemas/chat.ts` |
| 命令/导航 | `src/renderer/src/components/CommandPalette.tsx`、`src/renderer/src/utils/palette-nav.ts` |
| 侧栏状态 | `src/renderer/src/store/app-store.ts` |
| 分体窗口 | `src/renderer/src/detached/DetachedApp.tsx` |

## 11. P5（技术债，已拍板执行）：内部 hook 收口

> 本节把 §0／§9 中「拆出本方案」的 P5 落成可执行口径。只做文件搬迁与去反向依赖，不改行为、不动数据；每批独立提交、可单独 revert。

### 11.1 目标

- 对话壳不再从 `modules/agent/hooks` 直接引 hook；`agent/hooks` 不再反向依赖 `modules/chat`（P5 批次 1 后 `useAgentRunInsights` 已随搬家把 `../../chat/run-turn-map` 收成 `./run-turn-map`）。
- 批次 3 修订：共享卡片不再「一律留在 `agent/`」。`agent/` 最终只保留设置面板（MCP/Channels）与挂载入口 `ui.tsx`；对话壳、浮窗都要用的共享组件与纯工具统一搬到中立的 `src/renderer/src/components/agent/`，`agent/` 不得再有任何 `agent → chat` 反向依赖。
  - 推翻原口径的原因：`agent/` 已不再是 Agent 业务壳，只剩设置面板；把共享卡片继续留在 `agent/components` 会让「设置面板的私有组件」和「对话页的渲染件」混在同一目录，且 `popup/` 引用它时必须跨到 `modules/agent`。中立目录让 `chat/`、`popup/`、设置面板都只向下依赖组件层。
  - 边界：只搬「被跨模块复用」的渲染件与纯工具；只服务单一模块的实现仍留在该模块（`queue-settlement.ts`、`sub-session.ts` 只服务对话壳，归 `chat/`）。

### 11.2 文件清单

| 批次 | 搬迁 | 同步改引用 |
|---|---|---|
| 1 | `agent/hooks/messages-reducer.ts` → `chat/messages-reducer.ts`；`agent/hooks/useAgentRunInsights.ts` → `chat/useAgentRunInsights.ts`（`../../chat/run-turn-map` 收成 `./run-turn-map`） | `chat/useStreamSession.ts`、`chat/ChatModule.tsx`；`tests/messages-reducer-truncate.test.ts`、`tests/agent-delegate-role-label.test.tsx` |
| 2 | `agent/hooks/useAgentToolConfigs.ts` → `chat/useAgentToolConfigs.ts`；`agent/components/AgentToolBars.tsx` → `chat/AgentToolBars.tsx` | `chat/ComposerToolConfig.tsx`；`tests/helpers/renderer.tsx`、`ipc-agent-config-unread-257`、`ipc-failure-t1-214`、`ipc-judged-takeover-250`、`keyboard-submit-340`、`renderer-agent-shell-hint`、`renderer-hint-title-410`、`renderer-websearch-b3`、`renderer-websearch-searxng-407`、`truncate-hint-title-gate-410`、`enter-composing-gate-340` |
| 3 | `agent/agent-shared.ts` 与 11 个共享组件/工具（`AgentMessageCard`、`HtmlBlockActions`、`FsWriteActions`、`AgentLiveStepStrip`、`AgentRunSummary`、`AgentRunInspector`、`AgentTraceList`、`TraceReplayStatus`、`ZeroToolCallNotice`、`ToolPolicyDialog`、`virtual-list-utils`）→ `components/agent/`；`agent/queue-settlement.ts`、`agent/sub-session.ts` → `chat/`；`chat/assistant-display.ts` → `utils/assistant-display.ts`（消 `ChannelsPanel → chat` 反向依赖，选整文件平移这一侵入最小的做法） | 18 个 src 文件（`chat/ChatView.tsx`、`ChatModule.tsx`、`messages-reducer.ts` 等，`popup/PopupApp.tsx`、`components/CommandPalette.tsx`、`agent/channels/ChannelsPanel.tsx` 等）；21 个用例的路径锚点 |

### 11.3 验收

- `npm run typecheck` 0 错误；每批运行相关用例与 `waitfor-gate-364`、`i18n-dead-keys`、`i18n-parity`、`i18n-interpolation-361`。
- 受影响用例与闸门的路径锚点全部更新；每个搬走的 hook 至少有一条行为用例打在新入口；基线按用例数计，改动后不得减少。
- 批次 2 追加 `npm run build`，核对 chunk 无异常增长；行尾保持 LF。
- 批次 3 追加 `npm run build` 前后对照：先在 HEAD 干净工作区构建记录产物，再在搬迁后的工作区构建比对，主 chunk 的文件名、体积、SHA-256 必须一致；行尾保持 LF，不留 re-export 转发壳。

### 11.4 不做

- 不合并统一 runtime（如 `useAgentRuntime`）；不新建 `chat/hooks/`，`chat/` 继续平铺。
- 不搬共享卡片（`AgentMessageCard`、`AgentLiveStepStrip`、`AgentRunSummary`、`ZeroToolCallNotice`、`ToolPolicyDialog` 等）；批次 2 的 `AgentToolBars` 是随工具配置 hook 一起搬的唯一例外。
  - 批次 3 修订：本条已推翻。共享卡片与纯工具统一搬到中立目录 `src/renderer/src/components/agent/`（见 §11.1 的原因与边界）；`MCP`／`Channels` 面板与 `ui.tsx` 仍不搬。
- 不搬 `MCP`／`Channels` 面板（留在 `agent/`，只挂设置）；不改行为、不改测试断言口径、不改数据库与配置，本阶段没有需要迁移的数据。
