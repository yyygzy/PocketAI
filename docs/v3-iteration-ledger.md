# 墨匣 Moxia / PocketAI — V3 迭代与 Bug 修复台账

> 起始：2026-09-23（基于 v1.2.7 产品评测）。本台账登记 V3 周期的产品迭代项、Bug 清单与优化建议，供后续按优先级推进。
> 状态标记：`已修复` / `待决策` / `进行中` / `已规划` / `已落地`

---

## 一、V3 迭代目标

1. 补齐「最后一公里」体验债：可访问性、错误兜底闭环、命名对齐用户预期。
2. 强化便携定位：多设备配置/对话续接、知识库检索增强。
3. 性能与体量：大库虚拟化、向量索引后台化。
4. 生态：技能 SDK 深化、Agent 定时/后台任务。

---

## 二、Bug 清单

### A. 代码级 Bug（2026-09-23 首批修复）

| # | 模块 | 文件 | 现象 | 状态 |
|---|------|------|------|------|
| B1 | Ollama 运行时 | `src/renderer/src/components/OllamaPanel.tsx` `handleStop` | `await stopOllama()` 无 try/catch，IPC reject 变 unhandled rejection，且后续 refresh 不执行 | 已修复 |
| B2 | Ollama 运行时 | `OllamaPanel.tsx` 镜像保存按钮 `onClick` | async onClick 无 try/catch，`setOllamaMirror` reject 变 unhandled | 已修复 |
| B3 | Ollama 运行时 | `OllamaPanel.tsx` 安装/拉取进度条 | `transition-all` 含 transform，与 theme.css「不碰 transform」原则冲突，大宽度跳变可能布局抖动 | 已修复 |

### B. 产品/交互级 Bug（待决策后修）

| # | 模块 | 现象 | 建议 | 状态 |
|---|------|------|------|------|
| B4 | 导航命名 | Sidebar `sandbox`（🧪 沙箱）实为「AI 生成 HTML 应用预览」，与用户「沙箱=跑命令」预期错位 | 改名「应用」/「迷你应用」 | 已落地 |
| B5 | 解锁页 | 无密码可见性切换、无暴力破解防护（连续错误无计数/延时） | 加显隐切换 + 错误计数延时锁 | 已落地 |
| B6 | 对话默认 | `ChatModule` 智能默认仅取首个 enabled provider 的首个对话模型 | 优先回填向导已选 provider | 已落地 |
| B7 | 首启向导 | 选 Ollama 时内嵌 OllamaPanel，安装+启动长流程阻塞向导无法「稍后」 | 加「跳过/稍后配置」出口 | 已落地 |

---

## 三、优化建议

### UI/UX
- **可访问性**（已落地）：emoji 图标按钮普遍缺 `aria-label`（锁屏/折叠/Tab 关闭）；补 aria + 全局 `focus-visible` 样式 + 键盘 Tab 顺序。
- **抽原子类去重**（已落地）：`text-[10px] px-2 py-1 rounded border border-[var(--color-border)]` 反复堆砌，在 `styles.css` 抽 `.chip`/`.tag`/`.badge`。
- **统一 EmptyState/Confirm**（已落地）：已有 `ToastProvider` 与 `ToolApprovalDialog`，补 `<EmptyState>` / `<ConfirmDialog>` 统一各模块空态/确认。

### 工程
- **大列表虚拟化**（已落地）：AgentPanel 消息流 + ChatView 轮次流均引入 `@tanstack/react-virtual` 虚拟滚动。AgentPanel 消息级（V3-Eng-2）；ChatView 轮次级（V3-Eng-3）——移除渐进渲染切片/补渲染/视口恢复，每轮一个虚拟项，只渲染可视区 + overscan=4，复用 virtual-list-utils.ts 的 isNearBottom/shouldStickToBottom 纯函数做滚底决策。
- **流式 ref 收口**（已落地）：`ChatModule` 6 个流式 ref（requestId/finalized/totalColumns/settledCount/focusNonce/streamingConv）+ liveColumns/focusBranch 状态 + 事件订阅逻辑，提 `useStreamSession` hook 内聚，暴露 beginStream/failStream/focusNewBranch/abort/isStreaming 原子操作。
- **i18n 扩展**（已落地）：中英日韩四语完整（ja.ts/ko.ts 各 1221 条，含浏览器语言自动检测 ja-JP/ko-KR、ThemeLangControls 四语切换）；2026-09-29 将 i18n-parity.test.ts 从 zh/en 双语扩展为四语对等校验（key 集合/非空/占位符三不变量全量覆盖 ja/ko）。

---

