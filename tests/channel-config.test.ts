// channel-config 渠道网关配置测试
//
// 覆盖 src/main/channels/channel-config.ts 的配置读写纯业务逻辑：
// - prefixFor：type → KV 前缀（telegram 沿用旧前缀 channel.tg_ 兼容历史数据）
// - primarySecretKey / secondarySecretKey：凭据 key 路由矩阵
// - bool：'1' 字符串 → true
// - getChannelConfig / setChannelConfig：配置读写、白名单清洗、appId 清理、凭据长度校验
// - getChannelSecrets：明文密钥 + 白名单解析
// - getTgOffset / setTgOffset：offset 边界校验
//
// 策略：vi.hoisted 集中 mock appConfigRepo(Map) 与 secret-store(Map)，
// 每用例 beforeEach 重置，验证读写行为与清洗规则。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  const secrets = new Map<string, string>()
  return {
    store,
    secrets,
    appConfigRepo: {
      get: (k: string) => (store.has(k) ? store.get(k)! : null),
      set: (k: string, v: string) => store.set(k, v),
      delete: (k: string) => store.delete(k)
    },
    secretStore: {
      getSecret: (k: string) => secrets.get(k) ?? '',
      setSecret: (k: string, v: string) => {
        if (v === '') secrets.delete(k)
        else secrets.set(k, v)
      },
      hasSecret: (k: string) => secrets.has(k) && secrets.get(k) !== ''
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: mocks.appConfigRepo
}))

vi.mock('../src/main/crypto/secret-store', () => ({
  getSecret: (k: string) => mocks.secretStore.getSecret(k),
  setSecret: (k: string, v: string) => mocks.secretStore.setSecret(k, v),
  hasSecret: (k: string) => mocks.secretStore.hasSecret(k),
  SECRET_KV_KEYS: {
    TELEGRAM_TOKEN: 'channel.tg_token',
    FEISHU_APP_SECRET: 'channel.feishu_app_secret',
    DINGTALK_APP_SECRET: 'channel.dingtalk_app_secret',
    SLACK_BOT_TOKEN: 'channel.slack_bot_token',
    SLACK_APP_TOKEN: 'channel.slack_app_token',
    DISCORD_BOT_TOKEN: 'channel.discord_bot_token',
    WEBSEARCH_API_KEY: 'agent.websearch_api_key'
  }
}))

import {
  prefixFor,
  primarySecretKey,
  secondarySecretKey,
  bool,
  getChannelConfig,
  setChannelConfig,
  getChannelSecrets,
  getChannelField,
  setChannelField,
  getTgOffset,
  setTgOffset,
  convMapKey
} from '../src/main/channels/channel-config'

beforeEach(() => {
  mocks.store.clear()
  mocks.secrets.clear()
})

describe('prefixFor — 网关 KV 前缀映射', () => {
  it('telegram 沿用旧前缀 channel.tg_（向后兼容）', () => {
    expect(prefixFor('telegram')).toBe('channel.tg_')
  })
  it('其他网关用 channel.{type}_', () => {
    expect(prefixFor('feishu')).toBe('channel.feishu_')
    expect(prefixFor('dingtalk')).toBe('channel.dingtalk_')
    expect(prefixFor('slack')).toBe('channel.slack_')
    expect(prefixFor('discord')).toBe('channel.discord_')
  })
})

describe('primarySecretKey / secondarySecretKey — 凭据路由矩阵', () => {
  it('主凭据：telegram/slack/discord 有，飞书/钉钉无', () => {
    expect(primarySecretKey('telegram')).toBe('channel.tg_token')
    expect(primarySecretKey('slack')).toBe('channel.slack_bot_token')
    expect(primarySecretKey('discord')).toBe('channel.discord_bot_token')
    expect(primarySecretKey('feishu')).toBeNull()
    expect(primarySecretKey('dingtalk')).toBeNull()
  })

  it('次凭据：飞书/钉钉/Slack 有，telegram/discord 无', () => {
    expect(secondarySecretKey('feishu')).toBe('channel.feishu_app_secret')
    expect(secondarySecretKey('dingtalk')).toBe('channel.dingtalk_app_secret')
    expect(secondarySecretKey('slack')).toBe('channel.slack_app_token')
    expect(secondarySecretKey('telegram')).toBeNull()
    expect(secondarySecretKey('discord')).toBeNull()
  })
})

