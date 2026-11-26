# 墨匣（Moxia / PocketAI）交接说明

> 快照生成时间：2026-11-17（Asia/Shanghai）；最近回写：2026-11-26
> 源码版本：`package.json` 中 `version` 为 **1.3.0**；当前 `main` 分支 HEAD 为 `d173434`（快照生成时为 `6dbeff0`）
> 快照根目录：`E:\PocketAI-handover-1.3.0\`

本文只描述仓库里已经存在的代码与文档事实。凡本次未实测、无法从代码/文档确认的内容，会明确写「待确认」，不当作结论使用。

---

## 1. 项目是什么

墨匣（英文名 Moxia，仓库名 PocketAI）是一款**本地优先、可随身携带的桌面 AI 工作台**（Electron 桌面应用）。核心形态：

- 多模型对话与 Agent 执行（工具调用、运行记录、续跑、预算控制等）。
- 知识库与本地向量检索（SQLite + sqlite-vec + 本地 embedding 模型）。
- 技能、MCP 扩展、能力中心。
- 备份/恢复、数据健康、维护任务、平台管家（硬件画像与模型建议）。
- 数据默认跟着应用本体走，支持便携形态；安装版自 1.3.0 起把数据放到系统 appData 下，避免覆盖安装清空。
- 支持主密码与数据库加密（SQLCipher，`better-sqlite3-multiple-ciphers`）。

产品定位与模块设计见根目录：

- `产品策划书.md`
- `模块详细设计.md`
- `docs/product-plan-2026-11.md`（近期产品计划）
- `docs/release-notes-1.3.0.md`（1.3.0 发布说明草稿）
- `docs/v4-iteration-ledger.md`（V4 迭代台账，体量较大）
- `docs/verify-checklist.md`（人工验收清单）
- `docs/security-audit-ledger.md`（安全审计台账）

源码分层：

- `src/main/`：Electron 主进程（数据库、IPC、Agent、知识库、MCP、License、平台管家等）。
- `src/preload/`：预加载脚本（主窗口 / 解锁窗 / 浮窗三个入口）。
- `src/renderer/`：React 渲染层（含 i18n 四语：zh / en / ja / ko）。
- `src/shared/`：主进程与渲染层共享的类型、常量与纯函数。
- `tests/`：Vitest 用例（主进程与渲染层都有）。
- `scripts/`：构建辅助、模型下载、许可签发工具等。
- `extensions/`：内置扩展数据（打包进 asar，只读）。
- `resources/models/`：内置本地 embedding 模型（约 23 MB）。

---

## 2. 技术与运行环境要求

### 2.1 基础环境

| 项目 | 要求 / 事实 | 依据 |
|---|---|---|
| Node.js | **22.x**（CI 使用 `node-version: 22`；本快照生成机为 v22.23.2） | `.github/workflows/ci.yml`、`release.yml` |
| npm | 使用仓库内 `package-lock.json`（lockfileVersion 3） | `package-lock.json` |
| Electron | `44.4.5` | `package.json` / lockfile |
| 构建工具 | `electron-vite 4.0.1`、`electron-builder 26.15.3`、`vite 7.3.6` | `package.json` / lockfile |
| 语言与框架 | TypeScript `5.9.3`、React `18.3.1`、Tailwind CSS 3 | `package.json` / lockfile |
| 测试 | Vitest `5.0.2`（另有 `scripts/test-full.mjs` 全量入口） | `package.json` |
| 打包平台 | Windows x64 安装包/便携版；Linux x64 AppImage（CI 在 `ubuntu-latest` 上构建） | `package.json`、`electron-builder.linux.yml`、`release.yml` |

> 本快照**不包含 `node_modules`**。接手后第一件事是 `npm install`（会触发 `postinstall` 重建原生模块）。

### 2.2 原生模块与模型

| 依赖 | 版本 | 说明 |
|---|---|---|
| `better-sqlite3-multiple-ciphers` | 13.0.3 | SQLCipher 版 SQLite 绑定，**必须按 Electron ABI 重建**。`package.json` 的 `postinstall` 是 `electron-builder install-app-deps`，`npm install` 后会自动处理；换 Electron 版本或出现 ABI 不匹配时，手动执行 `npx electron-builder install-app-deps`。 |
| `sqlite-vec` | 0.1.9 | 向量检索的 SQLite 可加载扩展。本体是纯 JS，真正的原生扩展来自可选平台包（如 `sqlite-vec-windows-x64`），运行时通过 `require.resolve` 找到 `vec0.dll` / `vec0.so` / `vec0.dylib` 后 `db.loadExtension()`。**不是重建，而是打包时不能留在 asar 内**。 |
| `onnxruntime-node` | 1.30.0 | 由 `@huggingface/transformers@4.3.0` 间接引入，提供本地 ONNX 推理。预编译原生二进制，同样**不能留在 asar 内**。 |
| 本地 embedding 模型 | `Xenova/bge-small-zh-v1.5` | 位于 `resources/models/Xenova/bge-small-zh-v1.5/`（`onnx/model_quantized.onnx` 约 24,010,842 字节）。该目录在 `.gitignore` 中被忽略，但本次快照按文件系统复制，**已包含**。缺失时由 `npm run fetch:model` 下载（优先 hf-mirror.com，失败回退 huggingface.co）。 |

三条原生相关配置在 `package.json` 的 `build.asarUnpack` 和 `electron-builder.linux.yml` 的 `asarUnpack` 中，必须保持一致，否则打包版会在运行时报「找不到原生模块 / 扩展」。

### 2.3 首次安装与开发

```bash
npm install          # 安装依赖，并自动重建 better-sqlite3-multiple-ciphers
npm run dev          # electron-vite dev，启动开发环境
```

常用校验：

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:full    # 走 scripts/test-full.mjs 的全量测试入口
npm run build        # electron-vite build，产物在 out/
```

