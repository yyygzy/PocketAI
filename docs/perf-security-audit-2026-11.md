# PocketAI 1.3.0 性能与安全审计整改工作文档（2026-11-27）

> 审计时间：2026-11-27
> 审计范围：`src/`（593 文件 / 146k 行）、`license-server/`、`scripts/lib/`、`build/` 构建配置
> 审计方法：5 路并行专项审计（IPC 边界 / 工具执行层 / 密码学与凭据 / 数据层 / 渲染层）+ 关键项独立复现验证
> 状态标记：`待修复` / `修复中` / `已修复` / `待决策`
> 性质：**只读审计**，未修改任何生产代码；验证用临时脚本已清理

---

## 1. 背景与范围

### 1.1 审计方法

| 专项 | 覆盖目录 | 方法 |
|---|---|---|
| IPC 边界与 preload | `src/preload/`、`src/main/ipc/**`、`src/main/windows/`、`src/main/popup.ts` | 418 个 `safeHandle` 注册全量 AST 扫描 + 逐文件实读 |
| 工具执行层与沙箱 | `src/main/tools/`、`src/main/agent/`、`src/main/sandbox/`、`src/main/terminal/`、`src/main/knowledge/parsers/` | 危险调用点全量定位 + 复刻真实判定函数实测 |
| 密码学与凭据 | `src/main/crypto/`、`src/main/license/`、`src/main/backup/`、`src/main/mcp/oauth/`、`src/main/channels/` | 密钥流全链路追读 + 运行时参数实测（KDF / cipher / pragma） |
| 数据层 | `src/main/db/**`、`src/main/knowledge/`、`src/main/chat/`、`src/main/usage/` | schema 与索引全量比对 + 真库 EXPLAIN QUERY PLAN + 造数实测 |
| 渲染层 | `src/renderer/src/`（190 文件） | 订阅/清理点全量核查 + 组件重挂载与高亮耗时基准实测 |

标注「**已实测**」的条目表示已用真实代码路径复现或用真实数据库量化；其余为源码事实，标注「需人工确认」的表示依赖部署侧证据。

> **引文与断言约定**：本文代码引文为**语义摘录**（可能省略注释行、合并多行语句），省略处以 `...` 标注；以所引 `文件:行号` 的当前源码为准。「全仓唯一 / 仅 N 处」类强全称断言一律附 grep 命令原文以便复验。基准数字（毫秒 / 倍数）来自审计当次真实运行，无法从代码侧复验。

### 1.2 与既有文档的关系

| 文档 | 定位 | 本次的关系 |
|---|---|---|
| `安全审查修复方案.md`（仓库根，2026-11-20） | 出网闸 / SSRF / 凭据回显 / 配置注入为主的安全修复方案 | **不重叠**：本次 4 项未被其 H1–H3 / M1–M10 / L1–L7 / E1 清单覆盖 —— SEC-16-01（run_tests 注入，其 M7 只覆盖 MCP shim）、SEC-16-03（fs_write 悬空链接，其 M5/L4 只覆盖已有目标的 symlink）、SEC-16-05（deny-list 规则缺口）、工具执行链路性能（PERF-02/05/09/10 等） |
| `docs/security-audit-ledger.md`（135 KB） | 全项目安全审计**台账**，最后批次 SEC-Batch-15 | 本文档可作为 **SEC-Batch-16** 的来源，行号与证据链可直接迁入 |
| `docs/kb-upgrade-plan-2026-11.md` 等 | 按阶段推进 + 进度/验收回写的计划文档 | 本文档沿用该体例：阶段 → 验收 → 进度回写 |

> **编号约定**：安全条目用 `SEC-16-xx`（承接台账 SEC-1…SEC-32，批次 16）；性能条目用 `PERF-xx`（台账未设性能批次）。
> 与根目录《安全审查修复方案.md》的编号**互不冲突**，该文档的 H/M/L 编号在本文件中一律以全名指代。

### 1.3 结论摘要

**基础防护密度较高**：加密套件（AES-256-GCM + 随机 IV + 认证标签）、SQLCipher 4 每页 HMAC、日志双层脱敏、工作目录四重路径守卫、归档 Zip Slip 校验、JS 沙箱独立 partition + 禁网 + 全权限拒绝、MCP shim 元字符硬拒、密钥轮换无遗漏、OAuth PKCE + state + `timingSafeEqual` —— 这些均已验证有效，本次不重复排查（详见第 5 节）。

问题集中在三类：

1. **Windows 命令行注入面**——`run_tests` 绕过审批直连 `cmd.exe`，且参数校验不挡元字符（已实测）。
2. **信任边界缺口**——终端 IPC 不走审批链、日历路径绕过 `dialog-path-token`、凭据揭示零审计、字段解密 fail-open。
3. **数据层规模性劣化**——sqlite-vec KNN 查询形状导致 O(N²)（20k chunk 需 27 分钟）、FTS 删除触发器全表扫、列表接口无分页。

另有**发行私钥留存于交付工作区**这一流程性问题，与代码无关但影响授权体系根基（已实测配对成功）。

### 1.4 问题总表

| 编号 | 级别 | 类别 | 问题 | 主责位置 | 阶段 | 验证 |
|---|---|---|---|---|---|---|
| SEC-16-01 | 严重 | 注入 | `run_tests` Windows cmd 参数注入 → 无审批任意命令执行 | `src/main/tools/run-tests.ts` | P0 | **已实测** |
| SEC-16-02 | 严重 | 密钥 | 发行私钥留存交付工作区，与内置公钥配对 | `build/license-private.pem` | P0 | **已实测** |
| PERF-01 | 严重 | 性能 | sqlite-vec KNN 查询 O(N²)，主进程冻结 | `src/main/db/repositories/kb-vec.repo.ts` | P0 | **已实测** |
| SEC-16-03 | 高 | 路径 | `fs_write` 悬空符号链接逃逸工作目录 | `src/main/tools/fs-tools.ts` | P1 | 已实测 |
| SEC-16-04 | 高 | 审批 | 终端 IPC 绕过审批与审计链 | `src/main/terminal/terminal-service.ts` | P1 | 已验证 |
| SEC-16-05 | 高 | 策略 | shell deny-list 覆盖缺口（dd/fsutil/vssadmin 落 allow） | `src/main/tools/shell-tools.ts` | P1 | **已实测** |
| SEC-16-06 | 高 | 传输 | WebDAV 允许 http + Basic 明文携带口令 | `src/main/backup/webdav-client.ts` | P1 | 已验证 |
| PERF-02 | 高 | 性能 | 流式输出零节流 + `detect:true` 使高亮慢 18 倍 | `src/renderer/src/modules/chat/` | P1 | **已实测** |
| PERF-03 | 高 | 性能 | Markdown 组件/插件字面量 → 子树重挂载、状态重置 | `src/renderer/src/modules/chat/Markdown.tsx` | P1 | **已实测** |
| PERF-04 | 高 | 性能 | 消息/会话列表接口无 LIMIT，缺复合索引 | `src/main/db/repositories/message.repo.ts` | P1 | **已实测** |
| PERF-05 | 高 | 性能 | FTS5 DELETE 触发器在 UNINDEXED 列上全表扫 | `src/main/db/database.ts` | P1 | **已实测** |
| SEC-16-07 | 中 | 加密 | 字段解密 fail-open：形状不匹配原样返回存储值 | `src/main/crypto/field-encrypt.ts` | P1 | 已验证 |
| SEC-16-08 | 中 | 加密 | none 模式固定密钥为**默认态**，覆盖全部凭据 | `src/main/crypto/master-key.ts` | P1 | 已验证 |
| SEC-16-09 | 中 | 路径 | 日历 `.ics` 路径未走 `dialog-path-token` | `src/main/tools/calendar-ics.ts` | P1 | 已验证 |
| SEC-16-10 | 中 | 数据 | 备份合并整表覆盖丢本地知识库，向量索引不一致 | `src/main/backup/merge-service.ts` | P1 | 已验证 |
| SEC-16-11 | 中 | 审计 | 凭据 reveal 通道零审计留痕 | `src/main/ipc/handlers/providers.ts` | P1 | 已验证 |
| PERF-06 | 中 | 性能 | usage 预算聚合每次回复 2 次窗口扫描 + 逐行取回 JSON.parse | `src/main/usage/usage-service.ts` | P1 | **已实测** |
| PERF-07 | 中 | 性能 | N+1 查询（kb / skill / attachment-ingestion） | `src/main/db/repositories/` | P2 | 已验证 |
| PERF-08 | 中 | 性能 | `prepare()` 每次重建，UPDATE 场景慢 20 倍 | 多处 | P2 | **已实测** |
| PERF-09 | 中 | 性能 | 索引队列无上限、无去重、无退避 | `src/main/knowledge/index-queue.ts` | P2 | 已验证 |
| PERF-10 | 中 | 性能 | 工具注册表每次访问重建全量索引 | `src/main/tools/registry.ts` | P2 | 已验证 |
| SEC-16-12 | 中 | XSS | 导出 HTML 的 `href` 绕过协议白名单 | `src/renderer/src/utils/export-html.tsx` | P2 | 已验证 |
| SEC-16-13 | 中 | 泄漏 | Markdown 远程图片向第三方泄漏 IP/Referer | `src/renderer/src/modules/chat/Markdown.tsx` | P2 | 已验证 |
| SEC-16-14 | 中 | XSS | mermaid SVG 未做二次净化（依赖 strict+CSP 叠加） | `src/renderer/src/modules/chat/MermaidBlock.tsx` | P2 | 已验证 |
| SEC-16-15 | 中 | 授权 | License 用 RSA PKCS#1 v1.5 且公钥不可轮换 | `src/main/license/license.ts` | P2 | 已实测 |
| SEC-16-16 | 低 | 加密 | 便携导出 MOXENC1 的 KDF 档位钉死 N=2^15 且格式不可演进（备份信封 PKBK2 已逐档尝试，不适用） | `src/main/crypto/portable-crypto.ts` | P3 | 已验证 |
| SEC-16-17 | 低 | 加密 | 恢复码 Crockford Base32 容错映射定义但未接线 | `src/main/crypto/recovery-key.ts` | P3 | 已验证 |

---

## 2. P0：立即修复

### SEC-16-01 · `run_tests` Windows cmd 参数注入 → 无审批任意命令执行

**级别** 严重 ｜ **状态** 已修复 ｜ **位置** `src/main/tools/run-tests.ts:98-100`（校验 `:27-40`，权限 `:84`）｜ **验证** 已实测

**问题**

模型提供的测试文件路径被拼进 `cmd.exe /d /s /c` 的 argv，而 `parseFiles` 只挡绝对路径与 `..`，不挡 cmd 元字符：

```ts
// src/main/tools/run-tests.ts:98-100
const [cmd, spawnArgs] = process.platform === 'win32'
  ? ['cmd.exe' as string, ['/d', '/s', '/c', 'npx', ...vitestArgs] as string[]]
  : ['npx' as string, vitestArgs] as string[]
```

Node/libuv 只对**含空格或 Tab** 的参数加引号；**无空格**的 `&` `|` `>` 原样进入命令行，被 cmd 当作命令分隔符/重定向。

**复现证据**

