# 墨匣 Moxia / PocketAI — 安全审计台账

> 起始：2026-10-08（基于 main 分支 v1.2.8）。本台账登记全项目只读安全审计的发现、证据链、修复批次与验证结论，供后续按优先级推进。
> 状态标记：`待修复` / `已规划` / `修复中` / `已修复` / `待决策` / `误报`
> 威胁模型：本地优先 + U 盘便携。攻击者可离线获得 `app.db` / `config.json` / 日志 / WebDAV 备份包；运行时不可信输入面为 LLM 输出、MCP server 返回、网页/ICS/技能与助手导入内容。

---

## 一、审计范围与方法

1. **模块深读**（人工逐行）：`src/main/knowledge`（17 文件，检索链路）、`src/main/agent`（engine 1632 行 + 审批 + safe-params）、`src/main/tools`（13 文件，含 shell/fs/sandbox 边界）、`src/shared/text-tool-protocol.ts`、`src/shared/tool-preview.ts`。
2. **并行子审计 4 路**：加密与密钥（crypto/lock/license/backup/secret-store）、IPC 与网络边界（ipc/preload/net/files/export/channels）、代码执行与外部集成（mcp/sandbox/terminal/python/skills/assistant 导入导出）、渲染层与 Electron 配置（窗口 webPreferences/CSP/markdown/mermaid/导出）。
3. **证据复核**：子审计全部 Critical/High 逐条回读源码定位行号，剔除 1 条被实测证伪的结论与 2 处路径/事实错误（见第三节）。
4. **实测验证**：在工作区 `data/csp-probe/`（gitignore 内）用 Electron 44 起 `show:false` + `sandbox:true` 窗口 `loadFile` 一个含内联脚本的页面，同时注册 `onHeadersReceived` 注入 `script-src 'self'`，采集 `console-message`。结论见第三节第 1 条。探针目录已删除，未改动任何生产代码。

---

## 二、发现清单

### A. Critical

| # | 模块 | 文件:行 | 现象 | 状态 |
|---|------|---------|------|------|
| SEC-1 | 字段加密 | `crypto/master-key.ts:26-27,46-49,63,107-111` + `crypto/field-encrypt.ts:26-33,60-62` + `db/repositories/app-config.repo.ts:144` + `crypto/secret-store.ts:44,65` | 默认加密模式为 `'none'`，此时 `getFieldKey()` 返回由源码公开口令 `PocketAI-local-only` + 固定盐 `PocketAI-fixed-key-v1` 经 scrypt 派生的 `fixedFieldKey`。provider apiKeys 与 KV 凭据（Telegram/Slack/Discord token、websearch key）全部用它加密落盘。代码注释自己声明「派生输入随源码公开，任何人可复现」「仅用于非敏感场景，不是真正的安全保障」，与实际用途直接矛盾——拿到 U 盘 + 公开源码即可解出全部凭据 | 待修复 |
| SEC-2 | MCP 导入 | `shared/mcp-import.ts:110-121` → `shared/schemas/mcp.ts:66` → `mcp/manager.ts`（spawn）+ `renderer/.../mcp/McpImportModal.tsx:97-108` | 导入 `mcpServers` JSON 原样接受任意 `command/args/env` 且 `enabled:true`；schema 仅校验 command 长度，无白名单/存在性校验；导入预览只渲染 `key + [stdio]`，看不到命令本体，McpPanel 点启动也无确认。粘贴一段 `{"command":"powershell","args":["-enc","…"]}` 即可落地执行。**严重度校正**：实测无开机自启（`index.ts` 不触 `mcpManager`），import 只写库，且 Agent 只能调 `status==='running'` 的工具，故真正的执行闸门是「点启动」——修复落在预览展开 + 启动前确认，无需导入期闸门 | 已修复 |

### B. High