### 2.4 三条构建命令

三条命令都会先执行 `node scripts/fetch-embedding-model.mjs`（模型已存在且校验通过则跳过），再由 electron-builder 输出到 `dist/`：

| 目标 | 命令 | 产物命名 |
|---|---|---|
| Windows 安装包（NSIS） | `npm run dist:nsis` | `Moxia-1.3.0-x64.exe` |
| Windows 便携版 | `npm run dist:portable` | `Moxia-1.3.0-Portable-x64.exe` |
| Linux AppImage（x64） | `npm run dist:linux` | `Moxia-1.3.0-Linux-x86_64.AppImage` |

补充：

- `npm run dist` 会按 `package.json` 的 `build.win.target` 一次性产出 **NSIS + portable** 两个 Windows 包（`electron-builder --win`）。
- Linux 使用独立配置 `electron-builder.linux.yml`（`electron-builder --linux --config electron-builder.linux.yml`）。AppImage 的构建在 Linux 环境（CI 为 Ubuntu）上完成；在 Windows 上直接构建 Linux AppImage 的行为本次未验证，**待确认**。
- 版本号取自 `package.json` 的 `version`；改名/升版本时同步改这里。
- 发行更新清单：Windows 为 `dist/latest.yml`，Linux 为 `dist/latest-linux.yml`，均由 electron-builder 生成。

---

## 3. 数据目录落点规则

核心实现在 `src/main/portable.ts`，启动流程在 `src/main/index.ts` 的 `boot()`。

### 3.1 `APP_ROOT` 的解析优先级

1. 环境变量 `POCKETAI_APP_ROOT`（测试/隔离用，最高优先级）。
2. 打包版 + `APPIMAGE`（Linux AppImage 运行时注入，指向 `.AppImage` 文件自身）：取该文件所在目录。
3. 打包版 + `PORTABLE_EXECUTABLE_DIR`（Windows portable 单文件运行时注入）：取原 portable exe 所在目录。
4. 打包版：`path.dirname(app.getPath('exe'))`（NSIS 安装版的真实安装目录）。
5. 开发态：`process.cwd()`。

### 3.2 数据目录 `DATA_DIR`

