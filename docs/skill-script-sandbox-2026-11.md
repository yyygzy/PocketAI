# 技能脚本沙箱执行说明（阶段 5，2026-11）

## 结论先说

`run_skill_script` **不是通用命令执行器**，也不是 OS 层容器。它把可执行面收窄到：

1. 技能安装快照 `.skill-files.json` 里登记过的 `scripts/**/*.js|mjs|cjs`；
2. 既有 `js_eval` 浏览器沙箱（无 Node、无 preload、无文件系统、无网络、5s 超时、输出 2000 字截断）；
3. 默认关闭，开启后仍然是 `confirm + forceConfirm`，每次执行都要用户逐次批准。

`shell`/`python`/`.bat`/`.sh` 一律拒绝：当前应用没有可承诺的 OS 级沙箱，宁可明确不支持，也不做“看起来能跑”的假隔离。

## 开启方式

`app_config` 键：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `skill_script_enabled` | 关闭（缺省 / `'0'`） | `'1'` 才把工具从 `deny` 放成 `confirm`；读取失败也退回关闭 |

示例（主进程）：

```ts
appConfigRepo.setSkillScriptEnabled(true)
```

关闭时工具仍在注册表里，但 `classify()` 返回 `deny`，`execute()` 也会再次拒绝——不依赖 UI 是否藏住按钮。

## 工具契约

- id：`skill.run_script`
- name：`run_skill_script`
- 参数：`skill`（技能名或 id）、`script`（`scripts/report.js` 这样的相对路径）、`args`（JSON 对象，可选，≤8192 字符）
- 仅接受本次运行绑定、且 enabled 的技能
- 脚本必须在安装清单里、后缀必须是 `.js`/`.mjs`/`.cjs`、sha256 必须与安装时一致；新增/改过/符号链接/绝对路径/`..` 一律拒
- 参数以 JSON 字符串字面量注入，不拼进代码体；脚本按 AsyncFunction 函数体执行，可 `return`，可 `await`
- `console.log/info/warn/error/debug` 收集进返回值的 `logs`，最多 100 条、单条 1000 字

## 安全边界（逐项对应验收）

| 面 | 约束 | 落地位置 |
| --- | --- | --- |
| 网络 | 沙箱 session 的 `onBeforeRequest` 取消一切非 `data:`/`about:` 请求；`setPermissionRequestHandler` 全否 | `src/main/sandbox/js-eval-runner.ts` |
| 凭据 / 环境变量 | 沙箱内没有 `process`、没有 Node globals；不存在父进程 env 读取通道 | `sandbox:true` + `nodeIntegration:false` + 无 preload |
| 文件系统 / 写技能目录 | 沙箱页无 Node fs；工具层只读脚本正文，不提供任何文件参数 | `readSkillScript()` + 工具 schema |
| 未登记脚本 | 以 `.skill-files.json` 的键集为准，清单外一律拒 | `listSkillScripts()` / `readSkillScript()` |
| 脚本被改 | 读取时复验安装 sha256，改过即拒 | `readSkillScript()` |
| 越界 / 软链 | 词法归一化 + realpath 仍须落在本技能目录 + `O_NOFOLLOW` | `resolveSkillFilePath()` + `readSkillScript()` |
| 死循环 / 长输出 | 5s 超时销毁并重建窗口；结果 2000 字截断；支持 Agent `AbortSignal` | `runJsEval()` |
| 误授权 | 普通 confirm 也不落“本次会话总是允许”白名单 | `forceConfirm:true` |

## 三平台配置说明

三平台**不需要额外系统配置**：执行发生在 Electron 的隐藏 BrowserWindow 沙箱里，不启动 shell、不拉起 Python、不依赖 `sandbox-exec` / `bwrap` / AppLocker。

| 平台 | 需要配置 | 路径差异处理 | 冒烟点 |
| --- | --- | --- | --- |
| Windows | 无；不调用 `cmd.exe`/PowerShell | `scripts\report.js` 与 `scripts/report.js` 归一为同一清单路径 | 反斜杠路径可读；`.sh`/`.bat` 被拒 |
| macOS | 无；不调用 `/bin/sh` | 同 POSIX 斜杠 | `.js` 可读；`.py`/`.sh` 被拒 |
| Linux | 无；不依赖 seccomp/bwrap | 同 POSIX 斜杠 | `.js` 可读；`.py`/`.sh` 被拒 |

冒烟用例见 `tests/skill-script-tools-500.test.ts` 的“跨平台形状”一节；沙箱自身的网络守卫与无 Node 面由既有 `js-eval` 用例覆盖。

## 失败面

用户会看到可读错误，而不是空白或“再试一次”的循环：

- `技能脚本执行未开启`
- `脚本不在该技能的安装清单内，或不是允许的 JS 脚本`
- `脚本校验失败：内容与安装清单不一致`
- `脚本路径越出技能目录`
- `args 必须是 JSON 对象` / `args 过长`

任何失败都不会自动重试，也不会把权限从 `deny` 悄悄升到 `allow`。