```
payload: "nonexistentfile&echo>INJ_VERIFY.txt"  hasSpace: false
exit: 0
INJECTION CONFIRMED, file created: --reporter=dot
```

对照组（payload 含空格）被 libuv 引号保护，未注入 —— 这正是该问题长期未被发现的测试盲区。

**影响**

- `run_tests` 的 `permission: 'auto'`（`run-tests.ts:84`）→ **全程无审批**。
- 注入命令的 stdout 会被 `run-tests.ts:114-135` 收进 `out` 并随 JSON 回给模型，构成「执行命令 → 回灌上下文」的数据外带通道。
- 触发条件：模型输出即可（含被投毒的仓库 README / 项目文档诱导）。POSIX 侧 `npx` 直 spawn 不受影响，但为跨平台一致性应一并收敛。

**改法**

彻底绕开 `cmd.exe`（元字符永远不会被解释），并加文件名字符白名单兜底：

```ts
// src/main/tools/run-tests.ts
const TEST_PATH_RE = /^[\w@.\-/\u4e00-\u9fa5]+$/     // 允许中文文件名；仍无空格、无 & | < > ^ % ! " ' ( )
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/  // 强制 .test. / .spec. 后缀（正则必须与该意图一致）

function parseFiles(raw: unknown): string[] {
  ...
    const s = String(f ?? '').trim().replace(/\\/g, '/')
    if (!s) throw new Error('测试文件路径不能为空')
    if (s.length > MAX_FILE_CHARS) throw new Error('测试文件路径过长')
    if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.includes('..')) {
      throw new Error('测试文件路径必须是工作目录内的相对路径')
    }
    if (!TEST_PATH_RE.test(s) || !TEST_FILE_RE.test(s)) {
      throw new Error('测试文件路径非法：只允许形如 tests/foo.test.ts 的相对路径')
    }
    return s
}

// 执行侧：直接以 Node 模式跑 vitest 入口（元字符永远不会被解释）
const vitestEntry = path.join(cwdAbs, 'node_modules', 'vitest', 'vitest.mjs')
const child = spawn(process.execPath, [vitestEntry, 'run', ...files, '--reporter=dot'], {
  cwd: cwdAbs,
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }  // 打包后 process.execPath 是 Electron 二进制，必须切 Node 模式
})
```

**改法的两个前提（必须写进实现）**

1. `ELECTRON_RUN_AS_NODE=1`：打包后 `process.execPath` 是 Electron 二进制，直接 spawn 它跑 `.mjs` 会启动新的 Electron 实例而非 Node。
2. vitest 入口直跑**不再有 npx 的自动下载能力**：要求 vitest 已安装在用户工作区（`node_modules/vitest/vitest.mjs` 存在），未安装时返回可读错误提示（如「请在项目里安装 vitest 后重试」）。这是对现状（npx 自动拉取）的行为变化，需在验收里确认可接受。
3. `TEST_FILE_RE` 收紧后，`files` 传**目录**的用法不再支持（当前描述只承诺「测试文件路径」，但模型可能传目录）；如需保留，须另加目录白名单校验，不得放宽为任意路径。

**验收**

- 新增用例：`files: ["x&calc"]`、`["x|calc"]`、`["x>calc"]`、`["a b.test.ts"]`、`["foo.ts"]`（非 test/spec 后缀）、目录路径 均被拒；中文文件名的 `.test.ts` 可通过。
- Windows 打包产物下验证 `ELECTRON_RUN_AS_NODE=1` 路径确实以 Node 模式执行（不会弹出新的 Electron 窗口）。
- Windows 真机跑 `npm test` 通过，且工作目录不产生任何注入副产物文件。
- 同族改法同步到 `src/main/agent/post-edit-validation.ts:111-114,140-143`（见 SEC-16-05 关联项）。

---

### SEC-16-02 · 发行私钥留存交付工作区，且与内置生产公钥配对

**级别** 严重 ｜ **状态** 修复中 ｜ **位置** `build/license-private.pem`、`src/main/license/public-key.ts` ｜ **验证** 已实测（代码侧已完成：scripts/check-no-private-key.cjs 已挂 5 条 dist 链并在本仓实测拦截；私钥移出交付目录并轮换属用户运维动作，待办）

**问题**

`build/license-private.pem`（1704 B，RSA-2048）存在于交付工作区，且与 `src/main/license/public-key.ts` 内置的 base64 DER 公钥**逐字节配对**：

```
MATCH = true    private key type: rsa  bits: 2048
```

`.gitignore:19` 已排除该文件（`git ls-files build/` 仅跟踪 `license-public.pem`），但它仍在磁盘上，且 `license-server/server.js:362` 正是从这里读取它。

**影响**

任何取得本工作区的人（外发承包商、CI 缓存、桌面同步盘、误打包）即等价于持有发行方身份，可签发任意 `plan` / `expires_at` / `features` 的许可证。`license.ts:262-299` 的 `disk_fingerprint` 比对只能挡「一机一证」复用，挡不住伪造。

**改法**

1. 从交付目录移除该文件，改由 CI Secret / HSM / 离线签名机持有；发行流水线只在签名步骤临时挂载。
2. 加打包前拦截（建议与 `scripts/check-license-url.cjs` 同级）：

```js
// scripts/check-no-private-key.cjs —— 打包前必须 exit 0
const forbidden = ['build/license-private.pem', 'license-private.pem', 'license-server/license-private.pem']
for (const f of forbidden) {
  if (fs.existsSync(f)) { console.error(`[FATAL] 发行私钥存在于交付目录: ${f}`); process.exit(1) }
}
```

并挂进 `package.json` 的 `dist` / `dist:portable` / `dist:nsis` / `dist:linux*` 脚本链（`scripts/check-license-url.cjs &&` 之后）。

3. **轮换密钥对**：换新 Ed25519 对后，旧私钥即使泄露也无法签发新版本许可证（公钥版本化方案见 SEC-16-15）。

**验收**

- `scripts/check-no-private-key.cjs` 在有私钥时以非 0 退出，且已挂入全部打包脚本。
- 换发密钥后，旧许可证按设计失效或按版本兼容策略保留（需产品确认）。
- 确认 `electron-builder` 的 `files` / `extraResources` 不会把 `build/` 下的 pem 带入安装包。

---

### PERF-01 · sqlite-vec KNN 查询 O(N²)，主进程长时间冻结

**级别** 严重 ｜ **状态** 已修复 ｜ **位置** `src/main/db/repositories/kb-vec.repo.ts:154-170` ｜ **验证** 已实测

**问题**

KNN 子查询被写在 JOIN 的 FROM 里，SQLite 不物化它，vec 虚表被逐行求值，KNN 实际执行 N 次而非 1 次：

```ts
// src/main/db/repositories/kb-vec.repo.ts:157-168
`SELECT c.id AS chunk_id, c.doc_id, c.kb_id, c.sequence, c.content, v.distance
 FROM (
   SELECT rowid, distance FROM ${vecTableName(dim)}
   WHERE embedding MATCH ? AND rowid IN (${rowidPlaceholders}) AND k = ?
   ORDER BY distance ASC
 ) v
 JOIN ${MAP_TABLE} m ON m.vec_rowid = v.rowid AND m.dim = ?
 JOIN kb_chunks c ON c.id = m.chunk_id
 WHERE c.kb_id IN (${kbPlaceholders})
 ORDER BY v.distance ASC`
```

实测 EQP 显示 vec 虚表处于最内层并伴随 `USE TEMP B-TREE FOR ORDER BY`。

**量化影响**

| chunk 数 | 当前写法 | 纯 vec0 KNN |
|---|---|---|
| 3,000 | 47,123 ms | 11 ms |
| 20,000 | **1,647,079 ms（27.5 分钟）** | 64 ms |

better-sqlite3 是同步 API，**主进程完全冻结**，UI 无响应。每次知识库检索触发，Multi-Query 开启时单库最多 5 次。

**改法**

用物化 CTE 固定 KNN 只算一次：

```ts
const knnBatch = (batch: number[]): VecRow[] => {
  const rowidPlaceholders = batch.map(() => '?').join(',')
  return db
    .prepare(
      `WITH v AS MATERIALIZED (
         SELECT rowid, distance FROM ${vecTableName(dim)}
         WHERE embedding MATCH ? AND rowid IN (${rowidPlaceholders}) AND k = ?
         ORDER BY distance ASC
       )
       SELECT c.id AS chunk_id, c.doc_id, c.kb_id, c.sequence, c.content, v.distance
       FROM v
       JOIN ${MAP_TABLE} m ON m.vec_rowid = v.rowid AND m.dim = ?
       JOIN kb_chunks c ON c.id = m.chunk_id
       WHERE c.kb_id IN (${kbPlaceholders})
       ORDER BY v.distance ASC`
    )
    .all(float32ToBuffer(query), ...batch, k, dim, ...kbIds) as VecRow[]
}
```

**验收**

- 真库造 3,000 / 20,000 chunk（dim=512），检索 P95 < 500 ms；改造前后对比记录进 `docs/kb-upgrade-plan-2026-11.md` 阶段 5 的性能表。
- 首行 rowid 与距离序列与改造前**逐行一致**（排序口径不变）。
- `tests/kb-vec-batch.test.ts`、`tests/kb-perf-large.test.ts` 仍通过。

> 关联：`docs/kb-upgrade-plan-2026-11.md` 阶段 5 已记录「sqlite-vec KNN top20 = 1836 ms（8 维小向量）」，本次发现说明该口径下慢的原因即查询形状，补测后应重记。

---

## 3. P1：本迭代

### SEC-16-03 · `fs_write` 悬空符号链接逃逸工作目录

**级别** 高 ｜ **状态** 已修复 ｜ **位置** `src/main/tools/fs-tools.ts:68-101`（守卫）、`:227-242`（写入）｜ **验证** 已实测

**问题**

守卫用 `fs.existsSync` 向上找「最深存在节点」。**悬空 symlink**（目标尚不存在）使 `existsSync` 返回 `false`，于是回退到工作目录内的父级 → 守卫放行 → `writeFileSync` 跟随该链接写到工作目录之外：

```ts
// src/main/tools/fs-tools.ts:68-81
export function assertWithinWorkspaceByRealpath(targetAbs: string, wsAbs: string): void {
  let current = targetAbs
  let existing: string | null = null
  while (true) {
    if (fs.existsSync(current)) { existing = current; break }   // ← 悬空链接返回 false
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  if (!existing) return // 路径上无存在节点，无法构造 symlink 逃逸，放行
```

**影响**

工作目录内预置一个指向目录外的悬空链接（`link -> C:\Users\me\Desktop\x.txt`，目标尚不存在），模型调用 `fs_write({path:"link"})` 即可把文件创建在链接目标处。`fs_write` 虽是 `confirm` 档，但审批面板展示的是**工作目录内的相对路径**，用户看不到真实落点。

**改法**

逐段 `lstat` + `readlink` 解析悬空链接（`realpathSync` 对悬空链接会 ENOENT，必须用 `readlink` 取原始目标）。**注意：向上回溯必须在到达工作目录根时终止** —— 继续检查工作目录的祖先会把用户目录下合法的 junction / 符号链接误报为「逃逸」（原实现找到最深存在节点即停，不存在此问题，重写时不能丢掉这个语义）：