## 四、V3 迭代方向

1. **多设备配置/对话漫游**（已落地）：BackupPanel 已具备 WebDAV 增量上传/恢复/列表/定时全部能力 + 同步状态卡片（V3-Iter-1）。V3-Iter-2 新增双向合并冲突解决：用户内容表（conversations/messages/notes/images/translations/translation_glossary/sandbox_files）行级合并保留双方新增，配置类表（assistants/providers/skills/mcp_servers/kb_*）云端覆盖，本地敏感表（app_config/field_keys/license_records/schema_migrations）不动；冲突时弹窗让用户选择保留云端/本地/较新策略；附件按 sha256 去重下载。
2. **知识库检索增强**（已落地，2026-09-29 复核确认）：混合检索（向量 + BM25）+ 重排 + 引用溯源展示（消息内联来源块）。复核发现该方向在 v2 周期已完整实现、台账登记滞后——rag.ts 双路检索 + RRF 融合、kb_chunks_fts FTS5 表 + 触发器同步、reranker.ts LLM rerank + mmr.ts MMR、另有 HyDE；chat-service/agent engine 检索后 sources 落库（v19 migration messages.sources 列）并经 ChatDoneEvent 传至 MessageBubble 可折叠来源块。
3. **Agent 定时/后台任务**（已落地，2026-09-29 复核确认）：commit b051174 新增 `src/main/backup/task-scheduler.ts` 通用定时调度器——启动 60s 后首跑、每 10min tick、按任务独立间隔（app_config `task.*.last_run_at` 持久化）执行：kb_health_check（6h，修复卡在 pending/parsing/indexing 超 1h 的文档）与 backup_verify（24h，下载最新备份校验 sha256/增量索引格式）。quit-manager 注册停止。
4. **插件/技能 SDK**（已落地，2026-09-29 复核确认）：commit b051174 SDK v1——skill-parser 扩展 frontmatter 元数据（version/author/tags/category，白名单同步扩容），新增 validateSkillText（含缺 description/content 过短/默认 icon 三类警告）与 SKILL_TEMPLATES（通用/代码/翻译三模板）；IPC 新增 SKILL_VALIDATE/SKILL_TEMPLATES，SkillModule 增加校验与从模板创建 UI。
5. **性能与体量**（已落地）：大库虚拟化（V3-Eng-2/3）+ 向量索引重建后台化（commit b051174：新增 `src/main/knowledge/index-queue.ts` 顺序任务队列，KB_DOC_ADD_FILE/URL/TEXT/REINDEX 全部入队即返不再阻塞 IPC；KnowledgeModule 2s 轮询文档状态，pending/parsing/indexing 全部结束后自动停止）。
6. **移动伴侣**（暂缓，2026-09-29 本轮跳过）：便携盘 + 桌面已成型，移动端只读查看/轻交互作为 v2 差异化。待定形态：导出静态 HTML 查看器 / 本地 LAN Web 服务 / 加密备份包移动端解密查看（DB 为应用层字段加密非 SQLCipher，手机读库需走导出格式而非直接读 app.db）。

---

## 五、变更记录

