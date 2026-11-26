# 技能模块升级方案（2026-11）

## 背景与现状

技能模块地基已经扎实：JSON/MD 双解析、JSON/MD frontmatter 白名单、装前静态扫描、导入审计、目录包 sha256 + Ed25519 验签、两级披露（resident / load_skill）、常驻 32KB 预算、能力中心与绑定管理都已具备。

> 状态回写（2026-11-26）：下面这份“缺口清单”是方案创建时的历史快照；五阶段已全部完成并推送，逐项结果见文末“进度记录”。其中脚本执行限定为 JS 浏览器沙箱，OS 级沙箱/网络白名单/资源限额仍明确未做。

但对照 Anthropic Agent Skills 生态（2025-12 起 SKILL.md 成为跨 16+ 工具的开放标准）仍有结构性缺口：

- `SkillRecord` 无版本/来源/内容哈希；`SkillShape` 解析了 `version/author/license` 却丢弃；每次导入生成新 UUID，重复导入产生同名副本，无法更新/回滚/锁定版本（`docs/skill-source-research-2026-11.md:131,145`）。
- 无运行时自动触发：只按助手绑定全量注入或指针，模型不按任务描述自主选择技能。
- 脚本只存不执行：目录包可含 `scripts/references/assets`，但 `load_skill(path)` 只读文本、拒二进制；`allowed-tools` 忽略（安全上正确，功能上缺失）。
- 在线只支持单文件 URL，远程目录包/registry 不在位；扫描结果导入后展示、不阻断。
- 技能正文无法结构化引用 KB / MCP 工具。

本方案分五阶段，**先治理（低风险）、再能力（中风险）、最后生态（高风险）**。每阶段独立可验收，不改安全边界除非显式标注。

---

## 阶段 1：版本 / 来源 / 内容哈希 / 回滚（已完成）

**目标**：让技能有身份、有版本、有来源，能识别“同一技能的更新”而不是产生副本，能回滚到上一版。

**范围**：
- `SkillRecord` 新增 `version / author / license / sourceUrl / sourceCommit / contentHash / installedAt`；`contentHash` 复用 `skill-package.ts` 的既有 sha256 口径（name/description/icon/content/category/tags，不重造），目录包资源仍由包内 sha256 清单独立校验。
- DB 迁移加列（老库全部为空/默认值，行为不变）；`SkillShape` 解析出的元数据不再丢弃。
- 导入策略：以 `sourceUrl`（单文件/目录 URL）为身份键——同来源再次导入时**更新同一条记录**并把旧内容存入 `skill_versions` 历史表，而不是再建 UUID；无来源的手工技能仍按原行为新建。
- 回滚：历史表按 `skillId + importedAt` 倒序保留最近 N 版（建议 N=5），UI 提供“恢复到上一版”（写回正文/元数据、记录审计）。
- 不自动更新：来源变化只提示“有新版本”，用户确认才拉取/导入（沿用扫描 + 确认口径）。
- UI：技能详情展示版本/作者/许可证/来源/安装时间；导入结果与扫描报告显示“更新了哪一技能、从哪版到哪版”。

**兼容**：旧技能元数据为空，UI 显示“未记录”，不阻断；内置技能元数据来自 extensions/skills 文件，继续只读。

**验收**：DB 迁移与仓储单测（真库）；导入同来源更新而非副本、保留历史；回滚恢复正文；类型检查与既有技能测试全绿。

---

## 阶段 2：对齐 SKILL.md 标准 + 元数据落库（已完成）

**目标**：接受标准 `SKILL.md` 作为一等输入格式，减少互操作摩擦。

**范围**：JSON 导入继续保留；Markdown 导入兼容 `SKILL.md` 文件名与 kebab-case 目录规范；frontmatter 支持 `metadata.author` 等嵌套标量的常见误写兼容；`version/author/license` 落库（阶段 1 已完成字段）；正文 >500 行给出“建议拆分到 references/”的软警告（不阻断，沿用现有大小限制）。

**验收**：标准 SKILL.md 样例导入测试；元数据落库断言；软警告 UI 测试。

---

## 阶段 3：运行时技能路由 + 描述质量检查（已完成）

**目标**：从“全量注入绑定技能”走向“按任务描述选择技能”，对齐业界 description 决定触发的机制。

**范围**：候选技能 description 作为路由输入，选出 top-N 注入正文、其余给指针；路由可用向量相似度或一次小模型调用（做成可配置开关，默认关，灰度开启）；`load_skill` 保持不变作为兜底。新增“描述质量检查”：缺 when-to-use、过短、与另一技能高度相似时告警；配套一组 activation eval 固定 prompt 在 CI 跑触发准确率。

