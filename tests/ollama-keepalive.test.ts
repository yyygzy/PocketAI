// Ollama keep_alive（prefix caching 配套）回归：
//  ① 配置读写校验：空＝清除、合法时间串放行、非法值拒绝、过长拒绝
//  ② 仅 ollama provider 注入 keep_alive，其他 OpenAI 兼容端点绝不带上
//  ③ IPC 回显：get/set 通道可用，非法值返回 {ok:false} 且带中文错误
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const { getMock, setMock } = vi.hoisted(() => ({
  getMock: { value: null as string | null },
  setMock: { calls: [] as string[] }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: () => getMock.value,
    set: (_k: string, v: string) => { setMock.calls.push(v); getMock.value = v }
  }
}))

import { getOllamaKeepAlive, setOllamaKeepAlive } from '../src/main/ollama/keepalive-config'

beforeEach(() => {
  getMock.value = null
  setMock.calls = []
})

describe('keep_alive 配置校验', () => {
  it('未配置 / 空串 ⇒ 不下发（undefined）', () => {
    expect(getOllamaKeepAlive()).toBeUndefined()
    getMock.value = '   '
    expect(getOllamaKeepAlive()).toBeUndefined()
  })

  it('合法时间串原样放行：10m / 24h / -1 / 3600', () => {
    for (const v of ['10m', '24h', '-1', '3600']) {
      expect(setOllamaKeepAlive(v)).toBe(true)
      expect(getOllamaKeepAlive()).toBe(v)
    }
  })

  it('非法值与超长值拒绝，不写库', () => {
    expect(setOllamaKeepAlive('abc')).toBe(false)
    expect(setOllamaKeepAlive('1d')).toBe(false)
    expect(setOllamaKeepAlive('m'.repeat(33))).toBe(false)
    expect(setMock.calls).toEqual([])
  })

  it('传 null/空串清除配置', () => {
    getMock.value = '10m'
    expect(setOllamaKeepAlive(null)).toBe(true)
    expect(getOllamaKeepAlive()).toBeUndefined()
  })
})

describe('仅 ollama provider 注入 keep_alive（源码闸门）', () => {
  const adapter = readFileSync('src/main/providers/openai-compatible.ts', 'utf8')
  const manager = readFileSync('src/main/providers/manager.ts', 'utf8')

  it('请求体只在 keepAlive 存在时写入，且不是全局字段', () => {
    expect(adapter).toMatch(/if \(this\.keepAlive\) body\.keep_alive = this\.keepAlive/)
  })

  it('manager 只对 type==="ollama" 注入配置（经注入的 resolver，不直接依赖 DB）', () => {
    expect(manager).toMatch(/record\.type === 'ollama' \? this\.keepAliveResolver\(\) : undefined/)
    expect(manager).toMatch(/setKeepAliveResolver\(fn: \(\) => string \| undefined\)/)
    expect(manager).not.toMatch(/from '\.\.\/ollama\/keepalive-config'/)
    // 真实读取器由 Ollama handler 注册时注入（那里才有 app_config 依赖）
    const handler = readFileSync('src/main/ipc/handlers/ollama.ts', 'utf8')
    expect(handler).toMatch(/providerManager\.setKeepAliveResolver\(\(\) => getOllamaKeepAlive\(\)\)/)
  })

  it('非 ollama 的 OpenAI 兼容端点请求体没有被无条件注入', () => {
    // 全文件只有一处 body.keep_alive 赋值，且被 if (this.keepAlive) 守卫；
    // 没有第二处无条件赋值（这才是"不污染其他端点"的判据）。
    const assignments = adapter.match(/body\.keep_alive\s*=/g) ?? []
    expect(assignments).toHaveLength(1)
    expect(adapter).toMatch(/if \(this\.keepAlive\) body\.keep_alive = this\.keepAlive/)
  })
})

describe('IPC 读写通道（源码闸门）', () => {
  const types = readFileSync('src/shared/types.ts', 'utf8')
  const handler = readFileSync('src/main/ipc/handlers/ollama.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')

  it('常量、handler 与 preload 齐备，非法值回中文错误', () => {
    expect(types).toMatch(/OLLAMA_KEEPALIVE_GET/)
    expect(types).toMatch(/OLLAMA_KEEPALIVE_SET/)
    expect(handler).toMatch(/驻留时间格式不正确/)
    expect(preload).toMatch(/getOllamaKeepAlive/)
    expect(preload).toMatch(/setOllamaKeepAlive/)
  })
})
