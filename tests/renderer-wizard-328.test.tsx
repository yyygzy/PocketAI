// @vitest-environment jsdom
// V4-Iter-328 首启向导那一屏的四张脸
//
// 1) 三发写在不判信封（`saveAssistant` 绑 provider ／ `setAssistantPinned` ／ 循环里的 `saveSkill`）：
//    `safeHandle` 把主进程抛错与 zod 拒绝转成 **resolve 的 `{ok:false}`**，改前外面那层 try/catch 是死支路，
//    向导照样前进、完成页照画 ✓ ⇒ 「说了没做」。
// 2) 探针判定缺归属：`probeOut` 改前不认"测的是哪一台"，换 select 后旧结论跟着新模型走。
// 3) `finish()` 改前连返回值都不看 ⇒ 没记住"向导已完成"也静默关窗，下次开机整趟重走。
// 每条都配反向对照（成功那条路不能被一起砍掉）。
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'
import { zh } from '../src/renderer/src/i18n/zh'

const hardware = {
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}
const builtinAssistant = {
  id: 'a-builtin', name: '内置助手', description: '', avatar: '🤖',
  isBuiltin: true, toolPermissions: [], defaultProviderId: null
}
const copiedAssistant = { ...builtinAssistant, id: 'a-copy', isBuiltin: false, defaultProviderId: null }
const ollama = {
  id: 'p-ollama',
  type: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKeys: [],
  models: ['m-a', 'm-b'],
  enabled: true,
  createdAt: 1
}
const skill = (id: string, enabled: boolean) => ({ id, name: id, isBuiltin: true, enabled })

/** 探针载荷照真实形状给（`DelegateProbeResult`：entry 带 providerId 与 model，界面按它判归属） */
const probeOk = (providerId: string, model: string, capability = 'native_tools_ok') => ({
  entry: {
    key: `${providerId}::${model}`, providerId, model, capability,
    samples: 3, nativeHits: 3, digest: '', checkedAt: 1
  },
  error: null
})

function mount(over: Record<string, unknown> = {}, onClose = () => {}) {
  stubPocketai({
    getHardwareInfo: () => ({ ok: true, data: hardware }),
    getEncryptionStatus: () => ({
      mode: 'none', unlocked: true, dbEncrypted: false, fieldEncrypted: false,
      masterPasswordVerified: true, kdfN: null, kdfAtCurrentTier: true
    }),
    recommendModels: () => ({ ok: false }),
    listProviders: () => [ollama],
    listAssistants: () => [builtinAssistant],
    listSkills: () => [],
    completeWizard: () => ({ ok: true }),
    saveProvider: () => ollama,
    setLastProvider: () => ({ ok: true }),
    duplicateAssistant: () => copiedAssistant,
    saveAssistant: () => copiedAssistant,
    setAssistantPinned: () => ({ ok: true }),
    saveSkill: (rec: { id: string }) => skill(rec.id, true),
    enableEncryption: () => ({ ok: true }),
    probeDelegateCapability: (p: string, m: string) => probeOk(p, m),
    onOllamaPullEvent: () => () => {},
    onOllamaInstallEvent: () => () => {},
    getOllamaStatus: () => ({ ok: true, installed: false, running: false, models: [], version: '' }),
    getOllamaMirror: () => ({ ok: true, mirror: '' }),
    setOllamaMirror: () => ({ ok: true }),
    startOllama: () => ({ ok: true }),
    stopOllama: () => ({ ok: true }),
    ...over
  })
  return mountWithProviders(<FirstRunWizard variant="full" onClose={onClose} />)
}

const next = () => fireEvent.click(screen.getByText('下一步'))

/**
 * 从首启一路点到完成页（本地 Ollama 那条预设：不要 Key、也不要主密码 ⇒ 写链最短）。
 * 返回 render 结果好查 data 属性；`onClose` 用来判"该不该关窗"。
 */
async function walk(over: Record<string, unknown> = {}, onClose = () => {}) {
  const view = mount(over, onClose)
  next()
  next()
  fireEvent.click(await screen.findByText(/^Ollama$/))
  next()
  await screen.findByText(/一切就绪/)
  return view
}

