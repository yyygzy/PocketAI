// @vitest-environment jsdom
// V4-Iter-229：把真抛错换成一个"看起来正常的默认值"那三处的口径。
//
// §224 记下这一族时只量不判（`.catch` 面的第三档 other-value，3 处）。这三处的共同形状是：
// 失败被换成一个**恰好也是合法值**的东西（null / []），于是界面分不清"没有"与"没读到"。
// 三处的口径各不相同，因为它们的界面脸不同：
// ① `KbDetail` 的轮询：停下是对的（继续轮只会每 2s 再失败一次），但停下得说——
//    屏上留着旧状态，用户看到的是"文档还在解析中"，而我们已经不晓得了。⇒ 新键 `common.refreshFailed`。
// ② `StewardModule` 导出报告：原本 `.catch(() => null)` 连痕都没有，报告里那行退化成 `-`——
//    一份拿去远程求助的纯文本说"版本未知"却不说是为什么未知；两个兄弟各自都有留痕。⇒ 那句写进报告本身。
// ③ `FirstRunWizard`：这一步读不到就跳过是**对的**（模型与助手已经存好了，不该为"顺手"打断首启），
//    但完成页那句 ✓「自动启用前 3 个」原本是**无条件渲染**的 ⇒ 它在替用户撒谎。⇒ 那一行按这一步的真实结果说。
// 另：闸门（`ipc-await-shape-217` ⑦）把这一档从"只量"升成 ratchet——other-value 必须为 0。
//
// 轮询那一组用的是**真时钟**（2s 一拍），所以每条给到 15s；假时钟会让 waitFor 自己也停住（第一版就栽在这里）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { StewardModule } from '../src/renderer/src/modules/steward/StewardModule'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase, KbDocument } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const REFRESH_FAILED = (msg: string): string => L('common.refreshFailed').replace('{msg}', msg)
const LOAD_FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let warns: string[] = []
beforeEach(() => {
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
})
afterEach(() => vi.restoreAllMocks())
const traces = (): string[] => warns.filter((w) => w.startsWith('[ipc] '))

// ───────── ① 知识库轮询 ─────────

const kb = { id: 'kbA', name: '库甲', documentCount: 1 } as unknown as KnowledgeBase
const readyDoc = {
  id: 'd1', kbId: 'kbA', source: 'a.md', sourceType: 'txt', title: '文档 d1',
  chunkCount: 2, status: 'ready', error: null, contentHash: null, enabled: true, createdAt: 1
} as unknown as KbDocument

/**
 * 装桩并挂载，`listKbDocuments` 按第几次调用给值（1＝挂载那一读，2＝点「重建」后的 refresh，3＝轮询那一拍）。
 * 返回调用计数，用于证"停下"这件事。
 */
