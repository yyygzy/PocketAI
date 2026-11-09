# WorkBuddy 桌面端拆解报告

- 调研对象：腾讯 WorkBuddy（Windows），本机安装版
- 调研日期：2026-11-09
- 调研方式：只读检查安装目录、注册表、开始菜单快捷方式、用户配置目录、日志，以及 `app.asar` 的目录与关键文件
- 调研边界：全程未启动应用、未登录、未联网、未截图、未做源码级审计；下文凡由打包产物推断的内容均标注「推断」

## 0. 阅读约定

- **[事实]**：可直接从注册表、文件系统、日志或产物文件内容确认
- **（推断）**：由打包产物、文案、文件名、目录结构推导，未实机验证
- 文中路径均指本机实际路径；asar 内路径以 `app.asar!/` 表示，仅用于说明逻辑位置

## 1. 产品与版本事实

### 1.1 安装与版本

**[事实]**

| 项 | 值 |
| --- | --- |
| 产品名 | WorkBuddy 5.9.3 |
| 发行方 | Tencent Technology (Shenzhen) Company Limited |
| 安装目录 | `C:\APP\wb\WorkBuddy` |
| 主程序 | `C:\APP\wb\WorkBuddy\WorkBuddy.exe`（195.1 MB） |
| 卸载注册表项 | `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\BFD312E9-1019-4F57-9F44-F86246833B50` |
| 卸载命令 | `"C:\APP\wb\WorkBuddy\Uninstall WorkBuddy.exe" /currentuser` |
| 开始菜单 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\WorkBuddy.lnk`，目标指向主程序 |
| 安装范围 | per-user（HKCU，卸载命令带 `/currentuser`） |

注册表未写入 `InstallDate` 与 `InstallLocation`。目录创建时间为 2026-09-14 00:13:42；当前主程序与 resources 的落地时间为 2026-10-28 08:35–08:36，exe 自身写入时间为 2026-10-27 17:31:32。**安装时间只能用目录创建时间近似**，不能视为精确安装日期。

### 1.2 包体与签名

**[事实]**

- `WorkBuddy.exe` Authenticode 状态为 Valid，签名主体为腾讯科技（深圳），证书有效期至 2027-04-08
- `resources\app.asar` 173.6 MB
- `resources\app.asar.unpacked` 含原生模块与未打包资源
- 同目录存在 `chrome_*.pak`、`icudtl.dat`、`v8_context_snapshot.bin`、`libEGL.dll`、`libGLESv2.dll`、`LICENSE.electron.txt`、`version`
- `version` 文件内容为 `37.10.3-43`，即 Electron 37 系列
- 原生/外置件包括 node-pty 相关 DLL、PortableGit、内置 Python、ripgrep、`sandbox-cli.exe`、`tsbx*.dll`、`elevate.exe`

### 1.3 技术栈判定

**[事实]** 技术栈为 Electron，不是 CEF、Tauri 或纯原生：

- `version` 与 Electron 运行时文件齐全
- `app.asar` 内为 `main/`、`preload/`、`renderer/`、`cli/` 结构
- renderer 资源中包含 `react-dom`、`floating-ui.react-dom`，前端为 React **（推断：React 为主框架，另含 Vue/Svelte 兼容 shim）**

### 1.4 进程与数据落点

**[事实]** 来自 `%LOCALAPPDATA%\WorkBuddy\logs\main.log`：

- `Window created before daemon bootstrap`：主窗口先创建，daemon 异步启动
- `Skipping desktop database service; app-server owns SQLite`
- `Skipping desktop database migration; app-server owns SQLite startup migration`
- `Spawning daemon app-server process`，`execPath` 为 WorkBuddy.exe，入口位于 `app.asar\main\daemon-app-server...`
- `PAC resolver installed (per-request resolveProxy via host bridge)`
- `[PacRpc] listening on \\.\pipe\workbuddy-pac-<pid>-<hex>`

**[事实]** 用户数据目录为 `%USERPROFILE%\.workbuddy`，包含 `workbuddy.db`、`settings.json`、`keyblob`、`audit-log`、`security`、`sessions` 等。

**[事实]** `workbuddy.db` 表包括：`sessions`、`session_usage`、`automations`、`automation_runs`、`automation_delivery_outbox`、`automation_runtime_state`、`workspace_trust_decisions`、`buddy_snapshots`。

`sessions` 的关键字段包括：`cwd`、`title`、`status`、`mode`、`model`、`expert_id`、`permission_mode`、`use_sandbox_cli`、`project_id`、`plugin_context_json`、`session_settings`、`thought_level`、`transport`、`conversation_origin`、`visibility`、`group_id`、`group_title`、`agent_dirty`。

**[事实]** `cli/package.json` 显示内置 Agent 内核为 `@genie/agent-cli` 2.165.0；`cli/product.json` 的 `name` 为 `WorkBuddy`，`requestMaxStepLimit` 为 100。

## 2. Agent 运行时与工具编排

### 2.1 运行时分层

**[事实]**

- Electron 主进程只做窗口、系统集成与桥接，不持有业务数据库
- SQLite、迁移、会话执行由独立 daemon（app-server）负责
- daemon 使用同一个可执行文件启动，不是另装 CLI
- 本地 RPC 走命名管道，管道名带 pid 与随机 hex 片段
- 主进程与 daemon 之间有 PAC RPC 通道，按请求解析代理

**（推断）** 这种分层的主要收益是：窗口崩溃或重启不影响长任务；daemon 可以在窗口关闭后继续收尾；数据库只有一个写入者，避免多进程锁竞争。

### 2.2 工具与智能体注册

**[事实]** `product.json` 注册了 65 个工具、21 个 agent、9 个 slash command。

工具覆盖面包括：文件读写与编辑、Glob/Grep、Bash/PowerShell、WebFetch/WebSearch、MCP 资源、任务管理（TaskCreate/TaskGet/TaskUpdate/TaskList）、计划模式（EnterPlanMode/ExitPlanMode）、Skill/SkillManage、AskUserQuestion、LSP、ToolSearch/DeferExecuteTool、图像/视频/音频生成、Artifact、ComputerUse、Team 协作、SendMessage、Worktree、Cron、Monitor、REPL、A2A、Workflow。

agent 列表包含：`general-purpose`、`compact`、`contextSummary`、`securityReviewer`、`autoModeClassifier`、`Explore`、`Plan`、`handoff-summary` 等；内置子代理 `code-explorer` 以 Markdown + frontmatter 定义，工具集被限定为只读检索类。

**[事实]** 交互模式以插件形式内置：`resources/plugins/workbuddy-builtin/interactionmode/{ask,craft,expert,plan,quick}`。`ask` 模式的 `current-mode.md` 明确写死：只读、不得改文件、不得执行 shell、用户要求写入时应提示切换到 Agent 模式。

**（推断）** 工具注册表与 agent 定义集中在 `product.json`，说明服务端下发的产品配置可以改工具面，而不必发版。

### 2.3 交互模式

**[事实]** 内置 ask、craft、expert、plan、quick 五种模式目录，各带 `fragments/*.md` 与 `plugin.json`；`craft` 与 `plan` 的 `current-mode.md` 为 0 字节。

**[事实]** Prompt 采用片段拼接：`craft/fragments/tool-use.md` 中出现 `{% include "prompt-common/fragments/agent-to-agent.md" %}` 与条件变量 `{%- if WecomAgentAvailable -%}`。

**（推断）** 模式差异主要由 prompt 片段 + 工具策略组合实现，而不是多套执行引擎。

### 2.4 审批与权限编排

**[事实]**

- 会话表持久化 `permission_mode` 与 `use_sandbox_cli`
- 代码中出现 `Plan`、`Default`、`bypassPermissions` 等权限模式；`--dangerously-skip-permissions` 会映射到 `bypassPermissions`
- 字符串表中存在 `--allow-dangerously-skip-permissions` 开关
- 内置 hook `high-credit-gate.cjs`：扫描 `mcps/*/high-credit-tools.json`，命中计费工具时返回 `permissionDecision: 'ask'`
- 该判定发生在所有权限规则与 `bypassPermissions` 之前，因此 bypass 模式下仍会弹审批
- hook 明确禁止返回 `allow`（会短路后续权限检查），读取失败按「继续询问」处理，exit code 恒为 0
- 审批记忆按清单中的分组名生效

**（推断）** 审批分三层：产品级强制闸门（计费工具）→ 会话权限模式 → 工具/路径/命令规则。强制闸门优先级最高，是这套设计里最值得借鉴的部分。

### 2.5 并发、中断与进程收尾

**[事实]**

- Windows 下使用 Job Object 做 kill-on-close（`job-object.node`，x64/arm64 双架构）
- `no-orphans.cjs` 只清理当前进程派生的子孙进程，不安装 parent-death watchdog
- `daemon-supervisor.cjs` 单独派生 daemon，并明确不加入 worker 的 Job，避免启动器退出时误杀 daemon
- supervisor 只接受满足 `--serve` 且 `CODEBUDDY_SESSION_KIND=daemon` 的启动请求
- 子代理派生有深度上限，代码中可见 `depth > 2` 时拒绝
- 工具层提供 `KillShell`、`TaskStop`、`TaskOutput`，团队协作提供 `TeamCreate`、`SendMessage`、`EnterWorktree/LeaveWorktree`

**（推断）** 并发模型是「主会话 + 受限深度的子代理 + 可选 worktree 隔离」，而不是无限并行。

### 2.6 上下文与步数治理

**[事实]**

- 单次请求最大步数为 100
- 内置 `compact`、`contextSummary`、`summaryGenerator`、`memorySelector`、`insightsAnalyzer` 等 agent
- 工具结果通过 `ToolSearch` / `DeferExecuteTool` 延迟加载
- 会话可配置 `thought_level`、`session_settings`、`plugin_context_json`

**（推断）** 上下文治理以「压缩 agent + 延迟工具加载 + 步数上限」为主，具体阈值未在本次可读产物中确认。

### 2.7 定时任务

**[事实]**

- 数据库有 `automations`、`automation_runs`、`automation_delivery_outbox`、`automation_runtime_state`
- 自动化配置含 `permission_mode`、`use_sandbox_cli`、工作区范围
- 界面文案区分「免确认执行」与「需逐次确认」，并提示无人值守时人离开屏幕任务会停在等待状态
- 产物生成后可走系统通知，也可回传到小程序

**（推断）** outbox 表说明定时任务的投递（通知/IM）与执行解耦，失败可重试。

## 3. 界面布局与会话组织（推断）

> 本节未实机观察，全部由 renderer 产物、语言包、CSS 与窗口类名推断。

### 3.1 主窗骨架与尺寸

- 侧栏宽 220px，标题栏高 38px，侧栏按钮 36px，会话项 24px，侧栏条目 28px（来自 `index.html` 骨架 CSS）
- 骨架与最终布局同构，主题色由主进程通过 query 注入（`windowTheme` 或 `colorScheme`、`windowBackgroundLight/Dark`、`windowTitleBarHeight`）
- 登录账号快照通过 `?accountSnapshot=` 注入 `window.__initialAccount`，用于跳过等待 daemon `getAccount` 的冷启动窗口
- 主进程在 HTML 解析阶段即注入主题与窗口外观，避免首帧闪烁

### 3.2 侧栏与多会话

- 分组：置顶、任务、空间、工作空间、助理任务
- 分组标题可折叠/展开，支持筛选与空结果提示
- 分组可带状态角标：进行中、待确认、失败、未读
- 存在「新侧栏 / 经典侧栏」切换
- 底部入口包括任务列表、系统设置、浅色/深色主题、版本与更新、二维码小程序入口

### 3.3 右侧产物面板

- 右侧详情面板分「产物 / 文件变更 / 引用来源」
- 产物支持预览、在独立窗口打开、在默认应用打开、另存为
- 对超大文件与不支持类型有明确拒绝文案
- 快捷键可切换右侧面板

### 3.4 设置分区

设置路由固定 19 个 tab：`account`、`subscriptionUsage`、`connectors`、`settings`、`appearance`、`extensions`、`deviceConnections`、`securityCenter`、`keyboardShortcuts`、`memory`、`models`、`claw`、`buddyApps`、`personalization`、`conversationFlow`、`dataManagement`、`helpFeedback`、`laboratory`、`getHelp`。

旧路由 `systemPermissions`、`softwareConfig` 会重定向到 `securityCenter`，说明安全相关设置被合并为一级入口。

### 3.5 安全中心（界面）

- 工具控制：控制智能体可调用的 Tool 与 MCP，区分必要工具与自定义 MCP
- 网络策略：按 URL/域名配置允许/拒绝，并带优先级
- 命令策略：按命令前缀配置允许/询问
- 文件策略：按路径配置读/写/删除
- 敏感数据保护规则
- 沙箱开关与审批模式
- 审计查询：时间、操作等列，支持导出

### 3.6 多窗口

窗口骨架类名显示至少存在这些窗口形态：主窗、设置、会话、全局搜索、图片查看、开发者资料、Office 冷启动、合并详情、微信相关窗口。每类窗口有独立骨架与主题适配。

### 3.7 扩展 UI

**[事实]** 内置 8 个扩展：`cloud-assistant`、`community`、`edge-sync`、`global-search`、`im-channels`、`library`、`remote-desktop`、`workbuddy-baas-v2`。

扩展清单声明 `ui.entry.url`（指向 `./ui/assets/remoteEntry.js`）、`keepAlive`、`pickers`，以及可选的 `service.entry`（`fork` 子进程）。前端通过 Module Federation 共享 React/ReactDOM 单例。

**（推断）** 这是「主壳 + 微前端 + 可选服务进程」的插件化架构，适合大团队并行发版，不适合小团队早期照搬。

## 4. 权限与安全设计

### 4.1 渲染进程隔离

**[事实]** `main/secure-web-preferences.js` 按窗口类型返回白名单配置：

- `main`：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`nodeIntegrationInSubFrames: true`、`webviewTag: true`
- `first-party-window`：沙箱 + 隔离，关闭后台节流
- `guest-popup`：沙箱 + 隔离，无 Node
- `image-decoder`：独立 partition，`webSecurity: false`、`sandbox: false`
- `splash`：沙箱关闭、无 Node
- `no-preload-guest`：无 preload、沙箱 + 隔离

**[推断]** 集中式白名单比在每个 `BrowserWindow` 里散写选项更易审计；但 `main` 开启 `webviewTag` 与子帧 Node 预加载，攻击面偏大。

### 4.2 启动种子 token

**[事实]** `index.html` 用正则 `[?&]wbSeedToken=([0-9a-f]{32})` 取主进程注入的 32 位 hex token，再 `document.write` 加载 `wb-seed://seed/<token>/startup-seed.js`。注释说明该 token 是安全边界，避免 sandboxed `srcdoc` iframe 直接获取能力。