```ts
export function assertWithinWorkspaceByRealpath(targetAbs: string, wsAbs: string): void {
  const realWs = fs.realpathSync(wsAbs)
  let current = path.resolve(targetAbs)
  while (current !== path.dirname(current)) {
    // 已落到工作目录根：从根到目标的每一段都已验证为「非符号链接」或「指向目录内」；
    // 再向上只会在工作目录祖先上误报（可能是合法 junction），必须终止
    if (current === realWs || current.startsWith(realWs + path.sep)) return
    let st: fs.Stats
    try { st = fs.lstatSync(current) } catch { current = path.dirname(current); continue }
    if (st.isSymbolicLink()) {
      const raw = fs.readlinkSync(current)
      const resolved = path.resolve(path.dirname(current), raw)
      if (resolved !== realWs && !resolved.startsWith(realWs + path.sep)) {
        throw new Error('路径超出工作目录范围（符号链接逃逸）')
      }
      current = resolved
      continue
    }
    current = path.dirname(current)
  }
}
```

另注：`lstat` 的路径解析会**自动跟随中间路径分量**上的符号链接，多级链接链（link → link2 → 外部）的逐段解析行为必须在验收用例中实测确认，不能只靠代码推演。

**验收**

- 用例：悬空链接（目标不存在）、指向目录外的已存在链接、指向工作目录内的链接、链式链接（link → link2 → 外部）四类均正确判定。
- `fs_read` / `fs_write` / `fs.list` / `shell_exec` 的 cwd 守卫共用此函数，改一处即可全覆盖。

---

### SEC-16-04 · 终端 IPC 绕过审批与审计链

**级别** 高 ｜ **状态** 已修复 ｜ **位置** `src/main/ipc/handlers/terminal.ts:17-26`、`src/main/terminal/terminal-service.ts:131-147` ｜ **验证** 已验证

**问题**

手动终端只做 deny 黑名单判定，confirm 档命令不拦截，也不复用 `classifyCommand` 的完整判定（缺 `REASON_OUTSIDE` 与全部 CONFIRM 规则），且无审计留痕：

```ts
// src/main/terminal/terminal-service.ts:131-147
export function inputTerminal(ownerId: number, data: string): { ok: true } | { ok: false; error: string } {
  const s = sessions.get(ownerId)
  if (!s || !s.proc.stdin || s.proc.stdin.destroyed) {
    return { ok: false, error: '终端未运行' }
  }
  if (data !== '\x03') {
    const reason = classifyDenyOnly(data)      // ← 只跑 DENY_RULES + ROOT_DELETE_RE
    if (reason) return { ok: false, error: `命令被安全策略拦截（${reason}）` }
  }
  try {
    s.proc.stdin.write(data)
    return { ok: true }
  } catch (e) { ... }
}
```

**影响**

- 「用户即操作者」的设计本身合理，但 SEC-16-05 指出的正则缺口被原样带到终端：`rm -rf / 2>/dev/null`、`dd if=/dev/zero of=/dev/sda`、`fsutil file setZeroData c:` 均可**直接执行**。
- IPC 通道本身无审批、无审计，渲染层若被注入（XSS / 供应链投毒）即等于完整 shell。

**改法**

1. 终端复用 `classifyCommand` 的完整判定，或至少同步补齐后的 `DENY_RULES`。
2. 补齐 deny-list 后，`dd` / `fsutil` / `vssadmin` 在终端内应硬拒。
3. 终端命令写入 `security_events` 留痕（命令文本可脱敏后入库）。
4. 锁屏 / 应用隐藏时终止终端会话（对齐 `src/main/lock/ipc-gate.ts` 的 fail-closed 口径）。

**验收**

- 终端内 `dd if=/dev/zero of=/dev/sda`、`vssadmin delete shadows /all` 被拦。
- 锁屏后终端 IPC 返回 `APP_LOCKED` 且会话已终止。
- `security_events` 能查到终端命令记录。

---

### SEC-16-05 · shell deny-list 覆盖缺口，`dd`/`fsutil`/`vssadmin` 落 allow

**级别** 高 ｜ **状态** 已修复 ｜ **位置** `src/main/tools/shell-tools.ts:101-124`（DENY_RULES）、`:127-132`（ROOT_DELETE_RE）、`:250-284`（工作目录外路径检查）｜ **验证** 已实测

**问题**

`DENY_RULES` 覆盖 `format`/`diskpart`/`mkfs`/`shutdown`/`bcdedit`/`cipher /w`/系统目录删除/fork bomb，**不含 `dd`、`fsutil`、`vssadmin`**。实测（复刻真实 `classifyCommand`）：

```
dd if=/dev/zero of=/dev/sda          -> allow      ← 无审批，抹盘
fsutil file setZeroData c:           -> allow      ← 无审批，Windows 抹盘
vssadmin delete shadows /all /quiet  -> allow      ← 无审批，删卷影（勒索软件前摇）
```

「工作目录外路径」检查只覆盖盘符路径与 POSIX 系统目录白名单（`etc|usr|bin|sbin|System|private|var/root|var/tmp|tmp`），`/dev` `/home` `/root` 均不在列。

此外 `ROOT_DELETE_RE` 只认字面量 `rm -rf /`，加后缀即降级为 confirm：

```
rm -rf /                     -> deny  (BLOCKED_ROOT_DELETE)
rm -rf / 2>/dev/null         -> confirm
rm -rf / .  / rm -rf ~       -> confirm
Remove-Item -Path C:\Windows -Recurse -Force -> confirm   ← 动词表不含 PowerShell
```

**改法**

```ts
const DENY_RULES: Array<[RegExp, ToolPolicyReasonCode]> = [
  ...,
  // dd 覆盖 NVMe / eMMC / 分区后缀（/dev/sda、/dev/nvme0n1、/dev/nvme0n1p1、/dev/mmcblk0p1 等）
  [/\bdd\b[^|&;\r\n]*\bof=\/dev\/(?:[sh]d[a-z]|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?)\d*\b/i, 'BLOCKED_RAW_DEVICE'],
  [/\bfsutil\b[^|&;\r\n]*\bsetzerodata\b/i, 'BLOCKED_RAW_DEVICE'],
  [/\bvssadmin\b[^|&;\r\n]*\bdelete\b[^|&;\r\n]*\bshadows\b/i, 'BLOCKED_SHADOW_DELETE'],
  [/\b(?:wipefs|shred|blkdiscard)\b/i, 'BLOCKED_RAW_DEVICE'],
]

const ROOT_DELETE_RE = [
  // 裸根 + 常见变体：/、~/、~、$HOME、/.、/..、//（~ 不带斜杠也在内）
  /\brm\b[^|&;\r\n]*-[^|&;\r\n]*[rf][^|&;\r\n]*\s(?:\/|~(?:\/)?|\$HOME|\/\.|\/\.\.|\/\/)(?:\s|$|\*|\.)/i,
  /\b(?:rm|del|erase|rd|rmdir|remove-item)\b[^|&;\r\n]*\b[a-z]:[\\/](?:\s|$|\*)/i
]

// POSIX 系统目录白名单补齐 dev/home/root/opt/boot/srv，并展开 ~
if (/(^|[\s="'`(])\/(?:etc|usr|bin|sbin|dev|home|root|opt|boot|srv|System|private|var\/root|var\/tmp|tmp)(?:[\\/]|\b)/.test(cmd)) {
  return { decision: 'confirm', reason: REASON_OUTSIDE, risk: 'danger', forceConfirm: true }
}
```

> deny-list 本质上是黑名单，无法穷举变体（如 `rm -rf /$(...)`、变量间接引用）；上表是**补齐已知缺口**而非完备方案，硬拒之外的两档模型（deny / confirm / auto）仍是主防线。

**验收**

- 上述三条命令的分类结果由 `allow` 变为 `deny`。
- `rm -rf /` 的各变体全部落 deny。
- 与既有 `安全审查修复方案.md` L5「shell_exec 继承 process.env」是**不同问题**，本项只补规则表，不改 allow-list 模型（沿用 SEC-Batch-4 已选定的「补词表、保留两档」口径）。

---

### SEC-16-06 · WebDAV 允许 http，且以 Basic(base64) 明文携带口令

**级别** 高 ｜ **状态** 已修复 ｜ **位置** `src/main/backup/webdav-client.ts:111-131` ｜ **验证** 已验证

**问题**

```ts
// src/main/backup/webdav-client.ts:111-131
if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
  throw new Error(`WebDAV 仅支持 http/https 协议（收到 ${parsed.protocol}）`)
}
return createClient(creds.url, {
  username: creds.username,
  password: creds.password,
  authType: AuthType.Auto
})
```

代码注释已自陈风险（`:68-71`）。对比：Provider 侧 `assertProviderBaseUrlSafe`（`src/main/providers/types.ts:89-107`）**拒绝**非回环 http 与私网地址，WebDAV 与该口径不一致。需说明：其余出网通道（`safeFetch` 的 `net/safe-fetch.ts:344`、`skills/github-contents.ts:23`、`images/image-service.ts:69`、`search/provider-fetch.ts:89`）同样放行 http —— 但它们传输的是临时内容（抓取结果 / 图片），而 WebDAV 通道上承载的是**长期账号口令**（Basic base64），风险性质不同，应按更严口径处理。

**影响**

- 同一 Wi-Fi / 交换机镜像 / 内网 ARP 欺骗可直接解码 base64 拿到 WebDAV 账号口令。
- 叠加 none 模式：`backup-service.ts:386-388` 以 `masterKeyManager.getDbKey() !== null` 决定是否加密，none 模式下**备份包是未加密 zip**（内含明文 app.db + 附件），此时 http 链路等于把整个用户数据公开传输。
- 未加密本地备份包亦无最小权限落盘：`backup-service.ts:346-371` 的 `createLocalBackup` 未传 `mode: 0o600`（`grep -rn "0o600" src/` 命中 6 处：`drag-temp.ts:104`、`app-config.repo.ts:146`、`backup-service.ts:368`、`python-env.ts:554/596`、`encryption.ts:538`，均不含未加密备份路径）。

**改法**

与 Provider 侧口径对齐（回环放行，公网强制 https）：

```ts
// src/main/backup/webdav-client.ts —— buildClient 内
const isLoopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(parsed.hostname)
if (parsed.protocol === 'http:' && !isLoopback) {
  throw new Error('WebDAV 地址必须使用 https（仅本机回环允许 http）：明文 http 会以 Basic(base64) 明文携带账号口令')
}
```

若产品必须支持内网 NAS http，则至少加**显式二次确认 + 落盘告警**，并在设置页固定红字提示；同时把 `authType` 优先设为 `AuthType.Digest`。

配套：`createLocalBackup` 的 `writeFileAtomicSync(outPath, zip)` 补 `{ mode: 0o600 }`，与 `createEncryptedLocalBackup`（`:368`）口径一致。

**验收**

- 非回环 http URL 被拒；回环 http 仍可用。
- 设置页对 http WebDAV 有显式警示。
- 未加密备份包在 POSIX 下权限为 0600。

---

### PERF-02 · 流式输出零节流 + `detect:true` 使高亮慢 18 倍

**级别** 高 ｜ **状态** 已修复 ｜ **位置** `src/renderer/src/modules/chat/useStreamSession.ts:130-138,187-201`、`src/renderer/src/modules/chat/Markdown.tsx:142-152` ｜ **验证** 已实测

**问题**

流式 chunk 每来一个 token 就触发一次 React 全树提交，无节流、无 `requestAnimationFrame` 批处理、无 `useDeferredValue`/`startTransition`：

```ts
// src/renderer/src/modules/chat/useStreamSession.ts:130-138
const offChunk = window.pocketai.onChatChunk((e) => {
  if (e.requestId !== requestIdRef.current) return
  setLiveColumns((prev) => prev?.map((c, i) =>
    i === e.targetIndex ? { ...c, content: c.content + e.delta } : c))
})
```

Agent 路径的 reducer 另含 O(n) 查找 + O(n) 拷贝（`messages-reducer.ts:142-150`）。

级联链路：`setLiveColumns` → `ChatView` 的 `liveColumns` prop 变 → `renderedTurns` useMemo 重算（`ChatView.tsx:591-614`）→ `MessageBubble` 重渲染 → **react-markdown 全量重解析 + highlight.js 全量高亮**。

实测同一段 markdown 连续重解析 5 次：

| 配置 | 耗时 |
|---|---|
| `detect: true` | **3052 ms** |
| `detect: false` | **167 ms** |

差距 ≈ **18 倍**，根因是 `rehype-highlight` 的 `highlightAuto` 需遍历 lowlight `common` 注册的全部 37 种语言做嗅探。

`grep -rn "throttle|debounce" src/renderer/src` 命中 `ConversationList.tsx`（搜索框防抖）与 `utils/longtask.ts:8,23`（上报节流）——**流式路径无任何节流**这一结论仍成立。

**改法**

1. 一行收益最大的改动 —— 关闭自动嗅探并限定语言子集：

```ts
// src/renderer/src/modules/chat/Markdown.tsx:142-145
const rehypePlugins: PluggableList = katexPlugin
  ? [katexPlugin, [rehypeHighlight, { detect: false, subset: ['ts','tsx','js','jsx','python','json','html','css','sql','sh','yaml','md'] }]]
  : [[rehypeHighlight, { detect: false, subset: ['ts','tsx','js','jsx','python','json','html','css','sql','sh','yaml','md'] }]]