| # | 模块 | 文件:行 | 现象 | 状态 |
|---|------|---------|------|------|
| SEC-3 | 助手导入 | `shared/assistant-port.ts:109` + `ipc/handlers/assistants.ts:113-115` + `tools/registry.ts:52` | 导入文件原样透传 `toolPermissions`（可含 `"*"`）与最长 100K 的 `systemPrompt`；命中同名走 `save({...draft, id: existing.id})` 静默覆盖既有助手。`"*"` = 放开 `shell_exec`/`fs_write`/`js_eval` 等全部工具。导入一个「工作助手」= 替换系统提示 + 授予全工具 + 持久改写用户配置。修复：导入侧清空 `toolPermissions`（计入 `droppedTools` 提示重勾）+ engine 空数组语义收口 + 同名覆盖改两段式确认 | 已修复 |
| SEC-4 | 工具注册 | `mcp/manager.ts:418-428`（id=`mcp:<serverId>:<name>`，不查与内置重名）vs `tools/registry.ts:40-42,85,127-129` | 授权按 `id`（`filterByPermissions`）、解析执行按 `name`（`listAll().find(t => t.name === …)`，内置在前）。授权按 `id`（`filterByPermissions`）、解析执行按 `name`（`listAll().find(t => t.name === …)`，内置在前），且 MCP 工具名不与内置/其它 Server 查重。**严重度校正（原表述部分证伪）**：`classify`/`execute` 在按 name 找到 schema 后仍会用 `allowedToolIds.has(schema.id)` 二次校验（`registry.ts:143,188`），因此「只勾 MCP 那条 id」得到的是 `deny TOOL_NOT_ALLOWED`，**不是越权执行**。真实缺陷是另外三种：① `*`（Agent 默认）授权下模型按 MCP 的描述/参数调用、实际命中的是内置工具（行为被静默替换）；② 两个 Server 同名工具恒路由到第一个；③ `tools` 数组出现同名重复项。修复：`ensureUniqueToolNames` 给冲突名/非法函数名加 server 作用域别名并保留 `remoteName`，`id` 不变故既有授权不受影响（`tests/tool-name-collision.test.ts` 含复刻旧构造的对照组） | 已修复 |
| SEC-5 | MCP 权限 | `mcp/manager.ts:56-77` + `tools/registry.ts:98-115` | MCP 工具权限纯按名称分级：命中 `get/list/read/search/find/fetch/query/status…` 前缀即 `auto`（无审批执行），且 `source==='mcp'` 没有 args 级 `classify` 钩子。恶意/被攻陷 server 把执行类工具命名 `get_status`、`read_config` 即绕过。关键词表缺 `set/put/patch/deploy/download/publish/import/invoke/login/switch`。修复：默认一律 `confirm`，名称分级仅在用户对该 Server 显式勾选 `trustReadOnly`（migration v44）后才生效，不修补词表（名字不可信就不该作为放行依据） | 已修复 |
| SEC-6 | 备份恢复 | `ipc/handlers/backup.ts:82-100` + `backup/backup-service.ts`（restore 路径） | `BACKUP_LOCAL_RESTORE` 是极少数「带参数却无 argsSchema」的 handler；`payload.filePath` 非空即跳过文件对话框，直接读任意路径、解压、覆盖 `DATA_DIR/app.db` 并切主密钥。渲染层一旦注入，一次调用即完成数据销毁或旧备份重放。**表述校正**：渲染层正常路径其实已有 `bk.localRestoreConfirm` 确认（`SettingsModule.tsx:852`），缺陷是**确认只存在于渲染层、主进程无权威**——注入可绕过 UI 直接调通道。修复：入参加 zod schema，路径改由主进程签发的一次性令牌引用（`ipc/dialog-path-token.ts`，TTL 10 分钟/容量 20/peek 不消费以便密码重试），返回值只带 `restoreToken + fileName`，不再回传绝对路径 | 已修复 |
| SEC-7 | 凭据暴露 | `db/repositories/provider.repo.ts:29` + `ipc/handlers/providers.ts:10` + `preload/index.ts:117` | `rowToRecord` 解密后 `apiKeys` 明文随 `PROVIDER_LIST` 返回渲染层并经 preload 暴露。与项目自身约定冲突（`tools/websearch-config.ts:23` 只回 `hasKey`、`channels/channel-config.ts` 同） | 已修复 |
| SEC-8 | 备份 | `backup/backup-service.ts:158-215` | `createZipBuffer` 每次把整份 `app.db` 复制到 `os.tmpdir()/pocketai-backup-<ts>`，成功与异常分支都只调 `restoreJournalMode()`，全函数无删除（全仓 `rmSync` 仅用于 restore 临时目录）。便携场景等于把整库留在宿主机 `%TEMP%`，直接违背「随身不落宿主机」定位。修复：`tmp` 提到 try 外，`finally` 里 `rmSync(recursive,force)`，清理失败留 warn（不毁掉已完成的备份） | 已修复 |
| SEC-9 | shell 边界 | `tools/shell-tools.ts:122-154,409-413` | confirm 特征规则是关键词表，`python -c`、`certutil -urlcache`、`mshta`、`powershell -c`、`curl -o 后独立执行` 均不命中 → 返回 `allow` 直跑。在 `auto-safe` 策略下等于无审批执行；外部内容驱动路径存在（IM 渠道 agentMode、`web_fetch`、工具结果原文进上下文且无不可信标记，见 SEC-12） | 待修复 |