describe('bool — 字符串布尔解析', () => {
  it("'1' → true", () => expect(bool('1')).toBe(true))
  it("'0' / 其他 → false", () => {
    expect(bool('0')).toBe(false)
    expect(bool(null)).toBe(false)
    expect(bool(undefined)).toBe(false)
    expect(bool(true)).toBe(false)
    expect(bool('true')).toBe(false)
  })
})

describe('getChannelConfig — 读取网关配置', () => {
  it('空配置 → 全默认值，hasSecret 均 false', () => {
    const cfg = getChannelConfig('feishu')
    expect(cfg).toEqual({
      type: 'feishu',
      enabled: false,
      hasPrimarySecret: false,
      hasSecondarySecret: false,
      appId: '',
      whitelist: '',
      assistantId: '',
      providerId: '',
      model: '',
      agentMode: false
    })
  })

  it('enabled=1 / agentMode=1 → true', () => {
    mocks.store.set('channel.feishu_enabled', '1')
    mocks.store.set('channel.feishu_agent_mode', '1')
    const cfg = getChannelConfig('feishu')
    expect(cfg.enabled).toBe(true)
    expect(cfg.agentMode).toBe(true)
  })

  it('凭据已配置 → hasPrimarySecret/hasSecondarySecret true', () => {
    mocks.secrets.set('channel.feishu_app_secret', 'xxx')
    const cfg = getChannelConfig('feishu')
    expect(cfg.hasPrimarySecret).toBe(false) // 飞书无主凭据
    expect(cfg.hasSecondarySecret).toBe(true)
  })

  it('telegram 有主凭据 → hasPrimarySecret true', () => {
    mocks.secrets.set('channel.tg_token', '123456:ABC')
    const cfg = getChannelConfig('telegram')
    expect(cfg.hasPrimarySecret).toBe(true)
    expect(cfg.hasSecondarySecret).toBe(false)
  })

  it('字段读取按 type 前缀隔离', () => {
    mocks.store.set('channel.slack_app_id', 'slack-app')
    mocks.store.set('channel.discord_app_id', 'discord-app')
    expect(getChannelConfig('slack').appId).toBe('slack-app')
    expect(getChannelConfig('discord').appId).toBe('discord-app')
  })
})

describe('setChannelConfig — 保存网关配置', () => {
  it('enabled true/false → 存 1/0', () => {
    setChannelConfig('telegram', { enabled: true })
    expect(mocks.store.get('channel.tg_enabled')).toBe('1')
    setChannelConfig('telegram', { enabled: false })
    expect(mocks.store.get('channel.tg_enabled')).toBe('0')
  })

  it('主凭据空串 → 删除；非空 → 加密存储（trim）', () => {
    setChannelConfig('telegram', { primarySecret: '  token-abc  ' })
    expect(mocks.secrets.get('channel.tg_token')).toBe('token-abc')
    setChannelConfig('telegram', { primarySecret: '' })
    expect(mocks.secrets.has('channel.tg_token')).toBe(false)
  })

  it('主凭据超 512 字符 → 抛错', () => {
    const long = 'a'.repeat(513)
    expect(() => setChannelConfig('telegram', { primarySecret: long })).toThrow('主凭据过长')
  })

  it('次凭据超 512 字符 → 抛错', () => {
    const long = 'a'.repeat(513)
    expect(() => setChannelConfig('feishu', { secondarySecret: long })).toThrow('次凭据过长')
  })

  it('appId 只保留字母数字下划线减号，截断 64', () => {
    setChannelConfig('feishu', { appId: 'cli_a1b2-c3!@#d4' })
    expect(mocks.store.get('channel.feishu_app_id')).toBe('cli_a1b2-c3d4')

    const long = 'x'.repeat(100)
    setChannelConfig('feishu', { appId: long })
    expect(mocks.store.get('channel.feishu_app_id')).toHaveLength(64)
  })

  it('whitelist 清洗：去非法字符、合并连续逗号、去首尾逗号', () => {
    setChannelConfig('feishu', { whitelist: ',,u_1,u_2,,  u.3  ,u-4!@#,,' })
    expect(mocks.store.get('channel.feishu_whitelist')).toBe('u_1,u_2,u.3,u-4')
  })

  it('whitelist 清洗后为空串', () => {
    setChannelConfig('feishu', { whitelist: ',,!@#$,' })
    expect(mocks.store.get('channel.feishu_whitelist')).toBe('')
  })

  it('agentMode true/false → 存 1/0', () => {
    setChannelConfig('feishu', { agentMode: true })
    expect(mocks.store.get('channel.feishu_agent_mode')).toBe('1')
    setChannelConfig('feishu', { agentMode: false })
    expect(mocks.store.get('channel.feishu_agent_mode')).toBe('0')
  })

  it('返回 getChannelConfig 的最新值', () => {
    const cfg = setChannelConfig('slack', { enabled: true, appId: 'my-app', assistantId: 'asst_1' })
    expect(cfg.enabled).toBe(true)
    expect(cfg.appId).toBe('my-app')
    expect(cfg.assistantId).toBe('asst_1')
  })

  it('undefined 字段不动已有值', () => {
    mocks.store.set('channel.feishu_model', 'gpt-4')
    setChannelConfig('feishu', { enabled: true }) // 不传 model
    expect(mocks.store.get('channel.feishu_model')).toBe('gpt-4')
  })
})

