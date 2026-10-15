# 本地 Agent 改造方案与验证方案：中心管控 + 多角色协作 + 显存错峰

状态：待评审（未开工）。依据 = 2026-10-15 源码回读 + 本机三探针实测（GTX 1050 Ti 4096MiB / Ollama 0.33.1）。
关联：`docs/v4-iteration-ledger.md`（实施后逐条回填）、`docs/verify-checklist.md`（验收行从 **B72** 起，不重排）。

---

## 0. 目标与不做什么

**目标**：让 agent 的编排形状由**本机环境**决定，而不是由"我们假设用户有一张好卡"决定；并把已经存在却没接线的两处调度接缝用上。

**不做**（明确排除，避免范围漂移）：
- 不做多机/分布式执行；不做常驻 worker 池；不引入新的持久化文件格式（判据结果沿用 `app_config` 单键 JSON，形状同 `src/main/agent/text-protocol-prefs.ts:13`）。
- 不做嵌套树状 UI。理由与既有口径同源（`docs/v4-iteration-ledger.md` 里"记录跳回轮次→不做：缺的只是关联键，而用户不会用它跳回"）：角色归因只做**扁平带标签**，出现在现成的分步明细里（`src/renderer/src/modules/agent/chat/AgentPanel.tsx:517`）。
- 不改工具授权口径：`'*'` 只给内置这条单一来源（`src/main/tools/registry.ts:68-84`，三处判定点 `:75-77` 自述）保持不动，子代理只能继承、不能扩权。
- 不在本轮把"助手默认模型"从渲染层迁到主进程。它**当前是生效的**（`src/renderer/src/modules/chat/ChatModule.tsx:227/420/443` 会把 `asst.defaultProviderId/defaultModel` 写进 `targets`），只是引擎不读库字段（`src/main/agent/engine.ts:683` 取 `targets[0]`）。⚠️ 更正一条调研误报：曾有结论写"没人读、默认模型不生效"——被 `ChatModule` 那三处证伪。

---

## 1. 实测基线（方案的分档必须由这些数支撑，不是由参数量故事支撑）

| # | 测的是什么 | 实测值 | 对方案的约束 |
|---|---|---|---|
| M1 | `/api/tags` 给不给模型体积 | 给：`size`/`parameter_size`/`quantization_level`（3b Q4_K_M 1.93GB、1.5b 0.99GB、bge-m3 F16 1.16GB） | 判据有输入可用；但 `src/main/ollama/ollama-runtime.ts:128` 只读 `name`，**体积拿到就丢** |
| M2 | 实时显存占用可否采 | `nvidia-smi memory.used`：空 0MiB / 3b 2148MiB / coder 1200MiB / bge-m3 720MiB | `src/main/steward/hardware.ts:60-102` 只采**总量**（AdapterRAM 与 qwMemorySize 取大者），无 used |
| M3 | 两个 chat 模型能否同驻 | 只做 warm-load（空 prompt）时 3 个同挂；一旦真生成 64 token，后加载者把前者顶掉（used 2148→1200MiB） | **权重相加 ≤ 显存是错判**；瓶颈是 KV/上下文，而全仓 `n_ctx` 零命中 ⇒ 上下文预算现在无从得知 |
| M4 | 主动卸载 | `keep_alive:0` 生效，10ms 返回，used 1200→58MiB | 让位杠杆成立。⚠️ 对称性坑：对 embedding 模型走 `/api/generate` **卸不掉**（bge-m3 收尾仍挂 633MB），必须按加载它的那条端点卸 |
| M5 | 前台对话被后台索引抢卡 | 同一条 ~35 token 生成：无竞争 **3731ms** → 与 bge-m3 并发 **6103ms（+64%）**，embed 首载 11259ms；混跑后聊天模型被顶出显存 | 这是"错峰"要买的东西，有量纲：前台 +64% 且下一步再交冷启动税 |
| M6 | 并发是否省时间 | 跨模型冷启动：并发 7597ms vs 串行 8283ms（差 686ms，噪声级） | 应用层"同一张卡同时只放一个 chat 请求"**几乎不损失吞吐**，只是把隐形互拖换成可解释排队 |
| M7 | 小模型能不能当管控者 | 走应用真实形状（`src/main/providers/openai-compatible.ts:207-219` 带 `tools`+`tool_choice`）：`qwen2.5:3b-instruct` **4/4 合法委派**（原生 `/api/chat` 也 2/2，热态 1337-1354ms、冷 5249ms）；`qwen2.5-coder:1.5b` **0/4**——想调但自发写 ` ```json ` 围栏，而引擎只认 ` ```tool_call `（`src/shared/text-tool-protocol.ts:30`）；`qwen2.5:1.5b-instruct` **0/4**——直接自己作答 | **能力闸必须独立于容量闸**：同为 1.5B，一个"围栏标签差一点"、一个"根本不派活"，参数量推不出来 |
| M8 | 降级到文本协议会不会更好 | 用 `buildTextProtocolPrompt`（`text-tool-protocol.ts:100-106`）逐字提示，三个模型 **全部 0/3**，连 3b 都退化成自己写汇报 | 反向结论：**Ollama 的原生 tools 比文本协议可靠**；给低配机开方案时，禁止默认"走文本协议兜底" |