**[推断]** 用 token 作用域替代放宽 `script-src`，是比 `unsafe-inline` 更细的做法。

### 4.3 工作区信任

**[事实]** 存在工作区授信状态表 `workspace_trust_decisions` 与「受限模式」：

- 受限模式下不自动加载项目级配置
- Agent Runtime 的 Bash 工具被禁用
- 用户可「正常打开」或「以受限模式打开」，可保持/关闭受限模式
- 部分授信变更需要新任务或重启后生效

### 4.4 凭据与静态加密

**[事实]**

- 设置文件按字段加密，适配器名为 `credential-fields`，写入角色为 `daemon`
- 加密模式含 `disabled`、`standard`、`advanced`
- 加密信封形如 `{$wbEncrypted: 1, envelope: ...}`；`advanced` 使用 `scheme: asym-v1`
- 密钥材料落 `~/.workbuddy/keyblob`
- daemon 启动有 credential-protection bootstrap 握手，超时 5 秒后降级并记录事件
- 握手会做指纹去重与冲突检测
- 读取旧格式时触发迁移，迁移失败记录事件

**（推断）** `advanced` 的非对称信封可能用于企业侧密钥托管/审计；是否默认启用、默认档位为何，本次无法确认。

### 4.5 工具与出网治理

**[事实]**