| 运行形态 | 数据落点 | 说明 |
|---|---|---|
| 设置了 `POCKETAI_APP_ROOT` | `APP_ROOT/data` | 保持旧语义，**不做**安装版迁移；主要用于测试隔离/指定根目录。 |
| 开发态（未打包） | 仓库根 `data/` | 即 `APP_ROOT/data`。 |
| Windows 便携版 | portable exe 同目录 `data\` | 跟应用本体走；换文件夹等于换一份数据。 |
| Linux AppImage | `.AppImage` 文件同目录 `data/` | 挂载点只读，数据必须落在 AppImage 旁边。 |
| 安装版（NSIS / macOS dmg / Linux deb 等） | `app.getPath('appData')/Moxia/data` | Windows 为 `%APPDATA%\Moxia\data`；macOS 为 `~/Library/Application Support/Moxia/data`；Linux 为 `~/.config/Moxia/data`。 |

`DATA_DIR` 下主要落点：

- `app.db`：主数据库（SQLCipher 加密；向量表也在主库内，没有独立 `vectors.db`）。
- `config.json`：配置。
- `attachments/`：附件。
- `logs/`：日志（`LOGS_DIR`）。
- `extensions/mcp/`：用户可写的 MCP 扩展（`USER_EXTENSIONS_DIR`）。
- `userdata/`、`session/`：Chromium 的 `userData` / `sessionData`（`app.setPath` 到 `DATA_DIR` 下，避免写系统目录）。
- `license.lic`：存在时默认从这里加载。

另有 `RUNTIME_DIR = APP_ROOT/runtime`（便携 Python 等第三方运行时），它跟 `APP_ROOT` 走，不在 `DATA_DIR` 下。

### 3.3 从 1.2.8 及更早版本升级时的数据迁移

1.2.8 及更早的安装版把数据放在安装目录的 `data\`。覆盖安装时 electron-builder 的旧卸载器会重建整个安装目录，所以 1.3.0 采用两层保护：

1. **安装器层**：`build/installer.nsh` 的 `customInit` 在旧卸载器执行前，把 `$INSTDIR\data` 搬到 `$APPDATA\Moxia\data`；`Rename` 跨卷失败时用 `xcopy /e /i /h /y` 兜底；成功后写 `migrated-from.json`（`by: nsis-updater`）。
2. **首次启动层**：`migrateInstalledDataDir()` 在 `ensureDirs()` 之前运行。新位置没有数据、旧位置有 `app.db` 或 `config.json` 时，逐顶层项复制到新位置；逐文件比对相对路径与字节数，并对 `app.db` / `config.json` 做 SHA-256 校验；写 `migrated-from.json` 后再删除旧副本。中途失败只回滚本次创建的路径并弹窗退出，原数据保留在旧目录；复制中的 `.migrating` 哨兵用于下次启动清理半成品。

补充事实：

- `userdata/`、`session/` 是 Electron 档案树（本模块加载时就已 `app.setPath` 并可能正在写入），迁移一律跳过，不复制旧缓存也不覆盖目标缓存；`.lock` / `.migrating` / `migrated-from.json` 作为进程状态与幂等标记同样跳过。共享数据根 `migrateInstalledDataToSharedDir()` 复用同一套规则。
- 失败清理不再递归删整个目标 `DATA_DIR`，只删本次迁移写下的哨兵与文件/目录；目标里预存在的缓存或用户文件原样保留。
- 卸载程序只删程序文件，不删 `%APPDATA%\Moxia\data`（`build/installer.nsh` 的 `customUnInstall` 会提示该路径）。
- 迁移是一次性复制，大库/大附件会让升级或首次启动明显变慢。
- 便携版与 AppImage 不参与上述安装版迁移（数据本来就在应用旁边）；显式共享根仍会触发本机数据 → 共享根的迁移。

---

## 4. 1.3.0 原始发布轮与后续升级轮

### 4.1 1.3.0 原始发布轮（历史快照）

本地 `main` 上与该轮直接相关的三个提交（由旧到新）：

| 提交 | 摘要 | 关键内容 |
|---|---|---|
| `8ebea74` | `fix(data): 1.3.0 安装版数据迁出安装目录，覆盖升级不再清空` | 新增安装版数据落点 `appData/Moxia/data`；`portable.ts` 增加数据迁移与校验；`build/installer.nsh` 在覆盖升级前搬数据；新增迁移用例；发布说明草稿。 |
| `fe2669c` | `fix(boot): 修复冷启动白屏并让硬件探测等真数据` | 硬件采集改异步 PowerShell，启动路径不再被 CIM 查询钉住；硬件探测改为窗口 `show` 后延迟 1.5s 触发，能力页 8s 先答、后台 30s 补采，向导等真实数据、测不到就明说「没能测到」；磁盘探测拆快段（`Win32_LogicalDisk`）与慢段（`MSFT_PhysicalDisk`）并行；License 磁盘指纹改异步（`loadFromFileAsync`）、截图宿主懒加载；IPC 回执增加 `got/incomplete/probing`；四语文案与测试同步。 |
| `6dbeff0` | `build(linux): 补齐 AppImage 原生模块解包` | `electron-builder.linux.yml` 的 `asarUnpack` 补上 `sqlite-vec*/**/*.{dll,dylib,so}` 与 `node_modules/onnxruntime-node/**`，并排除 darwin/win32 的 sqlite prebuild，保留 Linux/linuxmusl。 |

### 4.2 后续升级轮（2026-11-26 回写）

| 提交 | 摘要 | 关键内容 |
|---|---|---|
| `8b62b25` | `feat(kb): 完成知识库升级五阶段与后台检测闭环` | 短中文 FTS 辅助路、CSV/XLSX 结构化检索、micro `sourceCoverageAtK` / `missingSources`、源文件变更检测与数据健康面板闭环；详见 `docs/kb-upgrade-plan-2026-11.md`。 |
| `67e675c` | `feat(skill): 完成技能版本治理与回滚` | v80 版本/来源/哈希字段、`skill_versions` 历史与回滚、内置技能锁定、四语文案与 UI。 |
| `df6f60c` | `feat(skill): 标准化 SKILL.md 与元数据兼容` | 标准 `SKILL.md`、`metadata.*` 补位、超长正文软提示、真库落库验收。 |
| `900d8f5` | `feat(skill): 完成技能路由、质量检查与资源按需读取` | 默认关闭的运行时路由 + activation eval、描述质量面板、`references/assets` 白名单只读与预览。 |
| `d173434` | `feat(skill): 增加浏览器沙箱技能脚本执行` | `run_skill_script` 默认 deny、逐次确认、仅清单内 JS、浏览器沙箱执行；详见 `docs/skill-upgrade-plan-2026-11.md` 与 `docs/skill-script-sandbox-2026-11.md`。 |

冷启动白屏的根因（`fe2669c` 提交说明与代码注释）：旧实现用同步 `execSync`/`execFileSync` 跑 PowerShell，Windows 上冷启动加 CIM 查询可占用主线程 15–30s，期间窗口导航、加载重试与显示兜底计时器都被推迟。现在启动路径只发起异步探测，主线程不再等待。

> 状态回写（2026-11-26）：`docs/release-notes-1.3.0.md` 已同步「冷启动白屏」为已修复，并保留目标机专项冷启动复测建议。

---

## 5. 当前已知问题

### 5.1 打包版托盘图标（已修复，旧记录作废）

- 旧现象：日志出现 `icon not found, skip tray init: ...app.asar\build\icon\icon-256.png`，托盘不初始化（1.2.8 同样存在）。
- 已修复：提交 `1f3027a`（`fix(win): 修正任务栏图标与主密码提示文案`）在 `package.json` 的 `asarUnpack` 加入 `build/icon/**/*`，`src/main/windows/boot-guards.ts` 的 `appIconPath()` 把 `app.asar` 换成 `app.asar.unpacked` 后取图标。打包产物 `resources/app.asar` 内确有 `build/icon/icon-256.png`。
- 实测：2026-11-24 重新打包并运行后，`artifacts/data/logs/main.log` 的启动段已不再出现 `skip tray init`。
- 因此「当前已知问题」不再列此项；旧的 `docs/release-notes-1.3.0.md` 已知问题行同步纠偏。

### 5.2 Linux 截图与选区取词缺口

- **截图**：`src/shared/screenshot.ts` 的 `isScreenshotPlatformSupported()` 只返回 `platform === 'win32'`；`src/main/popup.ts` 在非 Windows 上按 `unsupported-platform` 处理。Linux 目前没有截图进对话入口。
- **选区取词**：`src/main/popup.ts` 的 Linux 分支明确注释「无零依赖的统一取词方案（xdotool/xclip 不一定存在），v1 不支持」；Linux 上按选区快捷键只会打开快捷问答窗。设置页通过 `isLinuxPlatform()` 显示不支持提示（`src/renderer/src/utils/shortcuts.ts`、`SettingsModule.tsx`）。
- 结论：这是**产品边界/未实现**，不是偶发 bug；接 Linux 功能前需要先定方案与依赖。

### 5.3 WSL 硬件探测（已接宿主通道，MoxiaBuild 真机已复核）

- 旧问题：WSL2 的 `/proc`、`os.totalmem()` 与 `df` 看到的是虚拟机视图（内存受 `.wslconfig` 限制、磁盘是 `ext4.vhdx`），拿不到宿主机真值。
- 现已处理：`src/main/steward/hardware.ts` 通过 `/proc/version`、`os.release()`、`WSL_DISTRO_NAME` 识别 WSL，定位 `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`（可用 `POCKETAI_WSL_POWERSHELL` 覆盖），并行向宿主查 `Win32_Processor` / `Win32_ComputerSystem` / `Win32_OperatingSystem` / `Win32_VideoController` / `Win32_LogicalDisk` / `MSFT_PhysicalDisk`；`wslpath -w APP_ROOT` 决定查哪个盘符，不默认 C:。
- APP_ROOT 落在 WSL 扩展区（如 `/home`）时 `wslpath -w` 返回 UNC、无法映射盘符，可用 `POCKETAI_WSL_DISK=C` / `C:` / `E:\PocketAI` 显式指定宿主盘；该值同时用于磁盘画像与硬盘指纹，只放行单个盘符字母，不默认 C:。
- 硬盘指纹同步改走宿主 `Get-PhysicalDisk.SerialNumber`；拿不到就返回 null 不绑机，不用 VHD 虚拟序列号冒充。
- 宿主 PowerShell 一条都没查成时，退回原生 Linux 视图并保留「没测到」语义。
- **真机复核（2026-11-25，WSL2 发行版 `MoxiaBuild`，内核 `6.18.33.2-microsoft-standard-WSL2`）**：
  - `/mnt/e/PocketAI-handover-1.3.0` → `E:\PocketAI-handover-1.3.0`；`/home` → `\\wsl.localhost\MoxiaBuild\home`（UNC），确认 `/home` 场景确实需要 `POCKETAI_WSL_DISK`。
  - 宿主 PowerShell 在 WSL 内可直接调用，读到 CPU `Intel(R) Core(TM) i7-7700HQ` / 8 逻辑核，内存 `17,093,177,344` B；E: 为 NTFS、总容量 `128,034,271,232` B、空闲 `102,528,385,024` B、DriveType 3；GPU 为 Intel HD 630 + NVIDIA GTX 1050 Ti；物理盘序列号读到 `YS2020…73HP`（非 VHD 虚拟序列号）。
  - `tests/hardware-wsl.test.ts` 在 WSL 内 `10/10` 通过；另用一次性用例在真机确认 `isWsl()`、`wslWindowsDrive()` 自动映射 `E:`、以及 `POCKETAI_WSL_DISK=E:` 覆盖 UNC 场景均通过（临时用例已删除）。
- **仍未覆盖**：其他发行版与不同 GPU 直通组合仍有差异，需在目标机按需复核。

### 5.4 安装包未签名导致 SmartScreen 提示

- Windows 无代码签名证书；macOS `identity` 为 `null`。行为与放行方式以 `docs/release-notes-1.3.0.md` 为准：
  - Windows：SmartScreen 提示「Windows 已保护你的电脑」→「更多信息」→「仍要运行」；安装过程可能再拦一次。
  - macOS：系统设置 → 隐私与安全性 → 「仍要打开」，或右键打开；必要时 `xattr -dr com.apple.quarantine`。
- 完整性可用 `latest.yml` / `latest-linux.yml` 里的 `sha512` 核对；本次快照另行给出了 SHA-256（见第 7 节）。

### 5.5 其他交接时会碰到的限制

- **便携版应用内下载更新已实现，但真机 E2E 未跑**：设置页可下载 Release 资产、校验 SHA-256 并退出替换原 exe；仍需更高版本 Release 提供带 `sha256:` digest 的资产才能验证完整链路（`src/main/update-manager.ts`）。
- **应用内检查更新读到的正式版仍是 v1.2.8**：在 1.3.0 的 Release 真正发布前，1.3.0 会显示「已是最新」，这是版本比较的正确结果（`docs/release-notes-1.3.0.md`）。
- **升级迁移耗时**：大库/大附件升级时迁移会明显变慢，等待期间不要强杀进程。

### 5.6 NSIS 安装版隔离冒烟（2026-11-25）

- 用 `Moxia-1.3.0-x64.exe /S /D=...\artifacts\nsis-smoke-install` 静默安装到隔离目录，退出码 0；目录内有 `Moxia.exe`（ProductVersion `1.3.0.0`）、`Uninstall Moxia.exe`、`resources/app.asar`、`app-update.yml`，托盘图标解包到 `resources/app.asar.unpacked/build/icon/icon-256.png`。
- 用 `POCKETAI_APP_ROOT=...\artifacts\nsis-smoke-root` 启动安装版（Electron 不认 `APPDATA` 覆盖，故用应用根隔离数据；该路径不触发共享根迁移），主窗口标题 `墨匣 Moxia - PocketAI`，`data/app.db` 正常创建，`data/logs/main.log` 记录 DB 打开、窗口创建、助手/技能同步与调度器启动，无 ERROR。
- 静默卸载 `Uninstall Moxia.exe /S` 后 `Moxia.exe` 已删除，隔离 `data/app.db` 仍保留；测试进程、临时目录与首次尝试遗留的真实数据锁均已清理。
- 注意：上面的隔离冒烟用的是共享根迁移修复之前的旧包；用 `POCKETAI_DATA_DIR` 指向全新目录仍会命中旧版 EPERM。
- **新包复测（2026-11-25 18:23）**：重新打包后的 `Moxia-1.3.0-x64.exe` 已纳入共享根迁移修复。静默安装到 `nsis-smoke-install2`，用 `POCKETAI_DATA_DIR=...\nsis-smoke-data2` 启动：主窗口标题正常，`migrated-from.json` 写入（`kind: installed-to-shared`，4 个文件 / 1,929,851 字节 / 41ms），`app.db` 到位，`logs/main.log` 启动链无 ERROR，旧版 EPERM 不再出现。测试进程、隔离目录与测试安装均已清理。
- **asar integrity 真实验证（2026-11-25 19:35）**：构建日志记录 `updating asar integrity executable resource`；安装后的 `Moxia.exe` 含 asar 完整性资源，asar header 内 19,028 个文件全部带 SHA-256。单字节篡改 `out/main/index.js` 后启动只出现 `Error` 窗口、主窗口与 `main.log` 均不生成；恢复该字节（SHA-256 `F716A8E7…202A2132`）后正常启动并显示 `墨匣 Moxia - PocketAI`。
- **加密库解锁真实验证（2026-11-25 19:46）**：用 CDP 驱动安装版页面完成整链：`getEncryptionStatus` 初始 `mode:none/unlocked`；`enableEncryption('VerifyPass2026')` 后 `mode:db/dbEncrypted:true/unlocked:true/kdfN:131072/kdfAtCurrentTier:true`；`lockEncryption()` 后弹出 `unlock.html?mode=unlock`；错误密码返回 `密码错误` 且留解锁窗；正确密码错误密码窗口关闭、主窗口恢复，`unlocked:true`；杀进程后用同一隔离数据目录重启，启动期直接弹解锁窗，正确密码后日志出现 `DB 解锁成功` 与主窗口完整启动链。所有测试进程与隔离数据已清理。
- **自动锁 / 睡眠锁验收（2026-11-25 20:12）**：安装版页面 `setAutoLockTimeout(5000)` 返回 ok，内存状态从 `autoLockTimeout:0` 变为 `5000`，`app_config.auto_lock_timeout='5000'` 已落库；静置 13s 后状态自动变 `locked`，`unlock()` 恢复为 `unlocked`。重启后 `getLockStatus()` 仍为 `autoLockTimeout:5000` 且因超过阈值再次锁定，确认档位重启保持。锁屏态调用 `captureScreenshot('window')` 被主进程拒绝（`Error invoking remote method 'screenshot:capture': Error: APP_LOCKED`）。`tests/lock.test.ts` + `tests/auto-lock-persist-228.test.ts` 共 29/29 通过。
- **混合 DPI 验收（2026-11-25 20:20）**：当前单显示器 `\\.\DISPLAY1` 逻辑分辨率 1536×864、`AppliedDPI=240`（250% 缩放）；安装版渲染层 `devicePixelRatio=2.5`，窗口 CSS 1200×800 / inner 1188×765，主窗口屏幕捕获 1200×800，布局未溢出；整屏截图返回 3840×2160 物理像素（与 1536×864 逻辑分辨率恰为 2.5×）。真机暂无第二块不同缩放显示器，跨屏拖动切换 DPI 仍需目标机复核。
- **DRM / 截图限制验收（2026-11-25 20:25）**：锁屏态截图被 `APP_LOCKED` 闸门拒绝；解锁态 `captureScreenshot('window')` 对桌面返回可读失败码 `no-window/detail:desktop`，`captureScreenshot('screen')` 成功返回 3840×2160 PNG；黑帧识别回归 `tests/screenshot-p1-4-black-frame.test.ts` 6/6 通过（纯黑→`black`、正常画面不误伤、采样点只要一个非黑像素即放行）。真机 DRM/受保护视频窗口未在当前环境构造，代码路径以黑帧/透明帧拒绝兜底。
- **环境受限复核（2026-11-25 20:35）**：`powercfg /a` 显示本机仅支持 S3 睡眠；为避免挂起会话未触发真实睡眠，改用广播 `WM_POWERBROADCAST / PBT_APMSUSPEND (0x0004)`，安装版 `getLockStatus()` 从 `unlocked` 变为 `locked`；随后广播 `PBT_APMRESUMESUSPEND (0x0007)` 仍保持 `locked`，与 `onOsWake()` 的“唤醒后保持锁定”语义一致。`WM_WTSSESSION_CHANGE / WTS_SESSION_LOCK (0x0007)` 的 HWND_BROADCAST 模拟未触发应用锁定（系统锁定通知只发给已注册窗口），真实 `Win+L` 未执行以免锁住交互会话。显示器计数实测为 1（`\\.\DISPLAY1`，1536×864），无法构造跨屏不同缩放；未发现 DRM/受保护视频窗口（仅普通 Edge 页面），真实 DRM 捕获仍需目标机。

---

## 6. 提交与推送状态

> 当前复核（2026-11-26）：`main` HEAD 为 `d173434`，知识库与技能升级全部提交均已推送到 `origin/main` 与 `gitee/main`，工作区干净。下方命令输出与 `[ahead 1]` 均为 2026-11-17 历史快照，不再代表当前状态。tag / Release 状态仍待发布时复核，不作为代码遗留。

快照生成时的实际状态（`c:\PocketAI`）：

```text
$ git status -sb
## main...origin/main [ahead 1]