```

> 注意：`ignoreMissing` **不是 rehype-highlight v7 的有效选项**（v7 `Options` 共 6 字段：aliases / detect / languages / plainText / prefix / subset，见 `node_modules/rehype-highlight/lib/index.d.ts:13-43`），该选项在 v7 已被移除，当前写法是无效配置，需一并删除。

2. 流式合批 —— 仓库内已有可复制的正确范式 `TranslateModule.tsx:198-223`，照搬到 `useStreamSession`：

```ts
// src/renderer/src/modules/chat/useStreamSession.ts
const chunkBufRef = useRef('')
const rafRef = useRef<number | null>(null)
const flushLive = useCallback(() => {
  rafRef.current = null
  const buf = chunkBufRef.current
  if (!buf) return
  chunkBufRef.current = ''
  setLiveColumns((prev) => prev?.map((c, i) =>
    i === targetIndexRef.current ? { ...c, content: c.content + buf } : c))
}, [])
// 订阅内：chunkBufRef.current += e.delta
//           if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushLive)
// cleanup： if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
```

**验收**

- 同段 markdown 重解析耗时 < 250 ms（对比基线 3052 ms）。
- 连续流式输出时 React 提交次数从「每 token 一次」降到「每帧一次」。
- 代码高亮在无语言标注的块上降级为纯文本（不再误触发 37 语言嗅探）。

---

### PERF-03 · Markdown 组件/插件字面量 → 子树重挂载、组件状态重置

**级别** 高 ｜ **状态** 已修复 ｜ **位置** `src/renderer/src/modules/chat/Markdown.tsx:142-152`（`components` 展开至 `:216`）｜ **验证** 已实测

**问题**

`components` 与 `plugins` / `rehypePlugins` 每次渲染都是新建的数组/对象字面量：

```ts
// src/renderer/src/modules/chat/Markdown.tsx:142-152
const plugins = citationCount > 0 ? [remarkGfm, remarkMath, remarkCitations] : [remarkGfm, remarkMath]
const rehypePlugins: PluggableList = katexPlugin ? [...] : [...]
return (
  <ReactMarkdown
    remarkPlugins={plugins}
    rehypePlugins={rehypePlugins}
    components={{ sup: ..., a: ..., img: ..., pre: ..., code: ..., table: ..., th: ..., td: ... }}
```

react-markdown 10.1.0 的 `Markdown` 是**同步组件、无 memo**（`node_modules/react-markdown/lib/index.js:176` 直接 `createProcessor(options)`），只要 `content` 或 `options` 引用变了就必然全量重解析；而 `options` 每次都是新引用 → **每次父组件 rerender 都会卸载重挂整棵 Markdown 子树**。

**实测**：父组件 rerender 一次 → 子组件 **mount 2 次 / unmount 1 次**，且 `CodeBlock` 内部的 `useState` 折叠态被重置回 `EXPANDED`：

```ts
// src/renderer/src/modules/chat/Markdown.tsx:70-71
// 初始折叠态只在挂载时计算：流式生成中越过阈值不打断阅读，历史消息重挂即折叠
const [collapsed, setCollapsed] = useState(() => isCollapsible(block.code, codeCollapseLines()))
```

注释描述的「历史消息重挂即折叠」在流式生成中同样发生 —— 代码块会在生成过程中反复自动折叠/展开。

连带影响：`MermaidBlock` 的 effect 依赖 `[code, themeTick]`（`MermaidBlock.tsx:44-74`），父级每次 rerender 就重新 `mermaid.render`（含 DOM 测量 + SVG 序列化）。

**改法**

把不依赖运行时状态的部分提升为模块级常量：

```ts
// src/renderer/src/modules/chat/Markdown.tsx —— 模块级
const GFM_PLUGINS = [remarkGfm, remarkMath]
const HIGHLIGHT_OPTIONS = { detect: false, subset: [...] }
const BASE_COMPONENTS = { a: ..., img: ..., pre: ..., code: ..., table: ..., th: ..., td: ... }
```

`sup` 依赖 `citationCount` / `onCitation`，可按 `citationCount` 分桶用 `useMemo` 缓存，或改用 `data-citation` 属性 + 事件委托（`Markdown.tsx:153-171` 已在读 `node.properties.dataCitation`）。

**验收**

- 父组件 rerender 不再导致 Markdown 子树 mount/unmount（用 React DevTools Profiler 或测试断言 mount 次数）。
- 流式生成过程中代码块折叠态保持稳定。
- 含 mermaid 的回答在流式期间不重复渲染图表。

---

### PERF-04 · 消息/会话列表接口无 LIMIT，缺复合索引

**级别** 高 ｜ **状态** 已修复 ｜ **位置** `src/main/db/repositories/message.repo.ts:75-81`、`src/main/db/repositories/conversation.repo.ts:116-131` ｜ **验证** 已实测（修复口径：v83 复合索引 + message.repo 游标分页已完成；ChatView 滚动加载接线留待下迭代）

**问题**

```ts
// src/main/db/repositories/message.repo.ts:75-81
listByConversation(conversationId: string): MessageRecord[] {
  const rows = dbService.getHandle()
    .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId) as MessageRow[]
```

```ts
// src/main/db/repositories/conversation.repo.ts:116-131
.prepare(`SELECT c.*, ( ... LIMIT 1 ) AS last_preview, EXISTS(...) AS has_draft
         FROM conversations c${where} ORDER BY ${orderBy}`)
.all(...vals) as ConversationRow[]
```

两者均无 `LIMIT`/`OFFSET`，全量加载后经 IPC 整体跨进程传输。

**量化影响**：会话 1,000 × 消息 500 时，`convList` 实测耗时 **1,299 ms**（主进程同步阻塞）。EXPLAIN 显示走 `TEMP B-TREE FOR ORDER BY` —— 缺 `(conversation_id, created_at)` 复合索引。

**改法**

1. 补复合索引（`src/main/db/database.ts` 迁移段）。现有 messages 索引只有 `idx_messages_created_at(created_at)`（`:536`）、`idx_messages_starred(starred, created_at DESC)`（`:641`）、`idx_messages_pinned(conversation_id, pinned)`（`:692`）——均不能同时服务 `WHERE conversation_id=?` 与 `ORDER BY created_at`：

```sql
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);
-- 注意：单列 created_at 索引已存在（idx_messages_created_at，:536），不要重复创建
```

2. 列表接口加游标分页（`conversation_id + created_at` 游标，优于 OFFSET 深分页）：

```ts
listByConversation(conversationId: string, opts?: { limit?: number; before?: number }): MessageRecord[] {
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 200))
  const sql = opts?.before
    ? 'SELECT * FROM messages WHERE conversation_id=? AND created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?'
    : 'SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC LIMIT ?'
  ...
}
```

3. 会话列表侧先按 `updated_at` 倒序取前 N 条（含 `last_preview` 的相关子查询需用索引回表，见会话表结构）。

**验收**

- 1,000 会话 / 500 消息的库，`convList` < 100 ms。
- 首屏加载的消息数有明确上限；滚动加载走游标，不重复不漏项。

---

### PERF-05 · FTS5 DELETE 触发器在 UNINDEXED 列上全表扫

**级别** 高 ｜ **状态** 已修复 ｜ **位置** `src/main/db/database.ts:443,448`（`kb_chunks_fts`）、`:1521,1525`（`kb_chunks_fts_short`）｜ **验证** 已实测

**问题**

删除触发器按 `chunk_id` 删除，而 `chunk_id` 在 FTS5 表中是 **UNINDEXED** 列 —— 条件无法走索引，每删一行 chunk 扫一次整张 FTS 表：

```sql
-- src/main/db/database.ts:443
DELETE FROM kb_chunks_fts WHERE chunk_id = old.id;
```

`kb_chunks` 上有**两张** FTS 表（`kb_chunks_fts` + migration v79 新增的 `kb_chunks_fts_short`），扫描量翻倍。

**量化影响**：1 万 chunk 的库删除耗时 **82 秒**。

**改法**

改用 `rowid` 关联（UNINDEXED 列仍可用 rowid 精确定位），并在 FTS 表外建映射：

```sql
-- 触发器改为按 rowid 删除（fts5 表的 rowid 与源表 rowid 显式绑定）
CREATE TRIGGER kb_chunks_fts_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, content, doc_id, kb_id) VALUES (new.rowid, new.content, new.doc_id, new.kb_id);
END;
CREATE TRIGGER kb_chunks_fts_ad AFTER DELETE ON kb_chunks BEGIN
  DELETE FROM kb_chunks_fts WHERE rowid = old.rowid;