**安全**：路由只改变“注入哪些文本”，不扩大任何工具权限。

**验收**：路由纯函数单测 + 开关关闭时的回归对照；activation eval 基线记录。

---

## 阶段 4：references / assets 按需读取（已完成）

**目标**：让目录包里的参考文件真正可用，而不是只存不读。

**范围**：`load_skill(path)` 从“只读正文”扩展为“按白名单相对路径读 `references/**` 与 `assets/**` 文本文件”；路径规范化与越界防护（禁止 `..`、绝对路径、符号链接逃逸）；二进制继续拒读；资源清单在 UI 可点开预览。

**安全**：只加只读文件访问，不加执行、不加网络；沿用目录包 sha256 清单校验。

**验收**：路径穿越攻击用例、按需读取真库测试、UI 预览测试。

---

## 阶段 5：沙箱脚本执行（已完成：JS 浏览器沙箱范围）

**目标**：让依赖 `scripts/` 的上游技能在明确边界内可运行。

**本次落地**：不新建 OS 子进程，也不宣称容器隔离；只执行安装清单内 `scripts/**/*.js|mjs|cjs`，复用既有 `js_eval` 浏览器沙箱（无 Node / 无 preload / 无文件系统 / 无网络 / 5s 超时 / 2000 字输出上限）。`shell` / `python` / `bat` / `sh` 明确拒绝，等待单独的安全评审与 OS 沙箱能力后再做。

**边界与授权**：默认关闭（`skill_script_enabled`），开启后仍为 `confirm + forceConfirm`，每次逐次批准；脚本必须在隐藏安装清单里且 sha256 复验通过；参数限 JSON 对象且 ≤8192 字符；`allowed-tools` 不自动提权。

**验收**：默认关闭/逐次确认、清单外与非 JS 拒绝、篡改/新增/软链/路径越界拒绝、args 越界拒绝、跨平台路径冒烟；沙箱自身的无 Node/无网络/超时由既有 `js-eval` 用例覆盖。三平台配置说明见 `docs/skill-script-sandbox-2026-11.md`。

**未做（需单独评审）**：独立子进程/容器、可白名单域名网络、只读挂载 + 临时可写目录、CPU/内存限额、外发目标审计。这些不能靠 Node 子进程假称沙箱，故不塞进本批。

---

## 排期建议（已执行完毕，保留原顺序）

1. **阶段 1（治理）**：低风险、用户可感知强，先做。
2. **阶段 2（标准化）**：与阶段 1 数据模型天然衔接。
3. **阶段 3（能力）**：需评估模型调用成本，灰度。
4. **阶段 4（资源）**：低风险但依赖阶段 1 的资源清单哈希。
5. **阶段 5（脚本）**：最高风险，必须单独评审。

本方案的原则：不把上游扫描通过当安全证明；技能永远不能扩大工具权限；自动更新必须用户确认；所有外部内容继续带 `EXTERNAL_CONTENT_NOTICE`。

## 进度记录

- 2026-11-26：方案创建；阶段 1 开始执行。
- 2026-11-26：阶段 1 完成并通过验收。
  - 数据层：v80 迁移为 `skills` 增加版本/作者/许可证/来源/commit/哈希/安装时间字段，并新建 `skill_versions` 历史表与索引。
  - 仓储层：同来源（`sourceUrl`，审计口径去掉查询串/锚点）再次导入视为更新；实质内容变化自动留快照，最多保留 5 版；支持回滚；内置技能锁定且无历史。
  - 导入层：`version/author/license` 从 `SkillShape` 落库；URL/远程目录导入记录来源；`contentHash` 复用 `skill-package.ts` 校验和。
  - IPC/UI：`skill:list-versions` / `skill:rollback` 打通；详情页展示元数据与历史版本，确认后回滚并刷新；四语文案补齐。
  - 验证：`npm run typecheck` 通过；技能专项 27 文件 / 240 测试通过；最终全量 734 文件 / 7776 测试通过（1 文件 / 2 测试跳过）；`read_lints` 无新增问题。
  - 收尾：修正回滚确认框未挂载的 UI 缺陷；补登 waitFor / truncate 闸门；同步 `csv` 源类型与远程导入仓储桩等既有测试口径。