function mountKb(listForCall: (n: number) => unknown): { calls: () => number } {
  const state = { n: 0 }
  stubPocketai({
    listKbDocuments: () => {
      state.n += 1
      return listForCall(state.n)
    },
    reindexKbDocument: () => ({ ok: true }),
    deleteKbDocument: () => ({ ok: true }),
    setKbDocEnabled: () => ({ ok: true }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    addKbFiles: () => ({ docs: [], skippedSameSource: 0, skippedSameContent: 0 }),
    listProviders: () => [],
    listKbAskSessions: () => [],
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    reportPerf: () => undefined
  })
  mountWithProviders(<KbDetail kb={kb} onChanged={() => {}} />)
  return { calls: () => state.n }
}

describe('① 知识库轮询读不到：停轮询是对的，但必须说出来', () => {
  it('resolve 的 {ok:false} ⇒「刷新失败：库被占用（界面停在上一份）」，之后不再轮（第 3 拍之后就停）', async () => {
    const c = mountKb((n) => (n <= 2 ? [readyDoc] : { ok: false, error: '库被占用' }))
    fireEvent.click(await screen.findByText(L('kb.reindex')))
    await waitFor(() => expect(toasts()).toContain(REFRESH_FAILED('库被占用')), { timeout: 6000 })
    const at = c.calls()
    await nap(2600)
    expect(c.calls(), '停下之后再等一拍，调用数不许再涨').toBe(at)
  }, 15_000)

  it('真抛错 ⇒ 同一句（原因换成抛出来的原文）并留下一条 [ipc] 痕（原来是 .catch(() => null)，无声）', async () => {
    const c = mountKb((n) => (n <= 2 ? [readyDoc] : Promise.reject(new Error('通道没接上'))))
    fireEvent.click(await screen.findByText(L('kb.reindex')))
    await waitFor(() => expect(toasts()).toContain(REFRESH_FAILED('通道没接上')), { timeout: 6000 })
    expect(traces()).toContain('[ipc] kb.pollDocuments 失败: 通道没接上')
    expect(c.calls()).toBeGreaterThanOrEqual(3)
  }, 15_000)

  it('反向对照：读到的那批里没有还在处理的文档 ⇒ 正常收尾，那句不许冒', async () => {
    mountKb(() => [readyDoc])
    fireEvent.click(await screen.findByText(L('kb.reindex')))
    await nap(2600)
    expect(toasts().join('|'), '正常收尾不该出现那句"刷新失败"').not.toContain(L('common.refreshFailed'))
  }, 15_000)
})

// ───────── ② 导出诊断报告的版本行 ─────────

describe('② 导出报告：没读到的版本号要写「读不到：原因」，不是一个 `-`', () => {
  const stubs = (over: Record<string, unknown>): void => {
    stubPocketai({
      getHardwareInfo: () => ({
        os: { platform: 'win32', release: '10.0' },
        cpu: { model: 'X', cores: 8 },
        memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
        gpus: [],
        disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
      }),
      checkIntegrity: () => ({ ok: true, details: '' }),
      getHealthReport: () => ({ totalBytes: 0, sections: [], items: [], byCategory: [] }),
      recommendModels: () => ({ ok: false }),
      listProviders: () => [],
      runAudit: () => ({ ok: true, data: { score: 80, checks: [] } }),
      runDiagnose: () => ({ ok: true, data: { items: [] } }),
      getUpdateInfo: () => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: false }),
      exportStewardReport: () => ({ ok: true, canceled: false, path: '/tmp/r.txt' }),
      onOllamaPullEvent: () => () => {},
      onOllamaInstallEvent: () => () => {},
      getOllamaStatus: () => ({ installed: false, running: false, models: [], version: '' }),
      getOllamaMirror: () => ({ mirror: '' }),
      ...over
    })
  }
  const exportReport = async (): Promise<string> => {
    fireEvent.click(await screen.findByText(L('steward.exportReport')))
    await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'exportStewardReport')).toBe(true), { timeout: 6000 })
    return String(pocketaiCalls().find((c) => c.fn === 'exportStewardReport')?.args[0] ?? '')
  }

  it('版本那一发真抛错 ⇒ 报告里那句「读不到：通道没接上」，并留下一条痕', async () => {
    stubs({ getUpdateInfo: () => Promise.reject(new Error('通道没接上')) })
    mountWithProviders(<StewardModule />)
    const text = await exportReport()
    expect(text).toContain(L('steward.reportVersion'))
    expect(text).toContain(LOAD_FAILED('通道没接上'))
    expect(traces()).toContain('[ipc] steward.export.updateInfo 失败: 通道没接上')
  }, 15_000)

  it('resolve 的 {ok:false} ⇒ 同样那句，原因是它自己带的那句', async () => {
    stubs({ getUpdateInfo: () => ({ ok: false, error: '更新源不可达' }) })
    mountWithProviders(<StewardModule />)
    expect(await exportReport()).toContain(LOAD_FAILED('更新源不可达'))
  }, 15_000)

  it('反向对照：读到版本 ⇒ 那一行就是版本号，那句不在场', async () => {
    stubs({})
    mountWithProviders(<StewardModule />)
    const text = await exportReport()
    expect(text).toContain('0.9.9')
    expect(text).not.toContain(L('common.loadFailed'))
  }, 15_000)
})

// ───────── ③ 首启向导完成页那一行 ─────────

const wizardHardware = {
  os: { platform: 'win32', release: '10.0' },
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}
const ollamaProvider = {
  id: 'p-ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1',
  apiKeys: [], models: ['m-a'], enabled: true, createdAt: 1
}
const builtinSkill = { id: 's1', name: '内置一', isBuiltin: true, enabled: false }