由 M7/M8 出一条硬规矩：**能力探针必须走"应用真正会走的那条路"**（带 `tools` 字段的 OpenAI 兼容请求），拿文本协议的结果判能力 = 判错。

---

## 2. 判据层设计（L0）：三条正交的判据，不要混成一个"档位"

1. **容量判据**（能不能同时驻留、能不能并行）
   - 输入：总显存（已有）+ used（新增）+ 各模型权重体积（M1，新增保留）+ KV 预算（**待测 V-0**）。
   - 输出：`maxConcurrentChatSlots`、`allowChatEmbedOverlap`、`rolesMayUseDistinctModels`。
2. **能力判据**（这个 `providerId::model` 派得出委派吗）
   - 输入：一次探针请求的结果，三态 `native_tools_ok | fence_only | no_delegation`，外加模型标识（`/api/tags` 的 digest，模型换了要重探）。
   - 存储：`app_config` 单键 JSON 数组，键形状复用 `textProtocolKey` 的 `providerId::model`（`text-protocol-prefs.ts:22`）。上限与清洗规则照抄那份（防脏值撑大 KV）。
3. **成本判据**（这轮编排值不值）
   - 输入：现成 `recordPerf` 的 `agent.total`（标签由 `perf-probe.ts:68-76` 按 `kind` 拼出，慢阈值 `:36/:38`）+ 每次委派热态 1.34s（M7）。
   - 输出：预算闸门（总 LLM 调用数 / 总墙钟），**不是**给用户看的档位。
   - 已知缺口：`kb.*` 标签不带 `provider/model`（`rag.ts:438` 等），跨模型归因时看不出来 ⇒ 判据层顺带补标签。

三条正交的意义：`入门档 + 有能力` 可以开顺序委派（同模型换帽子）；`旗舰档 + 无能力` 一律不开管控者。**混成一条档位就会两头误判**。

---

## 3. 改造项（实施顺序即依赖顺序；每项一个台账编号，做完停下等提交）

### V4-Iter-140 判据底座（只读，不改行为）
- 落点：`ollama-runtime.ts:128` 保留 `size/digest`；`hardware.ts` GPU 项加 `usedMiB`（NVIDIA 走 `nvidia-smi`；非 NVIDIA 用 `/api/ps` 的 `size_vram` 汇总兜底，Mac 明确置 `null` 并在 UI 说"未测得"）；新增纯函数模块 `src/main/agent/local-capacity.ts`：`planCapacity({totalMiB, usedMiB, weightsMiB, kvMiB})`。
- 为什么单独成迭代：这一层是全系列唯一能"零风险先落"的部分，且**纯函数住在中立模块**（不寄居在常被整体 `vi.mock` 的 `rag.ts`/`engine.ts`，同既有教训）。
- 边界：不改任何调用点；`usedMiB` 采不到就是 `null`，判据退回保守档。
- 验收：B72（CI：`planCapacity` 真值表 + M3 那条"warm 同驻但生成态驱逐"必须落在同一档，防止把 ps 当显存真相）。