- 2026-11-26：阶段 2 完成并通过验收。
  - 解析：Markdown 走标准 `SKILL.md` 形状；`metadata.author/license/version/category` 在顶层缺字段时补位，显式顶层字段始终优先；`metadata` 容器本身不再误列为“本应用不执行”，未知子键按 `metadata.<key>` 单独报出。
  - 导入：文件 / 目录 / URL 继续接受 `.md` 与标准 `SKILL.md`；kebab-case 目录名按原入口规则读取，不拿目录名充当技能名；标准样例导入后真库读回 version/author/license/来源/commit/哈希/安装时间。
  - 软提示：正文超过 500 行新增 `LONG_BODY_SPLIT_HINT`（info 事实块），四语文案与扫描报告同步；只给“建议拆分到 references/”，不阻断、不改 8KB/32KB 上限。
  - 验证：`npm run typecheck` 通过；阶段 2 专项 6 文件 / 102 测试通过；最终全量 735 文件 / 7786 测试通过（1 文件 / 2 测试跳过）；`read_lints` 无新增问题。
- 2026-11-26：阶段 3 完成并通过验收。
  - 开关：新增 `skill_routing_enabled`（缺省关闭）与 `skill_routing_top_n`（缺省 3，收敛到 1..10）两个 app_config 键；路由配置读取失败一律退回关闭，灰度开关不把正常对话带崩。
  - 路由：`src/shared/skill-routing.ts` 用中英混合 token 重叠打分，同分保持绑定顺序；top-N 给全文，其余在有 `load_skill` 时给指针、无工具时省略并记入 `deferred`。仅改变注入哪几段正文，不改任何工具权限。
  - 接线：普通聊天与 Agent 都把本轮用户消息作为 `taskDescription` 传入；开关关闭时 `buildSkillsContext` 输出与阶段 2 逐字一致，§236 两层披露不变。
  - 描述质量：解析/校验屏提示 description 过短与缺 when-to-use；共享 `auditSkillDescriptions` 额外做两两相似检查，技能详情页新增"描述质量"面板，四语文案齐全。
  - 评测：`tests/fixtures/skill-activation-eval.json` 固化 8 条 prompt，CI 基线 8/8@1、8/8@2；阈值守住 top-1 ≥ 75%、top-N ≥ 87.5%。
  - 验证：`npm run typecheck` 通过；阶段 3 核心专项 6 文件 / 73 测试、UI/i18n 专项 7 文件 / 39 测试通过；最终全量 738 文件 / 7804 测试通过（1 文件 / 2 测试跳过）；`read_lints` 无新增问题。
- 2026-11-26：阶段 4 完成并通过验收。
  - 白名单：`load_skill(path)` 与 UI 清单只开放 `references/**` / `assets/**` 文本文件；`scripts/**` 仍随包保存但不给读、不给预览按钮。
  - 防护：词法越界/NUL/绝对路径 → realpath 实路径仍须在本技能目录（父目录软链也挡住）→ 安装时逐文件 sha256 隐藏清单在读取时复验 → 全缓冲区 NUL + 严格 UTF-8 拒二进制。旧包无清单时可读但标"未校验"。
  - 接线：新增 `skill:read-file` IPC 与 preload 方法；技能详情页文件清单可点开只读模态，展示路径、内容、截断/校验状态与读失败原因，四语文案齐全。
  - 安全：只读，不执行、不联网；不改目录包大小/文件数上限；删技能仍整目录清理（含隐藏清单）。
  - 验证：`npm run typecheck` 通过；阶段 4 专项 6 文件 / 46 测试通过；最终全量 740 文件 / 7814 测试通过（1 文件 / 2 测试跳过）；`read_lints` 无新增问题。
- 2026-11-26：阶段 5 完成并通过验收（JS 浏览器沙箱范围）。
  - 工具：新增 `run_skill_script`（`skill.run_script`），归 skill 组；默认 `deny`，`skill_script_enabled=1` 后才变 `confirm`，且 `forceConfirm:true`，每次逐次批准。
  - 执行：只认隐藏安装清单里的 `scripts/**/*.js|mjs|cjs`，读取时 sha256 复验；`shell`/`python`/`bat`/`sh` 明确拒绝，不造 OS 级假沙箱。
  - 沙箱：复用 `js_eval` 的隐藏 BrowserWindow（无 Node、无 preload、无网络、无文件系统、5s 超时、2000 字输出上限），支持 Agent `AbortSignal`；args 限 JSON 对象且 ≤8192 字符。
  - 文档：新增 `docs/skill-script-sandbox-2026-11.md`，列清三平台无需额外系统配置的原因、路径归一化冒烟点与未做的 OS 沙箱范围。
  - 验证：`npm run typecheck` 通过；阶段 5 工具/注册表专项 5 文件 / 86 测试通过；最终全量 741 文件 / 7821 测试通过（1 文件 / 2 测试跳过）；`read_lints` 无新增问题。