function mountWizard(over: Record<string, unknown>): void {
  stubPocketai({
    getHardwareInfo: () => wizardHardware,
    getEncryptionStatus: () => ({ mode: 'none', unlocked: true, dbEncrypted: false, fieldEncrypted: true, masterPasswordVerified: true, kdfN: null, kdfAtCurrentTier: true }),
    recommendModels: () => ({ ok: false }),
    listProviders: () => [ollamaProvider],
    listAssistants: () => [{ id: 'a-builtin', name: '内置助手', isBuiltin: true, toolPermissions: [], defaultProviderId: null }],
    duplicateAssistant: () => ({ id: 'a-copy', name: '内置助手', isBuiltin: false, toolPermissions: [], defaultProviderId: null }),
    saveAssistant: () => ({ ok: true }),
    listSkills: () => [],
    saveSkill: () => ({ ok: true }),
    completeWizard: () => ({ ok: true }),
    setLastProvider: () => ({ ok: true }),
    setAssistantPinned: () => ({ ok: true }),
    onOllamaPullEvent: () => () => {},
    onOllamaInstallEvent: () => () => {},
    getOllamaStatus: () => ({ installed: false, running: false, models: [], version: '' }),
    getOllamaMirror: () => ({ mirror: '' }),
    probeDelegateCapability: () => ({ entry: { capability: 'unknown' }, error: null }),
    ...over
  })
  mountWithProviders(<FirstRunWizard variant="full" onClose={() => {}} />)
}

/** 一路点到完成页（step 3） */
async function toDone(over: Record<string, unknown> = {}): Promise<void> {
  mountWizard(over)
  const next = (): void => { fireEvent.click(screen.getByText('下一步')) }
  next()
  next()
  fireEvent.click(await screen.findByText(/^Ollama$/))
  next()
  await screen.findByText(/一切就绪/)
}

describe('③ 完成页那一行按这一步的真实结果说，不再无条件 ✓', () => {
  it('读到内置技能 ⇒ ✓「自动启用前 3 个」在，且真去启用了它', async () => {
    await toDone({ listSkills: () => [builtinSkill] })
    expect(screen.queryByText(/自动启用前 3 个/)).not.toBeNull()
    expect(pocketaiCalls().some((c) => c.fn === 'saveSkill'), '读到了就该真去启用').toBe(true)
  })

  it('resolve 的 {ok:false} ⇒ 那一行说「读不到：技能库被占用」，✓ 那句不许留着', async () => {
    await toDone({ listSkills: () => ({ ok: false, error: '技能库被占用' }) })
    expect(screen.queryByText(LOAD_FAILED('技能库被占用'))).not.toBeNull()
    expect(screen.queryByText(/自动启用前 3 个/), '读不到时那句 ✓ 就是撒谎').toBeNull()
  })

  it('真抛错 ⇒ 同一格换成那句原文，并留下一条痕（原来是 .catch(() => [])）', async () => {
    await toDone({ listSkills: () => Promise.reject(new Error('通道没接上')) })
    expect(screen.queryByText(LOAD_FAILED('通道没接上'))).not.toBeNull()
    expect(screen.queryByText(/自动启用前 3 个/)).toBeNull()
    expect(traces()).toContain('[ipc] wizard.listSkills 失败: 通道没接上')
  })

  it('读到了、但一个内置技能都没有 ⇒ 既不 ✓ 也不报警，那一行整条不显示', async () => {
    await toDone({ listSkills: () => [] })
    expect(screen.queryByText(/自动启用前 3 个/)).toBeNull()
    expect(screen.queryByText(LOAD_FAILED('未知错误'))).toBeNull()
    expect(screen.queryByText(L('wizard.summarySkills') + ':')).toBeNull()
  })
})

describe('④ 接线（源码断言）：三处都不许再回落到"看起来正常的默认值"', () => {
  const KNOWLEDGE = 'src/renderer/src/modules/knowledge/KnowledgeModule.tsx'
  const STEWARD = 'src/renderer/src/modules/steward/StewardModule.tsx'
  const WIZARD = 'src/renderer/src/modules/wizard/FirstRunWizard.tsx'
  /** 注释里写着"原本是 .catch(() => null)"是要交代历史，扫描前先把行注释剥掉（否则自己抓自己） */
  const codeOf = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8')
      .split(String.fromCharCode(10))
      .filter((line) => !line.trim().startsWith('//'))
      .join(String.fromCharCode(10))

  it('三处都不再有 `.catch(() => null)`／`.catch(() => [])` 这种"合法值当兜底"', () => {
    for (const rel of [KNOWLEDGE, STEWARD, WIZARD]) {
      const code = codeOf(rel)
      expect(code, rel + ' 还有 .catch(() => null)').not.toContain('.catch(() => null)')
      expect(code, rel + ' 还有 .catch(() => [])').not.toContain('.catch(() => [])')
    }
  })

  it('每一处都既有脸、也有痕：轮询走 toast、报告把原因写进文本、向导那一行按结果说', () => {
    expect(codeOf(KNOWLEDGE)).toContain("t('common.refreshFailed', { msg })")
    expect(codeOf(STEWARD)).toContain("t('common.loadFailed', {")
    expect(codeOf(WIZARD)).toContain("skillOutcome?.state === 'failed'")
  })
})