### V4-Iter-141 本地槽位调度（错峰主体）
- 落点：把 `src/main/chat/concurrency.ts` 的 `withProviderLimit`（现容量 2、唯一使用者 `chat-service.ts:526`）扩成 `withLocalSlot(kind, providerId, model)`：`kind ∈ {foreground, retrieval, background}`；按 140 的判据给容量。
- **接线清单（回读后补全，漏一处就等于 139 那种"没接线"缺陷重演）**：
  - agent 侧 4 处 `streamChat`：`engine.ts:392`（历史压缩）、`:856`（规划）、`:1083`（主循环）、`:1670`（步数耗尽兜底）。原调研只点了 `:1083`。
  - 检索链 4 处：`knowledge/reranker.ts:71`、`knowledge/hyde.ts:22`、`knowledge/multi-query.ts:53`、`knowledge/ocr.ts:41`。
  - 标题：`conversation/title-gen.ts:65`。
  - embedding **不是** `streamChat`：`knowledge/embedding.ts:31`（批量，走 `adapter.embed` → `/v1/embeddings`）与 `:56`（查询）。⇒ 它和 chat 是两条端点，与 M4 那个"用 `/api/generate` 卸不掉 embedding 模型"是同一族坑：**任何按端点不对称设计的槽位/卸载逻辑都会漏一侧**，140–141 里凡涉及"这个模型现在驻留在哪条路上"的判断都必须带端点信息。
- 让路：`knowledge/index-queue.ts:39 isIdle()` 现在零调用者 ⇒ 后台任务出队前先问前台槽是否空闲；**只在空闲期跑**，不做 kill 式抢占（前台 run 内部会调 `kb_search`，误判"空闲"会自锁）。
- 让位卸载：默认**不**主动 `keep_alive:0`（冷启动 3.5-5s 是实测代价）；仅在"后台大批量索引 + 前台长时间无请求"时由用户显式开。
- 边界与回滚：判据拿不到 ⇒ 沿用今天的容量 2，行为不变。云 provider 不受本地槽位约束（只有 `type==='ollama'`/回环 baseUrl 这条判据参与的才走）。
- 验收：B73（CI：假时钟下排队顺序与并发数；M5 的 +64% 互拖用一条"检索链与索引不得同槽"断言守住）、B74（🔶 真机：4GB 机上聊天期间灌索引，看 `agent.total` 变化——数字只有真机可看）。

### V4-Iter-142 能力探针与三态徽标
- 落点：`src/main/agent/delegate-capability.ts`（纯函数判卷）+ 一次真实请求（走 `providerManager.getAdapter().streamChat`，带 `tools`，同 M7 形状）；结果写 `app_config`；设置页 → 模型服务商处显示 `可委派 / 只会写围栏 / 不派活`。
- 硬规矩：探针**不许**在文本协议模式下跑（M8 证过那条路会假阴性）；探针失败按 `hasIpcFailed` 那套"失败是返回值"的合同处理（V4-Iter-139 教训），不许把失败当"不支持"。
- 判卷口径：至少 3 次重复，全过才记 `native_tools_ok`（M7 里 3b 是 4/4，但单次不足以定论；稳定性本身列为待测 V-1）。
- 验收：B75（CI：判卷纯函数三态 + 反向对照"文本协议结果不得判成 ok"）、B76（真机：本机三个模型应分别落 `ok / fence_only / no_delegation`，这是探针自证）。

### V4-Iter-143 角色归因迁移（先给数据留位置）
- 落点：`agent_traces`（`src/main/db/database.ts:72-84`，只有 request_id/conversation_id/step_index）加 `parent_request_id`、`role_key`；`agent-trace.repo.ts:82` 写入；`latestRequestId`（`:40-56`）保持只认最近一轮的语义不动。
- 迁移纪律（v46 血账）：`ALTER TABLE ADD COLUMN` 不可重入；退回未执行**只退被测那一条**；新用例**不断言** `LATEST_SCHEMA_VERSION`，只 `PRAGMA table_info` 验列存在/类型/默认值（注意 PRAGMA 给的是文本默认值）。
- 验收：B77（CI：真库迁移往返 + 旧行 `NULL` 仍渲染）。

