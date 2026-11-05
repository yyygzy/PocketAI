// @vitest-environment jsdom
// V4-Iter-412（P0-1 第一枚）：首启向导把内置技能**绑到助手**那一发
//
// 现场（改前）：向导那一步只写 `skills.enabled`（`saveSkill({...sk, enabled:true})`），
// 而运行期取技能走的是 `buildSkillsContext(assistant.skillIds)` → `skillRepo.listEnabledByIds`——
// 八个内置助手的 `skillIds` 全是 `[]`（`extensions/assistants/*.json`）。
// 于是完成页那句 ✓「自动启用前 3 个」是真的，用户开聊却发现技能一个字都没进提示词：**装完不等于用上**。
//
// 本批改三件，各配判据：
//  ① 把这次确实开着的那几条并进取号助手的 `skillIds`（单独一发 `saveAssistant`，
//     不能借上面那发"只在助手没配 provider 时才发"的条件，否则第二次跑向导的人什么都没绑）；
//  ② 完成页把「启用」与「绑到这位助手」分成两行说，绑失败要说原因、不许留着 ✓；
//  ③ 这一发是全列覆盖（`assistant.repo.save()` 的 UPDATE 写全部列），所以载荷必须拿**刚写回的那条记录**：
//     拿绑 provider 之前的快照会把 provider 抹掉，拿 pin 之前的快照里的 `isPinned:false` 会把 pin 抹掉。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const hardware = {
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}
const builtinAssistant = {
  id: 'a-builtin', name: '内置助手', description: '', avatar: '🤖',
  isBuiltin: true, toolPermissions: [], skillIds: [], defaultProviderId: null, isPinned: false
}
/** `duplicateAssistant` 的载荷形状：副本没 provider、没 pin、没技能 */
const copiedAssistant = { ...builtinAssistant, id: 'a-copy', isBuiltin: false }
const ollama = {
  id: 'p-ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1',
  apiKeys: [], models: ['m-a', 'm-b'], enabled: true, createdAt: 1
}
const skill = (id: string, enabled: boolean) => ({ id, name: id, isBuiltin: true, enabled })

/** 只测技能绑定这一支，探针那条给"能测"的成功载荷 */
const probeOk = (providerId: string, model: string) => ({
  entry: {
    key: `${providerId}::${model}`, providerId, model, capability: 'native_tools_ok',
    samples: 3, nativeHits: 3, digest: '', checkedAt: 1
  },
  error: null
})

/**
 * `saveAssistant` 的回声桩：把收到的载荷记下来并原样并回记录里（主进程 `repo.save` 就是这么全列写的）。
 * 记载荷是为了断"第二发写进去的 provider / isPinned / skillIds 各是什么"，光看屏上的句子看不出来。
 * 用例想换失败载荷时只换**返回值**——记账这层由这里包着，换了载荷也照样数得出发了几发。
 */
function mount(over: Record<string, unknown> = {}, onClose: () => void = () => {}) {
  const saved: Array<Record<string, unknown>> = []
  const userSave = over.saveAssistant as ((rec: Record<string, unknown>) => unknown) | undefined
  const recordSave = (rec: Record<string, unknown>): unknown => {
    saved.push(rec)
    return userSave ? userSave(rec) : { ...copiedAssistant, ...rec }
  }
  stubPocketai({
    getHardwareInfo: () => ({ ok: true, data: hardware }),
    getEncryptionStatus: () => ({
      mode: 'none', unlocked: true, dbEncrypted: false, fieldEncrypted: true,
      masterPasswordVerified: false, kdfN: null, kdfAtCurrentTier: false
    }),
    recommendModels: () => ({ ok: false }),
    listProviders: () => [ollama],
    listAssistants: () => [builtinAssistant],
    listSkills: () => [],
    completeWizard: () => ({ ok: true }),
    saveProvider: () => ollama,
    setLastProvider: () => ({ ok: true }),
    duplicateAssistant: () => copiedAssistant,
    setAssistantPinned: () => ({ ok: true }),
    saveSkill: (rec: { id: string }) => skill(rec.id, true),
    enableEncryption: () => ({ ok: true }),
    probeDelegateCapability: (p: string, m: string) => probeOk(p, m),
    onOllamaPullEvent: () => () => {},
    onOllamaInstallEvent: () => () => {},
    getOllamaStatus: () => ({ ok: true, installed: false, liveness: 'down', models: [], version: '' }),
    getOllamaMirror: () => ({ ok: true, mirror: '' }),
    setOllamaMirror: () => ({ ok: true }),
    startOllama: () => ({ ok: true }),
    stopOllama: () => ({ ok: true }),
    ...over,
    saveAssistant: recordSave
  })
  return { view: mountWithProviders(<FirstRunWizard variant="full" onClose={onClose} />), saved }
}

