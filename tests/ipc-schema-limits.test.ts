// P4-6 配置/内容类 IPC schema 资源上限测试
//
// 覆盖 12 个此前只有 min(1) 无 max 的共享 schema：
// - LLM 注入面：skills.content/systemPrompt → LLM system prompt
// - 内容面：notes/knowledge/translate/images → 落库 / embedding / 计费 API
// - 配置面：providers/agent/sandbox/channels/preferences/encryption/license
// 阈值宽松、正常使用不可达；验证超限与畸形输入在 IPC 入口被拒。
import { describe, it, expect } from 'vitest'
import { skillSaveSchema, skillShapeSchema } from '../src/shared/schemas/skills'
import { assistantSaveSchema } from '../src/shared/schemas/assistants'
import { notesCreateSchema, notesUpdatePatchSchema } from '../src/shared/schemas/notes'
import {
  kbSaveSchema,
  kbDocAddUrlArgsSchema,
  kbDocAddTextArgsSchema,
  kbRetrieveArgsSchema
} from '../src/shared/schemas/knowledge'
import { translateRequestSchema, glossarySaveSchema } from '../src/shared/schemas/translate'
import { imageGenerateSchema } from '../src/shared/schemas/images'
import { providerRecordSchema, idSchema } from '../src/shared/schemas/providers'
import { websearchConfigSchema, calendarConfigSchema, toolApproveResponseSchema, textProtocolToggleSchema } from '../src/shared/schemas/agent'
import { sandboxCreateSchema, sandboxUpdateMetaSchema } from '../src/shared/schemas/sandbox'
import { channelSetConfigSchema } from '../src/shared/schemas/channels'
import { uiPrefsPatchSchema, sidebarOrderSchema, sidebarPinnedSchema } from '../src/shared/schemas/preferences'
import { DEFAULT_SIDEBAR_ORDER, MAX_PINNED_SIDEBAR_MODULES } from '../src/shared/types'
import { masterPasswordSchema, recoveryCodeSchema, recoverPayloadSchema } from '../src/shared/schemas/encryption'
import { licenseCodeSchema, filePathSchema } from '../src/shared/schemas/license'

