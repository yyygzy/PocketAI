// SEC-16-05 / SEC-16-04 命令分类判定测试
//
// 覆盖 docs/perf-security-audit-2026-11.md 两节的验收用例：
// - SEC-16-05：dd/fsutil/vssadmin/wipefs/shred/blkdiscard 落 deny；rm -rf / 变体（裸 ~、
//   重定向后缀、remove-item 动词）落 deny；POSIX 白名单补齐后的外部路径确认；
//   合法命令（dd if=a of=b、npm run build）不受影响。
// - SEC-16-04：终端口径 classifyTerminalCommand（deny 档 + 外部路径硬拒，confirm 档放行）、
//   终端命令审计留痕（截断 + 拦截原因进 detail）。
//
// 策略与 shell-tools.test.ts 同款：纯函数直接 import；mock appConfigRepo 避开 db→electron 链；
// security-event.repo 用 mock 收集 append 调用（不碰真库）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {} }
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))

// 终端审计走 mock repo（append 只收集，不落库）
const appendSpy = vi.hoisted(() => vi.fn())
vi.mock('../src/main/db/repositories/security-event.repo', () => ({
  securityEventRepo: { append: appendSpy },
  // 类型仅为编译期引用，运行时 mock 无需真值
  SecurityEventKind: undefined
}))

