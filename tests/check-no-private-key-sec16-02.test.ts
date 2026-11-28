// check-no-private-key.cjs 双分支测试（SEC-16-02）
//
// 覆盖 scripts/check-no-private-key.cjs：
// - 交付目录里存在任一发行私钥落点 → 中文报错 + exit 1
// - 干净目录 → exit 0
//
// 策略：脚本设计成接受 --dir 参数（默认 process.cwd()），测试用临时目录注入，
// 真仓库里的 build/license-private.pem 不参与断言、也不被改动。
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(__dirname, '..', 'scripts', 'check-no-private-key.cjs')

const tmpRoots: string[] = []
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pocketai-privkey-${prefix}-`))
  tmpRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
})

describe('check-no-private-key — 发现私钥 → exit 1（中文报错）', () => {
  it('build/license-private.pem 存在 → exit 1', () => {
    const dir = makeTmp('build')
    mkdirSync(join(dir, 'build'), { recursive: true })
    writeFileSync(join(dir, 'build', 'license-private.pem'), '-----BEGIN PRIVATE KEY-----')
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('发行私钥存在于交付目录')
    expect(r.stderr).toContain('build/license-private.pem')
  })

  it('license-server/license-private.pem 存在 → exit 1', () => {
    const dir = makeTmp('server')
    mkdirSync(join(dir, 'license-server'), { recursive: true })
    writeFileSync(join(dir, 'license-server', 'license-private.pem'), '-----BEGIN PRIVATE KEY-----')
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('license-server/license-private.pem')
  })

  it('根目录 license-private.pem 存在 → exit 1', () => {
    const dir = makeTmp('root')
    writeFileSync(join(dir, 'license-private.pem'), '-----BEGIN PRIVATE KEY-----')
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('license-private.pem')
  })

  it('两个落点同时存在 → 逐个报出（一次看全）', () => {
    const dir = makeTmp('multi')
    mkdirSync(join(dir, 'build'), { recursive: true })
    writeFileSync(join(dir, 'build', 'license-private.pem'), 'k1')
    writeFileSync(join(dir, 'license-private.pem'), 'k2')
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('build/license-private.pem')
    expect(r.stderr).toContain('license-private.pem')
  })
})

describe('check-no-private-key — 干净目录 → exit 0', () => {
  it('无任何私钥落点 → exit 0，输出校验通过', () => {
    const dir = makeTmp('clean')
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('校验通过')
  })

  it('同一路径存在的是公钥（license-public.pem）→ 不拦截', () => {
    const dir = makeTmp('pubkey')
    mkdirSync(join(dir, 'build'), { recursive: true })
    writeFileSync(join(dir, 'build', 'license-public.pem'), '-----BEGIN PUBLIC KEY-----')
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })

  it('不传 --dir → 默认 process.cwd() 可执行（行为随当前目录而异，只断言不崩）', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: makeTmp('cwd') })
    expect([0, 1]).toContain(r.status as number)
  })
})