$ git log origin/main..HEAD --oneline
6dbeff0 build(linux): 补齐 AppImage 原生模块解包

$ git tag --list | Select-Object -Last 5
v1.2.4
v1.2.5
v1.2.6
v1.2.7
v1.2.8
```

- 分支 `main` 比 `origin/main` **领先 1 个提交**：`6dbeff0`。该提交只改 `electron-builder.linux.yml`。
- 工作区干净（`git status --porcelain` 无输出）。
- **历史快照状态**：当时未打 `v1.3.0` 标签，最新标签为 `v1.2.8`，也尚未有 1.3.0 的 Release；当前 tag/Release 状态请另行复核。
- `package.json` 的版本已经是 `1.3.0`，属于已提交状态。
- remote：`origin https://github.com/yyygzy/PocketAI.git`（fetch/push 同址）。
- 接手后可用以下命令自行复核：

```bash
git status -sb
git log origin/main..HEAD --oneline
git tag --list
```

> 注意：快照里 `.git` 是完整复制的，包含上述提交历史与未推送提交；但**远程仓库并没有 `6dbeff0`**。若同事需要从远程拉取，需先由持有推送权限的人推送，或直接把本快照作为源。

---

## 7. 快照内容与核对结果

### 7.1 已复制

- 源目录：`c:\PocketAI`
- 目标目录：`E:\PocketAI-handover-1.3.0\`
- 包含：全部根文件（`package.json`、`package-lock.json`、`tsconfig.json`、`electron.vite.config.ts`、`vitest.config.ts`、`tailwind.config.js`、`postcss.config.js`、`electron-builder.linux.yml`、两份产品文档等）、`.git`（完整历史）、`.github`、`.trae`、`build`、`docs`、`extensions`、`license-server`、`licenses`、`resources`（含模型）、`scripts`、`src`、`tests`。

### 7.2 已排除

`node_modules`、`dist`、`data`、`runtime`、`logs`、`out`、`.screenshots`。

核对结果（仓库部分，不含后加的 `artifacts/` 与 `HANDOVER.md`）：

- 源：**3904 个文件 / 132,973,100 字节**
- 目标：**3904 个文件 / 132,973,100 字节**
- 逐相对路径比对：缺失 **0**、多余 **0**、大小不一致 **0**
- 目标目录内确认**没有**混入上述 7 个被排除目录。

### 7.3 `artifacts/`（1.3.0 安装包）

| 文件 | 字节数 | SHA-256（与源文件一致） |
|---|---:|---|
| `Moxia-1.3.0-x64.exe` | 301,038,573 | `32A5F24E8E0B30B39C388311A79A3C8CE23BE8E2F0E6FFF69F0B9368D86E8C85` |
| `Moxia-1.3.0-Portable-x64.exe` | 300,804,308 | `300C06A166E0607D25316B99B54E043ED018718F95A43041E237310340C619EE` |
| `Moxia-1.3.0-Linux-x86_64.AppImage` | 327,449,882 | `5C6DD5D3A3E52F1FF14848E46B1DD988A8BFCD1CC2985E0358B98ED12FC71930` |
| `latest.yml` | 335 | `B10176CEC54B9B42BE4D6434E8CD382FECBFB9DEF92B6E6FF4746F6E2D019B23` |
| `latest-linux.yml` | 388 | `B2082529339502D2F733916A7483F026C37DED07055FB99A160D85FF41D83C8F` |

合计 **5 个文件 / 929,293,486 字节**。`dist/` 内其他旧版本文件（如 `Moxia-1.1.8-x64 (2).exe`、1.2.x 的包与 blockmap、`win-unpacked/`、`builder-debug.yml`）**未带入**。

自查命令（Windows PowerShell）：

```powershell
Get-FileHash .\artifacts\Moxia-1.3.0-x64.exe -Algorithm SHA256
```

### 7.4 敏感文件交付范围（已核定）

**对外交付包含**：
- Git `HEAD` 中的源码、脚本、测试、文档与配置；`build/license-public.pem`（公钥）和 `license-server/server.js`（服务器实现，不含密钥/台账）可随源码交付。
- 正式安装包 `artifacts/Moxia-1.3.0-x64.exe`、`artifacts/Moxia-1.3.0-Portable-x64.exe` 与 `artifacts/latest.yml`。

**不对外交付，仅发行侧本地保管**：
- `build/license-private.pem`：License 私钥（1704 B；未进入 Git 历史，`.gitignore` 明确排除）。
- `licenses/`：`batch.csv`、`issued-log.jsonl` 与已签发 `.lic`，文件名含用户/公司标识（未进入 Git 历史）。
- `build/test-license.lic`：测试许可证（616 B；工作树中被忽略，但历史提交 `afe3483` 曾加入、`2065c99` 删除）。
- `license-server/licenses.json`、`license-server/licenses.json.tmp`、`license-server/*.pem`：台账与私钥副本（忽略规则已覆盖，当前快照中不存在）。

**发布包核验**：最终 NSIS 安装后扫描应用目录与 `app.asar`（21,028 个文件），应用代码块无 `license-private` / `test-license` / `issued-log` / `batch.csv` / `license-server` / `.pem` / `.lic` 命中；只看到 Electron/Chromium 与第三方依赖的通用许可证文件。构建配置的 `files` 只收 `out/**`、`package.json`、`build/icon/**`、`extensions/**`、`node_modules/**`，`extraResources` 只收 `resources/models`。

**注意**：本交接快照含完整 `.git` 历史，历史里曾有 `build/test-license.lic`。对外交付若包含 `.git`，应先做历史清理，或改用 `git archive HEAD` + 单独复制正式安装包，避免带出历史中的测试许可证。

### 7.5 商业化能力进度（2026-11-25）

- 服务端已新增管理员解绑通道 `POST /v1/admin/unbind`：请求头 `x-admin-token` 必须与 `LICENSE_ADMIN_TOKEN` 匹配（SHA-256 + `timingSafeEqual` 定长比较）；未配置 token 时返回 503，避免默认暴露。CLI `unbind` 与 HTTP 共用纯函数 `unbindCode`，解绑会清 `fingerprint` / `bound_at` / `license_id` / `license_json`，状态回 `unused`，并保留 owner/plan/days/updates_days/created_at。
- 错误码：`ADMIN_DISABLED` / `UNAUTHORIZED` / `RATE_LIMITED` / `BAD_REQUEST` / `CODE_FORMAT_INVALID` / `CODE_NOT_FOUND`；未绑定卡密幂等返回 `changed:false` 且不写盘。服务端启动日志会显示该通道是否启用。该通道只在 `license-server/`，不进客户端安装包，不改变已发布包行为。
- 解绑只让卡密重新可用于新机器；已签发旧 license 仍可在原指纹机器上离线使用至 `expires_at`，离线授权无法远程吊销。
- 测试：`tests/license-server-unbind.test.ts` 10/10；连同 `tests/license.test.ts` 共 55/55 通过，`npm run typecheck` 通过。席位、宽限期与 v1→v2 默认切换仍未做，客户端仍无自助解绑入口。

### 7.6 安全台账收口（2026-11-25）

- 修正四语 `agent.oauthHint`：原先无条件声称「凭据加密保存在本机」，但 none 模式下 `mcp-oauth.repo.assertPersistAllowed`（`src/main/db/repositories/mcp-oauth.repo.ts:121-129`）会拒存新 OAuth token/secret。现明确「设置主密码后加密保存；未设主密码时不会保存 OAuth Token」，并保留 Token 不进 UI/日志的承诺。
- 新增 `tests/i18n-oauth-hint-none-mode.test.ts`，钉住四语文案不再无条件承诺加密；已登记到 `docs/security-audit-ledger.md` 的 P1 收口行。
- KDF 升档标记复核：`config.json.kdfParams` + `app_config.master_kdf` 双通道、白名单校验、逐档回退与成功固化保持现状，不改协议；`tests/master-password-kdf.test.ts` + `tests/kdf-config-channel.test.ts` 加上文案测试共 20/20 通过。

---

## 8. 接手后的建议顺序

1. 在接近目标平台的环境安装 Node 22，执行 `npm install`，确认 `postinstall` 重建原生模块成功。
2. `npm run typecheck` 与 `npm test` 跑通，建立本地基线。
3. `npm run dev` 起开发环境，确认数据落在仓库根 `data/`（开发态）。
4. 需要出包时按第 2.4 节的三条命令执行；Linux AppImage 建议直接在 Linux/CI 上构建。
5. 修改数据目录相关代码前，先读 `src/main/portable.ts` 的注释与 `docs/release-notes-1.3.0.md` 的「升级说明」，避免破坏安装版迁移。
