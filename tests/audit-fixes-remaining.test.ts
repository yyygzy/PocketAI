// 最后一批审查项回归：
//  - 附件异步入库与消息删除竞态（OCR 期间删消息 ⇒ 孤儿 KB 文档）
//  - Windows 终止终端只杀 cmd.exe（孙进程泄漏）
//  - spawn 异步 error 后 session 残留（running 永久 true）
//  - 图片/沙箱 resolveDataPath 缺 realpath 复核（符号链接越界）
//  - 图片生成落盘非原子写
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('附件入库竞态', () => {
  it('图片 OCR 返回后再次复核消息存在', () => {
    const src = readFileSync('src/main/attachment/attachment-ingestion.ts', 'utf8')
    expect(src).toMatch(/const stillAlive = \(\): boolean => !!messageRepo\.getById\(messageId\)/)
    const i = src.indexOf('await ocrImageDataUrl(')
    const j = src.indexOf('kbDocRepo.insert(', i)
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    expect(src.slice(i, j)).toMatch(/stillAlive\(\)/)
  })
})

describe('终端进程树与 session', () => {
  it('Windows 下用 taskkill /T /F 终止整棵树', () => {
    const src = readFileSync('src/main/terminal/terminal-service.ts', 'utf8')
    expect(src).toMatch(/execFile\)\('taskkill', \['\/PID', String\(pid\), '\/T', '\/F'\]/)
  })

  it('error 事件清理 session 并补发 exit', () => {
    const src = readFileSync('src/main/terminal/terminal-service.ts', 'utf8')
    const i = src.indexOf("proc.on('error'")
    const seg = src.slice(i, i + 600)
    expect(seg).toMatch(/sessions\.delete\(ownerId\)/)
    expect(seg).toMatch(/push\('exit', '-1'\)/)
  })
})

describe('路径 realpath 守卫', () => {
  it('图片 resolveDataPath 调用 assertWithinWorkspaceByRealpath', () => {
    const src = readFileSync('src/main/images/image-service.ts', 'utf8')
    expect(src).toMatch(/assertWithinWorkspaceByRealpath\(abs, DATA_DIR\)/)
  })

  it('沙箱 resolveDataPath 调用 assertWithinWorkspaceByRealpath', () => {
    const src = readFileSync('src/main/sandbox/sandbox-service.ts', 'utf8')
    expect(src).toMatch(/assertWithinWorkspaceByRealpath\(abs, DATA_DIR\)/)
  })
})

describe('图片原子写', () => {
  it('saveImage 用 writeFileAtomicSync 而非 writeFileSync', () => {
    const src = readFileSync('src/main/images/image-service.ts', 'utf8')
    const i = src.indexOf('function saveImage(')
    const seg = src.slice(i, i + 900)
    expect(seg).toMatch(/writeFileAtomicSync\(abs, buf\)/)
    expect(seg).toMatch(/writeFileAtomicSync\(thumbAbs/)
    expect(seg).not.toMatch(/fs\.writeFileSync/)
  })
})
