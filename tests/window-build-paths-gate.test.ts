// 窗口路径闸门：每个 BrowserWindow 的 preload / 页面路径字面量，最终必须解析到**真实存在的构建产物**。
//
// 为什么不做"源码里字符串是否等于 `../`"这种形状检查：那只能拦住同一处写法；换文件名、换目录层级、
// 新增窗口都会绕过去。这里以 out/main（运行时 __dirname）为基准解析每个字面量并 existsSync，
// 写法怎么变都要落到一个真文件上。detached 窗口那条 `'../../preload/index.js'`
// （2026-11-06 的「Cannot read properties of undefined (reading 'getLockStatus')」根因）就是被它拦下的形状。
//
// 前置缺失时的口径：**跳过，不失败**。理由：
//  1) 干净 checkout / CI 在 build 之前跑单测时 out/ 本来就不存在，让它红等于强制"先 build 才能测"；
//  2) 只要 out/main/index.js 在（本仓通常都有），下面第二条用例就会逐个字面量解析并断言文件存在，
//     缺一个即红——闸门的强度落在"有构建产物"这个真实场景上，而不是把缺失当失败。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const MAIN_SRC = path.join(ROOT, 'src', 'main')
const OUT_MAIN = path.join(ROOT, 'out', 'main')
/** 存在构建产物才具备可解析的基准；不存在时本闸门跳过（理由见文件头） */
const HAS_BUILD = fs.existsSync(path.join(OUT_MAIN, 'index.js'))

/** 必须被扫到的窗口文件：防正则失配后"SITES 为空也算过" */
const REQUIRED_FILES = [
  'src/main/index.ts',
  'src/main/windows/detached.ts',
  'src/main/popup.ts',
  'src/main/ipc/handlers/encryption.ts'
]

type Kind = 'preload' | 'page'
interface Site {
  file: string
  line: number
  kind: Kind
  literal: string
  resolved: string
}

const SITE_PATTERNS: Array<{ kind: Kind; re: RegExp }> = [
  { kind: 'preload', re: /preload:\s*path\.join\(\s*__dirname\s*,\s*'([^']+)'/g },
  { kind: 'page', re: /loadFile\(\s*path\.join\(\s*__dirname\s*,\s*'([^']+)'/g }
]

function listTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, it.name)
    if (it.isDirectory()) files.push(...listTsFiles(full))
    else if (/\.ts$/.test(it.name)) files.push(full)
  }
  return files
}

function collectSites(): Site[] {
  const sites: Site[] = []
  for (const file of listTsFiles(MAIN_SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const { kind, re } of SITE_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const literal = m[1]!
        const line = text.slice(0, m.index!).split('\n').length
        sites.push({
          file: path.relative(ROOT, file).split(path.sep).join('/'),
          line,
          kind,
          literal,
          resolved: path.resolve(OUT_MAIN, literal)
        })
      }
    }
  }
  return sites
}

const SITES = collectSites()
const describeSite = (s: Site): string => `${s.file}:${s.line} ${s.kind} ${s.literal}`

describe('窗口 preload / 页面路径必须落到真实构建产物', () => {
  it('至少扫到 8 个字面量，且四个窗口文件都在册（防止正则失配后空转通过）', () => {
    const files = Array.from(new Set(SITES.map((s) => s.file)))
    expect(SITES.length, SITES.map(describeSite).join('\n')).toBeGreaterThanOrEqual(8)
    for (const f of REQUIRED_FILES) {
      expect(files, `没扫到 ${f} 的路径字面量`).toContain(f)
    }
  })

  if (HAS_BUILD) {
    it('每个 preload / 页面字面量都能在 out/ 下解析到真实文件', () => {
      const missing = SITES.filter((s) => !fs.existsSync(s.resolved))
      expect(missing, `解析不到的窗口路径：\n${missing.map((s) => `${describeSite(s)} → ${s.resolved}`).join('\n')}`).toEqual([])
    })
  } else {
    it.skip('每个 preload / 页面字面量都能在 out/ 下解析到真实文件（跳过：out/main/index.js 不存在，需先 build）', () => {})
  }
})
