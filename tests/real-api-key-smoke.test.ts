// @vitest-environment node
// 真实 API Key 冒烟：用应用自己的 Provider 适配器向真实云端端点发一次最小请求。
//
// 凭据只从环境变量或家目录下的本地 env 文件读取，不进代码、不进 git、不进日志：
//   POCKETAI_SMOKE_BASE_URL      例：https://api.deepseek.com / https://api.anthropic.com
//   POCKETAI_SMOKE_API_KEY       真实 Key
//   POCKETAI_SMOKE_MODEL         例：deepseek-chat / claude-sonnet-4-5
//   POCKETAI_SMOKE_PROVIDER_TYPE openai-compatible（默认）| anthropic
//   POCKETAI_SMOKE_ENV_FILE      env 文件路径，默认 ~/.pocketai-smoke.env
//
// 没配齐就整体跳过，不会让 CI 因为缺 Key 变红。
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 云端端点不占本地推理槽；顺带避免 local-capacity 在本测试里探测硬件
vi.mock('../src/main/providers/local-slot', () => ({
  withLocalSlot: (_req: unknown, fn: () => Promise<unknown>) => fn()
}))

import { OpenAICompatibleAdapter } from '../src/main/providers/openai-compatible'
import { AnthropicNativeAdapter } from '../src/main/providers/anthropic-native'
import { normalizeBaseUrl } from '../src/main/providers/types'

const KEYS = [
  'POCKETAI_SMOKE_BASE_URL',
  'POCKETAI_SMOKE_API_KEY',
  'POCKETAI_SMOKE_MODEL',
  'POCKETAI_SMOKE_PROVIDER_TYPE'
] as const

type SmokeEnvKey = (typeof KEYS)[number]

interface SmokeConfig {
  baseUrl: string
  apiKey: string
  model: string
  type: string
}

function readEnvFile(): Partial<Record<SmokeEnvKey, string>> {
  const file = process.env.POCKETAI_SMOKE_ENV_FILE || path.join(os.homedir(), '.pocketai-smoke.env')
  if (!fs.existsSync(file)) return {}
  const out: Partial<Record<SmokeEnvKey, string>> = {}
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim() as SmokeEnvKey
    if (!KEYS.includes(key)) continue
    out[key] = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
  }
  return out
}

function loadConfig(): SmokeConfig | null {
  const fromFile = readEnvFile()
  const pick = (k: SmokeEnvKey): string => (process.env[k] || fromFile[k] || '').trim()
  const baseUrl = pick('POCKETAI_SMOKE_BASE_URL')
  const apiKey = pick('POCKETAI_SMOKE_API_KEY')
  const model = pick('POCKETAI_SMOKE_MODEL')
  if (!baseUrl || !apiKey || !model) return null
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    model,
    type: pick('POCKETAI_SMOKE_PROVIDER_TYPE') || 'openai-compatible'
  }
}

/** 任何错误信息里都不允许带出 Key */
function redact(text: string, key: string): string {
  return text.split(key).join('***')
}

const cfg = loadConfig()
const suite = cfg ? describe : describe.skip

suite('真实 API Key 冒烟（真实端点，最小请求）', () => {
  it('应用自己的 Provider 适配器能拿到非空回复', async () => {
    const c = cfg!
    const adapter =
      c.type === 'anthropic'
        ? new AnthropicNativeAdapter(c.baseUrl, [c.apiKey])
        : new OpenAICompatibleAdapter(c.baseUrl, [c.apiKey])

    const started = Date.now()
    try {
      const result = await adapter.streamChat(
        [{ role: 'user', content: '只回复 pong 三个字母，不要其他文字。' }],
        { model: c.model, temperature: 0, maxTokens: 32 },
        { onDelta: () => {} }
      )
      const answer = result.content.trim()
      expect(answer.length).toBeGreaterThan(0)
      console.log(
        `[smoke] OK · type=${c.type} · model=${c.model} · ${Date.now() - started}ms · 回复=${answer.slice(0, 120)}`
      )
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      throw new Error(`真实端点冒烟失败（Key 已脱敏）: ${redact(raw, c.apiKey)}`)
    }
  }, 120_000)
})