vi.mock('../src/main/portable', () => ({ APP_ROOT: process.cwd() }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

import { classifyCommand, classifyTerminalCommand } from '../src/main/tools/shell-tools'
import { auditTerminalCommand } from '../src/main/terminal/terminal-service'

const WS = 'C:\\agent-workspace'

describe('classifyCommand（SEC-16-05 deny-list 补齐）', () => {
  describe('裸设备抹除 / 卷影删除：allow → deny', () => {
    it('dd 覆盖块设备（SD/盘、NVMe、eMMC、分区后缀）→ deny', () => {
      expect(classifyCommand('dd if=/dev/zero of=/dev/sda', WS).decision).toBe('deny')
      expect(classifyCommand('dd of=/dev/nvme0n1', WS).decision).toBe('deny')
      expect(classifyCommand('dd of=/dev/nvme0n1p1', WS).decision).toBe('deny')
      expect(classifyCommand('dd if=/dev/urandom of=/dev/mmcblk0p1', WS).decision).toBe('deny')
      expect(classifyCommand('dd of=/dev/hda', WS).decision).toBe('deny')
    })
    it('fsutil setZeroData → deny', () => {
      const v = classifyCommand('fsutil file setZeroData c:', WS)
      expect(v.decision).toBe('deny')
    })
    it('vssadmin delete shadows → deny', () => {
      const v = classifyCommand('vssadmin delete shadows /all /quiet', WS)
      expect(v.decision).toBe('deny')
    })
    it('wipefs / shred / blkdiscard → deny', () => {
      expect(classifyCommand('wipefs /dev/sda', WS).decision).toBe('deny')
      expect(classifyCommand('shred -n 1 secret.txt', WS).decision).toBe('deny')
      expect(classifyCommand('blkdiscard /dev/sdb', WS).decision).toBe('deny')
    })
  })

  describe('rm -rf / 变体：confirm → deny', () => {
    it('裸根与重定向后缀 → deny', () => {
      expect(classifyCommand('rm -rf /', WS)).toEqual({ decision: 'deny', reason: 'BLOCKED_ROOT_DELETE' })
      expect(classifyCommand('rm -rf / 2>/dev/null', WS).decision).toBe('deny')
      expect(classifyCommand('rm -rf / .', WS).decision).toBe('deny')
      expect(classifyCommand('rm -rf /*', WS).decision).toBe('deny')
    })
    it('裸 ~ 变体 → deny', () => {
      expect(classifyCommand('rm -rf ~', WS).decision).toBe('deny')
      expect(classifyCommand('rm -rf ~/', WS).decision).toBe('deny')
      expect(classifyCommand('rm -rf ~ ', WS).decision).toBe('deny')
    })
    it('remove-item 指向盘符根 → deny', () => {
      expect(classifyCommand('Remove-Item C:\\ -Recurse -Force', WS).decision).toBe('deny')
    })
    it('~/$HOME 的子路径仍走 confirm 档（不误杀合法清理）', () => {
      expect(classifyCommand('rm -rf ~/projects', WS).decision).toBe('confirm')
      expect(classifyCommand('rm -rf $HOME/tmp', WS).decision).toBe('confirm')
    })
  })

  describe('POSIX 系统目录白名单补齐 → confirm（外部路径）', () => {
    it('/dev /home /root /opt /boot /srv 命中', () => {
      expect(classifyCommand('ls /dev/sda1', WS).decision).toBe('confirm')
      expect(classifyCommand('ls /home/user', WS).decision).toBe('confirm')
      expect(classifyCommand('cat /root/.bashrc', WS).decision).toBe('confirm')
      expect(classifyCommand('ls /opt/app', WS).decision).toBe('confirm')
      expect(classifyCommand('ls /boot', WS).decision).toBe('confirm')
      expect(classifyCommand('ls /srv/data', WS).decision).toBe('confirm')
    })
    it('~ 展开后的外部路径命中', () => {
      expect(classifyCommand('ls ~/etc', WS).decision).toBe('confirm')
    })
    it('cat ~/.ssh/id_rsa → confirm（POSIX 外部路径）', () => {
      const v = classifyCommand('cat ~/.ssh/id_rsa', WS)
      expect(v.decision).toBe('confirm')
      expect(v.reason).toBe('DANGEROUS_OUTSIDE')
    })
    it('2>/dev/null 紧贴重定向符，白名单（前缀 >）不命中——confirm 来自既有重定向规则', () => {
      const v = classifyCommand('make 2>/dev/null', WS)
      expect(v.decision).toBe('confirm')
      // 白名单若命中会是 DANGEROUS_OUTSIDE（第 2 步先于危险特征表）；实际来自 `>+?` 重定向规则
      expect(v.reason).toBe('DANGEROUS_OVERWRITE')
    })
  })

  describe('合法命令不受影响（反例）', () => {
    it('dd 读写普通文件 → allow', () => {
      expect(classifyCommand('dd if=a of=b', WS).decision).toBe('allow')
      expect(classifyCommand('dd if=./in.img of=./out.img', WS).decision).toBe('allow')
    })
    it('dd 源为 /dev/zero、目标为普通文件 → confirm（白名单覆盖 /dev，安全方向；非 deny）', () => {
      const v = classifyCommand('dd if=/dev/zero of=./disk.img bs=1M count=10', WS)
      expect(v.decision).toBe('confirm')
      expect(v.reason).toBe('DANGEROUS_OUTSIDE')
    })
    it('日常构建命令 → allow', () => {
      expect(classifyCommand('npm run build', WS).decision).toBe('allow')
      expect(classifyCommand('git status', WS).decision).toBe('allow')
      expect(classifyCommand('ls -la', WS).decision).toBe('allow')
    })
    it('fsutil 非 setZeroData 子命令 / vssadmin 非 delete → 不落 deny', () => {
      expect(classifyCommand('vssadmin list shadows', WS).decision).not.toBe('deny')
    })
  })
})

describe('classifyTerminalCommand（SEC-16-04 终端口径）', () => {
  it('deny 档硬拒：dd / vssadmin / rm -rf /', () => {
    expect(classifyTerminalCommand('dd if=/dev/zero of=/dev/sda', WS)).not.toBeNull()
    expect(classifyTerminalCommand('vssadmin delete shadows /all', WS)).not.toBeNull()
    expect(classifyTerminalCommand('rm -rf /', WS)).toBe('BLOCKED_ROOT_DELETE')
  })
  it('工作目录外路径（REASON_OUTSIDE 类）硬拒', () => {
    expect(classifyTerminalCommand('cat ~/.ssh/id_rsa', WS)).toBe('DANGEROUS_OUTSIDE')
    expect(classifyTerminalCommand('ls /etc/passwd', WS)).toBe('DANGEROUS_OUTSIDE')
    expect(classifyTerminalCommand('type C:\\Windows\\win.ini', WS)).toBe('DANGEROUS_OUTSIDE')
  })
  it('confirm 档放行（用户即操作者）：删除/移动等危险特征不拦', () => {
    expect(classifyTerminalCommand('rm -rf ./build', WS)).toBeNull()
    expect(classifyTerminalCommand('npm run build', WS)).toBeNull()
    expect(classifyTerminalCommand('echo hello', WS)).toBeNull()
  })
})

describe('终端审计留痕（SEC-16-04）', () => {
  beforeEach(() => {
    appendSpy.mockClear()
  })

  it('已执行命令入库：message 带命令文本，blocked 为 null', () => {
    auditTerminalCommand(3, 'npm run build', null)
    expect(appendSpy).toHaveBeenCalledTimes(1)
    const arg = appendSpy.mock.calls[0]![0] as { kind: string; message: string; detail: Record<string, unknown> }
    expect(arg.kind).toBe('terminal_command')
    expect(arg.message).toContain('npm run build')
    expect(arg.detail).toMatchObject({ ownerId: 3, blocked: null })
  })

  it('deny 拦截命令入库：拦截原因进 message 与 detail', () => {
    auditTerminalCommand(5, 'rm -rf /', 'BLOCKED_ROOT_DELETE')
    const arg = appendSpy.mock.calls[0]![0] as { message: string; detail: Record<string, unknown> }
    expect(arg.message).toContain('BLOCKED_ROOT_DELETE')
    expect(arg.detail).toMatchObject({ ownerId: 5, blocked: 'BLOCKED_ROOT_DELETE' })
  })

  it('超长命令先截断再入库（500 字符上限，含截断提示）', () => {
    auditTerminalCommand(7, 'x'.repeat(2000), null)
    const arg = appendSpy.mock.calls[0]![0] as { message: string }
    expect(arg.message.length).toBeLessThan(600)
    expect(arg.message).toContain('已截断')
  })
})