describe('328 向导：三发写在不判信封', () => {
  /**
   * 那两发写在不判信封时该长的样子：走到配置步点「下一步」⇒ 说出原因、不前进、不关窗。
   * 不复用 `walk`（那一条要等完成页，而这一支正是"不该到完成页"）。
   */
  async function stopAtSetup(over: Record<string, unknown>, text: string) {
    const closed = vi.fn()
    const view = mount(over, closed)
    next()
    next()
    fireEvent.click(await screen.findByText(/^Ollama$/))
    next()
    expect(await screen.findByText(new RegExp(text))).toBeTruthy()
    expect(screen.queryByText(/一切就绪/), '写没做成就不该画完成页那几行 ✓').toBeNull()
    expect(closed).not.toHaveBeenCalled()
    return view
  }

  it('绑定 provider 那一发失败 ⇒ 不画完成页，且不再往下发 pin', async () => {
    await stopAtSetup(
      { saveAssistant: () => ({ ok: false, error: 'License：免费版助手数已满' }) },
      '免费版助手数已满'
    )
    expect(calledFns(), '助手都没绑好，pin 与技能两步都建立在它之上').not.toContain('setAssistantPinned')
  })

  it('pin 那一发失败同样停在配置步（它的成功载荷就是 {ok:true} ⇒ 判据必须是 hasIpcFailed）', async () => {
    await stopAtSetup(
      { setAssistantPinned: () => ({ ok: false, error: '库里那条助手已经不在' }) },
      '库里那条助手已经不在'
    )
    expect(calledFns(), 'pin 没做成就不该再去动技能').not.toContain('saveSkill')
  })

  it('反向对照：那两发都成功 ⇒ 完成页照常出现、pin 与探针那格都在', async () => {
    const closed = vi.fn()
    await walk({}, closed)
    expect(calledFns()).toContain('setAssistantPinned')
    expect(screen.getByText(/顺手测一下/)).toBeTruthy()
    expect(closed).not.toHaveBeenCalled()
  })

  it('技能启用部分失败 ⇒ 那一格报"现在开着几 / 一共几"，不再留着 ✓「自动启用前 3 个」', async () => {
    const { container } = await walk({
      // 三条里 s1 本来就开着（不发写）、s2 那发被拒、s3 写成 ⇒ 诚实的数是 2/3
      listSkills: () => [skill('s1', true), skill('s2', false), skill('s3', false)],
      saveSkill: (rec: { id: string }) =>
        rec.id === 's2' ? { ok: false, error: '技能目录只读' } : skill(rec.id, true)
    })
    const row = container.querySelector('[data-wizard-skill-row]')
    expect(row, '那一格要换成失败的脸').toBeTruthy()
    expect(row!.textContent).toContain('2/3')
    expect(row!.textContent).toContain('技能目录只读')
    expect(container.textContent).not.toContain(zh['wizard.summarySkillsAuto'])
    // 这个数把两种"看着都对"的算法分开了：只数本来就开着的（1/3）与只数写成功的（1/3）都不诚实
  })

  it('反向对照：三发都做成 ⇒ 才是那句 ✓，且没有失败句', async () => {
    const { container } = await walk({
      listSkills: () => [skill('s1', false), skill('s2', false), skill('s3', false)]
    })
    const row = container.querySelector('[data-wizard-skill-row]')
    expect(row!.textContent).toContain(zh['wizard.summarySkillsAuto'])
    expect(row!.textContent).not.toContain('没全做成')
  })
})

describe('328 向导：探针判定认模型', () => {
  it('测完 m-a 再挑 m-b ⇒ 那条判定不许跟着挪到新模型上', async () => {
    const { container } = await walk()
    fireEvent.click(screen.getByText('测一下'))
    await waitFor(() => expect(container.querySelector('[data-probe-verdict]')).toBeTruthy())
    expect(container.querySelector('[data-probe-verdict]')!.textContent).toContain('可当管控者')

    const sel = container.querySelector('[data-probe-block] select') as HTMLSelectElement
    fireEvent.change(sel, { target: { value: 'm-b' } })
    await waitFor(() => expect(container.querySelector('[data-probe-verdict]')).toBeNull())

    // 反向对照：真去测 m-b，判定该回来（收回不等于永久禁掉那一格）
    fireEvent.click(screen.getByText('测一下'))
    await waitFor(() => expect(container.querySelector('[data-probe-verdict]')).toBeTruthy())
  })

  it('换到没测过的那台时，失败句也不许顶在它头上', async () => {
    const { container } = await walk({
      probeDelegateCapability: (p: string, m: string) =>
        m === 'm-a' ? { ...probeOk(p, m, 'unknown'), error: { code: 'probe_incomplete', params: { failed: 1, total: 3 } } } : probeOk(p, m)
    })
    fireEvent.click(screen.getByText('测一下'))
    await waitFor(() => expect(container.querySelector('[data-probe-error]')).toBeTruthy())
    const sel = container.querySelector('[data-probe-block] select') as HTMLSelectElement
    fireEvent.change(sel, { target: { value: 'm-b' } })
    await waitFor(() => expect(container.querySelector('[data-probe-error]')).toBeNull())
  })
})

describe('328 向导：完成标记落库失败要留在屏上', () => {
  it('completeWizard 回 {ok:false} ⇒ 不关窗、说出"下次开机可能还会再弹"', async () => {
    const closed = vi.fn()
    const { container } = await walk({ completeWizard: () => ({ ok: false, error: '数据库被占用' }) }, closed)
    fireEvent.click(screen.getByText('开始使用'))
    const line = await waitFor(() => {
      const el = container.querySelector('[data-wizard-finish-error]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(line.textContent).toContain('数据库被占用')
    expect(line.textContent).toContain('下次开机向导可能还会再弹')
    expect(closed, '没记住就别把向导关掉（改前静默关窗＝下次整趟重走且零提示）').not.toHaveBeenCalled()
  })

  it('反向对照：写成了才关窗，那句失败话术不出现', async () => {
    const closed = vi.fn()
    const { container } = await walk({}, closed)
    fireEvent.click(screen.getByText('开始使用'))
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
    expect(container.querySelector('[data-wizard-finish-error]')).toBeNull()
  })
})