/** 从首启一路点到完成页（本地 Ollama 那条预设：不要 Key、也不要主密码 ⇒ 写链最短） */
async function walk(
  over: Record<string, unknown> = {},
  onClose: () => void = () => {}
): Promise<{ container: HTMLElement; saved: Array<Record<string, unknown>> }> {
  const { view, saved } = mount(over, onClose)
  fireEvent.click(screen.getByText('下一步'))
  fireEvent.click(screen.getByText('下一步'))
  fireEvent.click(await screen.findByText(/^Ollama$/))
  fireEvent.click(screen.getByText('下一步'))
  await screen.findByText(/一切就绪/, {}, MOUNT_BUDGET)
  return { container: view.container, saved }
}

/** 完成页那一行（`data-wizard-skill-bind-row`）；0 行／多行都直接判失败，别让"没画"混进"画错" */
const bindRow = (container: HTMLElement): Element | null => {
  const rows = container.querySelectorAll('[data-wizard-skill-bind-row]')
  expect(rows.length, '绑定那一行要么不出现、要么只有一条').toBeLessThanOrEqual(1)
  return rows[0] ?? null
}

describe('412 向导：启用的那几条要真写进取号助手的 skillIds', () => {
  it('三条内置技能都开着 ⇒ 补一发 saveAssistant，载荷带这三条 id，完成页画「已自动绑定」', async () => {
    const { container, saved } = await walk({
      listSkills: () => [skill('s1', false), skill('s2', false), skill('s3', false)]
    })
    expect(saved.length, '绑 provider 一发 ＋ 绑技能一发').toBe(2)
    expect(saved[1]!.skillIds).toEqual(['s1', 's2', 's3'])
    const row = bindRow(container)
    expect(row, '启用≠用上，完成页要单独说绑没绑').toBeTruthy()
    expect(row!.textContent).toContain(L('wizard.summarySkillsBound'))
    expect(row!.textContent).not.toContain('失败')
  })

  it('第二发不许抹掉第一发的成果：provider 拿刚写回的那条、isPinned 留空回落到库里（pin 是上一步做的）', async () => {
    const { saved } = await walk({
      listSkills: () => [skill('s1', false), skill('s2', false), skill('s3', false)]
    })
    // 第一发只把 provider 补上，技能还是副本自带的那份空表；带 id 的是第二发
    expect(saved[0]!.skillIds, '绑 provider 那一发不该顺手改技能').toEqual([])
    // `repo.save()` 是全列 UPDATE：载荷里出现 null / false 就是真的往库里写 null / false
    expect(saved[1]!.defaultProviderId, '拿绑 provider 之前的快照回写会把刚绑上的那台清空').toBe('p-ollama')
    expect(saved[1]!.isPinned, '把 pin 之前的 false 原样写回＝绑个技能顺手取消固定').toBeUndefined()
  })

  it('部分启用失败 ⇒ 只绑"现在确实开着"的那几条，不许把没写成的那条也说成绑上了', async () => {
    const { saved, container } = await walk({
      // s1 本来就开着（不发写）、s2 那发被拒、s3 写成 ⇒ 能绑的只有 s1 与 s3
      listSkills: () => [skill('s1', true), skill('s2', false), skill('s3', false)],
      saveSkill: (rec: { id: string }) =>
        rec.id === 's2' ? { ok: false, error: '技能目录只读' } : skill(rec.id, true)
    })
    expect(saved[1]!.skillIds).toEqual(['s1', 's3'])
    expect(bindRow(container)!.textContent).toContain(L('wizard.summarySkillsBound'))
  })

  it('早已绑过这三条 ⇒ 说「早已绑定」，且不再白发那一发（全列覆盖不该重做一次）', async () => {
    const { saved, container } = await walk({
      listSkills: () => [skill('s1', true), skill('s2', true), skill('s3', true)],
      duplicateAssistant: () => ({ ...copiedAssistant, skillIds: ['s1', 's2', 's3'] })
    })
    expect(saved.length, '并集没长大就不该再写一遍库').toBe(1)
    expect(bindRow(container)!.textContent).toContain(L('wizard.summarySkillsBoundAlready'))
  })

  it('绑那一发回 {ok:false} ⇒ 那一行换成失败句，但不许把已经做成的「启用」✓ 一起收回', async () => {
    let n = 0
    const { container } = await walk({
      listSkills: () => [skill('s1', false), skill('s2', false), skill('s3', false)],
      saveAssistant: (rec: Record<string, unknown>) => {
        n += 1
        return n === 1 ? { ...copiedAssistant, ...rec } : { ok: false, error: '助手记录已被删除' }
      }
    })
    const row = bindRow(container)
    expect(row!.textContent).toContain('助手记录已被删除')
    expect(row!.textContent).toContain(L('wizard.summarySkills'))
    expect(row!.textContent, '失败的那一行自己说失败，别把 ✓ 留在同一行').not.toContain(
      L('wizard.summarySkillsBound')
    )
    // 上一行（启用那一发确实做成了）不受影响
    expect(container.querySelector('[data-wizard-skill-row]')!.textContent).toContain(
      L('wizard.summarySkillsAuto')
    )
  })

  it('一条内置技能都没有 ⇒ 绑定那一行整条不出现（没东西可绑就不许说"绑好了"）', async () => {
    const { saved, container } = await walk({ listSkills: () => [] })
    expect(saved.length, '技能那一步没跑，就不该多发一发全列覆盖').toBe(1)
    expect(bindRow(container)).toBeNull()
  })

  it('反向对照：技能那一步读不到 ⇒ 没有绑定行，也不会拿空表去写库', async () => {
    const { saved, container } = await walk({ listSkills: () => ({ ok: false, error: 'IO:读不到技能目录' }) })
    expect(saved.length).toBe(1)
    expect(bindRow(container)).toBeNull()
    expect(container.querySelector('[data-wizard-skill-row]')!.textContent).toContain('IO:读不到技能目录')
  })
})

describe('412 向导：那一发不打断首启（技能没绑上 ≠ 首启失败）', () => {
  it('绑失败照样走到完成页，「开始使用」那颗键照常关窗（改前那一步压根没发这一发）', async () => {
    const closed = vi.fn()
    const { container, saved } = await walk(
      {
        listSkills: () => [skill('s1', false), skill('s2', false), skill('s3', false)],
        // 认"载荷里带着技能 id 的那一发"＝绑技能那一发；第一发（绑 provider）的 skillIds 是副本自带的空表
        saveAssistant: (rec: Record<string, unknown>) =>
          Array.isArray(rec.skillIds) && rec.skillIds.length > 0
            ? { ok: false, error: '库里那条助手已经不在' }
            : { ...copiedAssistant, ...rec }
      },
      closed
    )
    expect(saved.length, '两发都发出去了，第二发才是绑技能').toBe(2)
    expect(bindRow(container)!.textContent).toContain('库里那条助手已经不在')
    fireEvent.click(screen.getByText('开始使用'))
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1), MOUNT_BUDGET)
  })
})