### V4-Iter-144 `delegate_task` 内置工具 + 子 run（顺序形态）
- 落点：新增内置工具（注册进 `src/main/tools/registry.ts`）；执行分支在 `engine.ts:1441-1525` 处 fork：**直调 `agentEngine.run`，绕开 `chat-service.ts:174` 的会话锁**（同会话走 `send` 必自锁死：`withConversationLock` 把 agent 分支整个包住）。
- 子 run 三条硬规矩：① 工具白名单 ⊆ 父授权（继承 `resolveAgentToolPermissions` `engine.ts:222-229`，禁止子级出现 `'*'` 扩张）；② `kbIds` ⊆ 父 `kbIds`；③ `unattended: true`，且**派发前**就把 `confirm` 类工具从子清单里剔除——M7/源码都表明让它撞闸只会得到一句 `工具 X 需人工确认，但当前为无人值守场景，请在桌面端操作`（`engine.ts:1478-1485`）塞回上下文，用户既看不到弹窗也没得到结果。
- 预算闸：父 `MAX_STEPS=10` + 触顶 `+5`（`engine.ts:58/80`）本身不管总量 ⇒ 新增"本轮总 LLM 调用数 ≤ N"，N 由 140 判据给（入门档建议 3 角色 × 5 步 = 15 次，按 M7 热态 1.34s/次 ⇒ 单编排 ≥ 20s，必须先让用户看见这个预估）。
- 验收：B78（CI：真桥层 + 真库，钉"子级拿不到父级没有的工具/库""confirm 类不进子清单""父不锁死：子 run 期间同会话可再发消息"）、B79（CI：预算闸触顶时的降级文案与 trace 行数）。

### V4-Iter-145 角色并发（只在容量判据允许时开）
- 落点：141 的槽位 + 144 的子 run；跨模型角色仅当 `rolesMayUseDistinctModels`（M3：4GB 机 false）；同模型多角色并行不受显存限制、但受 141 的前台槽=1 限制 ⇒ 这一档实际收益来自云 provider。
- 验收：B80（CI：判据 false 时**物理上发不出**第二个模型请求，用请求计数器断言，不许只断 UI 置灰）。

### V4-Iter-146 界面：分步明细里的角色标签 + 本机档位说明
- 落点：`agent:step-event`（`src/shared/types.ts:2053`）加 `roleKey/parentRequestId`；`AgentPanel.tsx:517` 现成面板加扁平标签；新增一屏"本机判据"：总显存/已用/可同驻模型数/该模型可否委派（三态），每项后面写**测得还是估的**。
- 文案纪律：只承诺已证实之事——不写"多个 AI 协同"，写"本机可把任务派给 N 个角色，预计耗时 ≥ X 秒（依据：单次委派实测 1.34s）"。
- 验收：B81（DOM 可断言部分抽成纯函数/小组件挂进 CI）、B82（🔶 只有肉眼：标签位置、窄窗口换行；按既有口径，**加常驻项＝抬高最小可用宽度，必须重测窄窗口**）。

### V4-Iter-147 分档默认值与首启接线
- 把 140–145 的判据落成四档默认（沿用 `steward/model-recommend.ts:60/71/82/92` 的显存分界，但**语义不同**：那份阈值是为"拉哪个模型"定的，本轮为"能同驻几个"定的，两套阈值不许互相冒充，须各自注明）。
- 首启向导里跑一次 142 探针（可选、可跳过、失败不阻塞）。
- 验收：B83（CI：档位 → 默认参数表逐项对号；反向对照"入门档不得出现跨模型角色"）。

---

## 4. 验证方案（三层，逐条标注"谁能证"）

**V-0 先补的实测（在 140 之前，属阻塞项）**
- KV 显存曲线：同一模型在 `num_ctx` 512/2048/8192 下 `/api/ps.size_vram` 与 `nvidia-smi used` 的增量。没有这条，M3 只能说"会驱逐"，说不出"多大上下文开始驱逐"⇒ 145 的阈值是蒙的。
- 探针脚本形态：gitignored `data/*.mjs`，跑完 `keep_alive:0` 卸净 + 关 serve + 删脚本（本轮已按此执行过三次）。

