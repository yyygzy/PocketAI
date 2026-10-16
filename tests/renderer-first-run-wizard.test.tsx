// @vitest-environment jsdom
// 首启向导：步骤顺序、凭据措辞、口令闸门与 B1 前置拦截
//
// 覆盖四件事，全是之前只能靠在应用里点出来的项：
// 1) 「设主密码」这一步现在排在填 API Key **之前**（B1 口径的落地前提）；
// 2) API Key 提示不再声称「加密存储」；
// 3) 新设口令闸门与主进程同源：9 位本地拦下且**不发 IPC**，10 位才发；
// 4) 明文模式下填了 Key 点「下一步」不会被送去保存（也就能避免用户看到一条迟到的拒绝），
//    设完密码即可继续；选本地模型（不需要 Key）则不受影响。
import { describe, it, expect } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns, pocketaiCalls } from './helpers/renderer'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'

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
const copiedAssistant = { ...builtinAssistant, id: 'a-copy', isBuiltin: false }

/** encMode 可变：设完主密码后组件会自行把状态标成 db，但 stub 也要能提供初值 */
function mount(encMode: 'none' | 'db' = 'none', over: Record<string, unknown> = {}) {
  stubPocketai({
    getHardwareInfo: () => hardware,
    getEncryptionStatus: () => ({
      mode: encMode, unlocked: true, dbEncrypted: encMode === 'db', fieldEncrypted: true,
      masterPasswordVerified: true, kdfN: encMode === 'db' ? 131072 : null, kdfAtCurrentTier: true
    }),
    recommendModels: () => ({ ok: false }),
    listProviders: () => [],
    listAssistants: () => [builtinAssistant],
    listSkills: () => [],
    completeWizard: () => ({ ok: true }),
    saveProvider: () => Promise.resolve({ id: 'p1' }),
    setLastProvider: () => ({ ok: true }),
    duplicateAssistant: () => copiedAssistant,
    saveAssistant: () => ({ ok: true }),
    setAssistantPinned: () => ({ ok: true }),
    enableEncryption: () => ({ ok: true }),
    // Ollama 面板（选到本地预设时才挂载）会订阅状态与镜像源
    onOllamaPullEvent: () => () => {},
    onOllamaInstallEvent: () => () => {},
    getOllamaStatus: () => ({ ok: true, installed: false, running: false, models: [], version: '' }),
    getOllamaMirror: () => ({ ok: true, mirror: '' }),
    setOllamaMirror: () => ({ ok: true }),
    startOllama: () => ({ ok: true }),
    stopOllama: () => ({ ok: true }),
    // 147 那组要替 provider 清单与探针通道，其余用例不传 ⇒ 原样
    ...over
  })
  return mountWithProviders(<FirstRunWizard variant="full" onClose={() => {}} />)
}

const next = () => fireEvent.click(screen.getByText('下一步'))

/** step 0 → step 1（安全） */
async function goToSecurityStep() {
  mount()
  next()
  await screen.findByText(/先设主密码/)
}

/** step 1 → step 2（快速配置：预设 + Key + 助手） */
async function goToSetupStep() {
  await goToSecurityStep()
  next()
  fireEvent.click(await screen.findByText('DeepSeek'))
}

async function fillKey(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/API Key/), { target: { value } })
}

