// M8：MCP env 危险变量在配置入口拒绝、运行时合并时后置覆盖
import { describe, it, expect } from 'vitest'
import { mcpServerSaveSchema } from '../src/shared/schemas/mcp'
import { envValue, mergeMcpEnv, sanitizeMcpEnv } from '../src/main/mcp/env-policy'

describe('MCP_SERVER_SAVE env 键名校验', () => {
  it('危险键在配置入口直接拒绝', () => {
    for (const key of [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS',
      'PYTHONPATH',
      'PYTHONHOME',
      'ComSpec',
      'PATHEXT',
      'PATH'
    ]) {
      expect(mcpServerSaveSchema.safeParse({ name: 'x', env: { [key]: 'evil' } }).success).toBe(false)
    }
  })

  it('普通业务变量照常放行', () => {
    expect(
      mcpServerSaveSchema.safeParse({ name: 'x', env: { API_KEY: 'secret', DEBUG: '1' } }).success
    ).toBe(true)
  })
})

describe('运行时 env 合并', () => {
  it('危险键被丢弃，普通变量保留', () => {
    expect(
      sanitizeMcpEnv({
        LD_PRELOAD: '/tmp/evil.so',
        NODE_OPTIONS: '--require=evil.js',
        Path: 'C:\\evil',
        API_KEY: 'k'
      })
    ).toEqual({ API_KEY: 'k' })
  })

  it('应用环境覆盖用户配置，安全值最后写入', () => {
    const merged = mergeMcpEnv(
      { API_KEY: 'user', PATH: 'evil', NODE_OPTIONS: '--require=evil.js' },
      { PATH: 'safe-venv' },
      { API_KEY: 'app', PATH: 'app-path', OTHER: 'v' }
    )
    expect(merged.API_KEY).toBe('app')
    expect(merged.PATH).toBe('safe-venv')
    expect(merged.OTHER).toBe('v')
    expect(merged.NODE_OPTIONS).toBeUndefined()
  })

  it('PATH/Path 大小写不敏感读取（needsCmdShim 与 spawn 同一口径）', () => {
    expect(envValue({ Path: 'C:\\nodejs' }, 'PATH')).toBe('C:\\nodejs')
    expect(envValue({ PATH: '/usr/bin' }, 'PATH')).toBe('/usr/bin')
  })
})