**V-1 CI 层（能进 CI 的一半，必须全部进）**
- 判据纯函数真值表；槽位排队（可控假时钟，断并发数与顺序）；能力判卷三态 + 反向对照；`delegate_task` 入参 schema（**新建/默认载荷必须能过 schema**，同 V4-Iter-94 那条教训）；子作用域收窄（工具/库子集）；会话锁不死锁；trace 归因列往返；桥层（复用 139 那层：真 preload ⇄ 真 handler ⇄ 真临时库）。
- 变异实测要求（每个新闸门至少一轮，且必须**转红**）：删掉 `withLocalSlot` 一处接线 / 把子级白名单改成父级全量 / 让 confirm 工具重新进子清单 / 判据 false 时仍发第二模型请求 / 归因列不写 / 能力探针改走文本协议。恢复一律 `assert count==1` + sha256 核对 + 逐处 `git diff` 复查。

**V-2 真机/探针层（CI 证不到的，写清"只有肉眼或只有真机能看"）**
- M5 那条 +64% 互拖在接线后是否消失（看 `agent.total`，不看界面）。
- 卸载对称性（chat 端点卸 embedding 无效）在应用内是否被正确处理。
- 不同显卡档位（≥6GB / ≥12GB）的同驻阈值——**本机证不了，需第二台机器**；在拿到数据前，145 只能以"最保守档默认关闭"交付。
- 能力探针重复稳定性（同模型 10 次是否同一结论，M7 只有 4 次）。

**V-3 人工验收层**（落 `docs/verify-checklist.md`，B72–B83，预期文案逐字取代码，状态词允许 🔶 表示"机制已进 CI、显示层未肉眼确认"）。

---

## 5. 风险与停止条件

| 风险 | 处置 |
|---|---|
| 编排把成本乘上去：父 15 步 + 每子 15 步，本地 1.3s/次 ⇒ 一个"看起来更聪明"的任务实际几分钟 | 144 的预算闸 + 146 的耗时预估先行显示；预估只准引用实测数字 |
| 低配机上"多角色"退化成同模型换帽子，用户体感与单 agent 无差别 | 文案不许暗示"多模型协作"；判据屏写清"本轮所有角色共用同一模型" |
| 子代理撞确认闸造成的静默失败被当成结果 | 144 规定派发前过滤；桥层用例反向钉"confirm 不得进子清单" |
| 同一授权口径散落多处（`registry.ts:75-77` 三判定点） | 子作用域只做**收窄**，任何"扩权"路径必须在 CI 里被一条反向对照挡下 |
| `app_config` 存判据结果 = 新事实来源，模型换了就过期 | 存 digest；digest 变化即视为未探；探针失败不当结论 |

**停止条件**：V-0 若显示 4GB 机上 `num_ctx 2048` 就已经放不进两个模型（很可能），则 145 与 147 的高档默认全部退回"跨模型仅云 provider"，144 的顺序委派仍可做——方案不因它失败，只是把"多模型角色"整块挪出低配档。

---

## 6. 待你点头的三个决策（不决定就没法把 140 之后的口径写死）

1. **围栏标签要不要放宽**：`coder-1.5b` 实测 0/4 的原因是自发 ` ```json `，而解析只认 ` ```tool_call `（`text-tool-protocol.ts:30`）。放宽能白捡一档低配机的委派能力，代价是解析面变大（必须仍按 `ctx.tools` 名单校验 name、走原 BAD_ARGS 链）。目前只有 3 次样本，**不足以定论**，需要一轮 20 例实测再决定。
2. **子代理要不要独立会话**：绕锁直调 `agentEngine.run` 最省，但会话归属与 trace 呈现要定规矩（现有口径：Agent 只记助手 + 会话，不做记录跳转）。
3. **低配机默认开不开"顺序委派"**：M7 显示本机只有 3b 能当管控者（1.5b 一档 0/4）⇒ 是"探测到有能力才开"，还是"入门档一律不开、由用户在判据屏手动开"。