END;
```

迁移需重建两张 FTS 表并回填（参考 `docs/kb-upgrade-plan-2026-11.md` 阶段 2 的 v79 回填写法）。现有 INSERT 触发器（`database.ts:434-438`）**不绑定 rowid**（FTS rowid 为自动分配），故按 rowid 删除必须连同 INSERT 触发器一起改并整表重建，两者缺一即产生错删/漏删。

**验收**

- 先在副本库实测 SQLite 触发器内 `old.rowid` / `new.rowid` 的可用性 —— `kb_chunks` 主键是 `id TEXT`（无 INTEGER PRIMARY KEY 别名），触发器内引用 rowid 属有历史争议的行为；若不可用，退回「chunk_rowid ↔ fts_rowid 映射表」方案（参照 `kb_vec_map` 的做法）。
- 1 万 chunk 删除耗时 < 2 秒。
- 重建后 FTS 检索结果与改造前逐条一致（长查询排名口径不变）。

---

### SEC-16-07 · 字段解密 fail-open：形状不匹配时原样返回存储值

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/crypto/field-encrypt.ts:54-75`（fail-open 在 `:60`）｜ **验证** 已验证

**问题**

两条解密分支的失败语义不一致：

```ts
// src/main/crypto/field-encrypt.ts:54-75
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return ''
  if (!isCipherText(stored)) return stored // ← 历史明文：直接返回（fail-open）
  try {
    ...
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    log.warn('字段密文解密失败（密钥不匹配、锁定中或数据损坏）')
    return ''                                   // ← fail-closed
  }
}
```

- 形状合法但 GCM tag 校验失败 → 返回 `''`（正确）。
- 形状不合法（被截断、被改写、不以 `v1:` 开头）→ **原样返回存储内容**。

代码自陈 `isCipherText` 存在形状歧义：「随机 ASCII 口令里仍有约 1.7% 撞得进这个形状」（`:28-30`），双向误判。

**影响**

凭据完整性边界不可靠；凭据可用性可能静默降级（表现为「Key 没了」）。none 模式下 DB 明文可写 → 任意密文列可被替换为自选明文，读回时被当作真凭据使用。

**改法**

短期折中（不改 schema，先去掉 fail-open）：

```ts
if (!isCipherText(stored)) {
  log.warn(`字段值既不是密文也不是已知明文形态，按无凭据处理: len=${stored.length}`)
  return ''
}
```

长期正解：把「这是密文」落进独立列/表，读侧显式判定，不再靠猜形状：

```ts
export function decryptSecret(stored: string | null | undefined, isCipher: boolean): string {
  if (!stored) return ''
  if (!isCipher) return stored          // 明确标记的明文（仅迁移期）
  try { /* ... GCM 解密 ... */ }
  catch { log.warn('字段密文解密失败'); return '' }   // 一律 fail-closed
}
```

迁移通道保留但**只读一次**：`provider.repo.ts:253-267`（`migratePlaintextKeys`）、`mcp-server.repo.ts:245-265`（`migratePlaintextSecrets`）、`secret-store.ts:64-72`（`migrateKvSecrets`），迁完即关闭。

**验收**

- 被截断的密文读取返回空串，不再返回残值。
- 迁移期明文凭据仍能读出，且迁完后再读走 fail-closed 路径。

---

### SEC-16-08 · none 模式固定密钥为默认态，且实际覆盖全部凭据

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/crypto/master-key.ts:20-27,47-53`、`src/main/db/repositories/app-config.repo.ts:329-331` ｜ **验证** 已验证

**问题**

```ts
// src/main/crypto/master-key.ts:20-27
// 固定密钥（无密码模式下字段加密用的弱混淆密钥）
// 仅用于非敏感场景（config.json 等），不是真正的安全保障：
// 派生输入（下方口令与盐）随源码公开，任何人可复现。
const FIXED_KEY_PASSWORD = 'PocketAI-local-only'
const FIXED_KEY_SALT = Buffer.from('PocketAI-fixed-key-v1', 'utf8')
```

```ts
// src/main/db/repositories/app-config.repo.ts:329-331
getEncryptionMode(): EncryptionMode {
  return (this.get(KEYS.ENCRYPTION_MODE) as EncryptionMode | null) ?? 'none'   // ← 默认态
}
```

注释声称「仅用于非敏感场景」，但该密钥实际覆盖**全部**凭据：provider apiKeys / MCP env+headers / MCP OAuth 三件套 / 渠道 bot token / WebDAV 口令。

**影响**

全新安装默认 none ⇒ ① `data/app.db` 是完全明文的 SQLite；② 所有字段密文的密钥 = `scrypt('PocketAI-local-only', 'PocketAI-fixed-key-v1', N=32768, r=8, p=1)`，**任何拿到 app.db 的人都能离线复现并解出全部凭据**。

降级是实打实发生的：`ENCRYPTION_DISABLE` 路径会把原主密钥下的凭据**用固定密钥重写落盘**（`ipc/handlers/encryption.ts:296-331`）。

**改法**

1. **修正注释**（当前描述与实际用途不符，会误导后续维护者）：
   `master-key.ts:20-25` 改为「none 模式下字段加密用的**固定可复现**密钥，覆盖全部凭据；仅提供混淆而非机密性」。
2. 产品决策项（待决策）：把 `getEncryptionMode()` 的缺省从 `'none'` 改为**首次启动强制进入 setPassword 流程**。`src/main/index.ts:366-367` 已有 `setPassword` 分支，改造成本低。
3. 若不改默认，则 UI 上必须明确标注「当前凭据**未受保护**」，并把「字段加密」改称「字段混淆」。

**已有缓解（保留）**：`none-mode-gate.ts:54-65` 按值判定拒绝写入新密钥；禁用加密需主进程原生二次确认并清点凭据数（`encryption.ts:262-266`）；`security_events` 留痕（`:335-342`）；`encryptBackup` 拒绝用固定密钥产出假加密备份（`backup-service.ts:284-287`）。

**验收**

- 注释与实际用途一致。
- 若采纳「强制设密」，全新安装首次启动进入设密流程，已有 none 库平滑过渡（不丢凭据）。

---

### SEC-16-09 · 日历 `.ics` 路径未走 `dialog-path-token`

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/tools/calendar-ics.ts:36-58`（`setCalendarConfig`）、`src/main/ipc/handlers/agent.ts:212-223`（配置 IPC）、`:225+`（`AGENT_PICK_ICS_FILE`）｜ **验证** 已验证

**问题**

`calendar.read` 工具**只接受 `range` 参数**（`calendar-ics.ts:207-212`），路径来自 `app_config` 的 `agent.calendar_ics_paths`。但该配置的写入通道接受渲染层传入的**任意绝对路径**（只校验 `.ics` 后缀）：

```ts
// src/main/ipc/handlers/agent.ts:212-223
safeHandle(IPC.AGENT_SET_CALENDAR_CONFIG, (_e, input: { enabled?: unknown; paths?: unknown }) => {
  const patch: { enabled?: boolean; paths?: string[] } = {}
  if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
  if (Array.isArray(input?.paths)) {
    patch.paths = input.paths.filter((p): p is string => typeof p === 'string')
  }
  return setCalendarConfig(patch)
}, argsSchema(calendarConfigSchema))
```

`setCalendarConfig`（`calendar-ics.ts:40-55`）只做 `.ics` 后缀 + 去重 + 上限 10 条，**无路径令牌绑定、无工作目录约束**。

而主进程已有专门机制防这个（`src/main/ipc/dialog-path-token.ts`，注释即 SEC-6 的成因）：「若让渲染端回传**绝对路径**，该通道就变成『渲染端可指定任意路径让主进程读并写进应用状态』」。日历配置**未使用**该机制。

**影响**

- 渲染层（XSS / 供应链投毒）可写入任意 `.ics` 绝对路径，随后 `calendar_read`（`permission: 'confirm'`）会读取该文件，内容回灌模型上下文。
- 审批面板只展示工具入参 `{"range":"today"}`，**看不到实际会读哪些文件**（审批披露缺口）。

**改法**

1. `AGENT_PICK_ICS_FILE` 改签发 path token，配置侧只收 token：

```ts
// src/main/ipc/handlers/agent.ts
safeHandle(IPC.AGENT_PICK_ICS_FILE, async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const r = await win?.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'iCalendar', extensions: ['ics'] }] })
  if (!r || r.canceled || r.filePaths.length === 0) return { canceled: true }
  const token = issuePathToken(r.filePaths[0]!)
  return { canceled: false, token, fileName: path.basename(r.filePaths[0]!) }
})
// SET_CONFIG 侧：paths 改为 tokens，peekPathToken 解析后再校验 .ics 后缀
```

2. 审批预览补充将读取的文件名列表（`ApprovalPreviewField` 已有该能力），让用户看到「将读取 3 个日历文件：a.ics、b.ics、c.ics」。

**验收**

- 渲染层传入任意绝对路径（不经对话框）被拒。
- 审批弹窗展示实际读取的文件名。

---

### SEC-16-10 · 备份合并整表覆盖丢本地知识库，向量索引不一致

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/backup/merge-service.ts:91-94`（表清单）、`:618-622`（覆盖执行）｜ **验证** 已验证

**问题**

```ts
// src/main/backup/merge-service.ts:91-94 —— 云端覆盖清单共 7 张表，kb_* 三张在其中
const CLOUD_OVERWRITE_TABLES = [
  'assistants', 'providers', 'skills', 'mcp_servers',
  'knowledge_bases', 'kb_documents', 'kb_chunks'
]
```

云端备份合并时对清单内各表**整表 DELETE + 覆盖**（`assistants`/`providers`/`skills`/`mcp_servers` 属配置表语义、凭据列已按 `CREDENTIAL_COLUMNS` 保留本机值），其中 `kb_documents` / `kb_chunks` 被覆盖意味着**本地知识库内容被云端版本整体替换**。

**影响**

- 本地独有文档丢失（备份是全量替换语义，但用户预期通常是「合并」）。
- **`kb_vec_map` 不在清单内** → 覆盖后 chunk 表与向量映射表不一致，向量检索命中错位或漏召回。

**改法**

1. `kb_documents` / `kb_chunks` 改按行合并（并入 `ROW_MERGE_TABLES`，用 `doc_id` / `chunk_id` 做冲突策略），而非整表覆盖。
2. 覆盖类清单与向量表必须成组：`kb_chunks` 覆盖时同步 `kb_vec_map`（以及 `kb_chunk_embeddings` 等向量相关表）——建议成组声明：

```ts
// 覆盖组：chunk 与其向量映射必须同进同出
const CLOUD_OVERWRITE_GROUPS = [
  ['knowledge_bases'],
  ['kb_documents', 'kb_chunks', 'kb_vec_map'],   // ← 向量表必须同组
]
```

3. 覆盖前给用户明确提示「云端备份将替换本地知识库」。

**验收**

- 本地独有文档在合并后仍在。
- `kb_chunks` 与 `kb_vec_map` 行集合一致（写一条断言）。

---

### SEC-16-11 · 凭据 reveal 通道零审计留痕

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/ipc/handlers/providers.ts:28-32`、`src/main/ipc/handlers/mcp.ts:133-138` ｜ **验证** 已验证

**问题**

这两发是全应用**唯一**把凭据明文交给渲染层的通道：

```ts
// src/main/ipc/handlers/providers.ts:28-32
safeHandle(IPC.PROVIDER_REVEAL_KEYS, (_e, id: string) => {
  const rec = providerRepo.get(id)
  return { ok: true as const, apiKeys: rec?.apiKeys ?? [] }
}, argsSchema(idSchema))
```

