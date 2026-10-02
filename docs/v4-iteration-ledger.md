# 墨匣 Moxia / PocketAI — V4 迭代与 Bug 修复台账

> 起始：2026-09-29。V3 台账（docs/v3-iteration-ledger.md）已收尾：方向 1–5 落地、6 移动伴侣暂缓。
> 状态标记：`已修复` / `待决策` / `进行中` / `已规划` / `已落地`

---

## 一、V4 迭代目标

1. 数据可视化：把散落的本地数据变成用户可感知的价值（用量、成本、健康度）。
2. 便携场景体验：USB 冷启动、小白可见性。
3. 既定范围查漏：产品策划书 v1/v2 范围已全部消化（2026-09-29 复核），V4 起新命题驱动。

---

## 二、迭代任务

### V4-Iter-1 用量统计仪表盘（已落地）

- **范围**：token 用量统计（不含费用估算——价格配置用户决策暂缓，留作后续批次）。
- **方案**：
  - migration v21：`messages` 表加 `usage` 列（JSON：promptTokens/completionTokens/totalTokens/cachedTokens），仅 assistant 消息记录。
  - chat-service `runTarget` done 时把 provider 已解析的 `result.usage` 随 updateContent 落库（当前被丢弃）；Agent 最终消息按该轮累计写入，统一从 messages 聚合。
  - 新增 `src/main/usage/usage-service.ts`：按日 / provider / 模型 GROUP BY 聚合 + 汇总。
  - IPC USAGE_GET + preload 暴露；SettingsModule 加「用量」section：汇总卡片 + 14 天纯 CSS 柱状图 + provider/模型排行。
  - i18n 中英日韩四语对齐（parity 测试已扩四语）。
- **决策记录**：UI 落点 = Settings section（非独立模块）；价格配置 = 暂不做。

### V4-Iter-2 启动性能优化（已落地，2026-09-29 重启完成）

- **范围**：USB 冷启动痛点——先埋点测启动各阶段耗时，再时序优化。
- **方案**：① 主窗口创建时序重排——createMainWindow 从阶段 5（全部同步 DB 杂务之后）提前到解锁完成/配置读取后立即执行：IPC handlers 早已在 boot 开头注册（惰性闭包）、渲染层数据全部经 IPC 拉取，窗口 loadFile 异步加载渲染 bundle 与凭据迁移/provider 去重/助手技能同步/popup/Channels/License 等杂务并行，开窗时间从「杂务之和 + 渲染加载」降为「max(杂务, 渲染加载)」；initUpdateManager 保持窗口后（webContents.send 依赖）。② 启动埋点——BOOT_T0 + bootMark() 七个阶段打点（目录初始化/DB 打开+迁移/解锁完成/主窗口创建/凭据迁移/助手技能同步/浮窗 Channels License/调度器），[perf] 前缀写 boot 标签日志，已接数据健康面板可视化（2026-09-29 启动耗时区块落地）。渲染 bundle 拆包另立 V4-Iter-12 落地（主包 -31%）。

### V4-Iter-12 渲染 bundle 拆包（已落地）

- **范围**：首屏临界链主包瘦身。产物分析：mermaid 全家桶已是动态 import 按需 chunk、模块级 React.lazy 已落地（Workspace 10 模块）；主包 1515KB min 真实大头 = rehype-katex 静态引入 katex 全量 + i18n 四语全量常驻（313KB 源码）。
- **方案**：① Markdown.tsx katex 两段式懒加载——ensureKatex() 动态 import 插件+CSS（Promise 单例），挂载触发，ready 前公式显示原始 LaTeX、ready 后一次性重渲染；② i18n/index.tsx 按需加载——仅 zh 常驻（默认+兜底），en/ja/ko 动态 import + Promise 缓存，未就绪 t() 回退 zh。
- **效果**：主包 1515KB → 1052KB（-31%）；katex 484KB（css+字体按需）、en 73KB/ja 92KB/ko 81KB 独立按需 chunk。

### V4-Iter-13 图片 OCR 入知识库（已落地）

- **范围**：截图/扫描件（png/jpg/webp/gif）入库时用视觉模型识别图中文字再走常规索引，补齐「图片资料进不了检索链路」的小白痛点。
- **方案**：migration v29 knowledge_bases 加 ocr_provider_id/ocr_model（空=关闭，同构 MultiQuery 配置模式）；新增 `src/main/knowledge/ocr.ts`（OCR_SYSTEM_PROMPT 提取文字/表格转 Markdown/不编造；imageMime 纯函数；单图 10MB 上限；ocrImageFile 读文件→base64 data URL→adapter.streamChat 多模态单轮）；KbSourceType 加 'image'，parsers detectSourceType 收图片扩展（parseDocument case 'image' 抛错防御防二进制乱码）；ingestion parseForIngest 分流（未配 OCR 抛小白可读引导错误；PDF 空文本报错细化为「可能是扫描版，请转图片」）；文件对话框 filters + folder-scan 白名单加图片，scanFolderFiles 加 includeImages 参数（KB 未配 OCR 时文件夹导入自动跳过图片防批量报错）；KbForm 新增「OCR 文字识别」配置区块（复制 MultiQuery 模式）+ kb.ocr* 四语 key。
- **决策记录**：扫描版 PDF 不做（页面转图片需 canvas 原生依赖，便携打包风险大），引导转图片导入；本地 OCR（tesseract）不做（中文质量差+体积大），只走视觉模型 API 零打包体积。

### V4-Iter-54 编辑重发校准 + 消息批量收藏 + 会话分组文件夹（已落地）

- **范围**：用户点名三个候选一起做。调研校准结论：① 用户消息「编辑重发」**早已完整存在**（MessageBubble textarea 编辑态 + handleResend 分支链路 + i18n，零开发仅回归）；② 会话内消息多选框架与批量删除/复制也已存在（selectedIds/全选/操作条/气泡 checkbox），仅缺批量收藏；③ 会话分组文件夹为全新特性，是本批主体。
- **方案（A 批量收藏）**：ChatView 操作条复制/删除之间加星标按钮——选中消息含任一未收藏显示「收藏选中」、全已收藏显示「取消收藏选中」；新 prop onBatchToggleStar，ChatModule `Promise.all(setMessageStarred)` 后单次 setMessages map（单条失败静默跳过仅同步成功项）；i18n +2 key。
- **方案（B 分组文件夹）**：
  - migration v37：新表 `conversation_groups(id PK, assistant_id, name, created_at)` + conversations 加列 `group_id`（NULL=未分组）；无 FK。
  - 新 repo conversation-group.repo.ts：list（助手口径 asst-default→=值OR IS NULL，created_at ASC）/create（UUID+trim 1-40，assistantId 缺省 null）/rename/delete（事务先 UPDATE conversations SET group_id=NULL 再删组，只解散不删内容）/setConversationGroup（null=移出）；纯函数 buildGroupListWhere 导出供单测；conversation.repo rowToRecord +groupId（list SELECT c.* 天然带出）。
  - IPC 5 个 safeHandle（GROUP_LIST/CREATE/RENAME/DELETE/SET_GROUP，zod name trim 1-40）+ preload 5 桥接；types ConversationGroupRecord/groupId。
  - ChatModule：groups state 并入 reloadConversations 的 Promise.all 第三请求（助手切换/初始自动重拉）；create/rename/delete/move 四回调（move 乐观本地 patch 活跃+归档两列表，失败 reload 回滚）；delete 本地同步解绑。
  - ConversationList：分区仅普通浏览态生效（搜索/收藏/多选/标题过滤平铺）；collapsedGroups 折叠集合（默认全展开，含当前会话的组自动展开）；组按组内最近会话 updatedAt DESC 排（零 sort_order），组内 pinned DESC/updatedAt DESC；空组隐藏不删；未分组标题带为拖出放置目标（有组时才占位）；组头 📁/📂+数量+▶/▼+hover ✏️重命名/🗑解散（confirm 明示会话不删）；原生 HTML5 DnD（同 Sidebar 模式，MIME application/x-pocketai-conv，仅活跃区普通态可拖，归档不拖）；ConvItem ⋯ 菜单扁平追加各文件夹项（当前组 ✓）+移出项兜底无拖拽习惯；工具行 📁＋ 内联输入建组（Enter/Esc/blur）。
- **决策记录**：组带 assistant_id 同会话口径，跨助手移动不暴露；不做 sort_order——组顺序跟随最近使用更直觉且零维护；归档区不参与分组（归档=离场）；拖拽与菜单双通道保证可达性；编辑重发不重写（台账明确记录已存在防重复立项）。
- **明确不做**：文件夹嵌套/颜色图标/拖拽排序/手动排序；归档区分组、跨助手移动、文件夹导出；消息批量转发/批量引用；Agent 面板/浮窗批量收藏；编辑重发任何改动。

### V4-Iter-53 空会话自动清理（已落地）

- **范围**：点「新对话」立即在数据库建行，不发消息就切走/切助手会堆积标题为「新对话」/助手名的 0 消息空壳，永久占列表且无任何清理逻辑。本批从「不产生」与「静默回收」两端收口：空会话上再点新对话直接复用、切走时守卫删除、启动全局清扫历史遗留。
- **方案**：
  - 数据层（无 migration）：conversationRepo 新增 `deleteIfEmpty(id)`——`DELETE ... WHERE id=? AND title_default=1 AND pinned=0 AND NOT EXISTS(messages) AND NOT EXISTS(conversation_drafts)` 四重守卫，changes>0 返回布尔，守卫保证无子行走普通 DELETE 不需事务级联；`cleanupEmptyConversations()` 同款全局 SQL（不带 id，活跃/归档区都清），返回删除条数。
  - IPC：`CONVERSATION_DELETE_IF_EMPTY`（idSchema，删除命中才 clearSessionAllow，返 {deleted:boolean}）/ `CONVERSATION_CLEANUP_EMPTY`（无参，返 {deleted:number}）；preload `deleteConversationIfEmpty`/`cleanupEmptyConversations`。
  - ChatModule 三触发（全静默，零 i18n key 零 toast）：① 新对话复用——handleNewConv 开头判断当前会话「自动标题+未置顶+0 消息」（挂草稿的也复用，草稿随会话保留，建行反制造挂草稿空壳）则只重置引用态直接 return，不建行；② 切走清理——`discardCurrentIfEmpty()` useCallback([]) 读 ref 镜像（messagesRef/convIndexRef 每渲染同步、draftTextRef 为 Iter-52 同步镜像），命中守卫则 fire-and-forget 调 deleteIfEmpty，deleted 后本地过滤两列表，挂在 handleSelectConv/handleSelectMessage/handleSelectAssistant 三入口；③ 启动清扫——初始 listAssistants 后先 cleanupEmptyConversations（catch 报错不阻断）finally 再 reloadConversations(true)，清历史版本与崩溃前 600ms 窗口空壳。
- **决策记录**：草稿判定用渲染端 draftTextRef 同步值而非查库——避开 Iter-52 草稿 600ms 防抖未落库窗口（SQL NOT EXISTS drafts 作第二重保险）；手动重命名（title_default=0）/置顶（pinned=1）即免疫全部清理路径（用户有意保留的空白板）；归档空行启动时一并物理删除（四重守卫保证零用户内容）；有消息但被手动删光的重命名会话保留（title_default=0 守卫）；无「关闭会话」概念、无确认弹窗、无定时清扫。
- **明确不做**：不做关闭确认弹窗/清理结果通知；不做定时清扫；不做 Agent/浮窗特殊处理（同库全局清扫天然覆盖）；不动 handleSend 首次发消息建行路径（彼时无「前一个会话」可清）。

### V4-Iter-52 输入草稿持久化（已落地）

- **范围**：输入框写到一半切会话/重启，文本现状只在 Composer 内存里——同次运行切走再切回文本侥幸残留，重启必丢。本批按会话持久化未发送文本：输入 600ms 防抖落库，切会话先同步提交旧会话再回填目标会话草稿，发送后立即清除，会话列表 📝 标记提示有未发送内容。
- **方案**：
  - 数据层：migration v36 新增独立表 `conversation_drafts(conversation_id TEXT PRIMARY KEY, draft TEXT NOT NULL, updated_at INTEGER NOT NULL)`——独立表而非 conversations 加列，列表只经 EXISTS 子查询带布尔，不把草稿全文拉进列表行；无外键（与 messages 等同口径），delete 事务内手动级联删草稿；fork 不复制草稿。
  - conversationRepo：`getDraft(id)`（无行返回 ''）、`setDraft(id,text)`（空串 DELETE；非空 INSERT ... ON CONFLICT(conversation_id) DO UPDATE 的 UPSERT，Date.now() 时间戳）；ConversationRow+`has_draft?`、rowToRecord+`hasDraft:!!has_draft`；list() SQL 在 last_preview 子查询后加 `EXISTS(SELECT 1 FROM conversation_drafts d WHERE d.conversation_id=c.id) AS has_draft`。
  - IPC：`CONVERSATION_DRAFT_GET`（idSchema）/`CONVERSATION_DRAFT_SET`（idSchema + z.string().max(100_000)，空串=清除）；preload `getConversationDraft`/`setConversationDraft`；types +`hasDraft?:boolean` 两 IPC 常量。
  - Composer：Props 加 draftKey/draft/onDraftChange/onDraftCommit；内部 text 加 `textRef` 镜像 + `prevKeyRef`；effect[draftKey,draft]——key 变化先 onDraftCommit 旧会话最新文本再回填 draft，draft 异步到达时再次回填；所有写文本路径（onChange / insertAtCursor 片段插入 / submit 清空）统一收口到 `updateText`（setText+textRef+onDraftChange）。
  - ChatModule：activeDraft state + draftTimerRef（600ms 防抖）+ draftTextRef 镜像；handleSelectConv/handleSelectMessage/handleNewConv 同步 setActiveDraft('') 防旧草稿一帧闪现；currentConvId effect 统一加载（cancelled 守卫防快速连切竞态，失败兜底 ''）；handleDraftChange（非空防抖/空串立即删）、commitDraft（切会话立即落库）；落库成功后本地 patch conversations/archivedConversations 的 hasDraft（不等 reload 零延迟出 📝）；beforeunload/pagehide 不 await 尽力 flush 最后 600ms 窗口内击键；ChatView 纯透传 4 props。
  - ConversationList ConvItem 标题行 pinned 📍 同处加 📝（10px，title=draftHint，仅非多选态）；i18n 四语 +1 key chat.draftHint。
- **决策记录**：草稿只存文本——附件 dataURL 可能数 MB 不入库、replyTo 仅 id 不随草稿恢复；防抖 600ms（停止打字后落库，平衡 IPC 频率与丢失窗口）；切会话走同步提交而非等防抖（Composer 不重挂载无 key，必须在回填新文本前抢救 textRef）；独立表 EXISTS 方案避免列表查询带出全文；beforeunload 用 invoke 不 await 的尽力策略（崩溃窗口仅剩防抖间隔 600ms）。
- **明确不做**：附件持久化、replyTo 恢复、草稿列表/搜索、Agent/浮窗草稿、多设备同步。

### V4-Iter-51 消息收藏星标（已落地）

- **范围**：重要消息散落在各会话里找不回。本批加消息收藏：hover 消息点 ☆ 标记 → ⭐ 常显，侧边栏工具行 ⭐ 入口打开收藏列表（跨会话、时间倒序、上限 200），点击跳转回原消息，行内可取消收藏。
- **方案**：
  - 数据层：migration v35 `message_starred`——messages 加 `starred INTEGER NOT NULL DEFAULT 0` + `idx_messages_starred(starred, created_at DESC)`；`MessageRecord.starred?: boolean`；新增 `StarredMessageItem` 精简列表项（id/conversationId/conversationTitle/role/content/createdAt）。
  - messageRepo：`setStarred(id, starred)`（UPDATE 1/0）；`listStarred(limit=200)`——LEFT JOIN conversations 带标题（会话删除兜底空串），`WHERE starred=1 ORDER BY created_at DESC, rowid DESC`（同毫秒口径与 Iter-49 预览一致）。
  - IPC：`MESSAGE_SET_STARRED`（idSchema+z.boolean()）/ `MESSAGE_LIST_STARRED`（limit 1-500 可选）；preload `setMessageStarred`/`listStarredMessages`。
  - MessageBubble：操作按钮区容器显隐条件 `hovered || selected || starred`，其余按钮仍 hover 显现，星标按钮独立常显（⭐ accent / ☆ muted），位置固定行尾防抖位。
  - ChatModule `handleToggleStar`：IPC 落库 + `setMessages` 本地 map 更新（不 reload 零闪烁），同函数透传 ConversationList（收藏列表内取消收藏复用）。
  - ConversationList：`starredMode` 与搜索/过滤/多选互斥（进入时清其余 state）；工具行加 ⭐ 按钮（accent 高亮 aria-pressed）；StarredResults 组件（角色标签 + 会话标题 + relTime + 内容 line-clamp-2，行尾 hover ☆ 取消收藏），点击复用 `onSelectMessage` → focusMessageId 滚动高亮链路。
  - i18n 四语 +4 key（chat.star/unstar/starredList/starredEmpty）。
- **决策记录**：收藏列表上限 200 硬编码（与 MESSAGE_SEARCH 分页量级一致，不加分页）；取消收藏只从列表移除不 toast（行消失即反馈）；listStarred 不走 FTS（无搜索需求）；starred 消息选中态与 hover 态共享操作区容器（不新增常驻行高）。
- **明确不做**：不做收藏分组/标签、收藏消息导出、Agent/浮窗星标、收藏数角标、导出格式带星标。

### V4-Iter-50 助手维度用量明细弹窗（已落地）

- **范围**：V4-Iter-45 决策记录留尾「助手明细可后续扩展」——用量面板助手排行只能看聚合，点开看不到逐轮明细。本批在助手排行加「明细」按钮，弹窗展示该助手最近 N 天每一轮 assistant 生成的 token 明细（含所属会话列）。
- **方案**：
  - 数据层：`listUsageDetail` 加第 5 参 `assistantId?: string | null`（undefined=不过滤、null=自由会话 IS NULL、字符串=按助手过滤）；过滤拼装抽纯函数 `buildUsageDetailScope(conversationId?, assistantId?)` 导出直测，返回带前导空格的 SQL 片段 + 有序参数值。
  - IPC：`USAGE_DETAIL_GET` handler argsSchema 加第 4 参 `z.string().max(64).nullable().optional()`；preload `getUsageDetail` 透传。
  - UsagePanel：弹窗 state 泛化 `detailConv` → `detail: { title, showConv }`（会话/助手两维度共用弹窗）；`openAsstDetail(assistantId|null, name)` 调 `getUsageDetail(days, EXPORT_LIMIT, undefined, assistantId)`；助手排行表头加「明细」列 + 行尾眼睛按钮（stopPropagation 不触发行跳转）；聚合 key 为 `'(未知助手)'` 的行传 null（对应 assistant_id 为 NULL 的自由会话）。
  - 弹窗助手维度多一列「会话」（明细行已有 conversationTitle 字段），tfoot 合计行 colSpan 随 showConv 切换。
  - i18n 零新 key（全部复用 Iter-45 的 usage.detail* 与 usage.conversation）；usage-service.test +6 用例（buildUsageDetailScope 全组合 + 参数顺序）。
- **决策记录**：`assistantId=null` 用 `IS NULL` 而非参数绑定（NULL 不参与 = 比较）；空串按不过滤处理（falsy 与 undefined 同口径，防 UI 误传）；助手已删除的行 assistant_id 非空仍可查明细（过滤走 conversations 列不依赖 assistants JOIN）；明细按时间倒序与会话明细同口径。
- **明确不做**：不做明细行点击跳回会话（Iter-45 已否）；不做明细内搜索/排序；不做 provider/模型维度明细弹窗（排行已够用）。

### V4-Iter-49 会话列表消息预览（已落地）

- **范围**：会话列表只显示标题，想快速辨识内容必须点进去。本批在会话行标题下方加一行最新消息截断预览（常驻显示，非 hover），主列表与归档区同享。
- **方案**：
  - 数据层：`conversation.repo.ts` 的 `list()` SQL 改 `SELECT c.*, (SELECT substr(replace(replace(m.content, char(13),' '), char(10),' '), 1, 80) FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_preview FROM conversations c...`——单条 SQL 关联子查询带预览，避免逐会话 N+1；换行符折叠为空格防预览行内换行；活跃/归档列表同一 `list()` 自动继承。
  - 类型：`ConversationRecord` 加 `lastMessagePreview?: string | null`（仅 list 查询带出）；`ConversationRow` 加 `last_preview?: string | null`；`rowToRecord` 映射 `?? null`（get/create 等非 list 路径缺列安全回退）。
  - 渲染层：`ConversationList.tsx` ConvItem 标题区改 `flex-col`（标题行 + 预览行）；预览行 `text-[11px] leading-4 text-[var(--color-text-muted)] truncate`；仅非多选态且预览非空渲染，避免行高跳动；过滤态（Iter-47 filteredConversations）与归档区共用行组件自动生效。
  - 测试：conversation-repo.test +1 用例（缺列 → null；list 带出 → 透传）。
- **决策记录**：预览内容即消息原文不新增 i18n key；截断 80 字符在 SQL 层做（substr）而非前端截断，减少 IPC 载荷；`ORDER BY created_at DESC, rowid DESC` 与 fork 同毫秒消息排序口径一致；预览不随流式实时刷新（下次 reloadConversations 自然更新，避免流式期间列表高频重渲染）。
- **明确不做**：不做 hover 才显示（常驻更符合「快速辨识」目标）；不做多行预览（line-clamp-2 行高翻倍，列表密度损失大）；不做流式中预览实时更新；不预览 tool/system 角色标签（预览只取内容，角色区分留给详情页）。

### V4-Iter-48 消息引用回复（已落地）

- **范围**：长对话中想追溯某条消息的上下文，只能滚动翻找。本批加消息引用回复：hover 消息点「引用」→ Composer 显示引用条 → 发送后该 user 消息顶部带被引用消息预览条，点击跳转回原消息。
- **方案**：
  - 数据层：migration v34 给 messages 表加 `reply_to_id TEXT`；`MessageRecord` 加 `replyToId?: string | null`；`MessageRow`/`rowToRecord`/`insert` 同步映射；`SendMessagePayload` 加 `replyToId?`；chat-service 持久化 user 消息时写入 `replyToId`。
  - 渲染层：ChatModule 加 `replyToMessage` state + `handleSetReply`；ChatView 建 `msgById` Map，`handleReply(id)` 查找完整消息交父级；`onJumpToReply` 复用 `virtualizer.scrollToIndex('center')` + `highlightMsgId` 2s 高亮（与搜索跳转同口径）。
  - MessageBubble：Props 加 `replyTo`/`onJumpToReply`/`onReply`；气泡内容上方加引用条（角色标签+内容截断，点击跳转）；操作按钮区 CopyButton 后加「引用」按钮（user/assistant 均可用）。
  - Composer：Props 加 `replyTo`/`onCancelReply`；textarea 上方加引用条（角色+内容预览+关闭按钮）；submit 时传 `replyToId` 并清空引用状态。
  - i18n 四语 +5 key（chat.reply/you/assistant/replyEmpty/jumpToReply）；message-repo 测试 +1 用例（replyToId 映射）。
- **决策记录**：replyToId 只存 user 消息（assistant 回复不引用，避免链路过长）；被引用消息删除后引用条显示「（空消息）」，不报错；引用跳转复用现有高亮机制不新造动画；不把引用内容拼进 prompt（只做 UI 上下文提示，不影响模型输入，避免 token 膨胀和语义偏差）。
- **明确不做**：不做嵌套引用（A 引用 B，B 引用 C 只显示一层）；不做引用内容随消息编辑同步更新（引用的是发送时的快照 id，内容取当前最新）；不做跨会话引用。

### V4-Iter-47 会话列表标题过滤（已落地）

- **范围**：会话多了翻列表找会话慢，现有搜索框是消息全文搜索（跨会话 IPC），不能快速按标题定位会话。本批在消息搜索框下加「过滤会话」输入框，纯前端按标题过滤。
- **方案**：
  - ConversationList 加 `convFilter` state；`filteredConversations = conversations.filter(title 不区分大小写 includes)`，空关键词不过滤。
  - 消息搜索框下方加过滤输入框（仅 `!isSearching && !selectMode` 时显示，避免与消息搜索/多选模式视觉冲突），带清空按钮。
  - 会话列表 `conversations.map` → `filteredConversations.map`；空态区分「无会话」与「无匹配会话」。
  - i18n 四语 +2 key（chat.filterConversations / chat.noFilteredConversations）。
- **决策记录**：纯前端 filter 零 IPC（conversations 已在内存，列表通常百量级）；与消息搜索框视觉区分（上下排列，placeholder 文案不同）；不做最近搜索记录/高亮匹配（过度设计）。
- **明确不做**：不做按消息内容过滤会话（消息搜索已有）；不做拼音/模糊匹配；不做过滤后全选（多选模式与过滤互斥）。

### V4-Iter-46 历史会话批量删除（已落地）

- **范围**：会话只能逐个删，Iter-23 批量导出已建多选模式但删除没复用。本批在多选操作条加「批量删除」按钮，一键删选中的多个会话。
- **方案**：
  - 新增 `IPC.CONVERSATION_BATCH_DELETE`：handler 接收 ids 数组（z.array(idSchema).max(500)），逐个 `conversationRepo.delete` + `clearSessionAllow`，单条 try/catch 不中断，返回 `{ ok, deleted }`。
  - preload `deleteConversations(ids)`。
  - ConversationList：props 加 `onBatchDelete?: (ids: string[]) => void`；多选操作条在导出按钮后加红色「批量删除」按钮（disabled=无选中/deleting，删除中显示 common.deleting）；`handleDeleteSelected` 先 `window.confirm` 二次确认（chat.batchDeleteConfirm），再 await onBatchDelete。
  - ChatModule：`handleBatchDeleteConv` 调 IPC → 若当前会话在被删列表则清空 → reloadConversations → toast 成功（chat.batchDeleteDone，含实际删除数）。
  - i18n 四语 +4 key（chat.batchDelete/batchDeleteConfirm/batchDeleteDone + common.deleting）。