### C. Medium

| # | 模块 | 文件:行 | 现象 | 状态 |
|---|------|---------|------|------|
| SEC-10 | 锁定/限流 | `lock/ipc-gate.ts:20` + `ipc/handlers/lock.ts:18-36` + `shared/schemas/encryption.ts:8` | `LOCK_UNLOCK` 列入网关白名单且 handler 未接 `authRateLimiter`（对比 `ipc/handlers/encryption.ts:47-58` 有 5 次阈值 + 指数退避），db 模式锁屏界面可无限离线试密码。**修复**：`LOCK_UNLOCK` 的 db 模式重开探针接入 `authRateLimiter(AUTH_BUCKET.UNLOCK)`（与 `ENCRYPTION_UNLOCK` 同桶，同一口令只有一套计数器），空密码与验密失败都计入 fail，成功 reset；返回体与加密解锁同构（`locked/retryAfterMs/attempts`）。口令下限 6 位另立 SEC-32 | 已修复 |
| SEC-11 | MCP 密钥 | `db/repositories/mcp-server.repo.ts:138-164` + `backup/credential-rotation.ts:25-30` + `shared/mcp-export.ts:13,52-58` | MCP `env`/`headers`（可含 `Authorization: Bearer`）明文入库、未纳入凭据轮换快照；导出脱敏只按**键名**匹配，`X-Auth`/`AWS_ACCESS_KEY_ID`/`GH_PAT`/`KEY_1` 明文导出，而导出正是共享场景。修复：整列字段级加密 + 出 IPC 掩码 + 纳入轮换 + 导出值侧识别 | 已修复 |
| SEC-12 | 注入防护 | `tools/registry.ts:58-76` + `agent/engine.ts:1380-1395` + `tools/memory-save.ts:23` + `assistant/memory.ts:26` | 外部内容进 LLM 上下文无任何不可信标记/定界：MCP 工具描述原文进 `## 可用工具`，工具结果仅加 `[工具结果]` 前缀；`memory_save` 为 `auto`，可把一次性注入固化成永久 system 回注并要求「保持一致」，形成 注入 → `fs_read` 取密钥 → `memory_save` 固化 → `js_eval` 外发 的链路 | 待修复 |
| SEC-13 | 审批粒度 | `agent/tool-approval.ts:43-46,65` | 会话级「总是允许」只按 `conversationId + toolName` 比较：放行一条 `rm ./build` 后，同会话任意 `shell_exec`（含 `curl\|sh`）直接执行；跨 MCP server 的同名工具共享白名单。修复：键改为 `toolName + 规范化参数指纹`（递归排序 key 后 sha256；改参数顺序/空白不影响复用），MCP 维度由 SEC-4 的唯一别名天然带上 | 已修复 |
| SEC-14 | 日志 | `portable.ts:52` + `logger.ts:79-108` | 日志目录在便携盘 `data/logs`，`inspect(depth:4)` 全量序列化任意对象，无字段级 redact；现存 `data/logs/main.log` 有把模型回复全文写盘的历史 DEBUG 行。**修复**：新增 `security/log-redact.ts`（纯函数），`formatArgs` 序列化前先按敏感键名整值替换为 `[redacted]`（authorization/api[_-]?key/token/secret/password/credential/cookie/private_key/access_key/session_id 等），并对所有字符串按 2000 字符封顶（含嵌套值与 Error stack），循环引用与超深结构有兜底。**残留**：已存在的历史 `main.log` 内容不会被本次改动清除，发行说明里提示用户可自行删除 | 已修复 |
| SEC-15 | 路径/临时文件 | `files/files-service.ts:37-47`（对比 `tools/fs-tools.ts:53-79`）、`export/drag-temp.ts:24-30,70-72` | `DATA_DIR` 文件面只做 resolve + 前缀校验，缺 `assertWithinWorkspaceByRealpath` 同款符号链接防护；导出拖拽临时文件名 `base-${Date.now()}-${Math.random()}` 可预测、`writeFileSync` 无 `O_EXCL`、`isDragTempPath` 不解析符号链接 | 待修复 |
| SEC-16 | Provider 网络 | `providers/types.ts:74-76` + `shared/schemas/providers.ts:4-5` | baseUrl 缺协议时补 `http://`（明文携带 Bearer Key 与全部上下文）；schema 明确允许内网地址。缓解面已核实：`providers/openai-compatible.ts` 全链路 `redirect:'manual'` + 拒 3xx，Key 不随跳转外泄 | 待决策 |
| SEC-17 | 沙箱 | `security/csp.ts:36-43` + `sandbox/js-eval-runner.ts:43` | js_eval 窗口加载的是 `data:` 文档，而 CSP 仅经 `onHeadersReceived` 注入（`data:` 无响应头路径）→ 工具描述宣称的「无网络」缺少执行层保障，沙箱内 `new Image().src=…` 可作无审批外发通道。**按代码推断，未实测**（实测受 automode 拦截，仅完成 `file://` 场景） | 待修复 |
| SEC-18 | 知识检索 | `db/repositories/kb-chunk.repo.ts:226` + `db/repositories/kb-vec.repo.ts:155` | BM25 路 `split(/\s+/)` 使中文长句成为单个 token，FTS5 trigram 下短语要求连续原文 → 中文问句基本不命中（`tests/rag.test.ts` 未覆盖此路）；vec0 路 `1/(1+欧氏距离)` 与 JS 路余弦相似度混用同一 `score` 语义，被 `mmr.ts` 的 `normalizeScores` 直接读取 | 待修复 |
| SEC-19 | Agent 上下文 | `agent/engine.ts:642-655` | 历史 31~35 条时信息静默丢失：窗口裁剪阈值 `MAX_CONTEXT_MESSAGES=30` 与摘要阈值 `SUMMARIZE_THRESHOLD=35` 不一致，这 5 条既不进窗口也不进摘要 | 待修复 |
| SEC-20 | 供应链 | `shared/schemas/mcp.ts:124-138` + `mcp/python-env.ts:328-332,560-569` | pip 源可指任意 http(s) 且无 `--require-hashes`，换源 = 任意 wheel 落进 MCP 正在使用的 venv（缓解：requirements 白名单拒 `-` 开头/URL/git/@、`serverDir` 双校验、便携 Python 钉 sha256） | 待修复 |