| 日期 | 批次 | 内容 | 验证 |
|------|------|------|------|
| 2026-09-23 | V3-BugBatch-1 | B1/B2/B3 修复（OllamaPanel 错误兜底 + 进度条过渡） | typecheck 0 / vitest / build 三端 |
| 2026-09-23 | V3-BugBatch-2 | B4/B5/B6/B7 落地：侧栏 sandbox 改名「应用工坊」(🧩，内部 id 不变)；UnlockPage 密码显隐切换 + 连续错误指数退避（≥5 次起锁，1s→2s→4s→…→30s）；新增 wizard.last_provider_id 持久化 + ChatModule 优先回填向导已选 provider；向导 Ollama 分支加「稍后配置」出口（不阻塞前进） | typecheck 0 / vitest 18文件300用例 / build 三端 |
| 2026-09-23 | V3-A11y-1 | UI 可访问性加固：styles.css 新增全局 `:focus-visible` 轮廓（覆盖此前多处 `outline:none` 缺口，键盘 Tab 焦点可见，鼠标点击不触发）；8 文件纯图标/符号 button 补 `aria-label`（复用现有 i18n key，不新增）—— Sidebar 模块/锁屏/折叠、TabBar 关闭/新建、BranchNav 前后/对比、ThemeLangControls 主题切换、ConversationList ConvItem 导出/导出加密/重命名/删除、ModelSelector 移除/全加、AssistantRail 编辑。有可见文字的 button 不补（遵循 WCAG 2.5.3 Label in Name）。Tab 顺序无缺口（DOM 自然，draggable 不影响 focus） | typecheck 0 / vitest 18文件300用例 / build 三端 |
| 2026-09-23 | V3-UI-1 | 原子类去重：styles.css 新增 `.chip`/`.badge`/`.tag` 三类公共组件（尺寸与 Tailwind spacing 对齐：py-0.5=2px px-1.5=6px rounded=4px；.chip 11px+hover 变体 accent/danger，.badge 10px+语义配色 accent/muted/overlay/info，.tag 10px+border）。9 文件 13 处完全匹配的原子类堆砌替换为公共类—— MessageBubble 7 处（chip/chip-accent×5/chip-danger）、CopyButton 默认+ComparisonColumns+AssistantMarket 2+AssistantEditor+StewardModule+SkillModule+SandboxModule+ModelSelector。9px badge、动态 cls、px-2 py-1 差异化用例保留未强行替换（避免尺寸误匹配） | typecheck 0 / vitest 18文件300用例 / build 三端 |
| 2026-09-23 | V3-UI-2 | 统一 EmptyState/Confirm：新增 `components/EmptyState.tsx`（message/icon/action/className，收口散布的 text-muted text-center 纯文本空态）+ `components/ConfirmDialog.tsx`（含 `useConfirm()` hook，Promise 式调用替代原生 window.confirm——Electron 内样式突兀且阻塞渲染进程；保持原 `if (!await confirm(...)) return` 控制流）。7 处空态替换为 EmptyState（FilesModule×2/ConversationList×3/SettingsModule×2，传原 className 保视觉）；15 处 window.confirm 替换为 useConfirm（ImageModule/FilesModule/KnowledgeModule×2/NotesModule/SettingsModule×6 分布于 4 子组件/TranslateModule/ChatModule/SkillMarket/SkillModule），danger 按破坏性语义标注（delete/remove/clear/restore 类 danger，restartConfirm/visionWarn 默认），每组件渲染 `{dialog}`。复用 common.confirm/common.cancel，0 新增 i18n | typecheck 0 / vitest 18文件300用例 / build 三端 |
| 2026-09-23 | V3-Eng-1 | 流式 ref 收口：新增 `modules/chat/useStreamSession.ts`，将 ChatModule 散落的 6 个流式 ref（requestId/finalized/totalColumns/settledCount/focusNonce/streamingConv）+ liveColumns/focusBranch 两个状态 + onChatChunk/onChatDone/onChatError 订阅 + markSettled/finalize（含 200ms 延时与卸载 timer 清理）全部内聚于 hook。暴露原子操作：`beginStream(convId, targets)→requestId|null`（含忙时守卫，send/regenerate/resend 共用）、`failStream(requestId, convId)`（IPC reject 兜底，内部 requestId 校验防误清）、`focusNewBranch(turnKey, batchId)`（nonce 自增发分支聚焦信号）、`abort()`、`isStreaming()`（ref 直读，handler 内安全调用）。opts 经 optsRef 注入避免流式期反复重订阅丢 chunk。ChatModule 拆分原混合 effect：init 加载（providers/assistants，deps [reloadConversations]）与流式订阅（移入 hook，deps []）分离；解构取稳定回调入 useCallback 依赖（避免对象引用致每渲染重建，保 handleResend 原稳定性）。行为不变：多列对比/分支聚焦/abort/错误兜底/200ms finalize 延时/卸载清理全保留 | typecheck 0 / vitest 18文件300用例 / build 三端 |
| 2026-09-23 | V3-Eng-2 | AgentPanel 消息流虚拟化：引入 `@tanstack/react-virtual` ^3.14.13（devDependencies，纯 JS 无原生二进制不增 asarUnpack）；新增 `modules/agent/components/VirtualMessageList.tsx`（useVirtualizer + measureElement 动态高度 + overscan=6 + estimateSize 60 兜底 + pb-2 模拟原 space-y-2 项间距）+ `virtual-list-utils.ts` 纯函数（isNearBottom/shouldStickToBottom，用历史 wasAtBottom 决策避免竞态抖动）+ `tests/virtual-list-logic.test.ts`（9 用例）。改造 AgentPanel 替换原 `messages.map` 全量渲染为 `<VirtualMessageList>`。滚底逻辑：流式追加时若用户在底部锚定区则跟滚，用户主动向上滚后停止跟滚；切会话用 pendingScrollBottomRef 标记待 messages 加载后一次性滚底，避免误跟滚。ChatView 渐进渲染保留，升级为真虚拟化留作下一任务 | typecheck 0 / vitest 19文件309用例 / build 三端 |
| 2026-09-23 | V3-Iter-1 | 多设备对话漫游 MVP：BackupPanel 加「同步状态卡片」（仅 cfg 已配置时渲染）——两列对比本地最新（schedule.lastRunAt）与云端最新（webdavList 中 mtime 最大值）+ 对比结论行（本地较新建议上传 / 云端较新建议恢复 / 已同步）+ 主按钮「立即同步」（复用 uploadIncrementalBackup）+ 云端 newer 时次按钮「从云端恢复」（取 mtime 最大备份调 doRestore，含现有 confirm 破坏性确认）。refreshList 改 useCallback([t]) 稳定化 + 新增 formatSyncTime([t,lang]) + 自动拉取 effect（cfg 加载后自动 refreshList，免手动点刷新）。10 个 bk.sync* i18n key 中英对齐。无主进程改动，纯渲染层增强 | typecheck 0 / vitest 19文件309用例 / build 三端 |
| 2026-09-23 | V3-Eng-3 | ChatView 轮次级虚拟化：移除渐进渲染（INITIAL_TURN_COUNT=30 切片 + 向上滚补渲染 + 视口恢复 + 顶部「加载更早」按钮 + bottomRef.scrollIntoView），改为 useVirtualizer 每轮一虚拟项（复用 V3-Eng-2 模式：measureElement 动态高度 + overscan=4 + estimateSize 200 兜底 + paddingBottom:24 模拟原 space-y-6 项间距）。滚底逻辑复用 isNearBottom/shouldStickToBottom 纯函数 + isAtBottomRef 历史状态 + pendingScrollBottomRef 切会话待滚底标记。emptyHint（renderedTurns.length===0）early return 渲染欢迎块。删 chat.loadEarlier i18n 死键（zh/en parity 保持，i18n-parity 测试通过）。保留 turns/renderedTurns 数据层、selectedIds/activeBranchMap/compareTurns 状态、focusBranch effect、分支/对比/多选交互全不变。「大列表虚拟化」工程项部分落地→已落地（AgentPanel 消息级 + ChatView 轮次级全量收口） | typecheck 0 / vitest 19文件309用例 / build 三端 |
| 2026-09-23 | V3-Iter-2 | 多设备对话漫游——双向合并冲突解决：新增 `src/main/backup/merge-service.ts`，核心能力为 scanMergeConflicts（下载云端备份到临时 DB，逐表统计 cloudOnly/localOnly/both）与 executeMerge（按策略执行合并）。表分类：用户内容表（conversations/messages/notes/images/translations/translation_glossary/sandbox_files）行级合并——云端独有插入、本地独有保留、同 id 内容不同按策略取舍（local/cloud/newer，newer 按 updated_at/created_at 时间戳）；配置类表（assistants/providers/skills/mcp_servers/knowledge_bases/kb_documents/kb_chunks）云端覆盖；本地敏感表（app_config/field_keys/license_records/schema_migrations）不动。附件按 sha256 去重下载缺失文件。支持全量 zip 与增量索引两种备份格式，加密备份用当前 masterKey 解密。IPC 新增 BACKUP_WEBDAV_MERGE_SCAN / BACKUP_WEBDAV_MERGE_EXECUTE，预加载暴露 mergeScanWebDAVBackup / mergeExecuteWebDAVBackup。BackupPanel 同步状态卡片与备份列表各加「合并」按钮，点击后先扫描冲突展示各表新增/冲突统计，再弹窗让用户选策略（保留云端/保留本地/保留较新）。backup-service.ts 导出 ENC_PREFIX/toCreds/isEncryptedBlob/decryptBackup/IncrementalIndex 供复用。新增 tests/merge-service.test.ts（13 用例，内存 DB 验证 scanTableConflicts/mergeTable/overwriteTable） | typecheck 0 / vitest 20文件322用例 / build 三端 |
| 2026-09-29 | V3-Review-1 | 台账复核：发现 commit b051174（feat(v3)）已实现方向 2/3/4/5 与 i18n 扩展但台账未同步——方向 2 混合检索为 v2 周期成果；方向 3 task-scheduler（kb_health_check 6h + backup_verify 24h）；方向 4 技能 SDK v1（校验 + 三模板 + frontmatter 元数据）；方向 5 index-queue 后台化 + KnowledgeModule 轮询；i18n 日韩四语（ja/ko 各 1221 条 + 语言检测）。逐一验证证据链后全部标记已落地。顺带修复缺口：i18n-parity.test.ts 从 zh/en 扩展为四语对等校验 | typecheck 0 / vitest 121文件1841用例 / build 三端 |
