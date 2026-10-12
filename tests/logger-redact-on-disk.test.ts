// 真文件往返：**落盘的字节里到底有没有明文凭据**（B13 / SEC-14）
//
// 为什么单开一份：`log-redact.test.ts` 测的是纯函数（它特意独立成模块就是为了绕开
// logger.ts 的 electron 依赖）。于是「logger 真的调了它」「落盘那一行确实被处理过」
// 这两件事在 CI 里没人证过——正如 B32/B33 当初的情况。这里不桩 fs：真开一份临时日志目录，
// 用真 logger 写，再把**磁盘文件当字符串**扫。
//
// 第三条是反向对照：同一份文件里塞一条**不经脱敏**的明文行，扫描就必须搜得到。
// 没有这条，"搜不到"可能只是因为压根没写进文件（WAL 那次就是这么骗过我的，见 B33 附注）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => { throw new Error('测试环境不提供 userData') } }
}))

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  return { dir: base + sep + 'pocketai-log-redact-disk' }
})

import { createLogger, configureLogDir, readLogTail } from '../src/main/logger'
import { MAX_LOG_STRING_CHARS } from '../src/main/security/log-redact'

const FILE = path.join(P.dir, 'main.log')
/** 只在本用例里出现的假密钥，形状与真 Key 一致 */
const SECRET = 'sk-diskprobe-9b2f6c1d4e7a8053'
const CONTROL = 'sk-control-7f3a1c55d9e0b2a4'

function diskBytes(): string {
  return fs.readFileSync(FILE, 'utf8')
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  configureLogDir(P.dir)
})

afterAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('日志落盘脱敏（真文件）', () => {
  it('结构化参数里的凭据不出现在磁盘字节里，且留下 [redacted]', () => {
    createLogger('probe').info('保存 provider 配置', {
      name: '智谱',
      apiKeys: [SECRET],
      nested: { Authorization: `Bearer ${SECRET}`, note: '这行不是凭据' }
    })
    const disk = diskBytes()
    expect(disk).not.toContain(SECRET)
    expect(disk).toContain('[redacted]')
    // 非敏感字段照常可读——脱敏不该把日志变成砖
    expect(disk).toContain('智谱')
    expect(disk).toContain('这行不是凭据')
  })

  it('超长字符串按上限截断落盘（不整段进便携盘）', () => {
    const long = `L${'x'.repeat(MAX_LOG_STRING_CHARS + 4000)}END`
    createLogger('probe').info('粘贴了整段正文', long)
    const disk = diskBytes()
    expect(disk).not.toContain('END')
    expect(disk).toContain(`原长 ${long.length} 字符`)
  })

  it('反向对照：不经脱敏直接写的明文行，扫描确实搜得到（证明上面两条有牙齿）', () => {
    fs.appendFileSync(FILE, `${CONTROL} 这行绕过了 logger\n`)
    expect(diskBytes()).toContain(CONTROL)
  })

  it('readLogTail 读的就是这份文件（写盘与主进程内读取同一通道）', () => {
    createLogger('probe').warn('慢事件样例')
    const tail = readLogTail().join('\n')
    expect(tail).toContain('慢事件样例')
    expect(tail).toContain('[redacted]')
  })
})