describe('向导步骤与措辞', () => {
  it('安全步在填 Key 之前：step 1 就能看到加密卡片', async () => {
    await goToSecurityStep()
    expect(screen.getByText(/设置主密码（推荐）/)).toBeTruthy()
    expect(screen.getByText(/零保护|明文/)).toBeTruthy()
    // 这一步还没有任何凭据输入口
    expect(screen.queryByPlaceholderText(/API Key/)).toBeNull()
  })

  // B21 的"变成 4 步"这一半以前只能靠人数步骤点，这里钉住指示器数量
  it('步骤指示是 4 个点，且第 1 步就是安全步（还没有 Key 输入口）', async () => {
    const { container } = mount()
    const dots = Array.from(container.querySelectorAll('span')).filter((el) =>
      el.className.includes('h-1.5 rounded-full')
    )
    expect(dots).toHaveLength(4)
    expect(screen.queryByPlaceholderText(/API Key/)).toBeNull()
    next()
    await screen.findByText(/先设主密码/)
    // 安全步仍然没有凭据输入口（Key 要到第 2 步选完预设才出现，见下面那条用例）
    expect(screen.queryByPlaceholderText(/API Key/)).toBeNull()
  })

  it('API Key 提示不再说「加密存储」，并点明未设主密码前只是混淆', async () => {
    await goToSetupStep()
    const hint = await screen.findByText(/不会上传任何服务器/)
    expect(hint.textContent).toContain('固定密钥混淆')
    expect(hint.textContent).not.toContain('加密存储')
  })
})

describe('新设口令闸门（SEC-32①，现位于 step 1）', () => {
  async function typeTwice(pwd: string) {
    await goToSecurityStep()
    const inputs = document.querySelectorAll('input[type=password]')
    expect(inputs.length).toBe(2)
    fireEvent.change(inputs[0]!, { target: { value: pwd } })
    fireEvent.change(inputs[1]!, { target: { value: pwd } })
    fireEvent.click(screen.getByText('启用加密'))
  }

  it('9 位在本地被拦下，不发 enableEncryption', async () => {
    await typeTwice('123456789')
    expect(await screen.findByText('新密码至少 10 位，建议用短语')).toBeTruthy()
    expect(calledFns()).not.toContain('enableEncryption')
  })

  it('10 位才提交', async () => {
    await typeTwice('1234567890')
    await waitFor(() => expect(calledFns()).toContain('enableEncryption'))
  })
})

describe('B1 前置拦截：明文模式下不 put 新 Key', () => {
  it('填了 Key 点下一步 → 就地引导回安全步，且没有发出 saveProvider', async () => {
    await goToSetupStep()
    await fillKey('sk-should-not-be-saved')
    fireEvent.click(screen.getByText('内置助手'))
    next()
    expect(await screen.findByText(/未设置主密码，API Key 不会被保存/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /回到上一步设置主密码/ })).toBeTruthy()
    expect(calledFns()).not.toContain('saveProvider')
  })

  it('按引导回到 step 1 设好主密码后，同一份配置可正常保存', async () => {
    await goToSetupStep()
    await fillKey('sk-after-master')
    fireEvent.click(screen.getByText('内置助手'))
    next()
    await screen.findByText(/未设置主密码，API Key 不会被保存/)

    fireEvent.click(screen.getByRole('button', { name: /回到上一步设置主密码/ }))
    const inputs = document.querySelectorAll('input[type=password]')
    fireEvent.change(inputs[0]!, { target: { value: 'a-long-master-phrase' } })
    fireEvent.change(inputs[1]!, { target: { value: 'a-long-master-phrase' } })
    fireEvent.click(screen.getByText('启用加密'))
    await waitFor(() => expect(calledFns()).toContain('enableEncryption'))

    next() // step 1 → step 2（Key 草稿仍在）
    next() // step 2 → 保存并前进
    await waitFor(() => expect(calledFns()).toContain('saveProvider'))
    await waitFor(() => expect(screen.getByText(/一切就绪/)).toBeTruthy())
  })

  it('本地模型（不需要 Key）在明文模式下不受闸门影响', async () => {
    mount()
    next()
    next()
    fireEvent.click(await screen.findByText(/Ollama/))
    next()
    await waitFor(() => expect(calledFns()).toContain('saveProvider'))
  })
})

// ---------- V4-Iter-147：完成页那一格可选探针 ----------

/**
 * 走的是 `saved = existing` 那条分支（`FirstRunWizard.tsx:161-163`：本地预设且已有同 baseUrl 的记录时
 * 根本不调 `saveProvider`）⇒ 探针候选来自那条记录的 `models`，而现有那 6 条用例的 stub 一个都不用改。
 *
 * 这一组要钉的两条硬东西：
 *  · **挂载时不许自动发探针**——探针是 3 发真请求、跑在用户的显存上，"可选"必须可选到；
 *  · 判定 ≠ 开关（决策③：默认关、逐台在设置页点名）⇒ 这一屏不能出现任何"已开启"的口气。
 */