### D. Low（登记备查）

| # | 模块 | 文件:行 | 现象 | 状态 |
|---|------|---------|------|------|
| SEC-21 | 硬件检测 | `steward/hardware.ts:253,324,352,359` | `execSync` 拼接 `APP_ROOT`/设备名，安装路径含引号时可注入（其余 spawn 全部数组参数、无 shell） | 待修复 |
| SEC-22 | 锁网关覆盖 | `ipc/handlers/conversations.ts:270` | 全仓唯一 `ipcMain.on`，不在 `installLockGate`（只包 `ipcMain.handle`）覆盖范围，锁屏期仍可拖出既有临时文件 | 待修复 |
| SEC-23 | 渠道网关 | `channels/dingtalk-gateway.ts:148-149` | 直接连服务端下发的 `ServerUrl?token=`，未校验 wss/域名 | 待修复 |
| SEC-24 | 备份兼容 | `backup/backup-service.ts:256-263` | 解密方向保留固定密钥回退 → 历史 `.enc.zip` 对持源码者等同明文 | 待修复 |
| SEC-25 | 文件权限 | `db/repositories/app-config.repo.ts:64,93` | `mode:0o600` 在 Windows/exFAT U 盘无效（注释亦承认仅新建生效），config.json 的 salt + 恢复包与 DB 同权限 | 待决策 |
| SEC-26 | License | `license/server-config.ts:6`、`database.ts:198-204` | `ACTIVATION_BASE_URL='http://127.0.0.1:8787'` 开发残留（本地仍验签，不能伪造）；`api_key_cipher`、`field_keys` 为未使用死列/死表，易误导后续审计 | 待修复 |
| SEC-27 | 渲染层 | `settings/SettingsModule.tsx:2296` + `update-manager.ts:312` | release notes `href={r.url}` 直接用远端 `html_url`，无协议白名单（依赖 CSP 兜底，SEC-1 批次落地后应改走 `openExternalSecure`） | 待修复 |
| SEC-28 | ICS/终端 | `tools/calendar-ics.ts:99-105`、`terminal/terminal-service.ts:79-82` | ICS 无行/长度上限，续行拼接可放大内存；手动终端只按「输入行」判黑，可先写文件再执行绕过——设计上非安全边界，但宣传语不得称沙箱 | 待决策 |
| SEC-29 | Agent 一致性 | `agent/engine.ts:1489 vs 1561`、`tools/registry.ts:36,40`、`chat/chat-service.ts` vs `agent/engine.ts:574` | 降级提示用 `ctx.maxSteps`（重规划后已 15）、错误文案用 `MAX_STEPS`（10），两处数值不一致；`registry` 每次调用重建 `listAll()`（遍历 MCP runtimes）；`sources` 只落首轮检索命中，多步中 `kb_search` 命中不进引用溯源 | 待修复 |
| SEC-30 | 跨机合并 | `backup/merge-service.ts:91`（`mcp_servers`/`providers` 归「配置类表：云端覆盖本地」） | SEC-Batch-1 让 `providers.api_key_encrypted` 与 `mcp_servers.env/headers` 都成为字段密文后，跨机「保留云端」合并会把用源机主密钥加密的列整行拷进目标库 → 目标机解不开，凭据表现为丢失（providers 此前已如此，MCP 是本次新增面）。修法：合并时对这两列做「明文导出→本地密钥重加密」，或合并后强制提示重填密钥 | 待决策 |
| SEC-31 | 隐私锁语义 | `ipc/handlers/lock.ts:20-24` + `lock/lock.ts`（全文无口令） | `none` 模式下 `LOCK_UNLOCK` 直接忽略 `password` 参数放行——隐私锁服务本身不持有任何凭据，锁屏只是一层界面遮挡。数据在 none 模式本就明文，故不构成机密性突破，但 UI 文案不得暗示「锁定=受保护」（`App.tsx:158` 也是 `dbEncrypted ? lockPwd : undefined` 的传法） | 待决策 |
| SEC-32 | 口令策略 | `shared/schemas/encryption.ts:8` | 主密码下限 6 位，配合 scrypt N=32768（OWASP 下限档）与「离线拿到 app.db」的威胁模型，弱口令可被暴力派生验证。修法：新设口令时提高下限或加强度提示；改已有口令的校验下限需兼容存量（不能锁死老用户） | 待决策 |

