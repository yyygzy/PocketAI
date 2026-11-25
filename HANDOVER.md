# 墨匣（Moxia / PocketAI）交接说明

> 快照生成时间：2026-11-17（Asia/Shanghai）
> 源码版本：`package.json` 中 `version` 为 **1.3.0**；本地 `main` 分支 HEAD 为 `6dbeff0`
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

## 4. 1.3.0 这一轮做了什么

本地 `main` 上与本轮直接相关的三个提交（由旧到新）：

| 提交 | 摘要 | 关键内容 |
|---|---|---|
| `8ebea74` | `fix(data): 1.3.0 安装版数据迁出安装目录，覆盖升级不再清空` | 新增安装版数据落点 `appData/Moxia/data`；`portable.ts` 增加数据迁移与校验；`build/installer.nsh` 在覆盖升级前搬数据；新增迁移用例；发布说明草稿。 |
| `fe2669c` | `fix(boot): 修复冷启动白屏并让硬件探测等真数据` | 硬件采集改异步 PowerShell，启动路径不再被 CIM 查询钉住；硬件探测改为窗口 `show` 后延迟 1.5s 触发，能力页 8s 先答、后台 30s 补采，向导等真实数据、测不到就明说「没能测到」；磁盘探测拆快段（`Win32_LogicalDisk`）与慢段（`MSFT_PhysicalDisk`）并行；License 磁盘指纹改异步（`loadFromFileAsync`）、截图宿主懒加载；IPC 回执增加 `got/incomplete/probing`；四语文案与测试同步。 |
| `6dbeff0` | `build(linux): 补齐 AppImage 原生模块解包` | `electron-builder.linux.yml` 的 `asarUnpack` 补上 `sqlite-vec*/**/*.{dll,dylib,so}` 与 `node_modules/onnxruntime-node/**`，并排除 darwin/win32 的 sqlite prebuild，保留 Linux/linuxmusl。 |

冷启动白屏的根因（`fe2669c` 提交说明与代码注释）：旧实现用同步 `execSync`/`execFileSync` 跑 PowerShell，Windows 上冷启动加 CIM 查询可占用主线程 15–30s，期间窗口导航、加载重试与显示兜底计时器都被推迟。现在启动路径只发起异步探测，主线程不再等待。

> 状态提醒：`docs/release-notes-1.3.0.md` 仍把「冷启动白屏」列在「已知问题」里作为待查项；修复已提交（`fe2669c`），但发布说明尚未回写该条，接手后请以代码与实测为准。

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

### 5.3 WSL 硬件探测（已接宿主通道，仍需 WSL 实机复核）

- 旧问题：WSL2 的 `/proc`、`os.totalmem()` 与 `df` 看到的是虚拟机视图（内存受 `.wslconfig` 限制、磁盘是 `ext4.vhdx`），拿不到宿主机真值。
- 现已处理：`src/main/steward/hardware.ts` 通过 `/proc/version`、`os.release()`、`WSL_DISTRO_NAME` 识别 WSL，定位 `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`（可用 `POCKETAI_WSL_POWERSHELL` 覆盖），并行向宿主查 `Win32_Processor` / `Win32_ComputerSystem` / `Win32_OperatingSystem` / `Win32_VideoController` / `Win32_LogicalDisk` / `MSFT_PhysicalDisk`；`wslpath -w APP_ROOT` 决定查哪个盘符，不默认 C:。
- APP_ROOT 落在 WSL 扩展区（如 `/home`）时 `wslpath -w` 返回 UNC、无法映射盘符，可用 `POCKETAI_WSL_DISK=C` / `C:` / `E:\PocketAI` 显式指定宿主盘；该值同时用于磁盘画像与硬盘指纹，只放行单个盘符字母，不默认 C:。
- 硬盘指纹同步改走宿主 `Get-PhysicalDisk.SerialNumber`；拿不到就返回 null 不绑机，不用 VHD 虚拟序列号冒充。
- 宿主 PowerShell 一条都没查成时，退回原生 Linux 视图并保留「没测到」语义。
- **待确认**：仓库内没有 WSL 实机；`tests/hardware-wsl.test.ts` 钉住了识别/路径映射/盘符覆盖/回执解析纯函数，具体发行版与 GPU 直通场景仍需 WSL 实机复核。

### 5.4 安装包未签名导致 SmartScreen 提示

- Windows 无代码签名证书；macOS `identity` 为 `null`。行为与放行方式以 `docs/release-notes-1.3.0.md` 为准：
  - Windows：SmartScreen 提示「Windows 已保护你的电脑」→「更多信息」→「仍要运行」；安装过程可能再拦一次。
  - macOS：系统设置 → 隐私与安全性 → 「仍要打开」，或右键打开；必要时 `xattr -dr com.apple.quarantine`。
- 完整性可用 `latest.yml` / `latest-linux.yml` 里的 `sha512` 核对；本次快照另行给出了 SHA-256（见第 7 节）。

### 5.5 其他交接时会碰到的限制

- **便携版应用内下载更新已实现，但真机 E2E 未跑**：设置页可下载 Release 资产、校验 SHA-256 并退出替换原 exe；仍需更高版本 Release 提供带 `sha256:` digest 的资产才能验证完整链路（`src/main/update-manager.ts`）。
- **应用内检查更新读到的正式版仍是 v1.2.8**：在 1.3.0 的 Release 真正发布前，1.3.0 会显示「已是最新」，这是版本比较的正确结果（`docs/release-notes-1.3.0.md`）。
- **升级迁移耗时**：大库/大附件升级时迁移会明显变慢，等待期间不要强杀进程。

---

## 6. 提交与推送状态

> 当前复核（交付时）：本节下方的 `[ahead 1]` 与 `6dbeff0 未推送` 是交接快照生成时的历史状态，已过时。现已全部推送，`main` 与 `gitee/main`、`origin/main` 完全同步（均为 `af5561b`），工作区干净。仍未打 `v1.3.0` 标签、未发布 Release——这是待用户决定的发布动作，不是代码遗留。

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
- **未打 `v1.3.0` 标签**，最新标签仍是 `v1.2.8`；仓库也尚未有 1.3.0 的 Release。
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

### 7.4 敏感文件提醒（交接前请确认授权范围）

本次按「除排除目录外全量复制」执行，因此快照里包含以下 `.gitignore` 中标注为本地保管的内容：

- `build/license-private.pem`：License **私钥**（`.gitignore` 注释写明「仅发行侧本地保管，严禁入库」）。
- `licenses/`：已签发/测试激活码与 `issued-log.jsonl`、`batch.csv`，文件名含用户/公司标识。
- `build/test-license.lic`：测试许可证。
- `license-server/server.js`：激活服务器实现（不含 `licenses.json` 私钥副本，本次源目录也没有该文件）。

如果同事不需要参与发行/签发，建议在交付前从快照中删除上述文件，或单独走安全渠道传递。**本次未删除任何文件**，以免破坏「全量快照」的完整性。

---

## 8. 接手后的建议顺序

1. 在接近目标平台的环境安装 Node 22，执行 `npm install`，确认 `postinstall` 重建原生模块成功。
2. `npm run typecheck` 与 `npm test` 跑通，建立本地基线。
3. `npm run dev` 起开发环境，确认数据落在仓库根 `data/`（开发态）。
4. 需要出包时按第 2.4 节的三条命令执行；Linux AppImage 建议直接在 Linux/CI 上构建。
5. 修改数据目录相关代码前，先读 `src/main/portable.ts` 的注释与 `docs/release-notes-1.3.0.md` 的「升级说明」，避免破坏安装版迁移。
