// §281：内置助手的 name/description/welcomeMessage 四语本地化。
// 三面判据：① helper 纯函数行为；② 96 把键逐本字典齐 + 与磁盘 JSON 一一对上（新增内置助手没补字典就红）；
// ③ 真挂载的读点在 en 下确实显示英文名（正向对照：中文原始串不许再出现在屏上）。
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { cleanup, screen } from '@testing-library/react'
import React from 'react'
import type { AssistantRecord } from '../src/shared/types'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import {
  BUILTIN_ASSISTANT_IDS,
  BUILTIN_I18N_KEYS,
  assistantDisplayName,
  assistantDisplayDescription,
  assistantDisplayWelcome,
  builtinAssistantNameById
} from '../src/renderer/src/modules/chat/assistant-display'
import { AssistantRail } from '../src/renderer/src/modules/chat/AssistantRail'
import { mountWithProviders, stubPocketai } from './helpers/renderer'

const dicts: Record<'zh' | 'en' | 'ja' | 'ko', Record<string, string>> = { zh, en, ja, ko }
type Lang = keyof typeof dicts
const tFor = (lang: Lang) => (key: string): string => dicts[lang][key] ?? key

function rec(over: Partial<AssistantRecord>): AssistantRecord {
  return {
    id: 'x', name: '', description: '', avatar: '🤖', systemPrompt: '',
    defaultProviderId: null, defaultModel: null, defaultParams: null,
    toolPermissions: [], skillIds: [], knowledgeBaseIds: [], welcomeMessage: '',
    isBuiltin: false, isPinned: false, createdAt: 0, updatedAt: 0, ...over
  } as AssistantRecord
}

describe('assistant-display helper 行为', () => {
  const builtin = rec({ id: 'asst-default', name: '通用问答', isBuiltin: true })

  it('非内置助手：原样透传，绝不查字典', () => {
    const custom = rec({ id: 'my-asst', name: '我的助手', description: '我自己的', isBuiltin: false })
    expect(assistantDisplayName(custom, tFor('en'))).toBe('我的助手')
    expect(assistantDisplayDescription(custom, tFor('en'))).toBe('我自己的')
    expect(assistantDisplayWelcome(custom, tFor('en'))).toBe('')
  })

  it('内置助手：按当前语言取字典值（en 得英文名，不是中文原始串）', () => {
    expect(assistantDisplayName(builtin, tFor('en'))).toBe('General Q&A')
    expect(assistantDisplayName(builtin, tFor('ja'))).toBe('一般Q&A')
    expect(assistantDisplayName(builtin, tFor('ko'))).toBe('일반 문답')
    expect(assistantDisplayName(builtin, tFor('zh'))).toBe('通用问答')
  })

  it('内置 id 不在键表里 / 字典缺键 ⇒ 回落 DB 原始串，不吐裸键', () => {
    const orphan = rec({ id: 'asst-not-in-table', name: '孤儿内置', isBuiltin: true })
    expect(assistantDisplayName(orphan, tFor('en'))).toBe('孤儿内置')
    // t 找不到键时原样返回键名——helper 要能识别并回落
    const stubT = (k: string): string => k
    expect(assistantDisplayName(builtin, stubT)).toBe('通用问答')
  })

  it('builtinAssistantNameById：命中内置 id 给本地化名，自定义/未知 id 回 null', () => {
    expect(builtinAssistantNameById('asst-default', tFor('en'))).toBe('General Q&A')
    expect(builtinAssistantNameById('my-asst', tFor('en'))).toBeNull()
    expect(builtinAssistantNameById(null, tFor('en'))).toBeNull()
  })
})

describe('96 把键逐本字典齐 + 与磁盘内置助手对齐', () => {
  const idsFromDisk = readdirSync(path.resolve(__dirname, '../extensions/assistants'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => readFileSync(path.resolve(__dirname, '../extensions/assistants', f), 'utf8'))
    .map((raw) => (JSON.parse(raw) as { id: string }).id)
    .sort()

  it('BUILTIN_ASSISTANT_IDS 与 extensions/assistants/*.json 的 id 完全一致（新增内置必须同步补键表）', () => {
    expect([...BUILTIN_ASSISTANT_IDS].sort()).toEqual(idsFromDisk)
  })

  it('每个内置 id 的 name/description/welcomeMessage 三把键，四本字典都有非空值', () => {
    for (const id of BUILTIN_ASSISTANT_IDS) {
      const keys = BUILTIN_I18N_KEYS[id]
      for (const field of ['name', 'description', 'welcomeMessage'] as const) {
        const key = keys[field]
        for (const lang of ['zh', 'en', 'ja', 'ko'] as Lang[]) {
          expect(dicts[lang][key], `${lang}.${key} 该有值`).toBeTruthy()
        }
      }
    }
  })

  it('zh 字典的 name/description 逐字等于磁盘 JSON 原始串（DB 兜底与字典同源，不许偷偷改一处）', () => {
    for (const id of BUILTIN_ASSISTANT_IDS) {
      const json = JSON.parse(readFileSync(path.resolve(__dirname, `../extensions/assistants/${id}.json`), 'utf8')) as { name: string; description: string }
      expect(dicts.zh[BUILTIN_I18N_KEYS[id].name], `${id} name`).toBe(json.name)
      expect(dicts.zh[BUILTIN_I18N_KEYS[id].description], `${id} description`).toBe(json.description)
    }
  })

  it('assistant.copySuffix 四语齐', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko'] as Lang[]) {
      expect(dicts[lang]['assistant.copySuffix'], `${lang} copySuffix`).toBeTruthy()
    }
  })
})

describe('真挂载读点：AssistantRail 在 en 下显示英文名', () => {
  afterEach(() => cleanup())

  const rail = (): void => {
    stubPocketai({})
    mountWithProviders(
      React.createElement(AssistantRail, {
        assistants: [
          rec({ id: 'asst-default', name: '通用问答', description: '默认助手', isBuiltin: true, avatar: '💬' }),
          rec({ id: 'my-asst', name: '我的自定义', description: '用户自起', avatar: '🧩' })
        ],
        activeId: 'asst-default',
        onSelect: () => {},
        onOpenMarket: () => {}
      })
    )
  }

  it('语言=en：内置助手出英文「General Q&A」，自定义助手原样；中文原始串不在屏上', async () => {
    localStorage.setItem('pocketai.lang', 'en')
    rail()
    // en 字典异步补载 ⇒ 等英文名出现（findByText 自带重试，别用固定 sleep）
    await screen.findByText('General Q&A')
    expect(screen.getByText('我的自定义')).toBeTruthy()
    expect(screen.queryByText('通用问答')).toBeNull()
    localStorage.setItem('pocketai.lang', 'zh')
  })

  it('语言=zh：内置助手仍是中文「通用问答」（正向对照，证明 en 那侧不是整屏空白）', async () => {
    localStorage.setItem('pocketai.lang', 'zh')
    rail()
    expect(screen.getByText('通用问答')).toBeTruthy()
    expect(screen.queryByText('General Q&A')).toBeNull()
  })
})