---

## 三、结论纠正（子审计复核 + 自身修复计划的假设证伪）

1. **「生产环境 CSP 实际零生效（`file://` 不适用 `onHeadersReceived`）」— 误报。** 实测：`onHeadersReceived` 对 `file:///…/page.html` **有回调**，注入的 `script-src 'self'` **确实拦住内联脚本**（渲染端输出 `Executing inline script violates the following Content Security Policy`，内联脚本未执行）。故 `csp.ts` 的纵深防御在主窗口/浮窗/detached/unlock（均 `loadFile`）上生效，不必修 `<meta>`（可作双保险，但不是洞）。SEC-17 据此收窄到 `data:` 文档这一条路径。标记：`误报`。
2. 路径纠正：secret-store 实际在 `src/main/crypto/secret-store.ts`，不在 `src/main/db/repositories/`。
3. 事实纠正：不存在「`Math.random` 用于密钥」（仅临时文件名，见 SEC-15）；scrypt 参数为 N=32768/r=8/p=1（约 32MiB，代码注释写 64MB 有误）。

SEC-Batch-2 动手前对**本台账自己写的修复计划**做了一轮证伪，三条被推翻/改写：

4. **SEC-4「未授权的工具被执行」— 部分证伪。** `classify`/`execute` 按 name 找到 schema 后还有 `allowedToolIds.has(schema.id)` 二次校验（`registry.ts:143,188`），所以「只勾 MCP 那条 id」的结果是 `deny TOOL_NOT_ALLOWED` 而非越权执行。真实缺陷改述为：`*` 授权下的**行为静默替换**、跨 Server 同名的**恒路由到第一个**、`tools` 数组**同名重复项**。结论（改名 + `remoteName`）不变，理由换了。
5. **Step D「导入即落地执行」— 部分证伪。** 全仓无 MCP 开机自启（`index.ts` 不调 `mcpManager`），import 只写库；Agent 侧 `listMcp()` 只收 `status==='running'` 的运行时（`registry.ts:27-31`）。故执行闸门是「点启动」，修复不需要导入期拦截。
6. **Step E「导入清空 `toolPermissions` 即收回权限」— 证伪。** `engine.ts` 原有无条件 `[] → ['*']` 让清空等于保持全授权（且 9 个内置助手里 7 个本来就是 `[]`）。已按选定口径改为：空数组=无工具，仅「未选助手」与「内置助手」保留旧语义；该规则抽成纯函数 `resolveAgentToolPermissions` 并补单测。
7. 附带修正一处自我规格：MCP 启动命令预览最初实现为「trim 每个参数」，实测会让 `python -c "rm -rf /"` 展平成看不出参数边界的 `-c rm -rf /`——安全确认场景里保真优先，改为含空白参数加引号呈现。
8. **SEC-6 的「恢复无确认」表述不准**（Batch-3 复核）：渲染层正常路径本就弹 `bk.localRestoreConfirm` 危险确认，缺陷实质是**确认只存在于渲染层**、主进程对路径来源无权威。修复方向不变（把权威移进主进程的令牌机制），但严重度描述按此改写。另：`z.tuple([obj.optional()])` 对「无参数调用」实测可过（`[]` 与 `[undefined]` 均 success），因此给可选入参的 handler 加 schema 不会打断首次调用。