- **决策记录**：复用既有多选模式不重造 UI；批量走独立 IPC 而非前端循环调单条（一次往返，单条失败不连累其余）；二次确认用 window.confirm（与项目其他危险操作一致，不引 useConfirm 依赖）；上限 500 防爆。
- **明确不做**：不做归档会话批量删除（归档区不参与多选，与导出一致）；不做删除进度条（500 以内毫秒级）；不做删除撤销（FK 级联后无法回滚）。

### V4-Iter-45 消息级用量明细弹窗（已落地）

- **范围**：V4-Iter-25 决策记录留尾「不做消息级用量弹窗」——用量面板会话排行只能看聚合（请求数/token/费用），点开看不到逐轮明细，深度对账无出口。本批在会话排行行加「明细」按钮，弹窗展示该会话最近 N 天每一轮 assistant 生成的 token 明细。
- **方案**：
  - 复用 Iter-41 的 `listUsageDetail`，加第四参 `conversationId?`：非空时 SQL 追加 `AND m.conversation_id = ?`（参数化防注入，空值退化为 CSV 导出全量行为，零破坏性）；IPC handler argsSchema 加第三参 `z.string().max(64).optional()`；preload `getUsageDetail(days?, limit?, conversationId?)`。
  - UsagePanel：会话排行表头加「明细」列，行尾眼睛图标按钮（stopPropagation 不触发行跳转），点击 `openDetail(id, title)` 调 `getUsageDetail(days, EXPORT_LIMIT, id)`。
  - 弹窗：标题（会话名 + 最近 N 天）+ 表格（时间/模型/输入/输出/缓存/total/费用）+ tfoot 合计行（reduce 汇总各列）；点遮罩/关闭按钮关闭；loading/空态。
  - i18n 四语 +10 key（usage.detail/viewDetail/detailSubtitle/detailEmpty/detailTime/detailModel/detailIn/detailOut/detailCached/detailTotal）；common.loading/close 复用。
- **决策记录**：复用现有 IPC 不新增通道（conversationId 可选参数向后兼容，CSV 导出传 undefined 行为不变）；明细按时间倒序（最近在前），与排行口径一致；费用沿用 pricing 配置，未配单价的模型 cost=0 显示「—」；不加导出按钮（CSV 导出已是全量，单会话明细可从全量 CSV 过滤）。
- **明确不做**：不做单条消息跳转回会话；不做明细内搜索/排序；不做助手维度明细弹窗（结构同构但 Iter-25 留尾只提消息级，助手明细可后续扩展）。

### V4-Iter-44 会话内消息搜索（已落地）

- **范围**：长会话找不回某条消息——全局搜索（MESSAGE_SEARCH）只能跨会话列结果，不能在当前会话内定位。本批在 ChatView 内加搜索条，输入关键词匹配消息并滚动定位+高亮。
- **方案**：
  - 纯前端实现，messages 已在内存，零新 IPC。
  - 导出纯函数 `findMatchIds(messages, keyword)`：trim 后小写匹配 content，按消息顺序返回命中 id 列表；空关键词/无命中返回 []。
  - ChatView 状态：searchOpen / searchKeyword / curMatchIdx / searchInputRef；matchIds 用 useMemo；关键词变化重置 curMatchIdx=0。
  - `gotoMatch(dir)`：循环取命中 id，findIndex 定位所在 turn，`virtualizer.scrollToIndex(idx, 'center')` + 复用既有 `highlightMsgId` 机制高亮 2s（与全局搜索跳转同口径）。
  - UI：模型选择栏右端加搜索图标按钮；展开搜索条（输入框 + 计数 i/n + 上/下按钮 + 关闭），无命中时计数 0/0 且上下按钮禁用。
  - 快捷键：Ctrl/Cmd+F 打开并聚焦；打开后 Enter 下一个 / Shift+Enter 上一个 / Esc 关闭；Ctrl+F preventDefault 避免浏览器原生查找。
  - i18n 四语 +4 key（chatview.searchInConversation/searchPlaceholder/searchPrev/searchNext）。
  - 测试：新建 tests/chat-search.test.ts 6 用例（空关键词/不区分大小写/多命中顺序/无命中/trim/空 content 跳过）。
- **决策记录**：复用虚拟列表 scrollToIndex + highlightMsgId，不重造定位机制；纯函数抽出来便于单测，UI 交互不补测试（与 Iter-43 纯 UI 接线同口径）；搜索只匹配 content 不匹配附件/来源（覆盖日常找话需求，避免误命中噪声）。
- **明确不做**：不做正则/全词匹配选项；不做替换；不跨会话搜索（全局搜索已有）；不搜附件内容。

### V4-Iter-43 子窗口划词浮条挂接（已落地）

- **范围**：V4-Iter-37 决策记录留尾——应用内划词浮条（SelectionToolbar）只挂在主窗口 App.tsx，DetachedApp 独立窗口（标签弹出的单模块全屏窗，无侧边栏/TabBar）选中文本无浮条。本批补齐，独立窗内选中文本也出翻译/总结/改写动作条，与主窗口行为一致。
- **方案**：DetachedApp.tsx 单文件改动——import SelectionToolbar，在 contentRef 容器内 Workspace 之后、`!locked` 条件下渲染（与 App.tsx 同口径：锁屏时不挂载；锁屏遮罩 z-9999 高于浮条 z-9000，即便同时存在也被遮挡）。SelectionToolbar 自包含（useI18n + window.pocketai.getPopupConfig/openSelectionPopup），DetachedApp 已在 I18nProvider 内、有 ToastProvider、有 locked 状态，零新依赖、零新 IPC、零 i18n key。
- **决策记录**：浮条放 contentRef 内而非 ToastProvider 直接子级——与 App.tsx 结构对齐，且 locked 时 contentRef 设 inert 兜底（虽然 !locked 已不渲染，双保险）；独立窗与主窗共享同一浮窗进程单例，openSelectionPopup 唤起主浮窗无需改动。
- **明确不做**：不改 SelectionToolbar 定位/行为逻辑；不为独立窗做独立的浮窗进程（复用主浮窗单例）。

### V4-Iter-42 WebDAV 定时备份轮转清理（已落地）

- **范围**：策划书 6.1 必做「手动/定时备份到 WebDAV」的收尾缺口——定时备份链路（10 分钟 tick/间隔可配/静默执行/状态展示）完整，但 runScheduledBackup 只上传不清理，每天一个全量 zip（加密包含 DB+附件），WebDAV 空间无限增长，只能到云列表逐个手删。本批加「保留最近 N 份全量包」自动轮转。
- **方案**：
  - backup-scheduler：新键 backup.retention_count（默认 0=不清理，老用户升级零行为变化，自动删除必须显式开启，上限 100）；BackupScheduleStatus/BackupRunResult（shared 与 scheduler 两份定义）同步加 retentionCount/pruned；setBackupSchedule 收 retentionCount（clamp 0-100），zod patch 同步。
  - 纯函数 selectPrunableBackups(files, keep, justUploaded)：keep≤0→[]；只处理 kind='full'（incremental 索引引用 blobs/ 内容寻址对象，按份数盲删会断增量恢复链）；mtime 倒序取最新 keep 份（含本次新包），其余待删；justUploaded 再兜底过滤——WebDAV 时钟漂移导致新包 mtime 异常落入待删区也绝不删（宁可少删）；删除列表 reverse 成最旧优先，中途失败留下的也是较新包。
  - runScheduledBackup 成功后 pruneOldBackups：列清单→决策→逐个 deleteWebDAVBackup（每个独立 try/catch，失败 warn 继续），pruned 计成功数写入 last_result；列举/清理整段 try/catch，轮转任何失败不改变备份成功结论。手动上传 handler 不接轮转（手动场景用户对云文件有掌控）。
  - 设置页定时备份区加「保留份数」select（不自动清理/3/5/10/20/30），>0 时显示 hint（仅全量轮转、增量不受影响），上次成功文案 pruned>0 追加清理份数；i18n 四语 +4 key。
  - 测试：扩 backup-scheduler.test（mock +listWebDAVBackups/deleteWebDAVBackup/deleted/deleteFailOnce）——纯函数 6 用例（关闭/不足份数/超份最旧优先/乱序/增量不参与/时钟漂移救回新包）、轮转集成 4 用例（retention=2 删最旧 2 增量不动/默认 0 零列举零删除/单删失败继续且 pruned 只计成功/列举失败不连累备份）、retention 配置解析与钳制 1 用例；既有成功路径断言随 pruned:0 更新。
- **决策记录**：默认关闭轮转（自动删除是不可逆动作，升级零行为变化）；按份数不按天数（与「每天一个包」直觉一致且不依赖 WebDAV 时钟）；保留集先含新包、justUploaded 只作安全网（计划初版先排除新包导致其不占名额多删一份，测试推演时修正）；删除最旧优先保证中断安全。
- **明确不做**：不轮转增量包与其 blob；手动上传/备份后不触发清理；不加「立即清理」批量按钮（云列表已有逐条删除）；不顺手改诊断/数据健康面板的备份描述句。

### V4-Iter-41 用量数据 CSV 导出（已落地）

- **范围**：Iter-24 起用量体系（聚合/排行/单价/气泡微展示/会话累计）多次被提「可导出算账」未做。用量面板只能看聚合不能带走，月度复盘/报销/自定义透视无出口。本批在用量面板范围行加「导出 CSV」，导出**行级明细**（每轮 assistant 生成一行）而非聚合视图——聚合 UI 已可见，明细丢进表格才能自由透视。
- **方案**：
  - shared/types：+UsageDetailItem（createdAt/conversationId·title/assistantId·name 可空/provider/model/prompt·completion·cached·totalTokens/cost）、UsageDetailResult{items,truncated}；IPC +USAGE_DETAIL_GET/USAGE_EXPORT_CSV。
  - usage-service：+UsageDetailRow 与纯函数 aggregateUsageDetail（同口径坏 JSON 跳过、未配价 cost=0、roundCost、保持入参倒序、标题空/会话 id 空兜底「(未知会话)」、assistant 名 trim 后 null）；+listUsageDetail(days,limit=10000) SQL messages JOIN conversations LEFT JOIN assistants（同助手排行口径），内查 limit+1 判 truncated、clamp days 1-365/limit 1-20000。
  - handlers/messages：USAGE_DETAIL_GET 薄封装带价；USAGE_EXPORT_CSV 照搬 STEWARD_EXPORT_REPORT 模式（渲染端拼文本含 BOM，主进程 showSaveDialog+writeFileSync，defaultPath pocketai-usage-{days}d-{timestamp}.csv，filters csv，content zod 上限 500 万字符，返回 ok/canceled/path）。
  - preload +getUsageDetail/exportUsageCsv（PocketAPI=typeof api 自动同步）。
  - 新建 renderer/utils/usage-csv.ts：csvCell RFC4180 转义（逗号/引号/CRLF 双引号包裹、内部 " 翻倍）、formatLocalTime 本地 YYYY-MM-DD HH:mm:ss、buildUsageCsv（10 列固定序：时间/会话/助手/服务商/模型/输入/输出/缓存/总/花费，\uFEFF 开头 + CRLF 行尾，assistantName null → 空串）。
  - UsagePanel：chips 行右侧 ml-auto 导出按钮（无数据/导出中 disabled+title），handleExportCsv busy 防重→查明细→i18n 表头注入构建 CSV→落盘；成功 toast 条数，truncated 追加 warning 提示缩小范围，取消静默、失败 common.opFailed。
  - i18n 四语 +6 key：exportCsv/exportCsvDone{count}/exportCsvTruncated{limit}/colTime/colProvider/colCached；列头其余复用 usage.conversation/assistant/model/prompt/completion/totalTokens/cost。
- **决策记录**：导行级明细而不导面板聚合（多区块塞单 CSV 难用，明细透视表可还原一切聚合）；CSV+BOM 而非 XLSX（零表格库依赖，Excel/Numbers 直开中文不乱码）；截断在 service 内用 limit+1 判定而非 COUNT 二查；主进程不碰任何文案与表头，与诊断报告导出职责划分一致。
- **明确不做**：不做 XLSX/多 sheet；不做列选择/导出模板/自定义时间区间（7/30/90 chips 已联动）；不导消息正文（隐私敏感、体积大，仅统计字段）。

### V4-Iter-40 管家推荐模型一键拉取（已落地）

- **范围**：策划书 6.1 平台管家含「模型推荐下载」。OLLAMA_PULL 流式拉取链路（主进程单例+进度广播+中止）与设置页 OllamaPanel 拉取 UI 早已完整，但管家推荐卡片只显示 installed ✓ 标记，未装模型无动作——「检测→推荐→下载」闭环断在最后一跳，用户得去设置页手输模型名。本批在推荐卡片直接加拉取按钮+实时进度+中止。
- **方案**：
  - 新建 hooks/useOllamaPull.ts：从 OllamaPanel 收口 pulling/pullEvt state、onOllamaPullEvent 挂载订阅（卸载 off 不中断后台拉取）、空名/忙碌守卫、IPC !ok 与 reject 双兜底复位、abort；onDone/onError 回调走 ref（订阅只挂一次）；同文件导出纯函数 pickPullState（installed→pulling→busy-other→disabled→pullable 五态优先级，installed 最高防事件残留误显进度）。
  - OllamaPanel 重构接线：删自有 state/订阅/pull 函数改用 hook（onDone markPullDone+refresh，pull 错误独立 pullError 行与安装错误 err 分行），doPull 包一层 clearPullDone；UI/文案零变化，OllamaPullEvent 类型 import 随之下线。
  - StewardModule：refreshRecommendation 抽 useCallback 与 load 共用；hook onDone 重拉推荐（installedModels 来自实时端口探测，不本地乐观更新）+toast 成功、onError toast 失败；localPicks 卡片按 pickPullState 渲染——pulling 内嵌 1.5px 进度条（ollama 原始 status+百分比+中断按钮），busy-other/disabled 禁用（disabled title 引导去设置启动），pullable 显示「⬇️ 拉取」；installed 仅保留顶部绿标不出按钮；向量模型同等待遇。
  - i18n：四语仅新增 steward.pullNeedRunning 1 key（韩文字串内引号改用「」避免与 JS 单引号冲突，typecheck 当场抓住），其余复用 ollama.pullBtn/abort/pulling/pullDone。
  - 测试：新建 tests/ollama-pull-state.test.ts 6 用例（installed 优先/自身 pulling/忙别的/disabled/忙碌优先于未运行/pullable）；hook 编排不做 renderHook（仓库无该设施），状态组合全走纯函数。
- **决策记录**：抽 hook 而非管家页复制订阅逻辑（两处共用行为一致，OllamaPanel 纯接线重构 UI 零变化）；ollama 未运行只禁用+引导，不在管家页做启动/安装/镜像（无 runtime status 链路，启动心智归 OllamaPanel，避免半套实现）；拉取成功重拉 recommendModels 刷新 installed；主进程拉取全局单例，其他卡片 busy-other 禁用。
- **明确不做**：不做拉取完成自动注册 provider 模型（models 列表拉取是另一链路，与 OllamaPanel 现行为一致）；不做管家页 Ollama 安装/启动/镜像配置；不改推荐算法与卡片排序；不做并发多模型拉取（主进程单例限制）。

### V4-Iter-39 管家诊断报告导出（已落地）

- **范围**：策划书 6.4「诊断报告可导出为文本，便于远程求助」此前缺导出入口——管家页六块数据（硬件画像/DB 完整性/数据健康/模型推荐/安全体检/故障诊断）只能看不能带走。本批在管家页顶部加「📄 导出报告」，一键补跑体检/诊断并保存为带时间戳的 .txt。
- **方案**：
  - 新建 renderer/utils/diagnostic-report.ts：buildDiagnosticReport(data, labels) 纯函数 + ReportLabels 字典注入（复用 formatBytes）；固定五段结构 ①系统硬件（CPU/内存 GB/GPU 含显存 CUDA MPS 驱动/磁盘盘符类型总线容量可移动）②模型推荐（档位/summary/Ollama 态/已装列表/localPicks tag+id+installed+reason/在线建议/警告）③数据健康（完整性+会话消息知识库计数+附件+孤儿）④安全体检（/100 分+逐项 ✅⚠️❌ label-detail+建议行）⑤故障诊断（同构+修复行，空诊断显示整体正常）；缺失段不省略，audit/diagnose 未跑标 notRun、硬件/推荐 null 标 notAvailable；时间手动 pad 成本地 YYYY-MM-DD HH:mm:ss 不依赖 locale。
  - main：IPC STEWARD_EXPORT_REPORT，steward.ts safeHandle + zod（content 1..200000），仿 snippets export 走 dialog.showSaveDialog（默认名 pocketai-report-YYYYMMDD-HHmm.txt，文本文件/所有文件过滤），取消→canceled、写盘→path；preload +exportStewardReport。
  - UI：StewardModule 顶部 recheck 旁加按钮（flex gap 包裹）；handleExport 先 Promise.all 补跑 runAudit/runDiagnose（结果同时 setState 刷新页面，失败 catch 容忍沿用已有 state）+getUpdateInfo 取 currentVersion，再拼报告调 IPC；成功 toast.success、失败/!ok toast.error（useToast）；硬件/health 用挂载快照不 force 重采（避免导出触发慢硬件采集）。
  - i18n：四语新增 21 key（导出按钮/态/成败 toast/报告头与段名/建议·修复/已装模型·在线建议·注意事项/评分/三态词），字段级标签全部复用既有 steward.* key；段名单独建 reportSec* 而非剥离 emoji（避免跨语言正则脆弱）。
  - 脱敏核实：grep 确认 runAudit/runDiagnose 只检查 apiKeys 存在性（p.apiKeys.filter(Boolean).length），不输出 Key 明文，报告零敏感凭证。
  - 测试：新建 tests/diagnostic-report.test.ts 11 用例（全量数据头部时间版本/五段各字段/GB 精确一位小数/段顺序固定；全 null 不抛错+notRun/notAvailable/版本占位；空诊断显整体正常；完整性异常出 details；无 GPU+USB 可移动）。
- **决策记录**：纯函数放渲染端（六块数据全在 state，零 IPC 往返，main 只落盘，与既有分工一致）；导出时自动补跑 audit/diagnose（求助场景必须最新，省掉用户先手动跑两个按钮；硬件采集慢不强制重采）；纯文本 .txt 而非 PDF/JSON（远程求助粘贴最通用）；ReportLabels 注入而非纯函数 import i18n（可测+语言跟随 UI）；不剥离 emoji 而新建无 emoji 段名 key。
- **明确不做**：不做 PDF/HTML 报告；不做日志文件打包附加（属日志功能域）；不做段落勾选自定义；不做定时导出；不在报告中含会话内容/知识库正文等业务数据。

### V4-Iter-38 浮窗回答一键复制（已落地）

- **范围**：Iter-37 划词浮条打通了「选中→翻译/总结/润色」入口，但结果出来后要拿走只能手动框选浮窗文本再 Ctrl+C——选区助手最高频工作流（翻译/润色→粘走）的最后一跳缺失。本批给浮窗每条 assistant 回复加 hover 复制按钮。
- **方案**：PopupApp.tsx 单文件改动——新增 AssistantBubble 子组件（relative group 包裹 Markdown + 绝对定位圆形小按钮 -top-2 -right-2，hover 气泡/键盘聚焦显现，复制成功态常显 1.5s 并切换对勾图标，SVG 与 Markdown 代码块复制按钮同口径）；复用 useCopyFeedback（统一 1500ms 反馈态+writeClipboard 含 execCommand 降级，适配浮窗 file:// 透明窗口场景）；消息 map 中 assistant 非错误且有内容走新组件，错误气泡/流式占位/user 消息保持原样；复制内容=模型原文（与代码块复制 raw 口径一致，摘要带列表符号可接受）；i18n 零新 key（common.copy/common.copied 四语早已存在）；纯 UI 改动无新纯逻辑不新增测试。
- **决策记录**：不主动关窗——浮窗本就是 blur 自隐的 Spotlight 形态，用户复制后切到目标窗口粘贴时窗口自然隐藏，按钮只管复制+反馈，避免连续操作（再问一轮/多动作）被打断；按钮放气泡右上角而非底部动作行（浮窗 440px 纵向空间金贵，hover 显现零常态占用）；错误消息不给复制（错误排查走主窗口设置页，浮窗错误仅提示重试）。
- **明确不做**：不做「复制为纯文本」（剥离 Markdown 符号）双模式（翻译/润色输出几乎无 markdown，双按钮增加选择负担）；不做复制后自动关闭选项；不动主窗口 MessageBubble（其操作行复制/编辑/重跑/删除已完整）；不做历史回复批量复制。

### V4-Iter-37 应用内划词浮条（选区助手补齐，已落地）

- **范围**：策划书 6.1 v1 必做「选区助手：划词浮条（翻译/总结/改写）」此前只完成了一半——全局快捷键版（Ctrl+Shift+U 任意应用模拟复制取词→浮窗，Ctrl+Shift+U），但应用内划词没有就地入口。本批在主窗口选中正文后于选区旁浮出动作条，点击直接唤起既有浮窗单例并自动执行动作。
- **方案**：
  - 链路复用不造第二套：浮条只做入口 → 新 IPC POPUP_OPEN_SELECTION（zod text 1..8000 + action enum，trim/截断/锁屏拒绝复用 openPopup）→ PopupPayload 加 `action?: SelectionAction` → PopupApp 就绪后自动执行；浮窗的流式/模型选择/多轮/Markdown 全继承。
  - shared：新增 SelectionAction 联合类型；openPopup(mode, text?, action?) 第三参写 payload（quick 模式强制无 action）；主 preload +openSelectionPopup。
  - 新建 utils/selection-actions.ts：SELECTION_ACTIONS 单一顺序源；composeSelectionPrompt 从 PopupApp 抽出 4 条中文提示词（PopupApp 删内联改引用，动作芯片 map 也改用常量）；normalizeSelectionText（trim/空白 null/8000 截断）；isEditableSelectionHost 复用 shortcuts.isEditableTarget 鸭子判定并沿 parentElement 链上溯 64 层（contenteditable 子节点场景），不重复造 editable 判定。
  - 新建 components/SelectionToolbar.tsx + App 挂载（!locked 才挂）：document mouseup(左键)/keyup(Shift) 后延迟一帧读 selection；fixed 浮条 useLayoutEffect 按实测尺寸定位（选区上方居中，空间不足翻下，水平夹取视口）；按钮 onMouseDown preventDefault 防清选区；隐藏=mousedown 浮条外(capture)/selectionchange 空/Esc/scroll capture 即藏/blur；开关读 getPopupConfig().selectionEnabled，window focus 刷新；按钮文案直接复用 popup.act.* 四语（含 emoji）。
  - PopupApp：pendingActionRef 按 payload.ts 标记，effect 在 mode=selection+assistant/provider/model 就绪+非流式时自动跑一次后清空；快捷键取词入口不带 action 保持「芯片等用户点」旧行为。
  - i18n 不新增 key：popup.selectionHint 四语文案补充「应用内选中正文即浮出工具条」。
  - 测试：新建 tests/selection-actions.test.ts 14 用例（动作顺序/宿主判定 null+四类输入元素+祖先链/normalize 空空白 trim 超长恰界/4 动作提示词特征）；主进程 popup handler 沿用仓库零 popup 测试惯例不新增。
- **决策记录**：浮条只唤起浮窗不做就地内联回答（避免重复实现流式链路，回答也不打断阅读上下文）；带 action 自动执行（浮条按钮已表意图，进浮窗再点芯片是冗余；两入口语义不同故快捷键链路不自动）；与全局快捷键共用 selectionEnabled 一个开关不新增设置项（用户心智同一个「选区助手」）；scroll 即藏而非跟随重定位（零错位闪烁，重划成本低）；提示词不抽到 shared（仅渲染端两处使用，主进程不消费）。
- **明确不做**：不做复制/搜索等浏览器原生动作；不做就地回答/就地替换原文；不覆盖 detached 子窗口（独立窗口/preload，后续可同构挂接）；不做浮条自定义开关与自定义动作提示词；Linux 全局取词仍不支持（既有现状，与本批无关）。

### V4-Iter-36 会话累计用量条（已落地）

- **范围**：Iter-35 解决了「每轮气泡看单行 token/费用」，但用户仍需自己心算「这个会话总共花了多少」。本批在会话消息流顶部加累计用量条：本会话全部 assistant 消息 token 汇总 + 按各自模型单价求和的估算费用，hover 看输入/输出/缓存明细，零新 IPC（messages/pricing 均已在渲染端）。
- **方案**：新建 `src/renderer/src/utils/usage-summary.ts`——sumMessagesUsage(messages, pricing) 纯函数（只计 role=assistant 且带 usage 的 done 消息；逐条 priceKey(provider,model) 查价 computeUsageCost 后 roundCost 汇总；输出 prompt/completion/cached/total/cost/counted）；ChatView useMemo 派生 summary（deps messages/pricing），消息流容器顶部虚拟列表外渲染 11px muted 胶囊（右对齐，随消息流滚走不占固定布局），totalTokens>0 才显示，费用 fmtCost 为空（未配单价）时只显 token，title 复用 chatview.tokenHint/tokenCachedHint + 费用行；i18n 新增 chatview.sessionUsage 四语 1 key（明细 key 复用 Iter-35）；新建 tests/usage-summary.test.ts 6 用例（空会话/user 与无 usage 跳过计数/无 pricing 费用 0/单模型计费 7 元/多模型多批次含缓存价 12.7 元/单价缺失与无 provider 只计 token）。
- **决策记录**：账单口径=全部 assistant 消息（含分支重跑各批次），与 usage-service 聚合一致——重跑真实发生消费，用户要看的是「实际花了多少」而非「当前可见分支花了多少」；费用逐条按消息自带 provider/model 计价再求和，不做会话级单一模型假设；放消息流内随滚动消失而非顶部固定栏（省布局高度，长会话中顶部自然让位内容，需要时滚回顶部即可）；不新增明细 title key（直接复用气泡同款输入/输出/缓存文案）。
- **明确不做**：不做会话内逐轮费用明细表（Iter-25 留尾保留，气泡单行+累计已覆盖日常感知）；不做历史会话列表上的费用列（需跨会话聚合查询，用量面板已有会话排行+跳转）；不做费用预算/超支提醒（数据可视化模块未列，避免过度设计）。

