# 本地知识库升级方案（2026-11-26）

目标是提升“用户以为知识库能用、实际检索静默退化”的可发现性，再逐步改善短查询与结构化文档检索。方案按阶段推进，每阶段独立可验收。

## 阶段 1：变更检测 → 重建闭环（当前执行）

- 配置变更：Embedding 模型/provider、分块大小、分块重叠任一变化，都标记为需重建，并返回受影响文档数。
- 源文件变更：复用 `checkKbFileUpdates()` 的 `changed/missing` 结果，不自动重建，只给出用户可见提示与一键入口。
- UI：知识库详情页展示统一提示条，支持“重建全部/处理源文件变更”，并在成功后清除提示。
- 验收：配置变更判定纯函数测试 + IPC 返回结构测试 + 详情页提示交互测试；`npm run typecheck` 通过。
- 兼容：只增加提示与返回字段，不改检索排序、不改向量协议、不自动重建。
- 进度（2026-11-26）：已完成。主进程新增 `reindex-detection.ts` 纯函数（embedding provider/model + chunkSize/chunkOverlap，含旧库无维度兼容），`KB_SAVE` 返回 `needReindex` / `needReindexDocCount` 与兼容字段 `embeddingChanged` / `chunkingChanged`；详情页新增统一提示条，支持「重建全部文档 / 稍后处理 / 处理源文件变更」，成功后自动清除、切库不串台。
- 验收（2026-11-26）：`tests/knowledge-reindex-detection.test.ts`（10）与 `tests/renderer-kb-reindex-notice.test.tsx`（5）通过；知识库/i18n 回归 50/50 通过；`npm run typecheck` 通过。

## 阶段 2：中文 1–2 字 BM25 补齐

- 为短 CJK 查询增加 bigram/unicode61 辅助 FTS 路径，与现有 trigram 路并行进入 RRF。
- 需要索引回填/迁移；先做离线评估，确认不会显著拉低长查询排名。
- 验收：真实 FTS 表短查询命中测试 + 长查询回归对照。
- 进度（2026-11-26）：已完成。migration v79 新建 `kb_chunks_fts_short`（unicode61）并回填存量 chunk、补齐三个同步触发器；`dbService.open()` 注册 `cjk_spaced` SQL 函数；`fts-query.ts` 新增 `cjkSpacedText()`（索引侧 CJK 单字展开）与 `buildShortFtsMatchQuery()`（只给 1–2 字段/短拉丁词产出相邻短语，≥3 字仍只走 trigram）；`bm25Search()` 两路并行、按 chunkId 去重取较大分。RRF 与检索排序不动，长查询排名口径不变。
- 验收（2026-11-26）：`tests/fts-query.test.ts`（20）与 `tests/kb-bm25-short-real-db.test.ts`（7）通过，覆盖真实 FTS5 单字/双字命中、v79 回填与触发器、长查询与旧逻辑逐条一致；检索/迁移回归 87/87 通过；`npm run typecheck` 通过。

## 阶段 3：CSV/XLSX 结构化检索

- CSV/XLSX 解析产出“列名: 值”的行式文本，保留 sheet 前缀。
- 分块按行/表头边界切，避免切断列值关系；保留纯文本回退。
- 验收：真实 csv/xlsx 解析分块测试，关键词与表头同块可命中。
- 进度（2026-11-26）：已完成。`KbSourceType` 新增 `csv`，CSV 文件不再被误判为手工文本而卡在 `getRawText`；旧版本误判为 txt 的存量 CSV 按真实扩展名重判。`parseXlsxBytes` / 新增 `parseCsvBytes` 产出 `# sheet名/文件名` 前缀 + 每行「列名: 值 | 列名: 值」；支持 BOM、引号内逗号与双引号转义；无有效数据行回退平铺 CSV / 原始纯文本。`chunker.ts` 新增 `chunkTableLines()`：行式表格按整行切、重叠按整行回退，单行超预算时独占一块；`chunkMarkdown()` 按内容形态自动选择，非表格仍走原字符窗口。
- 验收（2026-11-26）：`tests/kb-table-structured.test.ts`（真实 CSV/XLSX 解析、表头与关键词同块、整行不切断、纯文本回退）通过；解析/分块/摄取相关 61/61、来源类型与检索回归 69/69 通过；`npm run typecheck` 通过。