---

## 四、已验证有效的防护（后续审计可省力的基线）

- **IPC 面**：`safeHandle` 注册 286 处，其中 197 处（69%）带 zod 入参 schema；无裸 `ipcMain.handle`（仅 `safe-handle.ts:47` 一处内部使用）。preload 三个桥（index/popup/unlock）均为具名白名单，无任意 channel 透传。
- **SSRF**：`net/safe-fetch.ts` 手动逐跳重定向 + 每跳 DNS 校验 + 连接钉 IP，`file:`/协议白名单每跳复核，覆盖 CGNAT / IPv4-mapped / NAT64 / 6to4 / `::1` / 十进制 IP；`tests/safe-fetch.test.ts` 有回归。出网口清单已逐项核对（provider、mcp http-transport `redirect:'error'`、channels 固定平台域名、ollama 127.0.0.1、webdav node-fetch 跨源剥离 authorization）；唯一无重定向策略的是 `license/activation-client.ts:56`。
- **窗口配置**：7 处 `new BrowserWindow` 全部 `sandbox:true + contextIsolation:true + nodeIntegration:false`；无 `webSecurity:false`、无 `allowRunningInsecureContent`、无 `<webview>`；`--no-sandbox` 仅 `!app.isPackaged`。
- **渲染层内容管线**：react-markdown 未挂 `rehype-raw`；mermaid `securityLevel:'strict'`；链接/图片双协议白名单（`Markdown.tsx:30-43,168-182`，有 `tests/markdown-render.test.ts` 回归）；`images/data-url.ts:16` 排除 SVG + 12MB 界；无 `eval`/`new Function`/`innerHTML`；工具结果与技能正文均以文本节点渲染；`external-links.ts:50-84` 的 `denyNewWindows` 覆盖四窗口并处理 `file://` 不透明源；Chromium 权限默认全拒且在开窗前安装。
- **历史修复真实有效（非仅注释）**：假加密备份（`encryptBackup` 无 dbKey 直接抛、WebDAV 判据用 `getDbKey()`）；Zip Slip + 符号链接双检（`backup-service.ts:625-637,700-740`、`merge-service.ts:256-259`，`tests/backup-service.test.ts:50-81` 覆盖 `../`/绝对路径/盘符/反斜杠）；锁 db 即清钥关库 + IPC 网关 fail-closed 且 `installLockGate()` 先于 `registerIpcHandlers()`；license RSA-2048-SHA256 规范化签名含 `disk_fingerprint`，私钥不入 git 不入包；`tools/builtin.ts` 数学表达式白名单 + vm 空 realm（记录了原 `new Function` RCE 的修复）；便携 Python 钉 SHA256 + `timingSafeEqual`、tar 条目与符号链接双重 `resolveUnder`；MCP 侧有界读（stdio 32MB 行、SSE/JSON 有界）、`tools/list` 名称/schema 尺寸上限、结果 256KB + 100 项双封顶。

---

## 五、修复批次规划

| 批次 | 覆盖条目 | 内容 | 前置决策 |
|------|----------|------|----------|
| SEC-Batch-1 凭据面 | SEC-7 / SEC-11 已落地；SEC-1 / SEC-24 待决策 | **已落地**：`PROVIDER_LIST`/`MCP_SERVER_LIST`/`GET`/`SAVE`/`START`/`RESTART`/`GET_RUNTIMES` 一律掩码出 IPC（新增 `src/shared/secret-mask.ts` 纯函数 + 按需 `PROVIDER_REVEAL_KEYS`/`MCP_SERVER_REVEAL_SECRETS`）；MCP `env/headers` 整列字段级加密（含历史明文启动期升级）并纳入轮换快照；导出加值侧形态识别与脱敏清单。**待定**：`none` 模式改用安装期 `randomBytes(32)` 本机 data-key（存 `%APPDATA%` 或 DPAPI 包裹），或禁 `none` 模式保存凭据；备份解密侧固定密钥回退 | none 模式密钥体系如何过渡（旧库无感/一次性重加密/强制重设）；跨机合并（SEC-30） |
| SEC-Batch-2 Agent 审批面 | SEC-2 / SEC-3 / SEC-4 / SEC-5 / SEC-13 | **已落地**（2026-10-08 SEC-Batch-2） | 无 |
| SEC-Batch-3 数据面 | SEC-6 / SEC-8 / SEC-10 / SEC-14 | **已落地**（2026-10-08 SEC-Batch-3） | 无 |
| SEC-Batch-4 边界与注入 | SEC-9 / SEC-12 / SEC-15 / SEC-17 / SEC-20 | shell 改 allow-list 模型（解释器 `-c/-e/-enc` 一律 confirm）；外部内容统一包裹 + system 禁令；files-service 补 realpath 校验、临时文件 `wx` + 0600；js_eval 窗口用 webRequest 直接 deny 网络（不依赖 CSP）；pip 强制 https + 变更二次确认 | SEC-16/SEC-25/SEC-28 的取舍 |
| SEC-Batch-5 查漏 | SEC-18 / SEC-19 / SEC-21~23 / SEC-26 / SEC-27 / SEC-29 | 中文检索分词或 n-gram 展开 + 两路 score 语义统一；摘要/窗口阈值对齐；`execSync` 改数组参数；`ipcMain.on` 入网关；dingtalk wss 白名单；死列与开发残留清理；release 链接走 `openExternalSecure`；降级步数文案统一 + `kb_search` 命中进 sources | 无 |