### V4-Iter-35 气泡 token 微展示（已落地）

- **范围**：单条消息 usage 早已落库（V4-Iter-1），用量面板有聚合视图，但对话过程中看不到每轮花了多少 token——最贴近消费时刻的位置无感知。本批在每条 assistant 气泡下加 10px 微展示：总 token 缩写 + 命中本机单价时的估算费用，hover title 看输入/输出/缓存明细；分支对比列同口径可横向比较。
- **方案**：
  - 纯函数收口：`src/main/usage/pricing.ts` → `src/shared/usage-pricing.ts`（本就零 electron/DB 依赖，主进程与渲染端共用 computeUsageCost/priceKey/parsePricing）；import 改道 usage-service/pricing-config/handlers(messages)/tests。
  - 新建 `src/renderer/src/utils/token.ts`：fmtTokens/fmtCost 从 UsagePanel 抽出共用；UsagePanel 删私有实现，本地同构 `pk` 改用共享 priceKey（消除重复）。
  - MessageBubble：+props usage/provider/pricing；assistant 气泡来源块下渲染 token 行（fmtTokens(totalTokens) + 费用 accent 小字），title 拼输入/输出/缓存命中明细（cached=0 省略），无 usage/streaming 不渲染。
  - ChatView：挂载拉 getUsagePricing 存 state（失败静默=只显示 token），assistant MessageBubble 传 usage/provider/pricing，pricing 透传 BranchCompare（其内部 MessageBubble 传齐三参）。
  - 调研校准：ChatDoneEvent 不带 usage，但 useStreamSession done 后 200ms 自动 loadMessages 带 usage 重载，无需改事件链路；MessageBubble 仅 ChatView/BranchCompare 使用，Agent/浮窗自动排除（同 Iter-22 口径）。
  - i18n：chatview.tokenLine/tokenHint/tokenCachedHint 中英日韩四语 3 key。
  - 测试：usage-pricing.test 改 import 路径用例不动；新建 tests/token-format.test.ts 6 用例（fmtTokens k/M 分级边界、fmtCost 0/负/NaN 空串与精度分级）。
- **决策记录**：pricing 纯函数移 shared 而非渲染端重复实现（DRY，文件头本就标注「便于单测」；pricing-config 的 KV 读写含 DB 依赖保留 main 不动）；费用用原生 title 而非自定义弹层（与用量柱 tooltip 同模式，零样式成本）；不设显示开关（10px muted 常显干扰极小，有反馈再加）。
- **明确不做**：不做流式进行中实时 token（多数 provider 仅流末尾返回 usage）、不覆盖 Agent 面板/浮窗、不做消息级用量弹窗（台账留尾保留）。

### V4-Iter-34 KB 问答历史跨库漫游（已落地）

- **范围**：V4-Iter-28 留尾四项收官（搜索 Iter-30 / 重命名导出 Iter-29 / 自动清理 Iter-33 已落地）——问答历史此前只能逐库进入「库详情→问答 tab→历史」翻看，跨库找旧问答必须一个个库点。本批在知识库模块加统一入口跨库查看/搜索全部问答留痕，点击直达所属库回放。
- **方案**：
  - repo：kb-ask-session.repo 增 `listAll(limit)` / `searchAll(keyword, limit)`——`FROM kb_ask_sessions s LEFT JOIN knowledge_bases k ON k.id=s.kb_id` 带库名，`ORDER BY s.updated_at DESC LIMIT ?`；空串回退 listAll；RoamRow = SessionRow & {kb_name: string|null}，null 回落空串交 UI 兜底。
  - types：+KbAskRoamItem（extends KbAskSessionMeta +kbName）+IPC KB_ASK_SESSION_LIST_ALL/SEARCH_ALL。
  - IPC/preload：knowledge.ts 2 safeHandle（limit zod int 1-500）；preload listAllKbAskSessions/searchAllKbAskSessions（默认 200）。
  - UI：新建 `KbAskRoam.tsx`（搜索框 200ms 防抖 + 会话行：标题/库名 chip/时间·消息数·模型，空态区分无历史/无匹配）；KnowledgeModule mode 联合加 'roam'，左栏标题行加 🕘 入口，右栏 mode==='roam' 渲染 KbAskRoam；点击行 → setAskJumpId+setMode('detail')+setSelectedId（模块 state 提升，不走 source-jump 式事件）；KbDetail 加 askJumpId/onAskJumpHandled props，effect 收到非空 setAskMode(true) 并透传 KbAskPanel；KbAskPanel 加 openSessionId/onSessionOpened props，effect 消费（setShowHistory(true)+loadSession+回调清空），兼容切库重挂载首消费与同库二次跳转；fmtSessionTime 导出供漫游列表复用。
  - i18n：kb.roamTitle/roamSearchPlaceholder/roamEmpty/roamSearchEmpty/roamKbDeleted 中英日韩四语 5 key。
  - 测试：kb-ask-session-repo.test 补 listAll/searchAll 4 用例（JOIN+ORDER+LIMIT SQL 与参数、LIKE 参数顺序、空白回退、kb_name null 兜底空串）。
- **决策记录**：漫游入口仅在知识库模块内，模块必然已挂载，用模块 state 提升最简（KbAskRoam 是 KnowledgeModule 的一个 mode），不引入 sessionStorage/事件——后续若有外部模块入口再升级 source-jump 模式；LIMIT 200 与 Iter-33 自动清理配套，不做分页；LEFT JOIN 仅防御（deleteKb 已级联 deleteByKb，无主会话理论不存在）。
- **明确不做**：不做分页/加载更多、不做按库筛选 chip（搜索框够用）、不做外部模块入口。

### V4-Iter-33 KB 问答历史自动清理（已落地）

- **范围**：V4-Iter-28 决策记录留尾——问答留痕只增不减，仅支持手动单条删除，久了无限膨胀。本批补保留策略（每库最多 N 条 / 保留最近 N 天），保存新会话时顺手清理。
- **方案**：
  - repo：kb-ask-session.repo 增 `prune(kbId, policy)`——keepDays>0 删 `updated_at < 阈值`、keepCount>0 删 `id NOT IN (SELECT ... ORDER BY updated_at DESC LIMIT ?)`，返回合计删除数。
  - 配置：新建 `src/main/knowledge/ask-retention-config.ts`（仿 pricing-config）——app_config 键 `kbAsk.retention`，JSON `{keepCount, keepDays}`；parseKbAskRetention 容错（非对象/负数/NaN/小数→回退或取整），默认双 0 = 关闭。
  - 联动：KB_ASK_SESSION_SAVE handler upsert 后读配置，非全 0 则 prune 该库（策略触发点而非调度器，零定时器复杂度）。
  - IPC：types +KB_ASK_RETENTION_GET/SET；knowledge.ts 2 个 safeHandle + zod（keepCount 0-10000 / keepDays 0-3650）；preload 双桥接 + KbAskRetention 类型导入。
  - UI：KbAskPanel 历史列表搜索框下加「自动清理」btn-ghost 按钮（策略生效时 accent 高亮）→ 展开行内配置（保留条数 不限/50/100/200/500 + 保留天数 不限/7/30/90/180 双 select），切换即保存 + toast + 刷新列表。
  - i18n：kb.askRetention/askRetentionCount/askRetentionDays/askRetentionUnlimited/askRetentionSaved 中英日韩四语 5 key。
  - 测试：kb-ask-session-repo.test 补 prune 4 用例（仅 keepDays/仅 keepCount/双策略合计/双 0 不删）；新建 ask-retention-config.test 6 用例（parse 非对象/非法值/小数取整、get 无配置/坏 JSON/set-get 往返）。
- **决策记录**：默认双 0 关闭，不静默删用户数据；prune 挂在 SAVE handler 层而非 repo.upsert 内部（repo 保持纯数据访问，编排归 handler）；仓库无 retention 调度先例（backup/log 均无自动清理），upsert 是天然触发点，天数策略同样由写入触发，不引入定时器。
- **明确不做**：不做全局跨库清理 UI、不做定时调度器、不做清理前确认弹窗（策略由用户显式设置，预期内行为）。

### V4-Iter-32 用量排行点击跳转（已落地）

- **范围**：V4-Iter-25/27 连续两次留尾——用量面板展示排行数据但不能直接操作。本批补点击跳转到对应会话/助手，打通洞察到操作最后一公里。
- **方案**：
  - 新建 `src/renderer/src/modules/settings/usage-jump.ts`：仿 source-jump.ts 跨模块导航模式——`USAGE_JUMP_EVENT` 事件 + sessionStorage pending 存取 + `requestUsageJump`（写 pending + 切模块 + 广播）+ `consumePendingUsageJump`（读后即清 + 类型校验容错）。
  - UsagePanel：会话/助手排行行加 `cursor-pointer hover:bg-hover-overlay` + onClick 调 `requestUsageJump`，title 提示「点击跳转」。
  - ChatModule：useEffect 监听 USAGE_JUMP_EVENT，消费 pending → conversation 调 handleSelectConv / assistant 调 handleSelectAssistant（后者内含 reloadConversations 重载）。
  - i18n：usage.clickToJump 四语对齐。
  - 测试：tests/usage-jump.test.ts 6 用例（request/consume 正常存取、读后即清、非法 JSON、非法 type、缺字段、无 pending）。
- **决策记录**：复用 source-jump.ts 的 sessionStorage+event 模式而非全局状态——跨模块跳转有先例且事件驱动更解耦；跳转到助手即切换当前助手并重载会话列表（复用 handleSelectAssistant 既有行为）。
- **明确不做**：不做到消息级别（V4-Iter-15 搜索跳转已做，这里只跳模块+选中对象）、不做动画/过渡、不做浏览器历史/返回栈。

### V4-Iter-31 提示词片段库导入导出（已落地）

- **范围**：V4-Iter-20 留尾——片段仅存本机，换设备/重装即丢。本批补 JSON 文件导出（备份/分享）+ 导入（迁移/合并）。
- **方案**：
  - repo：snippet.repo 增 `findByTitle(title)` + `createOrUpdateByTitle(title, content)`——同 title UPDATE（保留原 id）、无同 title INSERT（新 UUID）。
  - shared/types：+IPC 常量 SNIPPETS_EXPORT/SNIPPETS_IMPORT。
  - schemas：snippetImportSchema（宽松校验顶层 snippets 数组，逐条字段验证在 handler 层做）。
  - IPC：snippets.ts 增 EXPORT（主进程 list() → JSON.stringify → showSaveDialog 存盘）+ IMPORT（showOpenDialog 读 JSON → zod 校验 → 逐条 createOrUpdateByTitle 统计 imported/overwritten/skipped）。
  - preload：exportPromptSnippets + importPromptSnippets 桥接。
  - UI（SnippetButton）：列表底部工具行 btn-ghost「⬇ 导出 / ⬆ 导入」按钮；导出成功 toast 路径、导入成功 toast 计数、失败 toast 错误。
  - i18n：snippet.exportTitle/importTitle/exported/imported/importFailed 中英日韩四语 5 key。
  - 测试：tests/snippet-repo.test.ts 3 用例（createOrUpdateByTitle UPDATE/INSERT 分支、findByTitle 命中/未命中）。
- **决策记录**：同名覆盖策略（UPDATE）——片段列表按更新时间排序，无自定义 id 语义需求，同 title 即认为是同一条记录；不做增量/合并策略选择 UI（行为可预测优先）。
- **明确不做**：不做加密导出（片段不含敏感信息）、不做云同步/分享链接。

### V4-Iter-30 KB 问答会话搜索（已落地）

- **范围**：V4-Iter-28/29 留尾——问答留痕只增不减，历史列表只能按时间倒序翻页，留痕多了找不回等于白留。本批在历史列表加搜索，按标题+消息正文检索。
- **方案**：
  - repo：kb-ask-session.repo 增 `searchByKb(kbId, keyword)`——`title LIKE ? OR messages_json LIKE ?`（LIKE 实现，不引 FTS5 migration）；空串/空白回退 `listByKb`（避免 `LIKE '%%'` 全表扫描）。
  - shared/types：+IPC 常量 `KB_ASK_SESSION_SEARCH`。
  - IPC：knowledge.ts safeHandle + argsSchema(idSchema, z.string().max(200))。
  - preload：searchKbAskSessions(kbId, keyword) 桥接。
  - UI（KbAskPanel.tsx）：历史列表顶部加搜索输入框（200ms 防抖，卸载清 timer）；搜索态空结果显示「无匹配会话」，非搜索态空结果显示「暂无历史会话」；关闭历史面板自动清空搜索态。
  - i18n：kb.askSearchPlaceholder/kb.askSearchEmpty 中英日韩四语 2 key。
  - 测试：tests/kb-ask-session-repo.test.ts 5 用例（LIKE 匹配标题+消息体/空串回退全量/空白回退全量/无匹配空数组/非法 JSON 容错解析）。
- **决策记录**：LIKE 而非 FTS5——kb_ask_sessions 数据量级（几十~几百条）下 LIKE 完全够用，不引入 migration/触发器/tokenizer 复杂度；messages_json 是 JSON 字符串，LIKE 会匹配到 JSON 结构字符属可接受噪音。
- **明确不做**：不做 FTS5、不做跨库搜索、不做搜索结果高亮、搜索历史、自动补全。

### V4-Iter-29 KB 问答会话重命名与导出（已落地）

- **范围**：V4-Iter-28 留痕收尾——会话标题由首问自动截断生成不可手动改（长问截断后辨识度差）、问答成果无法导出带走。本批补：会话重命名（内联编辑）+ 单会话导出 Markdown/HTML。
- **方案**：
  - repo：kb-ask-session.repo 增 `rename(id, title)`（UPDATE 仅 title+updated_at，避免全量消息重传）。
  - shared/types：+IPC 常量 KB_ASK_SESSION_RENAME/EXPORT_MD/EXPORT_HTML。
  - shared/export-markdown.ts：增 `buildKbAskSessionMarkdown(session, messages)`——头部 `# title` + 模型/创建时间/更新时间/消息数元信息，每条消息 `## 角色`（user 引用块包裹、assistant 正文保真）+ 参考来源（复用 formatSources 去重）；KbAskMessage 无 attachments/toolCalls/usage，结构比 buildConversationMarkdown 更简。
  - IPC：knowledge.ts 3 handler——RENAME（zod id+title 1-200）、EXPORT_MD（主进程 kbAskSessionRepo.get → buildKbAskSessionMarkdown → showSaveDialog → writeFileSync）、EXPORT_HTML（渲染端构建后传主进程存盘，zod html ≤ 50MB）；复用 safeFileName 做默认文件名。
  - preload：renameKbAskSession/exportKbAskSessionMd/exportKbAskSessionHtml 3 桥接。
  - renderer/utils/export-html.tsx：增 `buildKbAskSessionHtml(session, messages)`——复用同文件 STYLE/Markdown/formatSources/roleLabel，结构简化为标题区 + 消息区（user 气泡/assistant Markdown+来源列表），无助手名/附件/工具/token；react-dom/server 动态 import 同既有拆包模式。
  - UI（KbAskPanel.tsx）：历史列表项加重命名 ✎（内联 input，Enter 确认/Esc 取消/失焦提交，空串不提交）+ 导出 ↓ 菜单（复用 ConversationList ExportMenu 组件，MD/HTML 两项）+ 删除 ✕；当前会话工具行在「新对话」右侧加重命名按钮 + 导出菜单（仅 sessionId 非空且非 pending 时显示，防导出未完成流式内容）；导出成功 toast 路径、失败 toast 错误。
  - i18n：复用 chat.rename/chat.exportMd/chat.exportHtml/chat.exportMenu/common.delete 免新增；新增 kb.askExported({path})/kb.askSessionNotFound 四语 2 key。
  - 测试：export-markdown.test 增 buildKbAskSessionMarkdown 4 用例（头部元信息/user 引用块+assistant 保真/来源去重/空内容无来源块）。
- **决策记录**：重命名走专用 rename 而非 upsert（只改两列，不传全量 messages）；MD 由主进程从 DB 构建（DB 权威，导出按钮 pending 时禁用保证内容完整）、HTML 由渲染端构建（复用 Markdown 组件渲染管线），与 CONVERSATION_EXPORT_MD/HTML 同构。
- **明确不做**：不做 PDF 导出（MD/HTML 已覆盖，PDF 走现有对话导出通道）、不做批量导出、不做导出时选择消息范围、不做会话搜索/分类。

### V4-Iter-28 KB 问答留痕（已落地）

- **范围**：V4-Iter-8 KB 问答模式对话纯内存态、关窗/切库即丢（ask-service.ts 注释自述「对话不落库」）。本批把问答会话落库留痕，可从历史列表回看与继续追问，补齐「问答成果可复用」的核心体验短板。
- **方案**：
  - migration v33 `kb_ask_sessions` 新表：id/kb_id/title/messages_json/provider_id/model/created_at/updated_at + kb_id+updated_at 复合索引；消息体（含引用来源）JSON 单列存储，一轮问答一行（问答无 FTS/逐条管理诉求，保持轻量）。
  - shared/types：新增 KbAskSessionRecord（含 messages: KbAskMessage[]）与 KbAskSessionMeta（列表瘦身元数据，messageCount 替代正文）；IPC 常量 KB_ASK_SESSION_SAVE/LIST/GET/DELETE。
  - shared/kb-ask-session.ts 纯函数：sessionTitleFrom（首问截断为标题，40 字上限加省略号）；parseKbAskMessages（容错解析：非法 JSON/非数组返 []，过滤 role/content/sources 不合法项，sources 保留原样）——零依赖放 shared，供主进程 repo 与 tests/ 复用。
  - kb-ask-session.repo.ts（仿 snippet.repo）：upsert（INSERT OR REPLACE，messages JSON.stringify）/listByKb（按 updated_at DESC 回 meta 不含正文）/get（parseKbAskMessages 容错还原）/delete/deleteByKb（KB 删除级联用）。
  - IPC：knowledge.ts 4 个 safeHandle（SAVE 走 zod 完整 schema，messages 上限 200 条）；preload 4 桥接（saveKbAskSession/listKbAskSessions/getKbAskSession/deleteKbAskSession）。
  - 落库时机：渲染端全量 upsert 单写路径，ask-service 零改动——send() 首轮生成 sessionId（crypto.randomUUID）后存「含提问」，onKbAskDone 存「含回答+sources」。用 msgsRef 镜像 + persistRef 转发，保证一次性挂载的流式订阅闭包拿到最新消息与 provider/model/sessionId。
  - UI：KbAskPanel 加会话工具行（历史(N) 切换 + 新对话）、历史列表（标题/消息数/相对时间/模型，当前会话高亮，删除单条）；加载历史会话回放全部消息可继续追问；新对话/删除当前会话中止进行中请求并清空；KnowledgeModule KbAskPanel 加 key={kb.id} 保证切库重挂载防跨库串数据（落库引入的必要修正）。
  - 级联：ingestion.ts deleteKb 增加 kbAskSessionRepo.deleteByKb，删库不留孤儿会话。
  - i18n：四语改写 kb.askHint（去掉「仅保存在当前页面」自相矛盾表述），新增 kb.askHistory/askNewSession/askNoSessions/askMsgCount({n}) 4 key。
  - 测试：tests/kb-ask-history.test.ts 8 用例（sessionTitleFrom 常规/超长截断/空白；parseKbAskMessages 合法/非法 JSON/非数组/非法项过滤/sources 非法整条丢+合法保留）；knowledge-ingestion.test.ts 补 kb-ask-session.repo mock（repo 顶部 import database→electron 链路须隔离，否则新 import 链导致该测试文件 import 失败）。
- **决策记录**：渲染端单写路径而非主进程 ask-service 内落库——保持 ask-service 零改动，渲染端天然持有完整 messages（含 sources）；流式中途关窗丢当轮回答（问题已保存）可接受。不做会话全文搜索 FTS/跨库漫游/重命名/导出/自动清理（留作后续）。
- **踩坑**：新增 repo import 链（kb-ask-session.repo → database → portable → electron）使 knowledge-ingestion.test.ts 顶层 import 失败，需在该测试补 vi.mock 隔离。

### V4-Iter-27 助手用量排行（已落地）

- **范围**：V4-Iter-25 决策记录明确留尾「不做助手维度排行（同模式可后续扩展）」。UsagePanel 已有 时间/Provider/模型/会话 四个维度，看不到「哪个助手花得最多」。本批补第五个维度：助手排行（名称/生成次数/Token/估算费用 Top10，随 7/30/90 天范围联动）。
- **方案**：
  - types：UsageAssistantItem（assistantId/name/requests/totalTokens/cost/lastUsedAt）+ IPC USAGE_ASSISTANTS='usage:assistants'。
  - usage-service：UsageAssistantRow 输入行（conversations JOIN assistants 带助手归属与名称）；纯函数 aggregateAssistantUsage(rows, prices) 与 aggregateConversationUsage 完全同构——Map 按 assistant_id 分组、parseUsageJson 坏 JSON 跳过、computeUsageCost 同口径计费、roundCost 消尾巴、totalTokens 倒序、name 空/NULL 兜底「(未知助手)」且同助手防御取首个非空、lastUsedAt 取 MAX(created_at)；UsageService#listAssistantUsage(days 夹 1-365, limit 夹 1-100 默认 10, prices)——SQL `messages JOIN conversations LEFT JOIN assistants` + created_at >= since 过滤，聚合后 slice 截断。
  - IPC：USAGE_ASSISTANTS safeHandle + zod days/limit 双 optional（1-365/1-100），handler 内 getUsagePricing().prices 透传；preload getUsageAssistants(days?, limit?)（d.ts 经 PocketAPI 类型自动推导无需另改）。
  - UsagePanel：会话排行区块之后加「助手排行」区块（Top10 表格，样式复用 byModel/会话排行同款，asstUsage 随 load(days) 同链路加载/重载，空数组不渲染区块）。
  - i18n：usage.byAssistant（助手排行 Top 10）/ usage.assistant（助手）四语 2 key。
  - 测试：usage-service.test 22→26 用例（多助手分组倒序+lastUsedAt、名称兜底与防御取非空含 assistant_id 空共享兜底组、坏 usage 行跳过、配置单价计费/未配置 cost=0）。
- **决策记录**：SQL 用 INNER JOIN conversations（孤儿消息无 conversations 行则无法归属助手，被排除属合理语义）；conversations LEFT JOIN assistants（assistant_id NULL/助手已删除时聚合侧兜底「(未知助手)」）；limit 默认 10（助手数量天然远少于会话）。不做点击排行跳转助手（Settings→Chat 跨模块链路，同 V4-Iter-25 决策）；不做助手维度会话数统计（保持与会话排行字段同构，最小改动）。

### V4-Iter-26 会话导出 PDF（已落地）

- **范围**：导出能力线（V4-Iter-17 单条 MD/HTML + 加密、V4-Iter-24 批量 MD/HTML）补 PDF 格式——打印/存档/分享离线文档场景。零新依赖：渲染端 buildConversationHtml 产物自包含（内联样式无外部资源），主进程隐藏 BrowserWindow + webContents.printToPDF 转换。单条（Chat/Agent 行内菜单）+ 多选批量（操作条第三按钮，上限 50）。
- **方案**：
  - 新建 `src/main/export/pdf.ts`：ensurePdfWindow 单例隐藏窗口（800×600、sandbox:true、无 preload、deny 弹窗/导航——模板照抄 js-eval-runner）；HTML 经临时文件（app temp 目录）file:// 加载（data URL 有 ~2MB 上限风险）；printToPDF A4 + printBackground + 页码页脚（headerTemplate 显式置空防默认日期页眉，margins.bottom 容纳 footer）；60s 兜底超时销毁重建防队列卡死；模块级串行队列（照抄 evalQueue 模式，队尾吞错）；loadFile/printToPDF 失败销毁窗口防坏窗口复用；finally unlink 临时文件。
  - IPC：CONVERSATION_EXPORT_PDF（id,html → showSaveDialog 默认 title.pdf → htmlToPdf → writeFileSync Buffer）；CONVERSATION_EXPORT_PDF_BATCH（files → showOpenDialog 选目录 → dedupeFileNames → 串行逐个转换写盘 → {ok,count,dir,failed}，数组 max 50 与渲染端 BATCH_PDF_MAX 同值）。preload +exportConversationPdf/exportConversationsPdfBatch。
  - 渲染端通道 batch-export.ts：BatchExportFormat 扩 'pdf'（content 仍为 HTML、扩展名 .pdf）；BATCH_PDF_MAX=50；finishBatchExport(files, format) 按 format 分流 PDF/既有通道，BatchExportOutcome 复用。
  - UI：ConversationList/SessionRail 单条 ↓ 菜单加「导出 PDF」第三项；多选操作条加第三按钮「导出所选 PDF」；ChatModule/AgentPanel +handleExportPdf（同 handleExportHtml 结构），handleBatchExport format 扩 'pdf'，capSelection 上限按 format 选（pdf=50 其他=500）超限复用 exportMultiCapped 提示。
  - i18n chat.exportPdf/chat.exportSelectedPdf 四语 2 key。
  - 测试：batch-export.test 8→12 用例（pdf 组装路径扩展名/内容；finishBatchExport pdf 分流走新通道且透传、md 分支仍走旧通道；BATCH_PDF_MAX=50 守卫）。
- **踩坑**：typecheck 抓出 ConversationList 顶层组件解构漏 onExportPdf（ConvItem 已解构但父组件漏传）。
- **决策记录**：全量批量导出不加 PDF（📤 菜单保持 MD/HTML——几百会话逐个渲染耗时不可控），PDF 批量只进多选通道（用户主动圈定范围）上限 50；不做 PDF 批量进度上报（跨进程事件推送成本高，invoke 挂起可接受）；仅页码页脚不做页眉/封面/目录；PDF 窗口生命周期与 js-eval-runner 常驻单例同构，不引入新退出行为。

### V4-Iter-25 会话用量明细（已落地）