describe('147 完成页探针：只在点名时发，失败不阻塞完成', () => {
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
  const probeCalls = () => pocketaiCalls().filter((c) => c.fn === 'probeDelegateCapability')
  const okProbe = () => ({ entry: { capability: 'native_tools_ok' }, error: null })

  /** 一路点到完成页（step 3）；返回 render 结果好查 data 属性 */
  async function toDone(over: Record<string, unknown> = {}) {
    const view = mount('none', { listProviders: () => [ollama], probeDelegateCapability: okProbe, ...over })
    next()
    next()
    fireEvent.click(await screen.findByText(/^Ollama$/))
    next()
    await screen.findByText(/一切就绪/)
    return view
  }

  it('走到完成页就把选择摆出来，但一次探针都不发', async () => {
    const { container } = await toDone()
    expect(container.querySelector('[data-probe-block]')).toBeTruthy()
    expect(probeCalls(), '探针是 3 发真请求，跑在用户显存上 ⇒ 不许挂载时自动跑').toHaveLength(0)
  })

  it('点「测一下」⇒ 恰好一发，参数是这家 provider 与清单里那台', async () => {
    const { container } = await toDone()
    fireEvent.click(screen.getByText('测一下'))
    await waitFor(() => expect(probeCalls()).toHaveLength(1))
    expect(probeCalls()[0]!.args).toEqual(['p-ollama', 'm-a'])

    // 换一家再点：第二发的参数必须跟着 select 走（默认那发只证明"发了"，不证明"发对了"）
    const sel = container.querySelector('[data-probe-block] select') as HTMLSelectElement
    fireEvent.change(sel, { target: { value: 'm-b' } })
    fireEvent.click(screen.getByText('测一下'))
    await waitFor(() => expect(probeCalls()).toHaveLength(2))
    expect(probeCalls()[1]!.args).toEqual(['p-ollama', 'm-b'])
  })

  it('判定行说的是"能派活"，不是"已打开"（决策③：开关在设置页逐台点名）', async () => {
    const { container } = await toDone()
    fireEvent.click(screen.getByText('测一下'))
    const verdict = await waitFor(() => {
      const el = container.querySelector('[data-probe-verdict]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(verdict.textContent).toContain('可当管控者')
    expect(verdict.textContent).toContain('≠ 已打开')
    expect(container.textContent, '这一屏不许给出任何"已经开了"的口气').not.toMatch(/已开启|已启用委派/)
  })

  it('探测没跑完 ⇒ 说"没测出结论"、不出判定行，而「开始使用」照样点得动（失败不阻塞）', async () => {
    const { container } = await toDone({
      probeDelegateCapability: () => ({ entry: { capability: 'unknown' }, error: '探测未跑完：1/3 次请求失败' })
    })
    fireEvent.click(screen.getByText('测一下'))
    const err = await waitFor(() => {
      const el = container.querySelector('[data-probe-error]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(err.textContent).toContain('这次没测出结论')
    expect(container.querySelector('[data-probe-verdict]'), '没结论就不该画判定').toBeNull()

    fireEvent.click(screen.getByText('开始使用'))
    await waitFor(() => expect(calledFns()).toContain('completeWizard'))
  })

  it('IPC 层直接拒绝（{ok:false}）也走同一句"没测出结论"，而不是抛到界面上', async () => {
    const { container } = await toDone({
      probeDelegateCapability: () => ({ ok: false, error: 'provider 不存在' })
    })
    fireEvent.click(screen.getByText('测一下'))
    const err = await waitFor(() => {
      const el = container.querySelector('[data-probe-error]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(err.textContent).toContain('provider 不存在')
    expect(probeCalls()).toHaveLength(1)
  })

  it('这家没有缓存模型 ⇒ 那一格压根不出现（不摆一个点了必错的按钮）', async () => {
    const { container } = await toDone({ listProviders: () => [{ ...ollama, models: [] }] })
    expect(container.querySelector('[data-probe-block]')).toBeNull()
    expect(probeCalls()).toHaveLength(0)
  })

  it('点「以后再说」⇒ 整块收起，且不发探针', async () => {
    const { container } = await toDone()
    fireEvent.click(screen.getByText('以后再说'))
    await waitFor(() => expect(container.querySelector('[data-probe-block]')).toBeNull())
    expect(probeCalls()).toHaveLength(0)
  })
})

// ---------- V4-Iter-151：保存前现取清单，不许拿挂载时的陈旧快照决定"要不要新建" ----------

/**
 * 现场：向导 step 2 里那个 OllamaPanel 拉完模型后，主进程已经建好/追加了这条 provider
 * （`ipc/handlers/ollama.ts:52`），而向导的清单是**挂载时**读的那一份 ⇒ 旧代码在这里判"没有"，
 * 发一份 `models: []` 的"新建"载荷，把刚拉到的那台清空（`providerRepo.save` 按 (type,baseUrl) 去重命中同一行）。
 * 这两条用例一个证根因修好、一个证"新建"这条路没被一起砍掉。
 */
describe('151 保存前重新取 provider 清单', () => {
  const ollama = {
    id: 'p-ollama',
    type: 'ollama',
    name: 'Ollama（本地模型）',
    baseUrl: 'http://localhost:11434/v1',
    apiKeys: [],
    models: ['qwen2.5:3b-instruct'],
    enabled: true,
    createdAt: 1
  }

  async function walkWith(over: Record<string, unknown>) {
    const view = mount('none', over)
    next()
    next()
    fireEvent.click(await screen.findByText(/^Ollama$/))
    next()
    await screen.findByText(/一切就绪/)
    return view
  }

  it('挂载时清单为空、保存时那条已存在 ⇒ 不再发"新建"载荷，且完成页那一格出现', async () => {
    let listCalls = 0
    const { container } = await walkWith({
      // 第一次 = 挂载时的快照（还没有）；第二次 = 保存前现取（用户刚在向导里拉完模型）
      listProviders: () => (++listCalls === 1 ? [] : [ollama]),
      probeDelegateCapability: () => ({ entry: { capability: 'native_tools_ok' }, error: null })
    })
    expect(listCalls, '保存前必须再取一次清单').toBeGreaterThanOrEqual(2)
    expect(calledFns(), '这条已存在 ⇒ 该走 existing 分支，不该发 models:[] 的新建载荷').not.toContain('saveProvider')
    // 顺带解掉 147 那条可达性缺口：向导里拉完模型的人，第一次就能看到那一格
    const block = container.querySelector('[data-probe-block]')
    expect(block, 'savedProvider 带着缓存模型 ⇒ 完成页那一格该出现').toBeTruthy()
    expect(block!.textContent).toContain('qwen2.5:3b-instruct')
  })

  it('反向对照：清单两次都空 ⇒ 照旧新建一条（修根因不能把"新建"这条路一起砍掉）', async () => {
    const { container } = await walkWith({ listProviders: () => [] })
    expect(calledFns()).toContain('saveProvider')
    expect(container.querySelector('[data-probe-block]'), '新建的那条没有缓存模型 ⇒ 那一格不出现').toBeNull()
  })

  it('取清单失败时退回挂载时那一份，不卡住用户（向导是首启必经路）', async () => {
    let n = 0
    const view = mount('none', {
      listProviders: () => {
        n += 1
        if (n === 1) return []
        throw new Error('IPC 挂了')
      }
    })
    next()
    next()
    fireEvent.click(await screen.findByText(/^Ollama$/))
    next()
    await waitFor(() => expect(calledFns()).toContain('saveProvider'))
    await screen.findByText(/一切就绪/)
    expect(view.container.querySelector('h1')).toBeTruthy()
  })
})