---

## 六、变更记录

| 日期 | 批次 | 内容 | 验证 |
|------|------|------|------|
| 2026-10-08 | SEC-Audit-1 | 全项目只读安全审计建档：2 项 Critical、7 项 High、11 项 Medium、9 项 Low 登记（SEC-1~SEC-29），每条含文件:行证据链、威胁模型解释与修复方向；4 路子审计结论逐条复核，剔除 1 条被实测证伪的「生产 CSP 零生效」误报并修正 2 处路径/事实错误；补记已验证防护基线（IPC 286/197 schema 覆盖、safeFetch 逐跳 SSRF、7 窗口 webPreferences 全量、渲染层无 raw HTML）与 5 个修复批次规划 | 未改动任何生产代码；CSP 结论经 Electron 44 `loadFile` 内联脚本拦截实测确认（探针目录已删除） |
| 2026-10-08 | SEC-Batch-1a | 凭据掩码收口（SEC-7 / SEC-11 落地，SEC-1 按决策暂不动）：① 新增 `src/shared/secret-mask.ts`（`maskSecret`/`isMaskedSecret`/`maskSecretList`/`maskSecretMap`/`restoreMaskedList`/`restoreMaskedMap`，出 IPC 为 `••••`+末 4 位，保存时占位按下标/key 回填原值，删除与新增语义不变）。② Provider：`PROVIDER_LIST`/`PROVIDER_SAVE` 返回掩码，新增 `PROVIDER_REVEAL_KEYS` 单条按需揭示；`providerRepo.save` 先回填再加密（`FirstRunWizard` 追加 Key 因下标对齐无需改）。③ MCP：`mcp_servers.env/headers` 整列 `encryptSecretMap` 落库（`decryptSecretMap` 兼容历史明文与损坏值 fail-closed），`list/get/save/start/restart/get-runtimes` 全掩码 + 新增 `MCP_SERVER_REVEAL_SECRETS`；启动阶段 3 加 `mcpServerRepo.migratePlaintextSecrets()`（只重写非密文列，绝不回写解密失败的行）；`credential-rotation` 快照增 `mcp` 一路，主密码四类切换点自动覆盖。④ 导出：`mcp-export` 加 `looksLikeSecret`（厂商 token 形态 / `Bearer` / 高熵串）做值侧兜底，`redactedEntries` 输出 `服务>键` 清单并写入 `x-pocketai-redacted-keys` 扩展键（统计量不再混进导出文件）。⑤ 渲染层：ProviderSettings 与 McpForm 加「显示密钥」入口与掩码提示，中英日韩四语补齐。审计过程中发现并登记 SEC-30（跨机合并会把源机密文拷进目标库） | typecheck 0 / vitest 187 文件 2548 用例全绿（新增 `tests/secret-mask.test.ts` 14 用例、`field-encrypt` 映射加解密 6 用例、`mcp-export` 值侧 1 用例、`credential-rotation` 改为三路断言）/ electron-vite build 三端成功 |
| 2026-10-08 | SEC-Batch-2 | Agent 审批面（SEC-2/3/4/5/13）。动手前先证伪自己的修复计划，结论见第三节 4-7 条。① **SEC-4 名字唯一化**：新增 `ensureUniqueToolNames`/`sanitizeFunctionName`（`tools/registry.ts`），给「与内置重名 / 跨 Server 重名 / 非法 LLM 函数名」的 MCP 工具加 server 作用域别名 `m_<serverId 前 8 位十六进制>_<清洗名>`，原名存进新字段 `ToolSchema.remoteName`（`shared/types.ts`），`execute` 用 `remoteName ?? name` 调 Server；**`id` 保持 `mcp:<serverId>:<原名>` 不变**，故既有助手授权与导入导出都不受影响。② **SEC-5**：`classifyMcpToolPermission(name, trustReadOnly=false)` 默认一律 `confirm`，名称语义分级只在用户显式勾选「信任只读命名工具」后生效；新增 migration v44 `mcp_servers.trust_read_only`（旧库/缺列按 0=不信任）、`McpServerRecord.trustReadOnly`、McpForm 勾选框 + 四语提示。③ **SEC-13**：`tool-approval.ts` 白名单键由 `toolName` 改为 `toolAllowKey = toolName::参数指纹`，指纹 `toolArgsFingerprint` 对参数 JSON 递归排序后 sha256 取 16 位（空/非法参数归一，非法 JSON 用原文保底）；engine 传入 `tc.function.arguments`；四语 `alwaysAllowHint` 文案改为「相同工具 + 相同参数」。④ **SEC-2**：新增 `renderer/.../mcp/mcp-launch.ts`（`formatMcpLaunch` 含空白参数加引号保边界、`mcpSecretKeyHint` 只列键名），导入预览逐条展示将执行的命令行与凭据键名，McpPanel 点启动前用 `useConfirm` 摊开同一份文案（同源，避免预览与确认不一致）。⑤ **SEC-3**：`resolveAssistantImportItem` 一律清空 `toolPermissions` 并回传 `droppedTools`；engine 的授权语义抽成纯函数 `resolveAgentToolPermissions`——空数组=无工具，仅「未选助手」与「内置助手」保留旧的空=全授权；`ASSISTANT_IMPORT` 改两段式同名覆盖确认（主进程暂存对话框路径、TTL 5 分钟、用后即弃，不接受渲染端任意路径），ChatModule 承接 `needsConfirm` 二次调用并提示被清空授权数 | typecheck 0 / vitest 189 文件 2581 用例全绿（新增 `tests/tool-name-collision.test.ts` 12 例含复刻旧构造的对照组、`tests/mcp-launch.test.ts` 8 例、`agent-context` 授权语义 4 例、`assistant-port` 授权清空 2 例、`tool-approval-session` 参数粒度 4 例；`classify-mcp-permission`/`agent-security`/`mcp-manager` 断言按新默认改写）/ electron-vite build 三端成功 / **行为变化需知**：MCP 工具默认每次调用弹确认（可按 Server 关闭）、导入的助手与未显式授权的自建助手在 Agent 模式下不再有隐式全工具 |
| 2026-10-08 | SEC-Batch-3 | 数据面（SEC-6 / SEC-8 / SEC-10 / SEC-14）。动手前复核自身结论，校正了 SEC-6 的「无确认」表述（见第三节第 8 条）。① **SEC-6 令牌化**：新增 `ipc/dialog-path-token.ts`（签发/peek/drop，TTL 10 分钟、上限 20、peek 不消费以便密码连续重试），`BACKUP_LOCAL_RESTORE` 入参改 `backupRestoreArgsSchema`（`restoreToken`+`backupPassword`），路径只在主进程解析，返回值不再含绝对路径（新增 `restoreToken`/`fileName` 两字段，`BackupRestoreResult.filePath` 移除）；`ASSISTANT_IMPORT` 的自写暂存逻辑收敛到同一模块（第二段改带 `confirmToken`，令牌失效不再回落成「重新弹框静默覆盖」）。② **SEC-8**：`createZipBuffer` 的 `tmp` 提到 try 外 + `finally` `rmSync(recursive,force)`，清理失败 `log.warn` 留痕。③ **SEC-10**：`LOCK_UNLOCK` 的 db 模式探针接入 `authRateLimiter(AUTH_BUCKET.UNLOCK)`（与加密解锁同桶），空密码也计 fail，返回体补 `locked/retryAfterMs/attempts`；`none` 模式忽略口令这一事实单独登记为 SEC-31，口令下限登记为 SEC-32。④ **SEC-14**：新增 `security/log-redact.ts` 纯函数（敏感键名整值 `[redacted]`、字符串 2000 字符封顶、Error/Date/Buffer/Map 原样、循环与超深兜底），`logger.formatArgs` 落盘前统一走它；历史 `main.log` 已有内容不在本次清除范围，已在 SEC-14 标注残留 | typecheck 0 / vitest 191 文件 2602 用例全绿（新增 `tests/dialog-path-token.test.ts` 9 例、`tests/log-redact.test.ts` 12 例；两条断言按实现语义自我修正：敏感键名是整值替换、深度上限差一层）/ electron-vite build 三端成功 / **未实测**：真实应用内的本地恢复密码重试链路、锁屏连续错密码的退避提示 |