- **范围**：V4-Iter-23 决策记录明确留尾「不做按会话/助手维度费用（聚合在 messages 行级已可后续扩展）」。UsagePanel 此前只有 时间/Provider/模型 三个维度，看不到「哪些会话花得最多」。本批补第四个维度：会话排行（标题/生成次数/Token/估算费用 Top20，随 7/30/90 天范围联动）。
- **方案**：
  - types：UsageConversationItem（conversationId/title/requests/totalTokens/cost/lastUsedAt）+ IPC USAGE_CONVERSATIONS='usage:conversations'。
  - usage-service：UsageConversationRow 输入行（LEFT JOIN conversations 带标题）；纯函数 aggregateConversationUsage(rows, prices)——Map 按 conversation_id 分组，parseUsageJson 坏 JSON 跳过、computeUsageCost 同口径计费、roundCost 消尾巴，totalTokens 倒序，title 空/NULL 兜底「(未知会话)」且同会话防御取首个非空，lastUsedAt 取 MAX(created_at)；UsageService#listConversationUsage(days 夹 1-365, limit 夹 1-100 默认 20, prices)——SQL LEFT JOIN + created_at >= since 过滤（时间范围由 SQL 承担，与 aggregateUsage 不同点：无 daily 补零需求故纯函数不收 days），聚合后 slice 截断。
  - IPC：USAGE_CONVERSATIONS safeHandle + zod days/limit 双 optional（1-365/1-100），handler 内 getUsagePricing().prices 透传（与 USAGE_GET 同模式）；preload getUsageConversations(days?, limit?)。
  - UsagePanel：模型 Top10 表之后加「会话排行」区块——表格样式复用 byModel 同款（会话列 truncate + title 提示、费用列 accent），convUsage 随 load(days) 同链路加载/重载（切天数范围、单价保存 reload 均联动），空数组不渲染区块。
  - i18n：usage.byConversation（会话排行 Top 20）/ usage.conversation（会话）四语 2 key。
  - 测试：usage-service.test 17→22 用例（多会话分组倒序+lastUsedAt、标题兜底与防御取非空、坏 usage 行跳过、空 conversation_id 兜底、配置单价计费/未配置 cost=0）。
- **决策记录**：与计划的一处偏差——aggregateConversationUsage 纯函数不收 days 参数（时间过滤由 SQL created_at >= since 承担；aggregateUsage 需要 days 是因为 daily 补零，本函数无此需求），limit 截断在 service 层 slice，测试聚焦纯函数行为。不做点击排行跳转会话（Settings→Chat 跨模块需处理助手切换链路）；不做助手维度排行（同模式可后续扩展）；不做单会话内消息级用量弹窗。

### V4-Iter-24 会话多选批量导出（已落地）

- **范围**：V4-Iter-17 批量导出留尾（当时明确「逐选留后续」）——📤 批量菜单只能全量导出当前助手所有会话，无法挑着导。本批：Chat 会话列表与 Agent 会话栏加多选模式（checkbox 逐选/全选），按所选批量导出 Markdown/HTML，复用既有 exportConversationsBatch IPC（上限 500 文件、重名去重、单文件失败不中断计 failed）。
- **方案**：
  - 新共用核心 `src/renderer/src/utils/batch-export.ts`：BATCH_EXPORT_MAX=500；capSelection(convs, max?) 超限截断保序返回 {list, dropped}（不足上限原引用返回零拷贝）；buildBatchExportFiles({convs, format, listMessages, resolveAssistantName, onProgress?}) 逐会话 listMessages → buildConversationMarkdown/buildConversationHtml 组装 BatchExportFile[]，每 10 个 setTimeout 0 让帧防卡 UI；finishBatchExport(files) 调 exportConversationsBatch 返回结构化 BatchExportOutcome（canceled/failed{error}/done{count,dir,failedCount}），由调用方拼 toast。
  - ConversationList：ExportMenu 加「多选导出…」第三项（清搜索+进多选，搜索态与多选互斥）；selectMode 下顶部按钮区替换为「全选/取消」，ConvItem 行首 checkbox（stopPropagation 防触发切会话）、行点击=toggle、隐藏 ⋯/↓/🔐/×/📍；底部固定操作条「已选 {n} 个会话」+ 导出 MD/网页 按钮（n=0 disabled）；Esc 退出；归档区不参与多选。
  - SessionRail 与 Chat 侧完全同构。
  - ChatModule/AgentPanel：handleBatchExport(format, convs?) 双语义——convs 缺省=既有全量导出，传入=多选导出（capSelection 超限 toast 提示忽略数）；两侧重复循环删除统一走共用核心。
  - i18n chat.exportMulti/exportSelectedMd/exportSelectedHtml/exportMultiCount/exportMultiCapped 四语 5 key（全选/取消复用既有 common.*）。
  - 测试：tests/batch-export.test.ts 8 用例（capSelection 空/引用相等/超限保序 dropped/自定义 max；buildBatchExportFiles md/html 文件名 safeFileName 与内容、onProgress [done,total] 序列、空消息会话也产出文件）。
- **踩坑**：① finishBatchExport 初版动态 import ToastProvider 想直接 toast——toast 是 React context hook，动态 import 拿不到 Provider 实例，改为返回结构化 outcome 由调用方（ChatModule/AgentPanel）拼 toast。② 测试 conv 工厂误写 `model` 字段——ConversationRecord 实际是 modelLabel/status（typecheck 抓出）。③ html 断言初版写大写 `<!DOCTYPE html` 失败——builder 实际输出小写 `<!doctype html>`（export-markdown.test 既有断言可证），改用 `toContain('</html>')`。
- **决策记录**：多选态与搜索态互斥（搜索时列表被搜索结果组件替换，进多选先清搜索）；全量批量导出入口保留不变，多选是新增分支；归档会话不参与多选（与 V4-Iter-18 归档区定位一致，需要时先取消归档）。

### V4-Iter-23 用量费用估算（已落地）

- **范围**：V4-Iter-1 用量统计的留尾（当时价格配置暂缓）。UsagePanel 只能看 token 数，看不到花了多少钱。本批：本机配置「每 100 万 token 单价」后，在汇总卡/按日柱/Provider 排行/模型 Top10 各层展示估算费用（¥/$），单价仅存本地不上传，未配置模型不计费。
- **领域口径**：cachedTokens 是 promptTokens 的**子集**（Anthropic cache_read / OpenAI cached_tokens），非增量；cache_creation 不跟踪按普通输入计价。费用 = ((prompt − cached) × 输入价 + cached × 缓存价（留空回退输入价）+ completion × 输出价) / 100 万；异常数据 cached>prompt 夹到 prompt 防负数。
- **方案**：
  - 新纯函数 `src/main/usage/pricing.ts`（零 electron/DB 依赖）：PRICE_UNIT=100 万、roundCost 6 位小数消浮点尾巴、sanitizeModelPrice（input/output 必填非负有限、cache 可空、非法整条丢）、parsePricing（currency 非白名单回退 CNY、prices 非对象回空表、key 必须含 `::`）、computeUsageCost、priceKey。
  - `src/main/usage/pricing-config.ts`：appConfigRepo KV 键 `usage.pricing`，get 时坏 JSON/无值回退 `{currency:'CNY',prices:{}}`（appConfigRepo 无 getJson，get()+JSON.parse try/catch），set 时 JSON.stringify。
  - shared/types：UsageSummary 的 totals/daily[]/byProvider[]/byModel[] 全加 cost；新增 ModelPrice/UsagePricing/UsageModelItem；IPC 加 USAGE_PRICING_GET/SET/USAGE_MODELS。新 zod schema `src/shared/schemas/usage.ts`（nonNegPrice + modelPriceSchema/usagePricingSchema 均 .strict()）。
  - usage-service：aggregateUsage 第三参 prices={}（旧调用零改动），平行 dailyCostMap，totals/provider/model/daily 各 cost 均 roundCost；新增 listDistinctModels（GROUP BY provider,model，MAX(created_at) 倒序 LIMIT 夹 1-500，默认 200，供单价编辑器自动列出历史模型）。
  - IPC：USAGE_GET 透传 getUsagePricing().prices；PRICING_GET 返回配置；PRICING_SET 走 usagePricingSchema.parse → parsePricing 规范化 → 持久化 → 返回规范化结果；MODELS 返回历史模型清单。preload 3 桥接。
  - UsagePanel：汇总卡 4→5 列新增「估算花费」（fmtCost：≥1 两位、0<n<1 四位、0 显示 —；币种 ¥/$），byModel 表加费用右对齐列、provider 行有费用时追加小字、柱状 tooltip 带费用；底部新增可折叠「单价设置」PriceEditor——币种 CNY/USD 切换，行清单=历史模型 ∪ 已配置 key（已配无用量不丢），每行输入/缓存/输出三个数字输入（每 100 万 token，缓存可空，输入输出需成对，否则保存报错），保存成功刷新本地态+重拉 summary+toast；i18n usage.* 新增 14 key 中英日韩四语对齐。
  - 测试：tests/usage-pricing.test.ts 17 用例（computeUsageCost 正常/缓存子集/留空回退/夹断/全 0/异常 token/浮点取整，parsePricing 币种回退/非对象/prices 脏数据/key 无 ::/cache=0 保留，sanitizeModelPrice/priceKey）；usage-service.test.ts 补 2 用例（价格表下 totals/daily/byModel 费用；未配置模型 cost=0 token 不丢、byProvider 费用=模型之和），空汇总 totals 断言补 cost:0。
- **踩坑**：① 纯函数测试初版把期望费用算大了 100 倍（把「单价 × token 数」忘了除百万口径本身——1M token × 2/M 应为 2 不是 200），vitest 实测抓出修正。② appConfigRepo 没有 getJson/setJson，改用 get()+JSON.parse/set()+JSON.stringify。③ listDistinctModels 先用双重断言，改为取蛇形行再 map 转 camelCase。
- **决策记录**：不做官方价目表内置（各家分档/阶梯/时区波动大，维护成本高于收益）；不做按会话/助手维度费用（聚合在 messages 行级已可后续扩展，本批仅时间维度）；币种是全局展示前缀不参与换算；单价不随备份外传的语义不做特殊加密（与其他本机配置同级）。

### V4-Iter-22 代码块一键复制（已落地）

- **范围**：AI 回复里的代码块此前只能手选或「整条消息复制」，高频小痛点。给 Markdown 围栏代码块加右上角复制按钮（图标+「复制/已复制」+语言名 tooltip），复用既有 writeClipboard/useCopyFeedback/common.copy 文案，零新增 i18n key。
- **调研校准**：候选原说「Chat/Agent 共用同一渲染组件」不实——Agent 消息卡是 `whitespace-pre-wrap` 纯文本渲染（不走 Markdown），且整条消息已有复制按钮；真实受益面是 Chat 气泡、浮窗 PopupApp、知识库问答、多模型对比列。另注意 export-html 用 renderToStaticMarkup 导出自包含 HTML（无事件处理器、无 i18n Provider），按钮必须在导出中关闭。
- **方案**：
  - 新纯函数 `src/renderer/src/utils/code-block.ts`：parseCodeProps 提取语言（小写、无语言围栏 lang=null）与代码；**nodesToText 递归拍平 children**——rehype-highlight 会把代码拆成 hljs span token 元素，直接 String(children) 会得到 `[object Object]`（旧 extractCodeBlock 只对 mermaid 这类未高亮语言侥幸可用），鸭子类型识别 `{props:{children}}`，不引入 react 运行时；末尾仅去一个换行。
  - Markdown.tsx：pre 渲染器对非 mermaid 围栏块渲染 CodeBlock（`relative` 包裹层 + 原 pre 样式 m-0，按钮 absolute 不随 pre 横向滚动移位；按钮半透明常显、hover/focus 全显，内联 SVG 复制/对勾图标）；mermaid 仍走 MermaidBlock；pre 非 code 结构/关闭开关时退回原 pre。新增 prop `codeCopy?: boolean`（默认 true）。
  - export-html.tsx 两处 Markdown 传 codeCopy={false}，导出 HTML 无死按钮。
  - 测试：tests/code-block.test.ts 11 用例（文本拍平/数组/嵌套 span/语言提取/无语言/单换行裁剪/高亮数组还原）。
- **踩坑**：① 高亮后 children 非字符串（span 数组），复制内容必须递归提取，已用单测锁住（这也是给 mermaid 提取路径顺手补的正确性）。② 测试里假元素数组不满足 ReactNode 类型，显式 `as ReactNode[]`。
- **决策记录**：Agent 纯文本渲染不做 markdown 化（超出本任务，整条复制已存在）；不做行号/折叠/语言标签常驻显示；导出 HTML 不带复制按钮（无 JS 环境）；无语言围栏块也提供复制。

### V4-Iter-21 会话智能标题（已落地）

- **范围**：会话标题此前只有「首条消息前 20 字截断」一条规则，且调研发现该规则在 Chat 主流程是**失效半成品**——Chat 新建会话标题传的是助手名（如「通用问答助手」），主进程 `title==='新对话'` 判断不触发，导致 Chat 会话长期同名；只有 Agent/浮窗/分支路径能得到截断标题。本批：首条消息后用当前模型生成 ≤10 字短标题（同语言），截断标题即时落地、模型标题后台升级，设置可开关；用户手改标题绝不覆盖。
- **方案**：
  - migration **v32 conv_title_default**：conversations 加 `title_default INTEGER NOT NULL DEFAULT 1`，存量行 `UPDATE … WHERE title<>'新对话'` 回填 0（老会话不被突然改名，仍为「新对话」的空会话保留资格）；ConversationRecord 加 titleDefault。
  - repo：create 入参 titleDefault（新建默认 1，导入两处传 false）；rename 同时置 0（手动改名=定稿）；新增 setTitleDefault；fork INSERT 显式 0；rowToRecord 对缺列 undefined 防御为 true。
  - 新模块 `src/main/conversation/`：title-prompt.ts 纯函数（fallbackTitle/buildTitlePrompt/sanitizeTitle——剥两层包裹引号、折叠空白、去「标题：」前缀与句末标点、空结果回退、模型标题上限 40 字符容英文 6 词）；title-gen.ts 编排（进入即消费标记保证每会话至多 1 次 LLM；开关关=完全旧行为仅「新对话」截断；开关开=先 rename 截断标题再 fire-and-forget 调 streamChat，独立 AbortController 10s 超时、maxTokens 32、temperature 0.3，成功 rename+broadcast CONVERSATION_TITLE_EVENT，失败 warn 保留截断；空文本/纯图片不调）；title-config.ts app_config 键 `conv.smart_title.enabled` 缺省开。
  - chat-service/engine 两处重复旧判断统一替换为 runFirstMessageTitle（Chat 取 targets[0]，Agent 取自身 target）。
  - IPC CONVERSATION_SMART_TITLE_GET/SET（safeHandle+z.boolean()）；preload 两桥接 + onConversationTitle 事件订阅（返回退订）；ChatModule 挂载订阅 map 更新活跃+归档两列表，useAgentChat 并入既有事件 effect offs；流式结束 reload 为兜底。
  - 设置页快捷键小节后新增「对话」小节：ConversationSettingsPanel 开关行（乐观更新+失败回滚，未加载时 disabled）。
  - i18n set.chat/set.smartTitle/set.smartTitleHint 中英日韩四语。
  - 测试：title-prompt.test.ts 13 用例、conversation-repo rowToRecord +1；channel-service 两处 fixture 补 titleDefault；agent-context 补 title-gen mock。
- **踩坑**：① 模型标题初版沿用截断上限 20 字符，英文 6 词标题被切断——单测抓住，模型标题单独放宽到 40 字符（中文长度由 prompt 约束）。② engine 新增 import 拉起 title-config→app-config.repo→portable→electron 链，agent-context 纯函数测试套件 electron 未完整 mock 而加载崩溃，补 vi.mock title-gen 切断链路。③ 全量并发 vitest 连续两次卡在 export-markdown 动态 import 用例 5000ms 超时（137 worker 冷启动竞争，单文件 4.3s 贴线，V4-Iter-20 已记录的 flaky 随文件数增多更易触发），`--fileParallelism=false` 串行 137 文件 1989 用例全绿。
- **决策记录**：不对老会话批量重命名；不做每助手/每模型开关与自定义 prompt；纯图片消息不做视觉识图命名；浮窗窗口不订阅事件；关开关时 Chat 助手名占位维持原样（100% 旧行为）。

### V4-Iter-20 提示词片段库（已落地）

- **范围**：高频提示词（「总结以下内容」「翻译成正式英文：」）此前只能手打或从笔记复制；Agent 斜杠指令是 6 条写死内置项、不可增删、无变量。本批给两个输入框加用户自管的片段库：标题+正文 CRUD、`{{变量}}` 占位插入前填充、光标处就地插入。不新增侧栏模块/设置页（轻量工具就近使用）。
- **方案**：
  - DB migration **v31 prompt_snippets**（追加不改历史）：新表 id/title/content/created_at/updated_at + updated_at DESC 索引；PromptSnippetRecord 类型；snippet.repo 仿 note.repo（list/get/create/update 刷 updated_at/delete，rowToRecord）。
  - IPC：SNIPPETS_LIST/CREATE/UPDATE/DELETE（safeHandle + zod：title trim 后 1-100、content 1-20000，update patch refine 至少含一字段）；ipc/index.ts 注册；preload 4 桥接（PocketAPI 由 typeof api 自动推导，只加实现+import 类型）。
  - 纯函数 `src/renderer/src/utils/snippet-template.ts`：extractTemplateVars（正则 `[A-Za-z0-9_一-龥]+` 支持中文变量名，去重保序）、applyTemplateVars（占位替换，空串=显式留空，未知 key 保留原占位防御，字符串替换无 $ 模式注入）；与 main/assistant/prompt-template.ts 的系统固定变量完全隔离。
  - 共用组件 `src/renderer/src/components/SnippetButton.tsx`：📝 按钮 + **fixed 定位弹层**（已核实 AgentModule 外壳 overflow-hidden，absolute 会被裁切；trigger getBoundingClientRect 向上展开、视口边界左移夹紧），三态——列表（搜索前端过滤/新建/✎/行内二次确认删除 3s 自动复位/空态引导）、编辑（标题+正文 textarea+变量用法提示+trim 校验 toast）、变量填充（每个变量一个 input、Enter 直接插入）；点外部关闭、Esc 先退子态再关整层（capture 监听防与中枢/斜杠菜单 Esc 打架）；打开即拉列表，CRUD 后刷新。
  - Chat Composer：附件按钮后加 SnippetButton；insertAtCursor 取 selectionStart/End 拼接走 setText（受控组件不直接改 DOM），rAF 后 focus+setSelectionRange 定位+resize（插入长片段自动撑高，resize 必须在 DOM 更新后）。
  - Agent AgentComposer：textarea 补 taRef，同一按钮（running 时 disabled 与输入区禁用一致），插入后无需 resize（固定行高样式）。
  - i18n snippet.* 20 key 中英日韩四语。
  - 测试：tests/snippet-template.test.ts 12 用例（提取去重保序/空白/中英文标识符/非法形态；替换全量/多实例/$ 特殊串/空串/未知保留/无变量原样）。
- **踩坑**：i18n-parity 测试占位符正则为 `/\{(\w+)\}/g`（\w 不含 CJK），各语 hint 示例分别写 `{{variable}}/{{变量名}}/{{変数名}}/{{변수명}}` 导致集合不一致红灯；统一为 `{{name}}` 示例后通过（变量实际仍支持中文，测试用例已覆盖）。另：全量首跑 export-markdown 动态 import 用例 5000ms 超时（136 worker 并发冷启动资源竞争），单跑/重跑均全绿，属既有 flaky 非本批回归。
- **决策记录**：不做分类/标签/排序字段（列表按更新时间+搜索框）；不做导入导出/云同步；插入不自动发送（用户可再编辑）；删除用行内二次确认而非全局 ConfirmDialog（弹层内交互保持轻）；片段内容只进 textarea 文本值无 XSS 面。

### V4-Iter-19 全局快捷键体系（已落地）

- **范围**：候选「全局快捷键体系」调研校准——并非从零开始：Agent 面板早有独立 useAgentShortcuts（Ctrl+N/K/`/`、Esc），App 内联 Ctrl+L 锁屏，但 Chat 侧零快捷键、无标签级快捷键；且 **V4-Iter-16 保活后隐藏模块的 window 监听仍存活，在 Chat 按 Ctrl+N 会误触发 Agent 静默新建会话**；主进程菜单 role:'close' 默认占用 CmdOrCtrl+W 会关整窗。本批统一收口为渲染端单中枢并补齐标签快捷键。
- **方案**：
  - 新建纯函数模块 `src/renderer/src/utils/shortcuts.ts`：`matchAppShortcut(e,{running})`——Ctrl/⌘ 等价、Alt 组合一律排除、Shift 组合排除；Ctrl+1~9 切标签（带 tabIndex 1-9）、+W 关标签、+, 设置、+L 锁屏、+N 新建、+K 搜索、+/ 聚焦输入框；Esc 无修饰+非编辑态焦点+running 才 abort；`isEditableTarget` 鸭子类型（INPUT/TEXTAREA/SELECT/contentEditable，纯 node 可测）；`modLabel()` Mac 显示 ⌘ 其余 Ctrl。
  - 新建 `src/renderer/src/hooks/useGlobalShortcuts.ts`（App 挂载一次）：标签/窗口类直接操作 store（setActiveTabId/closeTab/switchModule）与 lock IPC；会话类（newConv/focusSearch/focusComposer/abort）仅当 activeModule∈{chat,agent} 时 `window.dispatchEvent(CustomEvent('pai:app-shortcut'))` 派发；busyModules 判定 running；锁屏期间全屏蔽。导出 isActiveModuleInstance 活动实例守卫。
  - 活动标记：Workspace 活动模块容器加 `data-active-module="<id>"`（非活动 display:none 无此属性）；ChatModule/AgentPanel 监听事件先查该属性——彻底修掉保活隐藏实例与同模块多标签误触。
  - Chat 侧补齐（原来没有）：Composer textarea 加 data-chat-composer-input、ConversationList 搜索框加 data-chat-search-input；ChatModule 监听 newConv→handleNewConv、focusSearch→rAF 聚焦侧栏搜索、focusComposer→聚焦输入框、abort→stream abort（ref 存最新回调，监听只挂一次）。
  - Agent 侧收口：AgentPanel 删除 useAgentShortcuts 调用，改监听同一事件（focusSearch 保持「无消息不可用、打开消息搜索栏并聚焦」旧语义）；删除 useAgentShortcuts.ts 与 agent-shared.ts 的 matchAgentShortcut/AgentShortcutId/ShortcutKeyEvent；旧测试 tests/agent-shortcuts.test.ts 同步删除。
  - App.tsx 删内联 Ctrl+L effect（收口进中枢）；**menu.ts 两处 role:'close'（Mac 文件菜单/Win 窗口菜单）改为无 accelerator 的 click 关闭项，解除 CmdOrCtrl+W 默认绑定让给关标签**（鼠标点菜单仍可关窗；VS Code 同款约定）。
  - 设置页新增「键盘快捷键」只读速查小节（8 行 动作/kbd 按键表，按平台显示 ⌘/Ctrl），i18n 10 key 中英日韩四语。
  - 测试：新建 tests/shortcuts.test.ts 20 用例（各组合命中/Cmd 等价/大小写/Alt 与 Shift 排除/数字序号与 0/未知键/编辑态内修饰键仍接管/Esc 四态/isEditableTarget 六类）。
- **踩坑**：删除 matchAgentShortcut 后 typecheck 抓出已存在的 tests/agent-shortcuts.test.ts（初版调研未发现该测试文件），其用例被新测试完全覆盖，整文件删除；文件数 135 不变、用例 1956→1963（删旧 ~13 加新 20，净 +7）。
- **决策记录**：不用主进程 globalShortcut（系统级、失焦也响应，属快捷浮窗的场景），全部应用内快捷键走渲染端；不做自定义录制（设置里浮窗 hotkey 录制是另一独立功能）；Esc abort 在输入框聚焦时不抢（留给控件/弹层自身 Esc）；popup 独立小窗不挂中枢；Ctrl+N 仅 chat/agent 活动时生效，其他模块不响应。

### V4-Iter-18 会话置顶与归档（已落地）

- **范围**：会话表原先固定 `ORDER BY updated_at DESC`，无置顶/隐藏机制。本批给会话组织补两个轻能力：重要会话置顶、完结会话归档（不删除、可找回）。Chat 与 Agent 两侧同构。
- **方案**：
  - DB migration **v30 conv_pin_archive**（追加不改历史）：conversations 加 `pinned INTEGER DEFAULT 0`、`archived INTEGER DEFAULT 0`、`archived_at INTEGER`；ConversationRecord 加 pinned/archived/archivedAt。
  - conversation.repo：ConversationRow 加三列，rowToRecord 映射 0/1→boolean（旧行缺列 undefined 安全默认 false/null）；抽**纯函数 `buildConvListQuery({assistantId,isAgent,archivedOnly})`** 返回 where/vals/orderBy（WHERE 恒定含 archived=0/1，排序活跃 `pinned DESC, updated_at DESC`、归档 `pinned DESC, archived_at DESC, updated_at DESC`）；list 加第三参 `{archivedOnly}`；新增 setPinned/setArchived（取消归档不清 pinned，恢复后保持置顶）；**touch 追加 `archived=0, archived_at=NULL`——归档会话重新收到消息自动回主列表**。
  - IPC：CONVERSATION_LIST 第三参 archivedOnly（zod tuple 扩位）；新增 CONVERSATION_SET_PINNED / CONVERSATION_SET_ARCHIVED（safeHandle + idSchema+z.boolean()）；preload listConversations 第三参 + setConversationPinned/setConversationArchived。
  - UI 两侧：列表底部加「📦 已归档 (N)」折叠分区（▶/▼，N=0 不渲染，搜索态不显示）；ConvItem/SessionItem 标题前 📍 标记；**新增 ⋯ 更多菜单（复用 Iter-17 的 ExportMenu 通用弹层）承载置顶/取消置顶（归档区不显示此项）、归档/取消归档、重命名**，原独立 ✎ 按钮移入菜单（双击重命名保留），删除仍独立红色 × 不进菜单；最终行内操作 ⋯ ↓ 🔐 × 共 4 个缓解拥挤。
  - 数据流：ChatModule 与 useAgentChat 均增加 archivedConversations state，reload/初始加载改 Promise.all 并行拉活跃+归档；删除/重命名同步两列表；Agent selectConversation 的模型回填查找范围扩到归档列表（归档区点开的会话也能恢复模型）。归档动作给 info toast 提示找回路径；归档仅列表层隐藏，不切换当前视图。
  - i18n 新增 7 key（more/pin/unpin/archive/unarchive/archivedSection{n}/archivedHint）中英日韩四语。
  - 测试：conversation-repo.test.ts 追加 4 用例（新字段旧行默认与 0/1 映射、buildConvListQuery 活跃/归档/asst-default/普通助手/agent 组合与 vals 顺序、两种 ORDER BY）；channel-service.test.ts 两处手工构造的 ConversationRecord 补 pinned/archived/archivedAt。
