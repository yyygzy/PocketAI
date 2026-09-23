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
- **可访问性**：emoji 图标按钮普遍缺 `aria-label`（锁屏/折叠/Tab 关闭）；补 aria + 全局 `focus-visible` 样式 + 键盘 Tab 顺序。
- **抽原子类去重**：`text-[10px] px-2 py-1 rounded border border-[var(--color-border)]` 反复堆砌，在 `styles.css` 抽 `.chip`/`.tag`/`.badge`。
- **统一 EmptyState/Confirm**：已有 `ToastProvider` 与 `ToolApprovalDialog`，补 `<EmptyState>` / `<ConfirmDialog>` 统一各模块空态/确认。

### 工程
- **大列表虚拟化**：长对话/大知识库未见虚拟化，消息多时性能退化，引入虚拟滚动。
- **流式 ref 收口**：`ChatModule` 6 个 ref 管理流式状态偏散，提 `useStreamSession` hook。
- **i18n 扩展**：中英完整，可扩日韩。

---

## 四、V3 迭代方向

1. **多设备配置/对话漫游**：WebDAV 备份已有，补「配置同步 + 对话跨设备续接」，便携盘插哪台都能续。
2. **知识库检索增强**：混合检索（向量 + BM25）+ 重排 + 引用溯源展示（消息内联来源块）。
3. **Agent 定时/后台任务**：已有子任务编排 + 渠道分发，加定时触发（每日知识库同步、定时备份校验）。
4. **插件/技能 SDK**：技能市场已有，开放第三方 skill 开发规范形成生态。
5. **性能与体量**：大库虚拟化 + 向量索引重建后台化。
6. **移动伴侣**：便携盘 + 桌面已成型，移动端只读查看/轻交互作为 v2 差异化。

---

## 五、变更记录

| 日期 | 批次 | 内容 | 验证 |
|------|------|------|------|
| 2026-09-23 | V3-BugBatch-1 | B1/B2/B3 修复（OllamaPanel 错误兜底 + 进度条过渡） | typecheck 0 / vitest / build 三端 |
| 2026-09-23 | V3-BugBatch-2 | B4/B5/B6/B7 落地：侧栏 sandbox 改名「应用工坊」(🧩，内部 id 不变)；UnlockPage 密码显隐切换 + 连续错误指数退避（≥5 次起锁，1s→2s→4s→…→30s）；新增 wizard.last_provider_id 持久化 + ChatModule 优先回填向导已选 provider；向导 Ollama 分支加「稍后配置」出口（不阻塞前进） | typecheck 0 / vitest 18文件300用例 / build 三端 |