// ── skills（content 进 LLM system prompt） ────────────────
describe('skills schema — LLM 注入面上限', () => {
  it('合法保存通过', () => {
    expect(skillSaveSchema.safeParse({ name: '翻译助手', content: '你是…' }).success).toBe(true)
  })

  it('name 空/超 100 拒绝', () => {
    expect(skillSaveSchema.safeParse({ name: '' }).success).toBe(false)
    expect(skillSaveSchema.safeParse({ name: 'n'.repeat(101) }).success).toBe(false)
  })

  it('content 超 5 万字符拒绝', () => {
    expect(
      skillSaveSchema.safeParse({ name: 's', content: 'c'.repeat(50_001) }).success
    ).toBe(false)
    expect(
      skillSaveSchema.safeParse({ name: 's', content: 'c'.repeat(50_000) }).success
    ).toBe(true)
  })

  it('tags 超 20 个 / 单 tag 超 50 拒绝', () => {
    expect(
      skillShapeSchema.safeParse({
        name: 's',
        description: '',
        icon: '',
        content: '',
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`)
      }).success
    ).toBe(false)
    expect(
      skillShapeSchema.safeParse({
        name: 's', description: '', icon: '', content: '', tags: ['t'.repeat(51)]
      }).success
    ).toBe(false)
  })

  it('skillShape（导入/远程拉取）同上限收口', () => {
    expect(
      skillShapeSchema.safeParse({
        name: 's', description: '', icon: '', content: 'c'.repeat(50_001)
      }).success
    ).toBe(false)
  })
})

// ── assistants（systemPrompt 进 LLM） ─────────────────────
describe('assistants schema — LLM 注入面上限', () => {
  it('合法保存通过', () => {
    expect(assistantSaveSchema.safeParse({ name: '助手', systemPrompt: '你是…' }).success).toBe(
      true
    )
  })

  it('systemPrompt 超 10 万字符拒绝', () => {
    expect(
      assistantSaveSchema.safeParse({ name: 'a', systemPrompt: 's'.repeat(100_001) }).success
    ).toBe(false)
  })

  it('avatar 超 100 字符拒绝（emoji/短标识，不支持 data URL）', () => {
    expect(assistantSaveSchema.safeParse({ name: 'a', avatar: '🤖' }).success).toBe(true)
    expect(
      assistantSaveSchema.safeParse({ name: 'a', avatar: 'x'.repeat(101) }).success
    ).toBe(false)
  })

  it('toolPermissions/skillIds/knowledgeBaseIds 超 100 项拒绝', () => {
    const big = Array.from({ length: 101 }, (_, i) => `id${i}`)
    expect(assistantSaveSchema.safeParse({ name: 'a', toolPermissions: big }).success).toBe(false)
    expect(assistantSaveSchema.safeParse({ name: 'a', skillIds: big }).success).toBe(false)
    expect(assistantSaveSchema.safeParse({ name: 'a', knowledgeBaseIds: big }).success).toBe(false)
  })

  it('defaultParams 超 20 键拒绝', () => {
    const params = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]))
    expect(assistantSaveSchema.safeParse({ name: 'a', defaultParams: params }).success).toBe(false)
    expect(assistantSaveSchema.safeParse({ name: 'a', defaultParams: null }).success).toBe(true)
  })
})

// ── notes ────────────────────────────────────────────────
describe('notes schema — 上限', () => {
  it('合法创建通过', () => {
    expect(notesCreateSchema.safeParse({ title: 't', content: 'c', tags: ['a'] }).success).toBe(true)
  })

  it('title 超 200 / content 超 10 万拒绝', () => {
    expect(notesCreateSchema.safeParse({ title: 't'.repeat(201) }).success).toBe(false)
    expect(notesCreateSchema.safeParse({ content: 'c'.repeat(100_001) }).success).toBe(false)
  })

  it('update patch：tags 超 20 拒绝', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`)
    expect(notesUpdatePatchSchema.safeParse({ tags }).success).toBe(false)
  })
})

// ── knowledge ────────────────────────────────────────────
describe('knowledge schema — 上限与 URL 协议', () => {
  it('KB_SAVE 合法通过；chunkSize/topK 超限拒绝', () => {
    expect(kbSaveSchema.safeParse({ name: 'kb', chunkSize: 1000 }).success).toBe(true)
    expect(kbSaveSchema.safeParse({ name: 'kb', chunkSize: 8193 }).success).toBe(false)
    expect(kbSaveSchema.safeParse({ name: 'kb', topK: 101 }).success).toBe(false)
    expect(kbSaveSchema.safeParse({ name: 'kb', embeddingDim: -1 }).success).toBe(false)
  })

  it('DOC_ADD_URL：http(s) 通过，file/ftp 协议拒绝', () => {
    expect(kbDocAddUrlArgsSchema.safeParse(['kb1', 'https://example.com/a']).success).toBe(true)
    expect(kbDocAddUrlArgsSchema.safeParse(['kb1', 'file:///c:/secret.txt']).success).toBe(false)
    expect(kbDocAddUrlArgsSchema.safeParse(['kb1', 'ftp://x/y']).success).toBe(false)
  })

  it('DOC_ADD_URL：url 超 2048 / title 超 500 拒绝', () => {
    expect(
      kbDocAddUrlArgsSchema.safeParse(['kb1', `https://e.com/${'p'.repeat(2048)}`]).success
    ).toBe(false)
    expect(kbDocAddUrlArgsSchema.safeParse(['kb1', 'https://e.com', 't'.repeat(501)]).success).toBe(
      false
    )
  })

  it('DOC_ADD_TEXT：text 超 100 万 / title 超 500 拒绝', () => {
    expect(kbDocAddTextArgsSchema.safeParse(['kb1', 'x'.repeat(1_000_001), 't']).success).toBe(
      false
    )
    expect(kbDocAddTextArgsSchema.safeParse(['kb1', 'ok', 't'.repeat(501)]).success).toBe(false)
  })

  it('RETRIEVE：kbIds 超 20 / query 超 4000 拒绝', () => {
    expect(
      kbRetrieveArgsSchema.safeParse([Array.from({ length: 21 }, (_, i) => `kb${i}`), 'q']).success
    ).toBe(false)
    expect(kbRetrieveArgsSchema.safeParse([['kb1'], 'q'.repeat(4001)]).success).toBe(false)
    expect(kbRetrieveArgsSchema.safeParse([['kb1'], '正常问题']).success).toBe(true)
  })
})

// ── translate / images（计费 API 面） ─────────────────────
describe('translate / images schema — 上限', () => {
  const tReq = {
    requestId: 'r',
    providerId: 'p',
    model: 'm',
    sourceLang: 'auto' as const,
    targetLang: 'en' as const,
    style: 'standard' as const,
    text: '你好',
    glossaryEnabled: false
  }

  it('translate 合法通过；text 超 2 万拒绝', () => {
    expect(translateRequestSchema.safeParse(tReq).success).toBe(true)
    expect(
      translateRequestSchema.safeParse({ ...tReq, text: 'x'.repeat(20_001) }).success
    ).toBe(false)
  })

  it('glossary 术语超 200 拒绝', () => {
    expect(
      glossarySaveSchema.safeParse({ sourceTerm: 's'.repeat(201), targetTerm: 't' }).success
    ).toBe(false)
    expect(glossarySaveSchema.safeParse({ sourceTerm: 'AI', targetTerm: '人工智能' }).success).toBe(
      true
    )
  })

  const iReq = {
    requestId: 'r',
    providerId: 'p',
    model: 'dall-e-3',
    prompt: '一只猫',
    size: '1024x1024' as const
  }

  it('images 合法通过；prompt 超 4000 拒绝', () => {
    expect(imageGenerateSchema.safeParse(iReq).success).toBe(true)
    expect(
      imageGenerateSchema.safeParse({ ...iReq, prompt: 'p'.repeat(4001) }).success
    ).toBe(false)
  })
})

// ── providers ────────────────────────────────────────────
describe('providers schema — 上限', () => {
  const valid = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'openai-compatible' as const,
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeys: ['sk-xxx'],
    models: ['gpt-4o'],
    enabled: true,
    createdAt: 1700000000000
  }

  it('合法 provider 通过', () => {
    expect(providerRecordSchema.safeParse(valid).success).toBe(true)
  })

  it('baseUrl 允许空/内网（不限协议）但超 2048 拒绝', () => {
    expect(providerRecordSchema.safeParse({ ...valid, baseUrl: '' }).success).toBe(true)
    expect(
      providerRecordSchema.safeParse({ ...valid, baseUrl: 'http://192.168.1.1:11434' }).success
    ).toBe(true)
    expect(
      providerRecordSchema.safeParse({ ...valid, baseUrl: `http://e.com/${'p'.repeat(2048)}` })
        .success
    ).toBe(false)
  })

  it('apiKeys 超 50 / 单 key 超 256 拒绝', () => {
    expect(
      providerRecordSchema.safeParse({
        ...valid,
        apiKeys: Array.from({ length: 51 }, (_, i) => `k${i}`)
      }).success
    ).toBe(false)
    expect(providerRecordSchema.safeParse({ ...valid, apiKeys: ['k'.repeat(257)] }).success).toBe(
      false
    )
  })

  it('models 超 500 拒绝', () => {
    expect(
      providerRecordSchema.safeParse({
        ...valid,
        models: Array.from({ length: 501 }, (_, i) => `m${i}`)
      }).success
    ).toBe(false)
  })

  it('通用 idSchema：空拒绝，≤128 通过，超 128 拒绝', () => {
    expect(idSchema.safeParse('').success).toBe(false)
    expect(idSchema.safeParse('x'.repeat(128)).success).toBe(true)
    expect(idSchema.safeParse('x'.repeat(129)).success).toBe(false)
  })
})

// ── agent 配置 ───────────────────────────────────────────
describe('agent schema — 上限', () => {
  it('websearch apiKey 超 256 拒绝', () => {
    expect(
      websearchConfigSchema.safeParse({ enabled: true, apiKey: 'k'.repeat(257) }).success
    ).toBe(false)
    expect(websearchConfigSchema.safeParse({ provider: 'tavily', apiKey: 'tv-1' }).success).toBe(
      true
    )
  })

  it('calendar paths 超 20 个 / 单路径超 1024 拒绝', () => {
    expect(
      calendarConfigSchema.safeParse({
        paths: Array.from({ length: 21 }, (_, i) => `/c/${i}.ics`)
      }).success
    ).toBe(false)
    expect(calendarConfigSchema.safeParse({ paths: ['p'.repeat(1025)] }).success).toBe(false)
  })

  it('approvalId 超 64 拒绝', () => {
    expect(
      toolApproveResponseSchema.safeParse({ approvalId: 'a'.repeat(65), approved: true }).success
    ).toBe(false)
  })
})

// ── sandbox（与服务层 256KB/60/200 对齐） ─────────────────
describe('sandbox schema — 与服务层对齐', () => {
  it('合法创建通过', () => {
    expect(sandboxCreateSchema.safeParse({ name: 'demo', html: '<html></html>' }).success).toBe(
      true
    )
  })

  // §326：界面那句 placeholder 写的是「名称（可留空）」，主进程 cleanName 也确实兜着默认名「未命名」，
  // 而改前 schema 与 service 各有一道 min(1) ⇒ 留空点保存必失败。这里钉住"空名要放行"，
  // 上限仍由输入框的 maxLength 与服务层截断各守一道（数字出处见 SANDBOX_MAX_NAME_CHARS）。
  it('name 留空通过（「可留空」是真话；上限那条由下一个用例继续守着）', () => {
    expect(sandboxCreateSchema.safeParse({ name: '', html: '<html></html>' }).success).toBe(true)
  })

  it('name 超 60 / html 超 256K 字符拒绝', () => {
    expect(sandboxCreateSchema.safeParse({ name: 'n'.repeat(61), html: 'x' }).success).toBe(false)
    expect(
      sandboxCreateSchema.safeParse({ name: 'ok', html: 'h'.repeat(256 * 1024 + 1) }).success
    ).toBe(false)
  })

  it('update meta：description 超 200 拒绝', () => {
    expect(
      sandboxUpdateMetaSchema.safeParse({ id: 's1', patch: { description: 'd'.repeat(201) } })
        .success
    ).toBe(false)
  })
})

// ── channels / preferences / encryption / license ────────
describe('channels/preferences/encryption/license — 上限', () => {
  it('channel whitelist 超 2000 / secret 超 512 拒绝', () => {
    expect(channelSetConfigSchema.safeParse({ whitelist: 'w'.repeat(2001) }).success).toBe(false)
    expect(channelSetConfigSchema.safeParse({ primarySecret: 's'.repeat(513) }).success).toBe(false)
    expect(
      channelSetConfigSchema.safeParse({ enabled: true, whitelist: '123,456' }).success
    ).toBe(true)
  })

  it('customCss 走服务层 200KB 截断兜底（schema 不设 max，保持截断语义）', () => {
    // 服务层 setUiPreferences 对超长 CSS 截断而非拒绝（既有设计），schema 不重复设限
    expect(uiPrefsPatchSchema.safeParse({ customCss: 'c'.repeat(50_001) }).success).toBe(true)
    expect(uiPrefsPatchSchema.safeParse({ opacity: 0.8, customCss: 'body{}' }).success).toBe(true)
  })

  it('校验档 <6 / 新设档 <10 / >128 拒绝；恢复码 >64 拒绝', () => {
    expect(masterPasswordSchema.safeParse('12345').success).toBe(false)
    expect(masterPasswordSchema.safeParse('p'.repeat(129)).success).toBe(false)
    expect(masterPasswordSchema.safeParse('my-secret-pw').success).toBe(true)
    expect(recoveryCodeSchema.safeParse('r'.repeat(65)).success).toBe(false)
    // 恢复码重置产生的是新密码，走新设档（SEC-32①：下限 10，校验档仍是 6）
    expect(recoverPayloadSchema.safeParse({ code: 'ABCD-1234', newPassword: 'new-pw-6' }).success).toBe(false)
    expect(
      recoverPayloadSchema.safeParse({ code: 'ABCD-1234', newPassword: 'new-pw-1234' }).success
    ).toBe(true)
  })

  it('licenseCode 超 4096 / filePath 超 1024 拒绝', () => {
    expect(licenseCodeSchema.safeParse('L'.repeat(4097)).success).toBe(false)
    expect(filePathSchema.safeParse('/'.repeat(1025)).success).toBe(false)
  })
})

describe('侧栏导航 schema（顺序 / 固定）', () => {
  // 这条是本轮的"反向对照"：这里曾手写 11 项枚举、漏掉 12 个模块里的 'terminal'，
  // 于是**任何**合法顺序都被拒 ⇒ setSidebarOrder 永远失败并被前端回滚，侧栏拖拽排序从未生效。
  it('默认顺序必须自通过（枚举与常量清单不许漂移）', () => {
    expect(DEFAULT_SIDEBAR_ORDER).toHaveLength(12)
    expect(sidebarOrderSchema.safeParse(DEFAULT_SIDEBAR_ORDER).success).toBe(true)
    const reversed = [...DEFAULT_SIDEBAR_ORDER].reverse()
    expect(sidebarOrderSchema.safeParse(reversed).success).toBe(true)
  })

  it('缺项 / 重复 / 含未知模块 → 拒', () => {
    expect(sidebarOrderSchema.safeParse(DEFAULT_SIDEBAR_ORDER.slice(1)).success).toBe(false)
    const dup = DEFAULT_SIDEBAR_ORDER.map((m, i) => (i === 0 ? DEFAULT_SIDEBAR_ORDER[1]! : m))
    expect(sidebarOrderSchema.safeParse(dup).success).toBe(false)
    expect(
      sidebarOrderSchema.safeParse([...DEFAULT_SIDEBAR_ORDER.slice(1), 'nope']).success
    ).toBe(false)
  })

  it('固定列表：子集通过，重复/未知/超上限拒', () => {
    expect(sidebarPinnedSchema.safeParse(['chat', 'settings']).success).toBe(true)
    expect(sidebarPinnedSchema.safeParse([]).success).toBe(true)
    expect(sidebarPinnedSchema.safeParse(['chat', 'chat']).success).toBe(false)
    expect(sidebarPinnedSchema.safeParse(['nope']).success).toBe(false)
    expect(sidebarPinnedSchema.safeParse(DEFAULT_SIDEBAR_ORDER).success).toBe(false)
    expect(
      sidebarPinnedSchema.safeParse(DEFAULT_SIDEBAR_ORDER.slice(0, MAX_PINNED_SIDEBAR_MODULES + 1)).success
    ).toBe(false)
  })
})

describe('AGENT_SET_TEXT_PROTOCOL 入参（模型级文本协议开关）', () => {
  it('正常开关请求通过', () => {
    expect(textProtocolToggleSchema.safeParse({ providerId: 'p1', model: 'qwen2.5:3b', on: true }).success).toBe(true)
    expect(textProtocolToggleSchema.safeParse({ providerId: 'p1', model: 'm', on: false }).success).toBe(true)
  })

  it('空 providerId/model 或缺 on 一律拒（不允许"关掉一个不存在的模型"这种半截请求）', () => {
    expect(textProtocolToggleSchema.safeParse({ providerId: '', model: 'm', on: true }).success).toBe(false)
    expect(textProtocolToggleSchema.safeParse({ providerId: 'p1', model: '', on: true }).success).toBe(false)
    expect(textProtocolToggleSchema.safeParse({ providerId: 'p1', model: 'm' }).success).toBe(false)
    expect(textProtocolToggleSchema.safeParse({ providerId: 'p1', model: 'm', on: 'yes' }).success).toBe(false)
  })

  it('超长 id/model 拒（providerId 64、model 128；与存储层的片段上限一致）', () => {
    expect(textProtocolToggleSchema.safeParse({ providerId: 'p'.repeat(65), model: 'm', on: true }).success).toBe(false)
    expect(textProtocolToggleSchema.safeParse({ providerId: 'p1', model: 'm'.repeat(129), on: true }).success).toBe(false)
    expect(textProtocolToggleSchema.safeParse({ providerId: 'p1', model: 'm'.repeat(128), on: true }).success).toBe(true)
  })
})