- **踩坑**：ConversationRecord 加必填字段后，除 repo rowToRecord 外只有 channel-service.test.ts 两处 mock 记录直接实现该接口，typecheck 立即抓出并补齐；业务代码无裸构造点。
- **决策记录**：不做置顶组内拖拽手排（组内按更新时间，拖拽是标签页能力）；不做自动归档规则；不做归档独立页面（底部折叠区）；加密/批量导出范围仍为活跃列表；归档会话仍可被全文搜索命中并打开（归档≠删除），发新消息自动解除归档。

### V4-Iter-17 对话导出增强（保真 MD + 自包含 HTML + 批量导出，已落地）

- **范围**：候选「对话导出 MD/HTML」调研校准——单会话 Markdown 导出与加密 .moxia 导出早已存在（Chat/Agent 两侧均有入口），但旧 MD 导出把每条消息正文 `escapeMdCodeBlock` 整体包成代码块（AI 回复的标题/列表/表格/代码块格式全丢），且不含 RAG 来源/附件/token；HTML 与批量导出不存在。本批重做导出质量并补两种新出口。
- **方案**：
  - 新建 `src/shared/export-markdown.ts` 纯函数模块（主进程/渲染端/测试共用）：`buildConversationMarkdown(conv,messages,assistantName?)`——assistant 正文保真原样输出、user 正文逐行 `> ` 引用块包裹（区分角色+防内容伪造文档标题/分隔符）、sources 去重（按 docTitle）输出「参考来源」列表（不入 content 片段降噪）、image 附件只列名（base64 绝不入文件）/text 附件附 2000 字截断预览、usage 斜体 token 行、toolCalls 块保留；`safeFileName`（Windows 非法字符替换，全非法/只剩下划线兜底 conversation，顺手替换加密导出的内联正则）、`dedupeFileNames`（重名 -2/-3 序号，扩展名分离）、formatSources/formatAttachments/roleLabel 导出直测。conversations.ts 删除旧 renderConversationToMarkdown/escapeMdCodeBlock/roleLabel 三个本地函数，EXPORT_MD handler 改调 shared builder 并注入 assistant 名。
  - HTML 导出：新建 `src/renderer/src/utils/export-html.tsx`，`buildConversationHtml` 用 react-dom/server renderToStaticMarkup 渲染完整文档（**动态 import 拆 105KB 独立 chunk，仅导出时加载，主包 1183→1079KB 未回退 V4-Iter-12 瘦身成果**）；内联浅色固定排版 CSS（820px 卡片、代码块/表格/引用条/来源小号字，对 .markdown-body 原生标签收口，tailwind class/CSS 变量脱离应用后失效由内联样式覆盖）；user 消息蓝条气泡、附件/工具调用/来源/token 分区。XSS 防线：复用应用 Markdown 组件（未挂 rehype-raw，裸 HTML/script 在 remark 解析层即过滤）+ React 转义 + 测试注入 `<script>alert(1)</script>` 卡死。
  - 主进程新增 `CONVERSATION_EXPORT_HTML`（渲染端生成内容，主进程只 dialog 选 .html 路径+写盘，html 参数 zod 限 50MB）与 `CONVERSATION_EXPORT_BATCH`（files[{name,content}]，showOpenDialog openDirectory+createDirectory 选目录，dedupeFileNames 统一去重，逐文件写失败不中断计入 failed，zod 校验 name≤200/content≤50MB/数量 1–500）；preload 两个新桥接。
  - UI：ConversationList 抽出可复用 ExportMenu 组件（fixed 风格 absolute 弹层、点外部/Esc 关闭、点击阻止冒泡防穿透会话行，Chat ConvItem 与 Agent SessionItem 共用）；会话项 ↓ 从直接导 MD 改为「Markdown/网页」菜单，🔐 加密按钮保留独立；工具栏加 📤 批量导出菜单（全部 MD/全部 HTML）。ChatModule 单 HTML 导出（listMessages+assistants 查名）+ 当前助手批量（串行 listMessages、每 10 个让出一帧防同步渲染卡 UI、batchBusyRef 防重入、完成 toast 含目录与失败数）；AgentPanel 同构（范围=chat.conversations 当前列表）。
  - i18n 新增 9 key（exportMenu/exportMd/exportHtml/exportBatch/exportBatchMd/exportBatchHtml/exportBatchDone{ n,dir }/exportBatchEmpty/exportBatchFailed）中英日韩四语。
  - 新增 tests/export-markdown.test.ts 11 用例（保真渲染/引用块结构防护/元信息、来源去重与来源块、图片不泄 base64/文本截断、usage、safeFileName 兜底、dedupe 序号、HTML 文档结构+script 注入过滤）。
- **踩坑**：① react-dom/server 静态 import 直接把主包顶到 1183KB（+122KB），改动态 import 后独立 105KB chunk；② safeFileName 初版 `///`→`___` 非空不兜底，测试抓出后加「只剩下划线视为空」；③ AgentPanel 比 ChatModule 深一层目录，shared 相对路径要 5 个 `../`；④ node 测试环境跑 renderToStaticMarkup 无需 jsdom（react-dom/server 纯字符串输出），MermaidBlock/rehype 管线在 node 下可正常 import。
- **决策记录**：不做会话多选 UI（批量=当前助手全部，逐选留后续）；不做 PDF（打印引擎打包重）；不内嵌图片 base64；katex/mermaid 懒加载未就绪时导出保留源码文本（已知限制）；批量上限 500、单文件内容上限 50MB。

### V4-Iter-16 标签保活与 LRU 休眠（已落地）

- **范围**：落实产品策划书 4.2 标签状态机 `active → pinned → dormant → closed` 的保活/休眠段。调研校准：拖拽排序（TabBar HTML5 DnD + reorderTabs）与 popOut 早已实现；pinned 字段/视觉/豁免逻辑已有但**无固定入口**（半成品）；切走模块直接卸载（Workspace 只挂活动模块），会话状态/滚动位置/输入草稿全丢——连保活期都没有。
- **方案**：
  - app-store 新增会话态（不持久化）`mountedModules: ModuleId[]`（LRU，头部最近访问）+ `busyModules`；导出纯函数 `evictMounted(mounted,{activeId,pinnedIds,busyIds,max})`（尾部淘汰、保护集豁免、busy 占名额不淘汰）/ `pinFirst`（从 reorderTabs 抽出复用）/ `reconcileMounted`（关标签后移除孤儿挂载）；常量 `MAX_KEPT_MODULES=4`。actions：`touchModule`（激活更新 LRU+淘汰）、`setModuleBusy`（busy 解除补淘汰）、`togglePin`（置反+前置）；closeTab/closeOthers/closeRight 同步 activeModule（顺手修关闭活动标签后侧栏高亮不同步）与 mountedModules 收敛；persist merge 重启后仅挂载活动模块。
  - Workspace 重构：if 链抽成 `ModuleBody` 映射（chat 直出 + 其余 lazy/Suspense 外壳不变）；为 mountedModules 每个模块渲染容器，非活动 `display:none`（state/滚动/草稿保留），活动 `flex-1 min-h-0 flex flex-col`；防御性保证 activeModule 必在挂载集合（兼容 detached 独立窗口）。
  - App.tsx：activeModule 变化 effect 调 touchModule；TabBar 接 onTogglePin；Workspace props 改 activeModule；DetachedApp 同步。
  - busy 上报：ChatModule `liveColumns!==null`、AgentPanel `chat.running` 经 `useAppStore.getState().setModuleBusy` 上报——流式中模块豁免休眠；重挂自动重报。
  - TabBar 右键菜单加「固定标签/取消固定」（按 tab.pinned 切文案，置顶于 popOut 之上）；i18n tab.pin/tab.unpin 四语。
  - 新增 tests/app-store.test.ts 11 用例（evict/pinFirst/reconcile 纯函数 5 + LRU/超阈值/pinned 豁免/busy 豁免与解除补淘/closeTab 收敛 5 + persist merge 1）。
- **踩坑**：zustand v5 默认 storage factory 是 `() => window.localStorage`（非裸 localStorage），node 测试环境无 window → createJSONStorage 返回 undefined → middleware.mjs `if (!storage) return config(...)` 整体短路（store 正常但无 hydrate/api.persist/merge）；测试需同时 stub `globalThis.window = globalThis`。
- **决策记录**：不做「标签绑定独立会话」（ChatModule 多实例化牵动全部模块 state 归属）、不做休眠缩略图、MAX_KEPT 固定 4 不可配；知识库 pending 轮询自限自停不上报 busy。

### V4-Iter-15 会话搜索增强（已落地）

- **范围**：补齐会话搜索的三个关键短板——跳转定位+临时高亮、日期范围筛选、加载更多分页。
- **方案**：
  - 后端 messages.ts MESSAGE_SEARCH handler 加 `dateRange?({from?,to?})` + `offset?` 参数，FTS5/LIKE 两路径同步加 `m.created_at >= ? AND <= ?` + `LIMIT ? OFFSET ?`，zod schema 校验。
  - preload searchMessages 签名扩展为 `(query, assistantId?, dateRange?, offset?)`。
  - MessageSearchResults 组件加 `hasMore/loadingMore/onSelectMessage/onLoadMore` props；消息行点击改 `onSelectMessage(convId, messageId)`（会话标题仍 onSelectConv）；底部「加载更多」按钮（结果数=PAGE=50 时显示）。
  - ConversationList 加日期筛选 chips（全部/近 7 天/近 30 天/自定义 `<input type="date">`）+ offset 累计 + 加载更多；`onSelectMessage` prop 透传。
  - SessionRail 同步适配（onSelectMessage optional，加载更多）。
  - ChatView 加 `focusMessageId` prop + `highlightMsgId` state；useEffect 在 messages+renderedTurns 就绪后 findIndex 定位 turn → `virtualizer.scrollToIndex(idx, { align: 'center' })` + 2s 临时高亮（warning ring + animate-pulse）；MessageBubble 加 `highlight` prop。
  - ChatModule 加 `focusMessageId` state + `handleSelectMessage` 回调（切会话+设 focusMessageId），透传 ConversationList/ChatView。
  - i18n 四语 6 key（searchDateAll/7d/30d/Custom + searchLoadMore/searchLoading）。
- **决策记录**：Agent 侧 SessionRail 的 onSelectMessage 为 optional（fallback onSelectConv），Agent 消息渲染层不传则保持原有跳转行为不退化；不做搜索排序选项/搜索历史/正则语法搜索。

### V4-Iter-14 KB 数据健康（已落地）

- **范围**：知识库运维能力——完整性探测与修复。调研发现真实泄漏 bug：KB_DOC_DELETE 只删 kb_documents 行，chunks 靠 FK 级联，但 kb_vec_map/vec 表无 FK 无人清理，删单个文档必在 vectors.db 留孤儿向量（只有整库删除才清理）。
- **方案**：新增 `src/main/knowledge/kb-health.ts`——纯函数 findDuplicateGroups（按 kb_id+content_hash 分组、组内创建时间升序最早在前）/collectProviderIssues（embedding/rerank/hyde/multiquery/ocr 五引用 × missing/disabled/model-missing，provider 模型列表为空不做包含性校验防误报）单独导出直测；getKbIntegrityReport 只读探测（kb_vec_map LEFT JOIN kb_chunks 孤儿向量计数、孤儿 chunk 防御探测、缺向量 doc 仅 vec 启用时探测、length(embedding)!=embedding_dim*4 维度不匹配，逐项容错）；修复动作 cleanOrphans（复用 kbVecRepo.deleteByChunk/deleteByDoc + 收尾 SQL）/reindexDocs（pending + indexQueue reindex，复用 KB_DOC_REINDEX 同款链路）/deduplicate（同库同 hash 其余删除）；泄漏修复收口 kbDocRepo.delete() 先 kbChunkRepo.deleteByDoc（内部已清向量）再删文档行，KB_DOC_DELETE 与去重动作全部堵漏；DataHealthReport.kb 加 integrity 结构，data-health 探测整体容错并入；IPC DATA_HEALTH_KB_CLEAN/KB_DEDUP/KB_REINDEX 挂 steward.ts（zod idSchema 校验）；preload cleanKbOrphans/deduplicateKbDocs/reindexKbDocs；DataHealthPanel 新增「知识库完整性」区块（孤儿 Row+清理按钮、brokenDocs 表+一键重建索引、重复组行+保留最早删其余（confirm 确认）、providerIssues 表；runAction 统一 busy 防重/成功 toast/自动刷新）；dh.integrity.* 27 key 中英日韩四语。
- **决策记录**：去重仅「保留最早删其余」不做逐篇挑选 UI；provider 失效校验覆盖全部五类引用而非仅 embedding；探测并入 DataHealthReport 一次拉取，修复动作为独立写通道。

### V4-Iter-3 数据健康度仪表（已落地）

- **范围**：数据资产日常快照（体量明细 / 知识库索引状态 / 备份与维护任务运行情况），与平台管家（安全审计+故障诊断，手动触发带评分）分工互补：管家管「安不安全、坏没坏」，本面板管「数据长什么样、维护任务跑没跑」。
- **方案**：新增 `src/main/steward/data-health.ts` 聚合只读探测；IPC DATA_HEALTH_GET 挂 steward handlers；preload getDataHealth；Settings 新增「数据健康」section（UsagePanel 之后）。

### V4-Iter-4 知识库引用编号进正文（已落地）

- **范围**：知识库增强第一批——LLM 回答正文输出 [1][2] 引用标记，与消息来源块一一对应，可信度可视化。
- **方案**：rag.buildContext 注入编号引用指令（引用句末标 [n]、不编造）；新增 remark-citations 插件把正文 [n]（1~2 位）拆为引用节点，Markdown.tsx 渲染为可点击徽章（仅 citationCount>0 时启用，PopupApp/对比列零行为变化）；MessageBubble 点击徽章展开来源块并滚动定位，来源条目加 [n] 徽章与锚点。Agent 链路纯文本正文与来源块编号天然对应，无需改动。

### V4-Iter-5 知识库 Multi-Query 多查询检索（已落地）

- **范围**：知识库增强第二批——LLM 把用户问题改写成 3-4 个不同视角变体查询，各自双路检索后与原查询 RRF 融合，提升单一措辞的召回质量。与 HyDE（向量路改写）可叠加。
- **方案**：migration v26 knowledge_bases 加 multiquery_provider_id/multiquery_model（空=关闭）；新增 `src/main/knowledge/multi-query.ts`（parseMultiQueries 纯函数：按行切分/去序号前缀/去重/限量 4 条/超长丢弃；generateMultiQueries 失败返回 null 降级）；rag.retrieve 中原 query（向量路可用 HyDE 文本）+ 变体查询循环执行向量+BM25 双路，统一 RRF 融合；KbForm 新增「多查询」配置区块（复制 HyDE 模式）+ kb.multiQuery* 四语 key。

### V4-Iter-6 知识库文件夹批量导入（已落地）

- **范围**：知识库增强第三批——选择文件夹递归扫描，按扩展名过滤批量入队，小白用户整理资料目录一次导入。
- **方案**：新增 `src/main/knowledge/folder-scan.ts` 递归扫描（跳过隐藏目录/文件、node_modules 等常见大目录、符号链接防循环；扩展名白名单与文件对话框对齐；单文件 50MB、单次 500 个硬上限）；IPC KB_DOC_ADD_FOLDER（dialog.openDirectory → scanFolderFiles → 批量 insert + 入队，返回 docs/skippedCount/truncated）；preload addKbFolder；KbDetail 文档区新增「导入文件夹」按钮，无命中 toast 提示、达上限 toast 提示分批导入。

### V4-Iter-7 内置本地 embedding（已落地）

- **范围**：知识库增强第四批——随包内置本地向量模型（transformers.js + bge-small-zh-v1.5 int8，约 23MB），离线开箱即用，便携定位核心短板补齐。
- **方案**：`scripts/fetch-embedding-model.mjs` 构建时下载模型进 resources/models（hf-mirror 优先 + 官方回退，幂等 + 大小校验），extraResources 打包；`src/main/knowledge/local-embedding.ts` 懒加载单例强制本地推理不出网；embedding.ts 按 providerId='builtin' 分派（查询侧自动加 bge 指令前缀，幂等）；KbForm Provider 下拉加「内置本地模型」选项；KB 配置仍可随时换远程 API 并重索引。

### V4-Iter-8 KB 问答模式（已落地）

- **范围**：知识库增强第五批——NotebookLM 式「选库即聊」：知识库详情页内直接问答，自动检索拼上下文 + 流式回答 + 编号引用来源，去掉「先建助手再绑库」门槛。轻量实现：对话不落库（内存态随页面），与 ChatService conversation 链路解耦。
- **方案**：新增 `src/main/knowledge/ask-service.ts`（kbAskService：检索 → buildContext → adapter.streamChat，AbortController per requestId，abort 保留 partial 按 done 收尾；buildAskMessages/chunksToSources 纯函数导出）；独立事件通道 KB_ASK_CHUNK/DONE/ERROR_EVENT（preload onKbAskChunk/onKbAskDone/onKbAskError）；KbDetail 加「文档/问答」chip tab（hidden 保挂载，切 tab 问答不丢）；KbAskPanel 组件（provider/model 下拉记忆 localStorage + 流式气泡 + Markdown citationCount 引用点击滚动定位 + Enter 发送/Shift+Enter 换行/停止按钮 + 自动滚底）。

### V4-Iter-9 文档增量同步（已落地）

- **范围**：知识库增强第六批——file 文档入库时记录内容 sha256，「检查更新」按钮对比磁盘当前内容，变更文档一键重索引、源文件丢失文档一键移除，避免检索结果与源文件脱节。
- **方案**：migration v27 kb_documents 加 content_hash 列；ingestion.ingestDocument 尝试 hashFile（仅本地文件可算出，URL/手工文本/丢失文件失败写 null，天然不参与检测——修复了手工录入与 file 来源无法区分的语义缺陷）；`src/main/knowledge/sync-check.ts`（hashFile 流式 sha256 / classifyFileDoc 纯函数 / checkKbFileUpdates 只检测 hash 非 null 文档）；IPC KB_SYNC_CHECK + preload checkKbUpdates；KbDetail 工具栏「检查更新」按钮（无变更 toast、有变更确认弹窗列变更/丢失数量，danger 标注丢失，确认后批量重索引+移除）。

### V4-Iter-10 文档级检索开关（已落地）

- **范围**：知识库增强第七批（收尾）——元数据过滤核心项：文档级临时开关，停用后排除出检索范围（不删除、不重索引），适合过时资料暂时下线场景。范围收缩：检索测试面板按 docIds 多选过滤价值低，不做。
- **方案**：migration v28 kb_documents 加 enabled INTEGER NOT NULL DEFAULT 1；三条检索路径 SQL 层过滤 doc_id NOT IN (SELECT id FROM kb_documents WHERE enabled=0)：kbVecRepo.search（vec0 KNN 子查询 3 倍超额取样防 JOIN 过滤后不足 topK）、kbChunkRepo fallback 余弦全表扫描、bm25Search FTS5；kb-doc.repo setEnabled + KbDocument.enabled；IPC KB_DOC_SET_ENABLED + preload setKbDocEnabled；KbDetail 文档行首 checkbox 开关（停用行 opacity-60，title/aria-label 提示语义）；KB 问答/聊天/检索测试全链路自动继承。

### V4-Iter-11 来源跳转原文（已落地）

- **范围**：点击消息引用来源块条目的「↗」按钮 → 自动切到知识库模块 → 打开所属库与文档的分块预览 → 滚动定位到对应分块并高亮闪烁。衔接 V4-Iter-4 引用编号体系，补齐溯源最后一跳。
- **方案**：RetrievedChunk 加 kbId/seq 必填字段、MessageSource 加 kbId?/seq? 可选字段（旧 sources JSON 无新字段不可跳转，UI 自动隐藏按钮）；kbVecRepo.search/knnSearch/fallback/bm25Search 三条检索路径 SELECT 与映射补 kb_id/sequence（bm25 JOIN kb_chunks 取 sequence）；chat-service 落库映射与 ask-service chunksToSources 同步补字段；新增 `src/renderer/src/modules/knowledge/source-jump.ts`（requestSourceJump 写 sessionStorage pending + 复用 App 既有 'pocketai:switch-module' 事件切模块 + 广播 kb-open-source；consumePendingSourceJump 读后即清）；KnowledgeModule 挂载时消费 pending + 常驻监听事件 → setSelectedId + jumpFocus 下传；KbDetail 消费 jumpFocus（docs 加载到目标文档后开分块预览、问答 tab 自动切回，文档不存在悬空不消费）；ChunkPreview 加 focusSeq 定位滚动 + 1.8s 高亮闪烁。

---

## 三、变更记录