- MCP 工具调用前有 `sensitiveToolEgressGuard` 审查，序列化失败或 guard 不可用即拒绝
- 官方 MCP 另有 egress policy 名单
- MCP App 使用双层 iframe 沙箱代理，按 App 声明生成动态 CSP
- 权限默认下发 `clipboard-write`、`fullscreen`，仅当声明时才放行 camera/microphone/geolocation
- 安全中心提供网络、命令、文件三类策略

**（推断）** 出网治理主要发生在「工具调用前」，而不是全局网络层；Electron 自身的网络栈未看到统一出站白名单。

### 4.6 审计与配置保护

**[事实]** `main/fs-protection.js` 对配置目录内的删除操作做审计：

- 保护对象：配置目录本身、`workbuddy.db`、`app`、`memory`、`logs`、`keyblob`
- 拦截的 API：`unlinkSync`、`rmdirSync`、`rmSync`、`unlink`、`rmdir`、`rm` 及 promises 版本
- 命中时写入 `fs-protection.log`，记录 API、目标、是否递归、决策、调用栈
- 决策值为 `WARN`，**不阻断删除**
- 日志超过 5 MB 轮转

**（推断）** 这是「事后取证」而非「防误删」，对小白用户的保护有限。

### 4.7 网络韧性

**[事实]** `main/network-gate.js`：

