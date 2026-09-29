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

### V4-Iter-2 启动性能优化（暂缓）

- 2026-09-29 用户跳过，未开始调研/编码。原计划：USB 冷启动痛点，先埋点测启动各阶段耗时，再分阶段/惰性化优化。候选优化点：窗口创建时序、db 迁移开销、kb/ollama/mcp 等模块惰性化。留作后续批次可重启。

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