## 阶段 4：评测闭环补齐

- 增加引用覆盖率和缺失来源清单，沿用现有 `kb-eval-runner.ts` 的判分口径。
- 只新增指标，不改排序。
- 验收：扩展评测判分纯函数测试。
- 进度（2026-11-26）：已完成。`src/shared/kb-eval.ts` 新增 `sourceCoverageAtK`（micro：总命中期望来源 / 总期望来源，与 macro `recallAtK` 同判分口径、聚合方式不同）与 `missingSources`（`caseId + docId[#seq]` 的跨用例缺失清单，按卷子/expected 原序）；均从既有 `evaluateCase` 的 `matched/missing` 派生，不改判据、不改排序。运行器透传清单，面板新增覆盖率/缺失条数指标与聚合清单（前 20 条），四语同步。
- 验收（2026-11-26）：`tests/kb-eval.test.ts`（纯函数）与真库运行器断言覆盖 micro/macro 分化、清单顺序与 seq 保留、k 变化同步；评测/面板/i18n 54/54 通过，追加真库 35/35 通过；`npm run typecheck` 通过。

## 阶段 5：自动同步与性能验证

- 将源文件变更检测接入后台调度（只检测、不自动重建）。
- 用真实大库验证 JS KNN 兜底、sqlite-vec 分批和向量写入性能。
- 验收：调度用例 + 真机性能记录。
- 进度（2026-11-26）：已完成。`MaintenanceTaskKey` 新增 `kb_source_sync`（默认 6h），逐库调 `checkKbFileUpdates()` 汇总 changed/missing 写入 `app_config.kb.sourceSync.lastResult`，并记 perf `kb.sourceSync`；**只检测、不重建**，单库失败不拖垮整轮。`getLastSourceSyncScan()` 读回结果（坏 JSON 当没扫过）；`kb-vec.repo.ts` 抽出 `chunkRowids()`（32000/批，低于 SQLite 32766 bind 上限）。
- 真机性能记录（2026-11-26，3000 chunk / dim=8 / 本机 sqlite-vec 可用）：

  | 操作 | 耗时 | 备注 |
  | --- | --- | --- |
  | 3000 chunk 向量写入 | 1259.6 ms | `insertMany` 全量入库 |
  | BM25 全文检索 top20 | 18.3 ms | 两路 FTS 合并 |
  | JS KNN 兜底 top20 | 22.1 ms | 强制 `isVecEnabled()=false` |
  | sqlite-vec KNN top20 | 1836.0 ms | 首次查询含表加载开销；8 维小向量下慢于 JS 兜底，需更大维度/更多轮复测才能定论，不据此下"原生更快"的结论 |

- 验收（2026-11-26）：`tests/task-scheduler.test.ts`（36，含 3 个新用例钉住"只检测不重建"、坏 JSON、单库异常）与 `tests/kb-perf-large.test.ts`（4，`tests/kb-vec-batch.test.ts` 5）通过；`npm run typecheck` 通过。
- 闭环补齐（2026-11-26）：后台扫描结果已挂到 `DataHealthReport.sourceSyncScan`（可选字段，复用 `DATA_HEALTH_GET` 通路，无需新 IPC），由 `getDataHealthReport()` 调 `getLastSourceSyncScan()` 汇总；数据健康面板维护任务区新增第三行，展示最近扫描时间 +「变更数 / 库数」与该任务开关。旧报告缺该键时按「从未运行」显示，四语文案同步。知识库详情页的手动检查 + 提示条仍是阶段 1 的即时入口。

## 长期项

- 向量模型可切换与在线迁移。
- 表格原生索引。
- 稳定 chunk ID / 跨重建引用。
- 知识库权限分级与 ACL。
- 扫描版 PDF OCR 与本地离线 OCR。