已核实 `securityEventRepo.append` **只在两处被调用**（`encryption.ts:335` / `encryption.ts:387`，都是加解密开关），reveal 通道**零审计**。

**影响**

渲染层任意一处 XSS / 供应链投毒 / 被注入的 `ipcRenderer` 即可**批量**遍历并导出全部 Provider API Key 与 MCP env/headers（每条一次调用），且不留任何痕迹。锁屏网关 `src/main/lock/ipc-gate.ts:42` 只在**锁屏期间**抛 `APP_LOCKED` 阻断，运行时完全开放。

**改法**

「审计 + 单次令牌 + 限流」三件套：

```ts
safeHandle(IPC.PROVIDER_REVEAL_KEYS, (_e, id: string, token: string) => {
  if (!revealTokenStore.consume(token)) return { ok: false as const, error: '查看密钥需重新确认' }
  securityEventRepo.append({ kind: 'credential_reveal', message: `揭示 provider 凭据: ${id}`, detail: { providerId: id } })
  const rec = providerRepo.get(id)
  return { ok: true as const, apiKeys: rec?.apiKeys ?? [] }
}, argsSchema(idSchema, z.string()))
```

另：同一 id 的 reveal 加 60 s 冷却；揭示后在渲染层 30 s 自动清除（复用 `clipboard-guard` 的 TTL 思路）。

**验收**

- 每次 reveal 在 `security_events` 留痕。
- 重复 reveal 需重新取令牌。

---

### PERF-06 · usage 预算聚合每次回复 2 次窗口扫描 + 逐行取回 JSON.parse

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/usage/usage-service.ts:433-455` ｜ **验证** 已实测

**问题**

每次助手回复对日 / 月窗口各触发一次 30 天窗口聚合（`getBudgetStatus` → `sumCostSince`），同步阻塞主进程。成本不在扫描本身 —— `usage_events(created_at)` 已有索引 `idx_usage_events_created`（`database.ts:1340`），实际是**索引范围扫描 + 逐行取回 + 逐行 `JSON.parse`**；实测 2 万条 usage 事件时单次 **132 ms**。

**改法**

1. 聚合下沉为 SQL（`SUM`/`COUNT` 在 SQLite 内完成），只把聚合结果带回 JS，不再整表取行再 `JSON.parse`。
2. 结果按会话/对话缓存（key 含 `convId`），回复结束失效。

> 索引已存在，无需新建。

**验收**

- 2 万条 usage 事件下聚合 < 10 ms。
- 预算数字与改造前一致（回归用例对比）。

---

## 4. P2：下迭代

### PERF-07 · N+1 查询

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/db/repositories/kb.repo.ts:35-43`、`src/main/db/repositories/skill.repo.ts:98-106`、`src/main/attachment/attachment-ingestion.ts:94-99` ｜ **验证** 已验证

> 修复口径：PERF-07｜kb.repo 列表改为 2 条 GROUP BY 聚合 JOIN（1000 行 prepare 2N+1→1）；skill.repo 批量 IN 分片；attachment 引用判断走 v85 idx_kb_docs_source。

**问题**

- `kb.repo.ts:35-43`：每行 2 条 COUNT 子查询（列表页 N 行 → 2N 次计数）。
- `skill.repo.ts:98-106`：循环内逐条单查。
- `attachment-ingestion.ts:94-99`：每次删消息都全表扫 `kb_documents` 判断引用。

**改法**

- 计数改用 `GROUP BY` 聚合子查询或物化计数列；
- 逐条单查改批量 `IN (...)`；
- 附件引用判断走 `(doc_id)` 索引。

**验收**

- 1,000 行的列表接口查询次数从 O(N) 降为 O(1)。

### PERF-08 · `prepare()` 每次重建

**级别** 中 ｜ **状态** 已修复 ｜ **位置** 多处；典型 `src/main/db/repositories/kb-vec.repo.ts:78-80`（在循环体内 prepare）｜ **验证** 已实测

> 修复口径：PERF-08｜新建 statement-cache（WeakMap<db, Map<sql,stmt>>），热路径统一 cachedPrepare，kb-vec 循环内 prepare 移出；3000× UPDATE 基准 447ms→20ms（21.9×）。

**问题**

实测 UPDATE 场景 4,428 ms vs 217 ms（**20 倍**）差距。

**改法**

- 静态 SQL 预编译一次并缓存（按 SQL 字符串做 Map key）；动态部分用参数绑定。
- `kb-vec.repo.ts:78-80` 的 prepare 移出循环。

**验收**

- 热路径 SQL 全部走缓存；基准脚本记录改造前后对比。

### PERF-09 · 索引队列无上限、无去重、无退避

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/knowledge/index-queue.ts:48-84` ｜ **验证** 已验证

> 修复口径：PERF-09｜容量上限 500 + docId 全生命周期去重 + 并发上限（生产单例 3）+ 指数退避重试 3 次 + app_config 进度上报；默认构造保持旧语义兼容既有测试。

**问题**

导入 500 个文件会堆 500 个任务，无并发上限、无同文档去重、无失败重试退避。叠加 PERF-05（删除慢）可能长时间卡住。

**改法**

- 队列容量上限 + 同 `docId` 去重（已在队列的合并）；
- 并发上限（建议 2–4）；
- 失败重试指数退避 + 最大次数；
- 进度上报到 `app_config` 便于 UI 展示。

**验收**

- 导入 500 文件时队列长度不超上限，重复文档不重复入队。

### PERF-10 · 工具注册表每次访问重建全量索引

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/main/tools/registry.ts:161-177`（`buildIndex`）、调用点 `src/main/agent/engine.ts:2647,2674,3460,1504,1604` ｜ **验证** 已验证

> 修复口径：PERF-10｜engine 一轮内复用同一 index，N 条调用 buildIndex 从 2N+2 降为 1；失效覆盖 MCP 状态/增删改/帧结束。

**问题**

`buildIndex()` 被 6 处独立触发，每次都要走 `listBuiltinTools()`（含 SQLite 点查）与 `listMcp()`（**逐个 runtime 读 env/headers 并解密**，见 `:155` 注释自述 SEC-11）。

调用点密度：`engine.ts:2647`（每条 tool call 一次 `classify`）、`:2674`（每条再一次 `getSchema`）、`:3460`（又一次）。即**一步内 N 条工具调用 ⇒ 约 2N+2 次全量索引重建**，含 N 次 MCP 凭据解密。

**改法**

- 按 `(workspace_dir, shell 策略, MCP 运行态)` 版本号做单帧缓存，engine 一轮内复用同一 index 对象；
- 或把 `classify` 改批量接口（一次收 N 条调用）下沉到 registry。

**验收**

- 单步 N 条工具调用的 `buildIndex` 次数从 2N+2 降为 1。

### SEC-16-12 · 导出 HTML 的 `href` 绕过协议白名单

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/renderer/src/utils/export-html.tsx:131-139`（KB 问答版在 `:206-214`）｜ **验证** 已验证

> 修复口径：SEC-16-12｜两处 sources href 走 safeHttpHref + 导出 head CSP meta；危险协议降级纯文本。

**问题**

应用内的 Markdown 链接走 `Markdown.tsx:172-186` 的 `SAFE_NAV_HREF` 白名单；其它外链走 `src/renderer/src/utils/external-url.ts:9-21` 的 `safeHttpHref`。**唯独导出 HTML 这条路径完全绕过白名单**：

```tsx
// src/renderer/src/utils/export-html.tsx:131-139
{sources.map((s, i) => (
  <li key={i}>
    {s.kind === 'web' && s.url ? (
      <a href={s.url} target="_blank" rel="noreferrer">{s.docTitle}</a>
    ) : (s.docTitle)}
  </li>
))}
```

**落地链路**：`ChatModule.tsx:1250-1251` → `ipc/handlers/conversations.ts:219` `writeFileAtomicSync(filePath, html)` → 落盘 HTML 的 `<head>`（`export-html.tsx:164-170`）**无 CSP meta** ⇒ 用户用浏览器打开后点击 `javascript:` 链接即可在该 `file://` 文档中执行脚本。

**改法**

```tsx
const href = s.kind === 'web' ? safeHttpHref(s.url) : null
{href ? <a href={href} target="_blank" rel="noreferrer">{s.docTitle}</a> : s.docTitle}
```

并给导出 HTML 的 `<head>` 加 CSP meta：

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'">
```

**验收**

- `javascript:` / `data:` / `file:` 链接在导出物中降级为纯文本。
- 导出 HTML 含 CSP meta。

### SEC-16-13 · Markdown 远程图片向第三方泄漏 IP 与 Referer

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/renderer/src/modules/chat/Markdown.tsx:31-32,183-186`、`src/main/security/csp.ts:17-18` ｜ **验证** 已验证

> 修复口径：SEC-16-13｜SAFE_IMG_SRC 收紧 data:/blob: + CSP img-src 去 https: + referrerPolicy + cacheBust:false；默认不加载远程图片，降级可点占位链接。

**问题**

```ts
// src/renderer/src/modules/chat/Markdown.tsx:31-32
const SAFE_NAV_HREF = /^(https?:|mailto:)/i
const SAFE_IMG_SRC = /^(https?:|data:image\/|blob:)/i
```

```ts
// src/main/security/csp.ts:17-18
// 附件经 IPC 以 data:/blob: 展示；Markdown 远程图片允许 https:
"img-src 'self' data: blob: https:",
```

LLM 输出的 markdown 可包含 `![](https://attacker.tld/pixel.png)`，渲染时把**用户真实出口 IP、User-Agent、Referer** 泄露给第三方，并构成可去匿名化的追踪像素。同一机制也作用于 `export-image.tsx:117-121` 的 `toPng(el, { cacheBust: true })` —— 导出长图时会重新抓取这些外域图片。

**改法**（三选一或叠加）

1. 渲染层代理：图片走主进程抓取后转 `data:`/`blob:`（渲染层 `connect-src 'self'` 本就不允许直连）；
2. 收紧 CSP `img-src`（去掉 `https:`），由主进程白名单放行；
3. 渲染层加 `referrerPolicy="no-referrer"` + `loading="lazy"`（缓解但不解决 IP 泄漏，仅兜底）。

**验收**

- 渲染含外域图片的 markdown 时，无任何跨域请求发出（或仅向白名单域发出）。

### SEC-16-14 · mermaid SVG 未做二次净化

**级别** 中 ｜ **状态** 已修复 ｜ **位置** `src/renderer/src/modules/chat/MermaidBlock.tsx:53-59,103-108` ｜ **验证** 已验证

> 修复口径：SEC-16-14｜DOMPurify 二次净化 svg+svgFilters，FORBID_TAGS/ATTR；strict+DOMPurify+CSP 三层注释；dompurify 显式入 dependencies。

**问题**

```tsx
// src/renderer/src/modules/chat/MermaidBlock.tsx:103-108
<div
  className="mermaid-block ..."
  // mermaid 输出为受信 SVG（strict 模式转义文本、禁脚本）；CSP script-src 仍兜底
  dangerouslySetInnerHTML={{ __html: svg }}
/>
```