- 启动后等待网络可用，按 500/1000/2000/3000/5000 ms 退避重试，最长 30 秒
- 探测主机为 `copilot.tencent.com`
- 支持 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`
- 能生成网络诊断报告文本，包含 hosts 文件快照

### 4.8 反面样本

**[事实]**

- 存在 `DisableTlsVerification` 产品开关，命中后设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，并屏蔽对应的 Node 警告
- 主窗开启 `webviewTag` 与 `nodeIntegrationInSubFrames`
- 配置删除只审计不阻断

**（推断）** TLS 开关可能是为企业代理/自签环境准备的逃生口，但对消费级安全产品是危险默认，不应移植。

## 5. 可借鉴清单（按性价比排序）

### P0：低成本、直接改善体验或安全

1. **工作区信任/受限模式**：不加载项目配置、禁用命令执行，需显式授信
2. **每类窗口的骨架屏**：骨架与最终布局同构，主题首帧就位，避免白屏等运行时
3. **账号/主题快照首绘**：主进程通过 query 注入，前端跳过等待 daemon 的冷启动
4. **会话与运行态分离**：会话持久化，运行态用 `runState/executionStage/terminalOutcome/turnSeq` 表达
5. **侧栏状态角标**：进行中、待确认、失败、未读，直接回答「哪个任务需要我」
6. **审批顺序**：高风险/计费工具强制询问，优先级高于「全自动」，配置缺失时失败关闭
7. **右侧产物面板**：产物、文件变更、引用来源三栏，支持独立窗口打开
8. **`webPreferences` 集中白名单**：按窗口类型返回配置，禁止散写

### P1：需要架构投入

9. **Agent 运行时独立进程**：窗口先起、运行时后置，SQLite 单写者
10. **本地 IPC 使用带随机 token 的命名管道**，而不是裸端口
11. **Windows Job Object 收尾**：kill-on-close，daemon 由独立 supervisor 派生并脱离 worker Job
12. **设置字段级加密**：先做标准档 + 迁移 + 启动握手降级，不急于自研复杂信封
13. **最小安全中心**：先做审计日志 + 网络/命令/文件三类策略，不做优先级编辑器
14. **MCP App 双 iframe 沙箱**：动态 CSP + 按声明下发权限
15. **MCP 出网敏感数据审查**：调用前检查，失败拒绝

### P2：生态成熟后再考虑

16. **扩展清单 + Module Federation**：主壳共享 React 单例，扩展可带 fork 服务进程
17. **定时任务 outbox**：执行与通知/IM 投递解耦
18. **Prompt 片段化 + 条件 include**：交互模式作为可独立发版的插件
19. **无人值守任务的独立权限档**：免确认与逐次确认明确区分

## 6. 明确不建议移植的项及理由

| 项 | 不移植的理由 |
| --- | --- |
| 65 工具的大注册表 | 维护成本高、模型选择困难、权限面过大；小团队应先做 8–12 个高价值工具 |
| 微前端联邦 | 引入构建、版本、样式隔离、共享依赖等复杂度，早期收益低于成本 |
| 自带 Python/Git/ripgrep/沙箱二进制 | 包体增加上百 MB，更新与漏洞修复成本高 |
| `DisableTlsVerification` 开关 | 关闭 TLS 校验并屏蔽警告，属于危险默认 |
| `nodeIntegrationInSubFrames` + `webviewTag` | 不必要地扩大攻击面 |
| 自研 Windows 沙箱（sandbox-cli/tsbx） | 实现与维护门槛高，应优先用系统能力与最小权限 |
| 纯审计不拦截的配置保护 | 给用户虚假安全感，应至少对 `keyblob`、数据库做硬阻断 |
| 安全中心的优先级规则编辑器 | 对非技术用户过重；应提供预设档位而非规则编排 |
| 为 Vue/Svelte 背兼容 shim | 包体与测试成本换不来早期价值 |
| 全量 i18n 多语言包 + 巨型 CSS | 1.4 MB 单 CSS 与多套 UI 运行时属于规模化后的包袱 |

## 7. 未验证项与边界

1. **界面未实机观察**：未启动应用、未截图；布局、侧栏、设置分区、安全中心交互均由产物推断
2. **craft/plan 的 prompt 片段为 0 字节**：`craft/fragments/current-mode.md` 与 `plan/fragments/current-mode.md` 为空，模式完整行为无法确认
3. **`advanced` 加密默认值未知**：无法确认默认档位、是否绑定企业密钥、是否默认启用
4. **原生沙箱未审计**：`sandbox-cli.exe`、`tsbx*.dll`、Job Object 原生绑定未逆向，隔离强度无法验证
5. **安装时间用目录创建时间近似**：注册表无 `InstallDate`
6. **审批链路未实机跑通**：只读到 hook 与权限模式代码，未观察真实弹窗、记忆与并发表现
7. **安全中心策略的执行位置未确认**：无法判断规则是在工具层、沙箱层还是仅 prompt 约束
8. **性能数据缺失**：未测量冷启动、首 token、长会话内存、daemon 崩溃恢复
9. **未联网**：所有结论仅基于本机静态证据；网络不稳定时未做任何在线校验
10. **未做源码审计**：asar 内为压缩/混淆产物，结论以行为与配置为准，不代表代码质量评价