describe('getChannelSecrets — 明文密钥 + 白名单解析', () => {
  it('空配置 → 全空', () => {
    const s = getChannelSecrets('feishu')
    expect(s).toEqual({ primary: '', secondary: '', appId: '', whitelist: [] })
  })

  it('返回主/次凭据明文与 appId', () => {
    mocks.secrets.set('channel.tg_token', 'bot-token')
    mocks.store.set('channel.tg_app_id', 'app-123')
    const s = getChannelSecrets('telegram')
    expect(s.primary).toBe('bot-token')
    expect(s.secondary).toBe('')
    expect(s.appId).toBe('app-123')
  })

  it('whitelist 按逗号分割、trim、过滤空项', () => {
    mocks.store.set('channel.feishu_whitelist', ' u1 , u2 ,, u3 ')
    const s = getChannelSecrets('feishu')
    expect(s.whitelist).toEqual(['u1', 'u2', 'u3'])
  })

  it('空白名单 → 空数组（fail closed）', () => {
    const s = getChannelSecrets('feishu')
    expect(s.whitelist).toEqual([])
  })
})

describe('getChannelField / setChannelField / convMapKey', () => {
  it('按 type 前缀读写通用字段', () => {
    setChannelField('telegram', 'custom', 'val')
    expect(getChannelField('telegram', 'custom')).toBe('val')
    expect(mocks.store.get('channel.tg_custom')).toBe('val')
  })

  it('convMapKey 按 type 前缀拼 conv_map', () => {
    expect(convMapKey('telegram')).toBe('channel.tg_conv_map')
    expect(convMapKey('feishu')).toBe('channel.feishu_conv_map')
  })
})

describe('getTgOffset / setTgOffset — offset 边界校验', () => {
  it('未设置 / 非数字 / 负数 → 0', () => {
    expect(getTgOffset()).toBe(0)
    mocks.store.set('channel.tg_offset', 'abc')
    expect(getTgOffset()).toBe(0)
    mocks.store.set('channel.tg_offset', '-5')
    expect(getTgOffset()).toBe(0)
  })

  it('正数 → floor', () => {
    mocks.store.set('channel.tg_offset', '42')
    expect(getTgOffset()).toBe(42)
    mocks.store.set('channel.tg_offset', '42.9')
    expect(getTgOffset()).toBe(42)
  })

  it('setTgOffset 只接受有限正数，floor 后存储', () => {
    setTgOffset(100)
    expect(mocks.store.get('channel.tg_offset')).toBe('100')
    setTgOffset(100.7)
    expect(mocks.store.get('channel.tg_offset')).toBe('100')
  })

  it('setTgOffset 非法值不写入', () => {
    setTgOffset(-1)
    expect(mocks.store.has('channel.tg_offset')).toBe(false)
    setTgOffset(NaN)
    expect(mocks.store.has('channel.tg_offset')).toBe(false)
  })
})