已核实缓解层：mermaid 11.17.2 在 `strict` 下走 `sanitizeMore` → `DOMPurify.sanitize`；生产 CSP `script-src 'self'` 兜底。但：

- SVG 源内容来自 **LLM 生成的 mermaid 代码**（`Markdown.tsx:189-192` 提取）⇒ 不可信输入；
- CSP 仅在生产生效（`csp.ts:34`：`if (process.env['ELECTRON_RENDERER_URL']) return`）⇒ **开发模式下无 CSP 兜底**；
- DOMPurify 默认白名单对 `<foreignObject>` / `<style>` 的处理随版本变动。

**改法**

```ts
import DOMPurify from 'dompurify'
const CLEAN = DOMPurify.sanitize(out, {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'script', 'use', 'animate', 'set'],
  FORBID_ATTR: ['xlink:href', 'href']
})
setSvg(CLEAN)
```

并在文件头注释标注「strict + DOMPurify + CSP 三层，任一层不可删」。

**验收**

- 构造含 `<script>` / `onload` / `<foreignObject>` 的 mermaid 输入，渲染后 SVG 中不含这些节点。

### SEC-16-15 · License 用 RSA PKCS#1 v1.5 且公钥不可轮换

**级别** 中 ｜ **状态** 修复中 ｜ **位置** `src/main/license/license.ts:131-143`、`src/main/license/public-key.ts:4-5`、发行侧 `scripts/lib/issue-license.js:86` ｜ **验证** 已实测

> 修复口径：签名字段前缀分流（ed25519: / 旧 RSA 裸 base64），验签严格 fail-closed；ED25519_PUBLIC_KEY_B64 留空待运维离线生成密钥对后填入，与 SEC-16-02 私钥轮换 / 客户端发布同批上线。旧 RSA 证长期并存、不设过渡截止；新签发走 Ed25519（2026-11-28 用户决策）。

**问题**

```ts
// src/main/license/license.ts:131-143
function verifySignature(signedData: string, signatureB64: string): boolean {
  try {
    const pubKey = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY_DER_B64}\n-----END PUBLIC KEY-----`
    const verify = createVerify('RSA-SHA256')
    ...
```

实测内置公钥为 2048-bit RSA / e=65537 / `RSASSA-PKCS1-v1_5` + SHA-256。

**诚实边界**：这里是**验签**而非解密，攻击者拿不到解密预言机，**不构成 Bleichenbacher padding oracle**。真实风险是：(a) PKCS#1 v1.5 验签不是 CCA 安全的，NIST SP 800-131A Rev.2 已将其签名用途降级为遗留；(b) 2048-bit RSA 的长期有效性不满足 2030 年后要求；(c) **授权根只有这一把钥匙，没有轮换/多签机制** —— 而 SEC-16-02 已确认私钥曾留存于交付工作区，轮换能力是必需的。

**改法**

改用 Ed25519，公钥版本化以兼容旧证：

```ts
// src/main/license/public-key.ts —— v2 键（Ed25519，32 字节公钥）
export const ED25519_PUBLIC_KEY_B64 = '<base64 of 32-byte SPKI>'

// src/main/license/license.ts
import { verify } from 'node:crypto'
function verifySignature(signedData: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(ED25519_PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki'
    })
    if (key.asymmetricKeyType !== 'ed25519') return false
    return verify(null, Buffer.from(signedData, 'utf8'), key, Buffer.from(signatureB64, 'base64'))
  } catch { return false }
}
```

发行侧改 `crypto.sign(null, Buffer.from(canonical), privateKey)`；**必须与 SEC-16-02 的密钥轮换同批发布**。

**验收**

- 旧 RSA 许可证在过渡期内仍可验签（按公钥版本分流）。
- 新签发的许可证用 Ed25519 验签通过。

---

## 5. P3：低危与工程项

### SEC-16-16 · 便携导出 MOXENC1 的 KDF 档位钉死 N=2^15 且格式不可演进

**级别** 低 ｜ **状态** 已修复 ｜ **位置** `src/main/crypto/portable-crypto.ts:6-11,31,57`

> 修复口径：SEC-16-16｜MOXENC2 + kdfId(1)：新写 KDF_CURRENT，旧 MOXENC1 仍走 KDF_LEGACY；未知档位 fail-closed。

`KDF_LEGACY = { N: 32768, r=8, p=1 }`（`crypto/index.ts:44`），内存 32 MiB，是 `KDF_CURRENT`（N=2^17，128 MiB，**恰达 OWASP 最低推荐**）的 1/4 工作量。

`MOXENC1`（便携导出）**格式里没有档位字段** ⇒ 永久停在 2^15，且改档=老文件永久解不开。此项**只适用 MOXENC1**：备份信封 `PKBK2` 在读取侧已逐档尝试 `[KDF_LEGACY, KDF_CURRENT]` 并用 GCM tag 自证 + rememberTier（`backup-service.ts:118-123,136-144`），写侧 `encryptBackup`（`:283-303`）不经密码 KDF，不受此限；恢复包 `rv1:` 见下方说明。

**改法**：`MOXENC1` 加版本位（`MOXENC2` + kdfId(1)），读时按头标识选档、旧文件仍走 1；`PKBK2` 无需改动。

> 恢复包 `rv1:` 不必改 —— 恢复码 160-bit 熵，KDF 档位不改变攻击成本（`recovery-key.ts:67-78`）。

### SEC-16-17 · 恢复码 Crockford Base32 容错映射定义但未接线

**级别** 低 ｜ **状态** 已修复 ｜ **位置** `src/main/crypto/recovery-key.ts:25-32,51-56`

> 修复口径：SEC-16-17｜normalizeRecoveryCode 接线 Crockford 映射 I/L→1、O→0、U→V，旧码不变。

`DECODE_MAP['I']/'L'] → 1`、`DECODE_MAP['O'] → 0` 已定义，但全仓 `DECODE_MAP` 仅命中定义处，`normalizeRecoveryCode` 只做了大写 + 去分隔符。

**影响**：用户把 `1` 看成 `I`（或 `0` 看成 `O`）输入，恢复码被判为「无效」—— 恢复码是忘密码时的**唯一救援通道**（`rv1:` 包在 DB 之外的 `config.json`）。

**改法**

```ts
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')      // Crockford：I/L → 1
    .replace(/O/g, '0')          // O → 0
    .replace(/U/g, 'V')          // U → V（防手滑）
}
```

### 人工确认结论（2026-11-28 收口）

| # | 事项 | 代码位置 | 结论 / 需确认 |
|---|---|---|---|
| C1 | `license-server` 默认 `http://0.0.0.0:8787` 明文 | `license-server/server.js:39,367,391` | **已确认（2026-11-28）**：生产置于 HTTPS 反代之后，服务端 http 仅由反代终止 TLS；客户端侧已强制 https（`server-config.ts:26-28` 非法直接抛错拒绝启动）。无需代码改动 |
| C2 | 改密后恢复码是否强制用户保存 | `encryption.ts:227-231,504-505` | **已决策（2026-11-28）**：改密后强制保存新恢复码；当前仅提示，需后续实施渲染层流程（本次只记口径，不改代码） |
| C3 | 主密码长度与字符形态 | `src/shared/schemas/encryption.ts:8,16-18` | **已确认（2026-11-28）**：≥10 位即可，允许大小写字母、数字符号及其任意组合，含纯字母或纯数字；不引入复杂度强制。现有 `newMasterPasswordSchema` 已符合该口径，无需代码改动 |
| C4 | 终端会话的窗口关闭清理 | `src/main/terminal/terminal-service.ts` + `src/main/quit-manager.ts` + `src/main/index.ts` | 应用退出/锁屏/隐藏时子进程树是否被完整清理。**代码侧已收口**（`bf5a343`）：退出链（正常与 `will-quit` 兜底）调用 `killAllTerminals()` + `killInFlightShellJobs()`（`quit-manager.ts:104,108,135,139`）；主窗口 hide/minimize 调用 `killAllTerminals()`（`index.ts:244,249`）；锁屏态由 `lockService.onStateChange` 终止会话（`terminal-service.ts:221-226`）。剩余仅真机确认进程树无残留 |

---

## 6. 已验证有效的防护基线

> 以下机制本次逐条复核确认有效，**后续审计不必重复排查**，修改相关代码时须保持不破。

**加密与密钥**

- SQLCipher `PRAGMA key` 在任何查询/迁移之前设置（`db/database.ts:1642-1655`）；每页 HMAC-SHA512 认证实测生效（篡改 1 字节 → `SQLITE_CORRUPT`，错误密钥 → `SQLITE_NOTADB`）。
- 4 处 `createCipheriv`（`backup-service.ts:297`、`recovery-key.ts:74`、`field-encrypt.ts:48`、`portable-crypto.ts:33`；scripts/tests 另有 8 处非生产代码）的 IV **全部**为当场 `randomBytes(12)`，无固定 IV / 计数器复用；**全仓 `Math.random` 未用于任何密钥、IV、salt、token**（全仓 12 处命中逐一归类为文件名后缀 / requestId / 重试抖动）。
- 主密码 KDF 为 `scrypt N=2^17, r=8, p=1`（128 MiB），恰达 OWASP 最低推荐；**全仓无 PBKDF2 / MD5 / SHA-1 快速哈希派生**。
- KDF 参数白名单 + `normalizeKdfParams` 非白名单回 null，防止 `config.json` 被篡改 `N` 打爆内存。
- 密钥轮换 5 个换钥点同源，均走 `exportFieldCredentials/restoreFieldCredentials` + `captureWebDAVForRekey/restoreWebDAVAfterRekey`，无遗漏；`hasUndecryptableCipher` 严格区分「解不开」与「没配过」。
- 恢复码 160-bit 熵，包裹 masterKey 而非口令；恢复包在 DB 之外。

**边界与注入**

- 工作目录四重路径守卫：反斜杠归一 → `posix.normalize` → NUL 检查 → `path.resolve` 前缀校验 → `assertWithinWorkspaceByRealpath` 复核（**除 SEC-16-03 的悬空链接缺口**）。
- 全授权 `'*'` 只覆盖内置工具，MCP 工具须显式 id（`tools/registry.ts:104-107`）。
- 会话白名单粒度＝工具名＋规范化参数指纹（`agent/tool-approval.ts:58-73`）；危险档不查也不写白名单；审批 5 分钟超时按拒绝处理；无人值守场景 confirm 直接降级 `policy_deny`。
- 命令执行前二次分类（`shell-tools.ts:545-549`），防「判定后、执行前」配置被改松；`^` 转义符先行剥离（`:262`）。
- 子进程输出双层截断（字节 + 字符）；文件读取 256 KB、目录列举 500 条上限。
- JS 沙箱：独立 partition + 禁网 + 全权限拒绝 + 导航封锁；代码注入用 `JSON.stringify` 作字面量，无结构逃逸面。
- MCP Windows shim 元字符硬拒（`mcp/win-shim.ts:31,104-118`）。
- 技能文件四道闸 + `O_NOFOLLOW` + sha256 复验；归档解压 Zip Slip 前置校验。

**数据与凭据**