| 日期 | 批次 | 内容 | 验证 |
|------|------|------|------|
| 2026-09-29 | V4-Iter-1 | 用量统计仪表盘（token 用量，不含费用估算）：migration v25 `messages_usage`（messages 加 usage JSON 列 + created_at 索引）；chat-service runTarget 与 agent engine 生成完成时把 provider 已解析的 result.usage 随 updateContent 落库（此前被丢弃，abort/error 分支无 usage 不记录）；新增 `src/main/usage/usage-service.ts`——getSummary(days) 按最近 N 天聚合（JS 侧 reduce，坏 JSON 容错，本地时区切日，daily 补零填充，范围外行整体跳过保证口径一致，byModel Top10），parseUsageJson/localDateKey/aggregateUsage 纯函数导出；IPC USAGE_GET（argsSchema days 1-365 可选）挂在 messages.ts handlers，preload 暴露 getUsageSummary；Settings 新增「用量」section（UsagePanel.tsx，ProviderSettings 之后挂载）：7/30/90 天范围切换 + 4 汇总卡片（生成次数/总/输入/输出 token，缓存命中提示行）+ 按日纯 CSS 柱状图（hover title 显示日期与数量）+ Provider 排行条 + 模型 Top10 表 + EmptyState；i18n 新增 set.usage 与 usage.* 17 key 中英日韩四语对齐 | typecheck 0 / vitest 122文件1858用例 / build 三端 |
| 2026-09-29 | V4-Iter-3 | 数据健康度仪表（数据资产日常快照，与平台管家安全审计/故障诊断分工互补）：新增 `src/main/steward/data-health.ts`——getDataHealthReport() 四组只读探测（单项容错不互相阻断）：① 体量 walkDataDir 全目录递归一次、classifyDataEntry/aggregateDataSizes 按桶分类（app.db+WAL/vectors.db+WAL/attachments/extensions/logs/other，dataDirBytes 全量合计）；② 知识库索引状态 groupDocStatus 五状态计数 + topErrorDocs 失败文档 Top10（创建时间倒序，kbRepo 名映射注入，title 空回退 source）；③ WebDAV 备份状态（loadWebDAVConfig configured + getBackupSchedule enabled/interval/lastOkAt/lastError）；④ 内置维护任务 kb_health_check/backup_verify 上次运行时间（app_config task.*.last_run_at）。纯函数导出供直测；IPC DATA_HEALTH_GET 挂 steward.ts handlers，preload getDataHealth；Settings 新增「数据健康」section（DataHealthPanel.tsx，UsagePanel 之后）：4 体积汇总卡片 + 扩展/日志/其他占比条明细 + KB 状态 chips（复用 kb.st.* 四语 key，error>0 标红）+ 失败文档表（标题/所属库/原因/日期）+ 备份状态与维护任务运行时间行 + 刷新按钮；i18n 新增 set.dataHealth 与 dh.* 25 key 中英日韩四语对齐 | typecheck 0 / vitest 123文件1868用例 / build 三端 |
| 2026-09-29 | V4-Iter-4 | 知识库引用编号进正文（RAG 引用溯源可视化，知识库增强第一批）：rag.buildContext 头部注入编号引用指令（「依据知识库内容回答、引用句末标 [n]、库中没有的不编造」），[n] 编号与 sources 数组顺序一一对应；新增 `src/renderer/src/modules/chat/remark-citations.ts`——splitCitationText 把文本中 [n]（1~2 位数字，防 [1000] 误拆）切分为 text/citation 交替序列（citation 节点 data.hName=sup + hProperties.data-citation），remarkCitations 遍历 mdast text 节点 splice 替换并返回 [SKIP, index+len] 防重扫死循环，代码块/行内代码/链接文字/脚注天然不误拆；Markdown.tsx 加可选 citationCount/onCitation props——citationCount>0 才启用插件（PopupApp/ComparisonColumns 未传零行为变化），components.sup 拦截 data-citation 渲染徽章：编号在 [1, citationCount] 内为 accent 可点 button、越界为 muted 不可点 span（防 LLM 幻觉编号误导）；MessageBubble 传 sources.length 与 handleCitation（展开来源块 + requestAnimationFrame 后 scrollIntoView 定位 `kb-source-{messageId}-{n}` 锚点，scroll-mt-2），来源条目编号由「1.」改为 [1] 徽章样式与正文对应；Agent 链路（engine.ts 同用 ragService.buildContext）纯文本正文的 [n] 与来源折叠块编号天然对应无需改动；kb_search 工具结果无编号指令不产生混淆。新增 tests/remark-citations.test.ts 8 用例（splitCitationText 边界/mdast 变换/代码块与链接不误拆/多段落列表拆分），rag.test.ts buildContext 断言更新为引用指令版本 | typecheck 0 / vitest 124文件1876用例 / build 三端 |
| 2026-09-29 | V4-Iter-5 | 知识库 Multi-Query 多查询检索（RAG 召回增强，知识库增强第二批）：migration v26 `kb_multiquery`——knowledge_bases 加 multiquery_provider_id/multiquery_model TEXT 列（空=关闭）；新增 `src/main/knowledge/multi-query.ts`——MULTI_QUERY_SYSTEM_PROMPT 要求 LLM 输出 3-4 行不同视角等价查询（同义词/相关术语/上下位概念，保持原语言），parseMultiQueries 纯函数解析（按行切分→去行首「1./1、1)/-/*」序号前缀→trim 去空→单条超 MAX_VARIANT_CHARS=200 丢弃→去重→限量 MAX_MULTI_QUERIES=4），generateMultiQueries 失败/无 adapter/解析为空返回 null 由调用方降级；rag.retrieve 集成——与 hyde/rerank 同模式取第一个配置了 multiQuery 的 KB，queryVariants = [原 query（useHyde=true，向量路可用 HyDE 假设文档 embedding）, ...变体（useHyde=false）]，每 KB 内循环执行向量+BM25 双路收集后统一 rrfFuse 融合，rerank/MMR/标题填充链路不变；shared/types KnowledgeBase 加 multiQueryProviderId/multiQueryModel，kb.repo KbRow/rowToRecord/save UPDATE+INSERT 补列，kbSaveSchema 补 nullable 字段；KbForm 新增「多查询」配置区块（复制 HyDE 区块模式：Provider select 空值=禁用 + 模型 select/手输）；i18n 新增 kb.multiQueryHint/multiQueryProvider/multiQueryModel/multiQueryDisabled 四语（中英日韩）对齐；新增 tests/multi-query.test.ts 7 用例（parseMultiQueries 切分/序号前缀/去重/限量/超长丢弃/空与 null 容错），kb-repo.test.ts 与 knowledge-ingestion.test.ts fixture 补新字段 | typecheck 0 / vitest 125文件1883用例 / build 三端 |
| 2026-09-29 | V4-Iter-6 | 知识库文件夹批量导入（小白资料目录一次导入，知识库增强第三批）：新增 `src/main/knowledge/folder-scan.ts`——scanFolderFiles 同步递归扫描（KB_IMPORT_EXTS 扩展名白名单与 KB_DOC_ADD_FILE 对话框 filters 对齐：pdf/docx/xlsx/xls/html/htm/txt/md/markdown/csv/json；跳过 . 开头隐藏目录/文件、node_modules/__pycache__/target/dist/out 显式黑名单、符号链接防循环；单文件 KB_MAX_FILE_BYTES=50MB、单次 KB_MAX_FILES_PER_IMPORT=500 硬上限，超限标记 truncated；readdirSync/statSync 失败静默跳过不阻断；导出 FolderScanResult{files,skippedCount,truncated} 供直测）；shared/types IPC 常量 KB_DOC_ADD_FOLDER='kb-doc:add-folder'；knowledge.ts handlers 新增 handler（dialog.openDirectory → scanFolderFiles → kbDocRepo.insert 批量建文档（sourceType=detectSourceType）→ indexQueue 逐个入队即返，与单文件导入同构，前端 2s 轮询状态）+ argsSchema(idSchema)；preload addKbFolder 返回 {docs,skippedCount,truncated}；KnowledgeModule KbDetail 文档工具栏在「上传文件」后新增「导入文件夹」btn-ghost 按钮（busy 复用）——r.docs 为空 toast.warning kb.folderNoMatch、truncated toast.warning kb.folderTruncated({n})，随后 refresh+startPolling；i18n 新增 kb.importFolder/folderNoMatch/folderTruncated 中英日韩四语对齐；新增 tests/folder-scan.test.ts 7 用例（tmpdir 真实目录：扩展名过滤与 skipped 计数/递归+隐藏与 node_modules 排除/大小写不敏感/上限常量/不存在目录静默空结果） | typecheck 0 / vitest 126文件1890用例 / build 三端 |
| 2026-09-29 | V4-Iter-7 | 内置本地 embedding（离线开箱即用，知识库增强第四批，便携定位核心短板补齐）：依赖新增 @huggingface/transformers@4.3.0（dependencies，含 onnxruntime-node 1.30 N-API 二进制，asarUnpack 加 node_modules/onnxruntime-node/**）；新增 `scripts/fetch-embedding-model.mjs`——构建时下载 Xenova/bge-small-zh-v1.5 ONNX int8（config/tokenizer/tokenizer_config/model_quantized.onnx 共约 23.3MB）到 resources/models/（hf-mirror.com 优先 + huggingface.co 官方回退；幂等：已存在且 ≥minBytes 跳过；临时文件 .part 原子改名），dist/dist:portable/dist:nsis/dist:linux 四命令前置执行 + 独立 fetch:model 命令，.gitignore 排除 resources/models/，electron-builder extraResources models→resources；新增 `src/main/knowledge/local-embedding.ts`——懒加载单例（initPromise 失败重置可重试）、env.allowRemoteModels=false 强制本地不出网、模型路径 app.isPackaged ? resourcesPath/models : 项目根 resources/models、dtype q8、pooling cls + normalize、tensorToVectors 统一处理单 [batch,dim] Tensor 与 Tensor 数组两种输出形态（多文本返回扁平 data 需按行切片）、disposeLocalEmbedding 释放；BUILTIN_EMBED_PROVIDER_ID='builtin'/BUILTIN_EMBED_MODEL/BUILTIN_EMBED_DIM=512/BUILTIN_QUERY_PREFIX 常量收敛到 shared/types（renderer 可引用）；embedding.ts embedTexts/embedQuery 按 providerId==='builtin' 拦截分派（查询侧自动加 bge 检索指令前缀 withBuiltinQueryPrefix 幂等），远程 provider 链路不变；KnowledgeModule KbForm Embedding Provider 下拉首位加「内置本地模型（离线，中文优化）」选项，选中后模型字段固定只读展示 BUILTIN_EMBED_MODEL；i18n 新增 kb.builtinProvider 中英日韩四语；新增 tests/embedding.test.ts 5 用例（builtin 分派 localEmbedTexts 不触碰 providerManager/70 条按 32 分桶/非 builtin 走 adapter/embedQuery 分派/前缀幂等）+ tests/local-embedding.smoke.test.ts 3 用例真实推理冒烟（模型存在才跑 describe.skipIf：512 维+L2 归一化 norm≈1/同查询两次调用结果一致/相关句相似度 > 无关句——首跑即发现并修复多文本 Tensor 未按 batch 切片的 bug） | typecheck 0 / vitest 127文件1891用例 / build 三端 |
| 2026-09-29 | V4-Iter-8 | KB 问答模式（NotebookLM 式选库即聊，知识库增强第五批）：新增 `src/main/knowledge/ask-service.ts`——kbAskService.ask(sender, {kbIds, providerId, model, question, history})：invoke 内同步返回 requestId（sources 暂空），异步 ragService.retrieve（复用 V4 全检索链路含 HyDE/MultiQuery/rerank/MMR）→ buildContext → buildAskMessages → providerManager adapter.streamChat（AbortController per requestId 存 Map，abort 保留 accumulated partial 按 done 事件收尾；emit 前 sender.isDestroyed 守卫），chunk/done/error 经独立事件通道 KB_ASK_CHUNK_EVENT/KB_ASK_DONE_EVENT/KB_ASK_ERROR_EVENT 推送，与 ChatService conversation 链路完全解耦（对话不落库，内存态在前端）；buildAskMessages 纯函数（system(知识上下文) + 最近 KB_ASK_MAX_HISTORY=10 条历史过滤空内容 + user 问题）、chunksToSources（RetrievedChunk→MessageSource 同构）；IPC KB_ASK（zod schema：kbIds min1/providerId/model/question max100k/history max50）与 KB_ASK_ABORT 挂 knowledge.ts handlers；preload kbAsk/kbAskAbort + onKbAskChunk/onKbAskDone/onKbAskError（removeListener 清理函数）；KnowledgeModule KbDetail 头部下新增「文档/问答」chip tab 切换（hidden 属性保挂载——切 tab 问答对话不丢；文档管理+检索测试包 hidden={askMode} 容器）；新增 `KbAskPanel.tsx`：provider/model 双下拉（localStorage 记忆 kbask.providerId/kbask.model.*，默认第一个启用 provider 第一个模型小白零配置）+ 消息列表（user 右侧 accent 气泡 / assistant 左侧 Markdown citationCount 编号引用点击 scrollIntoView 定位 kbask-src-{i}-{n} 锚点 + 可折叠来源块复用 MessageBubble 样式）+ 流式中 assistant 气泡（streamText 实时渲染/空时光标脉冲）+ pending 态停止按钮 + Enter 发送/Shift+Enter 换行/isComposing 中文输入法防误发 + 自动滚底 + EmptyState 空态；i18n 新增 kb.docsTab/askTab/askTitle/askHint/askPlaceholder/askSend/askStop/askEmpty/askNoAnswer/askModelRequired 10 key 中英日韩四语对齐；新增 tests/kb-ask.test.ts 5 用例（buildAskMessages 无历史 system+user/有历史顺序/超 10 条截断保留最近/空内容过滤与空上下文无 system/chunksToSources 映射，vi.mock rag+providerManager 隔离 electron 链路） | typecheck 0 / vitest 128文件1896用例 / build 三端 |
| 2026-09-29 | V4-Iter-9 | 文档增量同步（file 文档源文件变更检测，知识库增强第六批）：migration v27 `kb_doc_content_hash`——kb_documents 加 content_hash TEXT 列；新增 `src/main/knowledge/sync-check.ts`——hashFile（createReadStream 流式 sha256，读不到文件 reject 由调用方定语义）、classifyFileDoc 纯函数（stored/current hash 对比 → unchanged/changed/missing，仅处理入库时记录过 hash 的文档）、checkKbFileUpdates(kbId)（过滤 sourceType!=='url' && contentHash!==null 的文档逐个对比，返回 {checked, unchanged, issues[{docId,title,source,kind:'changed'|'missing'}]}）；ingestion.ingestDocument 解析前 try hashFile 写 hash——URL/手工文本/文件丢失时 hashFile reject 写 null 天然不参与检测（设计修正：sourceType 无 'file' 类型且手工录入 txt 与 file 来源 txt 无法区分，改用 hash 非 null 语义圈定检测范围，存量旧文档重索引一次后纳入）；kb-doc.repo KbDocRow/rowToRecord 补 content_hash/contentHash + setContentHash(id, hash|null)；shared/types KbDocument 加 contentHash；IPC KB_SYNC_CHECK='kb:sync-check' 挂 knowledge.ts handlers + argsSchema(idSchema)，preload checkKbUpdates 返回 SyncCheckResult 结构；KnowledgeModule KbDetail 工具栏「录入文本」后新增「检查更新」btn-ghost 按钮 + handleSyncCheck（issues 空 toast.info kb.syncUpToDate({n})；否则 useConfirm 确认弹窗 kb.syncConfirm({n 变更, m 丢失})，missing>0 标 danger；确认后循环 reindexKbDocument（变更）+ deleteKbDocument（丢失）→ refresh + startPolling → toast.success kb.syncDone({n,m})；异常 toast.error，busy 守卫复用）；i18n 新增 kb.checkUpdates/syncUpToDate/syncConfirm/syncDone 中英日韩四语对齐；新增 tests/sync-check.test.ts 6 用例（classifyFileDoc 一致/不同/missing 分类 + hashFile 同内容同 hash 内容变化 hash 变化/文件不存在 reject，electron mock isPackaged+getAppPath 隔离 portable 链路），data-health/kb-doc-repo/knowledge-ingestion 测试 fixture 补 contentHash/content_hash/setContentHash mock | typecheck 0 / vitest 129文件1901用例 / build 三端 |
| 2026-09-29 | V4-Iter-10 | 文档级检索开关（元数据过滤核心项，知识库增强第七批收尾）：migration v28 `kb_doc_enabled`——kb_documents 加 enabled INTEGER NOT NULL DEFAULT 1；三条检索路径 SQL 层统一过滤 `doc_id NOT IN (SELECT id FROM kb_documents WHERE enabled=0)`——kb-vec.repo search（vec0 KNN 子查询 LIMIT 由 topK 改 topK*3 超额取样，JOIN 层过滤停用文档后 slice(0,topK)，防过滤后不足 topK）、kb-chunk.repo fallback 余弦全表扫描、bm25Search FTS5（fts 表 doc_id 列同步过滤）；kb-doc.repo setEnabled(id, enabled) + KbDocRow/rowToRecord 补 enabled；shared/types KbDocument 加 enabled: boolean；IPC KB_DOC_SET_ENABLED（argsSchema(idSchema, idSchema, z.boolean())）挂 knowledge.ts handlers，preload setKbDocEnabled(kbId, docId, enabled)；KnowledgeModule KbDetail 文档行首 checkbox 开关（handleToggleDoc → setKbDocEnabled + refresh；停用行 opacity-60 视觉弱化；title/aria-label 双语提示「参与检索/已排除出检索」语义，WCAG 可访问）；KB 问答/聊天/Agent/检索测试全检索链路自动继承停用语义，过时资料可临时下线不删除不重索引；i18n 新增 kb.docEnabled/docDisabled 中英日韩四语对齐；tests/kb-vec.test.ts 内存库 schema 补 kb_documents 表 + 新增「停用文档向量不参与检索、恢复后回归」真实库用例（5 用例），data-health/kb-doc-repo/knowledge-ingestion fixture 补 enabled 字段 | typecheck 0 / vitest 129文件1902用例 / build 三端 |
| 2026-09-29 | V4-Iter-11 | 来源跳转原文（引用溯源最后一跳，知识库增强第八批）：点击消息来源块条目「↗」→ 自动切知识库模块 → 打开所属库文档分块预览 → 滚动定位对应分块高亮闪烁。数据链路：shared/types RetrievedChunk 加 kbId/seq 必填字段、MessageSource 加 kbId?/seq? 可选字段（旧 sources JSON 无新字段 UI 自动隐藏按钮不报错）；kb-vec.repo search SELECT 加 c.kb_id/c.sequence + 显式返回类型同步；kb-chunk.repo knnSearch hits 映射/fallback（SELECT 加 c.sequence）/bm25Search（JOIN kb_chunks c 取 sequence，fts 表无此列）三条路径补 kbId/seq；chat-service sources 落库映射与 ask-service chunksToSources 同步补字段。导航层：新增 `src/renderer/src/modules/knowledge/source-jump.ts`——requestSourceJump（写 sessionStorage 'kb-pending-source' + dispatch 复用 App 既有 'pocketai:switch-module' {moduleId:'knowledge'} 事件 + 广播 KB_SOURCE_JUMP_EVENT='kb-open-source'）、consumePendingSourceJump（读后即清，坏 JSON/字段缺失容错返回 null）；KnowledgeModule 挂载时消费 pending（App 切模块后未挂载场景兜底）+ 常驻监听 kb-open-source（已挂载即时消费）→ setMode('detail')+setSelectedId+setJumpFocus 下传 KbDetail；KbDetail 消费 jumpFocus effect（docs 加载到目标文档后 setPreviewDoc + setAskMode(false) + onJumpHandled 清空；文档不存在悬空不消费无副作用）；ChunkPreview 加 focusSeq prop——chunks 加载后 getElementById(`kb-chunk-{seq}`) scrollIntoView 居中 + hlSeq 高亮 ring 1.8s 后清除，chunk div 补 id。UI：MessageBubble sources 类型改 MessageSource[] + 来源条目标题行尾「↗」按钮（s.kbId && s.seq!==undefined 才渲染，title/aria-label chatview.viewSource）；KbAskPanel 来源块同样处理（两处复用 requestSourceJump）；i18n 新增 chatview.viewSource 中英日韩四语对齐；新增 tests/source-jump.test.ts 5 用例（requestSourceJump 写 pending+双事件顺序/consume 读后即清与二次消费为空/坏 JSON 与字段缺失容错/无 pending，vi.stubGlobal mock sessionStorage+window），rag/mmr/kb-ask/kb-search-tool 测试 fixture 补 kbId/seq | typecheck 0 / vitest 130文件1906用例 / build 三端 |
| 2026-09-29 | V4-Iter-2 | 启动性能优化（暂缓项重启落地）：① 主窗口创建时序重排——index.ts boot() 中 createMainWindow 从阶段 5（凭据迁移/provider 去重/助手技能同步/initPopup/initChannelRuntime/License 全部同步杂务之后）提前到解锁完成或配置读取后立即执行；依据：IPC handlers 在 boot 开头已注册（惰性闭包，DB 未开也安全）、渲染层数据全部经 IPC 拉取不依赖主进程杂务，窗口 loadFile 异步加载渲染 bundle 与杂务并行，开窗时间从「杂务之和 + 渲染加载」降为「max(杂务, 渲染加载)」（解锁模式用户输入等待本身占大头，杂务并行后不额外叠加）；initUpdateManager 保持窗口创建后（setStatus 依赖 webContents.send），initTray/applyOpacity 随窗口后原位保留。② 启动埋点——模块级 BOOT_T0 = performance.now() + bootMark(stage) 七阶段打点（目录/日志初始化、DB 无密码打开+迁移或加密探测、解锁流程完成含用户输入等待、主窗口已创建、凭据迁移+provider 去重、内置助手/技能同步、浮窗/Channels/License、锁/备份/任务/提醒调度器完成），[perf] 前缀经 boot 标签 logger 写 data/logs，为后续数据健康面板可视化预留 | typecheck 0 / vitest 130文件1906用例 / build 三端 |
| 2026-09-29 | V4-Iter-2 留尾 | 启动耗时可视化（V4-Iter-2 预留项落地）：新增 `src/main/steward/boot-perf.ts`——bootMark(id, label) 双参签名（稳定阶段 id 供渲染层 i18n 映射 + 中文日志名），埋点逻辑自 index.ts 抽出（data-health 需读取，直接 import index.ts 会循环依赖）；BOOT_T0 前移至模块加载时刻（早于 index.ts 模块体执行，更贴近真实冷启动）；内存记录各阶段累计耗时，[perf] 日志打点不变；getBootPerf 返回深拷贝只读快照（stages 数组与元素均拷贝，防外部修改污染内部状态——vitest 副作用用例实测抓住浅拷贝缺陷后修复）；shared/types DataHealthReport 加 boot 字段（stages + totalMs=最后阶段累计毫秒），data-health getDataHealthReport 增加第 5 组只读探测；Settings 数据健康面板「维护任务」之后新增「本次启动耗时」区块：8 阶段占比条时间线（SizeRow 泛化为 BarRow 共用：label + ratio 条 + 右侧等宽值）+ 启动总耗时行与「解锁阶段含用户输入等待」提示；i18n 新增 dh.boot.* 11 key 中英日韩四语对齐；新增 tests/boot-perf.test.ts 3 用例（顺序追加与 ms 非递减/只读副本隔离/totalMs 取最后阶段，mock logger 断 electron） | typecheck 0 / vitest 131文件1909用例 / build 三端 |
| 2026-09-29 | V4-Iter-12 | 渲染 bundle 拆包（首屏主包瘦身，配合 V4-Iter-2 启动优化）：产物分析确认 mermaid 全家桶已是动态 import 按需 chunk、模块级 React.lazy 已落地（Workspace 10 模块），主包 1515KB min 的真实大头 = rehype-katex 静态引入 katex 全量 + i18n 四语全量常驻。① Markdown.tsx katex 两段式懒加载——移除 rehype-katex/katex.min.css 静态 import，模块级 ensureKatex() 动态 import 双资源（Promise 单例 katexPromise 防重复，katexPlugin 模块级缓存），组件挂载 useEffect 触发，ready 前公式以原始 LaTeX 文本渲染、ready 后 setKatexReady 全局一次性重渲染为公式（CSS 与插件同批到达，无无样式中间态；unified PluggableList 类型标注），PopupApp/对比列等复用 Markdown 的场景自动继承。② i18n/index.tsx 按需加载——仅 zh 常驻主包（默认语言 + 兜底字典），langLoaders en/ja/ko 动态 import（命名导出 m.en/m.ja/m.ko），ensureLang Promise 缓存防重复加载；I18nProvider 初始语言非 zh 时 effect 补载、setLang 时预载，未就绪期间 t() 兜底链回退 zh（dicts 改 Partial，本地 chunk 毫秒级几乎无感）；i18n-parity 测试静态 import 四文件不受影响。效果：主包 1515KB→1052KB（-31%），katex 484KB（含 css 29KB+字体 ttf 按需）、en 73KB/ja 92KB/ko 81KB 全部独立按需 chunk，首屏临界链仅剩主包+默认 chat 模块 | typecheck 0 / vitest 130文件1906用例 / build 三端 |
| 2026-09-29 | V4-Iter-13 | 图片 OCR 入知识库（截图/扫描件文字识别检索，知识库增强第九批）：migration v29 `kb_ocr`——knowledge_bases 加 ocr_provider_id/ocr_model TEXT 列（空=关闭，同构 MultiQuery 配置模式），kb.repo KbRow/rowToRecord/UPDATE/INSERT 四处映射补齐；新增 `src/main/knowledge/ocr.ts`（仿 multi-query.ts）——OCR_SYSTEM_PROMPT（提取全部文字/保持阅读顺序/表格转 Markdown/公式 LaTeX/不解释不编造）、imageMime 纯函数（png/jpg/jpeg/webp/gif→MIME，未知 null）、OCR_MAX_IMAGE_BYTES=10MB（base64 后 ~13MB 请求体主流视觉 API 限额内）、ocrImageFile（stat 超限抛错→readFileSync→base64 data URL→providerManager.getAdapter→adapter.streamChat 多模态单轮 [system + user(text+image_url)]，temperature 0/maxTokens 4096/onDelta noop→content.trim()，空文本抛错；无 adapter/读取失败/模型报错由调用方定语义）；shared/types KbSourceType 加 'image'、KnowledgeBase 加 ocrProviderId/ocrModel；parsers detectSourceType 收图片扩展→'image'（parseDocument case 'image' 抛错防御，防 default 分支把二进制当 txt 读出乱码）；ingestion parseForIngest 分流——image 走 OCR（未配 ocrProviderId/ocrModel 抛「图片文档需要在知识库设置中配置 OCR 视觉模型」小白引导），其余走 parseDocument；「解析后内容为空」按 .pdf 细化为「可能是扫描版，暂不支持 OCR，请转为图片后导入」；hashFile 对图片天然有效增量同步零改动；KB_DOC_ADD_FILE dialog filters 加「图片」组，folder-scan KB_IMPORT_EXTS 加图片扩展 + 导出 IMAGE_EXTS 子集，scanFolderFiles 加 includeImages 必选参数（图片扩展且 false 计入 skippedCount——KB 未配 OCR 时文件夹导入自动跳过图片防批量入库全报错，handlers 调用处传 !!(kb.ocrProviderId && kb.ocrModel)）；KnowledgeModule KbForm 新增「OCR 文字识别」配置区块（复制 MultiQuery 区块：provider 下拉空选项=关闭 + 选中后 model 下拉/手输 + ocrHint 文案）；i18n 新增 kb.ocrHint/ocrProvider/ocrModel/ocrDisabled 中英日韩四语对齐；新增 tests/ocr.test.ts 8 用例（imageMime 映射×2/ocrImageFile 成功 trim+多模态请求结构/无 adapter/超限不发请求/不支持格式/空文本/HTTP 429 透传，mock providerManager + tmpdir 真实文件），parsers.test.ts 加图片扩展 5 断言，folder-scan.test.ts 适配新签名 + 加 includeImages 双态用例，kb-repo/knowledge-ingestion fixture 补 ocr 字段与 providerManager mock | typecheck 0 / vitest 132文件1919用例 / build 三端 |
| 2026-09-29 | V4-Iter-14 | KB 数据健康（完整性探测与修复，知识库运维）：新增 `src/main/knowledge/kb-health.ts`——只读探测 getKbIntegrityReport 四组（kb_vec_map LEFT JOIN kb_chunks 孤儿向量计数（表不存在容错）/孤儿 chunk 防御探测/缺向量 doc（仅 isVecEnabled 时，DISTINCT doc_id）/维度不匹配 doc（length(embedding)!=knowledge_bases.embedding_dim*4，换模型未重建检索静默漏块））逐项 try/catch 容错；纯函数导出直测——findDuplicateGroups（kb_id+content_hash 分组、hash null 跳过（旧数据/URL/手工文本天然不参与）、组内创建时间升序最早在前）、collectProviderIssues（每库 embedding/rerank/hyde/multiquery/ocr 五引用 × missing（已删除）/disabled（禁用）/model-missing（模型不在 provider.models，列表为空不校验防误报），未配置 providerId 跳过）；修复动作 cleanOrphans（孤儿向量逐条 kbVecRepo.deleteByChunk（异常兜底直删 map 行）、孤儿 chunk 先 kbVecRepo.deleteByDoc 再 DELETE 收尾，返回计数）/reindexDocs（kbDocRepo.setStatus pending + indexQueue.enqueue kind:'reindex'，复用 KB_DOC_REINDEX 链路，ingestion 内部先清旧分块）/deduplicate(keepDocId)（同库同 contentHash 其余删除，无 hash/不存在抛错）；泄漏 bug 修复收口 kbDocRepo.delete() 先 kbChunkRepo.deleteByDoc（内部含 vec_map/vec 清理）再删文档行——KB_DOC_DELETE 此前只删文档行，chunks 靠 FK 级联但 vectors.db 无 FK 无人清理，删单文档必留孤儿向量，KB_DOC_DELETE 与去重动作全部堵漏；shared/types DataHealthReport.kb 加 integrity: KbIntegrityReport（orphanVectors/orphanChunks/brokenDocs{reason:'missing-vec'|'dim-mismatch'}/duplicates/providerIssues）+ 4 个子接口；data-health getDataHealthReport 第 2 组探测并入（整体容错失败按全空）；IPC DATA_HEALTH_KB_CLEAN/KB_DEDUP/KB_REINDEX 挂 steward.ts（argsSchema(idSchema)/idSchema.array()）；preload cleanKbOrphans/deduplicateKbDocs/reindexKbDocs；DataHealthPanel 索引状态区块后新增「知识库完整性」区块——integrityOk 全空一行文案，否则孤儿 Row（warn）+清理按钮、brokenDocs 表（Top10）+一键重建索引按钮、重复组行（库/数量/标题串）+保留最早删其余（useConfirm danger 确认弹窗，dialog 渲染补齐）、providerIssues 表（库/角色/问题）；runAction 统一 busy 防重/成功 toast/自动刷新；i18n 新增 dh.integrity.* 27 key 中英日韩四语对齐；新增 tests/kb-health.test.ts 11 用例（重复分组同库聚合/跨库不合并/null 跳过/kbName 注入、provider missing/disabled/missing 优先于禁用/model-missing/空列表不误报/未配置跳过、reindexDocs pending+入队+不存在跳过、deduplicate 保留删其余/无 hash 与不存在抛错——vi.hoisted 内存 docStore/queued 驱动编排逻辑） | typecheck 0 / vitest 133文件1930用例 / build 三端 |
| 2026-10-02 | V4-Iter-50 | 助手维度用量明细弹窗（Iter-45 留尾收尾）：listUsageDetail 加第 5 参 assistantId?:string|null（undefined=不过滤/null=自由会话 IS NULL/字符串=按助手）；过滤拼装抽纯函数 buildUsageDetailScope 导出直测；USAGE_DETAIL_GET argsSchema 加第 4 参 z.string.max64.nullable.optional，preload getUsageDetail 透传；UsagePanel 弹窗 state 泛化 detailConv→detail{title,showConv} 两维度共用，openAsstDetail 传 undefined conversationId，助手排行加明细列眼睛按钮（stopPropagation），'(未知助手)' 行传 null，弹窗助手维度多一列「会话」（明细行已有 conversationTitle），tfoot colSpan 随 showConv 切换；i18n 零新 key；usage-service.test +6 用例；不做明细行跳回会话/明细内搜索/provider·模型维度明细 | typecheck 0 / vitest 152文件2164用例 / build 三端 |
| 2026-10-02 | V4-Iter-54 | 三合一：①用户消息编辑重发——调研确认早已完整存在（MessageBubble 编辑态 textarea/Enter/Esc+handleResend 分支保留+resendMessage IPC+i18n），零改动仅回归；②消息批量收藏——ChatView 操作条+星标按钮（含任一未收藏→全收藏/全已收藏→全取消），+onBatchToggleStar prop，ChatModule Promise.all 逐条落库+单次 map（单条失败跳过），i18n +2 common key；③会话分组文件夹（主体）：migration v37 conversation_groups(id,assistant_id,name,created_at)+conversations.group_id；新建 conversation-group.repo.ts（list/create UUID/rename/delete 事务先解绑会话再删组/setConversationGroup，buildGroupListWhere 纯函数 asst-default→OR IS NULL）；conversation.repo rowToRecord+groupId；5 IPC safeHandle（zod name trim 1-40）+5 preload；ChatModule groups state 并入 reloadConversations 三请求+CRUD/move 乐观更新两列表；ConversationList 普通态分区（顶层未分组+组按组内最近更新排/组内 pinned 优先/空组隐藏/当前组自动展开/折叠集合），组头 📁📂 ✏️🗑 confirm 解散不删会话，原生 DnD（x-pocketai-conv MIME，文件夹头+未分组带 drop 高亮），⋯ 菜单扁平加组项（当前组 ✓）+移出，📁＋内联建组；搜索/过滤/多选/收藏态平铺、归档不分组；i18n 四语 +10 key；新建 conversation-group-repo.test.ts +10 用例；不做嵌套/排序/跨助手/归档组/批量转发/Agent 侧 | typecheck 0 / vitest 153文件2189用例 / build 三端 |
| 2026-10-02 | V4-Iter-53 | 空会话自动清理（点新对话未发消息不再堆积空壳）：conversationRepo +deleteIfEmpty(id)（四重守卫 title_default=1/pinned=0/NOT EXISTS messages/NOT EXISTS conversation_drafts，返 changes>0，无子行免事务级联）+cleanupEmptyConversations()（全局同款 SQL 活跃/归档通清，返条数）；IPC CONVERSATION_DELETE_IF_EMPTY（命中才 clearSessionAllow，返 deleted 布尔）/CONVERSATION_CLEANUP_EMPTY + preload 两桥接；ChatModule 三触发——handleNewConv 当前会话自动标题+未置顶+0 消息（含挂草稿）直接复用不建行、discardCurrentIfEmpty 稳定回调用 messagesRef/convIndexRef/draftTextRef 镜像判定（规避草稿 600ms 防抖竞态）fire-and-forget 删除并本地过滤列表、挂 handleSelectConv/handleSelectMessage/handleSelectAssistant；启动 listAssistants 后先清扫 finally 再 reloadConversations(true)（catch 不阻断）；零 migration/零 i18n/零 toast；conversation-repo.test mock +runChanges +3 用例；重命名/置顶免疫、归档空行同清、不做弹窗/定时/Agent 特判 | typecheck 0 / vitest 152文件2179用例 / build 三端 |
| 2026-10-02 | V4-Iter-52 | 输入草稿持久化（切会话/重启不丢未发送文本）：migration v36 独立表 conversation_drafts(conversation_id PK,draft,updated_at)，delete 事务级联删、fork 不复制；conversationRepo getDraft（无行''）/setDraft（空串 DELETE/非空 UPSERT ON CONFLICT），list() 加 EXISTS 子查询 has_draft 经 rowToRecord 映射；ConversationRecord+hasDraft、IPC CONVERSATION_DRAFT_GET/SET（SET 文本 max 100k，空串=清除）+preload 两桥接；Composer 4 props（draftKey/draft/onDraftChange/onDraftCommit），textRef+prevKeyRef，effect 在 key 变化时先 commit 旧会话再回填 draft（覆盖异步加载），onChange/insertAtCursor/submit 清空统一收口 updateText；ChatModule activeDraft+600ms 防抖 timer+draftTextRef，三个切会话入口同步清空防闪现，currentConvId effect cancelled 守卫加载，落库后本地 patch 列表 hasDraft 零延迟出 📝，beforeunload/pagehide 尽力 flush；ChatView 纯透传；ConversationList 标题行 📝 10px（非多选态）；i18n 四语 +1 key chat.draftHint；conversation-repo.test mock 升级 vi.hoisted prepare/all/get/run+transaction 捕获链 +7 用例（has_draft 映射/list SQL/读写/空删/级联）；不做附件持久化/replyTo 恢复/草稿列表/Agent 草稿/多端同步 | typecheck 0 / vitest 152文件2176用例 / build 三端 |
| 2026-10-02 | V4-Iter-51 | 消息收藏星标（重要消息跨会话找回）：migration v35 messages 加 starred INTEGER DEFAULT 0 + idx_messages_starred(starred,created_at DESC)；MessageRecord+starred?:boolean、新增 StarredMessageItem 精简列表项；messageRepo setStarred/listStarred（LEFT JOIN conversations 带标题、删除兜底空串、created_at DESC+rowid DESC）；IPC MESSAGE_SET_STARRED/MESSAGE_LIST_STARRED + preload setMessageStarred/listStarredMessages；MessageBubble 操作区显隐条件 hovered||selected||starred 星标按钮独立常显（⭐accent/☆muted 固定行尾）；ChatModule handleToggleStar（IPC+setMessages 本地 map 不 reload）；ConversationList starredMode 与搜索/过滤/多选互斥 + 工具行 ⭐ 入口 + StarredResults 组件（角色+标题+relTime+line-clamp-2 内容、行尾 hover ☆ 取消、点击复用 onSelectMessage 跳转链路）；i18n 四语 +4 key；message-repo.test +5 用例（mock prepare 链捕获 SQL/参数）；不做分组/导出/Agent 星标/角标 | typecheck 0 / vitest 152文件2169用例 / build 三端 |
| 2026-10-02 | V4-Iter-49 | 会话列表消息预览（快速辨识内容不用点进去）：conversation.repo list() SQL 加关联子查询 `(SELECT substr(replace(replace(m.content,char(13),' '),char(10),' '),1,80) FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_preview`（单 SQL 避免 N+1，换行折叠为空格，活跃/归档列表同享）；ConversationRecord+lastMessagePreview?:string|null、ConversationRow+last_preview、rowToRecord 映射（非 list 路径缺列回退 null）；ConversationList ConvItem 标题区改 flex-col 加 11px muted truncate 预览行（仅非多选态且非空渲染，过滤态/归档区自动继承）；i18n 零新 key（预览即消息原文）；conversation-repo.test +1 用例；不做 hover 才显示/多行预览/流式实时刷新/角色标签 | typecheck 0 / vitest 152文件2158用例 / build 三端 |
| 2026-10-02 | V4-Iter-48 | 消息引用回复（长对话追溯上下文）：migration v34 messages 加 reply_to_id TEXT；MessageRecord/SendMessagePayload 加 replyToId；MessageRow/rowToRecord/insert 同步；chat-service 持久化 user 消息写 replyToId；ChatModule replyToMessage state+handleSetReply；ChatView msgById Map+handleReply 查完整消息+onJumpToReply 复用 scrollToIndex center+highlightMsgId 2s；MessageBubble 加 replyTo 引用条（角色+内容截断点击跳转）+CopyButton 后「引用」按钮；Composer 加 replyTo 引用条（角色+预览+关闭）submit 传 replyToId 并清空；i18n 四语 +5 key；message-repo 测试 +1；不拼 prompt/不嵌套/不跨会话 | typecheck 0 / vitest 152文件2157用例 / build 三端 |
| 2026-10-02 | V4-Iter-47 | 会话列表标题过滤（快速定位会话）：ConversationList 加 convFilter state + filteredConversations（title 不区分大小写 includes，空不过滤）；消息搜索框下加过滤输入框（仅 !isSearching && !selectMode 显示，带清空按钮）；conversations.map→filteredConversations.map，空态区分无会话/无匹配；i18n 四语 +2 key；纯前端零 IPC，不做消息内容过滤/拼音匹配/过滤后全选 | typecheck 0 / vitest 152文件2156用例 / build 三端 |
| 2026-10-02 | V4-Iter-46 | 历史会话批量删除（复用 Iter-23 多选模式）：新增 IPC CONVERSATION_BATCH_DELETE（ids 数组 max500，逐个 delete+clearSessionAllow，单条 try/catch 不中断，返 deleted 计数）；preload deleteConversations；ConversationList props 加 onBatchDelete，多选操作条导出按钮后加红色批量删除按钮（二次确认 window.confirm，删除中显示 common.deleting）；ChatModule handleBatchDeleteConv 调 IPC→当前会话在删列表则清空→reload→toast 成功含实际删除数；i18n 四语 +4 key；不做归档区批量删除/进度条/撤销 | typecheck 0 / vitest 152文件2156用例 / build 三端 |
| 2026-10-02 | V4-Iter-45 | 消息级用量明细弹窗（Iter-25 留尾收尾，深度对账）：listUsageDetail 加第四参 conversationId?（非空 SQL 追加 AND conversation_id=? 参数化，空值退化 CSV 全量零破坏）；IPC argsSchema 第三参 z.string max64 optional；preload getUsageDetail 加 conversationId；UsagePanel 会话排行加「明细」列眼睛图标按钮（stopPropagation 不触发行跳转）+ 弹窗（时间/模型/输入/输出/缓存/total/费用 + tfoot reduce 合计 + loading/空态 + 点遮罩关闭）；i18n 四语 +10 key；不加单条跳转/明细内搜索/助手维度弹窗 | typecheck 0 / vitest 152文件2156用例 / build 三端 |
| 2026-10-02 | V4-Iter-44 | 会话内消息搜索（长会话找不回消息）：ChatView 导出纯函数 findMatchIds（trim 后小写匹配 content 按序返 id）+ searchOpen/keyword/curMatchIdx 状态 + matchIds useMemo；gotoMatch 复用 virtualizer.scrollToIndex('center')+highlightMsgId 高亮 2s（与全局搜索跳转同口径）；模型栏搜索图标按钮展开搜索条（输入框+i/n 计数+上下+关闭，无命中禁用上下）；快捷键 Ctrl/Cmd+F 打开聚焦/Enter 下一个/Shift+Enter 上一个/Esc 关闭（Ctrl+F preventDefault 防浏览器原生查找）；i18n 四语 +4 key；chat-search.test 6 用例；零新 IPC 纯前端 | typecheck 0 / vitest 152文件2156用例 / build 三端 |
| 2026-10-02 | V4-Iter-43 | 子窗口划词浮条挂接（Iter-37 留尾收尾）：DetachedApp.tsx 单文件 import SelectionToolbar，在 contentRef 内 Workspace 后 !locked 条件渲染（与 App.tsx 同口径，锁屏遮罩 z-9999 高于浮条 z-9000）；SelectionToolbar 自包含零新依赖/IPC/i18n，复用主浮窗单例；纯 UI 接线不补测试 | typecheck 0 / vitest 151文件2150用例 / build 三端 |
| 2026-10-02 | V4-Iter-42 | WebDAV 定时备份轮转清理（策划书 6.1 定时备份收尾，治远端无限堆积）：backup-scheduler +K_RETENTION（默认 0 关闭/上限 100）、BackupScheduleStatus+retentionCount、BackupRunResult+pruned（shared 与本地双定义同步）、zod patch+0-100；纯函数 selectPrunableBackups（只清 full 保增量引用链/mtime 倒序保留含新包/justUploaded 兜底防时钟漂移误删/最旧优先删除保中断安全）；runScheduledBackup 成功后 pruneOldBackups 列举→逐个删独立容错、pruned 入 last_result、轮转失败不连累备份 ok；手动上传不触发；设置页保留份数 select（0/3/5/10/20/30）+hint+pruned 文案；i18n 四语 +4 key；backup-scheduler.test 扩 mock +11 用例（纯函数 6/集成 4/配置 1，测试推演修正「新包占保留名额」语义）；不做增量轮转/立即清理按钮 | typecheck 0 / vitest 151文件2150用例 / build 三端 |
| 2026-10-02 | V4-Iter-41 | 用量数据 CSV 导出（月度复盘/报销/透视）：shared +UsageDetailItem/UsageDetailResult 与 USAGE_DETAIL_GET/USAGE_EXPORT_CSV 两 IPC；usage-service +aggregateUsageDetail 纯函数（坏 JSON 跳过/未配价 0/roundCost/倒序保持/未知会话兜底/assistant 名 null）+listUsageDetail（JOIN conversations+assistants，limit+1 判 truncated，clamp 365 天/20000 行）；handler 明细薄封装+CSV 落盘照搬诊断报告模式（默认名 pocketai-usage-{days}d-时间戳.csv，content zod 500 万字符上限）；preload +2 桥接；新建 renderer/utils/usage-csv.ts（RFC4180 转义/本地时间格式/10 列固定序/BOM+CRLF/null 助手空串）；UsagePanel chips 行导出按钮（无数据禁用、busy 防重、成功 toast 条数、截断 warning、取消静默）；i18n 四语 +6 key 列头复用既有；usage-csv.test 11 用例+usage-service.test 补 5 用例；不做 XLSX/列选择/正文导出 | typecheck 0 / vitest 151文件2139用例 / build 三端 |
| 2026-10-02 | V4-Iter-40 | 管家推荐模型一键拉取（闭环策划书 6.1「检测→推荐→下载」）：新建 hooks/useOllamaPull.ts（从 OllamaPanel 收口 pulling/pullEvt/事件订阅/守卫/双兜底复位/abort，onDone·onError 走 ref 订阅只挂一次，卸载不中断后台拉取）+同文件纯函数 pickPullState 五态（installed/pulling/busy-other/disabled/pullable，installed 最高优先级）；OllamaPanel 改 hook 接线 UI 文案零变化（doPull 包 clearPullDone，pullError 独立行）；StewardModule refreshRecommendation 抽 useCallback 复用，onDone 重拉推荐刷新 installed+toast、onError toast，卡片按五态渲染进度条（status+%+中断）/禁用（未运行 title 引导去设置）/拉取按钮，向量模型同等待遇；i18n 四语仅 +steward.pullNeedRunning（韩文内引号改「」避语法冲突）其余复用 ollama.*；ollama-pull-state.test 6 用例；不做自动注册 provider/管家页启动安装/并发拉取 | typecheck 0 / vitest 150文件2123用例 / build 三端 |
| 2026-10-02 | V4-Iter-39 | 管家诊断报告导出（策划书 6.4 远程求助）：新建 renderer/utils/diagnostic-report.ts buildDiagnosticReport 纯函数（ReportLabels 字典注入+复用 formatBytes，固定五段①硬件②模型推荐③数据健康④安全体检⑤故障诊断，缺失段不省略标 notRun/notAvailable，时间手动 pad 不依赖 locale）；main IPC STEWARD_EXPORT_REPORT（steward.ts safeHandle+zod content≤200000，showSaveDialog 默认名 pocketai-report-时间戳.txt，取消 canceled/成功 path）；preload +exportStewardReport；StewardModule 顶部导出按钮，handleExport 先 Promise.all 补跑 audit/diagnose（setState 同步刷新，失败容忍）+getUpdateInfo 取版本，toast 成败反馈，硬件用快照不 force；i18n 四语 21 新 key 字段复用既有 steward.*、段名新建 reportSec* 不剥 emoji；grep 核实体检只查 Key 存在性零凭证泄露；diagnostic-report.test 11 用例（五段字段/GB 一位小数/段序/全 null/空诊断/完整性异常/无 GPU+USB） | typecheck 0 / vitest 149文件2117用例 / build 三端 |
| 2026-10-02 | V4-Iter-38 | 浮窗回答一键复制（Iter-37 选区助手工作流闭环最后一跳）：PopupApp.tsx 单文件改动——新增 AssistantBubble 子组件（group 包裹 Markdown+绝对定位圆形复制按钮 -top-2 -right-2，hover/focus 显现，复制成功对勾态 1.5s，SVG 与代码块复制按钮同口径）；复用 useCopyFeedback+writeClipboard（file:// 透明窗 execCommand 降级）；仅 assistant 非错误有内容气泡启用，错误/流式占位/user 原样；复制模型原文与代码块 raw 口径一致；i18n 零新 key 复用 common.copy/copied；纯 UI 无新逻辑不补测试；不主动关窗（blur 自隐 Spotlight 形态，切窗粘贴自然隐藏，不打断连续多动作） | typecheck 0 / vitest 148文件2106用例 / build 三端 |
| 2026-10-02 | V4-Iter-37 | 应用内划词浮条（选区助手补齐策划书 6.1 必做）：全局快捷键版（Ctrl+Shift+U 取词浮窗）已有，本批补应用内就地入口——shared +SelectionAction 类型、PopupPayload +action、IPC POPUP_OPEN_SELECTION；main popup.ts openPopup 第三参 action + safeHandle（zod text≤8000/action enum，trim 截断/锁屏拒绝 ok:false）；主 preload +openSelectionPopup；新建 renderer/utils/selection-actions.ts（SELECTION_ACTIONS 顺序源/composeSelectionPrompt 从 PopupApp 抽出 4 条提示词/normalizeSelectionText 8000 截断/isEditableSelectionHost 复用 shortcuts.isEditableTarget 沿 parentElement 链上溯不重复造）；新建 components/SelectionToolbar.tsx（mouseup 左键+keyup Shift 延迟一帧读选区；fixed 浮条实测尺寸定位上方不足翻下水平夹取；onMouseDown preventDefault 防清选区；隐藏=capture mousedown 外/selectionchange 空/Esc/scroll/blur；selectionEnabled 开关 focus 刷新；文案复用 popup.act.*）App !locked 挂载；PopupApp pendingActionRef 按 ts 标记就绪后自动执行一次，快捷键入口无 action 保持手动芯片；i18n 零新 key 仅更新 popup.selectionHint 四语；selection-actions.test 14 用例 | typecheck 0 / vitest 148文件2106用例 / build 三端 |
| 2026-10-02 | V4-Iter-36 | 会话累计用量条（Iter-35 气泡微展示上卷，实时回答「本会话花了多少」）：新建 renderer/utils/usage-summary.ts sumMessagesUsage(messages,pricing) 纯函数（仅 assistant+带 usage 消息计入 counted；逐条 priceKey(provider,model) 查价 computeUsageCost 后 roundCost 汇总，多模型多批次各自计价；返回 prompt/completion/cached/total/cost/counted）；ChatView useMemo 派生（deps messages/pricing），消息流容器顶部虚拟列表外 11px muted 右对齐胶囊随滚动消失，totalTokens>0 才显示，未配单价 fmtCost 空串时只显 token，title 复用 tokenHint/tokenCachedHint+费用行；账单口径=全部批次含分支重跑（与 usage-service 一致，重跑真实消费）；i18n chatview.sessionUsage 四语 1 key 明细复用 Iter-35；usage-summary.test 6 用例（空会话/user 与无 usage 跳过/无 pricing/单模型 7 元/多模型含缓存价 12.7 元/缺单价缺 provider 只计 token）；零新 IPC | typecheck 0 / vitest 147文件2092用例 / build 三端 |
| 2026-10-02 | V4-Iter-35 | 气泡 token 微展示（对话中实时感知每轮花费）：pricing 纯函数收口 src/main/usage/pricing.ts→src/shared/usage-pricing.ts（零依赖主渲染共用 computeUsageCost/priceKey/parsePricing，pricing-config KV 读写留 main），import 改道 usage-service/pricing-config/handlers messages/usage-pricing.test；新建 renderer/utils/token.ts（fmtTokens/fmtCost 从 UsagePanel 抽出，UsagePanel 删私有实现+同构 pk 改共享 priceKey）；MessageBubble +usage/provider/pricing props，assistant 气泡下来源块下 10px muted 行显示缩写总 token+命中单价 ¥/$费用（accent 小字），title 原生提示输入/输出/缓存命中明细（cached=0 省略），无 usage/streaming 不渲染；ChatView 挂载拉 getUsagePricing（失败静默只显 token）透传 MessageBubble+BranchCompare（分支对比可横向比 token/费用）；调研校准 done 后 useStreamSession 200ms 自动 loadMessages 带 usage 无需改事件链、Agent/浮窗不用 MessageBubble 自动排除；i18n chatview.tokenLine/tokenHint/tokenCachedHint 四语 3 key；token-format.test 新建 6 用例（k/M 分级边界/费用 0 负 NaN/精度分级），usage-pricing.test 改路径用例不动 | typecheck 0 / vitest 146文件2086用例 / build 三端 |
| 2026-10-02 | V4-Iter-34 | KB 问答历史跨库漫游（V4-Iter-28 留尾四项收官）：kb-ask-session.repo +listAll(limit)/searchAll(keyword,limit)——LEFT JOIN knowledge_bases 带库名 ORDER BY s.updated_at DESC LIMIT ?，空串回退 listAll，kb_name null 回落空串 UI 兜底；types +KbAskRoamItem（extends KbAskSessionMeta+kbName）+IPC KB_ASK_SESSION_LIST_ALL/SEARCH_ALL；knowledge.ts 2 safeHandle（limit zod 1-500）+preload 双桥接（默认 200）；新建 KbAskRoam.tsx（200ms 防抖搜索+会话行标题/库名 chip/时间·消息数·模型+双空态）；KnowledgeModule mode 联合加 roam +左栏 🕘 入口，点击行模块 state 提升 setAskJumpId+setMode detail+setSelectedId（入口在模块内不用 source-jump 事件）；KbDetail 加 askJumpId/onAskJumpHandled props（effect setAskMode(true) 透传）；KbAskPanel 加 openSessionId/onSessionOpened（effect setShowHistory(true)+loadSession+回调清空，兼容切库重挂载与同库二次跳转）；fmtSessionTime 导出复用；i18n kb.roam* 中英日韩四语 5 key；kb-ask-session-repo.test +4 用例（JOIN SQL/LIKE 参数顺序/空白回退/null 兜底） | typecheck 0 / vitest 145文件2080用例 / build 三端 |
| 2026-10-02 | V4-Iter-33 | KB 问答历史自动清理（V4-Iter-28 留尾收官项）：kb-ask-session.repo +prune(kbId, policy)——keepDays>0 删 updated_at<阈值、keepCount>0 删 id NOT IN（ORDER BY updated_at DESC LIMIT ?），返回合计删除数；新建 src/main/knowledge/ask-retention-config.ts（仿 pricing-config，app_config 键 kbAsk.retention JSON {keepCount,keepDays}，parseKbAskRetention 容错回退双 0=关闭不静默删数据）；KB_ASK_SESSION_SAVE handler upsert 后非全 0 即 prune 该库（写入触发而非定时调度器，repo 保持纯数据访问编排归 handler）；types +KbAskRetention +IPC KB_ASK_RETENTION_GET/SET；knowledge.ts 2 safeHandle + zod（0-10000/0-3650）；preload 双桥接；KbAskPanel 历史列表加「自动清理」btn-ghost（生效时 accent 高亮）→ 展开双 select 行内配置（条数 不限/50/100/200/500 + 天数 不限/7/30/90/180）切换即保存 toast+刷新；i18n kb.askRetention* 中英日韩四语 5 key；kb-ask-session-repo.test +prune 4 用例（仅天数/仅条数/双策略合计/双 0 不删），新建 ask-retention-config.test 6 用例（parse 容错/get 回退/set-get 往返） | typecheck 0 / vitest 145文件2076用例 / build 三端 |
| 2026-10-02 | V4-Iter-32 | 用量排行点击跳转（V4-Iter-25/27 连续两次留尾，打通洞察到操作最后一公里）：新建 `src/renderer/src/modules/settings/usage-jump.ts` 仿 source-jump 模式——USAGE_JUMP_EVENT='usage-open-target' + UsageJumpDetail 联合类型（conversation{convId}/assistant{assistantId}），requestUsageJump 写 sessionStorage 'usage-pending-jump' + dispatch 'pocketai:switch-module' {moduleId:'chat'} + 广播事件（已挂载即时消费，未挂载挂载后 consume），consumePendingUsageJump 读后即清 + type/字段校验容错；UsagePanel 会话/助手排行 tr 加 cursor-pointer+hover:bg-hover-overlay + onClick requestUsageJump + title 提示（行 title 移到 tr，td span 不再重复）；ChatModule useEffect 监听 USAGE_JUMP_EVENT → conversation 调 handleSelectConv(d.convId)/assistant 调 handleSelectAssistant(d.assistantId)（后者含 setCurrentAssistantId+setCurrentConvId(null)+reloadConversations(true)），deps [handleSelectConv, handleSelectAssistant]；i18n usage.clickToJump 中英日韩四语 1 key；tests/usage-jump.test.ts 6 用例（request 写 pending+双事件/consume 读后即清/非法 JSON/非法 type/缺字段/无 pending，vi.stubGlobal mock sessionStorage+window 解决 node 环境无 DOM API） | typecheck 0 / vitest 144文件2066用例 / build 三端 |
| 2026-10-02 | V4-Iter-31 | 提示词片段库导入导出（V4-Iter-20 留尾）：snippet.repo +findByTitle(title) + createOrUpdateByTitle(title, content)（同 title UPDATE 保留原 id / 无同 title INSERT 新 UUID）；types +IPC SNIPPETS_EXPORT/SNIPPETS_IMPORT；schemas/snippets.ts +snippetImportSchema（宽松校验顶层 snippets 数组，逐条字段验证在 handler 层做）；snippets.ts 增 EXPORT（主进程 list() → JSON.stringify → showSaveDialog 存盘，safeFileName 命名）+ IMPORT（showOpenDialog 读 JSON → JSON.parse → snippetImportSchema.safeParse → 逐条 createOrUpdateByTitle 统计 imported/overwritten/skipped，title>100/content>20000 单条跳过）；preload exportPromptSnippets/importPromptSnippets 桥接；SnippetButton 列表底部工具行 btn-ghost「⬇ 导出 / ⬆ 导入」按钮（导出成功 toast 路径、导入成功 toast 计数、失败 toast 错误）；i18n snippet.exportTitle/importTitle/exported/imported/importFailed 中英日韩四语 5 key；tests/snippet-repo.test.ts 3 用例（UPDATE/INSERT 分支、findByTitle 命中/未命中） | typecheck 0 / vitest 143文件2060用例 / build 三端 |
| 2026-10-02 | V4-Iter-30 | KB 问答会话搜索（V4-Iter-28/29 留尾）：kb-ask-session.repo +searchByKb（`title LIKE ? OR messages_json LIKE ?`，空串/空白回退 listByKb 防全表扫描）；types +IPC KB_ASK_SESSION_SEARCH；knowledge.ts safeHandle + argsSchema(idSchema, z.string().max(200))；preload searchKbAskSessions 桥接；KbAskPanel 历史列表顶部加搜索输入框（200ms 防抖 + 卸载清 timer），搜索态空结果显示「无匹配会话」/非搜索态显示「暂无历史会话」，关闭历史面板自动清搜索态；i18n kb.askSearchPlaceholder/kb.askSearchEmpty 四语 2 key；tests/kb-ask-session-repo.test.ts 5 用例（LIKE 匹配/空串回退/空白回退/无匹配/非法 JSON 容错） | typecheck 0 / vitest 142文件2057用例 / build 三端 |
| 2026-09-30 | V4-Iter-29 | KB 问答会话重命名与导出（V4-Iter-28 留尾）：kb-ask-session.repo +rename（UPDATE 仅 title+updated_at）；types +IPC KB_ASK_SESSION_RENAME/EXPORT_MD/EXPORT_HTML；shared/export-markdown.ts +buildKbAskSessionMarkdown（头部元信息+user 引用块+assistant 保真+来源去重，KbAskMessage 无附件/工具/token 结构更简）；knowledge.ts 3 handler（RENAME zod id+title 1-200；EXPORT_MD 主进程 get→build→showSaveDialog→writeFileSync；EXPORT_HTML 渲染端构建后传主进程存盘 zod ≤50MB）；preload 3 桥接；renderer/utils/export-html.tsx +buildKbAskSessionHtml（复用 STYLE/Markdown/formatSources，react-dom/server 动态 import 拆包）；KbAskPanel 历史列表项加重命名 ✎ 内联编辑（Enter/Esc/失焦）+ 导出 ↓ 菜单（复用 ExportMenu MD/HTML）+ 删除，当前会话工具行加重命名+导出（仅非 pending 防导出未完成流式内容）；i18n 复用 chat.rename/exportMd/exportHtml 等 + 增 kb.askExported({path})/kb.askSessionNotFound 四语 2 key；export-markdown.test +4 用例 | typecheck 0 / vitest 141文件2052用例 / build 三端 |
| 2026-09-30 | V4-Iter-28 | KB 问答留痕（V4-Iter-8 留尾）：migration v33 `kb_ask_sessions` 新表（id/kb_id/title/messages_json/provider_id/model/created_at/updated_at + kb_id+updated_at 索引，消息体含 sources JSON 单列存储，一轮问答一行）；shared/types +KbAskSessionRecord/KbAskSessionMeta +IPC KB_ASK_SESSION_SAVE/LIST/GET/DELETE；新建 shared/kb-ask-session.ts 纯函数 sessionTitleFrom（首问截断40字）/parseKbAskMessages（容错解析过滤非法项，零依赖放 shared 供 repo+tests 复用）；新建 kb-ask-session.repo.ts（upsert INSERT OR REPLACE/listByKb 回 meta 不含正文/get 容错还原/delete/deleteByKb）；knowledge.ts 4 safeHandle（SAVE zod 完整 schema messages≤200）+preload 4 桥接；渲染端全量 upsert 单写路径（ask-service 零改动）——send 首轮 crypto.randomUUID 生成 sessionId 存「含提问」、onKbAskDone 存「含回答+sources」，msgsRef 镜像+persistRef 转发保证一次性挂载订阅拿到最新值；KbAskPanel 加历史(N)/新对话工具行 + 历史列表（标题/消息数/相对时间/模型，当前会话高亮+单条删除）+ 加载历史回放可继续追问；KnowledgeModule KbAskPanel 加 key={kb.id} 防切库跨库串数据；ingestion deleteKb 级联 kbAskSessionRepo.deleteByKb；i18n 四语改 kb.askHint + 增 kb.askHistory/askNewSession/askNoSessions/askMsgCount({n})；kb-ask-history.test 8 用例 + knowledge-ingestion.test 补 repo mock 隔离 electron 链路 | typecheck 0 / vitest 141文件2048用例 / build 三端 |
| 2026-09-30 | V4-Iter-27 | 助手用量排行（V4-Iter-25 留尾）：types +UsageAssistantItem +USAGE_ASSISTANTS；usage-service 新增 UsageAssistantRow（messages JOIN conversations INNER 归属 + LEFT JOIN assistants 带名）+ 纯函数 aggregateAssistantUsage（与 aggregateConversationUsage 同构：按 assistant_id 分组，坏 JSON 跳过/computeUsageCost 计费/roundCost，totalTokens 倒序，name 空兜底「(未知助手)」防御取首个非空，lastUsedAt=MAX(created_at)）+ listAssistantUsage(days 1-365/limit 1-100 默认 10)；IPC safeHandle+zod 双 optional+prices 透传，preload getUsageAssistants；UsagePanel 会话排行后加「助手排行」Top10 表（随 load(days)/reload 联动，空不渲染）；i18n usage.byAssistant/usage.assistant 四语；usage-service.test 22→26 用例 | typecheck 0 / vitest 140文件2040用例 / build 三端 |
| 2026-09-30 | V4-Iter-26 | 会话导出 PDF（零新依赖）：新建 src/main/export/pdf.ts（ensurePdfWindow 单例隐藏 sandbox 窗口照抄 js-eval-runner 模板；HTML 临时文件 file:// 加载避 data URL 2MB 上限；printToPDF A4+printBackground+页码页脚 headerTemplate 显式置空；60s 超时销毁重建；模块级串行队列队尾吞错；失败销毁窗口；finally unlink）；IPC EXPORT_PDF（showSaveDialog→htmlToPdf→写 Buffer）+EXPORT_PDF_BATCH（选目录→dedupeFileNames→串行转换→{count,dir,failed}，max 50）+preload 双桥接；batch-export.ts BatchExportFormat 扩 'pdf'（content 仍 HTML 扩展名 .pdf）+BATCH_PDF_MAX=50+finishBatchExport(files,format) 分流；ConversationList/SessionRail 单条菜单第三项+操作条第三按钮；ChatModule/AgentPanel +handleExportPdf+handleBatchExport 扩 format（capSelection 按 format 选上限）；i18n chat.exportPdf/exportSelectedPdf 四语；batch-export.test 8→12 用例 | typecheck 0 / vitest 140文件2036用例 / build 三端 |
| 2026-09-30 | V4-Iter-25 | 会话用量明细（V4-Iter-23 留尾）：types +UsageConversationItem +USAGE_CONVERSATIONS；usage-service 新增 UsageConversationRow（LEFT JOIN conversations 带标题）+ 纯函数 aggregateConversationUsage（按 conversation_id 分组，坏 JSON 跳过/computeUsageCost 同口径计费/roundCost，totalTokens 倒序，title 空兜底「(未知会话)」防御取首个非空，lastUsedAt=MAX(created_at)；时间过滤由 SQL created_at>=since 承担故不收 days）+ listConversationUsage(days 1-365/limit 1-100 默认 20)；IPC safeHandle+zod 双 optional+prices 透传，preload getUsageConversations；UsagePanel 模型 Top10 后加「会话排行」表（复用 byModel 样式，随 load(days)/reload 联动，空不渲染）；i18n usage.byConversation/usage.conversation 四语；usage-service.test 17→22 用例 | typecheck 0 / vitest 140文件2032用例 / build 三端 |
| 2026-09-30 | V4-Iter-24 | 会话多选批量导出（V4-Iter-17 留尾）：新建 renderer utils/batch-export.ts 共用核心（BATCH_EXPORT_MAX=500；capSelection 超限截断保序返回 {list,dropped}；buildBatchExportFiles 逐会话 listMessages→md/html builder 组装，每 10 个 setTimeout 0 让帧，onProgress(done,total)；finishBatchExport 返回结构化 outcome 由调用方拼 toast）；ConversationList 多选模式（ExportMenu 第三项入口清搜索进多选，顶部全选/取消，ConvItem checkbox+行点击 toggle+隐藏操作图标，底部「已选 {n}」+MD/网页按钮，Esc 退出，归档区不参与）；SessionRail 同构；ChatModule/AgentPanel handleBatchExport 双语义（convs 缺省=全量，传入=多选+capSelection 超限提示），删两侧重复循环；i18n chat.exportMulti* 5 key 四语（复用 common.selectAll/cancel）；batch-export.test 8 用例 | typecheck 0 / vitest 140文件2027用例 / build 三端 |
| 2026-09-30 | V4-Iter-23 | 用量费用估算（V4-Iter-1 留尾）：新增 main/usage/pricing.ts 纯函数（computeUsageCost 输入/缓存子集/输出分段÷100万，cached>prompt 夹断防负，roundCost 6 位；sanitizeModelPrice input/output 必填 cache 可空；parsePricing 币种白名单回退 CNY、prices 脏条目整条丢、key 须含 ::）+ pricing-config.ts（appConfigRepo KV `usage.pricing`，get/set+JSON 容错回退）；types UsageSummary 四层结构 +cost、新增 ModelPrice/UsagePricing/UsageModelItem + IPC USAGE_PRICING_GET/SET/USAGE_MODELS；schemas/usage.ts zod .strict()；usage-service aggregateUsage 第三参 prices 平行 dailyCostMap，listDistinctModels 历史模型 GROUP BY 倒序 LIMIT；messages handler 3 注册（SET zod.parse→规范化→返回）+ preload 3 桥接；UsagePanel 汇总卡 5 列「估算花费」、byModel 费用列、provider 费用小字、柱 tooltip，可折叠 PriceEditor（币种切换+历史模型∪已配 key 行清单+输入/缓存/输出三价输入，成对校验，保存重拉 toast）；i18n usage.* 14 key 四语；usage-pricing.test 17 用例 + usage-service.test 补 2 用例 | typecheck 0 / vitest 139文件2019用例 / build 三端 |
| 2026-09-30 | V4-Iter-22 | 代码块一键复制：新建 utils/code-block.ts（parseCodeProps 语言/代码提取；nodesToText 递归拍平 rehype-highlight 的 hljs span token——直接 String 会得 [object Object]，鸭子类型无 react 运行时依赖）；Markdown pre 渲染器加 CodeBlock（包裹层 relative+原 pre 样式，按钮 absolute 不随横向滚动移位，SVG 复制/对勾+半透明常显 hover 全显，复用 useCopyFeedback/common.copy 零新 i18n key），新增 codeCopy prop 默认 true；mermaid 仍走 MermaidBlock；export-html 两处 codeCopy=false 防导出死按钮；受益面 Chat/浮窗/知识库问答/对比列（Agent 为纯文本渲染、整条复制已存在，不做 markdown 化）；code-block.test 11 用例 | typecheck 0 / vitest 138文件2000用例 / build 三端 |
| 2026-09-30 | V4-Iter-21 | 会话智能标题：调研校准发现 Chat 新建会话传助手名致旧截断规则不触发（真实半成品）。migration v32 conv_title_default（conversations 加 title_default，存量真实标题回填 0 防误改）；ConversationRecord +titleDefault；repo create titleDefault 入参（导入传 false）/rename 同步置 0/setTitleDefault/fork 显式 0；新建 src/main/conversation/（title-prompt 纯函数 fallbackTitle/buildTitlePrompt/sanitizeTitle 剥引号折空白去前缀句末标点空回退模型标题 40 字符上限；title-gen 编排：进入即消费标记每会话至多 1 次、开关关=旧行为、开关开先落截断标题再 fire-and-forget streamChat 独立 10s 超时 maxTokens32 temp0.3 成功 broadcast CONVERSATION_TITLE_EVENT；title-config app_config 键缺省开）；chat-service 与 engine 两处旧判断统一替换（Chat 取 targets[0]）；IPC SMART_TITLE_GET/SET + preload 2 桥接 + onConversationTitle 订阅，ChatModule/useAgentChat 就地更新双列表 done-reload 兜底；设置页「对话」开关小节（乐观更新失败回滚）；i18n 3 key 四语；title-prompt 13 用例+repo 1 用例+fixture 修正 | typecheck 0 / vitest 137文件1989用例（串行全绿；并发 export-markdown 既有 flaky）/ build 三端 |
| 2026-09-30 | V4-Iter-20 | 提示词片段库：migration v31 prompt_snippets 新表+索引；PromptSnippetRecord 类型；snippet.repo CRUD（仿 note.repo）；IPC SNIPPETS_LIST/CREATE/UPDATE/DELETE（safeHandle+zod title≤100/content≤20000/patch refine）+ preload 4 桥接；utils/snippet-template.ts 纯函数 extractTemplateVars（支持中文变量名、去重保序）/applyTemplateVars（空串留空、未知保留、防$注入）；共用 SnippetButton 组件（📝+fixed 弹层避 Agent overflow-hidden 裁切，列表搜索/新建编辑/行内二次确认删除/变量填充三态，点外部/Esc 两级关闭）；Chat Composer 与 Agent AgentComposer（补 taRef、running 禁用）均接 insertAtCursor 光标处插入不自动发送；i18n snippet.* 20 key 四语；snippet-template.test 12 用例 | typecheck 0 / vitest 136文件1975用例 / build 三端 |
| 2026-09-29 | V4-Iter-19 | 全局快捷键体系：调研校准——Agent 早有独立快捷键 hook 但保活后隐藏实例误触、Chat 侧零快捷键、Ctrl+W 被菜单 role 占用关整窗。新建 utils/shortcuts.ts 纯函数 matchAppShortcut（Ctrl/⌘等价、Alt/Shift 组合排除、Esc 需 running+非编辑态焦点、isEditableTarget 鸭子类型、modLabel）+ hooks/useGlobalShortcuts.ts 单中枢（标签类直接 store/IPC、会话类 CustomEvent 'pai:app-shortcut' 派发、busyModules 判 running、锁屏屏蔽）；Workspace 活动容器加 data-active-module，ChatModule/AgentPanel 监听先守卫活动实例（修保活/多标签误触）；Chat 补齐 data-chat-composer-input/data-chat-search-input 锚点与 4 动作；AgentPanel 换事件并删 useAgentShortcuts.ts+agent-shared 旧纯函数+旧测试；App.tsx Ctrl+L 收口；menu.ts 两处 role:close 改无 accelerator click 解除 CmdOrCtrl+W；设置加键盘快捷键只读速查小节，i18n 10 key 四语；tests/shortcuts.test.ts 20 用例 | typecheck 0 / vitest 135文件1963用例 / build 三端 |
| 2026-09-29 | V4-Iter-18 | 会话置顶与归档：migration v30 conv_pin_archive（conversations 加 pinned/archived/archived_at）；ConversationRecord +3 字段；conversation.repo rowToRecord 0/1→boolean+旧行 undefined 安全默认，抽纯函数 buildConvListQuery（archived=0/1 恒定过滤、活跃 ORDER BY pinned DESC,updated_at DESC/归档 archived_at DESC），list 第三参 {archivedOnly}，新增 setPinned/setArchived（取消归档保留 pinned），touch 追加 archived=0 实现归档会话收到新消息自动回主列表；IPC CONVERSATION_LIST 第三参+新增 SET_PINNED/SET_ARCHIVED（safeHandle+zod），preload 3 桥接；Chat ConversationList 与 Agent SessionRail 同构——底部「📦 已归档 (N)」折叠区（N=0/搜索态不显示）、标题 📍 标记、新增 ⋯ 更多菜单（复用 ExportMenu：置顶/归档/重命名，归档区隐藏置顶项并切换文案），✎ 独立按钮移入菜单（双击重命名保留），删除保持独立红色 ×；ChatModule/useAgentChat 加 archivedConversations state 并行拉双列表、删除重命名同步、Agent 模型回填查找扩归档列表；归档 info toast 不切视图；i18n 7 key 四语；conversation-repo.test +4 用例，channel-service.test 两处 mock 记录补字段 | typecheck 0 / vitest 135文件1956用例 / build 三端 |
| 2026-09-29 | V4-Iter-17 | 对话导出增强（保真 Markdown + 自包含 HTML + 批量导出）：调研校准单会话 MD/加密导出早已存在但旧实现把消息正文整体 escape 成代码块（排版全丢）、无来源/附件/token。新建 `src/shared/export-markdown.ts` 纯函数模块（主进程/渲染端/测试共用）：buildConversationMarkdown——assistant 正文保真原样、user 逐行 `> ` 引用块包裹（防内容伪造文档结构）、sources 按 docTitle 去重输出「参考来源」（不入片段）、image 附件只列名绝不泄 base64/text 附件 2000 字截断预览、usage token 斜体行、toolCalls 块保留；safeFileName（非法字符替换+全非法/只剩下划线兜底 conversation，替换加密导出内联正则）、dedupeFileNames（重名 -2/-3 序号扩展名分离）、formatSources/formatAttachments/roleLabel 导出；conversations.ts 删旧 renderConversationToMarkdown 等 3 本地函数，EXPORT_MD 换 builder+注入助手名；新建 renderer/utils/export-html.tsx——renderToStaticMarkup 输出 <!doctype> 自包含文档，react-dom/server **动态 import 拆 105KB chunk**（静态 import 曾把主包顶到 1183KB，改后主包 1079KB 未回退 V4-Iter-12 瘦身），内联浅色固定排版 CSS 覆盖失效的 tailwind/CSS 变量（820px 卡片/代码块/表格/引用/来源分区，user 蓝条气泡），XSS 三重防线（Markdown 组件未挂 rehype-raw 裸 HTML 解析层过滤+React 转义+script 注入测试）；主进程新增 CONVERSATION_EXPORT_HTML（渲染端生成主进程选 .html 路径写盘，html zod 限 50MB）与 CONVERSATION_EXPORT_BATCH（openDirectory+createDirectory 选目录、dedupeFileNames 去重、单文件失败不中断计 failed、zod name≤200/content≤50MB/数量 1-500）；preload exportConversationHtml/exportConversationsBatch；UI ConversationList 抽出复用 ExportMenu（absolute 弹层/点外部 Esc 关闭/阻止冒泡，Chat ConvItem 与 Agent SessionItem 共用），会话项 ↓ 改 MD/网页菜单（🔐 加密独立保留），工具栏 📤 批量菜单；ChatModule handleExportHtml+当前助手批量（串行 listMessages、每 10 个让帧防卡、batchBusyRef 防重入、toast 含目录与失败数），AgentPanel 同构（范围=chat.conversations）；i18n 9 key 四语；新增 tests/export-markdown.test.ts 11 用例（保真/引用块结构防护/来源去重/图片不泄 base64/文本截断/usage/文件名兜底与去重/HTML 结构+script 过滤）；踩坑 node 下 renderToStaticMarkup 无需 jsdom | typecheck 0 / vitest 135文件1952用例 / build 三端 |
| 2026-09-29 | V4-Iter-16 | 标签保活与 LRU 休眠（策划书 4.2 active→pinned→dormant→closed 落实保活休眠段 + 补齐固定入口）：app-store 新增不持久化会话态 `mountedModules: ModuleId[]`（LRU 头部最近访问）+ `busyModules: Partial<Record<ModuleId,boolean>>`；导出纯函数 `evictMounted<T>(mounted,{activeId,pinnedIds,busyIds,max=MAX_KEPT_MODULES=4})`（总数超 max 时从非保护候选尾部 LRU 淘汰，active/pinned/busy 豁免，全保护时宁超阈值不淘汰——流式不中断优先于内存）、`pinFirst(tabs)`（pinned 前置保组内顺序，从 reorderTabs 抽出复用）、`reconcileMounted<T>`（关标签后移除无标签孤儿挂载并保证活动模块在列）；actions `touchModule`（激活时 unshift 头部+evict）/`setModuleBusy`（更新 busy，解除时补淘汰）/`togglePin`（置反 pinned+pinFirst 前置）；closeTab/closeOthers/closeRight 返回同步 activeModule（修关闭活动标签后侧栏高亮不同步）与 reconcileMounted 收敛；persist merge 重 hydration 后 mountedModules=[activeMod]/busyModules={}（保活态不持久化）；Workspace 重构——10 段 if 链抽成 ModuleBody 模块映射（chat 直出，其余 lazy+Suspense 外壳原样），从 store 读 mountedModules 为每个已挂载模块渲染容器（活动 `flex-1 min-h-0 flex flex-col`，非活动 `hidden` display:none 保留 DOM/state/滚动/草稿），防御性保证 activeModule 必在挂载集合（兼容 DetachedApp 独立窗口），props moduleId→activeModule；App.tsx activeModule 变化 effect 调 touchModule、TabBar 接 onTogglePin、DetachedApp 同步 props；busy 上报 ChatModule useEffect(liveColumns!==null) 与 AgentPanel useEffect(chat.running) 均经 useAppStore.getState().setModuleBusy（休眠重挂时自动重报纠正）；TabBar 右键菜单加「固定标签/取消固定」（tab.pinned 切文案，置顶 popOut 之上，onTogglePin prop）；i18n tab.pin/tab.unpin 中英日韩四语；新增 tests/app-store.test.ts 11 用例（纯函数 5：evict 未超/尾部淘汰 active 在尾豁免/pinned+busy 豁免全保护不淘汰/pinFirst 组序/reconcile 孤儿移除；actions 5：LRU 移位/超阈值淘汰/pinned 豁免+togglePin/busy 全保护超限+解除补淘/closeTab 卸载孤儿；persist merge 1：stub window.localStorage+resetModules 动态 import 验证仅挂活动模块/pinned 恢复）；踩坑 zustand v5 默认 factory `()=>window.localStorage` 在 node 无 window 时 createJSONStorage 返回 undefined → persist 整体短路（store 正常无 hydrate/api.persist/merge），测试须 stub globalThis.window=globalThis | typecheck 0 / vitest 134文件1941用例 / build 三端 |
| 2026-09-29 | V4-Iter-15 | 会话搜索增强（跳转定位+临时高亮+日期筛选+加载更多分页）：后端 messages.ts MESSAGE_SEARCH handler 加 `dateRange?({from?,to?})` + `offset?` 参数——FTS5 MATCH 与 LIKE fallback 两路径同步加 `m.created_at >= ?` / `m.created_at <= ?` + `LIMIT ? OFFSET ?`，zod schema 校验 `z.object({from,to}).optional()` + `z.number().int().min(0).optional()`；preload searchMessages 签名扩展 `(query, assistantId?, dateRange?, offset?)`；MessageSearchResults 组件加 `hasMore/loadingMore/onSelectMessage/onLoadMore` 四个新 props——消息行点击从 `onSelectConv(convId)` 改为 `onSelectMessage(convId, messageId)`（会话标题仍 onSelectConv），底部「加载更多」按钮（结果数===PAGE=50 时显示，loadingMore 时 disabled + 文案切换）；ConversationList 加日期筛选 chips（全部/近 7 天/近 30 天/自定义 `<input type="date">`×2 from/to，from→new Date().getTime()，to→+86_400_000 含当天全天），搜索 useEffect 依赖加 dateFilter/customFrom/customTo/dateRange，重置 offset + setHasMore(r.length===PAGE)；loadMore 追加 `setResults(prev=>[...prev,...r])` + offset+PAGE；onSelectMessage 透传到 ChatModule；SessionRail 同步适配（onSelectMessage optional fallback onSelectConv + 加载更多 + handleSelectMessage 清 search 态）；ChatView 加 `focusMessageId` prop + `highlightMsgId` state——useEffect 在 messages+renderedTurns+virtualizer 就绪后 `findIndex(t => t.user?.id===focusMessageId || t.replies.some(r=>r.id===focusMessageId))` → `virtualizer.scrollToIndex(idx,{align:'center'})` + `setHighlightMsgId(focusMessageId)` + 2s setTimeout 清除；MessageBubble 加 `highlight` prop（`ring-2 ring-[var(--color-warning)] animate-pulse`），user 和 assistant 气泡调用处传 `highlight={highlightMsgId===msg.id}`；ChatModule 加 `focusMessageId` state + `handleSelectMessage` 回调（切会话 setCurrentConvId+loadMessages+setFocusMessageId），透传 ConversationList onSelectMessage + ChatView focusMessageId；i18n 新增 6 key（searchDateAll/7d/30d/Custom + searchLoadMore/searchLoading）中英日韩四语对齐 | typecheck 0 / vitest 133文件1930用例 / build 三端 |
