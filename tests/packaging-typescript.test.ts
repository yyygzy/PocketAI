// @vitest-environment node
// `code.symbol` 依赖 typescript 运行时；把它放进 dependencies 还不够，
// 打包 files 规则里必须真的带上，否则安装包里只剩 import 语句、一调用就崩。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')

describe('打包清单必须包含 typescript 运行时', () => {
  it('package.json：typescript 是运行时依赖且未被 files 规则排除', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      build?: { files?: unknown[] }
    }
    expect(pkg.dependencies?.typescript).toBeTruthy()
    expect(pkg.devDependencies?.typescript).toBeUndefined()
    const files = (pkg.build?.files ?? []).map(String)
    expect(files.some((f) => f.includes('typescript'))).toBe(false)
  })

  it('electron-builder.linux.yml 不再排除 typescript', () => {
    const yml = readFileSync(path.join(root, 'electron-builder.linux.yml'), 'utf8')
    expect(yml).not.toMatch(/!\*\*\/node_modules\/\{[^}]*typescript/)
  })
})