- 日志双层脱敏（结构化按键名 + 文本级规则 + 长度封顶）；IPC 错误回包统一过 `redactSecretsInText`。
- 凭据默认只出 `hasPrimarySecret/hasSecondarySecret` 布尔标记；MCP OAuth `rowToView` 不含 secret；`assertPersistAllowed` 在 none 模式拒绝落库任何 token。
- 合并时凭据列保留本机值（`merge-service.ts:110-113` 的 `CREDENTIAL_COLUMNS`）。
- OAuth：PKCE + state + `timingSafeEqual`；仅回环端口；端点强制 https；`iss` 校验；错误不透传 `error_description`。
- Provider 侧出网地址校验更严：非回环 http 拒绝 + 私网地址拒绝；全仓无 `rejectUnauthorized:false`。
- 原子写不留半份文件（同目录 tmp + rename）。

**渲染层**

- 无 `rehype-raw`；全仓无 `innerHTML` / `insertAdjacentHTML` / `document.write` / `eval`。
- 协议白名单 + 基于 `defaultUrlTransform` 的 `safeUrlTransform`；外链走 `openExternalSecure` + `denyNewWindows`。
- 生产 CSP：`script-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`、`connect-src 'self'`、`form-action 'none'`。
- iframe 沙箱 `sandbox="allow-scripts"`；预览页 `default-src 'none'` + DOMParser 剥离 meta refresh。
- 消息列表虚拟化（key 稳定 + `measureElement` 动态测高）；自动滚动仅在用户位于底部时跟滚。
- 流式订阅用 ref 固定回调避免重复订阅丢 chunk；卸载时移除全部 7 个 IPC 订阅并清 timer。
- 组件级保活 LRU（`MAX_KEPT_MODULES = 4`）；长任务观测（200 ms 阈值 + 5 s 节流）。

---

## 7. 验收与回归

### 7.1 每轮修复的通用门槛

1. `npm run typecheck` 通过。
2. `npm test`（vitest）全绿。
3. 涉及 SQL 的改动须在**真库**（非 mock）上跑通，并附 EXPLAIN QUERY PLAN。
4. 涉及加密格式的改动须验证**旧文件仍可解**（向后兼容）。
5. 涉及 IPC 契约的改动须同步 `src/preload/` 与 `src/shared/types.ts`，并补入参校验用例。
6. 性能类改动须记录**改造前后的量化对比**（同一数据集、同一机器）。

### 7.2 测试落点建议

| 条目 | 建议落点 |
|---|---|
| SEC-16-01 | `tests/tools-run-tests-args.test.ts`（元字符拒绝）+ Windows 真机集成用例 |
| SEC-16-03 | `tests/fs-tools-symlink-escape.test.ts`（悬空/已存在/链式/内部四类） |
| SEC-16-05 | `tests/shell-command-classify.test.ts`（`dd`/`fsutil`/`vssadmin`/`rm -rf /` 变体） |
| SEC-16-07 | `tests/field-encrypt-fail-closed.test.ts`（截断密文 → 空串） |
| SEC-16-09 | `tests/calendar-ics-path-token.test.ts`（任意绝对路径被拒） |
| SEC-16-10 | `tests/backup-merge-kb-consistency.test.ts`（chunk 与 vec_map 一致性） |
| PERF-01 | 扩展 `tests/kb-perf-large.test.ts`（3k / 20k chunk，检索 P95） |
| PERF-02 | `tests/renderer-markdown-highlight.test.ts`（重解析耗时上限） |
| PERF-05 | `tests/kb-chunk-delete-perf.test.ts`（1 万 chunk 删除耗时） |
| SEC-16-15 | `tests/license-verify.test.ts`（Ed25519 验签 + 旧 RSA 兼容） |

### 7.3 人工复核清单

- [ ] SEC-16-02：确认私钥已从交付目录移除**且已从磁盘删除**（`git rm --cached` 无效，它是未跟踪文件）；确认打包产物（安装包 / asar / portable exe）内不含 pem。
- [ ] SEC-16-04：手动终端内执行 `dd`/`fsutil`/`vssadmin` 应被拦；锁屏后终端应终止。
- [ ] SEC-16-06：确认产品是否必须支持内网 NAS 的 http WebDAV（影响是否加二次确认而非直接拒绝）。
- [x] SEC-16-08：产品决策 —— 保留 `none` 默认；UI 标注「凭据未受保护」并将「字段加密」改称「字段混淆」（2026-11-28 用户决策，文案改动待实施）。
- [ ] SEC-16-09：审批弹窗是否展示将读取的日历文件名（需确认 UI 文案与交互）。
- [ ] PERF-01 / PERF-05：性能数字需在**目标用户真实数据量**下复测（至少 3k / 20k chunk 两档）。
- [ ] 全文核对：`安全审查修复方案.md` 的 H/M/L 编号与本文件的 SEC-16-xx / PERF-xx 无冲突；建议把本文件的 P0 三项回写进该文档的「分期计划」表。

---

## 8. 风险与注意事项

1. **改 deny-list 会影响既有用户工作流**：`dd`/`fsutil` 被硬拒后，少数依赖这些命令的合法场景（磁盘镜像、磁盘空间清理）会失效。建议在错误提示里给出可读原因，并保留「显式确认后放行」的二档（沿用 SEC-Batch-4 既定的两档模型）。
2. **改 KDF 档位会使老文件解不开**：`MOXENC1` 的 KDF 档位钉死是**必须做格式迁移**的技术债（加版本位 + 读时按头选档）；备份信封 `PKBK2` 的「GCM tag 自证逐档尝试」（`backup-service.ts:118-123,136-144`）是现成参照，但单靠读时逐档尝试救不了**无档位字段**的 `MOXENC1` —— 它还需要写侧换成新头。
3. **PERF-01 的改法涉及 SQL 形状**，需确认 sqlite-vec 0.1.9 在 `MATERIALIZED` CTE 下仍正确处理 `k = ?` 约束（sqlite-vec 对 LIMIT/`k = ?` 有硬约束，见 `kb-vec.repo.ts:150-152` 注释）。
4. **PERF-05 的触发器改写需重建 FTS 表并回填**，属数据层迁移，须先在副本库验证并准备回滚。
5. **改 none 模式默认值会影响全新安装体验**（多一步设密），也影响自动化测试的启动路径，须与产品确认（见 7.3）。
6. **SEC-16-13（远程图片）收紧后**，依赖外域图片的 markdown 会失效，属于可见行为变化，需在更新说明中交代。
7. 本次审计**未启动 Electron 应用做动态渗透测试**，也未审计 `src/main/net/` 与 `src/main/providers/` 的 TLS 细节（仅确认全仓无 `rejectUnauthorized:false`）——这两块留待后续专项。

---

## 9. 变更记录

| 日期 | 批次 | 内容 | 状态 |
|---|---|---|---|
| 2026-11-27 | SEC-Batch-16（初稿） | 5 路并行专项审计；27 项发现（3 严重 / 8 高 / 14 中 / 2 低）；其中 4 项已实测复现 | 已评审修订 |
| 2026-11-27 | 修复批（P0+P1） | 17 项实施完成：SEC-16-01（run_tests/post-edit-validation 直跑 Node + 路径白名单）、SEC-16-02（打包拦截脚本，私钥运维待办）、SEC-16-03（fs 守卫逐段 lstat+readlink 重写）、SEC-16-04/05（终端硬拒+审计+锁屏清会话、shell deny-list 补齐；reasonCode 正式拆分留下迭代）、SEC-16-06（WebDAV 强制 https + 本地备份 0600）、SEC-16-07（字段解密 fail-closed 迁移闸）、SEC-16-08（注释口径修正）、SEC-16-09（日历 path-token）、SEC-16-10（备份合并 KB 行级合并+向量一致性收口）、SEC-16-11（reveal 一次性令牌+审计+冷却）、PERF-01（KNN MATERIALIZED CTE）、PERF-02/03（highlight 收敛+组件提升+rAF 合批）、PERF-04（复合索引+游标分页；ChatView 接线留下迭代）、PERF-05（FTS 触发器按 rowid 重写，v84）、PERF-06（sumCostSince 指纹缓存+SQL 预过滤）；新增回归测试 12 个文件 111 例，全量 760 文件 7975 用例通过，tsc --noEmit 0 错误 | 已修复 |
| 2026-11-27 | 文档自审与勘误 | 对本文件自身做事实核查（两路核查代理核对约 90 条行号引用与全部事实断言 + 改法代码逐条推演）：修正 7 处事实错误（PKBK2 档位断言、0o600 计数、「唯一 http 通道」、throttle 漏检、Options 枚举、createCipheriv 计数、变更记录算术）、4 处改法缺陷（ELECTRON_RUN_AS_NODE 前提、TEST_FILE_RE 与意图不符、symlink 守卫越界回溯、old.rowid 触发器语义）、6 处偏差（SEC-16-10 表清单全引、PERF-04/06 冗余索引、SEC-16-07 函数名、SEC-16-05 正则缺口、§1.2 表述）；补充引文约定 | 已修订（本文档当前版本） |
| 2026-11-28 | 修复批（P2+P3） | 10 项实施完成并接上 4 处遗留：PERF-07（GROUP BY 聚合 + 批量 IN + v85 source 索引，1000 行 prepare 2N+1→1）、PERF-08（statement-cache WeakMap，基准 21.9×）、PERF-09（容量/去重/并发 3/指数退避/app_config 进度）、PERF-10（帧缓存，N 条调用 buildIndex 2N+2→1 + 失效路径）、SEC-16-12（导出 HTML href 白名单+CSP）、SEC-16-13（远程图片零跨域请求：SAFE_IMG_SRC 收紧+CSP img-src+referrerPolicy+cacheBust:false；行为变化=默认不显示远程图片）、SEC-16-14（DOMPurify 二次净化+dompurify 显式依赖）、SEC-16-15（Ed25519 签名字段前缀分流，公钥待运维填入 → 修复中）、SEC-16-16（MOXENC2+kdfId，旧格式兼容）、SEC-16-17（Crockford 容错映射接线）；遗留收口：reasonCode 独立拆分+两套四语字典同步、ChatView 滚动加载接 MESSAGE_LIST_PAGE（保留 §309 闸门并登记新写点）、SecurityEventKind 收编 credential_reveal/terminal_command、隐藏即杀终端会话。新增测试 12 个文件 80 例；全量 771 文件 8036 用例通过（1 例沙箱清理超时 flake，单跑 13/13 复绿），tsc 0 错误 | 已修复（2026-11-28 提交 `bf5a343` 并推送；SEC-16-15 代码侧完成，公钥待运维） |
| 2026-11-28 | 决策收口（C1/C2/C3/C4/SEC-16-08/RSA） | C1 确认生产经 HTTPS 反代；C2 改密强制保存新恢复码（待实施）；C3 确认 ≥10 位且字符形态不限，现有 schema 已符合；C4 代码侧已收口仅剩真机确认；SEC-16-08 保留 none 默认 + UI 标注未受保护/字段混淆（文案待实施）；旧 RSA 证长期并存不设截止 | 决策已收口；C2 / SEC-16-08 实现待排期 |

> 回写建议：本批次定稿后，把 P0 三项（SEC-16-01 / SEC-16-02 / PERF-01）与 P1 六项追加进 `docs/security-audit-ledger.md` 的「五、修复批次规划」表，并在「八、变更记录」新增一行。
